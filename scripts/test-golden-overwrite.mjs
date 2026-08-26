#!/usr/bin/env node
/**
 * golden 覆盖护栏的回归测试（无框架，纯 node:assert）。
 *
 * ★为什么必须有：这段逻辑原本内联在 gen-cases.mjs 里，而 gen-cases 要真跑
 * 两个引擎（分钟级），没人会为它写快测——于是最该被锁住的分支零覆盖。
 * 实际后果：我把 38 条已验证 golden 覆盖成了 1 条。护栏自身的
 * ReferenceError 被兜底 catch 吞掉，伪装成「文件损坏 → 整体重建」。
 *
 * 用法：node scripts/test-golden-overwrite.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { detectGoldenLoss, caseKey } from './lib/golden-overwrite.mjs';

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

const doc = (entry, names) => ({ entry, cases: names.map((n) => ({ name: n })) });

check('文件不存在 → 放行', () => {
  assert.deepStrictEqual(detectGoldenLoss(null, [{ name: 'a' }], 'e'), { ok: true });
});

check('新集合覆盖旧集合 → 放行', () => {
  const r = detectGoldenLoss(doc('e', ['a']), [{ name: 'a' }, { name: 'b' }], 'e');
  assert.strictEqual(r.ok, true);
});

check('★旧 case 不在新集合 → 报 lost 并列出名字', () => {
  const r = detectGoldenLoss(doc('e', ['a', 'b']), [{ name: 'a' }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'lost');
  assert.deepStrictEqual(r.lost, ['e/b']);
});

check('★解析失败（undefined）→ 报 unparseable，不当作可覆盖', () => {
  const r = detectGoldenLoss(undefined, [{ name: 'a' }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparseable');
});

check('★cases 非数组 → 同样 unparseable（防半损坏文件静默覆盖）', () => {
  const r = detectGoldenLoss({ entry: 'e', cases: 'oops' }, [{ name: 'a' }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparseable');
});

check('★per-case entry 参与键：同名不同 entry 不算同一条', () => {
  const prev = { entry: 'e1', cases: [{ name: 'x', entry: 'e2' }] };
  // 新集合里有同名 x 但 entry 是 e1 —— 不能把它当成 e2/x 已保留
  const r = detectGoldenLoss(prev, [{ name: 'x' }], 'e1');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.lost, ['e2/x']);
});

check('★文档级 entry 变更不应误报：旧 entry 缺省时按旧文档的 entry 归属', () => {
  // 旧文档 entry=old，新文档 entry=new；同名 case 若仍属 old，应报 lost
  const r = detectGoldenLoss(doc('old', ['x']), [{ name: 'x' }], 'new');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.lost, ['old/x']);
});

check('caseKey：per-case entry 优先于文档级', () => {
  assert.strictEqual(caseKey({ name: 'n', entry: 'a' }, 'b'), 'a n');
  assert.strictEqual(caseKey({ name: 'n' }, 'b'), 'b n');
});

check('空 cases 数组 → 放行（无 golden 可丢）', () => {
  assert.strictEqual(detectGoldenLoss({ entry: 'e', cases: [] }, [{ name: 'a' }], 'e').ok, true);
});

console.log(`\ngolden-overwrite guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
