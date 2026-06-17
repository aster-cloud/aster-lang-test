# Equivalence Divergent Manifest

> **Authoritative parity (note added 2026-06-16).** The current source of truth
> for the live parse-equivalence rate is the **latest row of
> `equivalence-history.csv`** (2026-06-16: **208 total / 208 equivalent / 0
> divergent = 1.0000**). The static `equivalence-report.json` snapshot
> (197 total / 183 equivalent / 14 divergent) and the per-case tables below
> reflect the **2026-05-21 baseline** and are NOT regenerated on every change —
> `equivalence-report.json` (and the appended CSV trend row) are produced by the
> nightly job `.github/workflows/nightly-equivalence.yml`
> (`scripts/equivalence-nightly.mjs`). Treat the historical counts in this file
> and in `corpus/tier1-parity/manifest.json`'s `basedOnEquivalenceReport`
> field as dated baselines, not current numbers.
>
> **Freshness guard.** `scripts/check-equivalence-freshness.mjs` (npm:
> `check:equivalence-freshness`, wired PR-blocking in `ci.yml`) keeps these
> artifacts honest: it fails CI if `equivalence-report.json` is internally
> inconsistent, if its totals match no real row in `equivalence-history.csv`
> (i.e. were hand-edited), or if `corpus/tier1-parity/manifest.json`'s cited
> baseline disagrees with the report. The nightly job runs it with
> `--require-fresh` after regenerating the report.

Generated against `equivalence-report.json` (dated baseline, history row
2026-05-13: 183/197 = 92.93%).

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
`--mode=eval` (evaluator output) | **report-only** — initial Phase C cycle | Promote to PR-blocking once the Truffle-side multi-argument NPE is fixed (see below). Phase C compares each side's evaluator output against the other engine's output AND the golden `expectedOutput`.

The Phase B fingerprint is structural — it compares `moduleName`, `declCount`,
the `kind → count` histogram, and the sorted list of declared symbol names —
not the full lowered Core IR. Field-level alignment is deferred until field-
name parity is settled. The initial run as of the Phase B landing shows
~55/162 tier1 samples where Java fails to lower (NPE in AstBuilder for `eff_caps_*`
files); those are the first targets for the follow-up.

The Phase C eval scope is the subset of tier1-parity samples that have a
sibling `corpus/tier1-equivalence/inputs/<name>.cases.json` (15 samples /
~45 cases as of the Phase C landing). Initial baseline:
3 identical / 42 Java-side `NullPointerException` ("arg2Value is null") in
multi-argument `Value.execute(args)` calls. The TS evaluator runs every
case to completion. The Java-side NPE is a Truffle codegen regression
that has to be fixed in `aster-lang-truffle/src/main/java/aster/truffle/nodes/`
before Phase C can be promoted to PR-blocking.

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

## Runtime (eval) divergences revealed after Phase B/C fixes (2026-06-05)

The IR + eval parity gates are now clean of the two large fix families:
- **Phase B** (Core IR lowering): eff_caps `It performs` lexicon-casing fix
  (aster-lang-core 69e40c7) — IR java-fail 55 → 0.
- **Phase C** (evaluator): operator-spelled builtin resolution
  (aster-lang-truffle 6952b77) — eval java-fail 42 → 3.

Peeling those layers revealed several **smaller, pre-existing runtime semantic
divergences** (eval mode, Java vs TS). All are now **RESOLVED**: as of the
2026-06-09 work the eval-parity gate is **60/60 identical, 0 divergent**
(was 44/52 mid-fix), and parse-parity is **206/206**.

### ✅ RESOLVED

| sample / case | decision | fix |
|---|---|---|
| `08-arithmetic-divide` `7 / 2` | **`/` is float division** (canonical = TS). Both engines IEEE-754 double; `7/2 → 3.5`, `1/3 → 0.3333333333333333` byte-identical. Integer-valued results (`20/4 → 5`) collapse via `CoreIrEvalCli.valueToJson` `fitsInInt`, so no `5.0`-vs-`5` mismatch. | aster-lang-truffle: `Builtins.div` returns `toDouble(a)/toDouble(b)`; removed the `doDivInt` int fast-path in `BuiltinCallNode` (div always flows through generic → double). Golden `08-arithmetic-divide.cases.json` updated `7/2 → 3.5`. |
| `06-string-concat` (×2), `19-let-multiple` (×2), `28-business-insurance-premium` (×3) | **int/double numeric promotion** | Once `/` produced doubles, the int-specialized `BuiltinCallNode` fast-paths returned only one operand for int+double (`100 - 10.0 → 10`) and string-concat dropped its 2nd operand. Removed the arithmetic int fast-paths; `add/sub/mul/div/mod` route through `doGeneric → Builtins.*` with int/double promotion; comparisons compare numerically as double (`0.0 == 0`). All 8 cases became identical. |
| `09-arithmetic-modulo` (`is_even`) | **restored with the real `modulo` operator** | The `n - (n/2)*2` even-check idiom relied on integer division and broke under float `/`. The language now has a real `modulo` operator, so `09` was rewritten to `n modulo 2 equals to 0` — a genuine even-check, golden back to `4→true, 7→false`. (Module renamed `…arithmetic.modulo` → `…arithmetic.evencheck` because a bare `.modulo` trailing segment now tokenizes as the `modulo` keyword.) |

### New operator coverage (2026-06-09)

`modulo` and `integer divided by` operators added (7-repo change). New parity
samples lock the truncate-toward-zero contract with negative cases:
- `31-arithmetic-intdiv`: `7 // 2 = 3`, `-7 // 2 = -3`, `7 // -2 = -3`
- `32-arithmetic-modulo-op`: `7 % 2 = 1`, `-7 % 2 = -1`, `7 % -2 = 1`

Both in `tier1-parity/manifest.json`. The manifest is clean; no open divergences.

## Eval-coverage backfill — newly surfaced divergences (2026-06-09)

The `.cases.json` backfill effort (`scripts/gen-cases.mjs`, which only writes a
golden when BOTH engines agree with the authored expected value) doubled eval
coverage (52 → 123 cases) and, by design, surfaced **4 real dual-engine eval
divergences** that were previously untested. These are NOT written as goldens
(the generator skips them); they are open bugs to fix:

| sample / case | TS | Java | category |
|---|---|---|---|
| `int_match_default` `99` (default arm) | `Undefined function 'Text.concat'` | `"other:case"` | **TS missing builtin**: `Text.concat` not registered in the TS interpreter; Java has it. |
| `match_null` `null` | `"none"` ✓ | `"some"` | **Java null-match bug**: a `When null` arm is not matched on the Java side for a null scrutinee. |
| `match_enum` `Invalid` | `"missing"` | `"invalid"` ✓ | **TS enum-match bug**: the second enum arm (`When Invalid`) is not reached — TS returns the first arm's value. |
| `enum_wildcard` `Locked` | `"bad"` | `NullPointerException (arg2Value null)` | **enum wildcard broken both sides**: TS returns the first arm; Java NPEs on the `When x` catch-all over an enum. |

### ✅ RESOLVED (3 of 4)

| sample | fix |
|---|---|
| `int_match_default` | aster-lang-ts: added the `Text.*` stdlib namespace to the interpreter (`evalStdlibCall`), mirroring aster-lang-truffle `Builtins` — covers Text.concat/toUpper/length/startsWith/contains/indexOf/equals/split/trim. |
| `match_enum` / `enum_wildcard` | **PatName two-meaning fix in BOTH engines**: a Capitalized name (enum variant / type, e.g. `NotFound`) matches by name-equality and does NOT bind; a lowercase name (`x`/`value`) is a catch-all binding over non-null. Previously the first `PatName` arm swallowed every input (TS) and a lowercase catch-all over an enum-string NPE'd / didn't match (Java). aster-lang-ts `interpreter.ts matchPattern`; aster-lang-truffle `MatchNode.PatNameNode`. |

Now dual-engine identical (verified via `gen-cases.mjs`); cases written.

### ⏳ STILL OPEN (1)

| sample / case | TS | Java | note |
|---|---|---|---|
| `match_null` `null` | `"none"` ✓ | `"some"` | **Java host-null marshaling**: a JSON `null` input passed through `CoreIrEvalCli` `Value.execute(args)` does not reach the `When null` (PatNull) arm as guest null, so the lowercase catch-all matches instead. `PatNullNode` itself is correct (`s == null`); the gap is in how Polyglot marshals a host `null` arg into the guest. Likely a CLI-harness artifact (real Aster code produces null via `None`/match, not host injection), not a core interpreter bug — needs Polyglot host-access investigation. `match_null(non-null)` is fine. |

### ⏳ More divergences surfaced by the cases backfill (batches 4–6, 2026-06-09)

eval coverage 47 → 72 of 141 eval-able samples (51%). The generator surfaced
these (cases NOT written; tracked here):

| sample / case | TS | Java | category |
|---|---|---|---|
| `greet` `User(id,name)` | `"Welcome, {name}"` (literal — no interpolation) | NPE on the struct match | **TS string interpolation**: `"…{name}"` in a Return is not substituted; **Java** NPEs matching a `User(...)` ctor pattern over a `{__type:"User",…}` map input. Both broken. |
| `incremental` `check` (returns a struct) | `{"__type":"Decision","approved":true,"reason":"OK"}` ✓ | `{"__type":"?","__display":"Decision{…}"}` | **struct serialization parity**: `CoreIrEvalCli.valueToJson` lossy-fallbacks host `AsterDataValue` to a `__display` string instead of a structured object — construct-returning samples can't be golden'd until the CLI serializes data values structurally. |
| `list_ops` `List.length` | `Undefined function 'List.length'` | `List.length: expected List, got HostObject` | **List/Map stdlib**: TS interpreter lacks the `List.*`/`Map.*` namespace (only `Text.*` added so far); Java's List builtins don't accept a Polyglot HostObject array. Both need work for collection samples. |

### ✅ RESOLVED — collections + higher-order (2026-06-09)

| sample(s) | fix |
|---|---|
| `list_ops`, `map_ops` (List.length/get/isEmpty, Map.get) | aster-lang-ts: added the non-lambda `List.*`/`Map.*` stdlib to `evalStdlibCall`. aster-lang-truffle: `Builtins.asList`/`asMap` accept guest `AsterListValue`/`AsterMapValue`; `Map.get` qualified-call no longer dropped (aster-lang-core `AstBuilder` treats `MapIdentExpr` as a type qualifier); CLI injects collection inputs as guest interop values + selects the requested entry function. |
| `stdlib_collections` (List.map), `stdlib_maybe_result` (Maybe.map/Result.mapOk/tapError), `lambda_cnl_mixed`, `lambda_cnl_match_bind`/`_maybe`/`_result`, `nested_generic_lambda` | aster-lang-ts: full **lambda/closure support** (lexical capture + higher-order `List.map/filter/reduce`, `Maybe.map`, `Result.mapOk/mapErr/tapError`) + **positional `PatCtor` binding** (`Ok(value)`/`Err(err)`/`Some(x)`). aster-lang-truffle: `LambdaRootNode` now adapts its return so entry-as-callable returns of List/Map/Some/Ok cross the host boundary (was `ClassCastException` in `ToHostValueNode`); `AsterMapValue implements Map` so the matcher + every Maybe/Result builtin accept it unchanged. All verified dual-engine identical via `gen-cases.mjs`. |

### ✅ RESOLVED — host-null match + Type alias (2026-06-09)

| sample / feature | fix |
|---|---|
| `match_null` `classify(null)`, `lambda_cnl_match_maybe` `fromMaybe(null, "fb")` | **host-null into a `When null` match**: a host `null` passed via `Value.execute(args)` arrives in the guest as a `HostObject` with `interopIsNull()==true` — **not** a Java `null` — so `PatNullNode`'s `s == null` failed and the lowercase catch-all matched instead. Fix (aster-lang-truffle `MatchNode`): add `isGuestNull(s)` = Java null OR `InteropLibrary.getUncached().isNull(s)`; `PatNullNode` matches it, the `PatName` catch-all rejects it. Both null cases now covered + dual-engine identical. |
| **Type alias** (`type Score as Int.`) | Was thought TS-only-broken; root cause was a **casing mistake in the sample** (`Type` vs `type`). The Java lexer token is `TYPE: 'type'` (lowercase), so `Type` lexed as a TYPE_IDENT and mis-parsed as a `Data` decl. With the canonical lowercase `type`, both engines agree: aster-lang-ts now parses `type X as T.` (added `KW.TYPE` + a decl-parser branch that consumes it and registers the alias name but emits **no** Core IR decl — matching aster-lang-core's `CoreLowering` which drops `TypeAlias`). Sample `type_alias.aster` added to the parse manifest + golden cases; IR field-identical; `feature-coverage` now reports Type alias as ✅ eval. |
