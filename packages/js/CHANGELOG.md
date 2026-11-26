# Changelog

## 2.9.0

### 新增（Wave D）

- tier1 parity 样本：名字转义 `syntax/escape-{en,de,zh,hi}`（ADR 0064 E1，#257）；关键词当名字 `syntax/keyword-name-builtin-{de,zh,hi}`、
  `syntax/keyword-name-declaration-words`（ADR 0056 修订 A6，#256）；D6 的 `syntax/name-d6-{en,de}`（#259），各带 eval case。
- tier1 必拒样本：`reject-escape-empty`、`reject-escape-fullwidth`、`reject-escape-invalid-char`、`reject-escape-unterminated`
  （名字转义，#257）；`reject-structural-keyword-name-{en,de,hi,zh}`（结构关键词作名字，#256）；`reject-it-performs-newline`、
  `reject-of-newline`（aster-lang-ts#389 的换行诊断，#259）。

### 变更

- `tier1-parity/manifest.json` 只追加条目。无删除，`packages/js/src` 无改动，包入口 API 无变化。这些样本的期望依赖 aster-lang-core 1.0.56
  与 aster-lang-ts 3.8.0。

## 2.8.0

### 新增（Wave C，#252）

- tier1 parity 样本：`syntax/result-is-en`、`syntax/result-is-de`、`syntax/possessive-en`（en-US / de-DE 的 `result-is` 与
  `english-possessive`，aster-lang-core#298，Wave C 裁决 D2）；`syntax/blank-line-before-block-body`、
  `workflow/workflow-blank-line-before-block`（任何块头之后可先空行，裁决 D3）；带词汇的 `vocab-de/alias-rhs-vocabulary`、
  `vocab-zh/alias-rhs-vocabulary`（类型别名右侧写词汇本地类型名，ADR 0051 修订 1，#174 第 5 项），各带 eval case。
- tier1 必拒样本：`reject-indented-top-level-declaration`、`reject-indented-top-level-declaration-after-decl`（裁决 D1）、
  `reject-type-alias-annotation`、`reject-type-alias-annotation-de`（类型别名前的声明级注解 E056）、`reject-result-is-newline`、
  `reject-result-is-newline-de`、`reject-result-is-newline-zh`、`reject-result-is-vertical-tab`（裁决 D2）、`reject-return-newline`、
  `reject-rule-header-newline-no-comma`、`reject-rule-name-newline`（aster-lang-ts#357 第 3 行，裁决 D4）、
  `vocab-e800-alias-rhs-unknown`（E800）。

### 变更

- `syntax/ideographic-space-zh`、`syntax/let-be-ideographic-space-zh` 改用汉字规则名与变量名（#226 m-2：U+3000 与 CJK 标识符同在
  一份源码里），期望不变；`syntax/blank-line-after-block-header` 只改 meta 说明。`tier1-parity/manifest.json` 只追加条目并刷新
  `basedOnEquivalence.history`。无删除。这些样本的期望依赖 aster-lang-core 1.0.55 与 aster-lang-ts 3.7.0。包入口 API 无变化。

## 2.7.0

### 新增

- tier1 parity 样本（ADR 0058 修订 2，aster-lang-ts#346，#241）：本地化类型别名引导词 `types/type-alias-keyword-zh`（`类型`）、
  `types/type-alias-keyword-de`（`Typ`）、`types/type-alias-keyword-hi`（`प्रकार`）。
- 带词汇的 tier1 parity 样本（ADR 0060 修订 1）：字面量触发词与关键词同形时关键词优先——`vocab-en/literal-trigger-keyword`、
  `vocab-zh/literal-trigger-keyword`、`vocab-zh/literal-trigger-english-keyword`（R16'，#239）；字面量宏内容含弯引号、反斜杠与
  ASCII 双引号——`vocab-en/literal-curly-quotes`、`vocab-zh/literal-curly-quotes`（R18，#240）。各带 eval case。
- tier1 parity 样本：`syntax/corner-quote-in-string-zh`（字符串内容含 `」`，aster-lang-ts#362 第 3 项，#237）、
  `syntax/result-is-zh`（`结果为`）与 `syntax/function-syntax-whitespace-zh`（aster-lang-locales#147、aster-lang-ts#357 第 4 行，#236）、
  `syntax/blank-line-after-block-header`（规则体 / If 块头后可空行，ADR 0056 修订 A4，#242）。
- tier1 必拒样本（ADR 0056 修订 A4，aster-lang-ts#338 / #357，#242）：`reject-bare-lowercase-type`、`reject-lowercase-generic-after-comma`、
  `reject-lowercase-map-after-comma`（E055）、`reject-raw-newline-in-string`、`reject-raw-newline-in-string-zh`（E051）、
  `reject-line-break-after-header-comma`（E062）；zh 函数头与 `结果为` 旁的 Unicode 空白（#236）：`reject-whitespace-em-space-after-rule-keyword-zh`、
  `reject-whitespace-nbsp-before-paren-zh`、`reject-whitespace-em-space-after-paren-zh`、`reject-whitespace-nbsp-after-result-is-zh`、
  `reject-whitespace-em-space-after-result-is-zh`。
- 已有样本与向量逐字节不变（只新增；`tier1-parity/manifest.json` 只追加条目并刷新 `basedOnEquivalence.history`）。这些样本的期望依赖
  aster-lang-core / aster-lang-locales / aster-lang-hi 1.0.53 与 aster-lang-ts 3.6.0。包入口 API 无变化。

## 2.6.0

### 新增

- source envelope 共享向量（ADR 0060 §7.1，#231）：`corpus/shared-vectors/envelope-vectors.json` 追加第 4 条向量
  （`vocabulary.id` = `envelope.literal-macro`：《静夜思》原诗源码（zh-CN）、字面量宏 `思故乡 → 静夜思` 与一条 struct，
  aliasSet 为 ADR 0060 §8 的四个汉字单词结构词别名），README 补该行与「只追加、不改写」的同步规则。已有 3 条向量逐字节不变；
  整份文件的 sha256 随之变化，下游副本须逐字节同步并更新各自的哈希钉。该向量的期望依赖 aster-lang-core 1.0.52
  与 aster-lang-ts 3.5.0 的别名校验 v2。包入口 API 无变化（loader 不读取 `shared-vectors/`）。

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
