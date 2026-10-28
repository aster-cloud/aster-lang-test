import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeIr, IR_INFERENCE_FIELDS } from '../ir-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 跨引擎 IR 归一化的契约测试。
 *
 * ★这些用例守的是**语义契约**（「推导分析层必须被抹平」「源码结构必须保留」），
 *   不是当前实现的形状。规则本身会随两引擎演进而增删，但这些契约不该变。
 */
describe('ir-normalize：跨引擎归一化', () => {
  it('抹平「推导分析层」——两引擎在这些字段上的合法分岔不得影响比较结果', () => {
    // ADR 0016 §B/§C：类型推断与各引擎自有元数据不是源码结构。
    // Java 侧独有 piiLevel/piiCategories/annotations；TS 侧独有 retTypeInferred/
    // constraints/typeInferred。若不抹平，任何跨引擎比较都会恒不相等。
    const javaSide = {
      kind: 'Func', name: 'approve',
      piiLevel: 'L2', piiCategories: ['email'], typeParams: [],
      ret: { kind: 'TypeName', name: 'Text' },
      body: { kind: 'Block', statements: [] },
    };
    const tsSide = {
      kind: 'Func', name: 'approve',
      retTypeInferred: true, typeParams: ['Unknown'],
      ret: { kind: 'TypeVar', name: 'Unknown' },
      body: { kind: 'Block', statements: [] },
    };

    assert.deepStrictEqual(normalizeIr(javaSide), normalizeIr(tsSide),
      '两引擎只在推导分析层不同，归一化后应完全相等。');
  });

  it('★保留源码结构——归一化不得把真实差异一起抹掉', () => {
    // 反向守卫。若哪天有人往 IR_INFERENCE_FIELDS 里多塞一个字段（比如 `name`
    // 或 `statements`），上面那条用例照样绿，而这条会变红。
    // 没有这条，「归一化」可以退化成「把所有字段都删光」——那样任何两棵树都相等。
    const a = { kind: 'Func', name: 'approve', body: { kind: 'Block', statements: [] } };
    const b = { kind: 'Func', name: 'assess', body: { kind: 'Block', statements: [] } };

    assert.notDeepStrictEqual(normalizeIr(a), normalizeIr(b),
      '规则名不同是**真实**的源码差异，归一化后必须仍然不等。');

    const withStmt = {
      kind: 'Func', name: 'approve',
      body: { kind: 'Block', statements: [{ kind: 'Return', expr: { kind: 'Bool', value: true } }] },
    };
    assert.notDeepStrictEqual(normalizeIr(a), normalizeIr(withStmt),
      '函数体语句数不同是真实差异，归一化后必须仍然不等。');
  });

  it('★归一化必须是确定性的：同一输入反复归一化产出相同结果', () => {
    // contentHash 建立在这条之上。若归一化引入任何非确定性（键序、Set 迭代序…），
    // change impact 会每次编译都全量报 stale。
    const node = {
      kind: 'Module', name: 'demo',
      decls: [{ kind: 'Func', name: 'f', annotations: [], body: { kind: 'Block', statements: [] } }],
    };
    const once = JSON.stringify(normalizeIr(node));
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(JSON.stringify(normalizeIr(node)), once,
        '同一输入的归一化结果发生了变化 —— 存在非确定性。');
    }
  });

  it('★与 parity 门禁共用同一份规则（单源，不得出现第二套）', () => {
    // 本仓反复记录过单源漂移事故：两处规则各自演进后，门禁说「一致」而
    // contentHash 说「不一致」，**且两边都不报错**。
    // 这条用例直接读门禁脚本，确认它是 import 本模块而非自己再定义一份。
    const gate = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'parity-tier1.mjs'), 'utf8');

    assert.ok(gate.includes("from '../packages/js/src/ir-normalize.ts'"),
      'parity-tier1.mjs 未从本模块导入归一化规则 —— 单源已被打破。');
    assert.ok(!/^const IR_INFERENCE_FIELDS = new Set\(\[/m.test(gate),
      'parity-tier1.mjs 里又出现了一份 IR_INFERENCE_FIELDS 定义 —— 规则已分叉成两套。');
  });

  it('注解参数容器形状：TS args 数组与 Java params 映射归一为同一对象（ADR 0039 §10）', () => {
    const decl = (annotations: unknown[]) => ({
      kind: 'Func', name: 'decide', annotations,
      body: { kind: 'Block', statements: [] },
    });
    const tsSide = decl([
      { name: 'id', args: [{ name: '$0', value: 'VB-001' }] },
      { name: 'control', args: [{ name: '$0', value: 'EU_AI_ACT:ART14' }] },
    ]);
    const javaSide = decl([
      { name: 'id', params: { $0: 'VB-001' } },
      { name: 'control', params: { $0: 'EU_AI_ACT:ART14' } },
    ]);
    assert.deepStrictEqual(normalizeIr(tsSide), normalizeIr(javaSide),
      '两引擎只在注解参数的容器形状上不同，归一化后应完全相等。');

    // 反向守卫：只归一形状，不抹平取值差异。
    const tsOther = decl([
      { name: 'id', args: [{ name: '$0', value: 'VB-999' }] },
      { name: 'control', args: [{ name: '$0', value: 'EU_AI_ACT:ART14' }] },
    ]);
    assert.notDeepStrictEqual(normalizeIr(tsOther), normalizeIr(javaSide),
      '注解参数值不同却被判为相等 —— 归一化越界改动了取值。');
  });

  it('推导字段清单非空（防止规则被整体清空后测试仍全绿）', () => {
    assert.ok(IR_INFERENCE_FIELDS.size > 0, 'IR_INFERENCE_FIELDS 为空，归一化形同虚设。');
    for (const f of ['piiLevel', 'retTypeInferred', 'typeInferred', 'constraints']) {
      assert.ok(IR_INFERENCE_FIELDS.has(f), `推导字段 ${f} 不在清单里，跨引擎比较会恒不相等。`);
    }
  });
});

/**
 * ADR 0051 §4：origin.written / role 是名称解析的旁路记录。
 * parity 需要比较它们（两引擎须在同一位置记录同一原写法与角色），
 * 而 ADR 0037 的 contentHash 只看语义，默认归一化必须与引入该字段前逐字节相同。
 */
describe('ir-normalize：includeResolution（ADR 0051）', () => {
  const funcWith = (written?: string, role?: string) => ({
    kind: 'Func', name: 'check',
    origin: {
      file: 'null', start: { line: 3, col: 1 }, end: { line: 4, col: 9 },
      ...(written === undefined ? {} : { written, role }),
    },
    params: [{ name: 'd', type: { kind: 'TypeName', name: 'Driver' } }],
    body: {
      kind: 'Block',
      statements: [{
        kind: 'Return', origin: { start: { line: 4, col: 3 }, end: { line: 4, col: 9 } },
        expr: {
          kind: 'Name', name: 'd.age',
          origin: { start: { line: 4, col: 10 }, end: { line: 4, col: 15 }, written: 'd.alter', role: 'FIELD_REF' },
        },
      }],
    },
  });

  // 引入 includeResolution 之前默认归一化的逐字节输出（contentHash 基线）。
  const BASELINE =
    '{"kind":"Func","name":"check","origin":{"file":null,"start":{"line":3},"end":{"line":4}},' +
    '"params":[{"name":"d","annotations":[],"retAnnotations":[],"effects":[]}],' +
    '"body":{"kind":"Block","statements":[{"kind":"Return","origin":{"file":null,"start":{"line":4},"end":{"line":4}},' +
    '"expr":{"kind":"Name","name":"d.age","origin":{"file":null,"start":{"line":4},"end":{"line":4}}}}]},' +
    '"annotations":[],"retAnnotations":[],"effects":[]}';

  it('默认（includeResolution=false）：输出与基线逐字节相同，written/role 不影响 contentHash', () => {
    assert.strictEqual(JSON.stringify(normalizeIr(funcWith('bewerten', 'FUNC_DECL'))), BASELINE);
    assert.strictEqual(JSON.stringify(normalizeIr(funcWith())), BASELINE);
    assert.strictEqual(JSON.stringify(normalizeIr(funcWith('bewerten', 'FUNC_DECL'), { includeResolution: false })), BASELINE);
  });

  it('includeResolution=true：保留 written/role，原写法或角色不同即不等', () => {
    const a = normalizeIr(funcWith('bewerten', 'FUNC_DECL'), { includeResolution: true });
    assert.deepStrictEqual(a.origin, { file: null, start: { line: 3 }, end: { line: 4 }, written: 'bewerten', role: 'FUNC_DECL' });
    assert.strictEqual(a.body.statements[0].expr.origin.written, 'd.alter');
    assert.strictEqual(a.body.statements[0].expr.origin.role, 'FIELD_REF');
    assert.notDeepStrictEqual(a, normalizeIr(funcWith(), { includeResolution: true }),
      '一侧记录了原写法、另一侧没有 —— parity 必须报出。');
    assert.notDeepStrictEqual(a, normalizeIr(funcWith('bewerten', 'FUNC_REF'), { includeResolution: true }),
      '角色不同 —— parity 必须报出。');
    assert.deepStrictEqual(a, normalizeIr(funcWith('bewerten', 'FUNC_DECL'), { includeResolution: true }));
  });

  it('includeResolution=true 对无 written/role 的 IR 不新增字段：无词汇语料结果不变', () => {
    const plain = { kind: 'Return', origin: { start: { line: 1, col: 1 }, end: { line: 1, col: 5 } }, expr: { kind: 'Bool', value: true } };
    assert.strictEqual(
      JSON.stringify(normalizeIr(plain, { includeResolution: true })),
      JSON.stringify(normalizeIr(plain)));
  });

  it('originMode 经选项对象传入；off 时 origin 连同 written/role 一并丢弃', () => {
    const out = normalizeIr(funcWith('bewerten', 'FUNC_DECL'), { originMode: 'off', includeResolution: true });
    assert.strictEqual(out.origin, undefined);
    const strict = normalizeIr(funcWith(), { originMode: 'strict' });
    assert.deepStrictEqual(strict.origin.start, { line: 3, col: 1 });
  });

  it('★parity 门禁比较 IR 时开启 includeResolution', () => {
    const gate = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'parity-tier1.mjs'), 'utf8');
    assert.match(gate, /includeResolution:\s*true/,
      'parity-tier1.mjs 未以 includeResolution: true 比较 IR —— 两引擎的原写法 / 角色分岔不受门禁约束。');
  });
});
