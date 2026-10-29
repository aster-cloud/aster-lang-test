# shared-vectors — 跨仓共享测试向量

## envelope-vectors.json（ADR 0051 §7）

source envelope 的共享向量。aster-api（Java `PolicyVersion.computeSourceEnvelope`）与 aster-cloud
（TS `computeSourceEnvelope`）必须对每条向量算出相同的 `expectedSha256`。

形状：`[{ content, aliasSetJson, locale, toolchainId, vocabulary, scopesJson, expectedSha256 }]`。五个哈希输入都是字符串；
`vocabulary` 是生成 scopesJson 的源词汇（DomainVocabulary JSON，无词汇为 `null`），供各端同时核对自己的
`canonicalScopesJson` 实现：`canonicalScopesJson(buildVocabularyScopes(vocabulary)) === scopesJson`。

| # | 场景 | aliasSetJson | scopesJson |
|---|---|---|---|
| 0 | 无词汇 | `""` | `""`（第 5 段帧为 `0:\|`） |
| 1 | 单 struct 词汇（Fahrer → Driver） | `{"FUNC_TO":["Richtlinie"]}` | 单 struct 的 `canonicalScopesJson` |
| 2 | 同义词 + NFC 组合字符（词汇写 `Cafe` + U+0301、同义词 `Bistro` + U+0301；源码同样含 U+0301） | `""` | 含 term / synonym 两种 source 的 `canonicalScopesJson` |

### 哈希规则

逐段写入同一个 SHA-256，段顺序固定为 `content, aliasSetJson, locale, toolchainId, scopesJson`。每段写

```
<该段 UTF-8 字节数的十进制 ASCII> ":" <该段 UTF-8 字节> "|"
```

`expectedSha256` 为摘要的小写十六进制。字节数按 UTF-8 计（不是字符数），例如 `Cafe` + U+0301 是 6 字节。
内容按原样写入，不做 NFC：NFC 只作用于词汇的 written（已体现在 scopesJson 里）。
null 输入在调用方先转成 `""`，与现有 4 段实现一致；本 ADR 只在末尾追加第 5 段，前 4 段的分帧与顺序不变。

参考实现（node）：

```js
const h = createHash('sha256');
for (const f of [content, aliasSetJson, locale, toolchainId, scopesJson]) {
  const b = Buffer.from(f, 'utf8');
  h.update(`${b.length}:`, 'ascii'); h.update(b); h.update('|', 'ascii');
}
h.digest('hex');
```

### scopesJson 的来源

- 无词汇时为 `""`，不调用 `canonicalScopesJson()`，也不序列化空 scopes 与 `schemaVersion`。
- 有词汇时为 aster-lang-ts `canonicalScopesJson(buildVocabularyScopes(vocabulary))`。生成本文件时（2026-10-29，
  aster-lang-ts ec0111d、aster-lang-core 6062188）Java `VocabularyScopes.build(vocabulary).canonicalJson()`
  的输出由 aster-lang-core `EnvelopeVectorsTest` 持续核对。

### toolchainId

使用 ADR 0051 §9 的格式 `abi=1.1;core=<engine>;validator=<v>;resolver=1;casefold=15.1;build=<b>`，
`build=vectors` 是固定占位，向量 2 用 `core=java`，用来确认 toolchainId 只当作不透明字符串参与哈希。

### 校验

- `node scripts/test-envelope-vectors.mjs`：按上述规则独立重算每条 `expectedSha256`，检查覆盖场景，
  并用兄弟仓 aster-lang-ts 的构建产物核对 scopesJson（需先 `pnpm build`）。
- aster-lang-core `EnvelopeVectorsTest`：同一份文件的副本（`src/test/resources/shared-vectors/`，sha256 钉住），
  断言 Java `VocabularyScopes.build(vocabulary).canonicalJson()` 与 scopesJson 一致、envelope 哈希与 expectedSha256 一致。
