# Changelog

## 2.5.0

### 新增

- tier1 parity 样本（aster-lang-ts#347，字符串字面量内容原样保留）：`syntax/quotes-in-string-literal`（`"…"` 里的 `‘ ’ “ ”`、
  `“…”` 定界、`“…"` 闭合）、`syntax/quotes-in-string-literal-zh`（「」里的 `“ ” ’` 与 ASCII `"`，`“…”`、`"…"` 定界）进入 manifest。
- 带词汇的 tier1 parity 样本（aster-lang-ts#345，字面量宏值转义后展开）：`vocab-en/literal-macro-escape`、`vocab-zh/literal-macro-escape`
  （宏值 `C:\new "x"`，各带 1 个 eval case），新增 `tier1-parity/vocab-en/` 目录。
- tier1 parity 样本（aster-lang-locales#143）：`syntax/let-be-ideographic-space-zh`（`令…定义为` 里的 U+3000 与 `\t` 是空白）。
- tier1 必拒样本：`reject-string-ascii-open-curly-close`（aster-lang-ts#347，`"abc”` 未闭合）；`reject-let-be-nbsp-zh`、
  `reject-let-be-em-space-after-be-zh`（E050）、`reject-let-be-newline-after-be-zh`、`reject-let-be-newline-before-be-zh`
  （aster-lang-locales#143，绑定不跨行）。这些样本的期望依赖 aster-lang-core 1.0.51、aster-lang-locales 1.0.51 与 aster-lang-ts 3.4.0（#229）。包入口 API 无变化。

## 2.4.0

### 新增

- tier1 parity 样本（aster-lang-ts#334，ADR 0056 修订 A3）：`types/field-annotations`、`types/field-annotations-zh`
  （字段前置注解，Field.annotations 两引擎逐字节一致）、`syntax/use-keyword-case`（`Use` / `use` / `USE` / `uSe` 同义，
  `USE` 仍可作类型名）、`tier1-equivalence/policies/lambda_inline_body`（lambda 单行体，带 2 个 eval case）进入 manifest。
- tier1 必拒样本（aster-lang-ts#334）：`reject-field-name-capitalized`、`reject-field-name-capitalized-multiline`（E055 字段名）、
  `reject-rule-name-capitalized`（E055 规则名）、`reject-identifier-leading-underscore`（E050）、
  `reject-of-type-arg-bare-lowercase`（E055，`Pair of Int, y` 的 `y`）。
- 这些样本的期望依赖 aster-lang-core 1.0.50 与 aster-lang-ts 3.3.0（#215、#225）。包入口 API 无变化。
- tier1 parity 样本（aster-lang-ts#348，词法空白只认 ASCII）：`syntax/unicode-space-in-string-and-comment`（字符串与注释里的
  Unicode 空白原样保留，含两个 U+2028 之间的空格）、`syntax/ideographic-space-zh`（zh-CN 的 U+3000 当空白）、
  `syntax/ascii-vt-ff-before-punct-zh`（标点前的 `\x0B` `\f` 当空白去掉）进入 manifest。
- tier1 必拒样本（aster-lang-ts#348，均为 E050）：`reject-whitespace-nbsp-only`、`reject-whitespace-ideographic-space-only`、
  `reject-whitespace-nbsp-between-tokens`、`reject-whitespace-nbsp-indent`、`reject-whitespace-nbsp-end-of-line`（及 `-zh`、`-hi`）、
  `reject-whitespace-ideographic-space-end-of-line-de`、`reject-whitespace-em-space-blank-line`、
  `reject-whitespace-narrow-nbsp-before-period`、`reject-whitespace-nbsp-before-comment`、`reject-whitespace-bom-mid-file`、
  `reject-whitespace-line-separator-end-of-line`。
- 包格式 v1 一致性夹具：`compile/source-only-nbsp-is-not-blank`、`compile/source-only-ideographic-space-is-not-blank`
  去掉 `knownEngineDivergence`（aster-lang-ts#348 修复后两个 CLI 都是 `COMPILE_ERROR`）。

## 2.3.0

### 新增

- tier1 parity 样本（aster-lang-ts#328，ADR 0056 修订 A2）：`types/param-annotations`、`types/param-annotations-zh`
  （形参前置注解，Param.annotations 两引擎逐字节一致）、`types/type-alias-keyword-case`（`Type` / `TYPE` / `type` 同义）、
  `types/maybe-prefix`、`types/maybe-prefix-zh`（前缀可空 `maybe T`，内层可带 `@pii`）进入 manifest。
- tier1 必拒样本（aster-lang-ts#328）：`reject-angle-bracket-generic`、`reject-angle-bracket-generic-field`（E056）、
  `reject-param-name-capitalized`、`reject-param-list-of-untyped-text`（E055）、`reject-result-or`（E062）、`reject-maybe-of`（E061）。
- 这些样本的期望依赖 aster-lang-core 1.0.49 与 aster-lang-ts 3.2.0（#213）。包入口 API 无变化。

## 2.2.0

### 新增

- tier1 parity 样本（`X of` 元数与边界，aster-lang-core#256 与 ADR 0056 修订 A1）：`types/of-type-arity`、
  `types/of-type-args-boundary` 及其 de / zh 版本进入 manifest（#208、#209）。
- tier1 必拒样本（ADR 0056 修订 A1）：`reject-rule-header-newline-after-comma`、`reject-rule-header-given-multiline`、
  `reject-rule-header-effect-next-line`（规则头必须写在一行）、`reject-is-enum-comparison`、`reject-not-call-bare-equals`、
  `reject-type-list-ambiguous-comma`、`reject-type-list-ambiguous-comma-generic`（括号类型表里的歧义逗号报 E064）（#209）。
- 这些样本的期望依赖 aster-lang-core 1.0.48 与 aster-lang-ts 3.1.0。包入口 API 无变化。

## 2.1.0

### 新增

- tier1 parity 样本（推断值统一，ADR 0056）：`lambda_capture_io_method`、`lambda_capture_method_call`、
  `lambda_capture_module_rule`、`lambda_capture_nested`（Lambda.captures 只列外层局部；后三份带 eval 用例）、
  `types/inferred-field-constraints`（未标注字段按命名规则与约束推断）、`workflow/workflow-bare-io-capability`
  （工作流能力检查只看显式能力）进入 manifest（#201–#203）。这些样本的期望 IR 依赖 aster-lang-core 1.0.47 与
  aster-lang-ts 3.0.0。包入口 API 无变化。

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
