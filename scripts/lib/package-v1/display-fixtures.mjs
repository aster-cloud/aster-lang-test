/**
 * 包格式 1.1 显示排版夹具（ADR 0059 修订 4；计划 T1 Step 5）：src/display/ 的源夹具 → display/ 目录下的黄金包、
 * 编辑后的显示文本、用例与篡改夹具。
 *
 * 为什么单独放在 display/ 而不是 packages/、tamper/：两个 CLI 现有的一致性运行器遍历 packages/*.cases.json 与
 * tamper/cases.json，不认识 requiresFormat；新用例放进去会让尚不支持 1.1 的 CLI 主干变红（计划裁决 PR1 要求每个
 * PR 合入时 main 全绿）。display/ 下每条用例都带 requiresFormat:"1.1"，由支持 1.1 的运行器读取。
 *
 * 期望值的来源：stdout 字节由本模块按 README「显示排版」的规则推导；反向映射的结论（unique / unmappable / ambiguous）
 * 由 fixture.json 手写并与参照实现 display.mjs 比对；matchesPackage 与求值结果手写（两个 CLI 在一致性门里复算）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.mjs';
import {
  ANCHOR_JWKS, TEST_KEY, TEST_ISSUER, TEST_KID, assemble, buildPackage, errorOut, inputJson, inspectOutput, jsonFile, loadSources,
  okEnvelope, runMeta, sha256sums, verifyOutput,
} from './fixtures.mjs';
import { signManifest } from './signing.mjs';
import {
  DisplayRuleError, checkDerivedLayout, checkPackageLayout, parseLayoutStrict, reconstructFromDisplay, toCanonical, toDisplay,
} from './display.mjs';
import { KEYWORD_SPELLINGS } from './display-vectors.mjs';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const utf8 = (s) => Buffer.from(s, 'utf8');
export const REQUIRES = '1.1';
const ANCHOR = ['--jwks', `../${ANCHOR_JWKS}`];

/** 词法表中 11 个运算符 kind 的名字（core UserAliasValidator 的运算符档）。 */
const OPERATOR_KINDS = new Set(KEYWORD_SPELLINGS.operatorKinds);

/** checkPackageLayout 的词汇与拼写参数（README「显示排版」：包 locale ∪ en-US，运算符另并入 aliasSet 别名）。 */
export function ruleContext(locale, aliasSet, vocabulary) {
  const loc = KEYWORD_SPELLINGS.locales[locale];
  const en = KEYWORD_SPELLINGS.locales['en-US'];
  const vocabularyLocalized = [];
  for (const [k, v] of Object.entries(vocabulary ?? {})) {
    if (!Array.isArray(v)) continue;
    for (const e of v) if (e && typeof e.localized === 'string') vocabularyLocalized.push(e.localized);
    void k;
  }
  const aliases = Object.entries(aliasSet ?? {}).filter(([k]) => OPERATOR_KINDS.has(k)).flatMap(([, v]) => v);
  return {
    vocabularyLocalized,
    literalKeywords: [...loc.literal, ...en.literal],
    operatorSpellings: [...loc.operator, ...en.operator, ...aliases],
  };
}

/** 编辑后的显示文件 → reconstructFromDisplay 的输入（严格 UTF-8、去至多一个 BOM）；非法 UTF-8 为 null（USAGE）。 */
function decodeEdited(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** 读 src/display/：与 src/ 同一形态，另有 layout.json 与 displays/*.txt。 */
export function loadDisplaySources(srcDir) {
  const dir = join(srcDir, 'display');
  const defs = loadSources(dir, { readLayout: true });
  for (const def of defs.values()) {
    const vocab = def.vocabulary ? JSON.parse(readFileSync(join(def.sourceDir, 'vocabulary.json'), 'utf8')) : null;
    def.vocabularyJson = vocab;
    def.ruleContext = ruleContext(def.locale, def.aliasSet, vocab);
    if (!def.layoutBytes) continue;
    // 源夹具的排版必须通过 L1–L7：签名包里的排版一定过得了 CLI 的 verify（修订 D11 的不变式）
    const layout = parseLayoutStrict(def.layoutBytes);
    def.layout = layout;
    def.displayBytes = utf8(toDisplay(layout));
    checkPackageLayout({
      layoutBytes: def.layoutBytes, displayBytes: def.displayBytes, source: readFileSync(join(def.sourceDir, 'policy.aster')),
      layoutVersion: 1, ...def.ruleContext,
    });
    const edits = join(def.sourceDir, 'displays');
    def.edits = existsSync(edits) ? new Map(readdirSync(edits).sort().map((f) => [f, readFileSync(join(edits, f))])) : new Map();
  }
  return defs;
}

const SHOW_META = (signed) => ({ cliVersion: '<CLI_VERSION>', coreIrSha256: null, engine: '<ENGINE>', entry: null, irRecompiled: false, signed });

/** run --display / show --from-display 的阶段（README「run --display」）。 */
const DISPLAY_RUN_STAGES = ['usage', 'read', 'manifest', 'signature', 'integrity', 'display', 'reconstruct', 'derived', 'compile', 'display-ir', 'entry', 'input', 'eval', 'done'];
const DISPLAY_STAGE_OF = {
  USAGE: 'usage', PKG_DISPLAY_INVALID: 'display', DISPLAY_UNMAPPABLE: 'reconstruct', DISPLAY_AMBIGUOUS: 'reconstruct',
  COMPILE_ERROR: 'compile', ENTRY_NOT_FOUND: 'entry', INPUT_INVALID: 'input', EVAL_ERROR: 'eval', TIMEOUT: 'eval', RESOURCE_EXHAUSTED: 'eval',
};
const atOrAfter = (stage, ref) => DISPLAY_RUN_STAGES.indexOf(stage) >= DISPLAY_RUN_STAGES.indexOf(ref);

/**
 * run --display 的 meta：signed 同 run；派生程序编译并通过 L8/L9 之后（entry 阶段起）entry 为所选入口、irRecompiled 为
 * true、带 display 成员；coreIrSha256 恒为 null（执行的不是 manifest 记录的 IR）。
 */
function displayRunMeta(pkg, stage, { entry, allowUnsigned, display }) {
  const haveIr = atOrAfter(stage, 'entry');
  const meta = {
    cliVersion: '<CLI_VERSION>',
    coreIrSha256: null,
    engine: '<ENGINE>',
    entry: haveIr ? entry : null,
    irRecompiled: haveIr,
    signed: atOrAfter(stage, 'integrity') && pkg.signed && !(allowUnsigned && !pkg.signed),
  };
  if (haveIr) meta.display = display;
  return meta;
}

function entryOfFlags(flags, def) {
  const i = flags.findIndex((f) => f === '--entry' || f.startsWith('--entry='));
  if (i < 0) return def.entries.find((e) => e.default).function;
  return flags[i].startsWith('--entry=') ? flags[i].slice('--entry='.length) : flags[i + 1];
}

/** 一条编辑的反向映射；与 fixture.json 声明的 reconstruct 比对，不符即生成失败。 */
function reconstructEdit(def, file, declared) {
  const bytes = def.edits.get(file);
  if (!bytes) throw new Error(`${def.name}: 缺少 displays/${file}`);
  const text = decodeEdited(bytes);
  if (text === null) {
    if (declared !== 'usage') throw new Error(`${def.name}/${file}: 非法 UTF-8，须声明 reconstruct:"usage"`);
    return { kind: 'usage' };
  }
  const r = reconstructFromDisplay(def.layout, text);
  if (r.kind !== declared) throw new Error(`${def.name}/${file}: 参照实现得 ${r.kind}，fixture 声明 ${declared}`);
  if (r.kind === 'unique') {
    try {
      checkDerivedLayout(r.layout, def.ruleContext.vocabularyLocalized, def.ruleContext.literalKeywords, def.ruleContext.operatorSpellings);
      r.derivedOk = true;
    } catch (e) {
      if (!(e instanceof DisplayRuleError)) throw e;
      r.derivedOk = false;
    }
    r.canonical = toCanonical(r.layout);
  }
  return r;
}

const EDIT_DIR = (pkgName) => `../edits/${pkgName}`;

/** 一个显示排版黄金包的用例（command：run / verify / inspect / show；rawArgs 为命令行语法用例）。 */
function displayPackageCases(pkg, exitCodes) {
  const def = pkg.def;
  const rows = [];
  for (const c of def.cases) {
    const flags = c.args ?? [];
    const allowUnsigned = flags.includes('--allow-unsigned');
    const target = c.target ?? pkg.name;
    const anchor = c.anchor === 'none' || allowUnsigned ? [] : ANCHOR;
    let args;
    let out;
    const editArg = (opt) => (c[opt] ? [`--${opt === 'fromDisplay' ? 'from-display' : 'display'}`, `${EDIT_DIR(pkg.name)}/${c[opt]}`] : []);
    if (c.rawArgs) {
      args = c.rawArgs.map((a) => a.replaceAll('{pkg}', target).replaceAll('{edits}', EDIT_DIR(pkg.name)));
      out = errorOut(c.expect.code, SHOW_META(false), exitCodes);
    } else if (c.command === 'show') {
      args = ['show', target, ...flags, ...editArg('fromDisplay'), ...anchor];
      out = showOutput(pkg, c, exitCodes);
    } else if (c.command === 'run' && c.display) {
      args = ['run', target, ...flags, ...editArg('display'), '--input', '-', ...anchor];
      out = runDisplayOutput(pkg, c, exitCodes);
    } else if (c.command === 'run') {
      args = ['run', target, ...flags, '--input', '-', ...anchor];
      const entry = entryOfFlags(flags, def);
      if (typeof c.expect === 'object') out = errorOut(c.expect.code, runMeta(pkg, c.expect.stage, { entry, allowUnsigned }), exitCodes);
      else out = { stdout: okEnvelope(runMeta(pkg, 'done', { entry, allowUnsigned }), c.value), exit: 0, code: null };
    } else if (c.command === 'verify') {
      args = ['verify', target, ...flags, ...anchor];
      out = verifyOutput(pkg, flags, c.failure ?? null, exitCodes);
    } else if (c.command === 'inspect') {
      args = ['inspect', target, ...flags, ...anchor];
      out = inspectOutput(pkg, flags, c.failure ?? null, exitCodes);
    } else throw new Error(`${pkg.name}/${c.name}: 未知命令 ${c.command}`);
    const row = { name: c.name, requiresFormat: REQUIRES, args };
    if (c.input !== undefined) row.stdin = inputJson(c.input);
    rows.push(Object.assign(row, { expectedStdout: out.stdout, expectedExit: out.exit, code: out.code }));
  }
  return { description: def.description, package: pkg.name, requiresFormat: REQUIRES, cases: rows };
}

/**
 * show 的输出（README「show」）：stdout 不是 JSON——有排版为 display.aster 的字节 + \n；无排版或 --canonical 为
 * policy/policy.aster 的字节 + \n；--from-display 为还原出的规范源码 + \n。失败输出与 run 相同的错误信封，meta 不取 IR。
 */
function showOutput(pkg, c, exitCodes) {
  const flags = c.args ?? [];
  const allowUnsigned = flags.includes('--allow-unsigned');
  const signed = pkg.signed && !(allowUnsigned && !pkg.signed);
  if (!pkg.signed && !allowUnsigned) return errorOut('PKG_UNSIGNED', SHOW_META(false), exitCodes);
  if (typeof c.expect === 'object') {
    const stage = c.expect.stage ?? DISPLAY_STAGE_OF[c.expect.code] ?? 'display';
    return errorOut(c.expect.code, SHOW_META(atOrAfter(stage, 'integrity') && signed), exitCodes);
  }
  const hasDisplay = Boolean(pkg.manifest.display);
  if (c.fromDisplay) {
    if (!hasDisplay) return errorOut('PKG_DISPLAY_INVALID', SHOW_META(signed), exitCodes);
    const r = reconstructEdit(pkg.def, c.fromDisplay, c.reconstruct ?? 'unique');
    if (r.kind !== 'unique') throw new Error(`${pkg.name}/${c.name}: 成功的 show --from-display 须唯一解`);
    return { stdout: `${r.canonical}\n`, exit: 0, code: null };
  }
  const bytes = hasDisplay && !flags.includes('--canonical') ? pkg.files.get('policy/display/display.aster') : pkg.files.get('policy/policy.aster');
  return { stdout: `${bytes.toString('utf8')}\n`, exit: 0, code: null };
}

/** run --display 的输出（README「run --display」）。 */
function runDisplayOutput(pkg, c, exitCodes) {
  const flags = c.args ?? [];
  const allowUnsigned = flags.includes('--allow-unsigned');
  const entry = entryOfFlags(flags, pkg.def);
  const r = reconstructEdit(pkg.def, c.display, c.reconstruct ?? 'unique');
  const display = r.kind === 'unique' ? { canonicalSha256: sha256Hex(utf8(r.canonical)), matchesPackage: c.matchesPackage } : undefined;
  if (r.kind === 'unique' && typeof c.matchesPackage !== 'boolean') throw new Error(`${pkg.name}/${c.name}: 唯一解的用例须声明 matchesPackage`);
  if (r.kind === 'unique' && !r.derivedOk && c.expect?.code !== 'DISPLAY_REJECTED') throw new Error(`${pkg.name}/${c.name}: 派生排版过不了 L2/L5–L7，须期望 DISPLAY_REJECTED`);
  if (typeof c.expect === 'object') {
    const stage = c.expect.stage ?? (c.expect.code === 'DISPLAY_REJECTED' ? 'display-ir' : DISPLAY_STAGE_OF[c.expect.code]);
    if (!stage) throw new Error(`${pkg.name}/${c.name}: 无法推断 ${c.expect.code} 的阶段`);
    return errorOut(c.expect.code, displayRunMeta(pkg, stage, { entry, allowUnsigned, display }), exitCodes);
  }
  if (r.kind !== 'unique') throw new Error(`${pkg.name}/${c.name}: 成功的 run --display 须唯一解`);
  return { stdout: okEnvelope(displayRunMeta(pkg, 'done', { entry, allowUnsigned, display }), c.value), exit: 0, code: null };
}

// ---------------------------------------------------------------------------
// 篡改夹具（display/tamper/）
// ---------------------------------------------------------------------------
/** 载荷换掉若干文件、files[] 同步、按需改 manifest，再重新签名（或去掉签名）。 */
function rebuild(base, { set = {}, remove = [], edit = null, unsigned = false }) {
  const payload = new Map(base.payload);
  for (const [p, b] of Object.entries(set)) payload.set(p, b);
  for (const p of remove) payload.delete(p);
  const manifest = structuredClone(base.manifest);
  const paths = [...payload.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
  manifest.files = paths.map((p) => ({ path: p, sha256: sha256Hex(payload.get(p)), size: payload.get(p).length }));
  if (edit) edit(manifest);
  return assemble({ ...base, payload, manifest, manifestBytes: undefined, signed: !unsigned });
}

/** 去掉 files[] 中的某个条目但保留 display（manifest 语义规则失败）。 */
function withoutListed(base, path) {
  return rebuild(base, { remove: [path] });
}

const TAMPERS = {
  /** 改 display.aster 的一个字并重新签名：签名与完整性都成立，只有 L4 失败。 */
  'display-text-tampered-resigned': (base) => ({ pkg: rebuild(base, { set: { 'policy/display/display.aster': utf8(base.files.get('policy/display/display.aster').toString('utf8').replace('明月光', '明月照')) } }), rule: 'L4' }),
  /** layout.json 换成带空白的同义 JSON：L1（不是规范序列化）。 */
  'display-layout-not-canonical-resigned': (base) => ({ pkg: rebuild(base, { set: { 'policy/display/layout.json': utf8(JSON.stringify(JSON.parse(base.files.get('policy/display/layout.json').toString('utf8')), null, 1)) } }), rule: 'L1' }),
  /** 改排版里一个内容 span（display.aster 同步重算）：L3（toCanonical 与 policy.aster 不符）。 */
  'display-roundtrip-mismatch-resigned': (base) => {
    const layout = JSON.parse(base.files.get('policy/display/layout.json').toString('utf8'));
    layout.spans = layout.spans.map((s) => (s.text === '明月光' ? { text: '明月照' } : s));
    const text = `{"v":1,"spans":[${layout.spans.map((s) => ('text' in s ? `{"text":${JSON.stringify(s.text)}}` : `{"canonical":${JSON.stringify(s.canonical)},"display":${JSON.stringify(s.display)}}`)).join(',')}]}`;
    return { pkg: rebuild(base, { set: { 'policy/display/layout.json': utf8(text), 'policy/display/display.aster': utf8(toDisplay(layout)) } }), rule: 'L3' };
  },
  /** 把「明月光」切成内容「明月」+ 结构「光」：L1–L7 都过（verify 通过），L9 补空格把名字切开 → display-ir 失败。 */
  'display-splits-name-resigned': (base) => {
    const layout = JSON.parse(base.files.get('policy/display/layout.json').toString('utf8'));
    layout.spans = layout.spans.flatMap((s) => (s.text === '明月光' ? [{ text: '明月' }, { canonical: '光', display: '光' }] : [s]));
    const text = `{"v":1,"spans":[${layout.spans.map((s) => ('text' in s ? `{"text":${JSON.stringify(s.text)}}` : `{"canonical":${JSON.stringify(s.canonical)},"display":${JSON.stringify(s.display)}}`)).join(',')}]}`;
    return { pkg: rebuild(base, { set: { 'policy/display/layout.json': utf8(text), 'policy/display/display.aster': utf8(toDisplay(layout)) } }), rule: 'L9' };
  },
  /** manifest 有 display 但 files[] 缺 layout.json：manifest 语义规则（PKG_INVALID_MANIFEST）。 */
  'display-missing-file': (base) => ({ pkg: withoutListed(base, 'policy/display/layout.json'), manifestCode: 'PKG_INVALID_MANIFEST' }),
  /** formatVersion 1.0 却带 display：1.0 schema 拒绝（PKG_INVALID_MANIFEST）。 */
  'display-in-1-0-manifest': (base) => ({ pkg: rebuild(base, { edit: (m) => { m.formatVersion = '1.0'; } }), manifestCode: 'PKG_INVALID_MANIFEST' }),
  /** 1.1 不带 display 成员、files[] 里仍有两个文件：只是普通载荷，show 打印规范源码。 */
  'display-files-without-member': (base) => ({ pkg: rebuild(base, { edit: (m) => { delete m.display; } }), noDisplay: true }),
  /** 无签名的 1.1 包：show 须 --allow-unsigned，照常打印并在 stderr 提示未核验。 */
  'display-unsigned': (base) => ({ pkg: rebuild(base, { unsigned: true }), unsigned: true }),
  /**
   * 隐藏转义的开反引号结构 span 显示成反引号本身（ADR 0059 修订 5 L10a 第 1 条，向量 E13）：派生自 b-display-escape，
   * display.aster 同步重算并重新签名；verify 在 display 检查项失败，show 同样拒绝，普通 run 不检查排版。
   */
  'display-escape-delimiter-shown-resigned': {
    base: 'b-display-escape',
    input: { 当: 7 },
    value: '7',
    make: (base) => {
      const layout = JSON.parse(base.files.get('policy/display/layout.json').toString('utf8'));
      const at = layout.spans.findIndex((s) => !('text' in s) && s.canonical === '`');
      layout.spans[at] = { canonical: '`', display: '`' };
      const text = `{"v":1,"spans":[${layout.spans.map((s) => ('text' in s ? `{"text":${JSON.stringify(s.text)}}` : `{"canonical":${JSON.stringify(s.canonical)},"display":${JSON.stringify(s.display)}}`)).join(',')}]}`;
      return { pkg: rebuild(base, { set: { 'policy/display/layout.json': utf8(text), 'policy/display/display.aster': utf8(toDisplay(layout)) } }), rule: 'L10a' };
    },
  },
};

export function displayTampers(dpkgs, exitCodes) {
  const files = new Map();
  const rows = [];
  for (const [name, spec] of Object.entries(TAMPERS)) {
    // 多数篡改派生自 b-jingyesi；带 base 的篡改另给基包与 run 的输入、值
    const baseName = typeof spec === 'function' ? 'b-jingyesi' : spec.base;
    const base = dpkgs.get(baseName);
    const def = base.def;
    const make = typeof spec === 'function' ? spec : spec.make;
    const t = make(base);
    const pkg = { ...t.pkg, def: { ...def, name } };
    for (const [p, b] of pkg.files) files.set(`${name}/${p}`, b);
    // 声明的规则号必须与参照实现一致（L9 需要编译，参照实现只确认 L1–L7 通过）
    if (t.rule) {
      let got = 'ok';
      try {
        checkPackageLayout({
          layoutBytes: pkg.files.get('policy/display/layout.json'), displayBytes: pkg.files.get('policy/display/display.aster'),
          source: pkg.files.get('policy/policy.aster'), layoutVersion: 1, ...def.ruleContext,
        });
      } catch (e) {
        if (!(e instanceof DisplayRuleError)) throw e;
        got = e.rule;
      }
      if (got !== (t.rule === 'L9' ? 'ok' : t.rule)) throw new Error(`display/tamper/${name}: 参照实现得 ${got}，声明 ${t.rule}`);
    }
    const unsigned = t.unsigned === true;
    const anchor = unsigned ? ['--allow-unsigned'] : ANCHOR;
    const push = (suffix, args, out, stdin) => {
      const row = { name: suffix ? `${name} (${suffix})` : name, base: baseName, requiresFormat: REQUIRES, args: [...args, ...anchor] };
      if (stdin !== undefined) row.stdin = stdin;
      rows.push(Object.assign(row, { expectedStdout: out.stdout, expectedExit: out.exit, code: out.code }));
    };
    const flagsU = unsigned ? ['--allow-unsigned'] : [];
    if (t.manifestCode) {
      const meta = runMeta(pkg, 'manifest', { entry: null, allowUnsigned: false });
      push('', ['run', name, '--input', '-'], errorOut(t.manifestCode, meta, exitCodes), '{}');
      push('verify', ['verify', name], verifyOutput(pkg, [], { stage: 'manifest', code: t.manifestCode }, exitCodes));
      push('inspect', ['inspect', name], inspectOutput(pkg, [], { stage: 'manifest', code: t.manifestCode }, exitCodes));
      push('show', ['show', name], errorOut(t.manifestCode, SHOW_META(false), exitCodes));
      continue;
    }
    const value = typeof spec === 'function' ? '"静夜思"' : spec.value;
    const stdin = typeof spec === 'function' ? '{}' : inputJson(spec.input);
    const entry = def.entries.find((e) => e.default).function;
    // 普通 run 不检查显示排版（只运行签名覆盖的规范源码）
    push('', ['run', name, '--input', '-'], { stdout: okEnvelope(runMeta(pkg, 'done', { entry, allowUnsigned: unsigned }), value), exit: 0, code: null }, stdin);
    const failure = t.rule === 'L9' ? { stage: 'display-ir', code: 'PKG_DISPLAY_INVALID' } : t.rule ? { stage: 'display', code: 'PKG_DISPLAY_INVALID' } : null;
    push('verify', ['verify', name], verifyOutput(pkg, flagsU, failure, exitCodes));
    push('verify --recompile', ['verify', name, '--recompile'], verifyOutput(pkg, [...flagsU, '--recompile'], failure, exitCodes));
    push('inspect', ['inspect', name], inspectOutput(pkg, flagsU, null, exitCodes));
    const signed = !unsigned;
    if (t.rule && t.rule !== 'L9') push('show', ['show', name], errorOut('PKG_DISPLAY_INVALID', SHOW_META(signed), exitCodes));
    else {
      const bytes = t.noDisplay ? pkg.files.get('policy/policy.aster') : pkg.files.get('policy/display/display.aster');
      push('show', ['show', name], { stdout: `${bytes.toString('utf8')}\n`, exit: 0, code: null });
    }
    if (unsigned) {
      // 不给 --allow-unsigned：PKG_UNSIGNED（signature 阶段）
      const row = { name: `${name} (show without --allow-unsigned)`, base: baseName, requiresFormat: REQUIRES, args: ['show', name] };
      const out = errorOut('PKG_UNSIGNED', SHOW_META(false), exitCodes);
      rows.push(Object.assign(row, { expectedStdout: out.stdout, expectedExit: out.exit, code: out.code }));
    }
  }
  return { files, cases: { description: '显示排版的篡改夹具（ADR 0059 修订 4、修订 5；派生自 display/packages/b-jingyesi 与 b-display-escape，全部重新签名）。普通 run 不检查排版；verify 在 display（L1–L7）或 display-ir（L8–L9，仅 --recompile）检查项失败；show 先过 L1–L7。', requiresFormat: REQUIRES, cases: rows } };
}

/** 1.0 包上的 show（计划裁决 Q4）：b-credit-limit。 */
function legacyShowCases(pkgs, exitCodes) {
  const pkg = pkgs.get('b-credit-limit');
  const target = '../../packages/b-credit-limit';
  const policy = pkg.files.get('policy/policy.aster').toString('utf8');
  const row = (name, args, out) => ({ name, requiresFormat: REQUIRES, args: [...args, ...ANCHOR], expectedStdout: out.stdout, expectedExit: out.exit, code: out.code });
  return {
    description: '1.0 包（无显示排版）上的 show：stdout 为 policy/policy.aster 的字节 + \\n，stderr 注明无显示排版；--from-display 没有可对照的排版，为 PKG_DISPLAY_INVALID（ADR 0059 修订 4 D6、§11 Q4）。',
    package: 'b-credit-limit',
    requiresFormat: REQUIRES,
    cases: [
      row('show-without-layout-prints-canonical', ['show', target], { stdout: `${policy}\n`, exit: 0, code: null }),
      row('show-canonical-without-layout', ['show', target, '--canonical'], { stdout: `${policy}\n`, exit: 0, code: null }),
      row('show-from-display-without-layout', ['show', target, '--from-display', '../edits/b-jingyesi/unchanged.txt'], errorOut('PKG_DISPLAY_INVALID', SHOW_META(true), exitCodes)),
      row('run-display-without-layout', ['run', target, '--display', '../edits/b-jingyesi/unchanged.txt', '--input', '-'], errorOut('PKG_DISPLAY_INVALID', SHOW_META(true), exitCodes)),
    ].map((r, i) => (i === 3 ? { ...r, stdin: inputJson({ applicant: { activeDefaults: 0, creditScore: 760, monthlyDebt: '2000', monthlyIncome: '9000', requestedAmount: '20000' } }) } : r)),
  };
}

/** display/ 下全部生成文件：路径（相对 conformance/package-v1）→ 字节。 */
export function displayFixtures(srcDir, pkgs, exitCodes) {
  const out = new Map();
  const defs = loadDisplaySources(srcDir);
  const dpkgs = new Map([...defs.values()].map((d) => [d.name, buildPackage(d)]));
  for (const pkg of dpkgs.values()) {
    for (const [p, bytes] of pkg.files) out.set(`display/packages/${pkg.name}/${p}`, bytes);
    out.set(`display/packages/${pkg.name}.cases.json`, jsonFile(displayPackageCases(pkg, exitCodes)));
    for (const [f, bytes] of pkg.def.edits ?? []) out.set(`display/edits/${pkg.name}/${f}`, bytes);
  }
  out.set('display/packages/b-credit-limit.cases.json', jsonFile(legacyShowCases(pkgs, exitCodes)));
  const tampers = displayTampers(dpkgs, exitCodes);
  for (const [p, bytes] of tampers.files) out.set(`display/tamper/${p}`, bytes);
  out.set('display/tamper/cases.json', jsonFile(tampers.cases));
  return { out, defs, dpkgs };
}

export { TEST_KEY, TEST_ISSUER, TEST_KID, signManifest, sha256sums, canonicalJson };
