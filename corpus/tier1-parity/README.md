# tier1-parity — 严格双引擎契约

> PR-blocking 子集。Java ANTLR 和 TS PEG 两端都必须接受这里的每一个样本。

## 范围

`tier1-parity` 是从 `tier1-equivalence/policies/*.aster` 中选出的严格子集：
两个引擎都**当前可以解析通过**且属于 Aster CNL 规范核心语法的样本。

定义方式：见 [`manifest.json`](./manifest.json)。manifest 形式而非物理拷贝
有两个原因——避免双份维护，以及让"何为 tier1-parity"成为代码评审项而非
文件移动。

## 与其他 tier 的关系

| Tier | 角色 | CI 强度 |
|---|---|---|
| **tier1-parity** | 严格双引擎契约（本目录） | **PR-blocking** — 任一不匹配即红 |
| tier1-equivalence | 双引擎应该等价的全集 | Nightly + report-only |
| tier2-divergent | 已知一方拒绝的样本（驱动改进） | Nightly trend；不阻塞 |
| tier3-fixtures | 单引擎专属 fixtures（golden/lossless 等） | 各 consumer 自跑 |

## 准入标准

新增 tier1-parity 样本时必须：
1. 文件已存在于 `tier1-equivalence/policies/`
2. `equivalence-report.json` 最近一次跑显示 `verdict: 'equivalent'`
3. PR 描述说明覆盖的语法特性（避免堆积同质样本）

## 退出标准

样本暂时不能维持双引擎等价时：
1. 从 `manifest.json` 中移除（**必须解释原因**）
2. 在 `DIVERGENT-MANIFEST.md` 登记
3. PR 标签 `parity-regression`，需要 lang owner review

宁可让 manifest 短，也不要让 manifest 撒谎。

## 必拒样本（`mustReject`）

`samples` 是「两端都必须接受」的契约；`mustReject` 是它的反面：两端都**必须以解析错误拒绝**的输入，
例如运算符词前缀调用 `and(a, b)`、`plus(x, y)`、zh 的 `并且(真值，假值)`（Java `operatorCall` 只接受符号运算符）。

- 样本放在 `corpus/tier1-reject/`，meta 写 `"expect": "reject"`，可选 `"expectErrorLine": N`
  （声明后两端的首个错误都必须落在第 N 行，防止「因为别处写错而被拒绝」的假通过）。
- 只参与 `--mode=parse`：两端都报解析错误才算通过。只有一端拒绝（`ts-accepted` / `java-accepted`）、
  两端都接受（`both-accepted`）、引擎崩溃而非报解析错误（`ts-crashed` / `java-crashed`）、
  错误行号不符（`line-mismatch`）都会让门禁变红，并在报告的 Must-reject 一节点名。
- 不参与 `--mode=ir` / `--mode=eval`，也不计入 `EVAL-EXEMPTIONS.md` 的样本数与豁免数
  （`tag-eval-exempt.mjs` 只扫描 `tier1-equivalence/policies/`）。
- `tier1-reject/` 下的每个 `.aster` 都必须登记在 `mustReject` 中，否则 parity 门直接报错（不得静默跳过）。
- Java 侧判定来自 aster-lang-core 的 `TsSampleParseInventoryTest`：它照常扫描并打印这些样本的失败行，
  但按 `corpus/tier1-reject/` 前缀把它们排除在已知失败数棘轮之外。
- 判定逻辑在 `scripts/lib/must-reject.mjs`，回归测试 `node scripts/test-must-reject.mjs`。

新增必拒样本时，PR 描述须说明「为什么这是语言规定的非法输入」，而不只是「某个引擎目前拒绝它」——
后者属于 `tier2-divergent`。

## 语料自带词汇（ADR 0051 §8）

领域词汇按位置解析后，同一份本地化源码的规范 IR 取决于词汇。带词汇的样本放在 `tier1-parity/vocab-<locale>/`，
负例放在 `tier1-reject/vocab-*.aster`，每个样本旁有同名 `<case>.vocab.json`（DomainVocabulary JSON，两引擎共用的输入形态，
每个 field / enum 值都带 parent）。manifest 条目写成 `{ "path": "...", "vocab": true }`。

- 三个门都把词汇与 `meta.lexicon` 同时传给两个引擎：TS 走 `parseSource` → `resolveAndLower`（eval 用 `compile(source, { lexicon, vocabulary })`），
  Java 走 aster-lang-core `CoreIrFingerprintCli`（JSON 输入行 `{path, lexicon, vocabulary}`）与 aster-lang-truffle `CoreIrEvalCli`
  （请求带 `lexicon` / `vocabulary`）。
- parse 门对带词汇样本检查「解析 + 名称解析」：正例两侧都成功且警告码一致（`meta.expectWarnings` 声明时须相同，如 `["W800"]`）；
  负例两侧都在名称解析阶段拒绝，错误码集合相同且包含 `meta.expectCode`。默认不比对诊断位置：字段声明、构造字段、枚举成员处
  Java AST 曾无逐项 span，位置差异已登记。样本 meta 写 `"compareDiagnosticLines": true` 即对该样本比较两侧「码 + 起始行」
  的多重集合（列号不比）。TS 侧位置取自诊断的 `span.start`；Java 侧要求 aster-lang-core 的 `CoreIrFingerprintCli`
  在记录里输出 `locs: [{code, line, col}]`，缺失时判 `locs-missing`（不会静默通过）。逐项 span 落地并输出 `locs` 之前，
  没有样本打开该开关。
- eval golden 放在 `vocab-<locale>/inputs/<case>.cases.json`，不放在样本旁：JVM 包 `CorpusLoader.readCases()` 会把样本旁的
  `.cases.json` 交给不传词汇的消费方执行。
- 守卫（`scripts/lib/vocab-corpus.mjs`，回归测试 `node scripts/test-vocab-corpus.mjs`）：词汇文件必须被 `vocab: true` 条目认领，
  `vocab: true` 条目必须有词汇文件，`tier1-parity/` 下的 `.aster` 与 `inputs/*.cases.json` 必须能被 manifest 加载到，
  带词汇负例必须声明 `expectCode`。

非词汇样本同样放在 `tier1-parity/` 的子目录（字符串条目）：`workflow/`（多步 workflow、compensate、单步）与 `types/`（函数类型）。
这类样本没有 `inputs/` golden（`<dir>/inputs/*.cases.json` 只给带词汇条目加载），因此在 meta 里标 `evalExempt` 并写明原因，
只比较 parse 与 IR。依赖的兄弟仓修复：

| 样本 | 依赖 |
|---|---|
| `workflow/*`、`vocab-de/workflow-step-name` | aster-lang-core#218（多元素 workflow 语法）、#219（未设置的 retry / timeout / compensate 不序列化为 null） |
| `types/function-type` | aster-lang-ts#247（TS 解析器与降级支持 `(T1, T2) -> R`） |
| `vocab-hi/devanagari-type-names` | aster-lang-core#220（天城文可作类型名 / 枚举值） |

`workflow-step-name` 的 eval 只覆盖规则 `gesamt`→`total`：TS 解释器不支持求值 workflow，workflow 本身只比 parse 与 IR。
