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

  it('推导字段清单非空（防止规则被整体清空后测试仍全绿）', () => {
    assert.ok(IR_INFERENCE_FIELDS.size > 0, 'IR_INFERENCE_FIELDS 为空，归一化形同虚设。');
    for (const f of ['piiLevel', 'retTypeInferred', 'typeInferred', 'constraints']) {
      assert.ok(IR_INFERENCE_FIELDS.has(f), `推导字段 ${f} 不在清单里，跨引擎比较会恒不相等。`);
    }
  });
});
