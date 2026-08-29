#!/usr/bin/env node
/**
 * tier1-parity gate.
 *
 * Reads `corpus/tier1-parity/manifest.json` — the explicit, reviewed list
 * of samples both engines must accept — and runs each through TS + Java.
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
 *   --mode=ir     (Phase B, report-only initially) — compare a structural
 *                 fingerprint of each side's lowered Core IR:
 *                   { moduleName, declCount, declKinds: {kind→count}, declNames }
 *                 Raw JSON parity is deferred until field-name divergence
 *                 (e.g. Import.path vs Import.name) is resolved by ADR.
 *   --mode=eval   (Phase C, report-only initially) — for every sample
 *                 with a sibling .cases.json, evaluate each case on both
 *                 engines and compare the result against expectedOutput
 *                 AND against the other engine's result.
 *
 * Flags:
 *   --report-only  — write the report and exit 0 even on divergence.
 *                    Used during Phase B's initial cycle so we can observe
 *                    the drift surface before promoting to PR-blocking.
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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { upsertDailyHistory } from './lib/history.mjs';
import { collectEvalCaseProblem, entryForCase, expectsError } from './lib/eval-cases.mjs';

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
// --full (ADR 0016, mode=ir only): field-level normalized IR diff instead of the
// shallow structural fingerprint. Captures each engine's complete lowered Core IR
// and compares it through normalizeIr()/diffIr() (alias table + ignore set).
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
    manifest.samples.map((rel) => basename(rel).replace(/\.aster$/, '')),
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
    manifest.samples.map((rel) => basename(rel).replace(/\.aster$/, '')),
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
  const { canonicalize, lex, parse, parseWithLexicon } = mod;
  if (!canonicalize || !lex || !parse) {
    fail('aster-lang-ts is missing expected exports (canonicalize/lex/parse)');
  }

  // ★按样本声明的词法表驱动（2026-08-17 审计）：此前 runner 从不读 meta.lexicon，
  //   一律按默认英语处理，导致非英语词法表在双引擎 parity 上零覆盖。
  const lexicons = await loadTsLexicons(mod);

  const results = {};
  for (const { rel, abs } of samples) {
    let ok = false;
    let err = null;
    try {
      const src = readFileSync(abs, 'utf8');
      const lexName = lexiconOf(abs);
      const lexObj = lexicons[lexName];
      if (!lexObj && lexName !== 'en-US') {
        fail(`sample ${rel} declares lexicon "${lexName}" but it could not be loaded from aster-lang-ts`);
      }
      const canonical = lexObj ? canonicalize(src, lexObj) : canonicalize(src);
      const tokens = lexObj ? lex(canonical, lexObj) : lex(canonical);
      const { ast, diagnostics } = lexObj && parseWithLexicon
        ? parseWithLexicon(tokens, lexObj)
        : parse(tokens);
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

  // ★逐样本「已观测」判定（issue #119）——取代原先的 Discovered 计数比较。
  //
  //   原防线是 `Discovered N >= manifest size`。但 Discovered 统计的是
  //   **tier1 全量 + tier2/ts-only**，是 manifest 的**超集**——陈旧 Maven 语料
  //   缺少某个新增 manifest 样本时，计数照样够，那个新样本被静默判为 Java-pass。
  //   超集比较对「缺了哪一个」这件事天然盲。
  //
  //   现在 core 的 inventory 测试逐条输出 `OBSERVED <path>`，这里按**集合**核对：
  //   manifest 里任何一个样本没出现在观测清单中 → 拒绝给出结论。
  const observed = new Set();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*OBSERVED\s+(\S+\.aster)\s*$/);
    if (m) observed.add(m[1].replace(/^corpus\//, ''));
  }
  if (observed.size === 0) {
    fail(
      'Java inventory did not emit any "OBSERVED <path>" line.\n' +
      'Either aster-lang-core is older than the observed-list change (issue #119),\n' +
      'or the test did not actually run. Refusing to report a verdict.',
    );
  }
  const unobserved = samples.map((x) => x.rel).filter((rel) => !observed.has(rel));
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

  // Failure rows only. Anything OBSERVED and not listed here is a genuine pass.
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
 * Run the TS pipeline through to lowering for every manifest sample,
 * and return a map { relPath → { ok, fingerprint?, error? } }.
 */
async function runTsIr(samples) {
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(distIndex)) {
    fail(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  }
  const mod = await import(distIndex);
  const { canonicalize, lex, parse, lowerModule } = mod;
  if (!canonicalize || !lex || !parse || !lowerModule) {
    fail('aster-lang-ts missing exports (canonicalize/lex/parse/lowerModule)');
  }

  const results = {};
  for (const { rel, abs } of samples) {
    try {
      const src = readFileSync(abs, 'utf8');
      const canonical = canonicalize(src);
      const tokens = lex(canonical);
      const { ast, diagnostics } = parse(tokens);
      if (diagnostics && diagnostics.some((d) => d.severity === 'error')) {
        results[rel] = {
          ok: false,
          error: diagnostics.find((d) => d.severity === 'error').message,
        };
        continue;
      }
      if (!ast) {
        results[rel] = { ok: false, error: 'parse returned no AST' };
        continue;
      }
      const core = lowerModule(ast);
      results[rel] = IR_FULL
        ? { ok: true, ir: core }
        : { ok: true, fingerprint: buildFingerprint(core) };
    } catch (e) {
      results[rel] = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  return results;
}

/**
 * Invoke aster-lang-core's CoreIrFingerprintCli test with -Dparity.ir.input
 * pointing at a temp file of absolute sample paths, and read back the
 * JSONL fingerprint output. The CLI is a JUnit test whose body short-
 * circuits to a no-op when the system properties aren't set, so it
 * coexists with normal `./gradlew test` runs without side effects.
 */
function runJavaIr(samples) {
  // Build the temp input/output paths. We use sample ABSOLUTE paths so
  // the Java side can read them without any corpus-resolution dance.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'parity-ir-'));
  const inputFile = join(tmpRoot, 'samples.txt');
  const outputFile = join(tmpRoot, 'java-fp.jsonl');
  // CRITICAL: the manifest sample list maps to corpus/<rel> paths in
  // the local checkout. Use those absolute paths so Java reads exactly
  // the bytes the manifest declares, with no stale-Maven dependency
  // (the same blind spot the parse mode's coverage check defends).
  writeFileSync(inputFile, samples.map((s) => s.abs).join('\n') + '\n');

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
      ...(IR_FULL ? ['-Dparity.ir.full=true'] : []),
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
      results[rel] = { ok: false, error: 'no fingerprint record for sample' };
    } else if (!rec.ok) {
      results[rel] = { ok: false, error: rec.error || 'unknown Java error' };
    } else {
      results[rel] = IR_FULL
        ? { ok: true, ir: rec.ir }
        : { ok: true, fingerprint: rec.fingerprint };
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
// ADR 0016 — field-level (normalized) Core IR parity (--mode=ir --full)
// ============================================================================

// Fields ignored on every node: pure position/diagnostic data that carries no
// evaluation semantics and legitimately differs between engines (e.g. line/col
// numbering conventions). Stripped recursively before comparison.
const IR_IGNORE_FIELDS = new Set(['origin']);

// Type-inference + per-engine metadata layer. The two engines run DIFFERENT type
// inference (TS leaves unannotated params/returns as TypeVar 'Unknown'/omitted;
// Java eagerly infers a concrete TypeName), and each emits its own metadata
// (piiCategories/piiLevel, typeParams seeding, retTypeInferred). None of this is
// source-level structure — it's derived analysis state that legitimately differs
// — so it is out of scope for STRUCTURAL IR parity (ADR 0016 §B/§C). Stripped on
// both sides so the comparison focuses on the executable tree (decls, params by
// name, statements, expressions). Declared (non-inferred) types survive because
// they live on nodes the parser emits directly, not via these inference fields.
const IR_INFERENCE_FIELDS = new Set([
  'type', 'ret', 'retType', 'typeParams', 'typeInferred', 'retTypeInferred',
  'constraints', 'piiCategories', 'piiLevel',
  // Effect capabilities: the two engines run different capability *inference*
  // (TS seeds effectCaps from the stdlib namespace of each call; Java derives
  // them later/elsewhere), so effectCaps is derived analysis state like the
  // type layer — out of scope for structural IR parity. The DECLARED effects
  // (`It performs …`) are compared separately (see effects normalization).
  'effectCaps', 'effectCapsExplicit',
  // Lambda closure captures: derived analysis (TS captures the whole enclosing
  // env, Java only the referenced subset) — a closure-implementation detail, not
  // source structure. Both engines execute closures identically (eval-parity);
  // the capture LIST is not a source-level artifact, so it's out of scope.
  'captures',
]);

// Known, accepted leaf-field renamings: same `kind`, semantically identical
// payload, different field name on each side. Normalize the TS name → Java name.
// Every entry here is an auditable "this divergence is acceptable" decision.
// key: `<kind>.<tsField>`  value: `<javaField>`
const IR_FIELD_ALIASES = {
  'Import.name': 'path',
  'Import.asName': 'alias',
};

/**
 * Recursively normalize a Core IR node so the two engines' trees become
 * field-comparable: drop ignored fields, apply the alias table, treat a missing
 * field as an empty array/false default, and sort order-insensitive collections.
 */
function normalizeIr(node, kind) {
  if (Array.isArray(node)) return node.map((n) => normalizeIr(n, kind));
  if (node === null || typeof node !== 'object') return node;

  const k = typeof node.kind === 'string' ? node.kind : kind;
  const out = {};
  for (const [key, val] of Object.entries(node)) {
    if (IR_IGNORE_FIELDS.has(key)) continue;
    if (IR_INFERENCE_FIELDS.has(key)) continue; // derived analysis state — out of scope
    const aliased = IR_FIELD_ALIASES[`${k}.${key}`] || key;
    out[aliased] = normalizeIr(val, k);
  }
  // Declared effects: TS calls the field `declaredEffects` and preserves the
  // source casing (`IO`); Java calls it `effects` and lowercases (`io`). Same
  // source-level data (`It performs …`) — fold both to a sorted lowercase set
  // under `effects` so the declared-effect surface IS compared (unlike the
  // inferred effectCaps, which are dropped above).
  if (out.declaredEffects !== undefined) { out.effects = out.declaredEffects; delete out.declaredEffects; }
  if (Array.isArray(out.effects)) {
    out.effects = [...out.effects].map((e) => String(e).toLowerCase()).sort();
  }
  // "missing == empty" for optional annotation arrays the two engines disagree
  // on emitting (TS omits empty arrays to preserve golden baselines; Java emits
  // []). Only injected on node kinds known to carry the field.
  for (const f of ['annotations', 'retAnnotations', 'effects']) {
    if (out[f] === undefined && nodeMayHave(k, out, f)) out[f] = [];
  }
  // Import version: TS omits an unset version; Java emits `null`. Same "no
  // version pin" meaning — fold both to null.
  if (k === 'Import' && out.version === undefined) out.version = null;
  // Annotation params: an argument-less annotation (`@entry`) carries no params
  // in TS; Java attaches an all-empty params container
  // `{annotations:[],retAnnotations:[],effects:[]}`. Treat such an empty
  // container as "no params" so both sides match.
  if (out.params && typeof out.params === 'object' && !Array.isArray(out.params)
      && Object.values(out.params).every((v) => Array.isArray(v) && v.length === 0)) {
    delete out.params;
  }
  // Ok/Err/Some/None constructor call-form: TS lowers `Ok(x)` to
  // `Call{target:Name "Ok", args:[x]}` (the call form is not given a dedicated
  // node by the TS front-end — only the `ok of x` keyword form is); Java lowers
  // both forms to a dedicated `{kind:"Ok", expr:x}`. Canonicalize the TS Call
  // shape to the dedicated-node shape so they compare equal.
  if (k === 'Call' && out.target && out.target.kind === 'Name'
      && ['Ok', 'Err', 'Some', 'None'].includes(out.target.name)) {
    const ctor = out.target.name;
    if (ctor === 'None') return { kind: 'None' };
    if (Array.isArray(out.args) && out.args.length === 1) {
      return { kind: ctor, expr: out.args[0] };
    }
  }
  // Ctor-pattern bind names: TS `PatCtor` lists them as `names: ["id","name"]`;
  // Java lists them as `args: [{kind:PatName, name:"id"}, …]`. Same ordered bind
  // names, different shape — canonicalize both to `binds: ["id","name"]`.
  if (k === 'PatCtor') {
    const binds = out.names
      ? out.names
      : Array.isArray(out.args)
        ? out.args.map((a) => (a && a.name !== undefined ? a.name : a))
        : [];
    delete out.names;
    delete out.args;
    out.binds = binds;
  }
  // 0-arg enum-variant pattern: `When InvalidCreds` → TS lowers to
  // `PatName{name:"InvalidCreds"}` (a Capitalized name-pattern = variant match),
  // Java to `PatCtor{typeName:"InvalidCreds", binds:[]}`. Same "match this enum
  // variant by name, bind nothing" meaning — canonicalize a Capitalized PatName
  // and a no-bind PatCtor to a single `PatVariant{variant}` form.
  if (k === 'PatName' && typeof out.name === 'string' && /^[A-Z]/.test(out.name)) {
    return { kind: 'PatVariant', variant: out.name };
  }
  if (k === 'PatCtor' && Array.isArray(out.binds) && out.binds.length === 0 && out.typeName) {
    return { kind: 'PatVariant', variant: out.typeName };
  }
  return out;
}

// Conservative: only inject an empty default for a list field on nodes known to
// carry it, so we don't invent fields on unrelated nodes. Field/param nodes have
// no `kind` discriminator (they're `{name, type}` records), so detect them by
// shape: a named record that isn't a top-level decl can carry `annotations`.
function nodeMayHave(kind, out, field) {
  if (kind === 'Func') return ['annotations', 'retAnnotations', 'effects'].includes(field);
  if (field === 'annotations' && out.name !== undefined && out.kind === undefined) return true;
  return false;
}

/**
 * Field-level diff of two normalized IR trees. Returns a list of
 * { path, ts, java } leaf disagreements (capped per sample for readability).
 */
function diffIr(tsIr, javaIr) {
  const diffs = [];
  walkDiff(normalizeIr(tsIr), normalizeIr(javaIr), '$', diffs);
  return diffs;
}

function walkDiff(a, b, path, diffs) {
  if (diffs.length >= 40) return; // cap noise per sample
  if (a === b) return;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    diffs.push({ path, ts: summarize(a), java: summarize(b) });
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      diffs.push({ path: `${path}.length`, ts: a.length, java: b.length });
      return;
    }
    for (let i = 0; i < a.length; i++) walkDiff(a[i], b[i], `${path}[${i}]`, diffs);
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      if (!(key in a)) { diffs.push({ path: `${path}.${key}`, ts: undefined, java: summarize(b[key]) }); continue; }
      if (!(key in b)) { diffs.push({ path: `${path}.${key}`, ts: summarize(a[key]), java: undefined }); continue; }
      walkDiff(a[key], b[key], `${path}.${key}`, diffs);
    }
    return;
  }
  diffs.push({ path, ts: a, java: b });
}

function summarize(v) {
  const s = JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 77) + '…' : s;
}

// Read a sample's evalExempt reason (or null) from its sibling .meta.json. An
// eval-exempt sample (effects/io/interop/workflow) exercises a derived-analysis
// surface (effect lowering, async workflow, host-interop) whose IR shape the two
// engines legitimately represent differently — the same boundary eval-parity
// uses. Such divergences are reported but do NOT count as structural-parity
// failures, matching ADR 0016's "structural parity = the executable tree".
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

function classifyIr(tsRes, javaRes, samples) {
  const rows = [];
  for (const { rel, abs } of samples) {
    const t = tsRes[rel] || { ok: false, error: 'missing ts' };
    const j = javaRes[rel] || { ok: false, error: 'missing java' };
    const exempt = IR_FULL ? exemptReasonOf(abs) : null;
    let verdict;
    let diffs = [];
    if (!t.ok && !j.ok) {
      verdict = 'both-fail';
    } else if (t.ok !== j.ok) {
      verdict = 'one-side-failed';
    } else if (IR_FULL) {
      diffs = diffIr(t.ir, j.ir);
      verdict = diffs.length === 0 ? 'identical' : (exempt ? 'divergent-exempt' : 'divergent');
    } else {
      diffs = diffFingerprints(t.fingerprint, j.fingerprint);
      verdict = diffs.length === 0 ? 'identical' : 'divergent';
    }
    rows.push({
      path: rel,
      ts: t.ok,
      java: j.ok,
      verdict,
      diffs,
      exempt,
      tsErr: t.error || null,
      javaErr: j.error || null,
    });
  }
  return rows;
}

function printMarkdownIr(rows, mode) {
  const total = rows.length;
  const identical = rows.filter((r) => r.verdict === 'identical').length;
  const divergent = rows.filter((r) => r.verdict === 'divergent');
  const divergentExempt = rows.filter((r) => r.verdict === 'divergent-exempt');
  const oneSideFailed = rows.filter((r) => r.verdict === 'one-side-failed');
  const bothFail = rows.filter((r) => r.verdict === 'both-fail');

  const kind = IR_FULL ? 'field-level' : 'fingerprint';
  console.log(`# tier1-parity IR ${kind} report (mode=${mode})\n`);
  console.log(`- total: ${total}`);
  console.log(`- identical: ${identical}`);
  console.log(`- divergent: ${divergent.length}`);
  if (IR_FULL) {
    console.log(`- divergent (eval-exempt, not a structural-parity failure): ${divergentExempt.length}`);
  }
  console.log(`- one side failed to lower: ${oneSideFailed.length}`);
  console.log(`- both failed: ${bothFail.length}\n`);

  if (divergent.length > 0) {
    console.log(`## Divergent (${kind})\n`);
    if (IR_FULL) {
      console.log('Normalized field-level diffs (origins stripped, known aliases applied, ' +
        'inferred-type noise removed — see ADR 0016). Each unresolved path is a real ' +
        'cross-engine IR divergence to triage.\n');
    } else {
      console.log('Structural diffs only (decl count, kind histogram, names). ' +
        'Field-level alignment runs under `--mode=ir --full` (ADR 0016).\n');
    }
    for (const r of divergent.slice(0, 50)) {
      console.log(`### ${r.path}\n`);
      for (const d of r.diffs) {
        const label = d.path || d.field;
        if (d.value !== undefined) console.log(`- ${label}: ${JSON.stringify(d.value)}`);
        else console.log(`- ${label}: ts=${JSON.stringify(d.ts)} java=${JSON.stringify(d.java)}`);
      }
      console.log('');
    }
    if (divergent.length > 50) {
      console.log(`_…and ${divergent.length - 50} more (truncated)_\n`);
    }
  }

  if (IR_FULL && divergentExempt.length > 0) {
    console.log('## Divergent — eval-exempt (informational)\n');
    console.log('These samples exercise effect/workflow/interop surfaces that are ' +
      'eval-exempt; the two engines lower their derived-analysis structure ' +
      'differently and this is out of scope for structural IR parity (ADR 0016). ' +
      'Listed for visibility, not counted as failures.\n');
    for (const r of divergentExempt) {
      console.log(`- ${r.path} (${r.exempt}): ${r.diffs.length} field diff${r.diffs.length === 1 ? '' : 's'}`);
    }
    console.log('');
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
  for (const { rel, abs } of samples) {
    const isExempt = exemptReasonOf(abs) !== null;
    const base = abs.split('/').pop().replace(/\.aster$/, '');
    const casesPath = join(CORPUS, 'tier1-equivalence', 'inputs', `${base}.cases.json`);
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
function runTsEval(requests) {
  if (!existsSync(TS_DUAL_ENGINE_RUNNER)) {
    fail(`TS dual-engine runner not found at ${TS_DUAL_ENGINE_RUNNER}. ` +
      `Run: cd ${TS_REPO} && pnpm build`);
  }
  const results = [];
  for (const req of requests) {
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
  const samples = resolveSamples(manifest);
  console.error(
    `[parity-tier1] manifest declares ${samples.length} samples (mode=${MODE}` +
      (REPORT_ONLY ? ', report-only' : '') + ')',
  );

  if (MODE === 'parse') {
    console.error('[parity-tier1] running TS engine ...');
    const tsRes = await runTsParse(samples);

    console.error('[parity-tier1] running Java engine (gradle, may take ~30s) ...');
    const javaRes = runJavaParse(samples);

    const rows = classify(tsRes, javaRes, samples);
    writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, total: rows.length, rows }, null, 2));
    printMarkdown(rows, MODE);

    const bad = rows.filter((r) => r.verdict !== 'pass');
    if (bad.length > 0) {
      const msg = `tier1-parity (parse) broken: ${bad.length}/${rows.length} sample(s) did not pass both engines`;
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
    console.error('[parity-tier1] running TS engine (canonicalize→lex→parse→lower) ...');
    const tsRes = await runTsIr(samples);

    console.error('[parity-tier1] running Java engine (gradle CoreIrFingerprintCli, may take ~30s) ...');
    const javaRes = runJavaIr(samples);

    const rows = classifyIr(tsRes, javaRes, samples);
    writeFileSync(REPORT_FILE, JSON.stringify({ mode: MODE, total: rows.length, rows }, null, 2));
    printMarkdownIr(rows, MODE);

    // Trend history (field-level mode only). `divergent-exempt` samples are out
    // of scope for structural parity (ADR 0016) so they leave the denominator:
    // rate = identical / (total - exempt). Matches the dashboard's other rates.
    if (IR_FULL) {
      const identical = rows.filter((r) => r.verdict === 'identical').length;
      const exempt = rows.filter((r) => r.verdict === 'divergent-exempt').length;
      const denom = rows.length - exempt;
      appendHistory('ir', denom, identical, denom - identical);
    }

    // `divergent-exempt` (effect/workflow/interop derived-analysis differences)
    // is informational only — never a structural-parity failure (ADR 0016).
    const bad = rows.filter((r) => r.verdict !== 'identical' && r.verdict !== 'divergent-exempt');
    if (bad.length > 0) {
      const msg = `tier1-parity (ir ${IR_FULL ? 'field-level' : 'fingerprint'}) divergence: ${bad.length}/${rows.length} sample(s) not identical`;
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
  const tsRes = runTsEval(requests);

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

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
