# Core IR field-level divergence ledger

Tracks every unresolved cross-engine Core IR divergence found by
`node scripts/parity-tier1.mjs --mode=ir --full` (ADR 0016 Phase 1).

The comparator normalizes away derived-analysis state (types, effect caps, lambda
captures, PII aggregation, origins) and known field aliases before diffing — see
`normalizeIr()` in `scripts/parity-tier1.mjs`. What remains below are real
source-structure divergences in how the two engines lower the same program.

**Status (2026-06-09): 197 / 207 samples field-identical; 10 divergent, all
triaged below.** None affects runtime output — eval-parity is 236/236 identical —
but the IR *shape* differs, which is what this layer exists to surface.

## Categories

### 🟡 ACCEPTED — representation difference (semantically equivalent)

These are two valid ways to encode the same source construct. Both engines
execute them identically. Documented as accepted; a future normalization rule or
an engineering decision to align one side may close them, but they are not bugs.

| samples | divergence | detail |
|---|---|---|
| `enum_exhaustiveness`, `enum_wildcard`, `match_enum` | **0-arg enum-variant pattern**: `When InvalidCreds` → TS `PatName{name:"InvalidCreds"}` vs Java `PatCtor{typeName:"InvalidCreds", args:[]}` | Both match the enum variant by name (the `PatName` two-meaning rule: a Capitalized name = variant match). TS treats a bare Capitalized arm as a name-pattern; Java treats it as a nullary constructor pattern. Eval-identical. |
| `interop_sum`, `interop_overload` | **Int literal typing**: `args[].value` is `"1"` (string) in TS vs `1` (number) in Java | Integer literal payload representation. Both evaluate to the same number; the JSON type of the literal node differs. |
| `entry_annotation` | **annotation params shape**: Java emits `annotations[0].params: {annotations:[],retAnnotations:[],effects:[]}`, TS omits | `@entry` annotation argument record; Java carries an empty params sub-record, TS leaves it off. |

### 🔴 TO INVESTIGATE — possible lowering bug

These are structural differences that may indicate one engine lowers the source
incorrectly. Each needs a source-level look before deciding accept-vs-fix.

| samples | divergence | detail |
|---|---|---|
| `login` | **qualified IO call lowering**: `expr.target.name` `io.verify` (TS) vs `verify` (Java); arg count 2 (TS) vs 3 (Java) | TS keeps the `io.` namespace prefix on the call target and 2 args; Java strips to `verify` with 3 args. A genuine divergence in how a namespaced/effectful call is lowered — investigate which is correct. |
| `fetch_dashboard` | **statement count**: rule `decls[3]` lowers to 4 statements (TS) vs 5 (Java) | One engine emits an extra statement in this rule body. |
| `eff_valid_all_caps` | **statement kind**: `statements[3]`/`[4]` are `Let "_"` (TS) vs `Return` (Java) | TS lowers a trailing eff-call expression to a `Let _ = …` discard binding; Java lowers it to a `Return`. Different statement structure for the same source lines. |

## How to refresh

```
cd aster-lang-test
node scripts/parity-tier1.mjs --mode=ir --full --report-only | tee ir-field-parity-report.md
```

Per ADR 0016: once every row here is either ACCEPTED (with a normalization rule
or recorded decision) or fixed in the engine, `--mode=ir --full` graduates from
report-only to PR-blocking.
