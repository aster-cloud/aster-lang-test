#!/usr/bin/env node
/**
 * drop 授权参数解析 + 最终退出码合并的回归测试（无框架，纯 node:assert）。
 *
 * ★为什么必须有：这两段逻辑此前内联在 gen-cases.mjs 里，而 gen-cases 要真跑
 * 两个引擎（分钟级），没人会为它写快测——于是**真实发生过的回归抓不到**：
 * 护栏正确打印「✗ 拒绝写入」，进程却 exit 0（末行 `process.exit(problems>0?1:0)`
 * 覆盖了中途设的 `exitCode = 1`），CI 把拒绝读成成功。
 *
 * 用法：node scripts/test-drop-authorization.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { parseDropArgs, finalExitCode } from './lib/drop-authorization.mjs';

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

// ---- parseDropArgs ----

check('未传 --allow-drop → 无授权，不报错', () => {
  const r = parseDropArgs(['spec.json', '--write']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.samples.size, 0);
});

check('★裸 --allow-drop（无样本名）→ MISSING_SAMPLES', () => {
  const r = parseDropArgs(['--write', '--allow-drop', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('★--allow-drop= 空值 → MISSING_SAMPLES（不当作全局放行）', () => {
  const r = parseDropArgs(['--write', '--allow-drop=', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('★有样本名但缺 --drop-reason → MISSING_REASON', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('★--drop-reason 为空白 → 仍视为缺理由', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha', '--drop-reason=   ']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('★--allow-dropfoo=alpha 不是授权（精确匹配，防前缀误判）', () => {
  const r = parseDropArgs(['--write', '--allow-dropfoo=alpha', '--drop-reason=x']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.samples.size, 0, '拼错的 flag 不得授予任何样本');
});

check('正确用法 → 解析出样本集合与理由', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha,beta', '--drop-reason=补真实现']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.samples].sort(), ['alpha', 'beta']);
  assert.strictEqual(r.reason, '补真实现');
});

check('★样本名去空白、忽略空项', () => {
  const r = parseDropArgs(['--allow-drop= alpha , ,beta ', '--drop-reason=x']);
  assert.deepStrictEqual([...r.samples].sort(), ['alpha', 'beta']);
});

check('★授权 alpha 不等于授权 beta（逐样本隔离）', () => {
  const r = parseDropArgs(['--allow-drop=alpha', '--drop-reason=x']);
  assert.ok(r.samples.has('alpha'));
  assert.ok(!r.samples.has('beta'), '未列出的样本不得被放行');
});

// ---- finalExitCode ----

check('★护栏已设 exitCode=1 → 不被 problems=0 覆盖成 0', () => {
  // 这正是上一轮真实发生的回归：拒绝写入却 exit 0
  assert.strictEqual(finalExitCode(1, 0), 1);
});

check('护栏未失败 + 有 problems → 1', () => {
  assert.strictEqual(finalExitCode(undefined, 3), 1);
  assert.strictEqual(finalExitCode(0, 3), 1);
});

check('护栏未失败 + 无 problems → 0', () => {
  assert.strictEqual(finalExitCode(undefined, 0), 0);
  assert.strictEqual(finalExitCode(0, 0), 0);
});

check('★参数校验的 exit 2 不被降级', () => {
  assert.strictEqual(finalExitCode(2, 0), 2);
});

console.log(`\ndrop-authorization guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
