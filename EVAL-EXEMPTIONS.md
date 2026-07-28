# Eval-parity coverage & exemptions

> **Purpose.** Make the eval-parity denominator explicit. The nightly badge/CSV
> reports eval parity as `identical / cases-compared`, but that number only
> covers samples that have a golden `*.cases.json`. This file records which
> samples are **legitimately exempt** from eval-parity and why, so the
> denominator is never silently shrunk.
>
> Source of truth is generated, not hand-maintained: run
> `node scripts/tag-eval-exempt.mjs` (dry) to reprint the live breakdown, or
> `--write` to stamp `evalExempt`/`evalExemptReason` into each sample's
> `.meta.json`. The nightly records the coverage trend row into
> `eval-coverage-history.csv` via `scripts/tag-eval-exempt.mjs --history=…`.

## Current state (2026-07-28, 复核于 not-precedence 合并后)

| Metric | Count |
|---|---:|
| Total tier1-equivalence samples | 218 |
| Eval-exempt (no meaningful pure-eval golden) | 73 |
| **Eval-able** (denominator) | **145** |
| Covered by a `*.cases.json` golden | 145 |
| **Coverage** | **145 / 145 = 100.0 %** |
| Eval-able but NOT yet covered (backlog) | 0 |

`--mode=eval` 实测 **289/289 identical**（双引擎一致且匹配 golden，0 divergent）。

> **2026-07 审计修复（P4 度量诚实化）。** 审计发现 `tag-eval-exempt.mjs` 的
> `STDLIB_NAMESPACES` 静态白名单漏了 `Date` / `Decimal` 两个已实现命名空间。
> 分类规则是「**有 `.cases.json` 即视为 eval-able，否则才走 `exemptReason`（含白名单）**」，
> 因此影响的**只有 `stdlib_date`**：它当时无 golden → 走 `exemptReason` → `Date.*`
> 命中「非白名单静态方法 → unsupported-syntax」→ 被误标 exempt、剔出 eval-able 分母，
> 让 143/143 假装完整（**伪 100%**：分母里缺了本该在的 `stdlib_date`）。
> `stdlib_decimal` **不受影响**——它自 PR #52 起就有 `compute` golden，按「有 cases 即
> eval-able」规则一直在分母内、一直跑双引擎 eval。
>
> 修复：
> - **(A)** 补 `Date` / `Decimal` 到 `STDLIB_NAMESPACES`（分类器完整性；对 `Date`
>   实质修复其误判，对 `Decimal` 是补齐声明、不改其既有覆盖状态）。
> - **(B)** `parity-tier1.mjs` 的 `collectEvalRequests` 加守卫：非 eval-exempt 样本缺
>   golden 则**报错**（而非静默跳过），防同类盲区再漂移。
> - **(C)** 仅为真缺 golden 的 `stdlib_date` 新增双引擎验证过的 `spanDays` golden；
>   `stdlib_decimal` **保留原有 `compute` golden**（未替换）。
> 结果：143/143（藏了 date）→ **144/144 真 100%**。
>
> **后续（PR #72，`not` 优先级 parity）**：新增 `not-precedence` 样本使分母 144 → **145**，
> 其 golden 覆盖同一 policy 内三条 rule（`notCompare` / `notNot` / `notAnd`），
> eval cases 280 → **289**。该样本也是**首个使用 case 级 `entry` 覆盖**的 golden——
> 此前一个 `.cases.json` 只能测一个 `doc.entry`，同 policy 内其余 rule 只被解析、
> 从不被求值（隐性 eval 盲区，与上文 `stdlib_date` 属同一类「分母悄悄变小」问题）。
> 机制见 `scripts/lib/eval-cases.mjs` 的 `entryForCase`。

## Exempt categories (73)

These samples cannot have a deterministic pure-eval golden. The rule that
classifies each lives in `scripts/tag-eval-exempt.mjs` (`exemptReason`).

| Reason | Count | Why exempt |
|---|---:|---|
| `effects` | 57 | Declares effects/capabilities (`It performs`, `requires`, `eff_*`); tests effect inference/enforcement — a compile-time concern, not runtime output. |
| `undefined-call` | 6 | Calls a function never defined in the module; fails in BOTH engines ("Undefined function") — a parser-only fixture with no runtime output to assert. |
| `type-check-fail` | 3 | `bad_*` samples designed to fail type-checking; no runtime output. |
| `io` | 2 | Calls a side-effecting IO builtin (`Http`/`Db`/`Files`/`Sql`/`Secrets`/`Ai`/`Repo`); runtime needs real effects, not a golden. |
| `interop` | 2 | Calls a host-interop builtin not available in the pure evaluator. |
| `unsupported-syntax` | 2 | Uses a construction/dispatch form unsupported in both pure evaluators (positional struct construction `T(…)`, enum static method `T.equals(…)`). |
| `pii` | 1 | Exercises PII propagation/sink flow — a type-system concern, not runtime output. |

These 73 are **deliberately not gated**: they are excluded from the eval-able
denominator, not counted as failures. Do not add goldens for them.

## Backlog

None — all 144 eval-able samples have a golden and participate in the parity
comparison. When a new eval-able sample is added without a golden, the
`collectEvalRequests` guard in `parity-tier1.mjs` fails loudly (rather than
silently shrinking the denominator), so this section cannot silently regress.

To add a golden: author `corpus/tier1-equivalence/inputs/<name>.cases.json`
via `scripts/gen-cases.mjs` (writes a golden only when BOTH engines already
agree with the authored expected value), then re-run
`node scripts/tag-eval-exempt.mjs` to confirm coverage.
