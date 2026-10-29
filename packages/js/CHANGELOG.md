# Changelog

## 1.2.0

### 新增

- tier1 parity 样本：多元素 `workflow`（depends on、retry、timeout、compensate，以及步骤名与 de-DE
  词汇函数同词的样本）、函数类型 `(T1, T2) -> R`、天城文类型名与枚举值（hi-IN）。这些样本依赖
  aster-lang-core 1.0.37 的 workflow 语法与天城文类型名修复（core#218、#220）和 aster-lang-ts 1.2.0 的
  函数类型解析（ts#247）（aster-lang-test#176）。

### 修复

- `ir-normalize.ts` 中属于 `normalizeNode` 的 JSDoc 归位，并给 `normalizeIr` 补上注释（#175）。

### 行为变化

- `normalizeIr(node, { includeResolution: true })` 不再整棵丢弃 `type` / `ret` / `retType` 子树，
  其中的 `origin.written` / `role` 折叠为按先序排列的 `typeResolutions` / `retResolutions` /
  `retTypeResolutions`（规范名、原写法、角色、起始行）。推导出的类型形状仍不参与比较。parity 比较因此更严格：
  经词汇解析的签名与字段类型也会跨引擎比对，所以升次版本位（#174 子项 3）。
- 默认路径（`includeResolution` 为 false，即 `contentHash` 的输入）逐字节不变。
- Core IR（core 1.0.37）：Java 引擎对 workflow 未设置的 `retry` / `timeout` / `compensate` 省略键，
  不再输出 `null`，与 TS 一致；IR 差异台账中的 workflow 条目已转为已解决（aster-lang-core#219）。

## 1.1.0

### Breaking

- `normalizeIr(node, options)` now takes an options object
  `{ originMode?, includeResolution? }` instead of positional arguments.
  `includeResolution` defaults to `false`, so `contentHash` inputs are
  unchanged; parity comparisons pass `includeResolution: true` to also compare
  `origin.written` / `origin.role` (ADR 0051).

### Added

- Tier-1 parity corpus with corpus-carried vocabularies (`<case>.vocab.json`)
  and shared envelope vectors (`corpus/shared-vectors/envelope-vectors.json`)
  for ADR 0051.
