#!/usr/bin/env node
/**
 * envelope 共享向量（corpus/shared-vectors/envelope-vectors.json，ADR 0051 §7）的自检（纯 node:assert）。
 *
 * ★为什么需要：aster-api 与 aster-cloud 都拿这份文件断言各自的 5 段 envelope 实现；文件本身若算错，
 * 两端会一起「对齐到错误答案」。这里按 README 写明的规则独立重算每条 expectedSha256，
 * 并锁住 ADR 0051 §7 要求的场景（无词汇 / 单 struct / 同义词 + NFC 组合字符）。
 *
 * 用法：node scripts/test-envelope-vectors.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus', 'shared-vectors', 'envelope-vectors.json');
const FIELDS = ['content', 'aliasSetJson', 'locale', 'toolchainId', 'scopesJson'];

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

/** 长度前缀分帧：每段 `<UTF-8 字节数>:<字节>|`，段序固定。 */
function envelope(v) {
  const h = createHash('sha256');
  for (const f of FIELDS) {
    const b = Buffer.from(v[f], 'utf8');
    h.update(`${b.length}:`, 'ascii');
    h.update(b);
    h.update('|', 'ascii');
  }
  return h.digest('hex');
}

const vectors = JSON.parse(readFileSync(FILE, 'utf8'));

check('形状：数组，每条恰好 5 个字符串输入 + expectedSha256', () => {
  assert.ok(Array.isArray(vectors) && vectors.length >= 3);
  for (const v of vectors) {
    assert.deepStrictEqual(Object.keys(v).sort(), [...FIELDS, 'expectedSha256'].sort());
    for (const f of FIELDS) assert.strictEqual(typeof v[f], 'string', f);
    assert.match(v.expectedSha256, /^[0-9a-f]{64}$/);
  }
});

check('expectedSha256 与独立重算一致', () => {
  for (const [i, v] of vectors.entries()) assert.strictEqual(envelope(v), v.expectedSha256, `vector ${i}`);
});

check('分帧鉴别力：把第 5 段并入第 4 段会得到不同哈希', () => {
  const v = vectors.find((x) => x.scopesJson !== '');
  assert.notStrictEqual(envelope({ ...v, toolchainId: v.toolchainId + v.scopesJson, scopesJson: '' }), v.expectedSha256);
});

check('覆盖：无词汇（scopesJson 为空串）', () => {
  assert.ok(vectors.some((v) => v.scopesJson === ''));
});

check('覆盖：单 struct 词汇', () => {
  assert.ok(vectors.some((v) => {
    if (v.scopesJson === '') return false;
    const s = JSON.parse(v.scopesJson);
    const types = Object.values(s.types).flat();
    return s.schemaVersion === 1 && types.length === 1 && types[0].kind === 'struct';
  }));
});

check('覆盖：同义词 + NFC 组合字符（scopes 中 written 已 NFC，content 保留组合字符原样）', () => {
  const v = vectors.find((x) => x.scopesJson.includes('"source":"synonym"'));
  assert.ok(v, '缺少含同义词的向量');
  assert.ok(v.content.includes('é'), 'content 应含 e + U+0301');
  const written = Object.values(JSON.parse(v.scopesJson).types).flat().map((c) => c.written);
  assert.ok(written.includes('Café'), 'scopes 中 written 应为 NFC 形式');
  assert.ok(written.every((w) => w === w.normalize('NFC')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
