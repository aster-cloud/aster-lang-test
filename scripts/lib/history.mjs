/**
 * Shared trend-history CSV writer with per-day upsert.
 *
 * The equivalence dashboard charts at most one bar group per day. If a metric
 * runs more than once on the same UTC day (nightly cron + a manual dispatch, or
 * a re-run after a fix), only the *last* run should count for that day. Rather
 * than rely solely on the dashboard's client-side dedupe, we keep the CSV itself
 * one-row-per-day: `upsertDailyHistory` drops any existing rows whose timestamp
 * falls on the same UTC day as the new row before appending it.
 *
 * Row schema is caller-defined (the first column must be the ISO `timestamp`),
 * so this works for both the parity CSVs (timestamp,total,identical,divergent,
 * rate) and the coverage CSVs (timestamp,total,value,rate).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {string} file    path to the CSV
 * @param {string} header  header line without trailing newline (e.g. "timestamp,total,value,rate")
 * @param {string} row     the new data row without trailing newline; its first
 *                         comma-separated field must be the ISO timestamp
 */
export function upsertDailyHistory(file, header, row) {
  const newDay = row.split(',', 1)[0].slice(0, 10); // YYYY-MM-DD (UTC)

  /** @type {string[]} */
  let dataRows = [];
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    // Drop the header (first line) and any row on the same UTC day as the new one.
    dataRows = lines
      .slice(1)
      .filter((l) => l.split(',', 1)[0].slice(0, 10) !== newDay);
  }
  dataRows.push(row);

  writeFileSync(file, header + '\n' + dataRows.join('\n') + '\n');
}
