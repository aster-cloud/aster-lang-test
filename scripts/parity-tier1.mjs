#!/usr/bin/env node
/**
 * tier1-parity PR-blocking gate.
 *
 * Reads `corpus/tier1-parity/manifest.json` — the explicit, reviewed list
 * of samples both engines must accept — and runs each through TS + Java.
 * Any divergence (or any sample missing from disk) is a hard failure.
 *
 * Intentional contrast with `equivalence-nightly.mjs`:
 *   - that script walks ALL tier1 + tier2 and tracks a *rate*, regressing
 *     only when the rate drops vs. baseline. It's an observation tool.
 *   - this script walks the explicit allow-list and is strict: every
 *     sample must pass both engines, no exceptions.
 *
 * Modes (mirrors the planned phase progression):
 *   --mode=parse  (default, Phase A) — parse both engines, compare ok/fail
 *   --mode=ir     (Phase B, NOT IMPLEMENTED) — compare normalized Core IR JSON
 *   --mode=eval   (Phase C, NOT IMPLEMENTED) — compare evaluator output
 *
 * Exit codes:
 *   0  — every manifest entry passed parse on both engines
 *   1  — at least one parse divergence (this is the PR-blocking signal)
 *   2  — infra failure (build missing, manifest invalid, etc.)
 *
 * Output:
 *   stdout — human markdown summary
 *   parity-tier1-report.json — machine-readable detail (per-sample verdict)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORPUS = join(ROOT, 'corpus');
const MANIFEST_FILE = join(CORPUS, 'tier1-parity', 'manifest.json');
const REPORT_FILE = join(ROOT, 'parity-tier1-report.json');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const CORE_REPO = resolve(ROOT, '..', 'aster-lang-core');

const args = process.argv.slice(2);
const modeArg = args.find((a) => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.slice('--mode='.length) : 'parse';

function fail(msg, code = 2) {
  console.error(`::error::${msg}`);
  process.exit(code);
}

function loadManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    fail(`manifest not found: ${MANIFEST_FILE}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    fail(`manifest is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    fail('manifest.samples must be a non-empty array');
  }
  return manifest;
}

function resolveSamples(manifest) {
  const out = [];
  const missing = [];
  for (const rel of manifest.samples) {
    const abs = join(CORPUS, rel);
    if (existsSync(abs)) {
      out.push({ rel, abs });
    } else {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail(`manifest references ${missing.length} missing sample(s):\n  - ${missing.join('\n  - ')}`);
  }
  return out;
}

async function runTsParse(samples) {
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(distIndex)) {
    fail(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  }
  const mod = await import(distIndex);
  const { canonicalize, lex, parse } = mod;
  if (!canonicalize || !lex || !parse) {
    fail('aster-lang-ts is missing expected exports (canonicalize/lex/parse)');
  }

  const results = {};
  for (const { rel, abs } of samples) {
    let ok = false;
    let err = null;
    try {
      const src = readFileSync(abs, 'utf8');
      const canonical = canonicalize(src);
      const tokens = lex(canonical);
      const { ast, diagnostics } = parse(tokens);
      if (diagnostics && diagnostics.some((d) => d.severity === 'error')) {
        err = diagnostics.find((d) => d.severity === 'error').message;
      } else if (!ast) {
        err = 'parse returned no AST';
      } else {
        ok = true;
      }
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
    results[rel] = { ok, err };
  }
  return results;
}

function runJavaParse(samples) {
  // Reuse aster-lang-core's TsSampleParseInventoryTest. It prints:
  //   `Discovered N samples (tier1 + tier2/ts-only)`  — total Java saw
  //   `| corpus/<path> | ❌ | err |`                   — failure rows only
  //   `Total: T, Pass: P, Fail: F, Pass-rate: X%`     — summary
  //
  // The test only emits rows for FAILURES (see
  // aster-lang-core/src/test/java/aster/core/dualengine/TsSampleParseInventoryTest.java).
  // That's fine *if* Java actually observed every manifest sample —
  // anything not on the failure list is genuinely passing.
  //
  // Stale-corpus blind spot (codex review R1): the inventory test
  // reads corpus from a Maven dependency `cloud.aster-lang:aster-lang-test`,
  // not the local checkout. A new sample added to the manifest in a
  // PR is NOT in that artifact, so the inventory test wouldn't see it
  // at all — and the runner would silently mark it ok.
  //
  // Defense: assert `Discovered N` >= manifest size. If the Java side
  // saw fewer samples than the manifest declares, it's reading a
  // stale corpus and the gate is invalid. The CI workflow MUST also
  // publish the local corpus to Maven Local before invoking gradle
  // (see ./.github/workflows/ci.yml `Publish corpus to Maven Local`).
  const result = spawnSync(
    './gradlew',
    ['test', '--tests', 'TsSampleParseInventoryTest', '--rerun-tasks', '-i'],
    { cwd: CORE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.status !== 0 && !output.includes('=== TS-engine sample → Java parser inventory ===')) {
    fail('aster-lang-core inventory test failed:\n' + output.slice(-2000));
  }
  if (!output.includes('Discovered ') || !output.includes('Pass-rate:')) {
    fail('aster-lang-core inventory test output incomplete:\n' + output.slice(-2000));
  }

  // Extract Discovered N — assert against manifest coverage.
  const discoveredMatch = output.match(/Discovered\s+(\d+)\s+samples/);
  if (!discoveredMatch) {
    fail('could not parse "Discovered N" from Java inventory output');
  }
  const discovered = Number(discoveredMatch[1]);
  if (discovered < samples.length) {
    fail(
      `Java inventory observed ${discovered} samples but the manifest declares ${samples.length}.\n` +
      `This means aster-lang-core is reading a stale corpus artifact, NOT the PR's\n` +
      `aster-lang-test checkout. The CI workflow must publish the local corpus\n` +
      `(./packages/jvm -> publishToMavenLocal) before invoking core's gradle test,\n` +
      `or the inventory test must be extended to accept a corpus override path.\n` +
      `Refusing to report a verdict — the result would be invalid.`,
    );
  }

  // Failure rows only. Anything in the manifest NOT listed here is a pass.
  const failed = new Set();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*\|\s*(corpus\/[^|]+?\.aster)\s*\|\s*❌\s*\|/);
    if (m) failed.add(m[1].trim().replace(/^corpus\//, ''));
  }

  const results = {};
  for (const { rel } of samples) {
    results[rel] = { ok: !failed.has(rel) };
  }
  return results;
}

function classify(tsRes, javaRes, samples) {
  const rows = [];
  for (const { rel } of samples) {
    const t = tsRes[rel] || { ok: false, err: 'missing in ts result' };
    const j = javaRes[rel] || { ok: false, err: 'missing in java result' };
    let verdict;
    if (t.ok && j.ok) verdict = 'pass';
    else if (!t.ok && !j.ok) verdict = 'both-fail';
    else verdict = 'divergent';
    rows.push({ path: rel, ts: t.ok, java: j.ok, verdict, tsErr: t.err || null });
  }
  return rows;
}

function printMarkdown(rows, mode) {
  const total = rows.length;
  const pass = rows.filter((r) => r.verdict === 'pass').length;
  const divergent = rows.filter((r) => r.verdict === 'divergent');
  const bothFail = rows.filter((r) => r.verdict === 'both-fail');

  console.log(`# tier1-parity report (mode=${mode})\n`);
  console.log(`- total: ${total}`);
  console.log(`- pass: ${pass}`);
  console.log(`- divergent: ${divergent.length}`);
  console.log(`- both-fail: ${bothFail.length}\n`);

  if (divergent.length) {
    console.log('## Divergent samples (one engine accepts, the other rejects)\n');
    console.log('| path | TS | Java | TS error |');
    console.log('|------|----|----|---------|');
    for (const r of divergent) {
      const tsCell = r.ts ? '✓' : '✗';
      const javaCell = r.java ? '✓' : '✗';
      const errCell = (r.tsErr || '').slice(0, 80);
      console.log(`| ${r.path} | ${tsCell} | ${javaCell} | ${errCell} |`);
    }
    console.log('');
  }
  if (bothFail.length) {
    console.log('## Both-fail samples (manifest is wrong — every entry must pass both)\n');
    for (const r of bothFail) {
      console.log(`- ${r.path}`);
    }
    console.log('');
  }
}

async function main() {
  if (MODE !== 'parse') {
    fail(`mode=${MODE} not implemented yet. Phase A only supports --mode=parse (default).`);
  }

  const manifest = loadManifest();
  const samples = resolveSamples(manifest);
  console.error(`[parity-tier1] manifest declares ${samples.length} samples (mode=${MODE})`);

  console.error('[parity-tier1] running TS engine ...');
  const tsRes = await runTsParse(samples);

  console.error('[parity-tier1] running Java engine (gradle, may take ~30s) ...');
  const javaRes = runJavaParse(samples);

  const rows = classify(tsRes, javaRes, samples);
  writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, total: rows.length, rows }, null, 2));
  printMarkdown(rows, MODE);

  const bad = rows.filter((r) => r.verdict !== 'pass');
  if (bad.length > 0) {
    console.error(`::error::tier1-parity broken: ${bad.length}/${rows.length} sample(s) did not pass both engines`);
    process.exit(1);
  }
  console.error('[parity-tier1] OK');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
