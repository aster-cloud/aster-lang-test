#!/usr/bin/env node
/**
 * ADR 0059 P0-T0.4 实测（spike，不合并）：给定 aliasSet / 词汇时 ts 与 aster-api 生产编译路径的 IR 字节 parity。
 *
 * Java 侧：scripts/spike-java/ApiCompileHarness.java（aster-api PolicyCompiler 同一序列，classpath 取本地
 *   aster-api quarkus-app 的 lib/main + app jar，文件路径经 --cp-file 给出）。
 * ts 侧：compile(src, { lexicon: base 叠加 aliasSet（按 kind 合并去重，同 AliasOverlayLexicon）, vocabulary }).coreJson。
 *
 * 样本集：
 *   control  — tier1-parity manifest 全部样本（含词汇样本），无 aliasSet
 *   alias-*  — 同一批 en-US / zh-CN / de-DE 样本按固定规则把关键词改写成别名拼写，并给出对应 aliasSet
 *   handmade — 手写的 alias + 词汇组合
 *
 * 用法：node scripts/spike-alias-parity.mjs --cp-file <cp.txt> --out <report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexiconOf } from './lib/sample-lexicon.mjs';
import { normalizeEntries, vocabPathOf } from './lib/vocab-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CP = readFileSync(opt('--cp-file'), 'utf8').trim();
const OUT = opt('--out', join(ROOT, 'spike-alias-parity-report.json'));

const { compile } = await import(join(TS_REPO, 'dist/src/browser.js'));
const lexMod = await import(join(TS_REPO, 'dist/src/config/lexicons/index.js'));
lexMod.initializeAllBundledLexicons();

/** 与 aster-api AliasOverlayLexicon.wrap 同语义：base 别名在前，用户别名按 kind 追加去重 */
function overlay(base, aliasSet) {
  if (!aliasSet || Object.keys(aliasSet).length === 0) return base;
  const merged = {};
  for (const [k, v] of Object.entries(base.aliases ?? {})) merged[k] = [...v];
  for (const [k, v] of Object.entries(aliasSet)) {
    merged[k] ??= [];
    for (const a of v) if (a && a.trim() && !merged[k].includes(a)) merged[k].push(a);
  }
  return { ...base, aliases: merged };
}

/** 关键词改写规则：[语义 kind, 规范拼写的正则, 别名拼写, 是否结构性] */
const REWRITES = {
  'en-US': [
    ['TIMES', /\btimes\b/g, 'multiplied by', false],
    ['RETURN', /\bReturn\b/g, 'the answer is', true],
    ['IF', /\bIf\b/g, 'in the case that', true],
  ],
  'zh-CN': [
    ['RETURN', /返回/g, '给出 结果', true],
    ['IF', /如果/g, '假如 说', true],
  ],
  'de-DE': [
    ['RETURN', /gib zurueck/g, 'liefere zurueck', true],
    ['IF', /\bwenn\b/g, 'im falle', true],
  ],
};

const manifest = JSON.parse(readFileSync(join(CORPUS, 'tier1-parity', 'manifest.json'), 'utf8'));
const { entries } = normalizeEntries(manifest.samples, 'samples');
const reqs = [];
for (const { rel, vocab } of entries) {
  const abs = join(CORPUS, rel);
  const source = readFileSync(abs, 'utf8');
  const locale = lexiconOf(abs);
  const vocabulary = vocab ? JSON.parse(readFileSync(vocabPathOf(abs), 'utf8')) : null;
  reqs.push({ id: `control:${rel}`, group: vocab ? 'control-vocab' : 'control', source, locale, aliasSet: null, vocabulary, allowStructural: false });
  const rules = REWRITES[locale];
  if (!rules) continue;
  let rewritten = source;
  const aliasSet = {};
  let structural = false;
  for (const [kind, re, alias, isStructural] of rules) {
    if (re.test(rewritten)) {
      re.lastIndex = 0;
      rewritten = rewritten.replace(re, alias);
      aliasSet[kind] = [alias];
      structural ||= isStructural;
    }
    re.lastIndex = 0;
  }
  if (Object.keys(aliasSet).length > 0) {
    reqs.push({ id: `alias:${rel}`, group: vocab ? 'alias-vocab' : `alias-${locale}`, source: rewritten, locale, aliasSet, vocabulary, allowStructural: structural });
  }
}
// 手写：别名与规范拼写混用、非结构别名不带 allowStructural
reqs.push({
  id: 'handmade:operator-alias-no-structural', group: 'handmade', locale: 'en-US', allowStructural: false, vocabulary: null,
  aliasSet: { TIMES: ['multiplied by'], DIVIDED_BY: ['split by'] },
  source: 'Module M.\n\nRule p given amount as Int, produce Int:\n  Return (amount multiplied by 3) split by 2.\n',
});
reqs.push({
  id: 'handmade:mixed-alias-and-canonical', group: 'handmade', locale: 'en-US', allowStructural: true, vocabulary: null,
  aliasSet: { RETURN: ['the answer is'], IF: ['in the case that'] },
  source: 'Module M.\n\nRule p given x as Int, produce Int:\n  in the case that x greater than 3\n    Return x.\n  the answer is 0.\n',
});

// Java 侧一次进程跑完全部请求
const javaProc = spawnSync('java', ['-cp', CP, join(ROOT, 'scripts/spike-java/ApiCompileHarness.java')], {
  input: reqs.map((r) => JSON.stringify({ id: r.id, source: r.source, locale: r.locale, aliasSet: r.aliasSet, vocabulary: r.vocabulary, allowStructural: r.allowStructural })).join('\n') + '\n',
  encoding: 'utf8', maxBuffer: 1 << 30,
});
const javaById = new Map();
for (const line of javaProc.stdout.split('\n')) {
  if (!line.startsWith('{')) continue;
  const o = JSON.parse(line);
  javaById.set(o.id, o);
}

const rows = [];
for (const r of reqs) {
  const j = javaById.get(r.id) ?? { ok: false, error: 'no java output' };
  const base = lexMod.LexiconRegistry.get(r.locale);
  let t;
  try {
    const c = compile(r.source, { lexicon: overlay(base, r.aliasSet), ...(r.vocabulary ? { vocabulary: r.vocabulary } : {}) });
    t = c.success
      ? { ok: true, sha256: createHash('sha256').update(c.coreJson).digest('hex'), coreJson: c.coreJson }
      : { ok: false, error: JSON.stringify([...(c.parseErrors ?? []), ...(c.loweringDiagnostics ?? []), ...(c.resolutionDiagnostics ?? [])].map((d) => d.code ?? d.message)).slice(0, 200) };
  } catch (e) {
    t = { ok: false, error: `throw: ${e.message}` };
  }
  let verdict;
  // 与 aster-lang-test ir --full 门同口径：去掉 origin.*.col 后再比（该门已知 col 两侧不同）
  const noCol = (x) => x.replace(/"col":\d+,/g, '');
  if (t.ok && j.ok) verdict = t.sha256 === j.sha256 ? 'identical' : (noCol(t.coreJson) === noCol(j.coreJson) ? 'differs-only-in-origin-col' : 'bytes-differ');
  else if (!t.ok && !j.ok) verdict = 'both-failed';
  else verdict = t.ok ? 'java-failed' : 'ts-failed';
  const row = { id: r.id, group: r.group, locale: r.locale, aliasSet: r.aliasSet, verdict, tsError: t.error, javaError: j.error };
  if (verdict === 'bytes-differ' || verdict === 'differs-only-in-origin-col') {
    row.colDiffs = (() => { const a = t.coreJson.match(/"origin":\{[^}]*\}[^}]*\}[^}]*\}/g) ?? []; const b = j.coreJson.match(/"origin":\{[^}]*\}[^}]*\}[^}]*\}/g) ?? []; return a.filter((x, i) => x !== b[i]).length; })();
    let k = 0;
    while (k < t.coreJson.length && t.coreJson[k] === j.coreJson[k]) k++;
    row.firstDiff = { at: k, ts: t.coreJson.slice(Math.max(0, k - 80), k + 80), java: j.coreJson.slice(Math.max(0, k - 80), k + 80) };
  }
  rows.push(row);
}
const summary = {};
for (const r of rows) {
  summary[r.group] ??= {};
  summary[r.group][r.verdict] = (summary[r.group][r.verdict] ?? 0) + 1;
}
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const r of rows.filter((x) => x.verdict !== 'identical' && x.verdict !== 'differs-only-in-origin-col')) console.log(r.verdict, r.id, r.tsError ?? '', '|', (r.javaError ?? '').slice(0, 160));
