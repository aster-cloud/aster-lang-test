# Core IR field-level divergence ledger

Tracks every cross-engine Core IR divergence found by
`node scripts/parity-tier1.mjs --mode=ir --full` (ADR 0016).

The comparator normalizes away derived-analysis state (types, effect caps, lambda
captures, PII aggregation) and known field aliases / shape differences before
diffing — see `normalizeIr()` in `scripts/parity-tier1.mjs`.

★`origin` is NO LONGER stripped wholesale (ADR 0037 §2.2.1). It is now compared
at `file` + `line` granularity; `col` is still tolerated because TS emits
placeholder end positions. See `IR_ORIGIN_MODE` for the staged tightening plan.

**Status (2026-06-09, ADR 0016 phases 2–3): zero unresolved structural
divergence.** The non-exempt corpus is **field-identical (202/207)**; the 5
remaining are eval-exempt effect/workflow/interop samples whose derived-analysis
structure is out of scope for structural IR parity (reported as
`divergent-exempt`, not failures). `--mode=ir --full` is now **PR-blocking**.

## 🔴 Open — `origin` line divergence: TS drops comment lines (ADR 0037 §2.2.1)

**Status (2026-09-12): 9/223 samples diverge on `origin.*.line`.** The gate now
COMPARES origin line numbers (it previously stripped `origin` wholesale); these 9
are the real divergences that exemption was hiding.

**Root cause — a genuine TS defect, not a convention difference.** Verified on
`test_claims.aster` (24-line comment header):

| | first declaration |
|---|---|
| source text | line **27** |
| after `Canonicalizer.canonicalize()` | line **27** (line count unchanged, 115 → 115) |
| Java `origin.start.line` | **27** ✅ |
| TS `origin.start.line` | **3** ❌ |

The offset is a constant **+24** across every node in the file — exactly the
number of leading comment lines. TS is numbering lines as if comments had been
removed; Java (and the actual canonical text) numbers them as they appear.
7 of the 9 divergent samples carry comment headers, consistent with this cause.

**Why this matters beyond parity:** ADR 0032 anchors execution traces to source
positions, and ADR 0037 builds OriginMap/MappingIR on them. A span that points
24 lines off the real statement makes "click the trace step, jump to the source
line" land on the wrong line — silently.

**Not fixed here.** This entry records it; the fix belongs in the TS frontend
(ADR 0037 step 3). Until then the gate compares `file` + `line` and tolerates
`col` (see `IR_ORIGIN_MODE` in `scripts/parity-tier1.mjs`).

## Resolved — normalization rules (ADR 0016 §A/§B)

Representation differences that were folded to a canonical form in `normalizeIr`:

| was divergent | rule |
|---|---|
| `Import.name/asName` (TS) vs `path/alias` (Java) | field alias table |
| `declaredEffects:["IO"]` (TS) vs `effects:["io"]` (Java) | alias + lowercase + sort |
| `Func`/`Field` empty `annotations` omitted (TS) vs `[]` (Java) | missing == empty |
| `Import.version` omitted (TS) vs `null` (Java) | missing == null |
| `PatCtor.names:["id"]` (TS) vs `args:[{kind:PatName,name}]` (Java) | canonical `binds:[…]` |
| **0-arg enum-variant pattern** `When InvalidCreds` → `PatName{name}` (TS) vs `PatCtor{typeName,binds:[]}` (Java) | canonical `PatVariant{variant}` |
| **`Ok(x)`/`Err(x)`/`Some(x)`/`None()` call-form** → `Call{Name "Ok", args:[x]}` (TS) vs `{kind:"Ok", expr:x}` (Java) | canonical dedicated-node shape |
| `@entry` annotation: all-empty `params` container (Java) vs omitted (TS) | empty container == no params |

Stripped derived-analysis layer (ADR §B/§C — not source structure, legitimately
per-engine): inferred `type`/`ret`/`typeParams`/`typeInferred`/`constraints`,
`effectCaps`/`effectCapsExplicit`, lambda `captures`, `piiLevel`/`piiCategories`.
(★`origin` spans are no longer stripped — see the open entry above.)

## Out of scope — eval-exempt derived-analysis differences (informational)

These samples are eval-exempt (effect/workflow/interop); the two engines lower
their *derived-analysis* structure differently. Per ADR 0016 this is out of scope
for **structural** IR parity (which compares the executable tree), so they are
reported as `divergent-exempt` and never block. Documented for visibility:

| sample | exempt | divergence |
|---|---|---|
| `login` | effects | qualified IO call: `io.verify(user,pass)` → TS `Call{Name "io.verify", args:[user,pass]}` (namespace-call) vs Java `Call{Name "verify", args:[io,user,pass]}` (method-call, `io` as receiver). Two self-consistent but different lowering strategies for a small-lowercase-namespace call. A deliberate language-design unification (namespace-call vs method-call semantics) — not a parity bug to patch under this ADR. |
| `eff_valid_all_caps` | effects | bare side-effect statements (`File.write(...)`, `Db.insert(...)` with no Let/Return) → TS `Let _ = …` (discard binding) vs Java `Return …`. |
| `fetch_dashboard` | effects | async workflow (`Start … async` / `Wait for …`) lowers to 4 statements (TS) vs 5 (Java). |
| `interop_sum`, `interop_overload` | interop | int-literal payload in `Interop.*` call args: `value:"1"` (TS string) vs `1` (Java number). |

## How to refresh

```
cd aster-lang-test
node scripts/parity-tier1.mjs --mode=ir --full --report-only | tee ir-field-parity-report.md
```
