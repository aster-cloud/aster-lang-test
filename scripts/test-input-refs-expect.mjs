#!/usr/bin/env node
/**
 * scripts/lib/input-refs-expect.mjs 的回归测试（纯 node:assert）：期望 inputRefs / construct 与两引擎结果的核对规则。
 * 用法：node scripts/test-input-refs-expect.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { inputRefsOf, inputRefsProblems } from './lib/input-refs-expect.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

const ir = { decls: [
  { kind: 'Data', name: 'Req' },
  { kind: 'Func', name: 'helper' },
  { kind: 'Func', name: 'decide', inputRefs: ['context.amount'] },
] };
const starIr = { decls: [{ kind: 'Func', name: 'decide', inputRefs: ['*'] }] };

check('inputRefsOf：缺字段记 null，只取 Func', () => {
  assert.deepStrictEqual(inputRefsOf(ir), { helper: null, decide: ['context.amount'] });
});
check('无 expectedInputRefs 时不适用', () => {
  assert.deepStrictEqual(inputRefsProblems('ts', {}, ir, {}), []);
});
check('期望一致时无问题', () => {
  assert.deepStrictEqual(inputRefsProblems('ts', { expectedInputRefs: { helper: null, decide: ['context.amount'] } }, ir, {}), []);
});
check('路径不同即报告', () => {
  const p = inputRefsProblems('java', { expectedInputRefs: { helper: null, decide: ['action'] } }, ir, {});
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /^java: decide\.inputRefs=/);
});
check('期望须列出每个函数，且不能多列', () => {
  assert.strictEqual(inputRefsProblems('ts', { expectedInputRefs: { decide: ['context.amount'] } }, ir, {}).length, 1);
  assert.strictEqual(inputRefsProblems('ts', { expectedInputRefs: { helper: null, decide: ['context.amount'], gone: null } }, ir, {}).length, 1);
});
check('["*"] 必须写明 construct，且 construct 须一致', () => {
  assert.strictEqual(inputRefsProblems('ts', { expectedInputRefs: { decide: ['*'] } }, starIr, { decide: 'recursion' }).length, 2);
  const meta = { expectedInputRefs: { decide: ['*'] }, expectedInputRefConstructs: { decide: 'recursion' } };
  assert.deepStrictEqual(inputRefsProblems('ts', meta, starIr, { decide: 'recursion' }), []);
  assert.strictEqual(inputRefsProblems('ts', meta, starIr, { decide: 'inline-depth' }).length, 1);
  assert.strictEqual(inputRefsProblems('java', meta, starIr, undefined).length, 1);
});
check('引擎给出期望之外的 construct 即报告', () => {
  assert.strictEqual(inputRefsProblems('ts', { expectedInputRefs: { helper: null, decide: ['context.amount'] } }, ir, { decide: 'x' }).length, 1);
});
check('expectedInputRefs 形态错误即报告', () => {
  assert.strictEqual(inputRefsProblems('ts', { expectedInputRefs: [] }, ir, {}).length, 1);
});

console.log(`\ninput-refs-expect: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
