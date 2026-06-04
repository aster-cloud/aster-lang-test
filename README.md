# aster-lang-test

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> 单一权威的 Aster Lang 测试 corpus。Java ANTLR 与 TS PEG 双引擎共用，未来 aster-idea / aster-vscode 重构时也从这里取测试。

## 为什么

历史上 corpus 散落在 `aster-lang-core/src/test/resources/dual-engine/` 与 `aster-lang-ts/{test,examples}/`，导致双引擎漂移。本仓集中存放所有可被任意 parser 消费的 `.aster` 样本 + 黄金期望，作为：

- 双引擎等价测试的单一权威 corpus
- IDE 集成（aster-idea / aster-vscode）的测试源
- Community lexicon 贡献者验证 lexicon 的标准 corpus

## 目录结构

```
corpus/
├── tier1-parity/              # 严格双引擎契约（PR-blocking）
│   ├── README.md              # 政策说明
│   └── manifest.json          # 显式允许列表 → samples 引用 tier1-equivalence 路径
├── tier1-equivalence/         # 双引擎都能解析且语义等价
│   ├── policies/*.aster
│   └── inputs/*.cases.json    # 黄金期望（input → expectedOutput）
├── tier2-divergent/           # 仅一边能解析
│   ├── java-only/*.aster      # Java ANTLR 能，TS PEG 不能
│   └── ts-only/*.aster        # TS PEG 能，Java ANTLR 不能
└── tier3-fixtures/            # 单端 fixture（parser-error / type-checker golden 等）
    ├── parser-error/
    ├── type-checker/
    └── ...
```

### Tier 与 CI 强度

| Tier | 作用 | 强度 |
|---|---|---|
| **tier1-parity** | 显式、评审过的双引擎契约 — 每个样本两端都必须接受 | **PR-blocking** （`scripts/parity-tier1.mjs --mode=parse`） |
| tier1-equivalence | 两端"应该"等价的全集 | Nightly trend（`equivalence-nightly.mjs`） |
| tier2-divergent | 已知一边拒绝的样本 — 驱动改进 | Nightly only |
| tier3-fixtures | 单端专属 | 各 consumer 自跑 |

详见 `corpus/tier1-parity/README.md` 与 `DIVERGENT-MANIFEST.md` 的 "Tier policy"。

每个 `.aster` 配同名 `.meta.json`：

```json
{
  "tier": 1,
  "engines": ["java", "ts"],
  "lexicon": "en-US",
  "capabilities": [],
  "knownGaps": []
}
```

## 消费方式

### TypeScript / Node

```bash
pnpm add -D @aster-cloud/aster-lang-test
```

```ts
import { listSamples, readSample, readCases } from '@aster-cloud/aster-lang-test';

for (const sample of listSamples({ tier: 1 })) {
  const source = readSample(sample.path);
  const cases = readCases(sample.casesPath);
  // ... feed to your parser
}
```

### Java / Gradle

```kotlin
testImplementation("cloud.aster-lang:aster-lang-test:0.0.1")
```

```java
import cloud.aster.test.CorpusLoader;

for (Sample s : CorpusLoader.listTier("tier1-equivalence")) {
    String source = s.readSource();
    JsonNode cases = s.readCases();
    // ...
}
```

## 等价度

| 维度 | 通过 / 总数 | 比率 |
|---|---|---|
| Tier 1（双引擎等价） | 308 / 308 | 100% |
| TS → Java 全量 | 285 / 360 | 79.2% |
| Java → TS 全量 | 23 / 30 | 76.7% |
| **整体等价度** | **308 / 390** | **79.0%** |

差距细分与排期见 [`aster-deploy/docs/rfc/dual-engine-syntax-baseline.md`](https://github.com/aster-cloud/aster-deploy/blob/main/docs/rfc/dual-engine-syntax-baseline.md) §9。

## 贡献

任何新 sample PR 必须同时通过 Java 与 TS parser（CI 强制）。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

Apache 2.0 — see [LICENSE](LICENSE).
