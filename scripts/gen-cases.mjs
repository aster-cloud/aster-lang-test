#!/usr/bin/env node
/**
 * Golden-cases generator / verifier for tier1-equivalence eval coverage.
 *
 * Reads a spec file describing, per sample, the entry function and a set of
 * input vectors (with the EXPECTED output the author intends). For each case it
 * runs BOTH engines (TS via dual-engine-runner, Java via CoreIrEvalCli) and:
 *   - writes the case into corpus/tier1-equivalence/inputs/<sample>.cases.json
 *     ONLY when both engines agree AND match the author's expected value;
 *   - otherwise reports the disagreement and SKIPS the file, so a single-engine
 *     bug is never frozen into a golden.
 *
 * The author still supplies `expected` (the intended semantics) — the engines
 * are a cross-check, not the source of truth. This prevents codifying whatever
 * the engines happen to do today.
 *
 * Spec format (cases-spec.json):
 *   {
 *     "samples": [
 *       { "name": "03-if-else", "entry": "grade",
 *         "cases": [
 *           { "name": "95 → A", "input": [95], "expectedOutput": "A" },
 *           ...
 *         ] }
 *     ]
 *   }
 *
 * Usage:
 *   node scripts/gen-cases.mjs <spec.json> [--write] [--only=NAME,NAME]
 *   (without --write it's a dry run: reports agreement, writes nothing)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORPUS = join(ROOT, 'corpus');
const POLICIES = join(CORPUS, 'tier1-equivalence', 'policies');
const INPUTS = join(CORPUS, 'tier1-equivalence', 'inputs');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const TRUFFLE_REPO = resolve(ROOT, '..', 'aster-lang-truffle');
const TS_RUNNER = join(TS_REPO, 'scripts', 'dual-engine-runner.mjs');

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

if (!specPath) {
  console.error('usage: gen-cases.mjs <spec.json> [--write] [--only=NAME,...]');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const samples = spec.samples.filter((s) => !ONLY || ONLY.has(s.name));

// ---- flatten to per-case requests ----
// Java's CoreIrEvalCli reads caseIndex as an int and joins on (samplePath,
// caseIndex). We give each request a GLOBAL integer index so the join key is
// unique even across samples; `key()` mirrors what each engine echoes back.
const requests = [];
let gIdx = 0;
for (const s of samples) {
  const samplePath = join(POLICIES, `${s.name}.aster`);
  if (!existsSync(samplePath)) {
    console.error(`!! sample not found: ${s.name}.aster`);
    continue;
  }
  s.cases.forEach((c, i) => {
    requests.push({
      sample: s.name, samplePath, entry: s.entry, input: c.input,
      localIndex: i, gIndex: gIdx++, name: c.name, expected: c.expectedOutput,
    });
  });
}
const javaKey = (r) => `${r.samplePath}#${r.gIndex}`;

// ---- TS engine (one spawn per case) ----
function runTs(reqs) {
  const out = new Map();
  for (const r of reqs) {
    const source = readFileSync(r.samplePath, 'utf8');
    const proc = spawnSync('node', [TS_RUNNER], {
      input: JSON.stringify({ source, entry: r.entry, input: r.input }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    let res;
    try {
      res = JSON.parse((proc.stdout || '').trim());
    } catch {
      res = { success: false, error: (proc.stderr || 'bad ts output').slice(0, 200) };
    }
    out.set(r.gIndex, res);
  }
  return out;
}

// ---- Java engine (batched CoreIrEvalCli) ----
function runJava(reqs) {
  const tmp = mkdtempSync(join(tmpdir(), 'gencases-'));
  const inFile = join(tmp, 'req.jsonl');
  const outFile = join(tmp, 'out.jsonl');
  writeFileSync(
    inFile,
    reqs.map((r) => JSON.stringify({ samplePath: r.samplePath, entry: r.entry, input: r.input, caseIndex: r.gIndex })).join('\n') + '\n',
  );
  const res = spawnSync(
    './gradlew',
    ['test', '--tests', 'CoreIrEvalCli', '--rerun-tasks', '-q', `-Dparity.eval.input=${inFile}`, `-Dparity.eval.output=${outFile}`],
    { cwd: TRUFFLE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!existsSync(outFile)) {
    console.error('Java CoreIrEvalCli produced no output:\n', ((res.stdout || '') + (res.stderr || '')).slice(-1500));
    process.exit(2);
  }
  const out = new Map();
  for (const line of readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      // Join on (samplePath, caseIndex) — caseIndex is our global int index.
      if (rec.samplePath !== undefined && rec.caseIndex !== undefined) {
        out.set(`${rec.samplePath}#${rec.caseIndex}`, rec);
      }
    } catch {}
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return out;
}

console.error(`[gen-cases] ${requests.length} cases across ${samples.length} samples — running TS…`);
const ts = runTs(requests);
console.error('[gen-cases] running Java (gradle, ~1min)…');
const java = runJava(requests);

// ---- compare + decide ----
const J = (v) => JSON.stringify(v);
const bySample = new Map();
let agree = 0;
const problems = [];
for (const r of requests) {
  const key = `${r.sample}#${r.localIndex}`;
  const t = ts.get(r.gIndex) || { success: false, error: 'no ts' };
  const jr = java.get(javaKey(r)) || { ok: false, error: 'no java' };
  const tVal = t.success ? t.value : undefined;
  const jVal = jr.ok ? jr.value : undefined;
  const exp = r.expected;
  const tsOk = t.success && J(tVal) === J(exp);
  const jaOk = jr.ok && J(jVal) === J(exp);
  if (tsOk && jaOk) {
    agree++;
    if (!bySample.has(r.sample)) bySample.set(r.sample, []);
    bySample.get(r.sample).push({ name: r.name, input: r.input, expectedOutput: exp });
  } else {
    problems.push({ key, name: r.name, expected: exp, ts: t.success ? tVal : `ERR:${t.error}`, java: jr.ok ? jVal : `ERR:${jr.error}` });
  }
}

console.log(`\n=== gen-cases: ${agree}/${requests.length} cases verified (both engines == expected) ===`);
if (problems.length) {
  console.log(`\n⚠️  ${problems.length} case(s) NOT verified (skipped — needs author review):`);
  for (const p of problems) {
    console.log(`  ${p.key} "${p.name}": expected=${J(p.expected)} ts=${J(p.ts)} java=${J(p.java)}`);
  }
}

// ---- write verified samples ----
let written = 0;
for (const s of samples) {
  const cases = bySample.get(s.name);
  if (!cases || cases.length === 0) continue;
  if (cases.length !== s.cases.length) {
    console.log(`  ~ ${s.name}: only ${cases.length}/${s.cases.length} cases verified — NOT writing (partial)`);
    continue;
  }
  const doc = { policy: `tier1-equivalence/policies/${s.name}.aster`, entry: s.entry, cases };
  if (WRITE) {
    writeFileSync(join(INPUTS, `${s.name}.cases.json`), JSON.stringify(doc, null, 2) + '\n');
    written++;
  }
}
console.log(WRITE ? `\n✅ wrote ${written} verified .cases.json file(s).` : `\n(dry run — pass --write to persist ${bySample.size} fully-verified sample(s))`);
process.exit(problems.length > 0 ? 1 : 0);
