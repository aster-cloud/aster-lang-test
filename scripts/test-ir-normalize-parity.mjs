#!/usr/bin/env node
/**
 * parity 门禁的 IR 归一化接线回归测试（纯 node:assert）。
 *
 * 取代原先对 parity-tier1.mjs 源码做子串匹配的做法（注释里写一句 `includeResolution: true`、
 * 留一个没人调用的函数都能骗过）。这里分两层：
 *   1. 行为：直接 import 门禁实际使用的 normalizeForParity，对带 written/role 的 IR 断言结果；
 *      并与 contentHash 走的默认 normalizeIr 对照；
 *   2. 接线：把 parity-tier1.mjs 去掉注释与字符串后，断言它经 lib 取得归一化、
 *      不再自行 import 归一化库，且 diffIr 比较的是经该入口归一化的树。
 *
 * 用法：node scripts/test-ir-normalize-parity.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForParity } from './lib/ir-normalize-parity.mjs';
import { normalizeIr } from '../packages/js/src/ir-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** 去掉块注释、行注释与字符串 / 模板字面量内容，只保留可执行代码的文本。 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += c + c;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const typeName = (name, written, role = 'TYPE', line = 7) => ({
  kind: 'TypeName', name,
  origin: { start: { line, col: 1 }, end: { line, col: 5 }, ...(written === undefined ? {} : { written, role }) },
});
const func = (paramType, retType) => ({
  kind: 'Func', name: 'bewerten',
  origin: { start: { line: 7, col: 1 }, end: { line: 8, col: 9 }, written: 'bewerten', role: 'FUNC_DECL' },
  params: [{ name: 'fahrer', type: paramType }],
  ret: retType,
  body: { kind: 'Block', statements: [] },
});

console.log('normalizeForParity 行为');

check('保留声明上的 written / role', () => {
  const out = normalizeForParity(func(typeName('Driver', 'Fahrer'), typeName('Int')));
  assert.strictEqual(out.origin.written, 'bewerten');
  assert.strictEqual(out.origin.role, 'FUNC_DECL');
});

check('保留签名（参数类型、返回类型）上的 written / role', () => {
  const out = normalizeForParity(func(typeName('Driver', 'Fahrer'), typeName('Level', 'Stufe')));
  assert.deepStrictEqual(out.params[0].typeResolutions, [{ name: 'Driver', written: 'Fahrer', role: 'TYPE', line: 7 }]);
  assert.deepStrictEqual(out.retResolutions, [{ name: 'Level', written: 'Stufe', role: 'TYPE', line: 7 }]);
});

check('签名上的 written 差异使两棵树不等', () => {
  const a = normalizeForParity(func(typeName('Driver', 'Fahrer'), typeName('Int')));
  const b = normalizeForParity(func(typeName('Driver', 'Fuehrer'), typeName('Int')));
  assert.notDeepStrictEqual(a, b);
});

check('与 contentHash 的默认归一化对照：默认路径不含任何解析记录', () => {
  const node = func(typeName('Driver', 'Fahrer'), typeName('Level', 'Stufe'));
  const dflt = normalizeIr(node);
  assert.strictEqual(dflt.origin.written, undefined);
  assert.strictEqual(dflt.params[0].typeResolutions, undefined);
  assert.strictEqual(dflt.retResolutions, undefined);
  assert.notStrictEqual(JSON.stringify(dflt), JSON.stringify(normalizeForParity(node)));
});

check('推导出的类型差异仍被忽略（TS 的 Unknown 与 Java 的具体类型）', () => {
  const tsSide = func({ kind: 'TypeVar', name: 'Unknown' }, undefined);
  const javaSide = func(typeName('Quote'), typeName('Int'));
  assert.deepStrictEqual(normalizeForParity(tsSide), normalizeForParity(javaSide));
});

check('originMode 由调用方注入：off 时 origin 与类型记录一并丢弃', () => {
  const out = normalizeForParity(func(typeName('Driver', 'Fahrer'), typeName('Int')), 'off');
  assert.strictEqual(out.origin, undefined);
  assert.strictEqual(out.params[0].typeResolutions, undefined);
});

console.log('parity-tier1.mjs 接线');

const gate = stripCommentsAndStrings(readFileSync(join(__dirname, 'parity-tier1.mjs'), 'utf8'));

check('去注释函数自检：注释里的 includeResolution 不算数', () => {
  const stripped = stripCommentsAndStrings('// includeResolution: true\n/* normalizeForParity */ const a = "normalizeForParity";');
  assert.ok(!/includeResolution|normalizeForParity/.test(stripped));
});

check('门禁从 lib 导入 normalizeForParity，且不再自行导入归一化库', () => {
  assert.match(gate, /import\s*\{\s*normalizeForParity\s*\}\s*from\s*''\s*;/);
  assert.ok(!/import[^;]*ir-normalize\.ts/.test(gate) && !/import\s*\{[^}]*\bnormalizeIr\b[^}]*\}/.test(gate),
    'parity-tier1.mjs 直接导入了归一化库 —— 出现第二条归一化路径。');
});

check('门禁自身不写 includeResolution / IR_INFERENCE_FIELDS（选项只在 lib 固定）', () => {
  assert.ok(!/includeResolution/.test(gate));
  assert.ok(!/IR_INFERENCE_FIELDS/.test(gate));
});

check('diffIr 比较的是经 normalizeForParity 归一化的两棵树', () => {
  const normalizeBody = gate.match(/function normalizeIr\(node\)\s*\{([^}]*)\}/);
  assert.ok(normalizeBody, '找不到门禁的 normalizeIr 包装函数');
  assert.match(normalizeBody[1], /return\s+normalizeForParity\(\s*node\s*,\s*IR_ORIGIN_MODE\s*\)/);
  const diffBody = gate.match(/function diffIr\(tsIr,\s*javaIr\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(diffBody, '找不到 diffIr');
  assert.match(diffBody[1], /walkDiff\(\s*normalizeIr\(tsIr\)\s*,\s*normalizeIr\(javaIr\)/);
});

check('lib 本身固定 includeResolution: true 且只从共享库导入', () => {
  const lib = stripCommentsAndStrings(readFileSync(join(__dirname, 'lib', 'ir-normalize-parity.mjs'), 'utf8'));
  assert.match(lib, /includeResolution:\s*true/);
  assert.match(lib, /import\s*\{[^}]*\bnormalizeIr\b[^}]*\}\s*from\s*''/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
