#!/usr/bin/env node
/**
 * 样本词法表（meta.lexicon）驱动的回归测试（纯 node:assert）。
 *
 * ★测试**生产逻辑本身**：parity-tier1.mjs 与 equivalence-nightly.mjs 的 TS 侧都经
 * scripts/lib/sample-lexicon.mjs 读取样本声明的词法表并据此解析（单一事实源）。
 * 锁住的核心语义（issue #205）：
 *   - nightly 必须把样本声明的词法表传给 TS 引擎：zh-CN 样本按 zh-CN 规范化 / 词法 / 解析，
 *     不得按默认英语硬解（否则「模块 …」报 Unexpected character '模'，nightly 整晚变红）；
 *   - nightly 范围内的样本必须**显式**声明 lexicon：缺 meta、缺字段或空值都要大声失败，
 *     不得静默退回 en-US——非英语样本漏标正是被静默退回掩盖的；
 *   - 声明的非 en-US 词法表在当前 TS 构建里取不到 → 失败，不得退回英语。
 *
 * 若同级 ../aster-lang-ts 已构建，额外用真实引擎跑语料里的 zh-CN 样本（端到端锁住 #205）。
 *
 * 用法：node scripts/test-sample-lexicon.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LEXICON,
  lexiconOf,
  declaredLexiconOf,
  selectTsLexicon,
  loadTsLexicons,
} from './lib/sample-lexicon.mjs';
import { undeclaredLexiconProblems, tsParseSamples } from './equivalence-nightly.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

// 临时语料：每个样本一对 .aster + .meta.json（meta 为 null 表示不写 meta 文件）。
const dir = mkdtempSync(join(tmpdir(), 'sample-lexicon-'));
function sample(name, src, meta) {
  const abs = join(dir, `${name}.aster`);
  writeFileSync(abs, src);
  if (meta !== null) writeFileSync(abs.replace(/\.aster$/, '.meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
  return abs;
}
const EN = sample('en', 'Module demo.\n', { tier: 1, lexicon: 'en-US' });
const ZH = sample('zh', '模块 样例。\n', { tier: 1, lexicon: 'zh-CN' });
const NO_FIELD = sample('no-field', '模块 样例。\n', { tier: 1 });
const EMPTY = sample('empty', '模块 样例。\n', { tier: 1, lexicon: '' });
const NO_META = sample('no-meta', '模块 样例。\n', null);
const BAD_JSON = sample('bad-json', 'Module demo.\n', '{ not json');
const NON_STRING = sample('non-string', 'Module demo.\n', { tier: 1, lexicon: 42 });

// 假引擎：记录每一步收到的词法表，以便断言 nightly 真的把它传下去了。
const ZH_LEX = { id: 'zh-CN' };
function fakeEngine() {
  const calls = [];
  const mod = {
    canonicalize: (src, lex) => { calls.push(['canonicalize', lex]); return src; },
    lex: (src, lex) => { calls.push(['lex', lex]); return [src]; },
    parse: (tokens) => { calls.push(['parse', undefined]); return { ast: { tokens }, diagnostics: [] }; },
    parseWithLexicon: (tokens, lex) => { calls.push(['parseWithLexicon', lex]); return { ast: { tokens }, diagnostics: [] }; },
  };
  return { calls, engine: { mod, lexicons: { 'zh-CN': ZH_LEX } } };
}

try {
  await check('lexiconOf（parity 宽松口径）：声明值原样返回，缺失 / 空值 / 坏 JSON / 非字符串退回 en-US', () => {
    assert.strictEqual(lexiconOf(ZH), 'zh-CN');
    assert.strictEqual(lexiconOf(EN), 'en-US');
    assert.strictEqual(lexiconOf(NO_FIELD), DEFAULT_LEXICON);
    assert.strictEqual(lexiconOf(NO_META), DEFAULT_LEXICON);
    assert.strictEqual(lexiconOf(EMPTY), DEFAULT_LEXICON);
    assert.strictEqual(lexiconOf(BAD_JSON), DEFAULT_LEXICON);
    assert.strictEqual(lexiconOf(NON_STRING), DEFAULT_LEXICON);
  });

  await check('declaredLexiconOf（nightly 严格口径）：显式声明才返回', () => {
    assert.strictEqual(declaredLexiconOf(ZH), 'zh-CN');
    assert.strictEqual(declaredLexiconOf(EN), 'en-US');
  });

  await check('declaredLexiconOf：缺字段 / 空值 / 非字符串 / 缺 meta / 坏 JSON 一律抛错，不退回 en-US', () => {
    assert.throws(() => declaredLexiconOf(NO_FIELD), /lexicon/);
    assert.throws(() => declaredLexiconOf(EMPTY), /lexicon/);
    assert.throws(() => declaredLexiconOf(NO_META), /meta/);
    assert.throws(() => declaredLexiconOf(BAD_JSON), /meta/);
    assert.throws(() => declaredLexiconOf(NON_STRING), /lexicon/);
  });

  await check('selectTsLexicon：en-US → undefined（默认路径）；已加载 → 对象；未加载的非 en-US → 抛错', () => {
    assert.strictEqual(selectTsLexicon({ 'zh-CN': ZH_LEX }, 'en-US', 'x'), undefined);
    assert.strictEqual(selectTsLexicon({ 'zh-CN': ZH_LEX }, 'zh-CN', 'x'), ZH_LEX);
    assert.throws(() => selectTsLexicon({}, 'zh-CN', 'x.aster'), /x\.aster.*zh-CN/);
  });

  await check('nightly 守卫：列出所有未显式声明 lexicon 的样本（不止第一个）', () => {
    const problems = undeclaredLexiconProblems([EN, ZH, NO_FIELD, EMPTY, NO_META], dir);
    assert.strictEqual(problems.length, 3, problems.join('\n'));
    for (const name of ['no-field.aster', 'empty.aster', 'no-meta.aster']) {
      assert.ok(problems.some((p) => p.includes(name)), `${name} 未被点名：\n${problems.join('\n')}`);
    }
    assert.deepStrictEqual(undeclaredLexiconProblems([EN, ZH], dir), []);
  });

  await check('#205：nightly 把 zh-CN 样本的词法表传给 canonicalize / lex / parseWithLexicon', () => {
    const { calls, engine } = fakeEngine();
    const res = tsParseSamples([ZH], engine, dir);
    assert.deepStrictEqual(res['zh.aster'], { ok: true, err: null });
    assert.deepStrictEqual(calls, [['canonicalize', ZH_LEX], ['lex', ZH_LEX], ['parseWithLexicon', ZH_LEX]]);
  });

  await check('nightly：en-US 样本走默认路径（不传词法表，行为与修复前逐字节一致）', () => {
    const { calls, engine } = fakeEngine();
    const res = tsParseSamples([EN], engine, dir);
    assert.deepStrictEqual(res['en.aster'], { ok: true, err: null });
    assert.deepStrictEqual(calls, [['canonicalize', undefined], ['lex', undefined], ['parse', undefined]]);
  });

  await check('nightly：声明的非 en-US 词法表取不到 → 抛错，不退回英语', () => {
    const { engine } = fakeEngine();
    assert.throws(() => tsParseSamples([ZH], { ...engine, lexicons: {} }, dir), /zh-CN/);
  });

  await check('nightly：解析诊断照常记为失败（ok=false + 首个错误消息）', () => {
    const { engine } = fakeEngine();
    engine.mod.parse = () => ({ ast: null, diagnostics: [{ severity: 'error', message: 'boom' }] });
    assert.deepStrictEqual(tsParseSamples([EN], engine, dir)['en.aster'], { ok: false, err: 'boom' });
  });

  const tsDist = join(TS_REPO, 'dist', 'src', 'index.js');
  const zhCorpus = join(ROOT, 'corpus', 'tier1-equivalence', 'policies', 'pattern-nested-name-matches-enum-member.aster');
  if (existsSync(tsDist)) {
    await check('#205 端到端：真实 TS 引擎按 meta 解析语料里的 zh-CN 样本 → ok', async () => {
      const engine = { mod: await import(tsDist), lexicons: await loadTsLexicons(TS_REPO) };
      const rel = 'tier1-equivalence/policies/pattern-nested-name-matches-enum-member.aster';
      assert.deepStrictEqual(tsParseSamples([zhCorpus], engine, join(ROOT, 'corpus'))[rel], { ok: true, err: null });
    });
  } else {
    console.log(`  - SKIP 端到端用例：${tsDist} 不存在（同级 aster-lang-ts 未构建）`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nsample-lexicon guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
