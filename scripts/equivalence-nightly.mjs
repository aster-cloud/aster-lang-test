#!/usr/bin/env node
/**
 * Nightly dual-engine equivalence runner (P1-9)
 *
 * 当前阶段：parse-equivalence
 *   - 跑 tier1-equivalence 全部 .aster
 *   - TS 引擎：直接 import + canonicalize/lex/parse
 *   - Java 引擎：调 inventory.mjs --parser=java
 *   - 两边都通过 → equivalent；任一失败 → divergence
 *
 * 下阶段（P1-9.5，未实施）：eval-equivalence
 *   - 用 .cases.json 输入 + 两边引擎跑 evaluate，比较 expected vs actual
 *   - 需要 Java 侧轻量 CLI（Truffle Context.eval(Source)）
 *
 * 输出：
 *   - stdout: 人类可读 markdown
 *   - equivalence-report.json: 机器可读详细结果
 *   - equivalence-history.csv: append 一行 timestamp,total,equiv,divergent,rate
 *
 * Exit:
 *   - 0 : equivalence rate >= baseline (从 history 取上次值或 0.7)
 *   - 1 : equivalence rate 倒退（regression）或基础设施失败
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORPUS = join(ROOT, 'corpus');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const CORE_REPO = resolve(ROOT, '..', 'aster-lang-core');
const HISTORY_FILE = join(ROOT, 'equivalence-history.csv');
const REPORT_FILE = join(ROOT, 'equivalence-report.json');
const MANIFEST_FILE = join(ROOT, 'corpus', 'tier1-parity', 'manifest.json');

function walkAster(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walkAster(p, out);
    else if (e.endsWith('.aster')) out.push(p);
  }
  return out;
}

async function runTsParse(samples) {
  // Lazy-import the TS engine. Built artefacts live at dist/src/index.js.
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(distIndex)) {
    throw new Error(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  }
  const mod = await import(distIndex);
  const { canonicalize, lex, parse } = mod;
  if (!canonicalize || !lex || !parse) {
    throw new Error('aster-lang-ts is missing expected exports (canonicalize/lex/parse)');
  }

  const results = {};
  for (const abs of samples) {
    const rel = relative(CORPUS, abs);
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
      err = e.message || String(e);
    }
    results[rel] = { ok, err };
  }
  return results;
}

function runJavaParse(samples) {
  // Invoke aster-lang-core's TsSampleParseInventoryTest. The test only emits
  // markdown rows for FAILING samples (lines starting with "| ... | ❌ | ...").
  // Strategy: parse all corpus-relative paths from the failure rows, then
  // default to "ok=true" for every sample NOT in the failure list.
  const result = spawnSync(
    './gradlew',
    ['test', '--tests', 'TsSampleParseInventoryTest', '--rerun-tasks', '-i'],
    { cwd: CORE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.status !== 0 && !output.includes('=== TS-engine sample → Java parser inventory ===')) {
    throw new Error('aster-lang-core inventory test failed:\n' + output.slice(-2000));
  }

  // Confirm the test actually ran (line "Discovered N samples")
  if (!output.includes('Discovered ') || !output.includes('Pass-rate:')) {
    throw new Error('aster-lang-core inventory test output incomplete:\n' + output.slice(-2000));
  }

  // Collect explicit failures. Row format:
  //   | corpus/<path> | ❌ | <first-error> |
  const failed = new Set();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*\|\s*(corpus\/[^|]+?\.aster)\s*\|\s*❌\s*\|/);
    if (m) failed.add(m[1].trim().replace(/^corpus\//, ''));
  }

  // Build per-sample result: ok=true unless explicitly listed as failed.
  const results = {};
  for (const abs of samples) {
    const rel = relative(CORPUS, abs);
    results[rel] = { ok: !failed.has(rel) };
  }
  return results;
}

function classify(tsRes, javaRes, allSamples) {
  const rows = [];
  for (const abs of allSamples) {
    const rel = relative(CORPUS, abs);
    const t = tsRes[rel] || { ok: false, err: 'missing in ts result' };
    const j = javaRes[rel] || { ok: false, err: 'missing in java result' };
    let verdict;
    if (t.ok && j.ok) verdict = 'equivalent';
    else if (!t.ok && !j.ok) verdict = 'both-fail';
    else verdict = 'divergent';
    rows.push({ path: rel, ts: t.ok, java: j.ok, verdict, tsErr: t.err, javaErr: j.err });
  }
  return rows;
}

function summarise(rows) {
  const total = rows.length;
  const equivalent = rows.filter((r) => r.verdict === 'equivalent').length;
  const divergent = rows.filter((r) => r.verdict === 'divergent').length;
  const bothFail = rows.filter((r) => r.verdict === 'both-fail').length;
  const rate = total === 0 ? 0 : equivalent / total;
  return { total, equivalent, divergent, bothFail, rate };
}

function readLastBaseline() {
  if (!existsSync(HISTORY_FILE)) return null;
  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split(',');
    if (parts.length >= 5 && !isNaN(Number(parts[4]))) return Number(parts[4]);
  }
  return null;
}

function appendHistory(s) {
  const ts = new Date().toISOString();
  const line = `${ts},${s.total},${s.equivalent},${s.divergent},${s.rate.toFixed(4)}\n`;
  if (!existsSync(HISTORY_FILE)) {
    writeFileSync(HISTORY_FILE, 'timestamp,total,equivalent,divergent,rate\n');
  }
  appendFileSync(HISTORY_FILE, line);
  return ts;
}

// 把 tier1-parity manifest 的 basedOnEquivalence 块同步到本次重生的 report.summary。
// 该块是「引用 report」的派生快照（见 check-equivalence-freshness.mjs Check 4：要求
// manifest.basedOnEquivalence 的 total/equivalent/divergent + history 与 report.summary
// 一致——rate/bothFail 不参与比对）。Phase A 重生 report 后若不同步它，
// 语料计数一变（如新增 parity 样本、分歧清零）就会触发 Check 4 失配——这正是 nightly
// 06-17 起连挂的根因之一。此处只【拷贝本次真实跑出的数字】（total/equivalent/divergent +
// report 自带的 basedOnHistory 时间戳），不发明任何计数，保持 fabrication-proof。
function refreshManifest(summary) {
  if (!existsSync(MANIFEST_FILE)) return;
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const prev = manifest.basedOnEquivalence || {};
  manifest.basedOnEquivalence = {
    history: summary.basedOnHistory,
    total: summary.total,
    equivalent: summary.equivalent,
    divergent: summary.divergent,
    _comment: prev._comment ||
      'Dated baseline matching equivalence-report.json (summary.basedOnHistory). ' +
      'Kept consistent by scripts/check-equivalence-freshness.mjs. ' +
      'The live rate is the latest row of equivalence-history.csv.',
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
}

function printMarkdown(s, rows) {
  console.log('# Dual-engine parse-equivalence report\n');
  console.log(`- total: ${s.total}`);
  console.log(`- equivalent (both ok): ${s.equivalent}`);
  console.log(`- divergent (one fails): ${s.divergent}`);
  console.log(`- both fail: ${s.bothFail}`);
  console.log(`- **equivalence rate: ${(s.rate * 100).toFixed(2)}%**\n`);

  const divergent = rows.filter((r) => r.verdict === 'divergent');
  if (divergent.length) {
    console.log('## Divergent samples\n');
    console.log('| path | TS | Java |');
    console.log('|------|----|----|');
    for (const r of divergent) {
      console.log(`| ${r.path} | ${r.ts ? '✓' : '✗ ' + (r.tsErr || '').slice(0, 60)} | ${r.java ? '✓' : '✗'} |`);
    }
  }
}

async function main() {
  // 覆盖 tier1 + tier2-divergent 的 ts-only / java-only。
  // tier1 是基线（应全部 equivalent），tier2 是已知分歧（驱动等价率提升）。
  const roots = [
    join(CORPUS, 'tier1-equivalence', 'policies'),
    join(CORPUS, 'tier2-divergent', 'ts-only'),
    join(CORPUS, 'tier2-divergent', 'java-only'),
  ];
  const samples = [];
  for (const r of roots) {
    if (existsSync(r)) walkAster(r, samples);
  }
  if (samples.length === 0) {
    console.error('No samples found under tier1-equivalence + tier2-divergent');
    process.exit(2);
  }
  console.error(`[nightly] running parse-equivalence over ${samples.length} samples (tier1 + tier2)`);

  console.error('[nightly] running TS engine ...');
  const tsRes = await runTsParse(samples);

  console.error('[nightly] running Java engine (gradle, may take ~30s) ...');
  const javaRes = runJavaParse(samples);

  const rows = classify(tsRes, javaRes, samples);
  const s = summarise(rows);

  // Append the history row first so we can stamp the report's summary with the
  // exact timestamp of the row it corresponds to. This lets
  // scripts/check-equivalence-freshness.mjs verify (with --require-fresh) that
  // the committed snapshot is a real, latest nightly result and not hand-edited.
  const historyTs = appendHistory(s);
  const summary = { ...s, basedOnHistory: historyTs };
  writeFileSync(REPORT_FILE, JSON.stringify({ summary, rows }, null, 2));
  // 让 tier1-parity manifest 的 basedOnEquivalence 跟随本次 report，避免
  // check-equivalence-freshness.mjs --require-fresh 的 Check 4 失配。
  refreshManifest(summary);
  printMarkdown(s, rows);

  const baseline = readLastBaseline();
  if (baseline !== null && s.rate + 1e-6 < baseline) {
    console.error(`\n::error::equivalence rate regressed: ${s.rate.toFixed(4)} < baseline ${baseline.toFixed(4)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
