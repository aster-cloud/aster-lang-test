#!/usr/bin/env node
/**
 * Cross-engine inventory runner. Invokes the parser-in-its-own-repo and
 * collects pass/fail counts.
 *
 * Usage:
 *   node scripts/inventory.mjs --parser=ts   [--gate=tier1]
 *   node scripts/inventory.mjs --parser=java [--gate=tier1]
 *
 * --gate=tier1 (default): exit 1 if any tier1 sample fails.
 * --gate=all              exit 1 if any tier1+tier2 sample fails (strict).
 * --gate=none             never exit non-zero (informational mode).
 *
 * Prerequisites:
 *   ts:   aster-lang-ts must be built (`cd ../aster-lang-ts && pnpm build`)
 *   java: aster-lang-core must be built + corpus published to mavenLocal
 *         (`cd ../aster-lang-test/packages/jvm && ./gradlew publishToMavenLocal`)
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs() {
  const out = { parser: null, gate: 'tier1' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--parser=')) out.parser = a.slice('--parser='.length);
    else if (a.startsWith('--gate=')) out.gate = a.slice('--gate='.length);
  }
  if (!out.parser) {
    console.error('Usage: inventory.mjs --parser=ts|java [--gate=tier1|all|none]');
    process.exit(2);
  }
  if (!['ts', 'java'].includes(out.parser)) {
    console.error(`--parser must be 'ts' or 'java', got '${out.parser}'`);
    process.exit(2);
  }
  if (!['tier1', 'all', 'none'].includes(out.gate)) {
    console.error(`--gate must be 'tier1', 'all', or 'none', got '${out.gate}'`);
    process.exit(2);
  }
  return out;
}

function runTsInventory() {
  const tsRoot = resolve(ROOT, '..', 'aster-lang-ts');
  const result = spawnSync(
    'node', ['scripts/java-corpus-parse-inventory.mjs'],
    { cwd: tsRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  return result.status === 0;
}

function runJavaInventory() {
  const coreRoot = resolve(ROOT, '..', 'aster-lang-core');
  const result = spawnSync(
    './gradlew', ['test', '--tests', 'TsSampleParseInventoryTest', '--rerun-tasks', '-i'],
    { cwd: coreRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = (result.stdout || '') + (result.stderr || '');
  // Forward only the markdown table + summary to stdout.
  let inTable = false;
  for (const line of output.split('\n')) {
    if (line.includes('=== TS-engine sample → Java parser inventory ===')) inTable = true;
    if (inTable) process.stdout.write(line.replace(/^    /, '') + '\n');
    if (line.match(/Pass-rate:/)) inTable = false;
  }
  // Tier1 gate: check for any tier1 row marked ❌
  const tier1Failed = output.split('\n').some((l) =>
    l.includes('❌') && l.includes('tier1-equivalence')
  );
  return !tier1Failed;
}

function main() {
  const { parser, gate } = parseArgs();
  console.error(`[inventory] parser=${parser} gate=${gate}`);

  const ok = parser === 'ts' ? runTsInventory() : runJavaInventory();

  if (gate === 'none') {
    process.exit(0);
  }

  if (!ok) {
    console.error(`\n❌ inventory gate (${gate}) FAILED`);
    process.exit(1);
  }
  console.error(`\n✅ inventory gate (${gate}) PASSED`);
}

main();
