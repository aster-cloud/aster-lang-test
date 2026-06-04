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
