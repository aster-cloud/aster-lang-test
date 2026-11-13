#!/usr/bin/env node
/**
 * scripts/lib/ir-byte-parity.mjs 的回归测试（纯 node:assert）：Core IR v2 逐字节 parity 判定（ADR 0055 §6）。
 *
 * 覆盖判定步骤 1–4、col 全局投影、值层豁免（V1–V4）的命中边界、stale / 到期判定与豁免表配置校验；
 * 末尾一组断言 parity-tier1.mjs 中真实的 VALUE_EXEMPTIONS 配置合法。
 * 规范字节用已构建的 aster-lang-ts 的 canonicalJson（与 core CanonicalJson 字节一致），
 * 故需先在同级 ../aster-lang-ts 执行 pnpm build。
 *
 * 用法：node scripts/test-ir-byte-parity.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  IR_VERDICTS, ExemptionConfigError, validateExemptions, createExemptionLedger,
  projectForCompare, judgeSample, exemptionFindings, narrowableScopes,
} from './lib/ir-byte-parity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const canonicalPath = resolve(__dirname, '..', '..', 'aster-lang-ts', 'dist', 'src', 'core', 'canonical-json.js');
if (!existsSync(canonicalPath)) {
  console.error(`aster-lang-ts 未构建（缺 ${canonicalPath}）。先在 ../aster-lang-ts 执行 pnpm build。`);
  process.exit(2);
}
const { canonicalJson } = await import(pathToFileURL(canonicalPath).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}: ${e.stack || e.message}`);
  }
}

// ── 夹具：最小 v2 形状（schema 校验在这些用例中被替换为桩，只有 schema-invalid 用例返回问题） ──
const FILE = 'tier1-equivalence/policies/sample.aster';
const origin = (line, col = 1, endLine = line, endCol = col + 4) => ({
  file: null, start: { line, col }, end: { line: endLine, col: endCol }, written: null, role: null,
});
const typeName = (name, o = origin(2)) => ({ kind: 'TypeName', name, origin: o });
const func = (over = {}) => ({
  kind: 'Func', name: 'f', typeParams: [],
  params: [{ name: 'x', type: typeName('Int'), annotations: [], constraints: [], typeInferred: false }],
  ret: typeName('Int'), retTypeInferred: false,
  annotations: [], retAnnotations: [], effects: [], effectParams: [], effectCaps: [], effectCapsExplicit: false,
  inputRefs: null,
  body: { kind: 'Block', statements: [], origin: origin(3) },
  origin: origin(1),
  ...over,
});
const moduleOf = (...decls) => ({ kind: 'Module', schemaVersion: 2, name: 'm', profile: null, decls, origin: origin(1) });
const bytes = (tree) => canonicalJson(tree);
const ok = (tree) => ({ ok: true, bytes: bytes(tree) });
const noProblems = () => [];

/** 一个类别豁免（V1–V3）的最小合法配置；match 默认等于 ADR §6 的位置定义。 */
const v1 = (over = {}) => ({
  id: 'V1', issue: 'https://github.com/aster-cloud/aster-lang-test/issues/1', owner: '两引擎类型检查维护者',
  expires: '2027-01-31', scope: 'category', files: [FILE],
  match: (path, node, parent) => path.endsWith('.ret') && parent?.kind === 'Func' && parent.retTypeInferred === true,
  ...over,
});
const v2 = (over = {}) => ({
  id: 'V2', issue: 'https://github.com/aster-cloud/aster-lang-test/issues/2', owner: '效应 / 能力检查维护者',
  expires: '2027-01-31', scope: 'category', files: [FILE],
  match: (path, node, parent) => path.endsWith('.effectCaps') && parent?.kind === 'Func' && parent.effectCapsExplicit === false,
  ...over,
});
const v4 = (entries, over = {}) => ({
  id: 'V4', issue: 'https://github.com/aster-cloud/aster-lang-test/issues/4', owner: 'Java parser 维护者',
  expires: '2027-01-31', scope: 'entries', entries, ...over,
});

const ledgerOf = (exemptions, today = '2026-11-14') => createExemptionLedger(exemptions, { today });
const judge = (tsTree, javaTree, ledger, { validate = noProblems, file = FILE } = {}) =>
  judgeSample({ file, ts: ok(tsTree), java: ok(javaTree), validate, canonicalJson, ledger });

console.log('ir-byte-parity');

check('identical bytes pass', () => {
  const m = moduleOf(func());
  const row = judge(m, m, ledgerOf([]));
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(row.diffs, []);
});

check('origin col difference ignored', () => {
  const a = moduleOf(func({ origin: origin(1, 1, 1, 9) }));
  const b = moduleOf(func({ origin: origin(1, 2, 1, 30) }));
  assert.notStrictEqual(bytes(a), bytes(b));
  assert.strictEqual(judge(a, b, ledgerOf([])).verdict, 'identical');
});

check('projectForCompare 只删除 origin.start.col / origin.end.col，不改原树', () => {
  const tree = moduleOf(func());
  const before = bytes(tree);
  const projected = projectForCompare(tree);
  assert.strictEqual(bytes(tree), before);
  assert.deepStrictEqual(projected.origin.start, { line: 1 });
  assert.deepStrictEqual(projected.decls[0].ret.origin.end, { line: 2 });
  assert.strictEqual(projected.decls[0].ret.origin.written, null);
});

check('exempt V1 subtree difference ignored', () => {
  const a = moduleOf(func({ retTypeInferred: true, ret: { kind: 'TypeVar', name: 'T', origin: origin(2) } }));
  const b = moduleOf(func({ retTypeInferred: true, ret: typeName('Int') }));
  const ledger = ledgerOf([v1()]);
  const row = judge(a, b, ledger);
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(row.exempted, { V1: 1 });
  assert.deepStrictEqual(exemptionFindings(ledger), []);
});

check('V1 不覆盖 retTypeInferred=false 的 ret（kind 不同即 shape-diff）', () => {
  const a = moduleOf(func({ ret: { kind: 'TypeVar', name: 'T', origin: origin(2) } }));
  const b = moduleOf(func({ ret: typeName('Int') }));
  const row = judge(a, b, ledgerOf([v1()]));
  assert.strictEqual(row.verdict, 'shape-diff');
  assert.strictEqual(row.diffs[0].path, '$.decls[0].ret.kind');
});

check('V1 不覆盖未登记文件', () => {
  const a = moduleOf(func({ retTypeInferred: true, ret: typeName('Text') }));
  const b = moduleOf(func({ retTypeInferred: true, ret: typeName('Int') }));
  const row = judge(a, b, ledgerOf([v1()]), { file: 'tier1-equivalence/policies/other.aster' });
  assert.strictEqual(row.verdict, 'value-diff');
});

check('field name difference fails as shape-diff', () => {
  const a = moduleOf(func());
  const b = moduleOf(func());
  delete b.decls[0].inputRefs;
  b.decls[0].inputRef = null;
  const row = judge(a, b, ledgerOf([]));
  assert.strictEqual(row.verdict, 'shape-diff');
  const paths = row.diffs.map((d) => d.path).sort();
  assert.deepStrictEqual(paths, ['$.decls[0].inputRef', '$.decls[0].inputRefs']);
  assert.ok(row.diffs.every((d) => d.class === 'shape'));
});

check('数组长度不同报 shape-diff', () => {
  const a = moduleOf(func({ effects: ['io'] }));
  const b = moduleOf(func({ effects: [] }));
  const row = judge(a, b, ledgerOf([]));
  assert.strictEqual(row.verdict, 'shape-diff');
  assert.deepStrictEqual(row.diffs[0], { class: 'shape', path: '$.decls[0].effects', ts: '["io"]', java: '[]' });
});

check('scalar difference outside exemptions fails as value-diff with path and both values', () => {
  const a = moduleOf(func({ name: 'f' }));
  const b = moduleOf(func({ name: 'g' }));
  const row = judge(a, b, ledgerOf([v1(), v2()]));
  assert.strictEqual(row.verdict, 'value-diff');
  assert.deepStrictEqual(row.diffs, [{ class: 'value', path: '$.decls[0].name', ts: '"f"', java: '"g"' }]);
});

check('origin.end.line 差异不在豁免内即 value-diff', () => {
  const a = moduleOf(func({ origin: origin(1, 1, 4) }));
  const b = moduleOf(func({ origin: origin(1, 1, 5) }));
  const row = judge(a, b, ledgerOf([]));
  assert.strictEqual(row.verdict, 'value-diff');
  assert.strictEqual(row.diffs[0].path, '$.decls[0].origin.end.line');
});

check('category exemption with zero exempted diffs in a full run reports stale-exemption', () => {
  const ledger = ledgerOf([v1(), v2()]);
  const m = moduleOf(func({ retTypeInferred: true }));
  assert.strictEqual(judge(m, m, ledger).verdict, 'identical');
  const findings = exemptionFindings(ledger);
  assert.deepStrictEqual(findings.map((f) => [f.verdict, f.id, f.file ?? null]).sort(),
    [['stale-exemption', 'V1', null], ['stale-exemption', 'V2', null]]);
});

check('类别仍有差异时，登记文件中不再有差异的一份只列为可收窄范围，不报 stale', () => {
  const other = 'tier1-equivalence/policies/other.aster';
  const ledger = ledgerOf([v1({ files: [FILE, other] })]);
  judge(moduleOf(func({ retTypeInferred: true, ret: typeName('Text') })),
    moduleOf(func({ retTypeInferred: true, ret: typeName('Int') })), ledger);
  const same = moduleOf(func({ retTypeInferred: true }));
  judge(same, same, ledger, { file: other });
  assert.deepStrictEqual(exemptionFindings(ledger), []);
  assert.deepStrictEqual(narrowableScopes(ledger), [{ id: 'V1', file: other }]);
});

const lambdaFunc = (captures) => func({ body: { kind: 'Block', origin: origin(3), statements: [{ kind: 'Return', origin: origin(3),
  expr: { kind: 'Lambda', params: [], ret: typeName('Int', origin(3)), captures, origin: origin(3),
    body: { kind: 'Block', statements: [], origin: origin(3) } } }] } });
const v3 = (over = {}) => ({
  id: 'V3', issue: 'https://github.com/aster-cloud/aster-lang-test/issues/3', owner: 'ts lowering 维护者',
  expires: '2027-01-31', scope: 'category', files: [FILE],
  match: (path, node, parent) => path.endsWith('.captures') && parent?.kind === 'Lambda', ...over,
});

check('V3 覆盖 Lambda.captures 数组（含长度不同）', () => {
  const ledger = ledgerOf([v3()]);
  const row = judge(moduleOf(lambdaFunc([])), moduleOf(lambdaFunc(['get', 'io'])), ledger);
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(row.exempted, { V3: 1 });
});

check('V3 不覆盖 Lambda 的其它字段', () => {
  const wide = v3({ match: (path, node, parent) => parent?.kind === 'Lambda' && (path.endsWith('.captures') || path.endsWith('.ret')) });
  const a = moduleOf(lambdaFunc([]));
  const b = moduleOf(lambdaFunc([]));
  b.decls[0].body.statements[0].expr.ret = typeName('Text', origin(3));
  assert.throws(() => judge(a, b, ledgerOf([wide])), /V3.*\.ret/);
});

check('expired exemption fails even when diffs remain', () => {
  const ledger = ledgerOf([v1()], '2027-02-01');
  const row = judge(moduleOf(func({ retTypeInferred: true, ret: typeName('Text') })),
    moduleOf(func({ retTypeInferred: true, ret: typeName('Int') })), ledger);
  assert.strictEqual(row.verdict, 'value-diff', '到期后该类别失效，差异照常报出');
  const findings = exemptionFindings(ledger);
  assert.deepStrictEqual(findings.map((f) => [f.verdict, f.id]), [['expired-exemption', 'V1']]);
});

check('到期日当天仍有效（运行日期晚于 expires 才失效）', () => {
  const ledger = ledgerOf([v1()], '2027-01-31');
  const row = judge(moduleOf(func({ retTypeInferred: true, ret: typeName('Text') })),
    moduleOf(func({ retTypeInferred: true, ret: typeName('Int') })), ledger);
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(exemptionFindings(ledger), []);
});

check('exemption without expires is a config error', () => {
  const { expires, ...noExpires } = v1();
  assert.throws(() => validateExemptions([noExpires]), ExemptionConfigError);
  assert.throws(() => createExemptionLedger([noExpires], { today: '2026-11-14' }), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ expires: '2027-1-31' })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ expires: '2027-02-15' })]), ExemptionConfigError, '截止日最晚 2027-01-31');
});

check('豁免表其它配置错误：缺 issue / owner、未知类别、重复类别、空文件清单、V4 路径不是 origin.end.line', () => {
  assert.throws(() => validateExemptions([v1({ issue: undefined })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ issue: 'see chat' })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ owner: '' })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ id: 'V9' })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1(), v1()]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ files: [] })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v1({ scope: 'entries' })]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v4([{ file: FILE, path: '$.decls[0].origin.start.line' }])]), ExemptionConfigError);
  assert.throws(() => validateExemptions([v4([])]), ExemptionConfigError);
});

check('V4 entry with no diff reports stale-exemption', () => {
  const ledger = ledgerOf([v4([{ file: FILE, path: '$.decls[0].origin.end.line' }])]);
  const m = moduleOf(func());
  assert.strictEqual(judge(m, m, ledger).verdict, 'identical');
  assert.deepStrictEqual(exemptionFindings(ledger).map((f) => [f.verdict, f.id, f.file, f.path]),
    [['stale-exemption', 'V4', FILE, '$.decls[0].origin.end.line']]);
});

check('V4 登记项上的行号差异被豁免', () => {
  const ledger = ledgerOf([v4([{ file: FILE, path: '$.decls[0].origin.end.line' }])]);
  const row = judge(moduleOf(func({ origin: origin(1, 1, 4) })), moduleOf(func({ origin: origin(1, 1, 5) })), ledger);
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(row.exempted, { V4: 1 });
  assert.deepStrictEqual(exemptionFindings(ledger), []);
});

check('V4 line diff not in entries fails', () => {
  const ledger = ledgerOf([v4([{ file: FILE, path: '$.decls[0].origin.end.line' }])]);
  const a = moduleOf(func({ origin: origin(1, 1, 4), ret: typeName('Int', origin(2, 1, 2)) }));
  const b = moduleOf(func({ origin: origin(1, 1, 5), ret: typeName('Int', origin(2, 1, 3)) }));
  const row = judge(a, b, ledger);
  assert.strictEqual(row.verdict, 'value-diff');
  assert.deepStrictEqual(row.diffs.map((d) => d.path), ['$.decls[0].ret.origin.end.line']);
});

check('V1 matcher on non-type node throws', () => {
  const blanket = v1({ match: () => true });
  const m = moduleOf(func({ retTypeInferred: true }));
  assert.throws(() => judge(m, moduleOf(func({ retTypeInferred: true, name: 'g' })), ledgerOf([blanket])),
    /V1.*\$\.decls/);
});

check('V2 / V3 matcher 只能命中对应数组', () => {
  const wideV2 = v2({ match: (path) => path.endsWith('.effects') || path.endsWith('.effectCaps') });
  const m = moduleOf(func({ effects: ['io'] }));
  assert.throws(() => judge(m, moduleOf(func({ effects: ['cpu'] })), ledgerOf([wideV2])), /V2/);
  const wideV3 = { ...v2(), id: 'V3', owner: 'ts lowering 维护者', match: (path) => path.endsWith('.effectCaps') };
  assert.throws(() => judge(m, moduleOf(func({ effects: ['io'], effectCaps: ['Http'] })), ledgerOf([wideV3])), /V3/);
});

check('effectCapsExplicit difference fails even when V2 active', () => {
  const a = moduleOf(func({ effectCapsExplicit: false, effectCaps: ['Http'] }));
  const b = moduleOf(func({ effectCapsExplicit: true, effectCaps: ['Sql'] }));
  const row = judge(a, b, ledgerOf([v2()]));
  assert.strictEqual(row.verdict, 'value-diff');
  assert.deepStrictEqual(row.diffs.map((d) => d.path).sort(), ['$.decls[0].effectCapsExplicit', '$.decls[0].effectCaps[0]']);
});

check('V2 覆盖 effectCapsExplicit=false 的 effectCaps 数组（含长度不同）', () => {
  const a = moduleOf(func({ effectCaps: ['Http', 'Sql'] }));
  const b = moduleOf(func({ effectCaps: [] }));
  const row = judge(a, b, ledgerOf([v2()]));
  assert.strictEqual(row.verdict, 'identical');
  assert.deepStrictEqual(row.exempted, { V2: 1 });
});

check('schema-invalid side fails', () => {
  const m = moduleOf(func());
  const validate = (tree) => (tree === null ? [] : [{ path: '/decls/0', code: 'schema' }]);
  const row = judge(m, m, ledgerOf([]), { validate });
  assert.strictEqual(row.verdict, 'schema-invalid');
  assert.deepStrictEqual(row.problems.map((p) => p.side), ['ts', 'java']);
});

check('非规范字节（键序或空白不符）判 schema-invalid', () => {
  const m = moduleOf(func());
  const row = judgeSample({
    file: FILE, ts: { ok: true, bytes: JSON.stringify(m, null, 2) }, java: ok(m),
    validate: noProblems, canonicalJson, ledger: ledgerOf([]),
  });
  assert.strictEqual(row.verdict, 'schema-invalid');
  assert.deepStrictEqual(row.problems, [{ side: 'ts', path: '', code: 'non-canonical-bytes' }]);
});

check('一侧失败分别报 ts-failed / java-failed', () => {
  const m = moduleOf(func());
  const base = { file: FILE, validate: noProblems, canonicalJson, ledger: ledgerOf([]) };
  assert.strictEqual(judgeSample({ ...base, ts: { ok: false, error: 'boom' }, java: ok(m) }).verdict, 'ts-failed');
  assert.strictEqual(judgeSample({ ...base, ts: ok(m), java: { ok: false, error: 'boom' } }).verdict, 'java-failed');
});

check('判定取值只来自 IR_VERDICTS', () => {
  assert.deepStrictEqual([...IR_VERDICTS].sort(), ['expired-exemption', 'identical', 'java-failed', 'schema-invalid',
    'shape-diff', 'stale-exemption', 'ts-failed', 'value-diff']);
});

// ── parity-tier1.mjs 中真实的豁免表 ──
const { VALUE_EXEMPTIONS } = await import('./parity-tier1.mjs');

check('VALUE_EXEMPTIONS 配置合法：每项有 issue 链接、owner 角色与 2027-01-31 截止', () => {
  validateExemptions(VALUE_EXEMPTIONS);
  for (const e of VALUE_EXEMPTIONS) {
    assert.match(e.issue, /^https:\/\/github\.com\/aster-cloud\/aster-lang-test\/issues\/\d+$/);
    assert.strictEqual(e.expires, '2027-01-31');
  }
});

check('VALUE_EXEMPTIONS 的文件均在 tier1 manifest 中', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'corpus', 'tier1-parity', 'manifest.json'), 'utf8'));
  const rels = new Set(manifest.samples.map((s) => (typeof s === 'string' ? s : s.path)));
  for (const e of VALUE_EXEMPTIONS) {
    for (const f of e.files ?? e.entries.map((x) => x.file)) assert.ok(rels.has(f), `${e.id}: ${f} 不在 manifest`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
