# Changelog

## 2.0.0

### Breaking

- 删除 IR 归一化导出（包入口子路径及其模块）。Core IR v2（ADR 0055）下两引擎输出同一种规范字节，
  跨引擎比较改为 schema 校验加逐字节比较（`scripts/parity-tier1.mjs --mode=ir --full`，判定逻辑在
  `scripts/lib/ir-byte-parity.mjs`），不再需要归一化。ADR 0037 的 contentHash 改为对删除整个 `origin`
  后的规范 IR 取 sha256（ADR 0055 §6），不再经本包。
- `IR-DIVERGENCE-LEDGER.md` 退役：值层差异改由 `parity-tier1.mjs` 的 `VALUE_EXEMPTIONS`（V1–V4，
  每项带 issue、owner 角色与 2027-01-31 截止）登记。

### 新增

- tier1 parity 样本：`constraints-v2`、`annotation-order-v2`、`double-literals-v2`、
  `vocab-zh/enum-variant-v2`，以及 `constraint-single-sided-range`、`constraint-matching-pattern`、
  `pattern-nested-name-matches-enum-member` 进入 manifest 并带 eval golden（ADR 0055 #3、#4、#16、#18）。

## 1.2.0

### 新增

- tier1 parity 样本：多元素 `workflow`（depends on、retry、timeout、compensate，以及步骤名与 de-DE
  词汇函数同词的样本）、函数类型 `(T1, T2) -> R`、天城文类型名与枚举值（hi-IN）。这些样本依赖
  aster-lang-core 1.0.37 的 workflow 语法与天城文类型名修复（core#218、#220）和 aster-lang-ts 1.2.0 的
  函数类型解析（ts#247）（aster-lang-test#176）。

### 修复

- IR 归一化模块（2.0.0 已删除）中节点归一化函数的 JSDoc 归位，并给入口函数补上注释（#175）。

### 行为变化

- IR 归一化入口（2.0.0 已删除）在 `includeResolution: true` 时不再整棵丢弃 `type` / `ret` / `retType` 子树，
  其中的 `origin.written` / `role` 折叠为按先序排列的 `typeResolutions` / `retResolutions` /
  `retTypeResolutions`（规范名、原写法、角色、起始行）。推导出的类型形状仍不参与比较。parity 比较因此更严格：
  经词汇解析的签名与字段类型也会跨引擎比对，所以升次版本位（#174 子项 3）。
- 默认路径（`includeResolution` 为 false，即 `contentHash` 的输入）逐字节不变。
- Core IR（core 1.0.37）：Java 引擎对 workflow 未设置的 `retry` / `timeout` / `compensate` 省略键，
  不再输出 `null`，与 TS 一致；IR 差异台账中的 workflow 条目已转为已解决（aster-lang-core#219）。

## 1.1.0

### Breaking

- The IR normalisation entry point (removed in 2.0.0) now takes an options object
  `{ originMode?, includeResolution? }` instead of positional arguments.
  `includeResolution` defaults to `false`, so `contentHash` inputs are
  unchanged; parity comparisons pass `includeResolution: true` to also compare
  `origin.written` / `origin.role` (ADR 0051).

### Added

- Tier-1 parity corpus with corpus-carried vocabularies (`<case>.vocab.json`)
  and shared envelope vectors (`corpus/shared-vectors/envelope-vectors.json`)
  for ADR 0051.
