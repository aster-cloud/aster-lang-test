#!/usr/bin/env node
/**
 * ADR 0059 P0-T0.3 实测（spike，不合并）：值形态与输入约定盘点。
 *
 * 对 tier1-parity manifest 中每个有 golden 的样本的每个 case：
 *   - ts：compile（按样本词法表 / 词汇）→ readCoreIr → evaluate（maxSteps 不限，与 CLI 相同）
 *         → JSON.parse(serializeGuestValue(value))
 *   - aster-api：POST /api/v1/policies/evaluate-json，policy = 同一份 IR（目标函数加 @entry，
 *         因为该端点不接收函数名，多 Rule 模块无 @entry 时报 ambiguous），context 分别用
 *         ①位置数组 ②按形参名的对象，取响应 result
 *   - 比较两侧 JSON 树（含对象键序），并尝试 canonicalJson(树)（空 TypeContext）
 *
 * 用法：node scripts/spike-value-forms.mjs --api http://localhost:18959 --out <report.json>
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexiconOf, loadTsLexicons, selectTsLexicon } from './lib/sample-lexicon.mjs';
import { normalizeEntries, vocabPathOf, casesPathOf } from './lib/vocab-corpus.mjs';
import { entryForCase, expectsError } from './lib/eval-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const API = opt('--api', 'http://localhost:18959');
const OUT = opt('--out', join(ROOT, 'spike-value-forms-report.json'));

const { compile } = await import(join(TS_REPO, 'dist/src/browser.js'));
const { readCoreIr } = await import(join(TS_REPO, 'dist/src/core/read-core-ir.js'));
const { evaluate, serializeGuestValue } = await import(join(TS_REPO, 'dist/src/core/interpreter.js'));
const { canonicalJson } = await import(join(TS_REPO, 'dist/src/core/canonical-json.js'));
const lexicons = await loadTsLexicons(TS_REPO);

const manifest = JSON.parse(readFileSync(join(CORPUS, 'tier1-parity', 'manifest.json'), 'utf8'));
const { entries } = normalizeEntries(manifest.samples, 'samples');

/** 运行时值类别（ts 侧，按 JS 形态归类） */
function categoryOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return 'Long(bigint)';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Double';
  if (typeof v === 'string') return 'Text';
  if (typeof v === 'boolean') return 'Bool';
  if (Array.isArray(v)) return 'List';
  const ctor = v?.constructor?.name;
  if (ctor === 'Decimal' || (typeof v.toFixed === 'function' && typeof v.isFinite === 'function')) return 'Decimal';
  if (ctor === 'GuestMap') return 'Map';
  if (typeof v === 'object') {
    if ('_type' in v || '__type' in v || 'type' in v && 'value' in v) return `Object(${Object.keys(v).slice(0, 3).join(',')})`;
    return `Struct(${ctor})`;
  }
  return typeof v;
}

/** 给目标 Func 加 @entry，供 /evaluate-json 选入口 */
function withEntryAnnotation(coreJson, entry) {
  const tree = JSON.parse(coreJson);
  for (const d of tree.decls) {
    if (d.kind === 'Func' && d.name === entry && !d.annotations.some((a) => a.name === 'entry')) {
      d.annotations = [...d.annotations, { name: 'entry', args: [] }];
    }
  }
  return JSON.stringify(tree);
}

async function callApi(policy, context) {
  const res = await fetch(`${API}/api/v1/policies/evaluate-json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'p0', 'X-User-Role': 'ADMIN', 'X-User-Id': 'p0' },
    body: JSON.stringify({ policy, context }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  // 原文中 result 段（保留 Jackson 键序与数字写法）
  return { status: res.status, ok: res.status === 200 && body.error == null, result: body.result, error: body.error ?? null, code: body.code ?? null, rawText: text };
}

/** 取响应原文里 "result": 之后的值原文（顶层键），用于比较数字写法 */
function rawResultOf(text) {
  const i = text.indexOf('"result":');
  if (i < 0) return null;
  let j = i + 9, depth = 0, inStr = false;
  const start = j;
  for (; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return text.slice(start, j);
}

const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rows = [];
for (const { rel, vocab } of entries) {
  const abs = join(CORPUS, rel);
  const base = abs.split('/').pop().replace(/\.aster$/, '');
  const vocabPath = vocab ? vocabPathOf(abs) : null;
  const casesPath = vocabPath ? casesPathOf(abs) : join(CORPUS, 'tier1-equivalence', 'inputs', `${base}.cases.json`);
  if (!existsSync(casesPath)) continue;
  const doc = JSON.parse(readFileSync(casesPath, 'utf8'));
  if (!doc.entry || !Array.isArray(doc.cases)) continue;
  const lexObj = selectTsLexicon(lexicons, lexiconOf(abs), rel);
  const vocabulary = vocabPath ? JSON.parse(readFileSync(vocabPath, 'utf8')) : undefined;
  const compiled = compile(readFileSync(abs, 'utf8'), { ...(lexObj ? { lexicon: lexObj } : {}), ...(vocabulary ? { vocabulary } : {}) });
  if (!compiled.success) { rows.push({ rel, verdict: 'ts-compile-failed' }); continue; }
  const core = readCoreIr(compiled.coreJson);
  for (let ci = 0; ci < doc.cases.length; ci++) {
    const c = doc.cases[ci];
    const entry = entryForCase(doc, c);
    const fn = core.decls.find((d) => d.kind === 'Func' && d.name === entry);
    const input = Array.isArray(c.input) ? c.input : [];
    const row = { rel, case: ci, entry, expectError: expectsError(c), arity: fn ? fn.params.length : null };
    if (!fn || fn.params.length !== input.length) { row.verdict = 'skip-arity'; rows.push(row); continue; }
    const named = Object.fromEntries(fn.params.map((p, i) => [p.name, input[i]]));
    const t = evaluate(core, entry, structuredClone(named), { maxSteps: Number.MAX_SAFE_INTEGER });
    row.tsOk = t.success;
    let tsTree;
    if (t.success) {
      row.category = categoryOf(t.value);
      tsTree = JSON.parse(serializeGuestValue(t.value));
      row.tsText = serializeGuestValue(t.value);
    } else row.tsError = t.error;
    const policy = withEntryAnnotation(compiled.coreJson, entry);
    const pos = await callApi(policy, input);
    const nam = await callApi(policy, named);
    row.apiPosOk = pos.ok; row.apiNamedOk = nam.ok;
    row.apiPosStatus = pos.status; row.apiNamedStatus = nam.status;
    if (!pos.ok) row.apiPosError = `${pos.code}: ${String(pos.error).slice(0, 160)}`;
    if (!nam.ok) row.apiNamedError = `${nam.code}: ${String(nam.error).slice(0, 160)}`;
    row.apiText = pos.ok ? rawResultOf(pos.rawText) : null;
    row.namedEqualsPositional = pos.ok === nam.ok && (!pos.ok || sameTree(pos.result, nam.result));
    if (t.success && pos.ok) {
      row.treeEqual = sameTree(tsTree, pos.result);
      row.textEqual = row.tsText === row.apiText;
      try { canonicalJson(pos.result); row.canonicalOk = true; } catch (e) { row.canonicalOk = false; row.canonicalError = e.reason || e.message; }
    }
    if (!('expectedOutput' in c)) row.expectedMatchesApi = null;
    else row.expectedMatchesApi = pos.ok && sameTree(c.expectedOutput, pos.result);
    row.verdict = row.expectError
      ? (!t.success && !pos.ok ? 'both-failed-as-expected' : 'error-case-mismatch')
      : (t.success && pos.ok ? (row.treeEqual ? 'tree-identical' : 'tree-differs') : (t.success === pos.ok ? 'both-failed' : 'one-side-failed'));
    rows.push(row);
  }
}

const count = (f) => rows.filter(f).length;
const byCat = {};
for (const r of rows.filter((r) => r.category)) {
  const k = r.category;
  byCat[k] ??= { cases: 0, treeIdentical: 0, textIdentical: 0, canonicalOk: 0, example: null, diffExample: null };
  const b = byCat[k];
  b.cases++;
  if (r.treeEqual) b.treeIdentical++;
  if (r.textEqual) b.textIdentical++;
  if (r.canonicalOk) b.canonicalOk++;
  b.example ??= { rel: r.rel, ts: r.tsText?.slice(0, 200), api: r.apiText?.slice(0, 200) };
  if (r.treeEqual === false || r.textEqual === false) b.diffExample ??= { rel: r.rel, case: r.case, ts: r.tsText?.slice(0, 300), api: r.apiText?.slice(0, 300) };
}
const summary = {
  cases: rows.length,
  verdicts: Object.fromEntries([...new Set(rows.map((r) => r.verdict))].map((v) => [v, count((r) => r.verdict === v)])),
  namedEqualsPositional: count((r) => r.namedEqualsPositional),
  namedNotEqualPositional: rows.filter((r) => r.namedEqualsPositional === false).map((r) => ({ rel: r.rel, case: r.case, pos: r.apiPosError ?? 'ok', named: r.apiNamedError ?? 'ok' })),
  canonicalFailed: rows.filter((r) => r.canonicalOk === false).map((r) => ({ rel: r.rel, case: r.case, reason: r.canonicalError, api: r.apiText?.slice(0, 120) })),
  byCategory: byCat,
};
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
