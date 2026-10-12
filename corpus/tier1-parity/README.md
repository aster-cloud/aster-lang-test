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
