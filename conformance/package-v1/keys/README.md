# 测试密钥：仅测试，绝不用于发布

本目录的 Ed25519 密钥**只用于包格式 v1 的一致性夹具**。它是公开的：种子是固定标签的 SHA-256，

```
seed = SHA-256(UTF-8("aster-policy-package/v1 TEST-ONLY signing key test-2026-11 (public, never use for releases)"))
```

任何人都能重算出私钥，所以用它签的东西**不证明任何来源**。

- 绝不放进任何 CLI 的内置信任锚（`export-jwks.json` 在 P1 为 `{"keys":[]}`）。
- 绝不用于签发真实导出包；真实导出密钥在 ADR 0059 P2 创建，与本密钥无关。
- 夹具通过 `--jwks ../keys/test-jwks.json` 或 `--pubkey ../keys/test-ed25519.pub.b64u` 显式把它当作锚。

| 文件 | 内容 |
|---|---|
| `test-ed25519.priv.b64u` | 32 字节种子，base64url 无填充，末尾一个 `\n` |
| `test-ed25519.pub.b64u` | 32 字节原始公钥，base64url 无填充，末尾一个 `\n`（`--pubkey` 的原始公钥形态） |
| `test-jwks.json` | JWKS（RFC 8037），唯一一把 `kid: "test-2026-11"` |

三个文件都由 `scripts/build-package-fixtures.mjs` 生成，`--check` 守住它们与种子一致。不在锚中的 kid 夹具使用 `test-2026-11-untrusted`（同一密钥、不同 kid）。
