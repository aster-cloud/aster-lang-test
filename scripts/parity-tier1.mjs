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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
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
  if (!existsSync(HISTORY_FILE)) {
    writeFileSync(HISTORY_FILE, 'timestamp,total,identical,divergent,rate\n');
  }
  appendFileSync(HISTORY_FILE, `${ts},${total},${identical},${divergent},${rate.toFixed(4)}\n`);
  console.error(`[parity-tier1] appended ${mode} history → ${HISTORY_FILE} (${identical}/${total})`);
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
  for (const { rel, abs } of samples) {
    const base = abs.split('/').pop().replace(/\.aster$/, '');
    const casesPath = join(CORPUS, 'tier1-equivalence', 'inputs', `${base}.cases.json`);
    if (!existsSync(casesPath)) continue;
    let cases;
    try {
      cases = JSON.parse(readFileSync(casesPath, 'utf8'));
    } catch {
      continue;
    }
    const entry = cases.entry;
    if (!entry || !Array.isArray(cases.cases)) continue;
    for (let i = 0; i < cases.cases.length; i++) {
      const c = cases.cases[i];
      requests.push({
        rel,
        samplePath: abs,
        entry,
        input: Array.isArray(c.input) ? c.input : [],
        caseIndex: i,
        caseName: c.name || `case ${i}`,
        expected: c.expectedOutput,
      });
    }
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
    if (!t.ok && !j.ok) {
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

  if (bothWrong.length > 0) {
    console.log('## Both-wrong (engines agree but neither matches the golden)\n');
    console.log('Either the `.cases.json` expectedOutput is stale, or both engines share a real bug.\n');
    console.log('| path | case | engine value | expected |');
    console.log('|------|------|--------------|----------|');
    for (const r of bothWrong.slice(0, 30)) {
      console.log(
        `| ${r.path} | ${r.caseName} | ${JSON.stringify(r.tsValue)} | ` +
        `${JSON.stringify(r.expected)} |`,
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
