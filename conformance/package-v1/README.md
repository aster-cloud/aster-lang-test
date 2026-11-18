# 包格式 v1 真相源与一致性夹具（ADR 0059 P1 T1）

规范来源（aster-api 仓）：`docs/adr/0059-executable-policy-export.md`、`docs/adr/0059-amendment-1-p0-findings.md`（修订 1，A0–A5）、
实施计划 `docs/superpowers/plans/2026-11-16-adr0059-p0-p1.md`（Global Constraints、Review Focus、T1）。本目录把其中的包格式与
CLI 行为定死为可执行的字节：两个 `aster` CLI（Node T2–T5、JVM T6–T9）与跨 CLI 一致性门（T11）只消费这里的文件。
**本 README 中标为「裁决」的条目细化或修正了计划原文，实现以本 README 为准**（计划与 ADR 的同步修订见 ADR 0059 修订 2，wontlost-ltd/aster-api#559，ACCEPTED 2026-11-17）。

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
| `anchors/` | 信任锚夹具：单个 JWK（带 / 不带 kid）与各种非法锚文件 | 生成 |
| `vectors/signing.json` | 签名向量 | 生成 |
| `vectors/value-json.json` | 值规范 JSON 向量（平台采集 + 边界值 + 嵌套层级 + 两组各 10 000 个随机 double） | 生成 |
| `vectors/position-free-hash.json` | `coreIr.positionFreeSha256` 向量（含一对只差 col 的 Java / ts IR） | 生成 |
| `vectors/stdout-normalize.json` | 归一向量 | 生成 |
| `packages/<name>/` + `packages/<name>.cases.json` | 15 个黄金包（目录形态）与用例；`b-credit-limit.zip`、`b-zh.zip` 为 zip 形态；`b-credit-limit-dir.zip/`（目录）与 `b-credit-limit-zip-no-extension`（zip）验证按文件类型而非扩展名判形态 | 生成 |
| `tamper/<name>/`、`tamper/<name>.zip`、`tamper/cases.json` | 篡改与畸形 zip 夹具，每个夹具 run / verify / inspect 各一条用例 | 生成 |
| `tamper/test-time.json` | 体积类夹具的生成配方（几十 MiB，不入库，由 CLI 测试运行时生成） | 生成 |
| `inputs-invalid/cases.json` | `INPUT_INVALID` 夹具（作用于黄金包） | 生成 |
| `compile/` | `compile` 子命令夹具：源码与 aliasSet / 词汇文件、`cases.json`（见「compile」） | 生成（源码类期望由 `--capture-compile` 按 InProcessCnlParser 解析 + 降级序列 采集） |
| `src/` | 生成器的输入：源码、`fixture.json`、采集的平台 IR（`platform-core.json`）与期望值（`expected.json`）、篡改与非法输入定义 | 手写 + `--capture` |

跨 CLI 一致性门（T11，CI job 与 required status check 均为 `package-conformance`，PR-blocking）：

```bash
node scripts/package-conformance.mjs --node ../aster-lang-ts/dist/runner/aster.mjs --jar ../aster-lang-truffle/cli/build/libs/aster-cli-<ver>.jar [--report-only] [--concurrency 4] [--filter s] [--report f.md]
```

对全部用例（含 `tamper/test-time.json` 的运行时配方：超大包 / 输入在临时目录生成，https 配方在 127.0.0.1 上起自签名 RSA 证书的服务）两侧各跑一遍：
两侧 stdout 经 `normalize-stdout.mjs` 归一后逐字节相同、退出码相同，且都等于 `expectedStdout` / `expectedExit`；`compile` 成功用例比较投影哈希；
带 `knownEngineDivergence` 的行只豁免 `knownDivergentEngine`（`node` / `jre`）那一侧的期望比较：另一侧仍须等于期望，分歧一侧仍须正常结束（退出码在 `exit-codes.json` 表内、stdout 是 JSON），
分歧消失（两侧一致且等于期望）时判失败（`stale knownEngineDivergence: remove marker`），提醒去掉标记。
用例数有下限：每个 cases 文件都须存在且非空，不给 `--filter` 时须跑完它们的全部行，给 `--filter` 时至少匹配一条，零条即失败。
同一 `routes` 的 https 配方共用一个服务，`routes` 不同的各起一个。兄弟仓走 checkout-sibling（同名分支优先），夹具与两侧 CLI 的联合改动可在合并前一起验证。

生成与校验（Node ≥ 24，无 npm 依赖）：

```bash
node scripts/test-package-v1.mjs                      # 生成器与参照实现各部件的单测
node scripts/build-package-fixtures.mjs --check       # 重新生成并与仓内逐字节比较（CI）
node scripts/build-package-fixtures.mjs               # 改了 src/ 后重新生成
node scripts/build-package-fixtures.mjs --verify-engines --ts ../aster-lang-ts --guard ../aster-guard   # 交叉验证（CI）
```

`--verify-engines` 用已构建的 aster-lang-ts（ajv、`canonicalJson`、编译器、解释器）与 aster-guard `jcs.ts` 证明：
- 三个 schema 与每个包内 `schema/input.json` / `output.json` 在 ajv 2020 `strict:true` 下可编译；
- 每个黄金 manifest 符合 schema，其字节 = aster-guard `jcs.ts` = ts `canonicalJson`；签名成立；ts 重编译源码得到同一 `positionFreeSha256`；
- **参照流水线**（`scripts/lib/package-v1/reference-check.mjs` 与 `input.mjs`，按本 README 的检查顺序与规则独立实现）对每条 `run`
  用例给出的错误码与阶段（从而 `meta`）都与夹具一致；不该失败的用例通过；每个 `inputs-invalid` 用例被拒绝、每个成功用例的输入被接受；
- ts 解释器复算每个成功用例、`EVAL_ERROR` 用例与 probes（probes 无损读取）；
- 全部 `expectedStdout` 符合 `envelope.schema.json`，message / 退出码与 `exit-codes.json` 一致；签名向量的期望码与参照判定一致。

CI 中的兄弟仓固定在被测版本（aster-lang-ts `v3.2.0`、aster-guard `v0.3.0`），不跟随 main：夹具的 IR 与期望值属于这一版本的编译器
（生态 1.0.49），main 上的 IR 变化（例如 aster-cloud/aster-lang-ts#339 的列对齐）不应让本仓变红。
源夹具 `src/compile/compile.json` 的 `pinnedTsDivergence`（只在 src，不进 `cases.json`）标出「两个 CLI 期望已一致、但固定的 ts 版本早于修复」的行
（目前是 aster-cloud/aster-lang-ts#348 的两行）：`--verify-engines` 断言所用 ts 仍给出不同结论，升级固定版本后分歧消失即报错，提醒去掉该字段。

### 重新采集（`--capture`，本地手动，CI 不跑）

升级被测编译器（生态 / ts 版本）时，由发起升级的人（列车负责人）重新采集并在同一 PR 里提交：

1. 构建对应版本的 aster-api（`./gradlew quarkusBuild -x test`），把 `build/quarkus-app` 的 `lib/main/*.jar`、`lib/boot/*.jar` 与 app jar
   以冒号连接写入 `cp.txt`；起 PG / Redis（podman）后以 `ASTER_SECURITY_APIKEY_ENABLED=false ASTER_SECURITY_SIGNATURE_ENABLED=false
   ASTER_SECURITY_RBAC_ENABLED=false ASTER_RUNTIME_BUILD=<非 dev 值>` 及一组仅本地的 guard 收据密钥启动 `quarkus-run.jar`；
2. `node scripts/build-package-fixtures.mjs --capture --cp-file cp.txt --api http://localhost:<port> --ts ../aster-lang-ts`：平台 IR 由
   `scripts/package-v1/PlatformCompile.java` 按 aster-api `PolicyCompiler` 的生产编译序列取得，期望值与值树取自 `/evaluate-json`；
3. `node scripts/build-package-fixtures.mjs`，再跑 `--check` 与 `--verify-engines`，并把 CI 的固定版本改到新 tag。

本次采集：aster-api `773a92a6`（生态 1.0.49，即 P0 实测所用构建）、aster-lang-ts 3.2.0。

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
- 给出 `stdin`（UTF-8 文本，可为空串）或 `stdinB64`（原始字节的 base64，用于 BOM、非法 UTF-8 等无法写进 JSON 字符串的输入）；都缺省表示不提供 stdin。
- 先用 `normalize-stdout.mjs`（JVM：`StdoutNormalizer.java`，跑 `vectors/stdout-normalize.json`）归一实际 stdout，再与 `expectedStdout`
  逐字节比较；退出码与 `expectedExit` 比较。`code` 是期望的错误码（成功为 `null`；`verify` 为第一项失败检查的码），供只断言错误码的单测使用。
- `engines` 字段保留给只适用于一侧的用例；v1 夹具没有这样的用例，**全部用例两侧都跑**。
- `compile/cases.json` 的成功用例以 `expectedPositionFreeSha256` 代替逐字节比较 stdout（见「compile」）。
- `tamper/cases.json` 的每条另带 `base`（派生自哪个黄金包）。`tamper/test-time.json` 的用例带 `recipe`，由测试在临时目录生成包或输入后运行（见「体积上限」）。

## 输出

所有子命令的 stdout 都是**一行值规范 JSON + `\n`**；诊断只写 stderr。形状见 `envelope.schema.json`：

- `run` 成功 `{"meta":M,"ok":true,"value":V}`；失败 `{"error":{"code":C,"message":S},"meta":M,"ok":false}`。
- `inspect` 成功 `{"inspect":{effects,governance,policy,runtime,schemas,tests},"meta":M,"ok":true}`：五个成员原样取自 manifest，
  `schemas` = `{"input": schema/input.json 的内容, "output": schema/output.json 的内容}`（ADR §4.1「打印入口、输入输出 schema」）。失败输出与 `run` 相同的错误信封。
- `verify` 恒为 `{"checks":[…],"meta":M,"ok":bool}`（`USAGE` 例外，输出错误信封），每个检查 `{"name","ok"}`，失败的那一项另带 `"code"`。
- `version`：`{"cliVersion","coreIrVersions":[2],"engine","formatVersions":["1.0"],"toolchainId","trustAnchorKids":[…]}`，不参与跨 CLI 比较。
- **裁决（固定 message）：`error.message` 必须逐字等于 `exit-codes.json` 中该错误码的 `message`。** 细节（哪个文件、哪个哈希、编译诊断、
  引擎异常文本、入口被 `main` 抢占的原因）一律写 stderr。计划原写「`PKG_IR_DRIFT` 的 message 带编译诊断」，那样失败信封无法跨 CLI 逐字节相同。
- **裁决（新错误码）：`PROBE_MISMATCH`（退出码 1）** 只由 `verify --probes` 产生。

`M` 的取值时机（两侧必须相同，否则失败信封不能逐字节相等）：

| 字段 | `run` / `inspect` | `verify` |
|---|---|---|
| `signed` | 签名检查通过后为 `true`；在此之前失败、无签名且 `--allow-unsigned`，均为 `false` | 同左 |
| `entry` | 取得 IR 后为所选入口名（`--entry` 的值，不论是否存在；缺省为 `default:true` 的入口）；之前为 `null`。`inspect` 成功时为缺省入口 | integrity 通过后为缺省入口，否则 `null` |
| `coreIrSha256` | 取得 IR 后为 `manifest.coreIr.sha256`（不是本地编译结果的哈希）；之前为 `null`。`inspect` 成功时填入 | integrity 通过后填入 |
| `irRecompiled` | B 包取得 IR（本地编译且投影哈希一致）后为 `true`；A 包恒 `false`；`inspect` 恒 `false` | `--recompile` 检查通过后为 `true` |
| `engine` / `cliVersion` | 各自的值；比较前归一为 `"<ENGINE>"` / `"<CLI_VERSION>"` | 同左 |

## 检查顺序

两个 CLI 按同一顺序检查，在第一处失败停止。「阶段」决定 `meta`（见上表）与 `verify` 中报告失败的检查项：

| 阶段 | 检查 | 失败码 | `verify` 检查项 |
|---|---|---|---|
| usage | 命令行语法（见「命令行」）；信任锚文件的读取与校验（见「信任锚」）；环境变量 `ASTER_TRUFFLE_FUNC` 已设置（仅 JVM，修订 A5） | `USAGE` | 不输出 checks，输出错误信封 |
| read | 读包（见「包路径」「zip 规则」「体积上限」）；没有 `manifest.json` | `PKG_INTEGRITY`；缺 manifest 为 `PKG_INVALID_MANIFEST` | `integrity`（缺 manifest 为 `schema`），唯一一项 |
| manifest | ① 大小 ≤ 1 MiB ② 严格 JSON（见「严格 JSON」，深度 ≤ 64）③ 所有数字都是 ±(2⁵³−1) 内的整数（规范 JSON 的数字域；用任意精度整数读入的实现也必须拒绝超出者，夹具 `manifest-unsafe-integer`），且**文件字节**逐字节等于其解析结果的规范 JSON 的 UTF-8 ④ `format` 为字符串 `aster-policy-package`，`formatVersion` 为字符串且匹配 `^(0\|[1-9][0-9]{0,8})\.(0\|[1-9][0-9]{0,8})(?![\s\S])` ⑤ 主版本 = 1 且次版本 ≤ 0 ⑥ schema ⑦ 语义规则（见「manifest 语义规则」）⑧ `coreIr.version` = 2 | ⑤ `PKG_UNSUPPORTED_FORMAT`；⑧ `PKG_UNSUPPORTED_IR`；其余 `PKG_INVALID_MANIFEST` | `schema` |
| signature | 无 `manifest.sig.json`：`--allow-unsigned` 时继续（`signed=false`），否则失败。有签名文件（即使给了 `--allow-unsigned` 也必须成立）：大小 ≤ 64 KiB → 严格 JSON → sig schema → `sig` 为规范 base64url（解码后重新编码与原文相同）→ 按「信任锚」取公钥（取不到为 `PKG_UNTRUSTED_KID`）→ Ed25519 验签 manifest 文件字节（RFC 8032：拒绝 S ≥ L） | `PKG_UNSIGNED`；`PKG_UNTRUSTED_KID`；其余 `PKG_SIGNATURE` | `signature` |
| integrity | `files[]` 每项存在、大小与 SHA-256 相符；包内除三个元文件外没有 `files[]` 以外的文件；`SHA256SUMS` 存在且逐字节等于由 `files[]` + `manifest.json` 生成的内容（GNU 格式 `<hex>␠␠<path>\n`，按路径 UTF-8 字节序）；A 包 `compiled/core.json` 的 SHA-256 = `coreIr.sha256`；`source.sha256` = `policy/policy.aster` 的 SHA-256；`tests.probesSha256` = `tests/probes.json` 的 SHA-256；`tests.probes` = 该文件（严格 JSON）中 `probes` 的条数 | `PKG_INTEGRITY` | `integrity` |
| ir | A：严格读入 `compiled/core.json`（ts `readCoreIr` / core `CoreIrJson.read`）。B：按 manifest 的 locale / aliasSet / allowStructural / 词汇本地编译（含 aliasSet 校验），按 `positionFreeSha256` 比对 | A 读入失败 `PKG_UNSUPPORTED_IR`；B 编译失败或不等 `PKG_IR_DRIFT` | A 包：`ir`（普通 `verify` 也做）；B 包不在普通 `verify` 中编译，只在 `recompile` / `probes` 中出现 |
| entry | `--entry`（缺省取 `default:true`）必须是 `policy.entries` 中的函数；JVM 另有入口被 `main` 抢占的情形 | `ENTRY_NOT_FOUND` | — |
| input | 读 `--input <file>` 或 `-`（stdin），按「输入」校验；文件不存在或不可读也在此报 | `INPUT_INVALID` | — |
| eval | 沙箱求值；结果按值规范 JSON 写出（写出失败，如嵌套超过 64 层，为 `EVAL_ERROR`） | `EVAL_ERROR`、`TIMEOUT`、`RESOURCE_EXHAUSTED` | — |

**裁决（格式版本先于 schema）：** 计划 T2 Step 3 写的是「规范字节 → schema → formatVersion」。这里把格式版本放在 schema 之前，
使带新字段的 1.1 manifest 报 `PKG_UNSUPPORTED_FORMAT`（ADR §3 的本意）而不是 `PKG_INVALID_MANIFEST`（夹具 `format-version-1.1-with-new-field`）。

`verify`：
- 检查项依次为 `schema`、`signature`、`integrity`、`ir`（**仅 A 包**：严格读入 `compiled/core.json`，失败码 `PKG_UNSUPPORTED_IR`，与 `run` 一致，对应 ADR §4.1 的「运行时兼容」）、`recompile`（仅 `--recompile`）、`probes`（仅 `--probes`），**在第一项失败处停止**，之后的项不输出。
- `recompile`：对 A、B 都按 manifest 本地编译 `policy/`，按 `positionFreeSha256` 比对，失败码 `PKG_IR_DRIFT`。
- `probes`：按 `tests/probes.json` 逐条以 `run` 的 entry → input → eval 路径求值（B 包先本地编译，失败码 `PKG_IR_DRIFT`；A 包严格读入
  `compiled/core.json`，失败码 `PKG_UNSUPPORTED_IR`），每条的超时为 `--timeout`（缺省 5 s，按条计）。**任何一条不符都报 `PROBE_MISMATCH`**：结果与期望不同、
  条目本身不合法（`entry` 不是 manifest 中的入口、`input` 不符合「输入」规则、`expected` 不是下文两种形状之一）、求值超时或资源耗尽、期望成功却求值失败
  （夹具 `a-probe-bad-entry`、`a-probe-bad-input`、`a-probe-bad-expectation`、`a-probe-timeout`）。
- A 包给了 `--recompile` 时，`probes` 仍然对 `compiled/core.json` 求值（本地编译只用于 `recompile` 比对，不替换平台 IR；夹具 `a-decimal/verify-recompile-and-probes`）。
- 退出码 = 失败检查项的错误码对应的退出码，全部通过为 0。
- 无签名且 `--allow-unsigned` 时 `signature` 记为 `{"name":"signature","ok":true}`，由 `meta.signed=false` 表明未验签。

`inspect` 执行 usage → read → manifest → signature → integrity，不取 IR、不求值；接受 `--jwks` / `--pubkey` / `--allow-unsigned`。

信息字段：`target`、`runtime.*`、`source.claimedRef`、`source.envelopeSha256`、`exportedBy`、`manifest.sig.json` 的 `issuer` 都**不**由 CLI 核验或据此放行
（夹具里 node / jre 两种 target 都由两个 CLI 运行）。A 包在 P1 不带 `runtime/` 文件（只测 `compiled/` 路径），`runtime.cli.sha256` 取空字节的哈希；
`runtime/aster.mjs` 这类未列入 `files[]` 的文件照常是多余文件（夹具 `extra-runtime-file`）。输出 schema（`schema/output.json`）只供阅读与 `inspect`，CLI 不校验求值结果。

## manifest 语义规则（schema 之后）

schema 表达不了、但两侧都必须判的规则，失败一律 `PKG_INVALID_MANIFEST`：

- `files[].path` 按 UTF-8 字节**严格**升序（即无重复）；按 ASCII 小写比较也不得重复（`README.md` 与 `readme.md` 不能并存，否则无法在大小写不敏感的文件系统上落成目录形态）；
- `policy.entries[].function` 互不相同；每个入口的 `inputSchema` 与 `outputSchema` 都恰为 `#/$defs/entry.<function>`；
- `policy.moduleName` 与每个 `function` 是 NFC（`s === s.normalize('NFC')`）。

标识符（C1）：`function` 与 `moduleName` 的段使用两侧 canonicalizer 的完整标识符规则 `[\p{L}_][\p{L}\p{M}\p{Nd}_]*`（ts `canonicalizer.ts`，Java
`Canonicalizer.isIdentifierPart`），覆盖 zh-CN / de-DE / hi-IN 名字（黄金包 `b-zh`：`块.遮蔽` / `分支遮蔽`）。`files[].path` 仍只允许 ASCII（固定文件名）。

**正则语义（I1）：** 两份 schema 中的模式都以 `(?![\s\S])` 而不是 `$` 收尾。ECMA-262（ajv）中二者等价，但 `java.util.regex`（networknt 的缺省
`Matcher.find()`）里 `$` 还会匹配末尾换行之前，`"test-2026-11\n"` 这样的值会在 JVM 上通过 schema。两侧各自用自己的正则引擎即可，无需切换到
ECMA 引擎；schema 不得再出现以 `$` 收尾的模式（夹具 `signature-kid-trailing-newline`、`manifest-sha256-trailing-newline`）。本 README 中 schema 之外的规则（`formatVersion`、`--timeout`、Long / Decimal 字符串）同样要求整体匹配、不接受末尾换行，文中的模式也都以 `(?![\s\S])` 收尾（夹具 `format-version-trailing-newline`、`usage-timeout-trailing-newline`、`long-string-trailing-newline`、`decimal-trailing-newline`）。

## 严格 JSON

`manifest.json`、`manifest.sig.json`、`tests/probes.json` 与 `--input` 都按同一语法读（参照实现 `scripts/lib/package-v1/strict-json.mjs`）。
各 JSON 库的缺省宽容度不同（Jackson 跳过 BOM、接受尾随 token；`JSON.parse` 对重复键取后者），因此 CLI 必须显式检查：

- 字节是合法 UTF-8，不以 BOM 开头；RFC 8259 语法，恰好一个值，前后只允许空白（空格、`\t`、`\n`、`\r`）；字符串内不得有未转义的控制字符；
- 对象内不得有重复键；字符串（含键）解码后不得含孤立代理项；
- 嵌套深度（对象 / 数组层数）≤ 64；数字溢出为 ±Infinity 即失败；整数 token（不含 `.` `e` `E`）必须无损读取（BigInt / BigInteger）。

## 包路径

- 路径参数指向**目录**即按目录形态读，指向**普通文件**即按 zip 读，与扩展名无关（夹具 `b-credit-limit-dir.zip/`、`b-credit-limit-zip-no-extension`）；不存在或是其他类型（FIFO 等）为 `PKG_INTEGRITY`（read）。
- 路径参数本身可以是符号链接（照常解析）；**目录内任何位置**的符号链接都使读包失败（`PKG_INTEGRITY`，read），不跟随。
- 目录形态中的子目录（含空子目录）不进入文件表，但计入条目数上限与深度上限（见「体积上限」）。

## zip 规则

只在内存解压、从不写盘。读取方先把整个文件读入内存（≤ 64 MiB），**同时解析中央目录与本地头并要求二者一致**——只用流式读取
（fflate `Unzip`、`java.util.zip.ZipInputStream`）看不到中央目录，必须另外校验（夹具 `zip-lfh-cd-*`；`ZipInputStream` 单独读这类文件不会报错）。
全部在 read 阶段判定，失败一律 `PKG_INTEGRITY`（参照实现 `reference-check.mjs` 的 `readZip`）：

- 文件本身 > 64 MiB；不是 zip；EOCD 必须恰在文件末尾（无归档注释、无尾随字节）；单卷；空归档失败；
- 第一个本地头在偏移 0（无前置字节），各条目按中央目录顺序紧密排列，最后一个条目之后紧接中央目录；条目注释必须为空；
- 每个条目的本地头与中央目录的名字字节、通用标志、方法一致；未置标志位 3 时本地头的 crc / 两个大小与中央目录一致；置标志位 3（数据描述符）时
  本地头的这三项为 0，数据后必须有带签名 `PK\x07\x08` 的描述符且与中央目录一致；**中央目录的大小为权威的「声明大小」**。两个方向的不一致都有夹具：中央目录错（`zip-lfh-cd-*`，只读本地头的流式实现会放过）与本地头错（`zip-lfh-*-wrong-cd-right`，只读中央目录的实现如 `java.util.zip.ZipFile`、fflate `unzipSync` 会放过）；
- 通用标志只允许位 3 与位 11（UTF-8 名）；加密等其他位失败；数据描述符只允许用于 deflate 条目；只接受方法 0（stored）与 8（deflate）；
  ZIP64（大小或偏移为 0xFFFFFFFF、条目数为 0xFFFF、或任何 0x0001 extra）失败；其他 extra field 忽略；
- 条目名必须是合法 UTF-8；含非 ASCII 字符时必须置位 11；
- 全部条目位于唯一的根目录 `<root>/` 之下。根段：非空、NFC、不是 `.` / `..`、不含 `/`、`\` 与控制字符（U+0000–U+001F、U+007F–U+009F）；
  其含义（ADR §2 的 `<moduleName>-v<version>-<target>-<mode>`）不校验，可以是非 ASCII（`块.遮蔽-v1-node-b`）。去掉根之后的路径受 `files[].path` 的 ASCII 规则约束
  （无 `.` / `..` 段）；目录条目（名以 `/` 结尾、大小为 0）同样受此约束（`<root>/../` 失败）；去掉根与末尾 `/` 之后为空的条目只允许是根目录条目 `<root>/` 本身（`<root>//` 失败）；下文逐条目的大小、CRC 与 deflate 规则对目录条目同样适用（带数据或 CRC 不是 0 的目录条目失败），目录条目只是不进入文件表；
- 同名条目重复即失败；
- 解压时边读边计数：单条实际解压字节 ≠ 声明大小、或累计实际解压字节 > 64 MiB 即失败（夹具：声明 1 KiB 实际 1 GiB 的单条目；1 000 个各 1 MiB 的条目；
  列在 `files[]` 中、声明大小正确却解压出 1 GiB 的 `README.md`）；解压后的 CRC-32 必须等于中央目录的 crc；
- deflate 条目的压缩数据必须**恰好**是一个完整的 deflate 流：最终块结束后、`csize` 之内还有字节即失败（夹具 `zip-deflate-trailing-bytes`；Node `inflateRawSync` 会静默忽略这些字节，`java.util.zip` 则可能把它们当成下一个头，两侧必须显式比较已消耗的输入字节数与 `csize`：Node 用 `node:zlib` `inflateRawSync(…, { info: true })` 的 `engine.bytesWritten`，JVM 用 `Inflater.getBytesRead()`；fflate 不公开该计数，不能用来实现这条）；
- 符号链接条目只是普通字节，不会被跟随（必然成为多余文件或哈希不符）。

zip 夹具是确定性的：mtime 1980-01-01、无 extra field（ZIP64 夹具除外）。`b-credit-limit.zip` 为本地头带大小的形态；`b-zh.zip` 按 aster-api 导出时
`java.util.zip.ZipOutputStream` 的写法生成（全部条目置位 11，deflate 条目置位 3 并带数据描述符）。deflate 由手写的存储块与动态 Huffman 块组成
（`scripts/lib/package-v1/zip.mjs`），不依赖 zlib 的压缩输出，任何机器上 `--check` 都逐字节复现。

## 体积上限

| 对象 | 上限 | 超出时 |
|---|---|---|
| zip 文件本身 | 64 MiB（先 `stat` 判断，再读入内存） | `PKG_INTEGRITY`（read） |
| 解压后单个条目 / 累计 | 64 MiB | `PKG_INTEGRITY`（read） |
| 目录形态的单个文件 / 文件累计 | 64 MiB（先 `stat` 判断，不得先读入再判断） | `PKG_INTEGRITY`（read） |
| 目录形态的条目数（普通文件与子目录，不含包根） | 1 024 | `PKG_INTEGRITY`（read） |
| 目录形态的子目录嵌套深度（包根的直接子目录为第 1 层） | 32 | `PKG_INTEGRITY`（read） |
| zip 的条目数（EOCD 记录的总数，含目录条目） | 1 024 | `PKG_INTEGRITY`（read） |
| `manifest.json` | 1 MiB | `PKG_INVALID_MANIFEST`（manifest） |
| `manifest.sig.json` | 64 KiB | `PKG_SIGNATURE`（signature） |
| `--input` | 16 MiB | `INPUT_INVALID`（input） |

**文件数与大小的先后（两侧必须相同，失败信封才一致）：**
- 目录形态：每层目录内按名字的 UTF-8 字节序遍历，对每个条目依次：符号链接 → 失败；子目录 → **先**判深度（> 32 失败）、**再**计入条目数（> 1 024 失败）、然后递归；
  普通文件 → **先**计入条目数，**再**判该文件大小与累计大小。任一项超出立即失败，不再继续遍历。深度上限防止两侧在病态嵌套上以不同方式栈溢出
  （测试时配方 `dir-depth-over-32`、`dir-depth-32-passes-read`、`dir-too-many-directories`、`dir-too-many-files`）。
- zip：先按 `stat` 判文件大小，读入后找 EOCD，**再**判 EOCD 记录的条目数，之后才解析中央目录与解压（夹具 `zip-too-many-entries`）。
- 上限取 1 024：v1 包最多十几个文件；1 024 个各 64 KiB 的文件恰好等于 64 MiB 的总量上限，两项上限不会互相掩盖常见情形。

几十 MiB 的夹具不入库：`tamper/test-time.json` 给出配方（复制黄金包目录后写入指定大小的零字节文件；或生成超长输入），由各 CLI 的测试在临时目录生成。

## 信任锚

信任锚的读取与校验属于 usage 阶段：锚文件不可读或不合法一律 `USAGE`（在读包之前）。JWKS 与 JWK 文件按「严格 JSON」读
（BOM、重复键、值之后的多余内容都是 `USAGE`；夹具 `usage-jwks-bom`、`usage-jwks-duplicate-json-key`、`usage-jwk-pubkey-trailing-garbage`）。

- 不给锚：使用内置 `export-jwks.json`。它只含平台的生产导出公钥（P1 为 `{"keys":[]}`，ADR 0059 P2 T25 起为 `export-2026-11a`），从不含测试密钥；夹具一律用测试密钥签名，所以不给锚时签名包都是 `PKG_UNTRUSTED_KID`（夹具 `builtin-anchor-rejects-test-kid`、`package-builtin-anchor-rejects-test-kid`）。
- `--jwks <file|url>`：参数匹配 `^[A-Za-z][A-Za-z0-9+.-]*://` 即视为 URL，否则按本地文件读。URL 必须以字面量小写 `https://` 开头，其他（含 `http://`、`ftp://`、
  大写 `HTTPS://`）一律 `USAGE` 且不发请求（夹具 `usage-jwks-http-url`、`usage-jwks-ftp-url`、`usage-jwks-uppercase-scheme`）。
  **初始 `--jwks` URL** 与 `Location` 受同一套规则，且在 usage 阶段、发出任何请求之前判定，违反即 usage 阶段的 `USAGE`（退出码 2）：
  ① 字符级与下文 `Location` 相同，必须是合法的 RFC 3986 URI-reference（原始空格、反斜杠、控制字符、原始非 ASCII 字符、非法 `%XX` 一律拒绝，不得悄悄编码或修正）；
  ② 满足下文的请求目标规则（host 非空、端口 1–65535 且不得为空、无 userinfo、`[` `]` 只用于 IP-literal），且非 IP-literal 的 host 不得含 `:`
  （`https://a:b:443/`、`https://h::443/`）。参照实现 `argv.mjs` 的 `checkAnchor`（`URI_REFERENCE_CHARS` + `validateRequestTarget`）；
  夹具 `usage-jwks-url-non-ascii`、`-space`、`-bad-percent`、`-backslash`、`-colon-in-host`、`-double-colon-port`、`-userinfo`、`-empty-port`。https 取回的规则：
  - **总**时限 10 s：从第一次请求开始，到读完最后一个响应体为止（含连接、TLS、全部重定向），不是套接字空闲超时——细水长流的响应体到点同样失败；只认 2xx；响应体 ≤ 1 MiB（超出即中止；恰好 1 MiB 可以）；
  - 请求带 `Accept-Encoding: identity`；响应的 `Content-Encoding` 缺省或为 `identity` 才接受，其他（如 `gzip`）为 `USAGE`（上限因此作用于未解码的字节）；
  - 重定向只认 301、302、303、307、308，其他 3xx（如 300）按非 2xx 处理为 `USAGE`；至多跟随 3 次，每一跳都必须是 https（https → http 失败）；
    `Location` 的处理（两侧必须逐字相同，参照实现 `argv.mjs` 的 `resolveReference`）：
    - 必须是合法的 RFC 3986 URI-reference：只含 unreserved / reserved 字符与合法的 `%XX`。空值、原始空格、反斜杠、控制字符、原始非 ASCII 字符一律 `USAGE`，
      **不得**像 WHATWG URL 解析那样悄悄修正（Node 的 `new URL()`、JVM 的 `URI.resolve` 宽松用法都不可直接用于校验）；
    - 相对引用按 **RFC 3986 §5.2.2**（含 §5.2.4 remove_dot_segments）相对**当前**请求 URL 解析。例：基准 `https://h/a/b` 下，`?q` → `https://h/a/b?q`，
      `../../x` → `https://h/x`；
    - `Location` 中的 scheme **不区分大小写**（`HTTPS://…` 视为 https 并跟随）；`--jwks` 参数本身仍只认字面量小写 `https://`；
    - **空的 `Location`（含只有空白的值）为 `USAGE`**：这是有意偏离 RFC 3986（RFC 3986 会把空引用解析为基准 URL 本身），以免同一 URL 无限重定向；
    - **解析出的目标在发出请求之前**还要满足（与初始 URL 相同的请求目标规则）：host 非空（`https:///x` 拒绝）；端口可省略，给出时必须是十进制 1–65535，**空端口**（`https://h:/x`，RFC 3986 允许）同样拒绝；
      **不得含 userinfo**（`u:p@`、`u@`，以及空的 `@`）；`[` `]` 只能作为 IP-literal host 的边界（`https://[::1]/`），路径、查询、片段或普通 host 中出现即拒绝
      （`https://h/a[b]`）；非 IP-literal 的 host 不得含 `:`（按最后一个 `:` 拆出端口后 host 仍含 `:`，如 `https://a:b:443/`）。任何违反都是 `USAGE`（参照实现 `validateRequestTarget`；配方 `https-jwks-redirect-empty-host`、`-port-out-of-range`、`-empty-port`、
      `-userinfo`、`-empty-userinfo`、`-brackets-outside-ip-literal`）；
    - 配方：`https-jwks-location-query-only-ok`、`https-jwks-location-dotdot-ok`、`https-jwks-location-uppercase-scheme-ok`（通过），
      `https-jwks-location-invalid`（含空格）、`https-jwks-location-backslash`（`USAGE`）。
  - **v1 不使用代理**：一律直连，`HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`、`NO_PROXY`、`no_proxy` 都忽略
    （Node 不得启用 `EnvHttpProxyAgent` / `NODE_USE_ENV_PROXY`；JVM 用 `HttpClient.Builder.proxy(HttpClient.Builder.NO_PROXY)`）；
  - TLS 信任库 = **各运行时的标准信任配置**，再在给出时追加 `ASTER_ANCHOR_CA_FILE`：
    - Node：系统 CA、内置 CA 与 `NODE_EXTRA_CA_CERTS`，即 `tls.getCACertificates('default')` ∪ `tls.getCACertificates('system')`（只取 `'system'` ∪ `'bundled'` 会丢掉 `NODE_EXTRA_CA_CERTS`，不对）；
    - JVM：缺省 TrustManager，即 `cacerts`，或设置了 `javax.net.ssl.trustStore` 时用它；
    - 通过这些标准途径安装的企业 CA 必须生效；
  - **仅供测试**的信任覆盖：环境变量 `ASTER_ANCHOR_CA_FILE` 指向一个 PEM 文件时，在标准信任库之上**追加**信任其中的证书（不是替换；只用于取信任锚）；
  - 任何失败（连接、TLS、超时、非 2xx、超限、重定向违规、不是严格 JSON、JWKS 不合法）都是 `USAGE`。
  测试时配方 `https-jwks-*`（`tamper/test-time.json`，26 条）在 127.0.0.1 上起自签名 https 服务、经 `ASTER_ANCHOR_CA_FILE` 信任，并把全部代理变量指向一个不通的地址
  （证明代理被忽略），全程离线；参照实现 `argv.mjs` 的 `fetchJwks` 由单测在同样的环境变量下跑同一组路由。
- 本地锚文件（`--jwks <file>`、`--pubkey <file>`）≤ 1 MiB，超出为 `USAGE`，先按大小判断再读入（夹具 `jwks-file-exactly-1MiB-ok`、`usage-jwks-file-over-1MiB`、`usage-pubkey-file-over-1MiB`）。
  JWKS：每个 key 必须 `kty:"OKP"`、`crv:"Ed25519"`、`x` 为 32 字节的规范 base64url、`kid` 为非空字符串；`alg` 若给出必须是 `EdDSA`、`use` 若给出必须是 `sig`；
  `kid` 不得重复；任何一个 key 不合法都使整个文件不合法。按签名文件的 `kid` 查找，找不到为 `PKG_UNTRUSTED_KID`。
- `--pubkey <file>`：两种形态，按首个非空白字符区分：
  - 原始公钥：文件内容恰为 32 字节公钥的规范 base64url（无填充），后面至多一个 `\n`（不接受 `\r\n`、空格或 `=`）。**不看 kid**：任何 kid 都用这把钥验签（夹具 `raw-pubkey-ignores-kid`）。
  - 单个 JWK（不是 JWKS）：校验同上。带 `kid` 时必须等于签名文件的 `kid`，否则 `PKG_UNTRUSTED_KID`；不带 `kid` 时不看 kid。
- `--jwks` 与 `--pubkey` 同时给出为 `USAGE`。

## 命令行

- 子命令 `compile`、`run`、`verify`、`inspect`、`version`；未知子命令为 `USAGE`。`run` / `verify` / `inspect` 恰有一个位置参数（包路径）。
- 带值选项：`--entry`、`--input`、`--timeout`、`--jwks`、`--pubkey`（`compile` 另有 `--locale`、`--alias-set`、`--vocabulary`、`--out`）；开关：`--allow-unsigned`、
  `--recompile`、`--probes`、`--allow-structural`。带值选项可写成 `--opt value` 或 `--opt=value`；选项与位置参数的先后任意；**同一选项出现两次为 `USAGE`**；未知选项为 `USAGE`
  （「未知」按子命令判：`compile --entry` 是 `USAGE`）。
- `--` 结束选项解析：其后的参数一律是位置参数（夹具 `double-dash-ends-options`、`usage-option-after-double-dash`）。
- 开关不带值：`--allow-unsigned=true` 之类为 `USAGE`；`--opt=` 的值为空为 `USAGE`（夹具 `usage-switch-with-value`、`usage-empty-equals-value`、`compile/usage-out-empty-value`）。
- 单独给出的空参数值同样是 `USAGE`：`--entry ""`、`--input ""`、`--locale ""`（夹具 `usage-separate-empty-entry`、`usage-separate-empty-input`、`compile/usage-locale-empty`）。
- `--opt value` 形式下，若下一个参数是**本子命令认识的选项**（`--input`、`--allow-unsigned` 等），视为缺值，`USAGE`；带值选项位于最末尾同样是缺值（夹具
  `usage-option-value-is-another-option`、`usage-option-value-is-a-known-switch`、`usage-option-missing-value-at-end`；若不判这条，`--entry --allow-unsigned` 会把开关当成入口名，得到 `ENTRY_NOT_FOUND`）。要传以 `--` 开头的值，用 `--opt=value`。
- `run` 必须给出 `--input`（`-` 表示 stdin）。`verify` 接受 `--timeout`（probes 每条的上限）。
- **超时的计时起点**：在**执行求值的线程里、紧挨着求值调用之前**开始计时。Node：在 Worker 内、IR 已读入（`readCoreIr`）且实参已转换之后、调用 `evaluate` 之前；
  JVM：Context 已创建、IR 已加载并选好入口之后、调用 `eval` / 执行入口之前。Engine / Context / Worker 的创建与 IR 读入都**不**计入，读包、验签、本地编译、
  输入校验同样不计入。到点由主线程 / 看门狗终止求值（Node `worker.terminate()`，JVM `context.close(true)`），输出 `TIMEOUT`，进程正常退出。
  `verify --probes` 每条探针各自计时。
- **求值前看门狗**：计时起点之前的阶段（Worker / Engine / Context 的创建、IR 读入与加载、实参转换）合计以 **60 s** 为界，超过即输出
  `RESOURCE_EXHAUSTED`（与求值阶段的资源耗尽同码）。这一结果与机器负载有关，和其他资源类结果一样不在逐字节一致的承诺内（修订 1 A4 / ADR §5.3），
  夹具不覆盖它（正常的包在这些阶段远低于 1 s；构造一个稳定超过 60 s 的合法包不现实）。两侧 CLI 各自用单元测试注入一个很慢的阶段（或把界限调小）验证。
  贴近边界的超时（求值耗时与上限相差无几）不在逐字节一致的承诺内（修订 1 A4 / ADR §5.3 的资源类结果）。
- `--timeout` 匹配 `^(0|[1-9][0-9]*)(ms|s)(?![\s\S])`，值必须 > 0 且 ≤ 300 s（`300000ms` 可以，`300001ms`、`0s`、`1.5s`、`01s`、`5` 都是 `USAGE`）；缺省 `5s`。

## 输入

`--input` 的内容（参照实现 `scripts/lib/package-v1/input.mjs`）：

1. ≤ 16 MiB，严格 JSON（见上）；
2. 顶层是对象，键**恰为**入口的全部形参名（逐字节；0 参入口只接受 `{}`）；
3. 每个形参按 Core IR 类型校验（下表）。失败一律 `INPUT_INVALID`。

包内 `schema/input.json` 用同一映射生成（P2 的导出端点必须照此生成）；它表达不了的规则（int64 范围、Decimal 位数、整数 token 与 `7.0` 的区别、严格 JSON）由 CLI 另判。

| Core IR 类型 | 输入形态 | `schema/input.json` |
|---|---|---|
| Int | 整数 token（不含 `.` `e` `E`；`7.0`、`7e0` 都不行），范围 **int32**（−2³¹ … 2³¹−1） | `{"type":"integer","minimum":-2147483648,"maximum":2147483647}` |
| Long | 整数 token 且在 ±(2⁵³−1) 内；或十进制字符串 `^-?(0\|[1-9][0-9]{0,18})(?![\s\S])` 且在 int64 内 | `{"anyOf":[{"type":"integer",…±(2⁵³−1)},{"type":"string","pattern":…}]}` |
| Double | 任意有限 JSON 数字（整数 token 也可以，转为 double guest 值） | `{"type":"number"}` |
| Decimal | 字符串 `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?(?![\s\S])`，数字（不计符号与小数点）至多 **80** 位（与 ts decimal.js `precision: 80` 一致）；JSON 数字不行 | `{"type":"string","pattern":…}` |
| Text / Bool | JSON 字符串 / 布尔 | `string` / `boolean` |
| List&lt;T&gt; | 数组，元素为 T 的形态 | `{"type":"array","items":…}` |
| Map&lt;Text, V&gt; | 对象，值为 V 的形态 | `{"type":"object","additionalProperties":…}` |
| Maybe&lt;T&gt; / Option&lt;T&gt; | `null` 表示 None，否则为 T 的形态（Some）；`{"__type":"Some",…}` 树形不接受 | `{"anyOf":[{"type":"null"},…]}` |
| 无载荷 Enum | 变体名字符串（`"Gold"`） | `{"type":"string","enum":[…]}` |
| Data `T` | 对象，全部字段必填（Maybe 字段的值可为 `null`），无多余字段 | `{"$ref":"#/$defs/data.T"}` |
| 入口 `f` | — | `#/$defs/entry.f`：全部形参必填、`additionalProperties:false` |

不能作为输入（P2 导出以 E733 拒绝）：Result、键不是 Text 的 Map、嵌套 Maybe、带载荷的 Enum、函数类型。

**裁决（I3，Int 为 int32）：** Truffle 的 Int 是 32 位（`CoreModel.IntE.value` 为 `int`，`Builtins.toInt` 截断），ts 用 JS number。
本地平台实测：超出 int32 的 Int 入参被 aster-api 转成 Long 后照常求值，Int 乘法溢出时也提升为 Long（`2147483647 × 10 = 21474836470`），
但这依赖宿主转换与具体 builtin，不是可承诺的语义。包格式因此把 Int 入参限定在 int32，超出即 `INPUT_INVALID`，需要大值时用 Long。
两引擎的整数宽度一致性（ts number 在 2⁵³ 之上失真、JVM 精确）另由 aster-cloud/aster-lang-truffle#183 跟踪。

## compile

`aster compile <pkg|file.aster> […]`，夹具在 `compile/`（`compile/cases.json`，路径相对该目录）：

- **两种形态按位置参数判**：位置参数以 `.aster` 结尾 → 源码形态；它不存在、是目录或不是普通文件都是 `USAGE`（夹具 `usage-source-missing`、`usage-source-is-a-directory`）。
  否则 → 包形态（目录或 zip，同「包路径」）。
- **源码的解码**：按严格 UTF-8 解码，非法字节为 `USAGE`（夹具 `usage-source-invalid-utf8`）；去掉**至多一个**开头的 BOM（U+FEFF）（`source-leading-bom-is-stripped`
  与 `credit.aster` 得到同一投影哈希）。包形态的 `policy/policy.aster` 按同一规则解码（非法 UTF-8 为本地编译失败）。
- **空白源码规则同样作用于包形态的 `policy/policy.aster`**（严格 UTF-8 解码、去掉至多一个开头 BOM 之后，只含 ASCII 空白即本地编译失败）：
  `compile <pkg>` 为 `COMPILE_ERROR`（meta 为 ir 阶段：`signed:true`，`entry` / `coreIrSha256` 为 null）；`verify --recompile` 为 `PKG_IR_DRIFT`；普通 `verify` 不编译而通过；
  A 包的 `run` 与 `verify --probes` 读 `compiled/core.json`，不受影响；B 包的 `run` 与 `verify --probes` 靠本地编译取 IR，为 `PKG_IR_DRIFT`
  （黄金包 `a-blank-policy`、`b-blank-policy`，以及 `compile/package-a-blank-policy`、`compile/package-b-blank-policy`）。
- **`compile` 只解析与降级，不做类型检查**（与 B 包本地重编译同一语义；aster-api `PolicyCompiler` 另跑 TypeChecker，包格式不采用）：有类型错误但语法正确的源码照常输出 IR
  （夹具 `source-type-error-is-not-checked`）。源码（解码并去掉 BOM 之后）为空或只含 **ASCII 空白**（U+0020、`\t`、`\n`、`\r`）为 `COMPILE_ERROR`
  （`source-empty`、`source-whitespace-only`、`source-only-bom-is-blank`）。U+00A0、U+3000 等其他 Unicode 空白不算空白，源码照常交给编译器
  （`source-only-nbsp-is-not-blank`、`source-only-ideographic-space-is-not-blank`：两引擎的词法空白都只认 ASCII 空格与 `\t`，在该字符上报 E050，期望 `COMPILE_ERROR`；见 aster-cloud/aster-lang-ts#348）。
- **源码形态**：可用 `--locale`（缺省 `en-US`；只支持 `en-US`、`zh-CN`、`de-DE`、`hi-IN`，形态合法但不在其中如 `fr-FR` 为 `USAGE`，夹具 `usage-locale-unsupported`）、`--alias-set <file>`（严格 JSON，`{"<SemanticTokenKind>":[别名…]}`）、`--vocabulary <file>`（严格 JSON）、
  `--allow-structural`（只能与 `--alias-set` 同用）、`--out`。`--jwks`、`--pubkey`、`--allow-unsigned` 是 `USAGE`；源码或这些文件不存在、不可读、不是严格 JSON 都是 `USAGE`。
  aliasSet 文件是严格 JSON 但形状不对（不是对象、值不是字符串数组、键不是已知的 `SemanticTokenKind`）为 `COMPILE_ERROR`，失败即拒（夹具 `source-alias-set-unknown-kind`、
  `source-alias-set-wrong-shape`、`source-alias-set-not-an-object`）；文件内容为 `null` 等同于没有 aliasSet。形状正确时按 aster-api `UserAliasValidator` 的规则校验
  （多词、规范形、结构词需 `--allow-structural` 等），不通过与源码编译失败一样是 `COMPILE_ERROR`。
- **期望值来源**：源码类用例的期望由 `--capture-compile` 按 aster-api `InProcessCnlParser` 的解析 + 降级序列（`scripts/package-v1/PlatformCompile.java`，
  不含类型检查，另按本节拒绝空白源码与形状不对的 aliasSet）采集；ts 参照（`--verify-engines`）按同样规则复算可复算的用例。
- **包形态**：走 usage → read → manifest → signature → integrity（接受 `--jwks`、`--pubkey`、`--allow-unsigned`），编译输入一律取自 manifest 与 `policy/`
  （A 包同样本地编译 `policy/`，不读 `compiled/`）；不与 `positionFreeSha256` 比对（漂移的包照常输出本地 IR，供排查；夹具 `package-drift-still-compiles`）。
  `--locale`、`--alias-set`、`--vocabulary`、`--allow-structural` 是 `USAGE`。本地编译失败为 `COMPILE_ERROR`。
- **输出**：成功时 stdout 为本地编译的规范 Core IR 字节加一个 `\n`；给 `--out <file>` 时把不带换行的规范 IR 字节写入该文件、stdout 为空。退出码 0。
  `--out` 原子写入（同目录临时文件再改名）；任何失败（含 `COMPILE_ERROR`）都不创建、不改动目标文件，也不留下临时文件（夹具 `source-syntax-error-writes-no-out-file`
  带 `outFileMustNotExist`）；父目录不存在或不是目录为 `USAGE`（`usage-out-parent-missing`），`--out` 本身是已存在的目录也是 `USAGE`（`usage-out-is-a-directory`），二者都在编译之前判定；
  父目录存在但不可写同样是 `USAGE`。
  两侧 IR 只差 origin 列（修订 1 A2），所以成功用例只比较投影哈希：`expectedStdout` 为 `null`（或 `--out` 时为 `""`）、`expectedPositionFreeSha256` 给出期望，
  `outFile` 表示要读 `<OUT>` 处的文件（测试把 `<OUT>` 换成临时路径）。带 `knownEngineDivergence` 的行，期望取平台（Java）解析结果，而 ts 编译器给出不同结论（跟踪 issue 见该字段，`knownDivergentEngine` 写明分歧的一侧）；Node CLI 在 issue 修复前会在这些行上失败，这是已知的引擎分歧，不是夹具错误。目前没有这样的行。失败时输出与 `run` 相同的错误信封（`meta` 按阶段，源码形态恒为 null / false）。

## tests/probes.json

严格 JSON，按值规范 JSON 写出：`{"probes":[{"entry":S,"expected":E,"input":{…}}…]}`，`E` 为 `{"ok":true,"value":V}` 或
`{"code":"EVAL_ERROR","ok":false}`（期望求值失败；超时与资源耗尽不在承诺内，P2 生成探针时丢弃这类探针）。`tests.probes` = 条数，
`tests.probesSha256` = 文件字节的 SHA-256。比较时**必须无损读取**（整数 token 读成 BigInt / BigInteger），把期望的 `V` 与求值结果各自按值规范 JSON
写出后逐字节比较；期望失败的探针要求求值以 `EVAL_ERROR` 失败。夹具 `a-inputs` 的探针结果超出 2⁵³（`9007199254740994`），用 `JSON.parse` 读会误判。

## 期望值来源

- 成功用例的 `value` 与 probes 的期望取自本地 aster-api `/evaluate-json`（`expected.json` 中 `source: "platform"`）。
- **平台 `/evaluate-json` 无法传入非整数 Decimal 与字符串形态的 Long**（JSON 字符串被当作 Text；带小数的 JSON 数字被当作 Double）。
  采集时把整数值的 Decimal 写成数字 token 发给平台；非整数 Decimal 与字符串 Long 的用例期望取自 ts 解释器（`source: "ts"`）。
  两个 CLI 都必须自己把这些字符串转成 Decimal / Long guest 值，不能照搬平台的 JSON 入参转换。
- `a-deep-recursion/depth-20000` 与 `a-multi-entry` 的除零用例已在平台上确认同样失败；`TIMEOUT` 与资源类结果按修订 A4 / P0 实测设定。

## 黄金包一览

| 包 | 形态 | 覆盖 |
|---|---|---|
| `b-credit-limit` | B，en-US，jre | Data 入参（含 Decimal 字段）、Verdict 四种结论、`--entry`、zip 形态（verify / inspect）、信任锚各形态、按类型判形态；`inputs-invalid` 与多数篡改夹具的基础 |
| `b-vocab-de` | B，de-DE + 词汇，node | 冻结词汇（`policy/compile/vocabulary.json`） |
| `b-zh` | B，zh-CN + 词汇，node | 中文模块名与函数名、非 ASCII zip 根、ZipOutputStream 形态的 zip（数据描述符、UTF-8 标志） |
| `b-alias` | B，非空 aliasSet，`allowStructural=true`，node | 别名多词规范形、过 `UserAliasValidator`；投影哈希下两侧都成功 |
| `a-decimal` | A，node | Decimal 字符串入参、HALF_EVEN 舍入、`verify --probes`、`verify --recompile` |
| `a-bad-probe` | A（派生自 a-decimal） | probes 第 2 条期望被改坏并重新签名：`verify` 通过、`verify --probes` → `PROBE_MISMATCH` |
| `a-probe-bad-entry` / `a-probe-bad-input` / `a-probe-bad-expectation` | A（派生自 a-decimal） | 探针条目不合法：`verify` 通过、`verify --probes` → `PROBE_MISMATCH` |
| `a-probe-timeout` | A（派生自 a-timeout） | 探针超时：`verify --probes --timeout 1s` → `PROBE_MISMATCH`（不是 `TIMEOUT`） |
| `a-inputs` | A，jre | Double / Long / List / Map / Maybe / Enum / Text 入参形态、int32 边界、结果超出 2⁵³ 的无损 probes |
| `a-multi-entry` | A，jre | 多个入口（无 `main`）、缺省与 `--entry`、Double 结果、0 参入口、`EVAL_ERROR`、`ENTRY_NOT_FOUND`、期望失败的 probe、命令行语法与 `USAGE` |
| `a-timeout` | A，node | `spin(60)` 在 `--timeout 1s` 下 `TIMEOUT` |
| `a-deep-recursion` | A，jre | `deep(20000)` 两侧 `RESOURCE_EXHAUSTED` |
| `unsigned` | A（派生自 a-multi-entry），无签名 | 缺省 `PKG_UNSIGNED`；`--allow-unsigned` 运行且 `signed=false`；`verify` 两种 |

已知风险（交给 T8）：JVM 沙箱的 `statementLimit 10_000_000` 可能在 1 s 之内先于看门狗耗尽，使 `a-timeout` 在很快的机器上得到 `RESOURCE_EXHAUSTED`
而不是 `TIMEOUT`（P0 实测 1 056 ms 时被取消，尚未触及上限）。T8 须在 CI 硬件上确认。
