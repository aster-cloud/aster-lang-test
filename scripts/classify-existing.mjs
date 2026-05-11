#!/usr/bin/env node
/**
 * One-shot migration: classify the existing 390 .aster files into tier1/2/3
 * and copy them into corpus/. Run once, then delete.
 *
 * Strategy:
 *   1. Walk aster-lang-ts/{test,examples} and aster-lang-core/src/test/resources/dual-engine
 *   2. Directory-based routing first (tier3 fixtures bypass inventory):
 *        - parser-error / syntax-tests / lossless / comments / e2e/golden / type-checker
 *        - lsp-* / runtime / truffle / fixtures (subdir-specific)
 *      → tier3-fixtures/<purpose>/
 *   3. Remaining files → run both parsers:
 *        - if Java parses && TS parses && has .cases.json → tier1-equivalence/policies + inputs
 *        - if Java parses && TS parses && no cases     → tier1-equivalence/policies (syntax-only)
 *        - if only TS parses                             → tier2-divergent/ts-only/
 *        - if only Java parses                           → tier2-divergent/java-only/
 *   4. Emit .meta.json next to each file
 *   5. Rewrite .cases.json `policy` path to corpus-relative
 *
 * Usage:
 *   cd aster-lang-test && node scripts/classify-existing.mjs [--dry-run]
 */
import { readdir, readFile, stat, copyFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TS_ROOT = resolve(ROOT, '..', 'aster-lang-ts');
const CORE_ROOT = resolve(ROOT, '..', 'aster-lang-core');
const CORPUS = resolve(ROOT, 'corpus');

const DRY_RUN = process.argv.includes('--dry-run');

const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.git', '.gradle', 'target']);

/**
 * Tier3 routing: relative-path prefix → tier3 sub-bucket.
 * The longest matching prefix wins.
 */
const TIER3_ROUTES = [
  // TS-side
  { prefix: 'test/cnl/programs/parser-tests/', bucket: 'parser-error' },
  { prefix: 'test/cnl/programs/syntax-tests/', bucket: 'parser-error' },
  // i18n samples are lexicon-canonicalize fixtures (not full parse fixtures);
  // they use lexicon-specific keywords/punctuation that the bare parser can't
  // round-trip without additional pipeline steps. Keep them as tier3.
  { prefix: 'test/cnl/programs/i18n/', bucket: 'lexicon-i18n' },
  { prefix: 'test/cnl/programs/zh-CN/', bucket: 'lexicon-i18n' },
  { prefix: 'test/lossless/', bucket: 'lossless' },
  { prefix: 'test/comments/', bucket: 'comments' },
  { prefix: 'test/e2e/golden/ast/', bucket: 'golden-ast' },
  { prefix: 'test/e2e/golden/core/', bucket: 'golden-core' },
  { prefix: 'test/e2e/golden/diagnostics/', bucket: 'golden-diagnostics' },
  { prefix: 'test/type-checker/golden/', bucket: 'type-checker' },
  { prefix: 'test/type-checker/cross-module/', bucket: 'type-checker-xmodule' },
  { prefix: 'test/lsp-multi/', bucket: 'lsp' },
  { prefix: 'test/lsp-index-fixture/', bucket: 'lsp' },
  { prefix: 'test/runtime/retry/', bucket: 'runtime-retry' },
  { prefix: 'test/truffle/', bucket: 'truffle' },
  { prefix: 'test/fixtures/', bucket: 'fixtures' },
  { prefix: 'test/policy-converter/', bucket: 'policy-converter' },
];

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && e.name.endsWith('.aster')) {
      yield full;
    }
  }
}

function tier3BucketFor(relPath) {
  let bestMatch = null;
  for (const r of TIER3_ROUTES) {
    if (relPath.startsWith(r.prefix)) {
      if (!bestMatch || r.prefix.length > bestMatch.prefix.length) bestMatch = r;
    }
  }
  return bestMatch?.bucket;
}

/* ------------------------ Inventories ------------------------ */

/** Try parsing source through TS PEG with the given lexicon. Returns { ok, err? }. */
async function tryTsParse(source, tsModules, lexicon) {
  try {
    tsModules.initializeDefaultLexicons();
    const canonical = tsModules.canonicalize(source, lexicon);
    const tokens = tsModules.lex(canonical, lexicon);
    const result = tsModules.parse(tokens, lexicon);
    if (result.diagnostics?.length) {
      return { ok: false, err: result.diagnostics[0].message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e?.message || String(e) };
  }
}

/** Pre-load TS parser modules. */
async function loadTsModules() {
  const tsDist = resolve(TS_ROOT, 'dist/src');
  const { canonicalize } = await import(pathToFileURL(join(tsDist, 'frontend/canonicalizer.js')));
  const { lex } = await import(pathToFileURL(join(tsDist, 'frontend/lexer.js')));
  const { parse } = await import(pathToFileURL(join(tsDist, 'parser.js')));
  const lexicons = await import(pathToFileURL(join(tsDist, 'config/lexicons/index.js')));
  return {
    canonicalize, lex, parse,
    EN_US: lexicons.EN_US,
    ZH_CN: lexicons.ZH_CN,
    DE_DE: lexicons.DE_DE,
    initializeDefaultLexicons: lexicons.initializeDefaultLexicons,
  };
}

function pickLexicon(relPath, tsModules) {
  if (relPath.includes('zh-CN') || relPath.includes('/zh-CN/')) return { lex: tsModules.ZH_CN, name: 'zh-CN' };
  if (relPath.includes('de-DE') || relPath.includes('/de-DE/')) return { lex: tsModules.DE_DE, name: 'de-DE' };
  return { lex: tsModules.EN_US, name: 'en-US' };
}

/**
 * Run the existing Java inventory test and parse its markdown output to get
 * the set of TS files that Java accepts.
 */
async function runJavaInventory() {
  console.error('[classify] running Java inventory (this takes ~30s)...');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('./gradlew', ['test', '--tests', 'TsSampleParseInventoryTest', '--rerun-tasks', '-i'], {
    cwd: CORE_ROOT,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const output = result.stdout + result.stderr;
  const failing = new Set();
  const passing = new Set();
  for (const line of output.split('\n')) {
    // Strip leading whitespace inserted by gradle "    | ... | ..."
    const m = line.match(/^\s+\| ([^|]+?) \| (✅|❌) \|/);
    if (m) {
      const rel = m[1].trim();
      if (m[2] === '❌') failing.add(rel); else passing.add(rel);
    }
  }
  console.error(`[classify] Java inventory: ${passing.size} pass, ${failing.size} fail`);
  return { passing, failing };
}

/* ------------------------ JavaParseHelper bridge ------------------------ */

let _javaProc = null;
let _javaQueue = [];

async function startJavaHelper() {
  const { spawn } = await import('node:child_process');

  // Build classpath: include test classes + main classes + antlr runtime
  const { spawnSync } = await import('node:child_process');
  const cpResult = spawnSync('./gradlew', ['-q', 'printTestClasspath'], { cwd: CORE_ROOT, encoding: 'utf8' });
  let classpath;
  if (cpResult.status === 0 && cpResult.stdout.trim()) {
    classpath = cpResult.stdout.trim();
  } else {
    // Fallback: build it ourselves
    const classes = resolve(CORE_ROOT, 'build/classes/java/main');
    const testClasses = resolve(CORE_ROOT, 'build/classes/java/test');
    const resources = resolve(CORE_ROOT, 'build/resources/main');
    // Find antlr runtime jar in gradle cache
    const findResult = spawnSync('find', [
      resolve(process.env.HOME, '.gradle/caches/modules-2/files-2.1/org.antlr/antlr4-runtime'),
      '-name', 'antlr4-runtime-*.jar'
    ], { encoding: 'utf8' });
    const antlrJar = findResult.stdout.trim().split('\n')[0];
    classpath = [classes, testClasses, resources, antlrJar].join(':');
  }

  const proc = spawn('java', ['-cp', classpath, 'aster.core.dualengine.JavaParseHelper'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[java-helper-stderr] ${chunk}`);
  });

  // Line-based reader
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const resolver = _javaQueue.shift();
      if (resolver) resolver(line);
    }
  });

  _javaProc = proc;
}

function stopJavaHelper() {
  if (_javaProc) {
    _javaProc.stdin.end();
    _javaProc = null;
  }
}

async function tryJavaParse(source) {
  // Write source to a temp file (helper reads paths from stdin).
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'aster-parse-'));
  const tmpFile = join(dir, 'sample.aster');
  writeFileSync(tmpFile, source, 'utf8');

  if (!_javaProc) await startJavaHelper();

  return new Promise((resolveFn) => {
    _javaQueue.push((line) => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      if (line === 'OK') resolveFn({ ok: true });
      else resolveFn({ ok: false, err: line.replace(/^FAIL: /, '') });
    });
    _javaProc.stdin.write(tmpFile + '\n');
  });
}

/* ------------------------ Source discovery ------------------------ */

async function discoverTsFiles() {
  const files = [];
  // examples/
  for await (const f of walk(resolve(TS_ROOT, 'examples'))) files.push(f);
  // test/
  for await (const f of walk(resolve(TS_ROOT, 'test'))) files.push(f);
  return files.sort();
}

async function discoverJavaCorpus() {
  const files = [];
  for await (const f of walk(resolve(CORE_ROOT, 'src/test/resources/dual-engine/policies'))) files.push(f);
  return files.sort();
}

/* ------------------------ Migration ops ------------------------ */

async function ensureDir(p) {
  if (!DRY_RUN) await mkdir(p, { recursive: true });
}

/**
 * Resolve the actual destination, disambiguating by source if a file already
 * exists at destAbs. This is critical because both Java corpus and many TS
 * sub-directories have same-named files (e.g. `01-hello.aster` exists in 3+
 * i18n dirs). Strategy: progressively prepend source-dir tokens.
 */
async function disambiguate(destAbs, srcAbs) {
  try { await stat(destAbs); } catch { return destAbs; }
  const dir = dirname(destAbs);
  const base = basename(destAbs, '.aster');
  // Build slug from source dir path (last 2 segments) to keep names traceable.
  const srcDir = dirname(srcAbs).split('/').slice(-2).join('-');
  let candidate = join(dir, `${base}__${srcDir}.aster`);
  let i = 0;
  while (true) {
    try { await stat(candidate); } catch { return candidate; }
    i++;
    candidate = join(dir, `${base}__${srcDir}-${i}.aster`);
  }
}

async function placeFile(srcAbs, destAbs, meta, casesAbs) {
  destAbs = await disambiguate(destAbs, srcAbs);
  if (DRY_RUN) {
    console.error(`  [dry] ${srcAbs} → ${destAbs}`);
    return;
  }
  await ensureDir(dirname(destAbs));
  await copyFile(srcAbs, destAbs);
  await writeFile(destAbs.replace(/\.aster$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  if (casesAbs) {
    const casesDest = destAbs
      .replace('/policies/', '/inputs/')
      .replace(/\.aster$/, '.cases.json');
    await ensureDir(dirname(casesDest));
    const raw = await readFile(casesAbs, 'utf8');
    const obj = JSON.parse(raw);
    obj.policy = relative(CORPUS, destAbs);
    await writeFile(casesDest, JSON.stringify(obj, null, 2) + '\n');
  }
}

/* ------------------------ Main ------------------------ */

async function main() {
  console.error(`[classify] root: ${ROOT}`);
  console.error(`[classify] dry-run: ${DRY_RUN}`);

  const tsModules = await loadTsModules();
  const tsFiles = await discoverTsFiles();
  const javaCorpus = await discoverJavaCorpus();
  console.error(`[classify] discovered ${tsFiles.length} TS files, ${javaCorpus.length} Java corpus`);

  const java = await runJavaInventory();

  const tally = { tier1: 0, 'tier2/ts-only': 0, 'tier2/java-only': 0, tier3: 0 };

  /* --- TS-side files --- */
  for (const abs of tsFiles) {
    const rel = relative(TS_ROOT, abs);
    const t3 = tier3BucketFor(rel);
    if (t3) {
      const dest = resolve(CORPUS, 'tier3-fixtures', t3, basename(abs));
      await placeFile(abs, dest, {
        tier: 3,
        bucket: t3,
        engines: ['ts'],
        lexicon: 'en-US',
        source: `aster-lang-ts/${rel}`,
      });
      tally.tier3++;
      continue;
    }
    // Java inventory only prints failures; absence in `failing` == pass.
    // Java inventory only prints failures; absence in `failing` == pass.
    const javaPasses = !java.failing.has(rel);
    const source = await readFile(abs, 'utf8');
    const { lex: lexicon, name: lexiconName } = pickLexicon(rel, tsModules);
    const tsResult = await tryTsParse(source, tsModules, lexicon);

    if (javaPasses && tsResult.ok) {
      const dest = resolve(CORPUS, 'tier1-equivalence/policies', basename(abs));
      await placeFile(abs, dest, {
        tier: 1,
        engines: ['java', 'ts'],
        lexicon: lexiconName,
        source: `aster-lang-ts/${rel}`,
      });
      tally.tier1++;
    } else if (tsResult.ok && !javaPasses) {
      const dest = resolve(CORPUS, 'tier2-divergent/ts-only', basename(abs));
      await placeFile(abs, dest, {
        tier: 2,
        engines: ['ts'],
        lexicon: lexiconName,
        source: `aster-lang-ts/${rel}`,
        knownGaps: ['java-cannot-parse'],
        divergenceType: 'grammar-gap',
      });
      tally['tier2/ts-only']++;
    } else if (javaPasses && !tsResult.ok) {
      // Rare: TS source that TS itself can't parse (file corruption?) but Java can.
      // Put in ts-only with a flag.
      const dest = resolve(CORPUS, 'tier2-divergent/java-only', basename(abs));
      await placeFile(abs, dest, {
        tier: 2,
        engines: ['java'],
        source: `aster-lang-ts/${rel}`,
        knownGaps: ['ts-cannot-parse-its-own-sample'],
        divergenceType: 'unexpected',
      });
      tally['tier2/java-only']++;
    } else {
      // Both fail — put in tier3/broken
      const dest = resolve(CORPUS, 'tier3-fixtures/broken', basename(abs));
      await placeFile(abs, dest, {
        tier: 3,
        bucket: 'broken',
        engines: [],
        source: `aster-lang-ts/${rel}`,
        notes: 'Neither parser accepts; preserved for triage.',
      });
      tally.tier3++;
    }
  }

  /* --- Java corpus (dual-engine/policies/*.aster) ---
   * IMPORTANT: these were never actually run through the Java parser before
   * extraction; the cross-lang test only spawned the TS engine via subprocess.
   * So we cannot assume "TS parses ⇒ both parse". Instead we use the Java
   * parser explicitly via a tiny gradle/shell call. To keep this script
   * simple (and avoid double-Java-startup cost), we mark these as ts-only
   * with `from-java-corpus` flag when TS accepts them but Java rejects, and
   * rely on the post-migration TsSampleParseInventoryTest to validate.
   *
   * Practical shortcut: write all 30 Java corpus samples as tier1 candidates
   * but flag them with `requiresPostMigrationValidation: true`. The inventory
   * test will then catch the 8 that Java rejects and produce a reclassify
   * report. (Run `node scripts/reclassify-java-corpus.mjs` after the first
   * inventory pass.)
   *
   * For now: if TS accepts → tier1; if TS rejects → tier2/java-only.
   * The 8 java-corpus-but-Java-rejects discrepancy will surface in the
   * inventory test output and be moved manually (or by a follow-up script).
   */
  const javaInputsDir = resolve(CORE_ROOT, 'src/test/resources/dual-engine/inputs');
  for (const abs of javaCorpus) {
    const name = basename(abs);
    const casesAbs = resolve(javaInputsDir, name.replace(/\.aster$/, '.cases.json'));
    const hasCases = await stat(casesAbs).then(() => true).catch(() => false);
    const source = await readFile(abs, 'utf8');
    const tsResult = await tryTsParse(source, tsModules, tsModules.EN_US);
    const javaResult = await tryJavaParse(source);

    if (tsResult.ok && javaResult.ok) {
      // Both parse → tier1 with cases (golden)
      const dest = resolve(CORPUS, 'tier1-equivalence/policies', name);
      await placeFile(abs, dest, {
        tier: 1,
        engines: ['java', 'ts'],
        lexicon: 'en-US',
        source: `aster-lang-core/src/test/resources/dual-engine/policies/${name}`,
        capabilities: ['cases-golden'],
      }, hasCases ? casesAbs : null);
      tally.tier1++;
    } else if (tsResult.ok && !javaResult.ok) {
      // TS-only — Java rejects its own historical corpus
      const dest = resolve(CORPUS, 'tier2-divergent/ts-only', name);
      await placeFile(abs, dest, {
        tier: 2,
        engines: ['ts'],
        lexicon: 'en-US',
        source: `aster-lang-core/src/test/resources/dual-engine/policies/${name}`,
        knownGaps: ['java-grammar-rejects-if-colon-block'],
        divergenceType: 'grammar-gap',
      });
      tally['tier2/ts-only']++;
    } else if (!tsResult.ok && javaResult.ok) {
      // Java-only (and/or, etc.)
      const dest = resolve(CORPUS, 'tier2-divergent/java-only', name);
      await placeFile(abs, dest, {
        tier: 2,
        engines: ['java'],
        lexicon: 'en-US',
        source: `aster-lang-core/src/test/resources/dual-engine/policies/${name}`,
        knownGaps: ['ts-peg-missing-and-or-binary-ops'],
        divergenceType: 'grammar-gap',
      });
      tally['tier2/java-only']++;
    } else {
      // Neither — preserve in broken
      const dest = resolve(CORPUS, 'tier3-fixtures/broken', name);
      await placeFile(abs, dest, {
        tier: 3,
        bucket: 'broken',
        engines: [],
        source: `aster-lang-core/src/test/resources/dual-engine/policies/${name}`,
        notes: 'Java corpus that neither engine parses; preserved for triage.',
      });
      tally.tier3++;
    }
  }

  stopJavaHelper();
  console.error('[classify] tally:', JSON.stringify(tally, null, 2));
}

main().catch((e) => { console.error(e); stopJavaHelper(); process.exit(1); });
