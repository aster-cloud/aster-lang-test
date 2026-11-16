# 包格式 v1 真相源与一致性夹具（ADR 0059 P1 T1）

规范来源（aster-api 仓）：`docs/adr/0059-executable-policy-export.md`、`docs/adr/0059-amendment-1-p0-findings.md`（修订 1，A0–A5）、
实施计划 `docs/superpowers/plans/2026-11-16-adr0059-p0-p1.md`（Global Constraints、Review Focus、T1）。本目录把其中的包格式与
CLI 输出定死为可执行的字节：两个 `aster` CLI（Node T2–T5、JVM T6–T9）与跨 CLI 一致性门（T11）只消费这里的文件。

## 目录

| 路径 | 内容 | 来源 |
|---|---|---|
| `schema/manifest-1.0.schema.json` | manifest 严格 schema（JSON Schema 2020-12，ajv `strict:true` 可编译） | 手写；ts / truffle 各存逐字节副本 |
| `schema/sig-1.0.schema.json` | `manifest.sig.json` schema | 手写；同上 |
| `exit-codes.json` | 错误码 → 退出码 + **固定 message** | 手写 |
| `envelope.schema.json` | 各子命令 stdout 的形状 | 手写 |
| `normalize-stdout.mjs` | 跨 CLI stdout 归一（修订 A0），T4 / T11 直接 import | 手写 |
| `VALUE-FORMS.md` | 值的树形与值规范 JSON | 手写 |
| `keys/` | **仅测试**的 Ed25519 密钥与 JWKS（见 `keys/README.md`） | 生成 |
| `vectors/signing.json` | 签名向量（11 条） | 生成 |
| `vectors/value-json.json` | 值规范 JSON 向量（39 条 + 10 000 个随机 double） | 生成 |
| `vectors/position-free-hash.json` | `coreIr.positionFreeSha256` 向量（5 条，含一对只差 col 的 Java / ts IR） | 生成 |
| `vectors/stdout-normalize.json` | 归一向量（11 条） | 生成 |
| `packages/<name>/` + `packages/<name>.cases.json` | 9 个黄金包（目录形态）与用例；`packages/b-credit-limit.zip` 为 zip 形态 | 生成 |
| `tamper/<name>/`、`tamper/<name>.zip`、`tamper/cases.json` | 篡改与畸形 zip 夹具（40 个） | 生成 |
| `inputs-invalid/cases.json` | `INPUT_INVALID` 夹具（16 个，作用于黄金包） | 生成 |
| `src/` | 生成器的输入：源码、`fixture.json`、采集的平台 IR（`platform-core.json`）与期望值（`expected.json`） | 手写 + `--capture` |

生成与校验（Node ≥ 24，无 npm 依赖）：

```bash
node scripts/test-package-v1.mjs                      # 生成器各部件的单测
node scripts/build-package-fixtures.mjs --check       # 重新生成并与仓内逐字节比较（CI）
node scripts/build-package-fixtures.mjs               # 改了 src/ 后重新生成
node scripts/build-package-fixtures.mjs --verify-engines --ts ../aster-lang-ts --guard ../aster-guard   # 交叉验证（CI）
```

`--verify-engines` 用已构建的 aster-lang-ts 与 aster-guard 源码证明：三个 schema 在 ajv 2020 `strict:true` 下可编译；每个
黄金 manifest 符合 schema 且其字节 = aster-guard `jcs.ts` = ts `canonicalJson`（manifest 域内规范 JSON 与 RFC 8785 相同）；
签名成立；ts 重编译每个包的源码得到同一 `positionFreeSha256`；ts 解释器复算每个成功用例、`EVAL_ERROR` 用例与 probes；
全部 `expectedStdout` 符合 `envelope.schema.json` 且 message / 退出码与 `exit-codes.json` 一致。

`--capture`（本地手动，CI 不跑）重新采集 `src/` 中的平台输入：平台 IR 由 `scripts/package-v1/PlatformCompile.java` 按 aster-api
`PolicyCompiler` 的生产编译序列取得；期望值与值树取自本地 aster-api `/evaluate-json`。本次采集：aster-api `773a92a6`（生态 1.0.49，
即 P0 实测所用构建）、aster-lang-ts 3.2.0。

## 用例格式（`*.cases.json`）

```json
{ "name": "allow",
  "args": ["run", "b-credit-limit", "--input", "-", "--jwks", "../keys/test-jwks.json"],
  "stdin": "{\"applicant\":{…}}",
  "expectedStdout": "{\"meta\":{\"cliVersion\":\"<CLI_VERSION>\",…},\"ok\":true,\"value\":…}\n",
  "expectedExit": 0,
  "code": null }
```

- `args` 不含可执行名；其中的相对路径**相对 cases.json 所在目录**，测试以该目录为 cwd 运行 CLI。
- `stdin` 缺省表示不提供 stdin（`verify` / `inspect` / `--input <file>`）。`stdin` 恰为给出的字节（可能是空串）。
- 先用 `normalize-stdout.mjs`（JVM：`StdoutNormalizer.java`，跑 `vectors/stdout-normalize.json`）归一实际 stdout，再与
  `expectedStdout` 逐字节比较；退出码与 `expectedExit` 比较。`code` 是期望的错误码（成功为 `null`），供只断言错误码的单测使用
  （T2 / T8 的 integrity / tamper 测试）。
- `engines` 字段保留给只适用于一侧的用例；v1 夹具没有这样的用例，**全部用例两侧都跑**。

信任锚：内置锚 P1 为空，所以用例以 `--jwks ../keys/test-jwks.json` 显式给出测试锚；`pubkey-raw-anchor` 用
`--pubkey ../keys/test-ed25519.pub.b64u`；`builtin-anchor-is-empty` 不给锚，期望 `PKG_UNTRUSTED_KID`。

## 输出

所有子命令的 stdout 都是**一行值规范 JSON + `\n`**；诊断只写 stderr。形状见 `envelope.schema.json`：

- `run` 成功 `{"meta":M,"ok":true,"value":V}`；失败 `{"error":{"code":C,"message":S},"meta":M,"ok":false}`。
- `inspect` 成功 `{"inspect":{effects,governance,policy,runtime,tests},"meta":M,"ok":true}`（五个成员原样取自 manifest）；
  失败输出与 `run` 相同的错误信封。
- `verify` 恒为 `{"checks":[…],"meta":M,"ok":bool}`，每个检查 `{"name","ok"}`，失败的那一项另带 `"code"`。
- `version`：`{"cliVersion","coreIrVersions":[2],"engine","formatVersions":["1.0"],"toolchainId","trustAnchorKids":[…]}`，不参与跨 CLI 比较。
- **`error.message` 必须逐字等于 `exit-codes.json` 中该错误码的 `message`。** 细节（哪个文件、哪个哈希、编译诊断、引擎异常文本、
  入口被 `main` 抢占的原因）一律写 stderr。

`M` 的取值时机（两侧必须相同，否则失败信封不能逐字节相等）：

| 字段 | `run` / `inspect` | `verify` |
|---|---|---|
| `signed` | 签名检查通过后为 `true`；在此之前失败、无签名且 `--allow-unsigned`，均为 `false` | 同左 |
| `entry` | 取得 IR 后为所选入口名（`--entry` 的值，不论是否存在；缺省为 `default:true` 的入口）；之前为 `null`。`inspect` 为缺省入口 | integrity 通过后为缺省入口，否则 `null` |
| `coreIrSha256` | 取得 IR 后为 `manifest.coreIr.sha256`（不是本地编译结果的哈希）；之前为 `null`。`inspect` 在 integrity 通过后填入 | integrity 通过后填入 |
| `irRecompiled` | B 包取得 IR（本地编译且投影哈希一致）后为 `true`；A 包恒 `false`；`inspect` 恒 `false` | `--recompile` 检查通过后为 `true` |
| `engine` / `cliVersion` | 各自的值；比较前归一为 `"<ENGINE>"` / `"<CLI_VERSION>"` | 同左 |

## 检查顺序

两个 CLI 按同一顺序检查，在第一处失败停止（`stage` 列即 `fixtures.mjs` 中决定 meta 的阶段）：

| 阶段 | 检查 | 失败码 |
|---|---|---|
| usage | 解析命令行：未知选项、缺少必需参数、`--timeout` 不是 `<n>ms` / `<n>s` 或超过 `300s`；环境变量 `ASTER_TRUFFLE_FUNC` 已设置（仅 JVM，修订 A5） | `USAGE` |
| read | 读包：目录形态逐个列出文件，**任何位置的符号链接即失败**；zip 形态见下文「zip 规则」。没有 `manifest.json` | `PKG_INTEGRITY`；缺 manifest 为 `PKG_INVALID_MANIFEST` |
| manifest | ① 文件字节 = 其解析结果的规范 JSON（否则含重复键、空白、键序、`3.0` 之类非整数写法、末尾换行都失败）② `format` 为字符串 `aster-policy-package` 且 `formatVersion` 为 `主.次` 形式的字符串 ③ 主版本 = 1 且次版本 ≤ 0 ④ schema ⑤ `coreIr.version` = 2 | ①②④ `PKG_INVALID_MANIFEST`；③ `PKG_UNSUPPORTED_FORMAT`；⑤ `PKG_UNSUPPORTED_IR` |
| signature | 无 `manifest.sig.json`：`--allow-unsigned` 时继续（`signed=false`），否则失败；有签名文件（即使给了 `--allow-unsigned` 也必须成立）：sig schema（含 base64url 规范编码）→ `kid` 查锚 → Ed25519 验签 manifest 文件字节 | `PKG_UNSIGNED`；`PKG_SIGNATURE`；`PKG_UNTRUSTED_KID` |
| integrity | `files[]` 每项存在、大小与 SHA-256 相符；包内除三个元文件外没有 `files[]` 以外的文件；`SHA256SUMS` 存在且逐字节等于由 `files[]` + `manifest.json` 生成的内容（GNU 格式 `<hex>␠␠<path>\n`，按路径 UTF-8 字节序）；A 包 `compiled/core.json` 的 SHA-256 = `coreIr.sha256` | `PKG_INTEGRITY` |
| ir | A：读 `compiled/core.json` 并严格读入。B：按 manifest 的 locale / aliasSet / allowStructural / 词汇本地编译（含 aliasSet 校验），按 `positionFreeSha256` 比对 | A 读入失败 `PKG_UNSUPPORTED_IR`；B 编译失败或不等 `PKG_IR_DRIFT` |
| entry | `--entry`（缺省取 `default:true`）必须是 `policy.entries` 中的函数；JVM 另有入口被 `main` 抢占的情形 | `ENTRY_NOT_FOUND` |
| input | 读 `--input <file>` 或 `-`（stdin），按下文「输入」校验 | `INPUT_INVALID` |
| eval | 沙箱求值 | `EVAL_ERROR`、`TIMEOUT`、`RESOURCE_EXHAUSTED` |

`verify` 的检查项与阶段对应：`schema` = manifest 阶段，`signature`、`integrity` 同名阶段，`recompile`（`--recompile`：对 A、B 都
本地编译 `policy/` 并按 `positionFreeSha256` 比对，失败码 `PKG_IR_DRIFT`），`probes`（`--probes`：按 `tests/probes.json` 逐条
以 `run` 的 entry → input → eval 路径求值，结果的值规范 JSON 与期望不同、或求值失败，失败码 `PROBE_MISMATCH`；B 包先本地编译，
失败码 `PKG_IR_DRIFT`）。两者同时给出时先 `recompile` 后 `probes`。`verify` 的退出码 = 第一项失败检查的错误码对应的退出码，全部通过为 0。
无签名且 `--allow-unsigned` 时 `signature` 记为 `{"name":"signature","ok":true}`，由 `meta.signed=false` 表明未验签。

`target` 与 `runtime.*` 只是信息字段：v1 CLI 不按它们放行或拒绝（夹具里 node / jre 两种 target 都由两个 CLI 运行）。A 包在 P1 不带
`runtime/` 文件（只测 `compiled/` 路径），`runtime.cli.sha256` 取空字节的哈希；`runtime/aster.mjs` 这类未列入 `files[]` 的文件
照常是多余文件（夹具 `extra-runtime-file`）。`source.envelopeSha256` 与 `source.claimedRef` 不由 CLI 核验。

## zip 规则

只在内存解压、从不写盘；按条目边读边计数（不得先整体解压再判断）。全部在 read 阶段判定，失败一律 `PKG_INTEGRITY`：

- 文件本身 > 64 MiB；不是 zip。
- 全部条目必须位于唯一的根目录 `<root>/` 之下（ADR §2：`<moduleName>-v<version>-<target>-<mode>/`，根名不校验含义，只要求是合法路径段）；
  去掉根后的路径受 `files[].path` 同一规则约束（`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，无 `.` / `..` 段）。`../x`、`<root>/../x`、
  `/x`、含反斜杠、两个根，都失败。
- 目录条目（名以 `/` 结尾）忽略；同名条目重复即失败。
- 只接受方法 0（stored）与 8（deflate）。
- 单条实际解压字节 ≠ 声明大小、或累计实际解压字节 > 64 MiB 即失败（夹具：声明 1 KiB 实际 1 GiB 的单条目；1 000 个各 1 MiB 的条目）。
- 符号链接条目只是普通字节，不会被跟随（必然成为多余文件或哈希不符）。

zip 夹具的头部是确定性的：mtime 1980-01-01、无 extra field、无数据描述符；`policy/policy.aster` 用 deflate（由存储块组成），解压炸弹
用手写的单个动态 Huffman 块（`scripts/lib/package-v1/zip.mjs`）——不依赖 zlib 的压缩输出，任何机器上 `--check` 都逐字节复现。

## 输入

`--input` 的内容必须是 JSON 对象，键**恰为**入口的全部形参名（逐字节；0 参入口只接受 `{}`）；按包内 `schema/input.json` 中
`entries[].inputSchema` 指向的 schema 校验，另加两条 schema 表达不了的规则：任何 JSON 整数 token 超出 ±(2⁵³−1) 即失败；
不是合法 JSON（含空 stdin）即失败。失败一律 `INPUT_INVALID`。`schema/input.json` 的类型映射（P2 的导出端点按同一映射生成）：

| Core IR 类型 | schema |
|---|---|
| Int | `{"type":"integer","minimum":-(2⁵³−1),"maximum":2⁵³−1}` |
| Long | `{"type":["integer","string"],…, "pattern":"^-?(0\|[1-9][0-9]*)$"}`（大值以十进制字符串给出） |
| Double | `{"type":"number"}` |
| Decimal | `{"type":"string","pattern":"^-?(0\|[1-9][0-9]*)(\\.[0-9]+)?$"}`——**只接受字符串**，JSON 数字即失败 |
| Text / Bool | `string` / `boolean` |
| Data `T` | `{"$ref":"#/$defs/data.T"}`：全部字段必填、`additionalProperties:false` |
| 入口 `f` | `#/$defs/entry.f`：全部形参必填、`additionalProperties:false` |

## `tests/probes.json`

值规范 JSON：`{"probes":[{"entry":S,"expected":{"ok":true,"value":V},"input":{…}}…]}`。`tests.probes` = 条数，
`tests.probesSha256` = 文件字节的 SHA-256。`expected.value` 与求值结果都按值规范 JSON 比较。

## 期望值来源（重要）

- 成功用例的 `value` 与 probes 的期望取自本地 aster-api `/evaluate-json`（`expected.json` 中 `source: "platform"`）。
- **平台 `/evaluate-json` 无法传入非整数 Decimal**（2026-11-17 实测：JSON 字符串被当作 Text →「期望 Decimal，实际 Text」；带小数的
  JSON 数字被当作 Double →「Cannot combine Decimal and Double」；只有整数 JSON 数字会被提升为 Decimal）。因此采集时把 Decimal
  字符串改写为整数数字 token 发给平台；唯一的非整数 Decimal 入参用例 `a-decimal/fractional-input`（`"12.34"`）的期望取自 ts 解释器
  （`source: "ts"`）。JVM CLI 必须自己把 Decimal 字符串转成 Decimal guest 值，不能照搬平台的 JSON 入参转换（T8 注意）。
- `a-deep-recursion/depth-20000` 与 `a-multi-entry/eval-error-division-by-zero` 已在平台上确认同样失败；`a-timeout/timeout-1s` 的
  `TIMEOUT` 与资源类结果按修订 A4 / P0 实测设定，不由平台复算。

## 黄金包一览

| 包 | 形态 | 覆盖 |
|---|---|---|
| `b-credit-limit` | B，en-US，jre | Data 入参（含 Decimal 字段）、Verdict 四种结论、`--entry`、zip 形态、`--pubkey`、空内置锚、`inspect`、`verify --recompile`；`inputs-invalid` 与多数篡改夹具的基础 |
| `b-vocab-de` | B，de-DE + 词汇，node | 冻结词汇（`policy/compile/vocabulary.json`） |
| `b-alias` | B，非空 aliasSet，`allowStructural=true`，node | 别名多词规范形、过 `UserAliasValidator`；投影哈希下两侧都成功 |
| `a-decimal` | A，node | Decimal 字符串入参、HALF_EVEN 舍入、`verify --probes` 通过、`verify --recompile` |
| `a-bad-probe` | A（派生自 a-decimal） | probes 第 2 条期望被改坏并重新签名：`verify` 通过、`verify --probes` → `PROBE_MISMATCH` |
| `a-multi-entry` | A，jre | 四个入口（无 `main`）、缺省与 `--entry`、Double 结果、0 参入口、`EVAL_ERROR`、`ENTRY_NOT_FOUND`、`USAGE` |
| `a-timeout` | A，node | `spin(60)` 在 `--timeout 1s` 下 `TIMEOUT` |
| `a-deep-recursion` | A，jre | `deep(20000)` 两侧 `RESOURCE_EXHAUSTED` |
| `unsigned` | A（派生自 a-multi-entry），无签名 | 缺省 `PKG_UNSIGNED`；`--allow-unsigned` 运行且 `signed=false`；`verify` 两种 |
