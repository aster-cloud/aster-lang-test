#!/usr/bin/env node
/**
 * 语料自带词汇（ADR 0051 §8）的 manifest 形态、守卫与判定回归测试（纯 node:assert）。
 *
 * ★测试**生产逻辑本身**：parity-tier1.mjs 的带词汇判定全部来自 scripts/lib/vocab-corpus.mjs。锁住的核心语义：
 *   - manifest 条目只有两种写法：路径字符串（无词汇）或 { path, vocab: true }；
 *   - 词汇文件必须被认领、vocab 条目必须有词汇文件、tier1-parity/ 下样本必须登记，否则门禁会静默跳过；
 *   - 正例要求两侧都成功且警告码一致；必拒样本要求两侧都在名称解析阶段以同一组码拒绝且含 expectCode，
 *     语法错误 / 崩溃不算「正确拒绝」。
 *
 * 用法：node scripts/test-vocab-corpus.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import {
  vocabPathOf,
  casesPathOf,
  normalizeEntries,
  checkVocabCorpus,
  judgeVocabSample,
  judgeVocabReject,
} from './lib/vocab-corpus.mjs';

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

const OK = (warnings = []) => ({ ok: true, warnings });
const RES = (...codes) => ({ ok: false, stage: 'resolve', codes, err: codes.join(';') });
const SYN = { ok: false, stage: 'syntax', err: 'L3:1 mismatched input' };
const CRASH = { ok: false, stage: 'crash', err: 'boom', crash: true };

// ---- normalizeEntries ----
check('字符串与 { path, vocab: true } 两种条目', () => {
  const { entries, problems } = normalizeEntries(['a.aster', { path: 'b.aster', vocab: true }], 'samples');
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(entries, [{ rel: 'a.aster', vocab: false }, { rel: 'b.aster', vocab: true }]);
});

check('对象条目缺 vocab: true / 多余键 / 缺 path → 报错', () => {
  const { problems } = normalizeEntries(
    [{ path: 'a.aster' }, { path: 'b.aster', vocab: true, lexicon: 'de-DE' }, { vocab: true }, 42],
    'samples',
  );
  assert.strictEqual(problems.length, 4);
});

check('mustReject 缺省视为空列表', () => {
  assert.deepStrictEqual(normalizeEntries(undefined, 'mustReject'), { entries: [], problems: [] });
});

// ---- checkVocabCorpus ----
const S = (rel, vocab = true) => ({ rel, vocab });
const base = {
  samples: [S('tier1-equivalence/policies/x.aster', false), S('tier1-parity/vocab-de/a.aster')],
  mustReject: [S('tier1-reject/vocab-e804.aster')],
  vocabOnDisk: ['tier1-parity/vocab-de/a.vocab.json', 'tier1-reject/vocab-e804.vocab.json'],
  parityAsterOnDisk: ['tier1-parity/vocab-de/a.aster'],
  parityCasesOnDisk: ['tier1-parity/vocab-de/inputs/a.cases.json'],
  metaOf: () => ({ expectCode: 'E804' }),
};

check('一致的语料 → 无问题', () => {
  assert.deepStrictEqual(checkVocabCorpus(base), []);
});

check('vocab 条目缺词汇文件 → 报错', () => {
  const problems = checkVocabCorpus({ ...base, vocabOnDisk: ['tier1-reject/vocab-e804.vocab.json'] });
  assert.ok(problems.some((p) => p.includes('does not exist')), problems.join('\n'));
});

check('未被认领的词汇文件 → 报错（引擎永远看不到它）', () => {
  const problems = checkVocabCorpus({ ...base, vocabOnDisk: [...base.vocabOnDisk, 'tier1-parity/vocab-de/orphan.vocab.json'] });
  assert.ok(problems.some((p) => p.includes('orphan.vocab.json')), problems.join('\n'));
});

check('无词汇条目旁的词汇文件也算未认领', () => {
  const problems = checkVocabCorpus({
    ...base,
    samples: [S('tier1-parity/vocab-de/a.aster', false)],
  });
  assert.ok(problems.some((p) => p.includes('a.vocab.json') && p.includes('not claimed')), problems.join('\n'));
});

check('tier1-parity/ 下未登记的样本 → 报错（三门都会静默跳过）', () => {
  const problems = checkVocabCorpus({ ...base, parityAsterOnDisk: [...base.parityAsterOnDisk, 'tier1-parity/vocab-zh/b.aster'] });
  assert.ok(problems.some((p) => p.includes('vocab-zh/b.aster')), problems.join('\n'));
});

check('带词汇必拒样本须声明 expectCode；无词汇必拒样本不得声明', () => {
  const missing = checkVocabCorpus({ ...base, metaOf: () => ({}) });
  assert.ok(missing.some((p) => p.includes('expectCode')), missing.join('\n'));
  const plain = checkVocabCorpus({
    ...base,
    mustReject: [S('tier1-reject/reject-x.aster', false)],
    vocabOnDisk: ['tier1-parity/vocab-de/a.vocab.json'],
  });
  assert.ok(plain.some((p) => p.includes('only checked for vocab entries')), plain.join('\n'));
});

check('vocabPathOf / casesPathOf', () => {
  assert.strictEqual(vocabPathOf('/c/tier1-parity/vocab-de/a.aster'), '/c/tier1-parity/vocab-de/a.vocab.json');
  assert.strictEqual(casesPathOf('/c/tier1-parity/vocab-de/a.aster'), '/c/tier1-parity/vocab-de/inputs/a.cases.json');
});

check('加载不到的 golden（放在样本旁或无对应样本）→ 报错', () => {
  const problems = checkVocabCorpus({
    ...base,
    parityCasesOnDisk: ['tier1-parity/vocab-de/a.cases.json', 'tier1-parity/vocab-de/inputs/ghost.cases.json'],
  });
  assert.strictEqual(problems.length, 2, problems.join('\n'));
});

// ---- judgeVocabSample ----
check('两侧成功且警告一致 → pass', () => {
  assert.strictEqual(judgeVocabSample({ ts: OK(['W800']), java: OK(['W800']) }).verdict, 'pass');
});

check('一侧失败 → divergent；两侧失败 → both-fail', () => {
  assert.strictEqual(judgeVocabSample({ ts: OK(), java: RES('E800') }).verdict, 'divergent');
  assert.strictEqual(judgeVocabSample({ ts: RES('E800'), java: OK() }).verdict, 'divergent');
  assert.strictEqual(judgeVocabSample({ ts: RES('E800'), java: SYN }).verdict, 'both-fail');
});

check('警告码不同 → warning-mismatch（重复码按集合比较）', () => {
  assert.strictEqual(judgeVocabSample({ ts: OK(['W800']), java: OK([]) }).verdict, 'warning-mismatch');
  assert.strictEqual(judgeVocabSample({ ts: OK(['W800', 'W800']), java: OK(['W800']) }).verdict, 'pass');
});

check('meta.expectWarnings 与两侧一致的警告不符 → warning-mismatch', () => {
  assert.strictEqual(judgeVocabSample({ ts: OK([]), java: OK([]), expectWarnings: ['W800'] }).verdict, 'warning-mismatch');
  assert.strictEqual(judgeVocabSample({ ts: OK(['W800']), java: OK(['W800']), expectWarnings: ['W800'] }).verdict, 'pass');
});

// ---- judgeVocabReject ----
check('两侧在名称解析阶段以同码拒绝 → rejected', () => {
  assert.strictEqual(judgeVocabReject({ ts: RES('E804'), java: RES('E804'), expectCode: 'E804' }).verdict, 'rejected');
});

check('任一侧接受 → 点名哪一侧', () => {
  assert.strictEqual(judgeVocabReject({ ts: OK(), java: OK(), expectCode: 'E804' }).verdict, 'both-accepted');
  assert.strictEqual(judgeVocabReject({ ts: OK(), java: RES('E804'), expectCode: 'E804' }).verdict, 'ts-accepted');
  assert.strictEqual(judgeVocabReject({ ts: RES('E804'), java: OK(), expectCode: 'E804' }).verdict, 'java-accepted');
});

check('语法错误或崩溃不算名称解析拒绝', () => {
  assert.strictEqual(judgeVocabReject({ ts: SYN, java: RES('E804'), expectCode: 'E804' }).verdict, 'ts-wrong-stage');
  assert.strictEqual(judgeVocabReject({ ts: RES('E804'), java: CRASH, expectCode: 'E804' }).verdict, 'java-wrong-stage');
});

check('错误码集合不同或不含 expectCode → code-mismatch', () => {
  assert.strictEqual(judgeVocabReject({ ts: RES('E804'), java: RES('E802'), expectCode: 'E804' }).verdict, 'code-mismatch');
  assert.strictEqual(judgeVocabReject({ ts: RES('E804', 'E801'), java: RES('E804'), expectCode: 'E804' }).verdict, 'code-mismatch');
  assert.strictEqual(judgeVocabReject({ ts: RES('E805'), java: RES('E805'), expectCode: 'E804' }).verdict, 'code-mismatch');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
