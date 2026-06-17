#!/usr/bin/env node
/**
 * Drift-guard for the equivalence parity artifacts (#30).
 *
 * The nightly job (`scripts/equivalence-nightly.mjs`) is the single source of
 * truth for the live parse-equivalence rate; it appends a row to
 * `equivalence-history.csv` on every run. The static snapshot
 * `equivalence-report.json`, the tier1-parity manifest and DIVERGENT-MANIFEST.md
 * are *dated* artifacts that are NOT regenerated on every change (see the note
 * at the top of DIVERGENT-MANIFEST.md). Nothing previously stopped them from
 * silently drifting into numbers that never corresponded to any real nightly
 * run, or from disagreeing with each other.
 *
 * This guard makes the artifacts self-checking. It is intentionally
 * *fabrication-proof*: it only ever compares numbers that already exist in
 * `equivalence-history.csv` and the committed artifacts — it never invents a
 * count. It FAILS (exit 1) when any of the following hold:
 *
 *   1. equivalence-report.json is internally inconsistent
 *      (its `summary` does not match a recount of its own `rows`).
 *   2. The report's `summary` totals do not correspond to ANY row in
 *      equivalence-history.csv (i.e. the snapshot was hand-edited to numbers
 *      that no nightly run ever produced).
 *   3. The report declares `summary.basedOnHistory` but that timestamp is not
 *      present in equivalence-history.csv, or its totals disagree with that row.
 *   4. The tier1-parity manifest's `basedOnEquivalence` block disagrees with
 *      the report it claims to cite.
 *   5. (only with --require-fresh) The report has drifted MORE than the allowed
 *      staleness window behind the latest nightly row. The window is a number of
 *      newer history rows (--max-stale-rows, default 0 → must match latest).
 *
 * Checks 1–4 are ALWAYS blocking: they catch hand-edited / fabricated numbers
 * and the three artifacts disagreeing with each other — the actual "silent
 * staleness" risk this guard exists to kill, and they require no engine run to
 * verify. They are wired PR-blocking in CI.
 *
 * Check 5 (calendar freshness vs the latest nightly) is OFF by default because
 * equivalence-report.json is, by documented design (see DIVERGENT-MANIFEST.md),
 * a *dated* snapshot regenerated only by the nightly job — the latest LIVE rate
 * lives in equivalence-history.csv. Refusing to bless a dated-but-real snapshot
 * would force fabricating per-sample rows for a run we cannot reproduce offline.
 * The nightly workflow runs this script WITH --require-fresh after regenerating
 * the report, so the snapshot is held to exact-match-latest at the one place
 * that can legitimately produce it. By default the staleness gap is reported as
 * an informational notice, never a failure.
 *
 * Usage:
 *   node scripts/check-equivalence-freshness.mjs [--require-fresh] [--max-stale-rows=N] [--json]
 *
 * Exit codes: 0 = consistent (& fresh if required), 1 = drift/inconsistency, 2 = bad input.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const HISTORY_FILE = join(ROOT, 'equivalence-history.csv');
const REPORT_FILE = join(ROOT, 'equivalence-report.json');
const MANIFEST_FILE = join(ROOT, 'corpus', 'tier1-parity', 'manifest.json');

function parseArgs(argv) {
  const opts = { maxStaleRows: 0, json: false, requireFresh: false };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--require-fresh') opts.requireFresh = true;
    else if (a.startsWith('--max-stale-rows=')) {
      const n = Number(a.slice('--max-stale-rows='.length));
      if (!Number.isInteger(n) || n < 0) fail(2, `--max-stale-rows must be a non-negative integer, got ${a}`);
      opts.maxStaleRows = n;
    } else {
      fail(2, `unknown argument: ${a}`);
    }
  }
  return opts;
}

const errors = [];
function note(msg) { errors.push(msg); }
function fail(code, msg) {
  console.error(`::error::${msg}`);
  process.exit(code);
}

function readHistory() {
  if (!existsSync(HISTORY_FILE)) fail(2, `missing ${HISTORY_FILE}`);
  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
  const header = lines.shift();
  if (!header || !header.startsWith('timestamp,total,equivalent,divergent,rate')) {
    fail(2, `unexpected equivalence-history.csv header: ${header}`);
  }
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [timestamp, total, equivalent, divergent, rate] = line.split(',');
    rows.push({
      timestamp: timestamp.trim(),
      total: Number(total),
      equivalent: Number(equivalent),
      divergent: Number(divergent),
      rate: Number(rate),
    });
  }
  if (rows.length === 0) fail(2, 'equivalence-history.csv has no data rows');
  return rows;
}

function sameTotals(a, b) {
  return a.total === b.total && a.equivalent === b.equivalent && a.divergent === b.divergent;
}

function fmt(o) {
  return `total=${o.total} equivalent=${o.equivalent} divergent=${o.divergent}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const history = readHistory();
  const latest = history[history.length - 1];

  // --- Load report ---
  if (!existsSync(REPORT_FILE)) fail(2, `missing ${REPORT_FILE}`);
  const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
  const summary = report.summary || {};
  const rows = report.rows || [];

  // Check 1: report internal consistency (summary vs recount of rows).
  const recount = {
    total: rows.length,
    equivalent: rows.filter((r) => r.verdict === 'equivalent').length,
    divergent: rows.filter((r) => r.verdict === 'divergent').length,
  };
  if (!sameTotals(summary, recount)) {
    note(`equivalence-report.json summary (${fmt(summary)}) does not match a recount of its own rows (${fmt(recount)}).`);
  }

  // Check 2: report summary corresponds to a real history row.
  const matchingRows = history.filter((h) => sameTotals(h, summary));
  if (matchingRows.length === 0) {
    note(
      `equivalence-report.json summary (${fmt(summary)}) does not correspond to ANY row in equivalence-history.csv. ` +
      `The snapshot must be a real nightly result — regenerate via scripts/equivalence-nightly.mjs, do not hand-edit.`,
    );
  }

  // Check 3: declared basedOnHistory timestamp must exist and agree.
  if (summary.basedOnHistory) {
    const cited = history.find((h) => h.timestamp === summary.basedOnHistory);
    if (!cited) {
      note(`equivalence-report.json summary.basedOnHistory="${summary.basedOnHistory}" is not a timestamp in equivalence-history.csv.`);
    } else if (!sameTotals(cited, summary)) {
      note(
        `equivalence-report.json summary.basedOnHistory="${summary.basedOnHistory}" row (${fmt(cited)}) ` +
        `disagrees with the report summary (${fmt(summary)}).`,
      );
    }
  }

  // Check 4: tier1-parity manifest cites the report consistently.
  if (existsSync(MANIFEST_FILE)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
    const cite = manifest.basedOnEquivalence;
    if (cite && typeof cite === 'object') {
      const cited = {
        total: cite.total,
        equivalent: cite.equivalent,
        divergent: cite.divergent,
      };
      if (!sameTotals(cited, summary)) {
        note(
          `corpus/tier1-parity/manifest.json basedOnEquivalence (${fmt(cited)}) ` +
          `disagrees with equivalence-report.json summary (${fmt(summary)}).`,
        );
      }
      if (cite.history && summary.basedOnHistory && cite.history !== summary.basedOnHistory) {
        note(
          `corpus/tier1-parity/manifest.json basedOnEquivalence.history="${cite.history}" ` +
          `disagrees with equivalence-report.json summary.basedOnHistory="${summary.basedOnHistory}".`,
        );
      }
    }
  }

  // Check 5: staleness window vs latest nightly row.
  // How many history rows are newer than the row the report is based on?
  const baseTs = summary.basedOnHistory;
  let staleBy;
  if (baseTs) {
    const idx = history.findIndex((h) => h.timestamp === baseTs);
    staleBy = idx === -1 ? history.length : history.length - 1 - idx;
  } else {
    // Fall back to the last index whose totals match the report.
    let lastMatch = -1;
    for (let i = 0; i < history.length; i++) if (sameTotals(history[i], summary)) lastMatch = i;
    staleBy = lastMatch === -1 ? history.length : history.length - 1 - lastMatch;
  }
  const staleMsg =
    `equivalence-report.json reflects a nightly run ${staleBy} row(s) behind the latest ` +
    `(report ${fmt(summary)} vs latest ${latest.timestamp} ${fmt(latest)}; allowed staleness ${opts.maxStaleRows} row(s)). ` +
    `Regenerate the snapshot from scripts/equivalence-nightly.mjs and refresh summary.basedOnHistory + the tier1-parity manifest.`;
  if (staleBy > opts.maxStaleRows) {
    if (opts.requireFresh) {
      note(staleMsg);
    } else if (!opts.json) {
      console.error(`::notice::${staleMsg}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      reportSummary: { total: summary.total, equivalent: summary.equivalent, divergent: summary.divergent, basedOnHistory: summary.basedOnHistory || null },
      latestHistory: latest,
      staleBy,
      maxStaleRows: opts.maxStaleRows,
      requireFresh: opts.requireFresh,
      errors,
    }, null, 2));
  }

  if (errors.length) {
    if (!opts.json) for (const e of errors) console.error(`::error::${e}`);
    console.error(`\nequivalence freshness check FAILED with ${errors.length} issue(s).`);
    process.exit(1);
  }

  console.log(
    `equivalence freshness OK: report ${fmt(summary)} ` +
    `(basedOnHistory=${summary.basedOnHistory || 'n/a'}) is internally consistent, matches a real ` +
    `equivalence-history.csv row, and agrees with the tier1-parity manifest. ` +
    (opts.requireFresh
      ? `Snapshot is within the freshness window (${staleBy} <= ${opts.maxStaleRows} row(s) behind latest).`
      : `Snapshot is ${staleBy} row(s) behind the latest nightly (informational; --require-fresh to gate on it).`),
  );
}

main();
