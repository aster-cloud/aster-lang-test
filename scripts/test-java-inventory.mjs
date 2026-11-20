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
  inventoryCountProblem,
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

check('失败行的首个错误文本随判定结果返回（must-reject 门据此取行号、区分崩溃）', () => {
  const out = OUTPUT.replace('| mismatched input |', "| L4:9 mismatched input 'and' |");
  const { results } = judgeSamples(['tier1-equivalence/policies/b.aster'], parseInventoryOutput(out));
  assert.strictEqual(results['tier1-equivalence/policies/b.aster'].ok, false);
  assert.strictEqual(results['tier1-equivalence/policies/b.aster'].err, "L4:9 mismatched input 'and'");
});

check('★错误文本含 U+2028 / U+2029 / U+0085 / U+00A0 时仍记为失败（aster-lang-ts#348，此前 `.` 失配而 fail-open）', () => {
  for (const code of [0x2028, 0x2029, 0x85, 0xa0]) {
    const ch = String.fromCharCode(code);
    const out = OUTPUT.replace('| mismatched input |', `| L4:11 token recognition error at: '${ch}' |`);
    const { results } = judgeSamples(['tier1-equivalence/policies/b.aster'], parseInventoryOutput(out));
    assert.strictEqual(results['tier1-equivalence/policies/b.aster'].ok, false, `U+${code.toString(16)}`);
    assert.strictEqual(results['tier1-equivalence/policies/b.aster'].err, `L4:11 token recognition error at: '${ch}'`);
  }
});

check('计数一致（失败行数 = Fail、OBSERVED 数 = Total）→ 无问题；汇总行被解析', () => {
  const inv = parseInventoryOutput(OUTPUT);
  assert.deepStrictEqual(inv.summary, { total: 3, pass: 2, fail: 1 });
  assert.strictEqual(inventoryCountProblem(inv), null);
});

check('★失败行失配（错误文本含原始换行）→ 失败行数少于 Fail，拒绝给出结论（#226 m-1，此前 fail-open）', () => {
  const out = OUTPUT.replace('| mismatched input |', '| L4:9 unexpected\ntoken |');
  const inv = parseInventoryOutput(out);
  assert.strictEqual(inv.failed.size, 0, '失配行不应被识别');
  const p = inventoryCountProblem(inv);
  assert.ok(p && /parsed 0 failure row\(s\) but the summary says Fail: 1/.test(p), p);
});

check('OBSERVED 行失配 → 已观测数少于 Total，拒绝给出结论', () => {
  const out = OUTPUT.replace('OBSERVED corpus/tier1-equivalence/policies/c.aster', 'OBSERVED  corpus/tier1-equivalence/policies/c.aster extra');
  const p = inventoryCountProblem(parseInventoryOutput(out));
  assert.ok(p && /parsed 2 OBSERVED line\(s\) but the summary says Total: 3/.test(p), p);
});

check('没有汇总行 → 拒绝给出结论', () => {
  const out = OUTPUT.replace(/\n\s*Total:[^\n]*$/, '');
  const p = inventoryCountProblem(parseInventoryOutput(out));
  assert.ok(p && /no "Total: T, Pass: P, Fail: F" summary/.test(p), p);
});

check('gradle -i 前缀缩进与重复输出不影响计数（集合去重，取最后一个汇总行）', () => {
  const twice = OUTPUT + '\n' + OUTPUT.split('\n').map((l) => `    ${l}`).join('\n');
  assert.strictEqual(inventoryCountProblem(parseInventoryOutput(twice)), null);
});

console.log(`\njava-inventory guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
