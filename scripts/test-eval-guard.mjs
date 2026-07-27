#!/usr/bin/env node
/**
 * eval-cases 守卫的回归测试（无测试框架，纯 node:assert）。
 *
 * ★测试**生产逻辑本身**：import scripts/lib/eval-cases.mjs 的 collectEvalCaseProblem /
 * validateEvalCasesDocument —— 与 parity-tier1.mjs 守卫和 tag-eval-exempt 的分类共用同一
 * helper（单一事实源，无内联副本漂移；Codex 复审要求）。
 *
 * 验证：非豁免样本必须有**有效** golden，否则报告问题；豁免样本缺 golden 由调用方（守卫）
 * 依 isExempt 放行，故 helper 只判"文档是否有效"，豁免语义在守卫层。覆盖失效形态：
 * 缺文件 / 解析失败 / 缺 entry / cases 非数组 / cases 空数组。
 *
 * 用法：node scripts/test-eval-guard.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { validateEvalCasesDocument, collectEvalCaseProblem } from './lib/eval-cases.mjs';

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

console.log('eval-cases 守卫回归测试（测生产 helper）:');

// —— collectEvalCaseProblem：文件层 + 文档层综合判定 ——
check('缺文件 → 报告问题', () => {
  const p = collectEvalCaseProblem({ exists: false, parseError: null, doc: null });
  assert.match(p, /缺 .cases.json/);
});

check('JSON 解析失败 → 报告问题', () => {
  const p = collectEvalCaseProblem({ exists: true, parseError: 'Unexpected token', doc: null });
  assert.match(p, /解析失败/);
});

check('缺 entry → 报告问题', () => {
  const p = collectEvalCaseProblem({ exists: true, parseError: null, doc: { cases: [{ input: [] }] } });
  assert.match(p, /缺 entry/);
});

check('cases 非数组 → 报告问题', () => {
  const p = collectEvalCaseProblem({ exists: true, parseError: null, doc: { entry: 'e', cases: {} } });
  assert.match(p, /非数组/);
});

check('cases 空数组 → 报告问题', () => {
  const p = collectEvalCaseProblem({ exists: true, parseError: null, doc: { entry: 'e', cases: [] } });
  assert.match(p, /空数组/);
});

check('有效 golden → 无问题(null)', () => {
  const p = collectEvalCaseProblem({ exists: true, parseError: null, doc: { entry: 'e', cases: [{ input: [] }] } });
  assert.strictEqual(p, null);
});

// —— validateEvalCasesDocument：纯文档层 ——
check('validate: 有效文档 → null', () => {
  assert.strictEqual(validateEvalCasesDocument({ entry: 'e', cases: [{ input: [] }] }), null);
});

check('validate: 非对象 → 报错原因', () => {
  assert.match(validateEvalCasesDocument(null), /非对象/);
});

console.log(`\n${pass} 过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
