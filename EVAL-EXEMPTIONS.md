# Eval-parity coverage & exemptions

> **Purpose.** Make the eval-parity denominator explicit. The nightly badge/CSV
> reports eval parity as `identical / cases-compared`, but that number only
> covers samples that have a golden `*.cases.json`. This file records (a) which
> samples are **legitimately exempt** from eval-parity and why, and (b) which
> eval-able samples are **not yet covered** (the 95.8% backlog), so neither is
> invisible.
>
> Source of truth is generated, not hand-maintained: run
> `node scripts/tag-eval-exempt.mjs` (dry) to reprint the live breakdown, or
> `--write` to stamp `evalExempt`/`evalExemptReason` into each sample's
> `.meta.json`. The nightly records the coverage trend row into
> `eval-coverage-history.csv` via `scripts/tag-eval-exempt.mjs --history=…`.

## Current state (2026-07-04)

| Metric | Count |
|---|---:|
| Total tier1-equivalence samples | 217 |
| Eval-exempt (no meaningful pure-eval golden) | 74 |
| **Eval-able** (denominator) | **143** |
| Covered by a `*.cases.json` golden | 137 |
| **Coverage** | **137 / 143 = 95.8 %** |
| Eval-able but NOT yet covered (backlog) | 6 |

Eval parity itself has held **255/255 = 1.0000** every night since 2026-06-30
(see `eval-history.csv`), which is why the nightly eval step is now **gating**
(audit #58). Gating applies only to the 137 covered samples; the 6 uncovered
backlog samples have no golden and therefore do not participate in the parity
comparison — they cannot cause the gate to fail, only to under-report coverage.

## Exempt categories (74)

These samples cannot have a deterministic pure-eval golden. The rule that
classifies each lives in `scripts/tag-eval-exempt.mjs` (`exemptReason`).

| Reason | Count | Why exempt |
|---|---:|---|
| `effects` | 57 | Declares effects/capabilities (`It performs`, `requires`, `eff_*`); tests effect inference/enforcement — a compile-time concern, not runtime output. |
| `undefined-call` | 6 | Calls a function never defined in the module; fails in BOTH engines ("Undefined function") — a parser-only fixture with no runtime output to assert. |
| `type-check-fail` | 3 | `bad_*` samples designed to fail type-checking; no runtime output. |
| `unsupported-syntax` | 3 | Uses a construction/dispatch form unsupported in both pure evaluators (positional struct construction `T(…)`, enum static method `T.equals(…)`). |
| `io` | 2 | Calls a side-effecting IO builtin (`Http`/`Db`/`Files`/`Sql`/`Secrets`/`Ai`/`Repo`); runtime needs real effects, not a golden. |
| `interop` | 2 | Calls a host-interop builtin not available in the pure evaluator. |
| `pii` | 1 | Exercises PII propagation/sink flow — a type-system concern, not runtime output. |

These 74 are **deliberately not gated**: they are excluded from the eval-able
denominator, not counted as failures. Do not add goldens for them.

## Eval-able but not yet covered — the 6-sample backlog (137/143)

These ARE eval-able (deterministic output exists) but have no golden yet. They
are the burn-down list to reach 100% coverage; they are report-only by nature
(no golden ⇒ nothing to compare), so they never block the gate.

| Sample | Note |
|---|---|
| `enterprise` | Large enterprise-lending decision program (many `Define`d structs + rules); needs authored golden inputs/outputs. |
| `personal` | Large personal-lending decision program; same as `enterprise`. |
| `g0-omit-produce` | Grammar sample: `Rule … given …:` with the `produce` keyword omitted (implicit return type). Needs golden inputs. |
| `g1-lowercase-keywords` | Grammar sample exercising lowercase keyword spellings (`define`/`rule`/`let`/`if`/`return`). Needs golden inputs. |
| `g1-softkeyword-idents` | Grammar sample using soft keywords (`let`, `match`, `when`) as identifiers. Needs golden inputs. |
| `pii_type_in_data` | Constructs a `User` with a PII-typed field and returns it; eval-able (returns a constant struct) but no golden authored yet. |

To burn one down: author `corpus/tier1-equivalence/inputs/<name>.cases.json`
via `scripts/gen-cases.mjs` (writes a golden only when BOTH engines already
agree with the authored expected value), then re-run
`node scripts/tag-eval-exempt.mjs` to confirm coverage ticked up.
