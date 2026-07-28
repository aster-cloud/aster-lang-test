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
import { validateEvalCasesDocument, collectEvalCaseProblem, entryForCase, expectsError } from './lib/eval-cases.mjs';

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

// —— 多 entry：case 级 entry 覆盖文档级默认 ——
// 背景：一个 policy 常含多条 rule，早期一文件只能测一个 entry，其余 rule 只被解析、
// 从不被求值（隐性 eval 盲区）。case 级 entry 让每条 rule 都能有 golden。

check('validate: case 级 entry 覆盖 → 有效', () => {
  assert.strictEqual(
    validateEvalCasesDocument({
      entry: 'first',
      cases: [{ input: [] }, { entry: 'second', input: [] }],
    }),
    null,
  );
});

check('validate: case entry 为空串 → 报错（否则静默回落换掉被测 rule）', () => {
  assert.match(
    validateEvalCasesDocument({ entry: 'e', cases: [{ entry: '', input: [] }] }),
    /cases\[0\]\.entry/,
  );
});

check('validate: case entry 非字符串 → 报错', () => {
  assert.match(
    validateEvalCasesDocument({ entry: 'e', cases: [{ input: [] }, { entry: 42, input: [] }] }),
    /cases\[1\]\.entry/,
  );
});

check('entryForCase: 无覆盖 → 用文档默认', () => {
  assert.strictEqual(entryForCase({ entry: 'base', cases: [] }, { input: [] }), 'base');
});

check('entryForCase: 有覆盖 → 用 case 级', () => {
  assert.strictEqual(entryForCase({ entry: 'base', cases: [] }, { entry: 'other', input: [] }), 'other');
});

check('entryForCase: 文档级仍必填（存量文件守卫不被削弱）', () => {
  assert.match(validateEvalCasesDocument({ cases: [{ entry: 'only-case-level', input: [] }] }), /缺 entry/);
});


// —— 错误路径用例 expectError（issue #69）——
// 契约：两个引擎都必须失败才算通过；任一侧返回值即判失败。

check('expectsError: 缺省 → false', () => {
  assert.strictEqual(expectsError({ input: [], expectedOutput: 1 }), false);
});

check('expectsError: true → true', () => {
  assert.strictEqual(expectsError({ input: [], expectError: true }), true);
});

check('expectsError: null/undefined 输入不炸', () => {
  assert.strictEqual(expectsError(null), false);
  assert.strictEqual(expectsError(undefined), false);
});

check('validate: expectError=true 合法', () => {
  assert.strictEqual(
    validateEvalCasesDocument({ entry: 'f', cases: [{ input: [1, 0], expectError: true }] }),
    null,
  );
});

check('validate: expectError 写成字符串 → 报错（否则静默退回值比对）', () => {
  assert.match(
    validateEvalCasesDocument({ entry: 'f', cases: [{ input: [], expectError: 'true' }] }),
    /cases\[0\]\.expectError/,
  );
});

check('validate: expectError=false → 报错（省略即可，显式 false 易误读）', () => {
  assert.match(
    validateEvalCasesDocument({ entry: 'f', cases: [{ input: [], expectError: false }] }),
    /cases\[0\]\.expectError/,
  );
});

check('validate: expectError 与 expectedOutput 并存 → 报错（互斥）', () => {
  assert.match(
    validateEvalCasesDocument({
      entry: 'f',
      cases: [{ input: [], expectError: true, expectedOutput: 1 }],
    }),
    /互斥/,
  );
});

check('validate: 普通用例的 expectedOutput 不受影响', () => {
  assert.strictEqual(
    validateEvalCasesDocument({ entry: 'f', cases: [{ input: [], expectedOutput: null }] }),
    null,
  );
});

console.log(`\n${pass} 过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
