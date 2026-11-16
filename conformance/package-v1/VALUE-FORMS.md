# 值的树形与值规范 JSON（包格式 v1）

来源：ADR 0059 修订 1 A1，以及实施计划 `docs/superpowers/plans/2026-11-16-adr0059-p0-p1.md`「P0 结果」§3（aster-api 仓）。
本文件规定 `run` 信封里 `value` 的字节形态。ts（T3 `src/package/value-json.ts`）与 JVM（T8 `ValueJson.java`）各实现一份，
跑同一组 `vectors/value-json.json`。参照实现：`scripts/lib/package-v1/value-json.mjs`。

## 1. 两步：先得到树，再按值规范 JSON 写出

1. **树**：求值结果按 aster-api `POST /api/v1/policies/evaluate-json` 响应里 `result` 的同一 JSON 树（下表）。
2. **字节**：把这棵树按「值规范 JSON」序列化。与平台的关系是「树相等、字节不等」：平台 `result` 是 Jackson 输出
   （键按插入序、Double 用 Java 写法），把它经同一序列化器写出后与 CLI 的 `value` 逐字节相同（P2 黄金门的比较口径）。

**不得**用空 TypeContext 的 ts `canonicalJson` / core `CanonicalJson.canonicalJson`：它们拒绝非整数与超出 ±(2⁵³−1) 的整数。

## 2. 值规范 JSON

- 对象键按 Unicode **码点**升序（与 ADR 0055 §5 同一比较器；不是 UTF-16 码元序——向量 `map-non-bmp-keys` 覆盖）。
- 数组保序；无任何空白；`null` 显式输出。
- 字符串按 RFC 8785 §3.2.2.2 转义（与 ECMAScript `JSON.stringify` 相同：`"`、`\`、`\b \f \n \r \t` 用短转义，其余 U+0000–U+001F 用
  小写 `\u00xx`，其他字符（含 U+007F、U+2028、非 BMP）原样输出 UTF-8）。字符串必须是合法 Unicode；含孤立代理项即 `EVAL_ERROR`。
- 整数（Int、Long，不限 2⁵³）输出精确十进制；`-0` 输出 `0`。
- 非整数 Double 按 RFC 8785 §3.2.2.3，即 ECMAScript `Number::toString`（最短往返位数；`1e21` 及以上、`1e-7` 及以下用指数形式，
  如 `1e+21`、`1e-7`、`5e-324`）。整数值的 Double（如 `1.0E20`）输出 `100000000000000000000`。`-0.0` 输出 `0`。
  JVM 侧：`Double.toString`（JDK 19 起为最短往返位数）取有效数字与指数后按 ECMAScript 规则重排。
- NaN / ±Infinity 不可能出现在值里；出现即 `EVAL_ERROR`。
- Long 超出 2⁵³ 时消费方需用大数 JSON 解析器读取 `value`。
- **嵌套层级上限 64**：顶层值为第 0 层，容器的元素 / 成员比容器深一层，任何值位于第 65 层或更深即 `EVAL_ERROR`
  （与 ts `serializeGuestValue` 的 `SERIALIZE_MAX_DEPTH = 64` 相同；JVM 侧须显式实现同一计数）。向量 `depth-*` 给出两侧边界。

## 3. 逐类型树形（平台为准）

| 值类别 | 平台 `result` 树形 | ts `serializeGuestValue` 需要的映射 | 向量 |
|---|---|---|---|
| Int | JSON 整数 | 无 | `int`、`int-division-exact` |
| Long | JSON 整数（超出 2⁵³ 也是裸数字） | 无（bigint → 十进制） | `long`、`long-from-unsafe-integer-input`、`long-2^53+1`、`long-min/max` |
| Double | JSON 数字 | 无（树相等；字节由本规范统一） | `double-*` |
| Decimal | 字符串：普通十进制写法（无指数），去掉小数部分末尾的 0，整数值不带小数点，零为 `"0"`，负数带 `-`（Truffle `AsterDecimalValue` 的 `stripTrailingZeros().toPlainString()`、ts decimal.js 同一写法） | 无 | `decimal`、`decimal-trailing-zero-stripped`（`"43.3"`）、`decimal-zero`、`decimal-negative`、`decimal-small` |
| Text | 字符串（含孤立代理项即 `EVAL_ERROR`） | 无 | `text-non-ascii`、`text-escapes`、`text-lone-surrogate`（error） |
| Bool | `true` / `false` | 无 | `bool` |
| List | 数组 | 无 | `list`、`nested-list-of-maybe` |
| Map | 对象（平台为插入序；规范形重排） | 无 | `map-insertion-order`、`map-non-bmp-keys` |
| Data | `{"__type":"<类型名>", <字段…>}` | 无 | `data-with-double-field`、`data-jackson-insertion-order` |
| Enum | `{"_enum":"Tier","args":[],"value":"Gold","variant":"Gold"}` | **删除** ts 多出的 `"__type":"?"` 键 | `enum` |
| Maybe | `{"__type":"Some","value":v}` / `{"__type":"None"}` | 无 | `maybe-some`、`maybe-none` |
| Result | `{"__type":"Ok","value":v}` / `{"__type":"Err","value":v}` | 无 | `result-ok`、`result-err` |
| Verdict | `{"__type":"Verdict","outcome":…[,"reason"][,"role"]}` | 无 | `verdict-*` |
| DateTime、PII | **未定**：语料与探针都没有产出，树形未取得 | — | — |

**DateTime 与 PII 不在包格式 v1 的承诺内。** P2 的导出检查对形参或返回类型含二者的入口以 E738 拒绝导出（修订 1 A5），
补齐树形须先修订本文件与 A5。T1 没有补采：补齐会改变 A5 的导出范围，属于需要单独裁决的规范变更。

## 4. 平台把 Double 结果写成整数的情形

平台对 `Int divided by Int` 在整除时返回 JSON 整数（`7 divided by 7` → `1`），否则返回 Double（`100 divided by 7` →
`14.285714285714286`）。两种都按本规范输出同一字节（`1`），向量 `int-division-exact` 收录。

## 5. 向量文件 `vectors/value-json.json`

- `vectors[]`：`{ name, category, source, treeJson, expected }`。`treeJson` 是值树的 JSON 文本：**不含 `.`、`e`、`E` 的数字
  token 是精确整数**（解析为 BigInt / BigInteger），其余数字 token 是 IEEE-754 double。`source=platform` 的 `treeJson` 是
  本地 aster-api `/evaluate-json` 响应中 `result` 的原文（采集清单 `src/value-probes.json`），`source=synthetic` 是按
  Jackson / `Double.toString` 写法构造的边界值。
- `error: true` 的向量（`expected` 为 `null`）必须序列化失败，CLI 报 `EVAL_ERROR`。
- `randomDoubles`：splitmix64（种子见文件）生成的 10 000 个 64 位位模式（大端十六进制 `bits`），排除 NaN / ±Infinity，
  `expected` 为 ECMAScript `String(x)`。均匀位模式绝大多数落在指数写法区间，所以另有：
- `randomPlainDoubles`：10 000 个落在普通小数区间的 double（53 位随机尾数 × 10^k，k ∈ [−9, 22]，以及随机整数之商），覆盖 JVM 侧
  `Double.toString` → ECMAScript 写法重排最容易出错的区间；固定向量另含 `2.0`、`-1.0`、`1.0E15`、`2⁵³`、`1e21 − ulp` 等整数值 double。
  两组都是由位模式构造 double 后序列化，逐条比较。
