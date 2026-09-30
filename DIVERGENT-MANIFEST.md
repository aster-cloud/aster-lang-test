# Equivalence Divergent Manifest

> **Authoritative parity (note added 2026-06-16).**
> The source of truth for every live rate is the **latest row of the
> corresponding history CSV** — `equivalence-history.csv` (parse),
> `ir-history.csv` (ir), `eval-history.csv` (eval) — appended by the nightly
> job `.github/workflows/nightly-equivalence.yml`. This file deliberately
> inlines **no** live counts: the sections above "Historical baseline" are
> checked by `scripts/tag-eval-exempt.mjs --check` (PR-blocking) and fail CI if
> a `N/N` count or a four-decimal rate literal is pasted in, because every such
> snapshot drifted within weeks (issues #95, #147, #149). The historical
> **2026-05-21 baseline** is retained only in the "Historical baseline"
> section for provenance — those counts are NOT regenerated on every change.
> Treat the historical counts in this file and in
> `corpus/tier1-parity/manifest.json`'s `basedOnEquivalenceReport` field as
> dated baselines, not current numbers.
>
> **Freshness guard.** `scripts/check-equivalence-freshness.mjs` (npm:
> `check:equivalence-freshness`, wired PR-blocking in `ci.yml`) keeps these
> artifacts honest: it fails CI if `equivalence-report.json` is internally
> inconsistent, if its totals match no real row in `equivalence-history.csv`
> (i.e. were hand-edited), or if `corpus/tier1-parity/manifest.json`'s cited
> baseline disagrees with the report. The nightly job runs it with
> `--require-fresh` after regenerating the report.

## Current state

**Live divergent count: see the `divergent` column of the latest
`equivalence-history.csv` row** (`tail -1 equivalence-history.csv`), and
`tier2-divergent/` is empty — every case listed in the historical baseline
below has since been fixed or reconciled. There is no open per-case divergence
backlog. The stale 14-case tables that used to live here (2026-05-21 baseline)
have been retired; they are preserved only as counts in the "Historical
baseline" section for provenance.

All three modes are gated in both PR CI and the nightly (audit #58 promoted
the nightly; the PR eval gate was promoted on 2026-07-15, see `ci.yml`):

| Mode | Live rate (single source of truth) | Gate |
|---|---|---|
| parse (`equivalence-nightly.mjs`) | latest row of `equivalence-history.csv` | **PR-blocking + nightly-gating** |
| ir (`parity-tier1.mjs --mode=ir --full`) | latest row of `ir-history.csv` | **PR-blocking + nightly-gating** |
| eval (`parity-tier1.mjs --mode=eval`) | latest row of `eval-history.csv` | **PR-blocking + nightly-gating** |

Eval-parity coverage and the exemption denominator are tracked in
**`EVAL-EXEMPTIONS.md`**, whose table is kept identical to the live output of
`node scripts/tag-eval-exempt.mjs` by the same `--check` gate. If a new
divergence ever appears, re-add a per-case row here and file the
corresponding engine issue.

⚠️ **Scope**: The parse runner (`scripts/equivalence-nightly.mjs`) is a
**parse-equivalence** check only — it compares whether each engine ACCEPTS
the source. IR/eval parity (lowering + runtime output) are covered by the two
gating `parity-tier1.mjs` modes above.

## Tier policy (read this before editing the corpus)

| Tier | What it asserts | CI gate |
|---|---|---|
| **tier1-parity** | Curated subset of tier1 where both engines must accept. Source of truth: `corpus/tier1-parity/manifest.json`. | **PR-blocking (parse)** in `aster-lang-test`, `aster-lang-core`, `aster-lang-ts` via `scripts/parity-tier1.mjs --mode=parse`. **PR-blocking (IR field-level)** alongside via `--mode=ir --full`. **PR-blocking (eval)** via `--mode=eval`, nightly-gating as well (audit #58). |
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

Mode | Status | History
---|---|---
`--mode=parse` | **PR-blocking + nightly-gating** | Promoted in the Phase A landing PR.
`--mode=ir --full` (field-level) | **PR-blocking + nightly-gating** | Promoted to PR-blocking after the normalizing comparator landed (both conditions met: baseline divergence reached zero; field-level normalized JSON parity replaced fingerprint comparison). Nightly promoted from report-only to gating in audit #58 after a full rate held for 4+ consecutive nights.
`--mode=eval` (evaluator output) | **PR-blocking + nightly-gating** | The Truffle multi-argument NPE and the eval divergences catalogued below are all resolved. Nightly promoted from report-only to gating in audit #58 after a full rate held for 4+ consecutive nights. PR CI was promoted from report-only (`continue-on-error` + `--report-only`) to blocking on 2026-07-15 once the multi-argument NPE blocker was fixed upstream (see the step comment in `.github/workflows/ci.yml`); do **not** re-add `continue-on-error` to that step. Phase C compares each side's evaluator output against the other engine's output AND the golden `expectedOutput`.

The Phase C eval scope is the subset of tier1-parity samples that have a
sibling `corpus/tier1-equivalence/inputs/<name>.cases.json`; the eval-able
denominator and its exemptions are defined in `EVAL-EXEMPTIONS.md`.

## Cases

**None open.** `tier2-divergent/` is empty and the live parse-equivalence rate
is the `rate` column of the latest `equivalence-history.csv` row. When a
divergence reappears, catalogue it here with a root-cause category and a
corresponding engine issue, mirroring the historical format retired below.

## Regression Guard

Regression is now caught automatically, not by manual review of this file:

- **parse** — `scripts/parity-tier1.mjs --mode=parse`, PR-blocking in
  `aster-lang-test`, `aster-lang-core`, `aster-lang-ts`, and nightly-gating.
- **ir (field-level)** — `scripts/parity-tier1.mjs --mode=ir --full`,
  PR-blocking and nightly-gating.
- **eval** — `scripts/parity-tier1.mjs --mode=eval`, PR-blocking and
  nightly-gating. Coverage/exemptions in `EVAL-EXEMPTIONS.md`.
- **doc rot** — `scripts/tag-eval-exempt.mjs --check`, PR-blocking and
  nightly-gating: the `EVAL-EXEMPTIONS.md` table must match the live
  classification, and neither this file (above "Historical baseline") nor the
  README rate table may inline a `N/N` count or rate literal.

A rate drop on any mode now fails the nightly job, which blocks the
`if: success()` "Append history to main" step so a regressed CSV/report can't be
committed to `main` and poison the baseline. The freshness guard
(`scripts/check-equivalence-freshness.mjs`) keeps the committed report honest.

## Historical baseline (2026-05-21, retired)

Preserved for provenance only — these are NOT current numbers (current
divergent = 0). At the 2026-05-21 baseline the parse-equivalence runner
reported **14 divergent / 197 corpus = 7.1%**: 13 TS-only cases (Java parser
rejected valid TS-accepted syntax — comparison-operator aliases, `Match`
pattern binding inside lambdas, `Otherwise If` chains, `Let x be <call>`,
nested generic lambdas) and 1 Java-only case (`neq_test.aster`, TS
mis-tokenised `not (x equals to y)`). All 14 were subsequently fixed across the
Phase A/B/C landings and the follow-up grammar work; the per-case tables and
sequencing plan that tracked them were removed on 2026-07-04 (audit #58) once
the backlog reached zero. The detailed resolution notes for the runtime/eval
layer are retained in the sections below.

### Phase B / Phase C landing-time notes (retired)

The original Phase B fingerprint was structural — it compared `moduleName`,
`declCount`, the `kind → count` histogram, and the sorted list of declared
symbol names — not the full lowered Core IR; it has since been replaced by the
field-level normalized comparator (`--mode=ir --full`). The initial run at the
Phase B landing showed ~55/162 tier1 samples where Java failed to lower (NPE in
AstBuilder for `eff_caps_*` files).

At the Phase C landing the eval scope was 15 samples / ~45 cases with an
initial baseline of 3 identical / 42 Java-side `NullPointerException`
("arg2Value is null") in multi-argument `Value.execute(args)` calls — a Truffle
codegen regression that was fixed upstream in
`aster-lang-truffle/src/main/java/aster/truffle/nodes/` before Phase C was
promoted to PR-blocking on 2026-07-15.

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
