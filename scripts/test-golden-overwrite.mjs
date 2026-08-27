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
import { detectGoldenLoss, caseKey, FILE_ABSENT } from './lib/golden-overwrite.mjs';

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

check('文件不存在（FILE_ABSENT 哨兵）→ 放行', () => {
  assert.deepStrictEqual(detectGoldenLoss(FILE_ABSENT, [{ name: 'a' }], 'e'), { ok: true });
});

check('★内容为合法 JSON null → unparseable，不得当成"文件不存在"放行', () => {
  // Codex 复审抓出：原实现用 null 兼表"不存在"，于是一个内容真是 `null`
  // 的既有文件会被无授权整体覆盖。哨兵与数据必须分离。
  const r = detectGoldenLoss(null, [{ name: 'a' }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparseable');
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

// ---- 变异审计补的两处高危盲区 ----

check('★新集合为空 → 报 lost 全部旧 case（整体清空是最严重的丢失形态）', () => {
  // ★本文件头部就写着"我把 38 条已验证 golden 覆盖成了 1 条"，
  //   但**从来没有一条测试给 nextCases 传过 []**——最极端的事故形态
  //   （覆盖成 0 条）此前零覆盖，加一行 `if (!nextCases.length) return {ok:true}`
  //   就能静默放行且全绿。用真实事故的 38 条规模钉死。
  const prev = { entry: 'e', cases: Array.from({ length: 38 }, (_, i) => ({ name: `c${i}` })) };
  const r = detectGoldenLoss(prev, [], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'lost');
  assert.strictEqual(r.lost.length, 38, '必须报出全部 38 条，不能只报首条');
});

check('★多条丢失必须全部报出（防只保留首条）', () => {
  const r = detectGoldenLoss(doc('e', ['a', 'b', 'c', 'd']), [{ name: 'a' }], 'e');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.lost.sort(), ['e/b', 'e/c', 'e/d']);
});

check('★FILE_ABSENT 必须是不可被 JSON 内容伪造的 Symbol', () => {
  // ★哨兵若退化成字符串 'file-absent'，一个内容恰为该字符串的既有文件
  //   就会被当成"文件不存在"而无授权整体覆盖——正是 null/哨兵混用那个
  //   漏洞换了个马甲。原测试只验了"null 不是哨兵"，没验"哨兵不可伪造"。
  assert.strictEqual(typeof FILE_ABSENT, 'symbol');
  for (const forged of ['file-absent', 'Symbol(file-absent)', 0, false, '', NaN]) {
    assert.strictEqual(
      detectGoldenLoss(forged, [{ name: 'a' }], 'e').ok,
      false,
      `${String(forged)} 不得被当成"文件不存在"而放行`,
    );
  }
});

check('★unparseable 必须带 lost:[]（调用方会读 .lost.length）', () => {
  // 去掉该字段时调用方 result.lost.length 直接崩，此前测试无感
  const r = detectGoldenLoss(undefined, [{ name: 'a' }], 'e');
  assert.ok(Array.isArray(r.lost), 'lost 必须是数组，否则调用方崩溃');
  assert.strictEqual(r.lost.length, 0);
});

check('★caseKey 用 ?? 而非 ||：entry 为空串时不得回退到文档级', () => {
  // `||` 会把合法的空串 entry 当成缺省，静默改变归属
  assert.strictEqual(caseKey({ name: 'n', entry: '' }, 'doc'), ' n');
});

console.log(`\ngolden-overwrite guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
