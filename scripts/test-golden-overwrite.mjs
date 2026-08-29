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
import { detectGoldenLoss, caseKey, caseAssertion, FILE_ABSENT } from './lib/golden-overwrite.mjs';

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

// ---- 同键改写（Codex 第五轮的主阻塞项）----
//
// ★护栏原先只比 entry+name，于是「键相同、断言内容被改」读作「没有丢失」
//   而静默放行。实测能把一条名为「未成年 premium = 100」的 golden
//   改写成 expectedOutput: 999 且 exit 0——名字承诺 100、断言体断言 999。

check('★同键但 expectedOutput 被改 → 必须报 rewritten', () => {
  const prev = { entry: 'e', cases: [{ name: 'x', input: [1], expectedOutput: 100 }] };
  const r = detectGoldenLoss(prev, [{ name: 'x', input: [1], expectedOutput: 999 }], 'e');
  assert.strictEqual(r.ok, false, '断言被改写不得放行');
  assert.strictEqual(r.reason, 'rewritten');
  assert.strictEqual(r.rewritten.length, 1);
  assert.ok(r.rewritten[0].includes('100') && r.rewritten[0].includes('999'), '须列出前后值');
});

check('★同键但 input 被改 → 必须报 rewritten（输入变了断言就换了对象）', () => {
  const prev = { entry: 'e', cases: [{ name: 'x', input: ['premium', 0], expectedOutput: 100 }] };
  const r = detectGoldenLoss(prev, [{ name: 'x', input: [999], expectedOutput: 100 }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rewritten');
});

check('★expectError 契约被换成值断言 → 必须报 rewritten', () => {
  const prev = { entry: 'e', cases: [{ name: 'x', input: [1], expectError: true }] };
  const r = detectGoldenLoss(prev, [{ name: 'x', input: [1], expectedOutput: 0 }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rewritten');
});

check('内容完全相同 → 放行（改写检测不得误伤正常重写）', () => {
  const prev = { entry: 'e', cases: [{ name: 'x', input: [1], expectedOutput: 100 }] };
  const r = detectGoldenLoss(prev, [{ name: 'x', input: [1], expectedOutput: 100 }], 'e');
  assert.strictEqual(r.ok, true);
});

check('★丢失优先于改写：两者并存时 reason=lost 且两个清单都在', () => {
  const prev = { entry: 'e', cases: [
    { name: 'a', input: [1], expectedOutput: 1 },
    { name: 'b', input: [2], expectedOutput: 2 },
  ] };
  const r = detectGoldenLoss(prev, [{ name: 'a', input: [1], expectedOutput: 999 }], 'e');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'lost', '有整条丢失时以 lost 为主因');
  assert.deepStrictEqual(r.lost, ['e/b']);
  assert.strictEqual(r.rewritten.length, 1, '被改写的 a 也必须列出');
});

check('★unparseable 分支必须同时带 lost 与 rewritten 空数组（调用方会读 .length）', () => {
  // Codex 指出 unparseable 的 lost 是死字段——调用方确实不读它，
  // 但字段缺失会让任何未来的 .length 访问直接崩，故保留并补齐 rewritten。
  const r = detectGoldenLoss(undefined, [{ name: 'a' }], 'e');
  assert.ok(Array.isArray(r.lost), 'lost 必须是数组');
  assert.ok(Array.isArray(r.rewritten), 'rewritten 必须是数组');
});

check('★caseKey 用 ?? 而非 ||：entry 为空串时不得回退到文档级', () => {
  // `||` 会把合法的空串 entry 当成缺省，静默改变归属
  assert.strictEqual(caseKey({ name: 'n', entry: '' }, 'doc'), ' n');
});

console.log(`\ngolden-overwrite guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
