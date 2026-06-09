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
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const POLICIES = join(ROOT, 'corpus', 'tier1-equivalence', 'policies');
const INPUTS = join(ROOT, 'corpus', 'tier1-equivalence', 'inputs');
const WRITE = process.argv.includes('--write');

/** Decide exemption + reason for a sample, or null if it is eval-able. */
function exemptReason(name, src) {
  if (name.startsWith('bad_')) {
    return { reason: 'type-check-fail', detail: 'designed to fail type-checking; no runtime output to assert' };
  }
  if (name.startsWith('eff_') || /\bIt performs\b|\brequires\b/.test(src)) {
    return { reason: 'effects', detail: 'tests effect inference/enforcement (a compile-time concern), not runtime output' };
  }
  if (/\b(Http|Db|Files|Sql|Secrets|Ai)\.\w+\(/.test(src)) {
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
  return null;
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
  const ex = exemptReason(name, src);

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
