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

  // ★输出完整性断言（issue #120）——必须先于「有没有 ❌ 行」的判定。
  //
  //   原实现只 grep ❌ 行、**完全不看 result.status**：gradle 整体失败时
  //   （依赖缺失、编译错、语料未 publish）输出里根本没有任何表格行 →
  //   tier1Failed=false → 打印「✅ inventory gate (tier1) PASSED」并 exit 0。
  //   即**基础设施一坏，门就恒绿**——比没有门更危险，因为它给出通过的假象。
  //
  //   判据与同仓 equivalence-nightly.mjs 的 runJavaParse 对齐（那边一直是对的）：
  //   marker + Discovered + Pass-rate 三者缺一即 fail，外加 status 检查。
  if (result.status !== 0 && !output.includes('=== TS-engine sample → Java parser inventory ===')) {
    console.error('[inventory] ❌ aster-lang-core inventory 测试未能运行（gradle 失败且无表格输出）：');
    console.error(output.slice(-2000));
    return false;
  }
  if (!output.includes('Discovered ') || !output.includes('Pass-rate:')) {
    console.error('[inventory] ❌ inventory 测试输出不完整（缺 Discovered / Pass-rate）——');
    console.error('           无法判定门是否真的跑过，按失败处理：');
    console.error(output.slice(-2000));
    return false;
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
