#!/usr/bin/env node
/**
 * must-reject（双引擎都必须拒绝）判定与 manifest 守卫的回归测试（纯 node:assert）。
 *
 * ★测试**生产逻辑本身**：parity-tier1.mjs 的 must-reject 判定全部来自
 * scripts/lib/must-reject.mjs。锁住的核心语义：
 *   - 只有两侧都**以解析错误**拒绝才算通过；任一侧接受即失败，且报告点名是哪一侧；
 *   - 崩溃（非诊断类异常）不算拒绝——否则引擎挂掉会被误读成「正确拒绝」；
 *   - 声明了 expectErrorLine 时，两侧的首个错误都必须落在该行；
 *   - tier1-reject/ 下的样本必须在 manifest.mustReject 里，不得静默跳过。
 *
 * 用法：node scripts/test-must-reject.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import {
  MUST_REJECT_DIR,
  judgeMustReject,
  javaRejection,
  checkMustRejectManifest,
} from './lib/must-reject.mjs';

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

const REJ = (line) => ({ ok: false, crash: false, line, err: 'syntax error' });
const ACC = { ok: true };
const CRASH = { ok: false, crash: true, line: null, err: 'TypeError: boom' };

check('两侧都以解析错误拒绝 → rejected', () => {
  assert.strictEqual(judgeMustReject({ ts: REJ(4), java: REJ(4) }).verdict, 'rejected');
});

check('★只有 Java 拒绝（TS 接受）→ ts-accepted，原因点名 TS', () => {
  const r = judgeMustReject({ ts: ACC, java: REJ(4) });
  assert.strictEqual(r.verdict, 'ts-accepted');
  assert.match(r.reason, /TS accepted/);
});

check('★只有 TS 拒绝（Java 接受）→ java-accepted，原因点名 Java', () => {
  const r = judgeMustReject({ ts: REJ(4), java: ACC });
  assert.strictEqual(r.verdict, 'java-accepted');
  assert.match(r.reason, /Java accepted/);
});

check('两侧都接受 → both-accepted', () => {
  assert.strictEqual(judgeMustReject({ ts: ACC, java: ACC }).verdict, 'both-accepted');
});

check('★崩溃不算拒绝：TS 崩溃 → ts-crashed；Java 崩溃 → java-crashed', () => {
  assert.strictEqual(judgeMustReject({ ts: CRASH, java: REJ(4) }).verdict, 'ts-crashed');
  assert.strictEqual(judgeMustReject({ ts: REJ(4), java: CRASH }).verdict, 'java-crashed');
});

check('接受优先于崩溃：一侧接受、另一侧崩溃时报告接受方', () => {
  assert.strictEqual(judgeMustReject({ ts: ACC, java: CRASH }).verdict, 'ts-accepted');
});

check('声明 expectLine 且两侧错误都在该行 → rejected', () => {
  assert.strictEqual(judgeMustReject({ ts: REJ(4), java: REJ(4), expectLine: 4 }).verdict, 'rejected');
});

check('★声明 expectLine 而任一侧错误不在该行 → line-mismatch，原因含两侧行号', () => {
  const r = judgeMustReject({ ts: REJ(4), java: REJ(1), expectLine: 4 });
  assert.strictEqual(r.verdict, 'line-mismatch');
  assert.match(r.reason, /ts=L4/);
  assert.match(r.reason, /java=L1/);
});

check('声明 expectLine 而一侧没有行号 → line-mismatch', () => {
  assert.strictEqual(judgeMustReject({ ts: REJ(null), java: REJ(4), expectLine: 4 }).verdict, 'line-mismatch');
});

check('未声明 expectLine → 不比较行号', () => {
  assert.strictEqual(judgeMustReject({ ts: REJ(9), java: REJ(1) }).verdict, 'rejected');
});

check('javaRejection：语法错误行解析出行号且非崩溃', () => {
  assert.deepStrictEqual(
    javaRejection({ ok: false, err: "L4:9 mismatched input 'and' expecting {'.'}" }),
    { ok: false, crash: false, line: 4, err: "L4:9 mismatched input 'and' expecting {'.'}" },
  );
});

check('★javaRejection：THROWN 行判为崩溃', () => {
  const r = javaRejection({ ok: false, err: 'THROWN: NullPointerException: x' });
  assert.strictEqual(r.crash, true);
  assert.strictEqual(r.line, null);
});

check('javaRejection：接受原样返回 ok=true', () => {
  assert.deepStrictEqual(javaRejection({ ok: true }), { ok: true });
});

check('javaRejection：失败却无错误文本 → 不判崩溃、行号为 null', () => {
  assert.deepStrictEqual(javaRejection({ ok: false }), { ok: false, crash: false, line: null, err: null });
});

// ---- manifest 守卫 ----
const REL = (n) => `${MUST_REJECT_DIR}/${n}.aster`;
const META_OK = { expect: 'reject', expectErrorLine: 4 };

function guard(over = {}) {
  return checkMustRejectManifest({
    mustReject: [REL('a'), REL('b')],
    samples: ['tier1-equivalence/policies/x.aster'],
    onDisk: [REL('a'), REL('b')],
    metaOf: () => META_OK,
    ...over,
  });
}

check('一致的 manifest → 无问题', () => {
  assert.deepStrictEqual(guard(), []);
});

check('mustReject 缺省 → 视为空列表；但目录里有样本时报孤儿', () => {
  assert.deepStrictEqual(guard({ mustReject: undefined, onDisk: [] }), []);
  const p = guard({ mustReject: undefined });
  assert.ok(p.some((x) => /not in manifest\.mustReject/.test(x)), p.join('\n'));
});

check('mustReject 不是数组 → 报错', () => {
  assert.ok(guard({ mustReject: 'x' }).some((x) => /must be an array/.test(x)));
});

check('★目录里有样本未登记 → 报孤儿（不得静默跳过）', () => {
  const p = guard({ onDisk: [REL('a'), REL('b'), REL('c')] });
  assert.ok(p.some((x) => x.includes(REL('c')) && /not in manifest\.mustReject/.test(x)), p.join('\n'));
});

check('mustReject 条目不在 tier1-reject/ 下 → 报错', () => {
  const p = guard({ mustReject: [REL('a'), REL('b'), 'tier1-equivalence/policies/y.aster'] });
  assert.ok(p.some((x) => /must live under/.test(x)), p.join('\n'));
});

check('同一路径同时在 samples 与 mustReject → 报错', () => {
  const p = guard({ samples: [REL('a')] });
  assert.ok(p.some((x) => /both samples and mustReject/.test(x)), p.join('\n'));
});

check('重复条目 → 报错', () => {
  const p = guard({ mustReject: [REL('a'), REL('a'), REL('b')] });
  assert.ok(p.some((x) => /duplicate/.test(x)), p.join('\n'));
});

check('meta 未声明 expect=reject → 报错', () => {
  const p = guard({ metaOf: (rel) => (rel === REL('b') ? { expectErrorLine: 4 } : META_OK) });
  assert.ok(p.some((x) => x.includes(REL('b')) && /expect.*reject/.test(x)), p.join('\n'));
});

check('expectErrorLine 不是正整数 → 报错', () => {
  const p = guard({ metaOf: () => ({ expect: 'reject', expectErrorLine: '4' }) });
  assert.ok(p.some((x) => /expectErrorLine/.test(x)), p.join('\n'));
});

check('expectErrorLine 可省略', () => {
  assert.deepStrictEqual(guard({ metaOf: () => ({ expect: 'reject' }) }), []);
});

console.log(`\nmust-reject guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
