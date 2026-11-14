#!/usr/bin/env node
/**
 * tier1-parity gate.
 *
 * Reads `corpus/tier1-parity/manifest.json` — the explicit, reviewed list
 * of samples both engines must accept — and runs each through TS + Java.
 * The manifest's `mustReject` list (samples under `corpus/tier1-reject/`) is
 * the inverse contract: parse mode passes them only when BOTH engines report a
 * parse error (optionally on `meta.expectErrorLine`); a one-sided acceptance or
 * a crash fails the gate. They are parse-only — skipped by ir/eval modes.
 *
 * Intentional contrast with `equivalence-nightly.mjs`:
 *   - that script walks ALL tier1 + tier2 and tracks a *rate*, regressing
 *     only when the rate drops vs. baseline. It's an observation tool.
 *   - this script walks the explicit allow-list and is strict: every
 *     sample must pass both engines, no exceptions.
 *
 * Modes (mirrors the planned phase progression):
 *   --mode=parse  (Phase A, default, PR-blocking) — parse both engines,
 *                 compare ok/fail
 *   --mode=ir     (Phase B) — compare a structural fingerprint of each side's
 *                 lowered Core IR: { moduleName, declCount, declKinds, declNames }.
 *   --mode=ir --full (ADR 0055 §6, PR-blocking) — byte-level Core IR v2 parity:
 *                 both sides' canonical bytes must be schema-valid; after
 *                 dropping origin.*.col and masking the registered value-layer
 *                 exemptions (VALUE_EXEMPTIONS, V1–V4) they must be byte-identical.
 *                 Verdicts: identical / schema-invalid / shape-diff / value-diff /
 *                 ts-failed / java-failed, plus stale-exemption / expired-exemption
 *                 for the exemption table. See scripts/lib/ir-byte-parity.mjs.
 *   --mode=eval   (Phase C, report-only initially) — for every sample
 *                 with a sibling .cases.json, evaluate each case on both
 *                 engines and compare the result against expectedOutput
 *                 AND against the other engine's result.
 *
 * Flags:
 *   --report-only  — write the report and exit 0 even on divergence.
 *   --today=YYYY-MM-DD — (ir --full) run date for exemption expiry checks.
 *   --dump-dir=<dir>   — (ir --full) write each side's canonical bytes to
 *                        <dir>/<rel>.{ts,java}.json for reproduction.
 *
 * Exit codes:
 *   0  — clean (or --report-only)
 *   1  — divergence detected (in strict mode)
 *   2  — infra failure
 *
 * Output:
 *   stdout — human markdown summary
 *   parity-tier1-report.json — machine-readable detail (per-sample verdict)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { upsertDailyHistory } from './lib/history.mjs';
import {
  IR_VERDICTS, EXEMPTION_CATEGORIES, createExemptionLedger, judgeSample, exemptionFindings, maskedCounts, narrowableScopes,
} from './lib/ir-byte-parity.mjs';
import { inputRefsProblems } from './lib/input-refs-expect.mjs';
import { collectEvalCaseProblem, entryForCase, expectsError } from './lib/eval-cases.mjs';
import { inventoryOutputProblem, parseInventoryOutput, judgeSamples } from './lib/java-inventory.mjs';
import { MUST_REJECT_DIR, judgeMustReject, javaRejection, checkMustRejectManifest } from './lib/must-reject.mjs';
import {
  VOCAB_SUFFIX, VOCAB_SAMPLE_DIR, vocabPathOf, casesPathOf, normalizeEntries, checkVocabCorpus, judgeVocabSample, judgeVocabReject, compareLinesOf,
} from './lib/vocab-corpus.mjs';

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
const REPORT_ONLY = args.includes('--report-only');
// --full（仅 mode=ir）：逐字节比较两引擎的 Core IR v2 规范字节（ADR 0055 §6），取代声明级指纹。
const IR_FULL = args.includes('--full');
// --history=<file>: 追加一行趋势 CSV（供 nightly 写 eval-history.csv / parse-history.csv）。
const historyArg = args.find((a) => a.startsWith('--history='));
const HISTORY_FILE = historyArg ? resolve(historyArg.slice('--history='.length)) : null;

/**
 * 追加趋势历史行。表头与 equivalence-history.csv 对齐（identical 列名取代 equivalent，
 * 因为 eval 的"一致"含义是 identical），首次写入时带表头。
 */
function appendHistory(mode, total, identical, divergent) {
  if (!HISTORY_FILE) return;
  const rate = total === 0 ? 0 : identical / total;
  const ts = new Date().toISOString();
  // Per-day upsert: at most one row per UTC day (last run of the day wins).
  upsertDailyHistory(
    HISTORY_FILE,
    'timestamp,total,identical,divergent,rate',
    `${ts},${total},${identical},${divergent},${rate.toFixed(4)}`,
  );
  console.error(`[parity-tier1] recorded ${mode} history → ${HISTORY_FILE} (${identical}/${total})`);
}

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
  // 条目为路径字符串或 { path, vocab: true }（ADR 0051 语料自带词汇，见 lib/vocab-corpus.mjs）
  const samples = normalizeEntries(manifest.samples, 'samples');
  const mustReject = normalizeEntries(manifest.mustReject, 'mustReject');
  const problems = [...samples.problems, ...mustReject.problems];
  if (problems.length > 0) fail(`manifest entries are malformed:\n  - ${problems.join('\n  - ')}`);
  return { raw: manifest, samples: samples.entries, mustReject: mustReject.entries };
}

const relsOf = (entries) => entries.map((e) => e.rel);

function resolveSamples(entries) {
  const out = [];
  const missing = [];
  for (const { rel, vocab } of entries) {
    const abs = join(CORPUS, rel);
    if (existsSync(abs)) {
      out.push({ rel, abs, vocabPath: vocab ? vocabPathOf(abs) : null });
    } else {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail(`manifest references ${missing.length} missing sample(s):\n  - ${missing.join('\n  - ')}`);
  }
  return out;
}

/**
 * 守卫一：tier1 policies 下的每个 .aster 都必须在 manifest 中。
 *
 * ★为什么需要：三个严格门（parse/IR/eval）都只遍历 manifest。样本不在 manifest 里
 * 就是**全部跳过**，而不是失败——于是「为某个真实跨引擎缺陷写的守门用例」可以
 * 从未生效而 CI 全绿。实测发现 struct_list_equality 正是如此：policies 有 223 个
 * .aster，manifest 只有 222 条，唯一缺席的就是它（PR #90 的提交信息明言它是
 * 「TS === 引用相等 vs Java Objects.equals 结构相等」那条修复的守门）。
 *
 * 豁免用 EXEMPT_FROM_MANIFEST 显式列出并写明理由——必须是显式的，
 * 「悄悄不在 manifest 里」正是本守卫要消灭的状态。
 */
const EXEMPT_FROM_MANIFEST = new Set([
  // 目前无豁免。新增豁免必须在此写明理由。
]);

function assertAllPoliciesInManifest(manifest) {
  const dir = join(CORPUS, 'tier1-equivalence', 'policies');
  if (!existsSync(dir)) return;
  const onDisk = readdirSync(dir).filter((f) => f.endsWith('.aster'));
  const inManifest = new Set(
    relsOf(manifest.samples).map((rel) => basename(rel).replace(/\.aster$/, '')),
  );
  const orphans = onDisk
    .map((f) => f.replace(/\.aster$/, ''))
    .filter((name) => !inManifest.has(name) && !EXEMPT_FROM_MANIFEST.has(name))
    .sort();
  if (orphans.length > 0) {
    fail(
      `${orphans.length} tier1 policy sample(s) are not in manifest — ` +
        `all three gates SKIP them silently:\n  - ${orphans.join('\n  - ')}\n` +
        `Add them to corpus/tier1-parity/manifest.json, ` +
        `or list them in EXEMPT_FROM_MANIFEST with a reason.`,
    );
  }
}

/**
 * 守卫二：inputs 下的每个 .cases.json 都必须能被某个 manifest 样本加载到。
 *
 * ★为什么需要：eval 门查 golden 用的是**精确文件名** `${base}.cases.json`
 * （base = .aster 去后缀）。命名成 `<样本>_<规则>.cases.json` 的文件永远匹配不上，
 * 于是那些期望**从未被执行**。更糟的是 coverage-report.py 用前缀 glob
 * `{name}*.cases.json` 把它们计入「已执行」——**度量说已覆盖、门禁实际没跑**，
 * 这批规则若在任一引擎回归，CI 依然全绿。
 *
 * 实测（修复前）：206 个 cases 文件里 57 个是孤儿，712 条 case 里 60 条死置。
 * 正确做法是用 case 级 `entry` 覆盖合并进基文件（lib/eval-cases.mjs 已支持），
 * 而不是另起文件名。
 */
function assertNoOrphanCaseFiles(manifest) {
  const dir = join(CORPUS, 'tier1-equivalence', 'inputs');
  if (!existsSync(dir)) return;
  const loadable = new Set(
    relsOf(manifest.samples).map((rel) => basename(rel).replace(/\.aster$/, '')),
  );
  const orphans = readdirSync(dir)
    .filter((f) => f.endsWith('.cases.json'))
    .filter((f) => !loadable.has(f.replace(/\.cases\.json$/, '')))
    .sort();
  if (orphans.length > 0) {
    fail(
      `${orphans.length} .cases.json file(s) can never be loaded by any manifest sample ` +
        `(eval gate matches the exact filename \`<sample>.cases.json\`):\n  - ${orphans.join('\n  - ')}\n` +
        `Merge them into the base file using per-case \`entry\` overrides ` +
        `(see scripts/lib/eval-cases.mjs), then delete the orphan file.`,
    );
  }
}

/**
 * 守卫三：must-reject 清单与 tier1-reject/ 目录、样本 meta 一致（判定见 lib/must-reject.mjs）。
 * 与守卫一同理：目录里有样本却不在清单中，parse 门就会静默跳过它。
 */
function assertMustRejectManifest(manifest) {
  const dir = join(CORPUS, MUST_REJECT_DIR);
  const onDisk = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.aster')).map((f) => `${MUST_REJECT_DIR}/${f}`)
    : [];
  const problems = checkMustRejectManifest({
    mustReject: relsOf(manifest.mustReject),
    samples: relsOf(manifest.samples),
    onDisk,
    metaOf: (rel) => readMeta(join(CORPUS, rel)),
  });
  if (problems.length > 0) {
    fail(`manifest.mustReject is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

/** 递归列出 corpus/<dir> 下以 suffix 结尾的文件（相对 corpus/）。 */
function listCorpusFiles(dir, suffix) {
  const root = join(CORPUS, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(suffix))
    .map((f) => `${dir}/${f.split('\\').join('/')}`)
    .sort();
}

/**
 * 守卫四：语料自带词汇（ADR 0051 §8）。词汇文件必须被某个 `vocab: true` 条目认领，
 * `vocab: true` 条目必须有词汇文件，tier1-parity/ 下的样本必须登记，带词汇的必拒样本须声明 expectCode。
 * 与守卫一同理：没被认领的词汇文件意味着引擎从未见过它，门禁却照样全绿。
 */
function assertVocabCorpus(manifest) {
  const problems = checkVocabCorpus({
    samples: manifest.samples,
    mustReject: manifest.mustReject,
    vocabOnDisk: [
      ...listCorpusFiles('tier1-equivalence', VOCAB_SUFFIX),
      ...listCorpusFiles(VOCAB_SAMPLE_DIR, VOCAB_SUFFIX),
      ...listCorpusFiles(MUST_REJECT_DIR, VOCAB_SUFFIX),
    ],
    parityAsterOnDisk: listCorpusFiles(VOCAB_SAMPLE_DIR, '.aster'),
    parityCasesOnDisk: listCorpusFiles(VOCAB_SAMPLE_DIR, '.cases.json'),
    metaOf: (rel) => readMeta(join(CORPUS, rel)),
  });
  if (problems.length > 0) {
    fail(`vocabulary-carrying corpus is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

/** 读取样本的词汇（DomainVocabulary JSON）；无词汇样本返回 undefined。 */
function readVocab(sample) {
  return sample.vocabPath ? JSON.parse(readFileSync(sample.vocabPath, 'utf8')) : undefined;
}

function readMeta(abs) {
  const metaPath = abs.replace(/\.aster$/, '.meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

// 加载 TS 侧的词法表对象（en-US 用 undefined 走默认路径，保持既有行为逐字节不变）。
async function loadTsLexicons(mod) {
  const out = {};
  const specs = [
    ['zh-CN', 'config/lexicons/zh-CN.js', 'ZH_CN'],
    ['de-DE', 'config/lexicons/de-DE.js', 'DE_DE'],
    ['hi-IN', 'config/lexicons/hi-IN.js', 'HI_IN'],
  ];
  for (const [name, rel, exportName] of specs) {
    try {
      const m = await import(join(TS_REPO, 'dist', 'src', rel));
      if (m[exportName]) out[name] = m[exportName];
    } catch {
      // 该词法表在当前构建中不可用；只有样本真的声明它时才会 fail（见调用处）
    }
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

  // ★按样本声明的词法表驱动（2026-08-17 审计）：此前 runner 从不读 meta.lexicon，
  //   一律按默认英语处理，导致非英语词法表在双引擎 parity 上零覆盖。
  const lexicons = await loadTsLexicons(mod);

  const results = {};
  for (const { rel, abs } of samples) {
    const lexName = lexiconOf(abs);
    const lexObj = lexicons[lexName];
    if (!lexObj && lexName !== 'en-US') {
      fail(`sample ${rel} declares lexicon "${lexName}" but it could not be loaded from aster-lang-ts`);
    }
    results[rel] = tsParseOne(mod, readFileSync(abs, 'utf8'), lexObj);
  }
  return results;
}

/**
 * 单个样本的 TS 解析结果 { ok, err, line, crash }。
 * 错误诊断与 DiagnosticError 都是「解析错误」（带行号）；其余异常是崩溃，
 * must-reject 门不把崩溃当成拒绝。
 */
function tsParseOne({ canonicalize, lex, parse, parseWithLexicon }, src, lexObj) {
  try {
    const canonical = lexObj ? canonicalize(src, lexObj) : canonicalize(src);
    const tokens = lexObj ? lex(canonical, lexObj) : lex(canonical);
    const { ast, diagnostics } = lexObj && parseWithLexicon
      ? parseWithLexicon(tokens, lexObj)
      : parse(tokens);
    const diag = (diagnostics || []).find((d) => d.severity === 'error');
    if (diag) return { ok: false, err: diag.message, line: diag.span?.start?.line ?? null, crash: false };
    if (!ast) return { ok: false, err: 'parse returned no AST', line: null, crash: true };
    return { ok: true, err: null };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    const line = e?.diagnostic?.span?.start?.line ?? null;
    return { ok: false, err, line, crash: !e?.diagnostic };
  }
}

/**
 * TS 侧经名称解析的编译（ADR 0051）：parseSource（关键词规范化 + 字面量宏）→ R1 → lower → R2，
 * 词汇（若样本自带）与样本声明的词法表同时传入。返回 { rel → 结果 }，结果形状见 tsResolveOne。
 * 只用包入口的带检查出口 resolveAndLowerChecked（原始 lowerModule 不是公开 API）。
 */
async function runTsResolve(samples) {
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(distIndex)) {
    fail(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  }
  const mod = await import(distIndex);
  if (!mod.parseSource || !mod.resolveAndLowerChecked || !mod.NameResolutionError || !mod.buildVocabularyScopes) {
    fail('aster-lang-ts is missing expected exports (parseSource/resolveAndLowerChecked/NameResolutionError/buildVocabularyScopes)');
  }
  const lexicons = await loadTsLexicons(mod);
  const results = {};
  for (const sample of samples) {
    results[sample.rel] = tsResolveOne(mod, readFileSync(sample.abs, 'utf8'), tsLexiconFor(lexicons, sample), readVocab(sample));
  }
  return results;
}

/** 样本声明的 TS 词法表对象；en-US 为 undefined（默认路径）。 */
function tsLexiconFor(lexicons, { rel, abs }) {
  const lexName = lexiconOf(abs);
  const lexObj = lexicons[lexName];
  if (!lexObj && lexName !== 'en-US') {
    fail(`sample ${rel} declares lexicon "${lexName}" but it could not be loaded from aster-lang-ts`);
  }
  return lexObj;
}

/** 诊断位置 [{ code, line, col }]；与 Java CoreIrFingerprintCli 记录里的 `locs` 同形。 */
const locsOf = (diagnostics) => diagnostics.map((d) => ({ code: d.code, line: d.span?.start?.line ?? null, col: d.span?.start?.col ?? null }));

/**
 * 单个样本经解析 + 名称解析的结果：
 *   成功 { ok: true, warnings: [码], ir }；
 *   失败 { ok: false, stage: 'syntax' | 'resolve' | 'crash', codes?: [错误码], err, crash }。
 */
function tsResolveOne({ parseSource, resolveAndLowerChecked, NameResolutionError, buildVocabularyScopes }, src, lexObj, vocab) {
  try {
    const scopes = vocab ? buildVocabularyScopes(vocab) : undefined;
    const parsed = parseSource(src, lexObj, scopes);
    const syntax = parsed.diagnostics.find((d) => d.severity === 'error');
    if (syntax) return { ok: false, stage: 'syntax', err: syntax.message, crash: false };
    const resolved = resolveAndLowerChecked(parsed.ast, scopes);
    return { ok: true, warnings: resolved.diagnostics.map((d) => d.code), locs: locsOf(resolved.diagnostics), ir: resolved.core };
  } catch (e) {
    if (e instanceof NameResolutionError) {
      return {
        ok: false, stage: 'resolve', crash: false,
        codes: e.diagnostics.map((d) => d.code),
        locs: locsOf(e.diagnostics),
        err: e.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '),
      };
    }
    const err = e && e.message ? e.message : String(e);
    return e?.diagnostic
      ? { ok: false, stage: 'syntax', err, crash: false }
      : { ok: false, stage: 'crash', err, crash: true };
  }
}

function runJavaParse(samples) {
  // 调 aster-lang-core 的 TsSampleParseInventoryTest。输出解析与逐样本判定与
  // equivalence-nightly.mjs 共用 lib/java-inventory.mjs（单一事实源，见该文件头注）。
  //
  // Stale-corpus blind spot (codex review R1): the inventory test
  // reads corpus from a Maven dependency `cloud.aster-lang:aster-lang-test`,
  // not the local checkout. A new sample added to the manifest in a
  // PR is NOT in that artifact, so the inventory test wouldn't see it
  // at all — and "not in the failure list" would silently mark it ok.
  // The CI workflow MUST publish the local corpus to Maven Local before
  // invoking gradle (see ./.github/workflows/ci.yml `Publish corpus to Maven Local`).
  const result = spawnSync(
    './gradlew',
    ['test', '--tests', 'TsSampleParseInventoryTest', '--rerun-tasks', '-i'],
    { cwd: CORE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (result.stdout || '') + (result.stderr || '');
  const problem = inventoryOutputProblem(result.status, output);
  if (problem) fail(problem);

  // ★逐样本「已观测」判定（issue #119 / #132）——取代原先的 Discovered 计数比较。
  //   Discovered 统计的是 tier1 全量 + tier2/ts-only，是 manifest 的超集，
  //   陈旧语料缺少某个新增 manifest 样本时计数照样够。这里按集合核对：
  //   manifest 里任何一个样本没出现在 OBSERVED 清单中 → 拒绝给出结论。
  const inventory = parseInventoryOutput(output);
  if (inventory.observed.size === 0) {
    fail(
      'Java inventory did not emit any "OBSERVED <path>" line.\n' +
      'Either aster-lang-core is older than the observed-list change (issue #119),\n' +
      'or the test did not actually run. Refusing to report a verdict.',
    );
  }
  const { results, unobserved } = judgeSamples(samples.map((x) => x.rel), inventory);
  if (unobserved.length > 0) {
    fail(
      `Java inventory did not observe ${unobserved.length} manifest sample(s):\n` +
      unobserved.map((r) => `  - ${r}`).join('\n') + '\n\n' +
      `This means aster-lang-core is reading a stale corpus artifact, NOT the PR's\n` +
      `aster-lang-test checkout. The CI workflow must publish the local corpus\n` +
      `(./packages/jvm -> publishToMavenLocal) before invoking core's gradle test.\n` +
      `Refusing to report a verdict — "not in the failure list" would wrongly count\n` +
      `these as passing.`,
    );
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

/** must-reject 样本逐个判定；verdict 为 'rejected' 才算通过（见 lib/must-reject.mjs）。 */
function classifyMustReject(tsRes, javaRes, rejects) {
  return rejects.map(({ rel, abs }) => {
    const ts = tsRes[rel] || { ok: false, crash: true, err: 'missing in ts result' };
    const java = javaRejection(javaRes[rel] || { ok: false, err: 'THROWN: missing in java result' });
    const expectLine = readMeta(abs)?.expectErrorLine ?? null;
    const { verdict, reason } = judgeMustReject({ ts, java, expectLine });
    return {
      path: rel, verdict, reason, expectLine,
      ts: ts.ok, tsLine: ts.line ?? null, tsErr: ts.err || null,
      java: java.ok, javaLine: java.line ?? null, javaErr: java.err || null,
    };
  });
}

/** 带词汇正例：两侧解析 + 名称解析都成功且警告码一致（见 lib/vocab-corpus.mjs）。 */
function classifyVocabSamples(tsRes, javaRes, samples) {
  return samples.map(({ rel, abs }) => {
    const ts = tsRes[rel] || { ok: false, err: 'missing in ts result' };
    const java = javaRes[rel] || { ok: false, err: 'missing in java result' };
    const meta = readMeta(abs);
    const expectWarnings = meta?.expectWarnings ?? null;
    const { verdict, reason } = judgeVocabSample({ ts, java, expectWarnings, compareLines: compareLinesOf(meta) });
    return {
      path: rel, vocab: true, ts: ts.ok, java: java.ok, verdict, reason,
      tsWarnings: ts.warnings ?? null, javaWarnings: java.warnings ?? null,
      tsErr: ts.err || null, javaErr: java.err || null,
    };
  });
}

/** 带词汇必拒样本：两侧都在名称解析阶段以同一组错误码拒绝，且包含 meta.expectCode。 */
function classifyVocabRejects(tsRes, javaRes, rejects) {
  return rejects.map(({ rel, abs }) => {
    const ts = tsRes[rel] || { ok: false, stage: 'crash', err: 'missing in ts result' };
    const java = javaRes[rel] || { ok: false, stage: 'crash', err: 'missing in java result' };
    const meta = readMeta(abs);
    const expectCode = meta?.expectCode ?? null;
    const { verdict, reason } = judgeVocabReject({ ts, java, expectCode, compareLines: compareLinesOf(meta) });
    return {
      path: rel, vocab: true, verdict, reason, expectCode,
      ts: ts.ok, tsCodes: ts.codes ?? null, tsErr: ts.err || null,
      java: java.ok, javaCodes: java.codes ?? null, javaErr: java.err || null,
    };
  });
}

function printMustReject(rows) {
  const bad = rows.filter((r) => r.verdict !== 'rejected');
  console.log(`## Must-reject samples (both engines must report a parse error)\n`);
  console.log(`- total: ${rows.length}`);
  console.log(`- rejected by both: ${rows.length - bad.length}`);
  console.log(`- failing: ${bad.length}\n`);
  if (bad.length === 0) return;
  console.log('| path | verdict | reason |');
  console.log('|------|---------|--------|');
  for (const r of bad) {
    console.log(`| ${r.path} | ${r.verdict} | ${(r.reason || '').slice(0, 120)} |`);
  }
  console.log('');
}

// ============================================================================
// Phase B: IR fingerprint mode
// ============================================================================

/**
 * Build the same structural fingerprint shape the Java side emits.
 * Operates directly on the lowered Core IR JSON object — no field-by-field
 * comparison, just the structural shape (decl count + kinds + names).
 */
function buildFingerprint(coreModule) {
  const fp = {
    moduleName: coreModule?.name || '',
    declCount: 0,
    declKinds: {},
    declNames: [],
  };
  const decls = Array.isArray(coreModule?.decls) ? coreModule.decls : [];
  fp.declCount = decls.length;
  for (const decl of decls) {
    const kind = (decl && decl.kind) || 'Unknown';
    fp.declKinds[kind] = (fp.declKinds[kind] || 0) + 1;
    if (decl && typeof decl.name === 'string') fp.declNames.push(decl.name);
  }
  fp.declNames.sort();
  // Sort kinds for stable comparison.
  fp.declKinds = Object.fromEntries(
    Object.entries(fp.declKinds).sort(([a], [b]) => a.localeCompare(b)),
  );
  return fp;
}

/**
 * Run the TS pipeline through name resolution (R1 → lower → R2) for EVERY
 * manifest sample — not only vocabulary samples — so English no-vocabulary
 * regressions in name resolution are caught by the same gate as the Java
 * side (CoreIrFingerprintCli also runs R1/R2 for every sample).
 * Returns { relPath → { ok, fingerprint? | ir?, error? } }.
 */
async function runTsIr(samples) {
  const resolved = await runTsResolve(samples);
  const analyze = IR_FULL ? await loadTsInputRefsAnalyzer() : null;
  const { serializeCoreIr } = IR_FULL ? await import(join(TS_REPO, 'dist', 'src', 'index.js')) : {};
  if (IR_FULL && !serializeCoreIr) fail('aster-lang-ts is missing serializeCoreIr (needs Core IR v2, ts ≥ 2.0.0)');
  const results = {};
  for (const { rel } of samples) {
    const r = resolved[rel];
    results[rel] = !r.ok
      ? { ok: false, error: r.err }
      : IR_FULL ? tsCanonicalOf(serializeCoreIr, r.ir, analyze) : { ok: true, fingerprint: buildFingerprint(r.ir) };
  }
  return results;
}

/** ts 侧规范字节（ADR 0055 §6 第 1 步）；序列化抛错（例如 IR 不满足规范输出前提）记为 ts 失败。 */
function tsCanonicalOf(serializeCoreIr, ir, analyze) {
  try {
    return { ok: true, bytes: serializeCoreIr(ir), ir, inputRefConstructs: tsConstructsOf(analyze, ir) };
  } catch (e) {
    return { ok: false, error: `serializeCoreIr: ${e && e.message ? e.message : String(e)}` };
  }
}

/** TS 的 analyzeInputRefs（ADR 0046 §11 D2）；旧版 aster-lang-ts 没有该模块时为 null。 */
async function loadTsInputRefsAnalyzer() {
  const p = join(TS_REPO, 'dist', 'src', 'governance', 'input-refs.js');
  if (!existsSync(p)) return null;
  return (await import(p)).analyzeInputRefs ?? null;
}

/** inputRefs 为 ["*"] 的函数 → E708 construct；与 Java CoreIrFingerprintCli 的 inputRefConstructs 同形。 */
function tsConstructsOf(analyze, ir) {
  if (!analyze) return undefined;
  const out = {};
  for (const d of ir?.decls ?? []) {
    if (d.kind === 'Func' && Array.isArray(d.inputRefs) && d.inputRefs.length === 1 && d.inputRefs[0] === '*') {
      out[d.name] = analyze(ir, d).construct;
    }
  }
  return out;
}

/**
 * Invoke aster-lang-core's CoreIrFingerprintCli test with -Dparity.ir.input
 * pointing at a temp file of absolute sample paths, and read back the
 * JSONL fingerprint output. The CLI is a JUnit test whose body short-
 * circuits to a no-op when the system properties aren't set, so it
 * coexists with normal `./gradlew test` runs without side effects.
 */
function runJavaIr(samples, { full = IR_FULL } = {}) {
  // Build the temp input/output paths. We use sample ABSOLUTE paths so
  // the Java side can read them without any corpus-resolution dance.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'parity-ir-'));
  const inputFile = join(tmpRoot, 'samples.txt');
  const outputFile = join(tmpRoot, 'java-fp.jsonl');
  // CRITICAL: the manifest sample list maps to corpus/<rel> paths in
  // the local checkout. Use those absolute paths so Java reads exactly
  // the bytes the manifest declares, with no stale-Maven dependency
  // (the same blind spot the parse mode's coverage check defends).
  // 带词汇或非 en-US 词法表的样本写成 JSON 行（路径 + 词法表 [+ 词汇文件]），CoreIrFingerprintCli 据此
  // 规范化关键词并做名称解析；只写路径时 Java 侧按 en-US 处理，与 ts 侧按 meta 驱动的词法表不一致。
  const lineOf = (s) => {
    const lexicon = lexiconOf(s.abs);
    if (!s.vocabPath && lexicon === 'en-US') return s.abs;
    return JSON.stringify({ path: s.abs, lexicon, ...(s.vocabPath ? { vocabulary: s.vocabPath } : {}) });
  };
  writeFileSync(inputFile, samples.map(lineOf).join('\n') + '\n');

  const result = spawnSync(
    './gradlew',
    [
      'test',
      '--tests',
      'CoreIrFingerprintCli',
      '--rerun-tasks',
      '-i',
      `-Dparity.ir.input=${inputFile}`,
      `-Dparity.ir.output=${outputFile}`,
      ...(full ? ['-Dparity.ir.full=true'] : []),
    ],
    { cwd: CORE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (result.stdout || '') + (result.stderr || '');

  // Gradle returns non-zero on test failure even when our test itself
  // succeeded but another test in the suite blew up. Trust the output
  // file as the source of truth — if it exists and is non-empty, the
  // CLI did its job. If gradle failed AND no output file, that's infra.
  if (!existsSync(outputFile)) {
    fail(
      'aster-lang-core CoreIrFingerprintCli produced no output. ' +
        'Gradle log tail:\n' +
        output.slice(-2000),
    );
  }

  const lines = readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
  const byAbs = new Map();
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && rec.path) byAbs.set(rec.path, rec);
    } catch {
      // Skip malformed lines; Gradle test runner output sometimes
      // interleaves stdout from other tasks. The CLI writes the
      // dedicated output file directly so this should not happen,
      // but defend anyway.
    }
  }

  const results = {};
  for (const { rel, abs } of samples) {
    const rec = byAbs.get(abs);
    if (!rec) {
      results[rel] = { ok: false, stage: 'crash', error: 'no fingerprint record for sample', err: 'no fingerprint record for sample' };
    } else if (!rec.ok) {
      const error = rec.error || 'unknown Java error';
      // stage/codes 供带词汇样本的 parse 门判定（语法错误 / 名称解析错误 / 其它异常）
      results[rel] = { ok: false, stage: rec.stage || 'crash', codes: rec.codes, locs: rec.locs, error, err: error };
    } else {
      if (full && typeof rec.irCanonical !== 'string') {
        fail('aster-lang-core CoreIrFingerprintCli --full did not emit irCanonical (needs Core IR v2, ADR 0055 §6)');
      }
      results[rel] = full
        ? { ok: true, bytes: rec.irCanonical, ir: JSON.parse(rec.irCanonical), inputRefConstructs: rec.inputRefConstructs, warnings: rec.diagnostics || [], locs: rec.locs }
        : { ok: true, fingerprint: rec.fingerprint, warnings: rec.diagnostics || [], locs: rec.locs };
    }
  }

  // Clean up the temp dir + its contents; ignore failures (CI tmpfs
  // gets wiped anyway, but local runs leak otherwise).
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  return results;
}

/**
 * Compare two fingerprint records and return a structured diff. Returns
 * empty array when identical.
 */
function diffFingerprints(tsFp, javaFp) {
  const diffs = [];
  if (!tsFp || !javaFp) {
    diffs.push({ field: 'fingerprint', reason: 'one side missing' });
    return diffs;
  }
  if (tsFp.moduleName !== javaFp.moduleName) {
    diffs.push({
      field: 'moduleName',
      ts: tsFp.moduleName,
      java: javaFp.moduleName,
    });
  }
  if (tsFp.declCount !== javaFp.declCount) {
    diffs.push({
      field: 'declCount',
      ts: tsFp.declCount,
      java: javaFp.declCount,
    });
  }
  // Kind histogram diff — list kinds present on one side but not the
  // other, plus any kinds where the counts disagree.
  const allKinds = new Set([
    ...Object.keys(tsFp.declKinds || {}),
    ...Object.keys(javaFp.declKinds || {}),
  ]);
  for (const k of allKinds) {
    const t = tsFp.declKinds?.[k] || 0;
    const j = javaFp.declKinds?.[k] || 0;
    if (t !== j) diffs.push({ field: `declKinds.${k}`, ts: t, java: j });
  }
  // Names — symmetric difference.
  const tsNames = new Set(tsFp.declNames || []);
  const javaNames = new Set(javaFp.declNames || []);
  const tsOnly = [...tsNames].filter((n) => !javaNames.has(n)).sort();
  const javaOnly = [...javaNames].filter((n) => !tsNames.has(n)).sort();
  if (tsOnly.length > 0) diffs.push({ field: 'declNames.tsOnly', value: tsOnly });
  if (javaOnly.length > 0) diffs.push({ field: 'declNames.javaOnly', value: javaOnly });
  return diffs;
}

// ============================================================================
// ADR 0055 §6 — 逐字节 Core IR parity（--mode=ir --full）
// ============================================================================
//
// 判定逻辑在 scripts/lib/ir-byte-parity.mjs（与回归测试 scripts/test-ir-byte-parity.mjs 共用）；
// 本脚本负责取两侧规范字节、装配 schema 校验，并持有值层豁免表 VALUE_EXEMPTIONS。
// 两侧唯一的全局投影是删除 origin.start.col / origin.end.col；其余每个字节都硬比较，
// 字段名、kind、字段是否出现、数组长度不同一律 shape-diff，永远不可豁免。

/**
 * 值层分期豁免表（ADR 0055 §6）。每项：
 *   id       V1 类型推断 / V2 能力推断 / V3 闭包捕获 / V4 origin 行号；
 *   issue    tracking issue；owner 为负责收紧的维护者角色；
 *   expires  截止日（最晚 2027-01-31）。运行日期晚于它，该类别失效并报 expired-exemption；
 *   V1–V3    scope 'category'：只在 files 列出的语料文件内、由 match 选中 ADR 表中的值位置；
 *   V4       scope 'entries'：逐项登记 (语料文件, JSON 路径)，只豁免该处的 origin.end.line。
 * V1–V3 整个类别、或 V4 某个登记项一轮运行中不再有被豁免的差异即报 stale-exemption，须删掉该项。
 * go-live 要求本表为空。
 */
// ── 豁免表现状（ADR 0056 实施完毕）──
// V1（类型推断）：推断返回类型统一为占位 Unknown（§3.1），未标注形参 / 字段按 locales 的同一张命名规则表推断（§3.2），
//   条目删除（aster-lang-test#195）。
// V2（能力推断）：effectCaps 只记显式能力（§4.1），条目删除（aster-lang-test#196）。
// V3（Lambda.captures）：门禁内 0 处差异，从未登记（aster-lang-test#197）。
// V4（origin 行号）：推断占位锚定 produce 关键词（§3.3 / §4.3），条目删除（aster-lang-test#198）。
// 表为空即 ADR 0055 §6 的 go-live 条件。
export const VALUE_EXEMPTIONS = Object.freeze([]);

// --today=YYYY-MM-DD：注入运行日期（测试到期判定用），默认取当前 UTC 日期。
const todayArg = args.find((a) => a.startsWith('--today='));
const TODAY = todayArg ? todayArg.slice('--today='.length) : new Date().toISOString().slice(0, 10);
// --dump-dir=<dir>：把每个样本两侧的规范字节写到 <dir>/<rel>.{ts,java}.json，供引擎维护者复现差异。
const dumpArg = args.find((a) => a.startsWith('--dump-dir='));
const DUMP_DIR = dumpArg ? resolve(dumpArg.slice('--dump-dir='.length)) : null;

/** 规范序列化与 schema + 不变式校验，均取自同级 aster-lang-ts（schema 副本与 locales 源由 ts 的 sibling parity 测试守护）。 */
async function loadIrChecks() {
  const canonicalPath = join(TS_REPO, 'dist', 'src', 'core', 'canonical-json.js');
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(canonicalPath) || !existsSync(distIndex)) fail(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  const { canonicalJson } = await import(canonicalPath);
  const { validateCoreIrInvariants } = await import(distIndex);
  if (!canonicalJson || !validateCoreIrInvariants) fail('aster-lang-ts is missing canonicalJson / validateCoreIrInvariants (needs Core IR v2, ts ≥ 2.0.0)');
  const schemaPath = join(TS_REPO, 'shared', 'core-ir.v2.schema.json');
  if (!existsSync(schemaPath)) fail(`Core IR v2 schema not found: ${schemaPath}`);
  const ajvModule = createRequire(join(TS_REPO, 'package.json'))('ajv/dist/2020.js');
  const Ajv2020 = ajvModule.Ajv2020 ?? ajvModule.default ?? ajvModule;
  const schemaValidate = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  const validate = (tree) => (schemaValidate(tree)
    ? validateCoreIrInvariants(tree)
    : schemaValidate.errors.map((e) => ({ path: e.instancePath, code: 'schema', message: e.message })));
  return { canonicalJson, validate };
}

function dumpBytes(rel, side, bytes) {
  if (!DUMP_DIR || typeof bytes !== 'string') return;
  const out = join(DUMP_DIR, `${rel}.${side}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
}

/** 逐样本判定 + 治理输入引用期望值核对，再对豁免表做 stale / 到期判定。 */
function classifyIr(tsRes, javaRes, samples, checks) {
  const ledger = createExemptionLedger(VALUE_EXEMPTIONS, { today: TODAY });
  const rows = [];
  for (const { rel, abs } of samples) {
    const t = tsRes[rel] || { ok: false, error: 'missing ts' };
    const j = javaRes[rel] || { ok: false, error: 'missing java' };
    dumpBytes(rel, 'ts', t.bytes);
    dumpBytes(rel, 'java', j.bytes);
    const judged = judgeSample({ file: rel, ts: t, java: j, ledger, ...checks });
    const row = { path: rel, ...judged, tsErr: t.error || null, javaErr: j.error || null };
    if (row.verdict === 'identical' || row.verdict === 'value-diff') {
      // 治理输入引用样本：两引擎相同还不够，须等于 meta 声明的期望值（两边同时算错也要变红）
      const meta = readMeta(abs) ?? {};
      const expectProblems = [
        ...inputRefsProblems('ts', meta, t.ir, t.inputRefConstructs),
        ...inputRefsProblems('java', meta, j.ir, j.inputRefConstructs),
      ];
      if (expectProblems.length > 0) {
        row.verdict = 'value-diff';
        row.diffs.push(...expectProblems.map((value) => ({ class: 'value', path: 'expectedInputRefs', value })));
        row.valueCount += expectProblems.length;
      }
    }
    rows.push(row);
  }
  return { rows, findings: exemptionFindings(ledger), narrowable: narrowableScopes(ledger), exempted: maskedCounts(ledger) };
}

function countBy(rows, verdict) {
  return rows.filter((r) => r.verdict === verdict).length;
}

function printMarkdownIrFull({ rows, findings, narrowable, exempted }, mode) {
  console.log(`# tier1-parity IR byte-level report (mode=${mode} --full, ADR 0055 §6, run date ${TODAY})\n`);
  console.log(`- total: ${rows.length}`);
  for (const v of IR_VERDICTS.filter((x) => !x.endsWith('-exemption'))) console.log(`- ${v}: ${countBy(rows, v)}`);
  console.log(`- stale-exemption: ${findings.filter((f) => f.verdict === 'stale-exemption').length}`);
  console.log(`- expired-exemption: ${findings.filter((f) => f.verdict === 'expired-exemption').length}`);
  console.log(`- shape differences (paths): ${rows.reduce((s, r) => s + r.shapeCount, 0)}`);
  console.log(`- value differences outside exemptions (paths): ${rows.reduce((s, r) => s + r.valueCount, 0)}\n`);

  console.log('## Value-layer exemptions (masked differences this run)\n');
  console.log('| id | category | masked | expires | issue |');
  console.log('|---|---|---:|---|---|');
  for (const e of VALUE_EXEMPTIONS) {
    console.log(`| ${e.id} | ${EXEMPTION_CATEGORIES[e.id]} | ${exempted[e.id] ?? 0} | ${e.expires} | ${e.issue} |`);
  }
  console.log('');

  if (findings.length > 0) {
    console.log('## Exemption table problems\n');
    for (const f of findings) {
      const where = [f.file, f.path].filter(Boolean).join(' ');
      console.log(`- ${f.verdict} ${f.id}${where ? ` ${where}` : ''}${f.verdict === 'expired-exemption' ? ` (expires ${f.expires}, run date ${f.today})` : ''}`);
    }
    console.log('');
  }

  if (narrowable.length > 0) {
    console.log('## Exemption scopes that can be narrowed (informational)\n');
    console.log('These files no longer have a masked difference in their category; remove them from the category\'s `files`.\n');
    for (const n of narrowable) console.log(`- ${n.id} ${n.file}`);
    console.log('');
  }

  for (const verdict of ['shape-diff', 'value-diff', 'schema-invalid', 'ts-failed', 'java-failed']) {
    const bad = rows.filter((r) => r.verdict === verdict);
    if (bad.length === 0) continue;
    console.log(`## ${verdict} (${bad.length})\n`);
    for (const r of bad) {
      console.log(`### ${r.path}\n`);
      if (r.tsErr || r.javaErr) console.log(`- error: ts=${JSON.stringify(r.tsErr)} java=${JSON.stringify(r.javaErr)}`);
      for (const p of r.problems) console.log(`- ${p.side} ${p.code} ${p.path}${p.message ? ` — ${p.message}` : ''}`);
      for (const d of r.diffs.slice(0, 20)) {
        if (d.value !== undefined) console.log(`- ${d.class} ${d.path}: ${JSON.stringify(d.value)}`);
        else console.log(`- ${d.class} ${d.path}: ts=${d.ts ?? '(absent)'} java=${d.java ?? '(absent)'}`);
      }
      if (r.diffs.length > 20) console.log(`- …and ${r.diffs.length - 20} more`);
      console.log('');
    }
  }
}

function printMarkdownIrFingerprint(rows, mode) {
  const divergent = rows.filter((r) => r.verdict === 'divergent');
  const oneSideFailed = rows.filter((r) => r.verdict === 'one-side-failed');
  console.log(`# tier1-parity IR fingerprint report (mode=${mode})\n`);
  console.log(`- total: ${rows.length}`);
  console.log(`- identical: ${countBy(rows, 'identical')}`);
  console.log(`- divergent: ${divergent.length}`);
  console.log(`- one side failed to lower: ${oneSideFailed.length}`);
  console.log(`- both failed: ${countBy(rows, 'both-fail')}\n`);
  if (divergent.length > 0) {
    console.log('## Divergent (fingerprint)\n');
    console.log('Structural diffs only (decl count, kind histogram, names). Byte-level parity runs under `--mode=ir --full` (ADR 0055 §6).\n');
    for (const r of divergent.slice(0, 50)) {
      console.log(`### ${r.path}\n`);
      for (const d of r.diffs) {
        if (d.value !== undefined) console.log(`- ${d.field}: ${JSON.stringify(d.value)}`);
        else console.log(`- ${d.field}: ts=${JSON.stringify(d.ts)} java=${JSON.stringify(d.java)}`);
      }
      console.log('');
    }
  }
  if (oneSideFailed.length > 0) {
    console.log('## One-side lowering failures\n');
    for (const r of oneSideFailed.slice(0, 30)) {
      const failedSide = r.ts ? 'java' : 'ts';
      const err = r.ts ? r.javaErr : r.tsErr;
      console.log(`- ${r.path} (${failedSide} failed: ${(err || '').slice(0, 100)})`);
    }
    console.log('');
  }
}

/** --mode=ir（不带 --full）：声明级结构指纹，非门禁口径，仅供快速观测。 */
function classifyIrFingerprint(tsRes, javaRes, samples) {
  return samples.map(({ rel }) => {
    const t = tsRes[rel] || { ok: false, error: 'missing ts' };
    const j = javaRes[rel] || { ok: false, error: 'missing java' };
    let verdict;
    let diffs = [];
    if (!t.ok && !j.ok) verdict = 'both-fail';
    else if (t.ok !== j.ok) verdict = 'one-side-failed';
    else {
      diffs = diffFingerprints(t.fingerprint, j.fingerprint);
      verdict = diffs.length === 0 ? 'identical' : 'divergent';
    }
    return { path: rel, ts: t.ok, java: j.ok, verdict, diffs, tsErr: t.error || null, javaErr: j.error || null };
  });
}

// Read a sample's declared lexicon (defaults to 'en-US').
//
// ★2026-08-17 审计：每个 .meta.json 都声明了 `lexicon` 字段，但 parity runner
//   **从不读取它**——两侧引擎一律按默认（英语）词法表处理。结果是：
//   219 个 tier1 样本全部是 en-US，非英语词法表在双引擎 parity 上**零覆盖**。
//   CJK / 天城文 等标识符的双引擎分歧因此无法被自动发现，只能靠人工审计。
//   本函数让 runner 真正按样本声明的词法表驱动两侧引擎。
function lexiconOf(abs) {
  const metaPath = abs.replace(/\.aster$/, '.meta.json');
  if (!existsSync(metaPath)) return 'en-US';
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    return typeof meta.lexicon === 'string' && meta.lexicon ? meta.lexicon : 'en-US';
  } catch {
    return 'en-US';
  }
}

// 样本 meta 的 evalExempt 理由（无则 null）；只用于 eval 门的 golden 守卫，IR 门不读它。
function exemptReasonOf(abs) {
  const metaPath = abs.replace(/\.aster$/, '.meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    return meta.evalExempt === true ? (meta.evalExemptReason || 'exempt') : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Phase C: evaluator output parity
// ============================================================================

const TRUFFLE_REPO = resolve(ROOT, '..', 'aster-lang-truffle');
const TS_DUAL_ENGINE_RUNNER = join(TS_REPO, 'scripts', 'dual-engine-runner.mjs');

/**
 * For every manifest sample, look for a sibling .cases.json under
 * `corpus/tier1-equivalence/inputs/<basename>.cases.json`. Returns the
 * flat list of evaluation requests. Samples without a cases file are
 * dropped — Phase C only checks samples with golden inputs.
 */
function collectEvalRequests(samples) {
  const requests = [];
  // ★守卫:非 eval-exempt 的样本必须有**有效** golden，否则报错而非静默跳过。
  // 历史缺陷:缺 cases 的样本被静默丢弃 —— 曾让 `stdlib_date`（因白名单误判被剔出分母）
  // 悄悄消失，制造"伪 100%"（143/143 隐藏了 date）。守卫覆盖全部失效形态（缺文件 / JSON
  // 损坏 / 缺 entry / cases 非数组 / cases 空数组），判定逻辑与 tag-eval-exempt 共用
  // scripts/lib/eval-cases.mjs（单一事实源，防漂移）。豁免样本（meta.evalExempt=true）本就
  // 不需要 golden（走 derived-analysis 结构比对），跳过合法。
  const problems = []; // { rel, why }
  for (const { rel, abs, vocabPath } of samples) {
    const isExempt = exemptReasonOf(abs) !== null;
    const base = abs.split('/').pop().replace(/\.aster$/, '');
    // 带词汇样本的 golden 在样本目录的 inputs/ 下（见 lib/vocab-corpus.mjs casesPathOf），其余在 tier1-equivalence/inputs/
    const casesPath = vocabPath
      ? casesPathOf(abs)
      : join(CORPUS, 'tier1-equivalence', 'inputs', `${base}.cases.json`);
    const exists = existsSync(casesPath);
    let doc = null;
    let parseError = null;
    if (exists) {
      try {
        doc = JSON.parse(readFileSync(casesPath, 'utf8'));
      } catch (e) {
        parseError = (e && e.message) || String(e);
      }
    }
    const problem = collectEvalCaseProblem({ exists, parseError, doc });
    if (problem) {
      if (!isExempt) problems.push({ rel, why: problem });
      continue;
    }
    for (let i = 0; i < doc.cases.length; i++) {
      const c = doc.cases[i];
      // entry 逐 case 解析：case 级 `entry` 覆盖文档级默认，让**一个 policy 里的多条 rule**
      // 都能被求值（此前一文件只能测一个 entry，同文件其余 rule 仅被解析 = eval 盲区）。
      requests.push({
        rel,
        samplePath: abs,
        vocabPath,
        entry: entryForCase(doc, c),
        input: Array.isArray(c.input) ? c.input : [],
        caseIndex: i,
        caseName: c.name || `case ${i}`,
        expected: c.expectedOutput,
        // 断言"两引擎都应拒绝"的错误路径用例（issue #69）
        expectError: expectsError(c),
      });
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[parity-tier1] ${problems.length} 个非 eval-exempt 样本无有效 golden（eval 盲区，拒绝静默跳过）:\n` +
      problems.map((p) => `  - ${p.rel}: ${p.why}`).join('\n') +
      `\n给它们补有效 golden（scripts/gen-cases.mjs）或在 .meta.json 标 evalExempt 并说明理由。`,
    );
  }
  return requests;
}

/**
 * Invoke the TS dual-engine-runner once per request. It reads
 * {source, entry, input} from stdin and emits {success, value, error}.
 * Each spawn is fresh per request because the runner is designed for
 * one-shot use.
 */
/**
 * 求值请求是否要按样本的词法表 / 词汇处理。dual-engine-runner 的 stdin 协议只有 {source, entry, input}，
 * 默认按 en-US 编译；带词汇或声明了非 en-US 词法表的样本都走进程内求值（loadTsVocabEval）。
 */
function needsLexiconEval(req) {
  return Boolean(req.vocabPath) || lexiconOf(req.samplePath) !== 'en-US';
}

/** Java 求值请求中的词法表 / 词汇字段；en-US 且无词汇时为空（CoreIrEvalCli 走默认词法表）。 */
function evalLexiconFields(req) {
  if (!needsLexiconEval(req)) return {};
  return { lexicon: lexiconOf(req.samplePath), ...(req.vocabPath ? { vocabulary: req.vocabPath } : {}) };
}

async function runTsEval(requests) {
  if (!existsSync(TS_DUAL_ENGINE_RUNNER)) {
    fail(`TS dual-engine runner not found at ${TS_DUAL_ENGINE_RUNNER}. ` +
      `Run: cd ${TS_REPO} && pnpm build`);
  }
  const vocabEval = requests.some(needsLexiconEval) ? await loadTsVocabEval() : null;
  const results = [];
  for (const req of requests) {
    if (needsLexiconEval(req)) {
      results.push({ rel: req.rel, caseIndex: req.caseIndex, ...vocabEval(req) });
      continue;
    }
    const source = readFileSync(req.samplePath, 'utf8');
    const stdin = JSON.stringify({ source, entry: req.entry, input: req.input });
    const proc = spawnSync('node', [TS_DUAL_ENGINE_RUNNER], {
      input: stdin,
      encoding: 'utf8',
      timeout: 30_000,
    });
    let out;
    try {
      out = JSON.parse((proc.stdout || '').trim());
    } catch {
      out = { success: false, error: (proc.stderr || 'invalid TS runner output').slice(0, 240) };
    }
    results.push({
      rel: req.rel,
      caseIndex: req.caseIndex,
      ok: out.success === true,
      value: out.success ? out.value : undefined,
      error: out.success ? null : out.error || null,
    });
  }
  return results;
}

/**
 * 带词汇或非 en-US 词法表请求的 TS 求值（进程内）。dual-engine-runner 的 stdin 协议只有 {source, entry, input}，
 * 没有词法表与词汇通道；这里复用同一份 dist（browser compile + interpreter），
 * 步骤与该 runner 逐一对应：compile → 找入口 → 元数检查 → evaluate → serializeGuestValue。
 */
async function loadTsVocabEval() {
  const { compile } = await import(join(TS_REPO, 'dist', 'src', 'browser.js'));
  const { evaluate, serializeGuestValue } = await import(join(TS_REPO, 'dist', 'src', 'core', 'interpreter.js'));
  const lexicons = await loadTsLexicons({});
  return (req) => {
    const sample = { rel: req.rel, abs: req.samplePath, vocabPath: req.vocabPath };
    const compiled = compile(readFileSync(req.samplePath, 'utf8'), {
      lexicon: tsLexiconFor(lexicons, sample),
      vocabulary: readVocab(sample),
    });
    if (!compiled.success || !compiled.core) {
      const errors = [...(compiled.parseErrors || []), ...(compiled.resolutionDiagnostics || [])];
      return { ok: false, error: `Compile failed: ${errors.map((e) => e.message).join('; ')}` };
    }
    const fn = (compiled.core.decls || []).find((d) => d.kind === 'Func' && d.name === req.entry);
    if (!fn) return { ok: false, error: `Function '${req.entry}' not found in module` };
    const paramNames = (fn.params || []).map((p) => p.name);
    if (req.input.length !== paramNames.length) {
      return { ok: false, error: `Arity mismatch for '${req.entry}': expected ${paramNames.length}, got ${req.input.length}` };
    }
    const context = Object.fromEntries(paramNames.map((name, i) => [name, req.input[i]]));
    const result = evaluate(compiled.core, req.entry, context);
    if (!result.success) return { ok: false, error: result.error || null };
    // 与 runner 一致：serializeGuestValue 按插入序输出，再按 JSON 读回
    return { ok: true, value: JSON.parse(serializeGuestValue(result.value)), error: null };
  };
}

/**
 * Invoke aster-lang-truffle's CoreIrEvalCli with a JSONL request file
 * and read back the per-case results. Like Phase B, this depends on
 * the gradle test task forwarding `parity.eval.*` system properties
 * (see aster-lang-truffle/build.gradle.kts).
 */
function runJavaEval(requests) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'parity-eval-'));
  const inputFile = join(tmpRoot, 'requests.jsonl');
  const outputFile = join(tmpRoot, 'java-eval.jsonl');
  const lines = requests.map((req) =>
    JSON.stringify({
      samplePath: req.samplePath,
      entry: req.entry,
      input: req.input,
      caseIndex: req.caseIndex,
      // 带词汇或非 en-US 词法表的请求：CoreIrEvalCli 按词法表规范化关键词，带词汇时以该词汇做名称解析
      ...evalLexiconFields(req),
    }),
  );
  writeFileSync(inputFile, lines.join('\n') + '\n');

  const result = spawnSync(
    './gradlew',
    [
      'test',
      '--tests',
      'CoreIrEvalCli',
      '--rerun-tasks',
      '-i',
      `-Dparity.eval.input=${inputFile}`,
      `-Dparity.eval.output=${outputFile}`,
    ],
    { cwd: TRUFFLE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const tail = ((result.stdout || '') + (result.stderr || '')).slice(-2000);
  if (!existsSync(outputFile)) {
    fail(`aster-lang-truffle CoreIrEvalCli produced no output. Gradle log tail:\n${tail}`);
  }

  // Parse JSONL back. The Java side may emit one row per input line
  // OR — if a request line was malformed — a synthetic "ok=false"
  // row without samplePath. The runner uses (samplePath, caseIndex)
  // as the join key.
  const byKey = new Map();
  for (const line of readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.samplePath !== undefined && rec.caseIndex !== undefined) {
        byKey.set(`${rec.samplePath}${rec.caseIndex}`, rec);
      }
    } catch {}
  }

  const results = [];
  for (const req of requests) {
    const rec = byKey.get(`${req.samplePath}${req.caseIndex}`);
    if (!rec) {
      results.push({
        rel: req.rel,
        caseIndex: req.caseIndex,
        ok: false,
        error: 'no Java result row for this case',
      });
    } else if (!rec.ok) {
      results.push({
        rel: req.rel,
        caseIndex: req.caseIndex,
        ok: false,
        error: rec.error || 'unknown Java error',
      });
    } else {
      results.push({
        rel: req.rel,
        caseIndex: req.caseIndex,
        ok: true,
        value: rec.value,
        error: null,
      });
    }
  }

  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  return results;
}

/**
 * Compare TS and Java eval results case-by-case. Each row also
 * surfaces the expected golden value so the report distinguishes
 * "both engines agree but differ from golden" (real bug somewhere)
 * from "engines disagree" (parity gap).
 */
function classifyEval(tsResults, javaResults, requests) {
  // Index by (rel, caseIndex) for safe lookup.
  const tsByKey = new Map(tsResults.map((r) => [`${r.rel}${r.caseIndex}`, r]));
  const javaByKey = new Map(javaResults.map((r) => [`${r.rel}${r.caseIndex}`, r]));

  const rows = [];
  for (const req of requests) {
    const key = `${req.rel}${req.caseIndex}`;
    const t = tsByKey.get(key) || { ok: false, error: 'no ts result' };
    const j = javaByKey.get(key) || { ok: false, error: 'no java result' };
    const expectedJson = JSON.stringify(req.expected);
    const tsMatchesExpected = t.ok && JSON.stringify(t.value) === expectedJson;
    const javaMatchesExpected = j.ok && JSON.stringify(j.value) === expectedJson;

    let verdict;
    if (req.expectError) {
      // 错误路径用例（issue #69）：契约是**两个引擎都必须拒绝**。
      // 任一侧返回了值 = 该引擎没拒绝非法输入 → 这正是要抓的跨引擎错误语义分歧
      // （例如一方除零抛异常、另一方返回 Infinity）。
      // 刻意不比对错误消息：消息是实现细节（Java 带堆栈+中文提示，TS 是短句），
      // 强行对齐只会制造脆弱断言；契约是"拒绝与否"。
      if (!t.ok && !j.ok) {
        verdict = 'identical';
      } else if (t.ok && j.ok) {
        verdict = 'both-wrong'; // 两侧都没拒绝 → golden 说该失败，实际都成功了
      } else {
        verdict = t.ok ? 'java-only-failed' : 'ts-only-failed';
      }
    } else if (!t.ok && !j.ok) {
      verdict = 'both-failed';
    } else if (!t.ok) {
      verdict = 'ts-only-failed';
    } else if (!j.ok) {
      verdict = 'java-only-failed';
    } else if (JSON.stringify(t.value) !== JSON.stringify(j.value)) {
      verdict = 'divergent';
    } else if (!tsMatchesExpected) {
      // Engines agree but both differ from golden. Usually a stale
      // .cases.json (policy changed without updating expectedOutput),
      // or both engines share a real bug. Either way it isn't parity,
      // so it can't be marked `identical`. (Codex review R-Phase-C-C2.)
      verdict = 'both-wrong';
    } else {
      verdict = 'identical';
    }

    rows.push({
      path: req.rel,
      caseIndex: req.caseIndex,
      caseName: req.caseName,
      expected: req.expected,
      expectError: req.expectError === true,
      tsMatchesExpected,
      javaMatchesExpected,
      ts: t.ok,
      tsValue: t.ok ? t.value : undefined,
      tsErr: t.error || null,
      java: j.ok,
      javaValue: j.ok ? j.value : undefined,
      javaErr: j.error || null,
      verdict,
    });
  }
  return rows;
}

function printMarkdownEval(rows, mode) {
  const total = rows.length;
  const identical = rows.filter((r) => r.verdict === 'identical').length;
  const divergent = rows.filter((r) => r.verdict === 'divergent');
  const bothWrong = rows.filter((r) => r.verdict === 'both-wrong');
  const tsOnly = rows.filter((r) => r.verdict === 'ts-only-failed');
  const javaOnly = rows.filter((r) => r.verdict === 'java-only-failed');
  const bothFailed = rows.filter((r) => r.verdict === 'both-failed');

  console.log(`# tier1-parity evaluator report (mode=${mode})\n`);
  console.log(`- total cases: ${total}`);
  console.log(`- identical (engines agree AND match golden): ${identical}`);
  console.log(`- divergent (engines disagree): ${divergent.length}`);
  console.log(`- both-wrong (engines agree but neither matches golden): ${bothWrong.length}`);
  console.log(`- ts-only failed: ${tsOnly.length}`);
  console.log(`- java-only failed: ${javaOnly.length}`);
  console.log(`- both failed: ${bothFailed.length}\n`);

  if (divergent.length > 0) {
    console.log('## Divergent results (both engines produced a value but they disagree)\n');
    console.log('| path | case | ts | java | expected |');
    console.log('|------|------|----|------|----------|');
    for (const r of divergent.slice(0, 30)) {
      console.log(
        `| ${r.path} | ${r.caseName} | ${JSON.stringify(r.tsValue)} | ` +
        `${JSON.stringify(r.javaValue)} | ${JSON.stringify(r.expected)} |`,
      );
    }
    console.log('');
  }

  // expectError 用例的 both-wrong 含义不同：不是"值对不上 golden"，而是"该拒绝却都
  // 接受了"。分开列，避免维护者按值比对的思路去排查一个错误路径问题。
  const bothWrongValue = bothWrong.filter((r) => !r.expectError);
  const bothAcceptedUnexpectedly = bothWrong.filter((r) => r.expectError);

  if (bothWrongValue.length > 0) {
    console.log('## Both-wrong (engines agree but neither matches the golden)\n');
    console.log('Either the `.cases.json` expectedOutput is stale, or both engines share a real bug.\n');
    console.log('| path | case | engine value | expected |');
    console.log('|------|------|--------------|----------|');
    for (const r of bothWrongValue.slice(0, 30)) {
      console.log(
        `| ${r.path} | ${r.caseName} | ${JSON.stringify(r.tsValue)} | ` +
        `${JSON.stringify(r.expected)} |`,
      );
    }
    console.log('');
  }

  if (bothAcceptedUnexpectedly.length > 0) {
    console.log('## Expected-error cases that BOTH engines accepted\n');
    console.log('`expectError: true` 断言两侧都应拒绝，但两侧都返回了值——'
      + '要么该输入其实合法（golden 写错），要么两个引擎共享同一个"不拒绝非法输入"的缺陷。\n');
    console.log('| path | case | ts value | java value |');
    console.log('|------|------|----------|------------|');
    for (const r of bothAcceptedUnexpectedly.slice(0, 30)) {
      console.log(
        `| ${r.path} | ${r.caseName} | ${JSON.stringify(r.tsValue)} | ` +
        `${JSON.stringify(r.javaValue)} |`,
      );
    }
    console.log('');
  }

  if (javaOnly.length > 0) {
    console.log('## Java-only failures (TS evaluated, Java did not)\n');
    for (const r of javaOnly.slice(0, 30)) {
      console.log(`- ${r.path} / ${r.caseName} → ${(r.javaErr || '').slice(0, 120)}`);
    }
    if (javaOnly.length > 30) console.log(`_…and ${javaOnly.length - 30} more (truncated)_`);
    console.log('');
  }

  if (tsOnly.length > 0) {
    console.log('## TS-only failures (Java evaluated, TS did not)\n');
    for (const r of tsOnly.slice(0, 30)) {
      console.log(`- ${r.path} / ${r.caseName} → ${(r.tsErr || '').slice(0, 120)}`);
    }
    console.log('');
  }
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
  const vocabRows = rows.filter((r) => r.vocab);
  const vocabBad = vocabRows.filter((r) => r.verdict !== 'pass');
  if (vocabRows.length > 0) {
    console.log(`## Vocabulary-carrying samples (parse + name resolution, ADR 0051): ${vocabRows.length - vocabBad.length}/${vocabRows.length} pass\n`);
    for (const r of vocabBad) console.log(`- ${r.path} (${r.verdict}): ${(r.reason || '').slice(0, 160)}`);
    if (vocabBad.length > 0) console.log('');
  }
}

/** 按 --report-only 收尾：失败时打印 ::error::（或 ::warning::）并设置退出码。 */
function finish(msg, failed) {
  if (!failed) {
    console.error('[parity-tier1] OK');
    return;
  }
  if (REPORT_ONLY) {
    console.error(`::warning::tier1-parity (${msg})`);
    return;
  }
  console.error(`::error::tier1-parity (${msg})`);
  process.exitCode = 1;
}

async function main() {
  if (MODE !== 'parse' && MODE !== 'ir' && MODE !== 'eval') {
    fail(`mode=${MODE} not implemented. Supported: parse (Phase A), ir (Phase B), eval (Phase C).`);
  }

  const manifest = loadManifest();
  // ★两道守卫先于三门运行：语料与 manifest 脱节时必须**红**，
  //   而不是静默跳过（跳过看起来跟通过一模一样）。
  assertAllPoliciesInManifest(manifest);
  assertNoOrphanCaseFiles(manifest);
  assertMustRejectManifest(manifest);
  assertVocabCorpus(manifest);
  const samples = resolveSamples(manifest.samples);
  // must-reject 样本只参与 parse 门：它们没有 IR、也没有可求值的输出
  const rejects = resolveSamples(manifest.mustReject || []);
  console.error(
    `[parity-tier1] manifest declares ${samples.length} samples + ${rejects.length} must-reject (mode=${MODE}` +
      (REPORT_ONLY ? ', report-only' : '') + ')' +
      (MODE === 'parse' ? '' : '; must-reject samples are parse-only and skipped here'),
  );

  if (MODE === 'parse') {
    // 带词汇样本（ADR 0051）的契约在名称解析阶段：单独走「解析 + R1/R2」两侧，见 lib/vocab-corpus.mjs
    const plain = samples.filter((s) => !s.vocabPath);
    const plainRejects = rejects.filter((s) => !s.vocabPath);
    const vocabSamples = samples.filter((s) => s.vocabPath);
    const vocabRejects = rejects.filter((s) => s.vocabPath);

    console.error('[parity-tier1] running TS engine ...');
    const tsRes = await runTsParse([...plain, ...plainRejects]);

    console.error('[parity-tier1] running Java engine (gradle, may take ~30s) ...');
    const javaRes = runJavaParse([...plain, ...plainRejects]);

    const rows = classify(tsRes, javaRes, plain);
    const rejectRows = classifyMustReject(tsRes, javaRes, plainRejects);

    if (vocabSamples.length + vocabRejects.length > 0) {
      console.error(`[parity-tier1] resolving ${vocabSamples.length + vocabRejects.length} vocabulary-carrying sample(s) on both engines ...`);
      const tsVocab = await runTsResolve([...vocabSamples, ...vocabRejects]);
      const javaVocab = runJavaIr([...vocabSamples, ...vocabRejects], { full: false });
      rows.push(...classifyVocabSamples(tsVocab, javaVocab, vocabSamples));
      rejectRows.push(...classifyVocabRejects(tsVocab, javaVocab, vocabRejects));
    }
    writeFileSync(REPORT_FILE, JSON.stringify(
      { mode: MODE, total: rows.length, rows, mustReject: rejectRows }, null, 2));
    printMarkdown(rows, MODE);
    printMustReject(rejectRows);

    const bad = rows.filter((r) => r.verdict !== 'pass');
    const badReject = rejectRows.filter((r) => r.verdict !== 'rejected');
    if (bad.length + badReject.length > 0) {
      const msg = `tier1-parity (parse) broken: ${bad.length}/${rows.length} sample(s) did not pass both engines, ` +
        `${badReject.length}/${rejectRows.length} must-reject sample(s) not rejected by both`;
      if (REPORT_ONLY) {
        console.error(`::warning::${msg}`);
        process.exit(0);
      }
      console.error(`::error::${msg}`);
      process.exit(1);
    }
    console.error('[parity-tier1] OK');
    return;
  }

  if (MODE === 'ir') {
    // 先装配校验器：ts 未构建或缺 v2 出口时立即报基础设施错误，不必等 gradle 跑完
    const checks = IR_FULL ? await loadIrChecks() : null;
    console.error('[parity-tier1] running TS engine (parse→R1→lower→R2) ...');
    const tsRes = await runTsIr(samples);

    console.error('[parity-tier1] running Java engine (gradle CoreIrFingerprintCli, may take ~30s) ...');
    const javaRes = runJavaIr(samples);

    if (!IR_FULL) {
      const rows = classifyIrFingerprint(tsRes, javaRes, samples);
      writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, total: rows.length, rows }, null, 2));
      printMarkdownIrFingerprint(rows, MODE);
      return finish(`ir fingerprint: ${rows.filter((r) => r.verdict !== 'identical').length}/${rows.length} sample(s) not identical`,
        rows.some((r) => r.verdict !== 'identical'));
    }

    const result = classifyIr(tsRes, javaRes, samples, checks);
    const { rows, findings } = result;
    writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, full: true, today: TODAY, total: rows.length, ...result }, null, 2));
    printMarkdownIrFull(result, MODE);

    // 趋势：identical / total。逐字节口径下没有「豁免样本移出分母」——值层豁免只替换位置，不剔除样本。
    const identical = rows.filter((r) => r.verdict === 'identical').length;
    appendHistory('ir', rows.length, identical, rows.length - identical);

    // 任何非 identical 的样本、任何 stale / 到期的豁免都使门禁失败（ADR 0055 §6）。
    const bad = rows.filter((r) => r.verdict !== 'identical');
    return finish(`ir byte-level: ${bad.length}/${rows.length} sample(s) not identical, ${findings.length} exemption-table problem(s)`,
      bad.length + findings.length > 0);
  }

  // mode === 'eval'
  const requests = collectEvalRequests(samples);
  console.error(`[parity-tier1] eval scope: ${requests.length} cases ` +
    `(samples with .cases.json: ${new Set(requests.map((r) => r.rel)).size})`);
  if (requests.length === 0) {
    console.log('# tier1-parity evaluator report (mode=eval)\n');
    console.log('No samples with .cases.json found — nothing to compare. ' +
      'Add golden inputs under corpus/tier1-equivalence/inputs/<name>.cases.json.');
    process.exit(0);
  }

  console.error('[parity-tier1] running TS evaluator (one subprocess per case)...');
  const tsRes = await runTsEval(requests);

  console.error('[parity-tier1] running Java evaluator (gradle CoreIrEvalCli, may take ~1min)...');
  const javaRes = runJavaEval(requests);

  const rows = classifyEval(tsRes, javaRes, requests);
  writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, total: rows.length, rows }, null, 2));
  printMarkdownEval(rows, MODE);

  const identicalCount = rows.filter((r) => r.verdict === 'identical').length;
  appendHistory('eval', rows.length, identicalCount, rows.length - identicalCount);

  const bad = rows.filter((r) => r.verdict !== 'identical');
  if (bad.length > 0) {
    const msg = `tier1-parity (eval) divergence: ${bad.length}/${rows.length} case(s) not identical`;
    if (REPORT_ONLY) {
      console.error(`::warning::${msg}`);
      process.exit(0);
    }
    console.error(`::error::${msg}`);
    process.exit(1);
  }
  console.error('[parity-tier1] OK');
}

// 只在作为脚本执行时运行；回归测试 import 本文件只为读取 VALUE_EXEMPTIONS。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(2);
  });
}
