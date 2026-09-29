#!/usr/bin/env node
/**
 * 文档内联计数锈蚀检测（scripts/lib/doc-rot.mjs）的回归测试（无框架，纯 node:assert）。
 *
 * ★为什么必须有：`tag-eval-exempt.mjs --check` 读的是真实文档，通过时看不出
 * 检测是否真的在工作——此前 EVAL-EXEMPTIONS.md 一处 144 vs 150 的自相矛盾
 * 就是在「--check 全绿」下存活的（issue #149）。这里用构造文本证明：
 * 内联计数会被抓到、历史区间不受波及、区间标题被改名时不会静默放行。
 *
 * 用法：node scripts/test-doc-rot.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { findInlineCounts, sliceRegion } from './lib/doc-rot.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

const DOC = [
  '# Manifest',
  '',
  '## Current state',
  '| parse | 217/217 = 1.0000 | gating |',
  'coverage is 137 / 143 eval-able',
  'see the latest row of `equivalence-history.csv`',
  '',
  '## Historical baseline',
  '14 divergent / 197 corpus = 7.1%; held 255/255 = 1.0000 for 4 nights',
].join('\n');

// ---- sliceRegion ----

check('无 from/until → 整份文档', () => {
  assert.strictEqual(sliceRegion(DOC), DOC);
});

check('until 截断在标题之前（不含标题本身）', () => {
  const r = sliceRegion(DOC, { until: /^## Historical baseline/m });
  assert.ok(r.endsWith('`equivalence-history.csv`\n\n'));
  assert.ok(!r.includes('Historical'));
});

check('from 找不到 → null（区间被改名不能静默通过）', () => {
  assert.strictEqual(sliceRegion(DOC, { from: /^## 一致率/m }), null);
});

// ---- findInlineCounts ----

check('★实时区间内的 N/N 与 = 1.0000 全部命中，行号正确', () => {
  const hits = findInlineCounts(DOC, { until: /^## Historical baseline/m });
  assert.deepStrictEqual(hits, [
    { line: 4, match: '217/217' },
    { line: 4, match: '= 1.0000' },
    { line: 5, match: '137 / 143' },
  ]);
});

check('历史区间不在受检范围内（255/255 不报）', () => {
  const hits = findInlineCounts(DOC, { until: /^## Historical baseline/m });
  assert.ok(hits.every((h) => h.match !== '255/255'));
});

check('from + until 圈定中段，行号仍按整份文档计', () => {
  const hits = findInlineCounts(DOC, { from: /^## Current state/m, until: /^## Historical/m });
  assert.strictEqual(hits.length, 3);
  assert.strictEqual(hits[0].line, 4);
});

check('区间标题缺失 → 返回单条 <region not found> 漂移，而非空数组', () => {
  const hits = findInlineCounts(DOC, { from: /^## 一致率/m, until: /^## /m });
  assert.deepStrictEqual(hits, [{ line: 0, match: '<region not found>' }]);
});

check('只含指针的文本 → 无命中', () => {
  const clean = '| parse | latest row of `equivalence-history.csv` | PR-blocking |\n2026-07-15 audit #58 v1.0.30';
  assert.deepStrictEqual(findInlineCounts(clean), []);
});

check('日期、issue 号、路径、版本号不误报', () => {
  const noise = '2026-09-28 #147 packages/js/src/ir-normalize.ts 1.0.30 4+ nights = 0 divergent';
  assert.deepStrictEqual(findInlineCounts(noise), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
