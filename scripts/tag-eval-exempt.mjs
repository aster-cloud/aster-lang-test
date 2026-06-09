#!/usr/bin/env node
/**
 * Tag samples that cannot have a meaningful pure-eval golden with an
 * `evalExempt` flag (+ reason) in their .meta.json, and report eval coverage
 * as `cases / (total - exempt)`.
 *
 * A sample is eval-exempt when it:
 *   - calls a side-effecting builtin (Http/Db/Files/Sql/Secrets/Ai/Interop) —
 *     its runtime needs real IO, not a deterministic golden;
 *   - declares effects / capabilities (`It performs`, `eff_*`) — the sample
 *     exists to test effect inference/enforcement, a compile-time concern;
 *   - is PII-typed (the sample tests PII propagation/typing, not eval output);
 *   - is a `bad_*` sample designed to fail type-checking.
 *
 * Usage:
 *   node scripts/tag-eval-exempt.mjs            # report coverage only (dry)
 *   node scripts/tag-eval-exempt.mjs --write    # write evalExempt into meta.json
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const POLICIES = join(ROOT, 'corpus', 'tier1-equivalence', 'policies');
const INPUTS = join(ROOT, 'corpus', 'tier1-equivalence', 'inputs');
const WRITE = process.argv.includes('--write');
// --history=<file>: append a trend row `timestamp,total,value,rate` (value =
// covered, total = eval-able) so the dashboard can chart eval coverage over time.
const HISTORY_FILE = (() => {
  const a = process.argv.find((x) => x.startsWith('--history='));
  return a ? resolve(a.slice('--history='.length)) : null;
})();

/** Decide exemption + reason for a sample, or null if it is eval-able. */
function exemptReason(name, src) {
  if (name.startsWith('bad_')) {
    return { reason: 'type-check-fail', detail: 'designed to fail type-checking; no runtime output to assert' };
  }
  if (name.startsWith('eff_') || /\bIt performs\b|\brequires\b/.test(src)) {
    return { reason: 'effects', detail: 'tests effect inference/enforcement (a compile-time concern), not runtime output' };
  }
  if (/\b(Http|Db|Files|Sql|Secrets|Ai|IO|Repo)\.\w+\(/.test(src)) {
    return { reason: 'io', detail: 'calls a side-effecting IO builtin; runtime needs real effects, not a deterministic golden' };
  }
  if (/\bInterop\.\w+\(/.test(src)) {
    return { reason: 'interop', detail: 'calls a host-interop builtin not available in the pure evaluator' };
  }
  // PII: only exempt samples that actually exercise PII *flow* (propagation,
  // http/network sinks, nested calls). `pii_type_*` that merely return a
  // constant are eval-able and counted toward coverage.
  if (/^pii_(propagation|http|nested|function_return)/.test(name)) {
    return { reason: 'pii', detail: 'tests PII propagation/sink flow (a type-system concern), not runtime output' };
  }
  // Parser-only fixtures that call a function never defined in the module (and
  // not a stdlib namespace call): they fail in BOTH engines with "Undefined
  // function", so there is no runtime output to assert. Detect statically — a
  // call to a bare lowercase identifier that is neither `Rule <name>` nor a
  // `Let <name> be function …` binding anywhere in the source.
  if (callsUndefinedFunction(src)) {
    return { reason: 'undefined-call', detail: 'calls a function never defined in the module; fails in both engines (parser-only fixture)' };
  }
  // Two construction/dispatch forms that are unsupported in BOTH pure evaluators
  // (each fails at runtime in TS and Java alike, verified via gen-cases):
  //   • positional struct construction `TypeName(a, b, …)` — only the
  //     `TypeName with f set to …` form is implemented;
  //   • enum static methods `EnumType.equals(a, b)` — not a stdlib namespace.
  const unsup = usesUnsupportedConstruction(src);
  if (unsup) {
    return { reason: 'unsupported-syntax', detail: unsup };
  }
  return null;
}

const STDLIB_NAMESPACES = new Set(['Text', 'List', 'Map', 'Maybe', 'Option', 'Result']);

/** Returns a reason string if the source uses a construction/dispatch form that
 *  fails in both pure evaluators, else null. */
function usesUnsupportedConstruction(src) {
  // Collect Define'd type names, then look for a positional call to one.
  const definedTypes = new Set();
  for (const m of src.matchAll(/\bDefine\s+([A-Z]\w*)\b/g)) definedTypes.add(m[1]);
  for (const m of src.matchAll(/(?<![A-Za-z0-9_.])([A-Z]\w*)\s*\(/g)) {
    if (definedTypes.has(m[1])) return `positional struct construction \`${m[1]}(…)\` (only the \`with … set to\` form is supported in both engines)`;
  }
  // Qualified static call on a non-stdlib type, e.g. `Action.equals(...)`.
  for (const m of src.matchAll(/\b([A-Z]\w*)\.([a-z]\w*)\s*\(/g)) {
    if (!STDLIB_NAMESPACES.has(m[1])) return `enum/type static method \`${m[1]}.${m[2]}(…)\` unsupported in both engines`;
  }
  return null;
}

// 语言关键字/运算符词形：它们后面跟 `(` 不是函数调用（如 `not (...)`、`Let x be (...)`）。
const RESERVED_WORDS = new Set([
  'be', 'not', 'and', 'or', 'of', 'if', 'set', 'to', 'is', 'as', 'given', 'produce',
  'return', 'let', 'match', 'when', 'otherwise', 'some', 'none', 'with', 'has',
  'greater', 'less', 'than', 'least', 'most', 'equal', 'equals', 'at', 'the', 'a', 'an',
  // 算术/逻辑运算符词形：后跟括号是括号子表达式，不是函数调用
  'plus', 'minus', 'times', 'divided', 'modulo', 'by', 'integer',
]);

/** 源码是否调用了从未定义的裸小写函数名（无 `Rule name`、无 `Let name be function`），
 *  且不是 stdlib 的 `X.y(` 命名空间调用、也不是关键字/运算符词形。 */
function callsUndefinedFunction(src) {
  const defined = new Set();
  for (const m of src.matchAll(/\bRule\s+([a-z]\w*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\bLet\s+([a-z]\w*)\s+be\s+function\b/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?<![A-Za-z0-9_.])([a-z]\w*)\s*\(/g)) {
    const fn = m[1];
    if (!defined.has(fn) && !RESERVED_WORDS.has(fn)) return true;
  }
  return false;
}

const all = readdirSync(POLICIES).filter((f) => f.endsWith('.aster')).map((f) => f.replace('.aster', ''));
const hasCases = new Set(
  readdirSync(INPUTS).filter((f) => f.endsWith('.cases.json')).map((f) => f.replace('.cases.json', '')),
);

let exemptCount = 0;
let taggedCount = 0;
const exemptByReason = {};
const evalableNoCases = [];

for (const name of all) {
  const metaPath = join(POLICIES, `${name}.meta.json`);
  if (!existsSync(metaPath)) continue;
  const src = readFileSync(join(POLICIES, `${name}.aster`), 'utf8');
  // A sample with golden cases is, by definition, eval-able — never exempt it
  // (some samples have one undefined-call rule but a separately-covered entry).
  const ex = hasCases.has(name) ? null : exemptReason(name, src);

  if (ex) {
    exemptCount++;
    exemptByReason[ex.reason] = (exemptByReason[ex.reason] || 0) + 1;
    if (WRITE) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.evalExempt !== true || meta.evalExemptReason !== ex.reason) {
        meta.evalExempt = true;
        meta.evalExemptReason = ex.reason;
        meta.evalExemptDetail = ex.detail;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        taggedCount++;
      }
    }
  } else if (!hasCases.has(name)) {
    evalableNoCases.push(name);
  }
}

const total = all.length;
const evalable = total - exemptCount;
const covered = all.filter((n) => hasCases.has(n)).length;
const pct = ((covered / evalable) * 100).toFixed(1);

console.log('=== tier1 eval coverage ===');
console.log(`total samples:        ${total}`);
console.log(`eval-exempt:          ${exemptCount}  ${JSON.stringify(exemptByReason)}`);
console.log(`eval-able:            ${evalable}`);
console.log(`with .cases.json:     ${covered}`);
console.log(`coverage:             ${covered}/${evalable} = ${pct}% of eval-able samples`);
console.log(`\neval-able WITHOUT cases (${evalableNoCases.length} remaining to backfill):`);
console.log('  ' + evalableNoCases.join(', '));
if (WRITE) console.log(`\n✅ tagged ${taggedCount} meta.json with evalExempt.`);
else console.log('\n(dry run — pass --write to tag meta.json)');

if (HISTORY_FILE) {
  const ts = new Date().toISOString();
  const rate = evalable > 0 ? covered / evalable : 0;
  if (!existsSync(HISTORY_FILE)) {
    writeFileSync(HISTORY_FILE, 'timestamp,total,value,rate\n');
  }
  appendFileSync(HISTORY_FILE, `${ts},${evalable},${covered},${rate.toFixed(4)}\n`);
  console.error(`[tag-eval-exempt] appended coverage history → ${HISTORY_FILE} (${covered}/${evalable})`);
}
