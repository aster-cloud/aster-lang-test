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

## ✅ Resolved — `origin` line divergence: TS collapsed blank/comment lines (ADR 0037)

**Fixed 2026-09-12** in `aster-lang-ts` (`aster-lang-ts#170`).

The TS canonicalizer cleared whitespace-only lines with `/^\s+$/gm`. Because
`\s` **includes `\n`**, a run of blank lines matched as one block and collapsed
to a single empty string — despite the adjacent comment reading "Do not collapse
newlines globally". Comments are blanked earlier in the same function, so any
run of ≥2 comment/blank lines shifted every following line:

```
'A.\n\n\n\n\nB.\n'  (7 lines)  →  'A.\n\nB.\n'  (4 lines)
```

Measured on `test_claims.aster` (24-line comment header): TS canonicalize took it
from 115 lines to **91**, moving the first declaration from line 27 to line 3.
Java blanks comments but preserves line count (115 → 115), so Java was correct
throughout.

Fix: `/^[^\S\n]+$/gm` — whitespace excluding newlines, so it still clears
whitespace-only lines but is line-count preserving.

**Result: whole-file origin.line offset is gone.** The gate now compares
`origin.file` + `origin.*.line` across the corpus with 0 divergence from this cause.

## 🔴 Open — two residual TS span bugs (exposed by the fix above)

Removing the old carve-out surfaced two much smaller, unrelated TS defects.
Java is correct in both; 5 samples affected.

**(a) `ts=0` on synthesized blocks** — 10 diffs, `g2a-inline-if.aster`.
TS emits `line: 0` for inline-if `thenBlock`/`elseBlock`. Line 0 is not a valid
1-based line at all: TS is emitting a default-initialised span for blocks it
*synthesises* rather than parses.

**(b) `end.line` short by 1–4** — 15 diffs across `hipaa-validation-demo`,
`multiline_continuation`, `patient-record`, `prescription-workflow`.
On multi-line declarations TS closes the span at the last consumed token instead
of the declaration's real end.

Carved out as `divergent-known-ts-span` (see `parity-tier1.mjs`). The carve-out is
narrow by construction — **only** `origin.*.line` diffs qualify, so `origin.file`
stays guarded and any new divergence in any other field still fails the gate
(verified by mutation: injecting a non-origin diff turns it red; `strict` mode,
which also compares `col`, reports 150/223).

⚠️ Delete that branch once (a) and (b) are fixed.

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
