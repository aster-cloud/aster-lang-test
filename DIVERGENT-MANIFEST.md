# Equivalence Divergent Manifest

Generated against `equivalence-report.json` (baseline 2026-05-21: 184/198 = 92.93%).

⚠️ **Scope**: The current runner (`scripts/equivalence-nightly.mjs`) is a
**parse-equivalence** check only — it compares whether each engine ACCEPTS
the source, not whether they lower to identical IR or produce identical
runtime output. Categories below reflect that scope.

Maps each of the 14 divergent corpus cases to a **root-cause category** so future
fixes can be sequenced and tracked.

## Tier policy (read this before editing the corpus)

| Tier | What it asserts | CI gate |
|---|---|---|
| **tier1-parity** | Curated subset of tier1 where both engines must accept. Source of truth: `corpus/tier1-parity/manifest.json`. | **PR-blocking (parse)** in `aster-lang-test`, `aster-lang-core`, `aster-lang-ts` via `scripts/parity-tier1.mjs --mode=parse`. **Report-only (IR fingerprint)** alongside via `--mode=ir --report-only`. |
| tier1-equivalence | Full set of samples that *should* be bidirectionally accepted; tier1-parity is a subset of this. | Nightly (`equivalence-nightly.mjs`), regression on rate vs. last-recorded baseline. |
| tier2-divergent | Known one-engine-only samples; drives the divergence backlog. | Nightly only; cases catalogued in this file. |
| tier3-fixtures | Single-engine specialty fixtures (golden AST/Core, lossless, lsp, runtime-retry, type-checker). | Each consumer runs its own subset. |

**Why two tier1 levels.** tier1-parity is the explicit, reviewed contract: every
sample on the list is the language's load-bearing core syntax and must never
regress. tier1-equivalence is a broader scope that includes samples we *want*
both engines to accept but where regressions are caught by trend, not by hard
block. Promoting a sample from tier1-equivalence into tier1-parity requires a
PR that updates `corpus/tier1-parity/manifest.json` with a note explaining the
syntax surface it locks in. Demotion follows the inverse rule and is tracked
below.

### Mode escalation policy

Mode | Status | Promotion trigger
---|---|---
`--mode=parse` | **PR-blocking** | Was promoted in the Phase A landing PR.
`--mode=ir` (fingerprint) | **report-only** — initial Phase B cycle | Promote to PR-blocking once two conditions hold: (1) baseline divergence reaches zero or a stable known set; (2) ADR resolves the field-name divergence (e.g. `Import.path` vs `Import.name`) and the runner is upgraded from fingerprint comparison to full normalized JSON parity.
`--mode=eval` (evaluator output) | not implemented | Phase C work; depends on Java Truffle CLI exposing `{source, entry, input}` → `value` over stdin.

The Phase B fingerprint is structural — it compares `moduleName`, `declCount`,
the `kind → count` histogram, and the sorted list of declared symbol names —
not the full lowered Core IR. Field-level alignment is deferred until field-
name parity is settled. The initial run as of the Phase B landing shows
~55/162 tier1 samples where Java fails to lower (NPE in AstBuilder for `eff_caps_*`
files); those are the first targets for the follow-up.

## Summary

| Category | Count | Direction | Status |
|---|---:|---|---|
| **TS-only (Java parser doesn't accept)** | 13 | TS pass, Java fail | Assessed |
| **Java-only (TS parser doesn't accept)** | 1 | TS fail, Java pass | Assessed |
| **Lowering / IR divergence** | — | both parse, lowered IR differs | **Not assessed in this report** |
| **Runtime / output normalization** | — | both lower, evaluator yields different value | **Not assessed in this report** |

Total: **14 divergent / 197 corpus = 7.1%** (matches CSV history baseline).

Lowering and runtime divergences are NOT zero by exclusion — they are simply
out of scope for the parse-equivalence runner. A separate pipeline gate
(comparing lowered Core IR JSON, then evaluator outputs) is required before
this manifest can claim full-pipeline parity. The categories are listed here
so future work can fill them in.

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
