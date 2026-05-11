# Contributing to aster-lang-test

## 加新 sample 的流程

### 1. 决定它属于哪一层

| 你的样本 | tier |
|---|---|
| 双引擎都能解析且**语义等价** | `tier1-equivalence/` — 必须附 `.cases.json` 黄金期望 |
| 仅 Java ANTLR 能解析 | `tier2-divergent/java-only/` — 标 `knownGap` 说明 TS 缺什么 |
| 仅 TS PEG 能解析 | `tier2-divergent/ts-only/` — 同上 |
| 解析必须出错（parser-error fixture）| `tier3-fixtures/parser-error/` |
| 类型检查 golden | `tier3-fixtures/type-checker/` |
| 其他单端 fixture | `tier3-fixtures/<purpose>/` |

### 2. 文件命名

- 用 `kebab-case`，前缀两位数字便于排序（如 `42-some-policy.aster`）
- `.cases.json` 与 `.aster` 同名（`42-some-policy.aster` → `42-some-policy.cases.json`）
- `.meta.json` 必填，与 `.aster` 同名

### 3. `.meta.json` 字段

```json
{
  "tier": 1,                          // 1 / 2 / 3
  "engines": ["java", "ts"],          // 哪些引擎能解析
  "lexicon": "en-US",                 // 用哪个 lexicon（en-US / zh-CN / de-DE / ...）
  "capabilities": ["workflow", "io"], // 用到的语言特性
  "knownGaps": [],                    // tier 2 时必填；解释另一引擎为何失败
  "tags": ["business", "finance"]     // 可选；分类标签
}
```

### 4. `.cases.json`（tier 1 必填）

```json
{
  "policy": "tier1-equivalence/policies/42-some-policy.aster",
  "entry": "evaluate",
  "cases": [
    { "name": "happy path", "input": [10, 20], "expectedOutput": 30 },
    { "name": "edge: negatives", "input": [-1, 1], "expectedOutput": 0 }
  ]
}
```

### 5. 本地验证

```bash
# 跑双向 inventory，确认你的新 sample 与你声明的 tier 一致
node scripts/inventory.mjs --parser=java
node scripts/inventory.mjs --parser=ts

# 跑 cases 黄金验证（tier 1）
node scripts/run-cases.mjs --parser=ts
./gradlew -Pengine=java :cases:test
```

如果某个 PR 让 tier 1 通过率下降，CI 会 block。

## 禁止事项

- ❌ 不要把 pretty-printer round-trip 样本放进来（那是 aster-lang-ts/test/lossless/ 的领地）
- ❌ 不要新增 `tier2-divergent` 的样本而不在 RFC §9 backlog 里挂一条修复条目
- ❌ 不要在 sample 里硬编码绝对路径或 host-specific 路径
