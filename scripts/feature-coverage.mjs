#!/usr/bin/env node
/**
 * Feature-coverage instrument.
 *
 * Sample-level eval coverage answers "how many corpus *samples* are executed
 * dual-engine"; it does NOT say *which language features* are actually exercised
 * (a feature could appear only in samples that are eval-exempt, so it's parsed
 * but never executed by the equivalence gate). This tool closes that gap.
 *
 * For each language feature it reports three depths:
 *   - declared       : the feature appears in ≥1 corpus sample at all;
 *   - parse-covered  : appears in a sample listed in the PR-blocking parse
 *                      manifest (both engines must accept it);
 *   - eval-covered   : appears in a sample that has a verified .cases.json
 *                      (both engines produce identical runtime output).
 *
 * A feature that is `declared` + `parse-covered` but NOT `eval-covered` is a
 * blind spot: the grammar accepts it on both sides, but no test proves the two
 * engines *execute* it the same way.
 *
 * Detection is purely textual (regex over canonicalized English source). It is
 * deliberately conservative — a feature counts as exercised by a sample only if
 * its detector matches that sample's source.
 *
 * Usage:
 *   node scripts/feature-coverage.mjs            # human-readable report (stdout)
 *   node scripts/feature-coverage.mjs --json     # machine-readable JSON (stdout)
 *   node scripts/feature-coverage.mjs --gaps     # only list eval blind spots
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const POLICIES = join(ROOT, 'corpus', 'tier1-equivalence', 'policies');
const INPUTS = join(ROOT, 'corpus', 'tier1-equivalence', 'inputs');
const MANIFEST = join(ROOT, 'corpus', 'tier1-parity', 'manifest.json');

const JSON_OUT = process.argv.includes('--json');
const GAPS_ONLY = process.argv.includes('--gaps');
// --history=<file>: append a trend row `timestamp,total,value,rate` (value =
// eval-covered features, total = features present in corpus).
const HISTORY_FILE = (() => {
  const a = process.argv.find((x) => x.startsWith('--history='));
  return a ? resolve(a.slice('--history='.length)) : null;
})();

// ---------------------------------------------------------------------------
// Feature taxonomy. Each feature has a `group`, a human label, and a `test`
// predicate over a sample's source text. Detectors match the canonical English
// surface forms (the corpus is authored in en-US). Keep these conservative and
// anchored so a substring like a module name can't trigger a false positive.
// ---------------------------------------------------------------------------
const FEATURES = [
  // --- declarations ---
  ['decl', 'Module declaration',        (s) => /^\s*Module\s+/m.test(s)],
  ['decl', 'Rule declaration',          (s) => /^\s*Rule\s+\w/m.test(s)],
  ['decl', 'Data type (Define … has)',  (s) => /\bDefine\s+[A-Z]\w*\s+has\b/.test(s)],
  ['decl', 'Enum (Define … as one of)', (s) => /\bDefine\s+[A-Z]\w*\s+as one of\b/.test(s)],
  ['decl', 'Type alias (type … as)',    (s) => /^\s*type\s+\w+\s+as\b/mi.test(s)],
  ['decl', 'Cross-module import (Use)', (s) => /^\s*Use\b/m.test(s)],
  ['decl', 'Parameters (given)',        (s) => /\bgiven\b/.test(s)],
  ['decl', 'Typed parameter (… as T)',  (s) => /\bgiven\b.*\bas\s+[A-Z]\w*/.test(s)],
  ['decl', 'Declared return type',      (s) => /\bproduce\s+[A-Z]\w*\s*:/.test(s)],

  // --- statements ---
  ['stmt', 'Let binding',               (s) => /^\s*Let\s+\w/m.test(s)],
  ['stmt', 'Set (reassignment)',        (s) => /^\s*Set\s+\w/m.test(s)],
  ['stmt', 'Return',                    (s) => /\bReturn\b/.test(s)],
  ['stmt', 'If',                        (s) => /^\s*If\b/m.test(s)],
  ['stmt', 'If/Otherwise (else)',       (s) => /^\s*Otherwise\b/m.test(s)],
  ['stmt', 'Match',                     (s) => /^\s*Match\b/m.test(s)],
  ['stmt', 'Match When arm',            (s) => /^\s*When\b/m.test(s)],
  ['stmt', 'Match When null',           (s) => /\bWhen\s+null\b/.test(s)],
  ['stmt', 'Match ctor pattern',        (s) => /\bWhen\s+[A-Z]\w*\s*\(/.test(s)],
  ['stmt', 'Workflow Start',            (s) => /^\s*Start\b/m.test(s)],
  ['stmt', 'Workflow Wait',             (s) => /^\s*Wait\b/m.test(s)],

  // --- expressions ---
  ['expr', 'Field access (a.b)',        (s) => /\b[a-z]\w*\.[a-z]\w*\b/.test(s)],
  ['expr', 'Struct construction (with)',(s) => /\b[A-Z]\w*\s+with\s+\w+\s+set to\b/.test(s)],
  ['expr', 'Function call',             (s) => /(?<![A-Za-z0-9_.])[a-z]\w*\s*\(/.test(s)],
  ['expr', 'Lambda (be function)',      (s) => /\bbe\s+function\b/.test(s)],
  ['expr', 'Ok(…) / ok of',             (s) => /\bok of\b|(?<![A-Za-z0-9_.])Ok\s*\(/.test(s)],
  ['expr', 'Err(…) / err of',           (s) => /\berr of\b|(?<![A-Za-z0-9_.])Err\s*\(/.test(s)],
  ['expr', 'Some(…) / some of',         (s) => /\bsome of\b|(?<![A-Za-z0-9_.])Some\s*\(/.test(s)],
  ['expr', 'None / none',               (s) => /(?<![A-Za-z0-9_.])[Nn]one\b/.test(s)],
  ['expr', 'String literal',            (s) => /"/.test(s)],

  // --- operators ---
  ['op', 'plus (+)',                    (s) => /\bplus\b/.test(s)],
  ['op', 'minus (-)',                   (s) => /\bminus\b/.test(s)],
  ['op', 'times (*)',                   (s) => /\btimes\b/.test(s)],
  ['op', 'divided by (/)',              (s) => /\bdivided by\b/.test(s)],
  ['op', 'integer divided by (//)',     (s) => /\binteger divided by\b/.test(s)],
  ['op', 'modulo (%)',                  (s) => /\bmodulo\b/.test(s)],
  ['op', 'greater than',                (s) => /\bgreater than\b/.test(s)],
  ['op', 'less than',                   (s) => /\bless than\b/.test(s)],
  ['op', 'at least (>=)',               (s) => /\bat least\b/.test(s)],
  ['op', 'at most (<=)',                (s) => /\bat most\b/.test(s)],
  ['op', 'equals to (==)',              (s) => /\bequals? to\b/.test(s)],
  ['op', 'is (not) equal to',           (s) => /\bis (not )?equal to\b/.test(s)],
  ['op', 'logical and',                 (s) => /\sand\s/.test(s)],
  ['op', 'logical or',                  (s) => /\sor\s/.test(s)],
  ['op', 'logical not',                 (s) => /\bnot\b/.test(s)],

  // --- stdlib namespaces ---
  ['stdlib', 'Text.*',                  (s) => /\bText\.\w+/.test(s)],
  ['stdlib', 'List.*',                  (s) => /\bList\.\w+/.test(s)],
  ['stdlib', 'Map.*',                   (s) => /\bMap\.\w+/.test(s)],
  ['stdlib', 'Maybe/Option.*',          (s) => /\b(Maybe|Option)\.\w+/.test(s)],
  ['stdlib', 'Result.*',                (s) => /\bResult\.\w+/.test(s)],
  ['stdlib', 'higher-order (map/filter/reduce)', (s) => /\b(List\.(map|filter|reduce)|Maybe\.map|Result\.map\w*)\b/.test(s)],

  // --- effects / annotations ---
  ['adv', 'Effect declaration (It performs)', (s) => /\bIt performs\b/.test(s)],
  ['adv', 'Capability (requires)',      (s) => /\brequires\b/.test(s)],
  ['adv', '@pii annotation',            (s) => /@pii\b/.test(s)],
  ['adv', '@entry annotation',          (s) => /@entry\b/.test(s)],
  ['adv', '@example annotation',        (s) => /@example\b/.test(s)],
  ['adv', '@cpu annotation',            (s) => /@cpu\b/.test(s)],
];

const GROUP_LABELS = {
  decl: 'Declarations', stmt: 'Statements', expr: 'Expressions',
  op: 'Operators', stdlib: 'Stdlib', adv: 'Effects / Annotations',
};

// ---------------------------------------------------------------------------
// Load corpus + coverage sets.
// ---------------------------------------------------------------------------
const allSamples = readdirSync(POLICIES)
  .filter((f) => f.endsWith('.aster'))
  .map((f) => f.replace('.aster', ''));

const manifestSet = new Set(
  JSON.parse(readFileSync(MANIFEST, 'utf8')).samples.map(
    (p) => p.replace(/^.*\//, '').replace('.aster', ''),
  ),
);

const evalSet = new Set(
  readdirSync(INPUTS)
    .filter((f) => f.endsWith('.cases.json'))
    .map((f) => f.replace('.cases.json', '')),
);

const sources = new Map();
for (const name of allSamples) {
  sources.set(name, readFileSync(join(POLICIES, `${name}.aster`), 'utf8'));
}

// ---------------------------------------------------------------------------
// Compute per-feature coverage.
// ---------------------------------------------------------------------------
const rows = FEATURES.map(([group, label, test]) => {
  let declared = 0;
  let parse = 0;
  let evald = 0;
  for (const [name, src] of sources) {
    if (!test(src)) continue;
    declared++;
    if (manifestSet.has(name)) parse++;
    if (evalSet.has(name)) evald++;
  }
  return { group, label, declared, parse, eval: evald };
});

const used = rows.filter((r) => r.declared > 0);
const unused = rows.filter((r) => r.declared === 0); // declared-but-absent = a gap in the corpus itself
const evalGaps = used.filter((r) => r.eval === 0);    // exercised but never executed dual-engine

if (HISTORY_FILE) {
  const total = used.length;                          // features present in corpus
  const value = used.filter((r) => r.eval > 0).length; // of those, eval-covered
  const ts = new Date().toISOString();
  const rate = total > 0 ? value / total : 0;
  if (!existsSync(HISTORY_FILE)) {
    writeFileSync(HISTORY_FILE, 'timestamp,total,value,rate\n');
  }
  appendFileSync(HISTORY_FILE, `${ts},${total},${value},${rate.toFixed(4)}\n`);
  process.stderr.write(`[feature-coverage] appended history → ${HISTORY_FILE} (${value}/${total})\n`);
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      features: FEATURES.length,
      declared: used.length,
      parseCovered: used.filter((r) => r.parse > 0).length,
      evalCovered: used.filter((r) => r.eval > 0).length,
    },
    features: rows,
    notInCorpus: unused.map((r) => r.label),
    evalBlindSpots: evalGaps.map((r) => r.label),
  }, null, 2) + '\n');
  process.exit(0);
}

if (GAPS_ONLY) {
  console.log('# Feature eval blind spots (declared + parsed, but never executed dual-engine)\n');
  if (evalGaps.length === 0) {
    console.log('None — every exercised feature has at least one eval-verified sample.');
  } else {
    for (const r of evalGaps) {
      console.log(`- [${GROUP_LABELS[r.group]}] ${r.label}  (parse-covered in ${r.parse} sample${r.parse === 1 ? '' : 's'})`);
    }
  }
  console.log();
  if (unused.length) {
    console.log('# Not present in the corpus at all\n');
    for (const r of unused) console.log(`- [${GROUP_LABELS[r.group]}] ${r.label}`);
  }
  process.exit(0);
}

// Full report.
const pad = (s, n) => String(s).padEnd(n);
console.log('# tier1 feature-coverage report\n');
console.log(`- features tracked:   ${FEATURES.length}`);
console.log(`- present in corpus:  ${used.length}`);
console.log(`- parse-covered:      ${used.filter((r) => r.parse > 0).length}`);
console.log(`- eval-covered:       ${used.filter((r) => r.eval > 0).length}`);
console.log(`- eval blind spots:   ${evalGaps.length}`);
console.log(`- absent from corpus: ${unused.length}\n`);

let lastGroup = null;
console.log('| feature | declared | parse | eval | depth |');
console.log('|---|--:|--:|--:|---|');
for (const r of rows) {
  if (r.group !== lastGroup) {
    console.log(`| **${GROUP_LABELS[r.group]}** | | | | |`);
    lastGroup = r.group;
  }
  const depth = r.declared === 0 ? '— absent'
    : r.eval > 0 ? '✅ eval'
    : r.parse > 0 ? '⚠️ parse-only'
    : '🟡 declared-only';
  console.log(`| ${pad(r.label, 30)} | ${r.declared} | ${r.parse} | ${r.eval} | ${depth} |`);
}

if (evalGaps.length) {
  console.log('\n## ⚠️ Eval blind spots (parsed on both engines, never executed dual-engine)\n');
  for (const r of evalGaps) console.log(`- [${GROUP_LABELS[r.group]}] ${r.label}`);
}
if (unused.length) {
  console.log('\n## — Features absent from the corpus\n');
  for (const r of unused) console.log(`- [${GROUP_LABELS[r.group]}] ${r.label}`);
}
