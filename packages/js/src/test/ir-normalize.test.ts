import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeIr, IR_INFERENCE_FIELDS } from '../ir-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 去掉块注释与行注释，使源码文本检查不被注释里的字样欺骗。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

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

  it('★仓内脚本只有一个入口使用归一化规则（单源，不得出现第二套）', () => {
    // 本仓反复记录过单源漂移事故：两处规则各自演进后，门禁说「一致」而
    // contentHash 说「不一致」，**且两边都不报错**。
    // 扫描 scripts/ 下全部脚本（去掉注释后）：导入归一化库的只能是 lib/ir-normalize-parity.mjs，
    // 且任何文件都不得再定义自己的推导字段 / 别名表。门禁接线的行为级断言见 scripts/test-ir-normalize-parity.mjs。
    const scriptsDir = join(__dirname, '..', '..', '..', '..', 'scripts');
    const files = [
      ...readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).map((f) => join(scriptsDir, f)),
      ...readdirSync(join(scriptsDir, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join(scriptsDir, 'lib', f)),
    ].filter((f) => !f.endsWith('test-ir-normalize-parity.mjs'));
    const importers = files.filter((f) => /from\s*['"][^'"]*ir-normalize\.ts['"]/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepStrictEqual(importers.map((f) => f.slice(scriptsDir.length + 1)), ['lib/ir-normalize-parity.mjs'],
      '只有 lib/ir-normalize-parity.mjs 可以导入归一化库 —— 出现了第二条归一化路径。');
    for (const f of files) {
      assert.ok(!/\b(const|let|var)\s+(IR_INFERENCE_FIELDS|IR_IGNORE_FIELDS|IR_FIELD_ALIASES)\b/.test(stripComments(readFileSync(f, 'utf8'))),
        `${f} 里又出现了一份归一化规则定义 —— 规则已分叉成两套。`);
    }
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

  it('★parity 入口固定 includeResolution: true（去注释后检查；行为级断言见 scripts/test-ir-normalize-parity.mjs）', () => {
    const lib = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'ir-normalize-parity.mjs'), 'utf8');
    assert.match(stripComments(lib), /includeResolution:\s*true/,
      'lib/ir-normalize-parity.mjs 未以 includeResolution: true 归一化 —— 两引擎的原写法 / 角色分岔不受门禁约束。');
  });
});

/**
 * ADR 0051 R33：签名 / 字段类型上的 origin.written / role。
 * `type` / `ret` / `retType` 整棵属于推导分析层（两引擎对未标注类型的推断不同，必须忽略），
 * 但其中由名称解析写入的 written / role 是源码级记录，includeResolution 开启时必须参与比较。
 */
describe('ir-normalize：签名类型上的 written / role（includeResolution）', () => {
  const typeName = (name: string, written?: string, line = 7, role = 'TYPE') => ({
    kind: 'TypeName', name,
    origin: {
      start: { line, col: 35 }, end: { line, col: 41 },
      ...(written === undefined ? {} : { written, role }),
    },
  });
  const func = (paramType: unknown, ret?: unknown) => ({
    kind: 'Func', name: 'bewerten',
    params: [{ name: 'fahrer', type: paramType, constraints: [] }],
    ...(ret === undefined ? {} : { ret }),
    body: { kind: 'Block', statements: [] },
  });
  const on = { includeResolution: true };

  it('参数类型的 written / role 不同即不等；相同则相等（行号变化也要报出）', () => {
    const a = normalizeIr(func(typeName('Driver', 'Fahrer')), on);
    assert.deepStrictEqual(a, normalizeIr(func(typeName('Driver', 'Fahrer')), on));
    assert.notDeepStrictEqual(a, normalizeIr(func(typeName('Driver', 'Fuehrer')), on), 'written 不同必须报出');
    assert.notDeepStrictEqual(a, normalizeIr(func(typeName('Driver', 'Fahrer', 7, 'TYPE_REF')), on), 'role 不同必须报出');
    assert.notDeepStrictEqual(a, normalizeIr(func(typeName('Driver', 'Fahrer', 9)), on), '记录位置行不同必须报出');
    assert.notDeepStrictEqual(a, normalizeIr(func(typeName('Driver')), on), '一侧没有记录必须报出');
  });

  it('规范名不同也要报出（解析到不同类型）', () => {
    assert.notDeepStrictEqual(
      normalizeIr(func(typeName('Driver', 'Fahrer')), on),
      normalizeIr(func(typeName('Pilot', 'Fahrer')), on));
  });

  it('返回类型与字段类型同样参与比较', () => {
    const ret = (w?: string) => func(typeName('Int'), typeName('Level', w, 7));
    assert.notDeepStrictEqual(normalizeIr(ret('Stufe'), on), normalizeIr(ret('Rang'), on));
    const data = (w: string) => ({ kind: 'Data', name: 'Driver', fields: [{ name: 'level', type: typeName('Level', w, 5) }] });
    assert.notDeepStrictEqual(normalizeIr(data('Stufe'), on), normalizeIr(data('Rang'), on));
    assert.deepStrictEqual(normalizeIr(data('Stufe'), on), normalizeIr(data('Stufe'), on));
  });

  it('嵌套泛型：按先序收集所有类型位置的记录', () => {
    const nested = (inner: string, outer: string) => func({
      kind: 'TypeApp', base: 'Map',
      origin: { start: { line: 7, col: 30 }, end: { line: 7, col: 60 } },
      args: [typeName('Text'), { kind: 'TypeApp', base: 'List', args: [typeName('Level', inner)] }],
      ...{ outerWritten: outer },
    });
    const a = normalizeIr(nested('Stufe', 'x'), on);
    assert.deepStrictEqual(a, normalizeIr(nested('Stufe', 'y'), on), '非记录字段不参与比较');
    assert.notDeepStrictEqual(a, normalizeIr(nested('Rang', 'x'), on), '深层嵌套的 written 差异必须报出');
    assert.deepStrictEqual(a.params[0].typeResolutions, [{ name: 'Level', written: 'Stufe', role: 'TYPE', line: 7 }]);
  });

  it('Option / Result 等包装类型：包装层名称与内层 written 都能到达', () => {
    const opt = (w: string) => func({ kind: 'Option', type: typeName('Level', w) });
    assert.notDeepStrictEqual(normalizeIr(opt('Stufe'), on), normalizeIr(opt('Rang'), on));
  });

  it('推导差异仍被忽略：无记录的类型节点（Unknown / 缺省 ret / 不同占位）不影响比较', () => {
    const tsSide = func({ kind: 'TypeVar', name: 'Unknown' }, undefined);
    const javaSide = func({ kind: 'TypeName', name: 'Quote', origin: { start: { line: 7, col: 1 }, end: { line: 7, col: 2 } } },
      { kind: 'TypeName', name: 'Int', origin: { start: { line: 7, col: 47 }, end: { line: 7, col: 50 } } });
    assert.deepStrictEqual(normalizeIr(tsSide, on), normalizeIr(javaSide, on));
    assert.strictEqual(normalizeIr(tsSide, on).params[0].typeResolutions, undefined, '无记录时不新增字段');
  });

  it('written 缺省（等于规范名时两引擎都不写出）：与有记录的一侧不等，两侧都缺省则相等', () => {
    assert.deepStrictEqual(normalizeIr(func(typeName('Int')), on), normalizeIr(func(typeName('Int')), on));
    assert.strictEqual(normalizeIr(func(typeName('Int')), on).params[0].typeResolutions, undefined);
  });

  it('空 ret / null ret 不报错且不产生记录', () => {
    assert.strictEqual(normalizeIr(func(typeName('Int'), null), on).retResolutions, undefined);
    assert.strictEqual(normalizeIr({ kind: 'Func', name: 'f', ret: {} }, on).retResolutions, undefined);
  });

  it('默认路径（contentHash）不变：类型子树仍整棵丢弃，记录不泄漏', () => {
    const out = normalizeIr(func(typeName('Driver', 'Fahrer')));
    assert.strictEqual(out.params[0].type, undefined);
    assert.strictEqual(out.params[0].typeResolutions, undefined);
    assert.strictEqual(
      JSON.stringify(normalizeIr(func(typeName('Driver', 'Fahrer')))),
      JSON.stringify(normalizeIr(func(typeName('Pilot')))));
  });

  it('originMode=off：origin 整体丢弃，类型记录一并丢弃', () => {
    const out = normalizeIr(func(typeName('Driver', 'Fahrer')), { includeResolution: true, originMode: 'off' });
    assert.strictEqual(out.params[0].typeResolutions, undefined);
  });
});
