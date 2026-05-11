#!/usr/bin/env node
/**
 * Post-migration fixup: re-validate tier1 samples against the real Java parser
 * via JavaParseHelper. Files that Java actually rejects get moved to
 * tier2-divergent/ts-only/ with updated meta.
 *
 * Why: classify-existing.mjs assumed any sample not in the Java inventory's
 * failing list was Java-accepted. But the Java inventory only scans
 * aster-lang-ts/, so the 30 Java-corpus samples were never actually Java-parsed
 * before being copied. This script closes that gap.
 *
 * Run after the initial migration. Idempotent — safe to re-run.
 *
 * Usage:
 *   cd aster-lang-test && node scripts/reclassify-from-java-inventory.mjs
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORE_ROOT = resolve(ROOT, '..', 'aster-lang-core');
const CORPUS = resolve(ROOT, 'corpus');

/* ------------------------ Java helper bridge ------------------------ */

let _javaProc = null;
const _javaQueue = [];

function buildClasspath() {
  const classes = resolve(CORE_ROOT, 'build/classes/java/main');
  const testClasses = resolve(CORE_ROOT, 'build/classes/java/test');
  const resources = resolve(CORE_ROOT, 'build/resources/main');
  const findResult = spawnSync('find', [
    resolve(process.env.HOME, '.gradle/caches'),
    '-name', 'antlr4-runtime-*.jar',
  ], { encoding: 'utf8' });
  const antlrJar = findResult.stdout.trim().split('\n').find((p) =>
    p.includes('antlr4-runtime-4.13') && !p.endsWith('-sources.jar') && !p.endsWith('-javadoc.jar'));
  if (!antlrJar) throw new Error('antlr4-runtime jar not found in ~/.gradle/caches');
  return [classes, testClasses, resources, antlrJar].join(':');
}

function startJavaHelper() {
  const cp = buildClasspath();
  console.error(`[reclassify] java classpath: ${cp}`);
  const proc = spawn('java', ['-cp', cp, 'aster.core.dualengine.JavaParseHelper'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[java-helper-stderr] ${chunk}`));
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
  if (_javaProc) { _javaProc.stdin.end(); _javaProc = null; }
}

function tryJavaParse(asterAbs) {
  return new Promise((resolveFn) => {
    _javaQueue.push((line) => {
      if (line === 'OK') resolveFn({ ok: true });
      else resolveFn({ ok: false, err: line.replace(/^FAIL: /, '') });
    });
    _javaProc.stdin.write(asterAbs + '\n');
  });
}

/* ------------------------ Walk + reclassify ------------------------ */

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.aster')) yield full;
  }
}

async function reclassify() {
  startJavaHelper();
  console.error('[reclassify] scanning tier1-equivalence/...');

  const tier1Dir = resolve(CORPUS, 'tier1-equivalence/policies');
  const tsOnlyDir = resolve(CORPUS, 'tier2-divergent/ts-only');
  await mkdir(tsOnlyDir, { recursive: true });

  let reclassified = 0, kept = 0;

  // Materialize the list first; we mutate the dir while iterating.
  const samples = [...walk(tier1Dir)];

  for (const asterAbs of samples) {
    const javaResult = await tryJavaParse(asterAbs);
    if (javaResult.ok) {
      kept++;
      continue;
    }

    const name = basename(asterAbs);
    const newAster = join(tsOnlyDir, name);
    const oldMeta = asterAbs.replace(/\.aster$/, '.meta.json');
    const newMeta = newAster.replace(/\.aster$/, '.meta.json');

    // Move sample + meta
    await rename(asterAbs, newAster);
    const metaRaw = await readFile(oldMeta, 'utf8');
    const meta = JSON.parse(metaRaw);
    meta.tier = 2;
    meta.engines = ['ts'];
    meta.knownGaps = meta.knownGaps || [];
    meta.knownGaps.push(`java-rejects: ${javaResult.err}`);
    meta.divergenceType = 'grammar-gap';
    delete meta.capabilities; // no longer "cases-golden" for tier1
    await writeFile(newMeta, JSON.stringify(meta, null, 2) + '\n');
    await rmSync(oldMeta);

    // Move cases.json if any (and delete its reference — tier2 doesn't run golden)
    const oldCases = asterAbs
      .replace('/policies/', '/inputs/')
      .replace(/\.aster$/, '.cases.json');
    try {
      const newCases = newAster.replace(/\.aster$/, '.cases.json');
      await rename(oldCases, newCases);
      console.error(`  moved cases: ${basename(oldCases)} (tier2/ts-only retains golden for future grammar fix)`);
    } catch { /* no cases — fine */ }

    console.error(`[reclassify] tier1 → ts-only: ${name} (${javaResult.err})`);
    reclassified++;
  }

  stopJavaHelper();
  console.error(`\n[reclassify] kept ${kept} as tier1, moved ${reclassified} to tier2/ts-only`);
}

reclassify().catch((e) => { console.error(e); stopJavaHelper(); process.exit(1); });
