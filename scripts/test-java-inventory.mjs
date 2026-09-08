#!/usr/bin/env node
/**
 * java-inventory 解析/判定的回归测试（纯 node:assert）。
 *
 * ★测试**生产逻辑本身**：parity-tier1.mjs 与 equivalence-nightly.mjs 的 Java 侧判定
 * 共用 scripts/lib/java-inventory.mjs（单一事实源）。锁住的核心语义（issue #132）：
 * 「不在失败清单 = 通过」只对**已观测**样本成立；未出现在 OBSERVED 清单里的样本
 * 必须被判为未观测（ok=false），不得默认通过。
 *
 * 用法：node scripts/test-java-inventory.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import {
  INVENTORY_MARKER,
  inventoryOutputProblem,
  parseInventoryOutput,
  judgeSamples,
} from './lib/java-inventory.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

const OUTPUT = [
  '    ' + INVENTORY_MARKER,
  '    Corpus source: cloud.aster-lang:aster-lang-test',
  '    Discovered 3 samples (tier1 + tier2/ts-only)',
  '',
  '    | Sample | Java parse | First error |',
  '    |---|---|---|',
  '    | corpus/tier1-equivalence/policies/b.aster | ❌ | mismatched input |',
  '    === Observed samples (one per line) ===',
  '    OBSERVED corpus/tier1-equivalence/policies/a.aster',
  '    OBSERVED corpus/tier1-equivalence/policies/b.aster',
  '    OBSERVED corpus/tier1-equivalence/policies/c.aster',
  '    === End observed samples ===',
  '',
  '    Total: 3, Pass: 2, Fail: 1, Pass-rate: 66.7%',
].join('\n');

check('输出完整（marker + Discovered + Pass-rate）→ 无问题', () => {
  assert.strictEqual(inventoryOutputProblem(0, OUTPUT), null);
});

check('gradle 非零且无表格 → 报基础设施失败', () => {
  const p = inventoryOutputProblem(1, 'BUILD FAILED\nCould not resolve dependency');
  assert.ok(p && /inventory test failed/.test(p), p);
});

check('gradle 非零但表格已输出（测试断言失败）→ 不算基础设施失败', () => {
  assert.strictEqual(inventoryOutputProblem(1, OUTPUT), null);
});

check('缺 Discovered / Pass-rate → 报输出不完整', () => {
  const p = inventoryOutputProblem(0, INVENTORY_MARKER + '\nDiscovered 3 samples\n');
  assert.ok(p && /incomplete/.test(p), p);
});

check('解析 OBSERVED 与 ❌ 行，路径去掉 corpus/ 前缀', () => {
  const { observed, failed } = parseInventoryOutput(OUTPUT);
  assert.deepStrictEqual([...observed].sort(), [
    'tier1-equivalence/policies/a.aster',
    'tier1-equivalence/policies/b.aster',
    'tier1-equivalence/policies/c.aster',
  ]);
  assert.deepStrictEqual([...failed], ['tier1-equivalence/policies/b.aster']);
});

check('已观测且不在失败清单 → ok；已观测且在失败清单 → 不 ok', () => {
  const inv = parseInventoryOutput(OUTPUT);
  const { results, unobserved } = judgeSamples(
    ['tier1-equivalence/policies/a.aster', 'tier1-equivalence/policies/b.aster'],
    inv,
  );
  assert.strictEqual(results['tier1-equivalence/policies/a.aster'].ok, true);
  assert.strictEqual(results['tier1-equivalence/policies/b.aster'].ok, false);
  assert.deepStrictEqual(unobserved, []);
});

check('★未观测样本不得默认通过：ok=false 且列入 unobserved', () => {
  const inv = parseInventoryOutput(OUTPUT);
  const { results, unobserved } = judgeSamples(
    ['tier1-equivalence/policies/a.aster', 'tier1-equivalence/policies/new.aster'],
    inv,
  );
  assert.strictEqual(results['tier1-equivalence/policies/new.aster'].ok, false);
  assert.match(results['tier1-equivalence/policies/new.aster'].err, /not observed/);
  assert.deepStrictEqual(unobserved, ['tier1-equivalence/policies/new.aster']);
});

check('★旧版 core（无 OBSERVED 行）→ 全部样本判为未观测，而非全部通过', () => {
  const legacy = OUTPUT.split('\n').filter((l) => !/OBSERVED|Observed samples|End observed/.test(l)).join('\n');
  const inv = parseInventoryOutput(legacy);
  assert.strictEqual(inv.observed.size, 0);
  const { results, unobserved } = judgeSamples(['tier1-equivalence/policies/a.aster'], inv);
  assert.strictEqual(results['tier1-equivalence/policies/a.aster'].ok, false);
  assert.strictEqual(unobserved.length, 1);
});

console.log(`\njava-inventory guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
