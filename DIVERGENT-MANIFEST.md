# Equivalence Divergent Manifest

Generated against `equivalence-report.json` (baseline 2026-05-21: 184/198 = 92.93%).

Maps each of the 14 divergent corpus cases to a **root-cause category** so future
fixes can be sequenced and tracked. The four categories below correspond to
where the cross-engine divergence happens in the pipeline.

## Summary

| Category | Count | Direction |
|---|---:|---|
| **TS-only (Java parser doesn't accept)** | 13 | TS pass, Java fail |
| **Java-only (TS parser doesn't accept)** | 1 | TS fail, Java pass |
| **Lowering / IR divergence** | 0 | both parse, lowered IR differs |
| **Runtime / output normalization** | 0 | both lower, evaluator yields different value |

Total: **14 divergent / 197 corpus = 7.1%** (matches CSV history baseline).

## Cases

### Category A: TS-only (13)

Java parser rejects valid TS-accepted syntax. Each row should produce a Java
parser issue (with proposed grammar rule) before being either fixed or
demoted to "TS-only by design".

| # | Path | Suspected root cause | Suggested action |
|---|---|---|---|
| 1 | `tier2-divergent/ts-only/comparison_operators.aster` | Java doesn't accept the comparison operator aliases yet (e.g. `greater than or equal`, `not equal to`, `in range`) | Extend ANTLR grammar in `aster-lang-core` (already accepts most aliases — verify `>=` / `<=` / `in range` triplet) |
| 2 | `tier2-divergent/ts-only/cross_compiler_ops.aster` | Same operator-alias family as #1, packaged as cross-engine probes | Same as #1 |
| 3 | `tier2-divergent/ts-only/lambda_cnl_match_bind.aster` | Java parser doesn't accept `Match … When Constructor(field, field), Return …` pattern binding inside lambda | Add `MatchExpr` with `Bind` pattern to Java grammar |
| 4 | `tier2-divergent/ts-only/lambda_cnl_match_bind__programs-patterns.aster` | Same as #3 (programs-patterns variant) | Same as #3 |
| 5 | `tier2-divergent/ts-only/lambda_cnl_match_maybe.aster` | Match arm pattern for `Maybe(value)` / `Nothing()` | Same as #3 |
| 6 | `tier2-divergent/ts-only/lambda_cnl_match_maybe__programs-patterns.aster` | Same as #5 (programs-patterns variant) | Same as #3 |
| 7 | `tier2-divergent/ts-only/lambda_cnl_match_result.aster` | Match arm pattern for `Ok(value)` / `Err(message)` | Same as #3 |
| 8 | `tier2-divergent/ts-only/lambda_cnl_match_result__programs-patterns.aster` | Same as #7 (programs-patterns variant) | Same as #3 |
| 9 | `tier2-divergent/ts-only/lambda_cnl_mixed.aster` | Lambda body containing both `Match` and `If` arms | Likely subsumed once #3 lands |
| 10 | `tier2-divergent/ts-only/loan.aster` | Likely uses lambda / match / let-with-call combination | Re-run after #3 and #13 land; track residual |
| 11 | `tier2-divergent/ts-only/nested_generic_lambda.aster` | Generic type parameter binding inside nested lambda | Java grammar needs nested-generic support; investigate `[T] given x as T` form |
| 12 | `tier2-divergent/ts-only/test_eligibility_with_ifs.aster` | Multi-clause `If … Otherwise If … Otherwise …` chain | Verify Java grammar treats `Otherwise If` as `else if` |
| 13 | `tier2-divergent/ts-only/test_let_with_call.aster` | `Let x be foo(args)` form — `Let` binding to a call expression | Extend `LetBinding` to accept any expression on RHS in Java grammar |

### Category B: Java-only (1)

| # | Path | TS parser error | Java behavior | Suggested action |
|---|---|---|---|---|
| 14 | `tier2-divergent/java-only/neq_test.aster` | `Expected ')' after expression` — TS parser tokenises `not (x equals to y)` strangely | Java parses fine; emits `!=` in IR | Fix TS parser to recognise the `not (X equals to Y)` pattern as `!=` — likely a precedence issue in `unary_op` |

## Recommended Sequencing

1. **First pass (low-risk grammar adds)** — items 1, 12, 13: comparison aliases, `Otherwise If`, `Let` + call. ETA: 1-2 days. Should clear 3-4 cases.
2. **Second pass (Match patterns)** — items 3-9: lands one grammar rule (`MatchExpr` with `Bind`) but unlocks 7 cases. ETA: 2-3 days.
3. **Third pass (nested generic lambda)** — item 11: scope creep risk; defer until 1 + 2 are landed. ETA: 1-2 days.
4. **TS-side fix** — item 14: not(equals to) precedence. ETA: 0.5 day.

If 1+2+4 land, baseline goes to **194/197 = 98.5%**. Item 11 is the only "demote
to TS-only by design" candidate if it proves expensive — that drops 1 from the
denominator and keeps baseline at 100% of expected-equivalent corpus.

## Regression Guard

To prevent silent regression on the 183 passing cases, set up a CI gate:

```bash
# In aster-lang-core CI (today only TS side runs):
./gradlew :aster-lang-core:test --tests '*DualEngineCrossLangTest*'
# Should be wired into the default test target, not `excludeTags("crosslang")`.
```

This file is checked into the repo so the failure manifest itself is reviewable.
Update it whenever a category-A case is fixed (delete the row) or a new case
appears (add row + root-cause line).
