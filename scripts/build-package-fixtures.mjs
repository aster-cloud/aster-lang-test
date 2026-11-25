#!/usr/bin/env node
/**
 * 包格式 v1 夹具生成器（ADR 0059 P1 T1）：从 conformance/package-v1/src/ 的源夹具生成黄金包、cases.json、
 * 篡改与畸形 zip 夹具、inputs-invalid 夹具、四组向量与测试密钥文件。幂等：同一输入永远产出同一字节。
 *
 * 用法：
 *   node scripts/build-package-fixtures.mjs             重新生成并写盘（覆盖生成目录）
 *   node scripts/build-package-fixtures.mjs --check     重新生成并与仓内逐字节比较（含多余 / 缺失文件与符号链接），不写盘；CI 用
 *   node scripts/build-package-fixtures.mjs --verify-engines [--ts <dir>] [--guard <dir>] [--assume-ts-display]
 *       用兄弟仓 aster-lang-ts（已 build）与 aster-guard 交叉验证生成结果：ajv 2020 strict 校验三个 schema 与全部
 *       manifest / 签名文件 / expectedStdout；aster-guard jcs.ts 与 ts canonicalJson 对照规范字节；ts 重编译源码比对
 *       positionFreeSha256；ts 解释器复算每个成功用例与 probes 的值。缺省 --ts ../aster-lang-ts、--guard ../aster-guard。
 *   node scripts/build-package-fixtures.mjs --capture --cp-file <cp.txt> --api <url> [--ts <dir>]
 *       重新采集「平台」输入并写入 src/：按 aster-api 生产编译序列（scripts/package-v1/PlatformCompile.java，classpath 为
 *       本地已构建的 aster-api quarkus-app 的 lib/main + lib/boot + app jar，冒号分隔写在 cp.txt）取 platform-core.json；
 *       以本地 aster-api POST /api/v1/policies/evaluate-json 取期望值与值树（expected.json、value-trees.json）；
 *       平台无法表达的输入（非整数 Decimal）用 ts 解释器求期望值并标注 source=ts。只在本地手动运行，CI 不跑。
 *
 * 退出码：0 成功；1 --check / --verify-engines 发现差异；2 用法或环境错误。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ANCHOR_JWKS, TEST_KEY, TEST_KID, UNTRUSTED_KID, buildPackage, buildTamper, inputInvalidCase, jsonFile, keyFiles, loadSources,
  packageCases, positionFreeVectors, signingVectors, stdoutNormalizeVectors, tamperCases, tamperTarget, valueJsonVectors, writeZipOf, anchorFiles, testTimeCases, extraForms, compileFixtures,
} from './lib/package-v1/fixtures.mjs';
import { canonicalJson } from './lib/package-v1/canonical.mjs';
import { parseValueTree, valueJson } from './lib/package-v1/value-json.mjs';
import { positionFreeTree, sha256Hex } from './lib/package-v1/position-free.mjs';
import { publicKeyFromRaw, verifyManifest } from './lib/package-v1/signing.mjs';
import { checkPackage } from './lib/package-v1/reference-check.mjs';
import { InputError, validateInput } from './lib/package-v1/input.mjs';
import { parseStrictJson } from './lib/package-v1/strict-json.mjs';
import { parseCommand, decodeSource, isBlankSource, readDisplayFile } from './lib/package-v1/argv.mjs';
import {
  DisplayRuleError, checkPackageLayout, hiddenEscapeTriples, irNameStrings, padStructuralSpans, reconstructFromDisplay, stripHiddenEscapes,
  structuralNameHits, toCanonical,
} from './lib/package-v1/display.mjs';
import { ruleContext } from './lib/package-v1/display-fixtures.mjs';
import { displayFixtures } from './lib/package-v1/display-fixtures.mjs';
import { displayVectors } from './lib/package-v1/display-vectors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'conformance', 'package-v1');
const SRC = join(PKG, 'src');
const GENERATED_DIRS = ['packages', 'tamper', 'inputs-invalid', 'vectors', 'anchors', 'compile', 'display'];
const GENERATED_KEY_FILES = ['keys/test-ed25519.priv.b64u', 'keys/test-ed25519.pub.b64u', 'keys/test-jwks.json'];

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
// 完整错误码表：codes ∪ codesSince 的各次版本（README「输出」）
const exitCodesDoc = JSON.parse(readFileSync(join(PKG, 'exit-codes.json'), 'utf8'));
const exitCodes = { ...exitCodesDoc.codes, ...Object.assign({}, ...Object.values(exitCodesDoc.codesSince ?? {})) };
const utf8 = (s) => Buffer.from(s, 'utf8');

// ---------------------------------------------------------------------------
// 生成：相对 PKG 的路径 → { bytes } | { link }
// ---------------------------------------------------------------------------
function generate() {
  const out = new Map();
  const put = (rel, bytes) => {
    if (out.has(rel)) throw new Error(`重复生成 ${rel}`);
    out.set(rel, { bytes });
  };
  const defs = loadSources(SRC);
  const pkgs = new Map([...defs.values()].map((d) => [d.name, buildPackage(d)]));

  for (const [rel, bytes] of keyFiles()) put(rel, bytes);

  for (const [rel, bytes] of anchorFiles()) put(rel, bytes);

  for (const pkg of pkgs.values()) {
    for (const [p, bytes] of pkg.files) put(`packages/${pkg.name}/${p}`, bytes);
    put(`packages/${pkg.name}.cases.json`, jsonFile(packageCases(pkg, defs, exitCodes)));
    if (pkg.def.zip) put(`packages/${pkg.name}.zip`, writeZipOf(pkg));
    // 路径形态：目录不论名字是否以 .zip 结尾都按目录读；普通文件不论扩展名都按 zip 读
    for (const [rel, bytes] of extraForms(pkg)) put(rel, bytes);
  }

  const tampers = JSON.parse(readFileSync(join(SRC, 'tamper.json'), 'utf8'));
  const tamperRows = [];
  for (const t of tampers.cases) {
    const built = buildTamper(t, pkgs);
    if (built.kind === 'zip') put(`tamper/${tamperTarget(t)}`, built.bytes);
    else if (built.kind === 'dir') {
      for (const [p, bytes] of built.files) put(`tamper/${t.name}/${p}`, bytes);
      for (const [p, target] of built.links ?? []) out.set(`tamper/${t.name}/${p}`, { link: target });
    }
    tamperRows.push(...tamperCases(t, pkgs, exitCodes, built));
  }
  put('tamper/cases.json', jsonFile({ description: tampers.description, cases: tamperRows }));
  put('tamper/test-time.json', jsonFile(testTimeCases(pkgs, exitCodes)));

  for (const [rel, bytes] of compileFixtures(SRC, pkgs, exitCodes)) put(rel, bytes);

  const invalid = JSON.parse(readFileSync(join(SRC, 'inputs-invalid.json'), 'utf8'));
  put('inputs-invalid/cases.json', jsonFile({ description: invalid.description, cases: invalid.cases.map((c) => inputInvalidCase(c, pkgs, exitCodes)) }));

  const tsCore = new Map([['b-alias', readFileSync(join(SRC, 'b-alias', 'ts-core.json'), 'utf8')]]);
  put('vectors/signing.json', jsonFile(signingVectors(pkgs)));
  put('vectors/position-free-hash.json', jsonFile(positionFreeVectors(pkgs, tsCore)));
  put('vectors/stdout-normalize.json', jsonFile(stdoutNormalizeVectors(pkgs, exitCodes)));
  const trees = JSON.parse(readFileSync(join(SRC, 'value-trees.json'), 'utf8'));
  put('vectors/value-json.json', jsonFile(valueJsonVectors(trees.trees)));
  // 包格式 1.1 显示排版（ADR 0059 修订 4）：四组共享向量与 display/ 下的夹具
  for (const [rel, doc] of Object.entries(displayVectors())) put(rel, jsonFile(doc));
  const display = displayFixtures(SRC, pkgs, exitCodes);
  for (const [rel, bytes] of display.out) put(rel, bytes);
  return { out, defs, pkgs, display };
}

// ---------------------------------------------------------------------------
// 写盘与 --check
// ---------------------------------------------------------------------------
function walk(dir, base = dir, acc = new Map()) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    const rel = relative(PKG, abs).split('\\').join('/');
    if (st.isSymbolicLink()) acc.set(rel, { link: readlinkSync(abs) });
    else if (st.isDirectory()) walk(abs, base, acc);
    else acc.set(rel, { bytes: readFileSync(abs) });
  }
  return acc;
}

function onDisk() {
  const acc = new Map();
  for (const d of GENERATED_DIRS) walk(join(PKG, d), PKG, acc);
  for (const f of GENERATED_KEY_FILES) if (existsSync(join(PKG, f))) acc.set(f, { bytes: readFileSync(join(PKG, f)) });
  return acc;
}

function check(out) {
  const disk = onDisk();
  const problems = [];
  for (const [rel, want] of out) {
    const got = disk.get(rel);
    if (!got) problems.push(`缺失：${rel}`);
    else if (want.link !== undefined || got.link !== undefined) {
      if (want.link !== got.link) problems.push(`符号链接不符：${rel}（期望 ${want.link ?? '普通文件'}，实际 ${got.link ?? '普通文件'}）`);
    } else if (!want.bytes.equals(got.bytes)) problems.push(`字节不符：${rel}`);
  }
  for (const rel of disk.keys()) if (!out.has(rel)) problems.push(`多余：${rel}`);
  return problems;
}

function write(out) {
  for (const d of GENERATED_DIRS) rmSync(join(PKG, d), { recursive: true, force: true });
  for (const [rel, v] of [...out].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const abs = join(PKG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (v.link !== undefined) symlinkSync(v.link, abs);
    else writeFileSync(abs, v.bytes);
  }
}

// ---------------------------------------------------------------------------
// --capture：采集平台 IR 与期望值（本地手动）
// ---------------------------------------------------------------------------
const isMultiFunc = (ir) => ir.decls.filter((d) => d.kind === 'Func').length > 1;

/** 给目标 Func 加 @entry（/evaluate-json 不接收函数名，多 Rule 模块须靠 @entry 选入口；P0 结果 §3）。 */
function withEntryAnnotation(coreJson, entry) {
  const tree = JSON.parse(coreJson);
  if (!isMultiFunc(tree)) return coreJson;
  const fn = tree.decls.find((d) => d.kind === 'Func' && d.name === entry);
  fn.annotations = [...fn.annotations, { name: 'entry', args: [] }];
  return JSON.stringify(tree);
}

/**
 * 包格式输入（Decimal 为字符串）→ 平台 /evaluate-json 的 context 原文：平台把 JSON 字符串当 Text、把带小数的 JSON 数字
 * 当 Double，只有整数 JSON 数字能被提升为 Decimal（2026-11-17 本地实测）。因此 Decimal 字段写成数字 token，且只允许整数值；
 * 非整数 Decimal 输入无法经该端点表达，这类用例在 fixture.json 中标注 expect:"ts"。
 */
function platformContext(input, func, ir) {
  const datas = new Map(ir.decls.filter((d) => d.kind === 'Data').map((d) => [d.name, d]));
  const enc = (v, type) => {
    switch (type.kind) {
      case 'List': return `[${v.map((x) => enc(x, type.type)).join(',')}]`;
      case 'Map': return `{${Object.keys(v).map((k) => `${JSON.stringify(k)}:${enc(v[k], type.val)}`).join(',')}}`;
      case 'Maybe':
      case 'Option': return v === null ? 'null' : enc(v, type.type);
      default: break;
    }
    if (type.name === 'Decimal') {
      if (!/^-?(0|[1-9][0-9]*)$/.test(v)) throw new Error(`平台无法表达非整数 Decimal 输入 ${v}`);
      return v;
    }
    // 平台把 JSON 字符串当 Text：十进制字符串形态的 Long 无法经该端点表达（这类用例标注 expect:"ts"）
    if (type.name === 'Long' && typeof v === 'string') throw new Error(`平台无法表达字符串形态的 Long 输入 ${v}`);
    const data = datas.get(type.name);
    if (data) return `{${data.fields.map((f) => `${JSON.stringify(f.name)}:${enc(v[f.name], f.type)}`).join(',')}}`;
    return valueJson(v);
  };
  return `{${func.params.map((p) => `${JSON.stringify(p.name)}:${enc(input[p.name], p.type)}`).join(',')}}`;
}

/** 响应原文中顶层 "result": 的值原文（保留 Jackson 的数字写法与键序）。 */
function rawResultOf(text) {
  const i = text.indexOf('"result":');
  if (i < 0) return null;
  let j = i + 9;
  let depth = 0;
  let inStr = false;
  const start = j;
  for (; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
  }
  return text.slice(start, j);
}

async function platformEval(api, coreJson, entry, contextJson) {
  const body = `{"policy":${JSON.stringify(withEntryAnnotation(coreJson, entry))},"context":${contextJson}}`;
  const res = await fetch(`${api}/api/v1/policies/evaluate-json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'package-v1-fixtures', 'X-User-Role': 'ADMIN', 'X-User-Id': 'package-v1-fixtures' },
    body,
  });
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (res.status === 200 && parsed.error == null) return { ok: true, raw: rawResultOf(text) };
  return { ok: false, status: res.status, error: `${parsed.code ?? ''} ${parsed.error ?? ''}`.trim() };
}

function javaCompile(cpFile, requests) {
  const cp = readFileSync(cpFile, 'utf8').trim();
  const r = spawnSync('java', ['-cp', cp, join(ROOT, 'scripts/package-v1/PlatformCompile.java')], {
    input: `${requests.map((q) => JSON.stringify(q)).join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`PlatformCompile 失败：${r.stderr.slice(-2000)}`);
  const byId = new Map(r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((o) => [o.id, o]));
  for (const q of requests) {
    const o = byId.get(q.id);
    if (!o?.ok) throw new Error(`${q.id}: 平台编译失败：${o?.error ?? '无输出'}`);
  }
  return byId;
}

async function loadTs(tsDir) {
  const at = (p) => import(pathToFileURL(join(tsDir, p)).href);
  if (!existsSync(join(tsDir, 'dist/src/browser.js'))) throw new Error(`${tsDir} 未构建（缺 dist/src/browser.js）：先 pnpm install && pnpm build`);
  const [browser, lexMod, interp, readIr, canon, tokenKind] = await Promise.all([
    at('dist/src/browser.js'), at('dist/src/config/lexicons/index.js'), at('dist/src/core/interpreter.js'),
    at('dist/src/core/read-core-ir.js'), at('dist/src/core/canonical-json.js'), at('dist/src/config/token-kind.js'),
  ]);
  lexMod.initializeAllBundledLexicons();
  const req = createRequire(join(tsDir, 'package.json'));
  // 必须与解释器 import 的是同一个 ESM 模块实例（解释器用 instanceof 判 Decimal），不能 require CJS 版本。
  const Decimal = await import(pathToFileURL(join(dirname(req.resolve('decimal.js/package.json')), 'decimal.mjs')).href);
  return {
    compile: browser.compile,
    lexicon: (locale) => lexMod.LexiconRegistry.get(locale),
    evaluate: interp.evaluate,
    serializeGuestValue: interp.serializeGuestValue,
    readCoreIr: readIr.readCoreIr,
    canonicalJson: canon.canonicalJson,
    isSemanticTokenKind: (k) => Object.hasOwn(tokenKind.SemanticTokenKind, k),
    Decimal: Decimal.default ?? Decimal,
    req,
    version: JSON.parse(readFileSync(join(tsDir, 'package.json'), 'utf8')).version,
  };
}

/** 与 aster-api AliasOverlayLexicon.wrap 同语义：base 别名在前，用户别名按 kind 追加去重（P0 结果 §4）。 */
function overlay(base, aliasSet) {
  if (!aliasSet || Object.keys(aliasSet).length === 0) return base;
  const merged = {};
  for (const [k, v] of Object.entries(base.aliases ?? {})) merged[k] = [...v];
  for (const [k, v] of Object.entries(aliasSet)) {
    merged[k] ??= [];
    for (const a of v) if (!merged[k].includes(a)) merged[k].push(a);
  }
  return { ...base, aliases: merged };
}

/** 按盘上包的 manifest 与 policy/ 文件本地编译（verify --recompile / --probes 的参照）；编译失败返回 null。 */
function tsCompileFiles(ts, manifest, files) {
  const source = decodeSource(files.get('policy/policy.aster'));
  // README「compile」：空白（只看 ASCII 空白）源码与形状不对的 aliasSet 失败即拒（COMPILE_ERROR / B 包为 PKG_IR_DRIFT）；不做类型检查
  if (isBlankSource(source)) return null;
  const aliasSet = JSON.parse(files.get('policy/compile/alias-set.json').toString('utf8'));
  if (aliasSet !== null) {
    if (typeof aliasSet !== 'object' || Array.isArray(aliasSet)) return null;
    for (const [k, v] of Object.entries(aliasSet)) {
      if (!ts.isSemanticTokenKind(k) || !Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
    }
  }
  const vocab = files.get('policy/compile/vocabulary.json');
  const lexicon = overlay(ts.lexicon(manifest.source.locale), aliasSet);
  // README「compile」：zh-CN 的 U+3000 由规范化转成半角空格，只含它（与 ASCII 空白）的源码同样是空白（core#288）。
  // 按规则直接判，不调用被测 ts 的规范化：固定的旧版 ts 规范化还会吞掉其他 Unicode 空白（aster-lang-ts#348 之前）
  if (/^zh(-|$)/i.test(manifest.source.locale) && isBlankSource(source.replaceAll('\u3000', ' '))) return null;
  const c = ts.compile(source, { lexicon, ...(vocab ? { vocabulary: JSON.parse(vocab.toString('utf8')) } : {}) });
  return c.success ? c.coreJson : null;
}

function tsCompile(ts, def) {
  const source = readFileSync(join(def.sourceDir, 'policy.aster'), 'utf8');
  const vocabulary = def.vocabulary ? JSON.parse(readFileSync(join(def.sourceDir, 'vocabulary.json'), 'utf8')) : undefined;
  const c = ts.compile(source, { lexicon: overlay(ts.lexicon(def.locale), def.aliasSet), ...(vocabulary ? { vocabulary } : {}) });
  if (!c.success) throw new Error(`${def.name}: ts 编译失败`);
  return c.coreJson;
}

/**
 * 包格式输入 → ts 解释器的上下文（T3 parseInput 的职责，这里只为复算期望值）：Decimal 字符串 → decimal.js 实例；
 * Long → BigInt；Int / Double → number；List / Map / Data 递归；Maybe：null → None，否则内层值（解释器接受这两种宿主形态）；
 * Enum：变体名字符串。输入可以来自 JSON.parse（number）或 parseValueTree（BigInt）。
 */
function tsContext(ts, input, func, ir) {
  const datas = new Map(ir.decls.filter((d) => d.kind === 'Data').map((d) => [d.name, d]));
  const conv = (v, type) => {
    switch (type.kind) {
      case 'List': return v.map((x) => conv(x, type.type));
      case 'Map': return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x, type.val)]));
      case 'Maybe':
      case 'Option': return v === null ? null : conv(v, type.type);
      default: break;
    }
    if (type.name === 'Decimal') return new ts.Decimal(String(v));
    if (type.name === 'Long') return BigInt(v);
    if (type.name === 'Int' || type.name === 'Double') return Number(v);
    const data = datas.get(type.name);
    if (data) return Object.fromEntries(data.fields.map((f) => [f.name, conv(v[f.name], f.type)]));
    return v;
  };
  return Object.fromEntries(func.params.map((p) => [p.name, conv(input[p.name], p.type)]));
}

/** ts 求值结果 → 值规范 JSON（Enum 删去 ts 多出的 "__type":"?"，VALUE-FORMS.md）。 */
function tsValueJson(ts, value) {
  const drop = (v) => {
    if (Array.isArray(v)) return v.map(drop);
    if (v !== null && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!(k === '__type' && x === '?')) o[k] = drop(x);
      return o;
    }
    return v;
  };
  return valueJson(drop(parseValueTree(ts.serializeGuestValue(value))));
}

/**
 * 一条探针是否与期望相符（README「tests/probes.json」）：entry 必须是 manifest 中的入口、input 必须通过「输入」规则、
 * expected 必须恰为 {"ok":true,"value":V} 或 {"code":"EVAL_ERROR","ok":false}；求值以步数上限代替超时（参照实现不跑 Worker），
 * 超出即视为超时 → 不符。任何一项不满足都是 PROBE_MISMATCH。p 来自 parseValueTree（整数为 BigInt）。
 */
const PROBE_STEP_LIMIT = 20_000_000;
function probeMatches(ts, coreJson, manifest, p) {
  const ir = JSON.parse(coreJson);
  if (typeof p.entry !== 'string' || !manifest.policy.entries.some((e) => e.function === p.entry)) return false;
  const e = p.expected;
  const keys = e !== null && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e).sort().join(',') : '';
  const okShape = keys === 'ok,value' && e.ok === true;
  const errShape = keys === 'code,ok' && e.ok === false && e.code === 'EVAL_ERROR';
  if (!okShape && !errShape) return false;
  let input;
  try {
    input = validateInput(utf8(valueJson(p.input)), ir, p.entry);
  } catch (err) {
    if (err instanceof InputError) return false;
    throw err;
  }
  const r = tsEval(ts, coreJson, p.entry, input, PROBE_STEP_LIMIT);
  if (r.error && /step/i.test(r.error)) return false;
  return okShape ? r.ok && r.value === valueJson(e.value) : !r.ok;
}

function tsEval(ts, coreJson, entry, input, maxSteps = Number.MAX_SAFE_INTEGER) {
  const ir = JSON.parse(coreJson);
  const func = ir.decls.find((d) => d.kind === 'Func' && d.name === entry);
  const r = ts.evaluate(ts.readCoreIr(coreJson), entry, tsContext(ts, input, func, ir), { maxSteps });
  return r.success ? { ok: true, value: tsValueJson(ts, r.value) } : { ok: false, error: r.error };
}

async function capture() {
  const cpFile = opt('--cp-file');
  const api = opt('--api');
  if (!cpFile || !api) usage('--capture 需要 --cp-file 与 --api');
  const ts = await loadTs(resolve(opt('--ts', join(ROOT, '..', 'aster-lang-ts'))));
  const baseNames = readdirSync(SRC).filter((n) => {
    const f = join(SRC, n, 'fixture.json');
    return existsSync(f) && !JSON.parse(readFileSync(f, 'utf8')).base;
  }).sort();
  const requests = baseNames.map((name) => {
    const def = JSON.parse(readFileSync(join(SRC, name, 'fixture.json'), 'utf8'));
    return {
      id: name,
      source: readFileSync(join(SRC, name, 'policy.aster'), 'utf8'),
      locale: def.locale,
      aliasSet: def.aliasSet,
      vocabulary: def.vocabulary ? JSON.parse(readFileSync(join(SRC, name, 'vocabulary.json'), 'utf8')) : null,
      allowStructural: def.allowStructural,
    };
  });
  requests.push({ id: '$values', source: readFileSync(join(SRC, 'value-probes.aster'), 'utf8'), locale: 'en-US' });
  const compiled = javaCompile(cpFile, requests);
  for (const name of baseNames) writeFileSync(join(SRC, name, 'platform-core.json'), compiled.get(name).coreJson);

  const defs = loadSources(SRC);
  writeFileSync(join(SRC, 'b-alias', 'ts-core.json'), tsCompile(ts, defs.get('b-alias')));

  for (const name of baseNames) {
    const def = defs.get(name);
    const ir = JSON.parse(def.platformCore);
    const funcOf = (entry) => ir.decls.find((d) => d.kind === 'Func' && d.name === entry);
    const expected = { cases: {}, probes: [] };
    const one = async (entry, input, source) => {
      if (source === 'ts') {
        const r = tsEval(ts, def.platformCore, entry, input);
        if (!r.ok) throw new Error(`${name}: ts 求值失败 ${r.error}`);
        return { source: 'ts', value: r.value };
      }
      const r = await platformEval(api, def.platformCore, entry, platformContext(input, funcOf(entry), ir));
      return r.ok ? { source: 'platform', value: valueJson(parseValueTree(r.raw)) } : { source: 'platform', error: r.error };
    };
    for (const c of def.cases) {
      if (c.command !== 'run' || c.sameAs || c.rawArgs) continue;
      const entryIdx = (c.args ?? []).indexOf('--entry');
      const entry = entryIdx >= 0 ? c.args[entryIdx + 1] : def.entries.find((e) => e.default).function;
      if (c.expect === 'platform' || c.expect === 'ts') {
        const r = await one(entry, c.input, c.expect);
        if (r.value === undefined) throw new Error(`${name}/${c.name}: 平台求值失败 ${r.error}`);
        expected.cases[c.name] = r;
      } else if (c.expect.platform === 'error') {
        const r = await one(entry, c.input, 'platform');
        if (r.value !== undefined) throw new Error(`${name}/${c.name}: 期望平台失败，实际成功 ${r.value}`);
        expected.cases[c.name] = r;
      }
    }
    for (const p of def.probes) {
      const r = await one(p.entry, p.input, p.source ?? 'platform');
      if (p.expect === 'EVAL_ERROR') {
        if (r.value !== undefined) throw new Error(`${name}: probe 期望平台求值失败，实际成功 ${r.value}`);
      } else if (r.value === undefined) throw new Error(`${name}: probe 平台求值失败 ${r.error}`);
      expected.probes.push(r);
    }
    writeFileSync(join(SRC, name, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  }

  const probes = JSON.parse(readFileSync(join(SRC, 'value-probes.json'), 'utf8'));
  const valuesCore = compiled.get('$values').coreJson;
  const trees = [];
  for (const p of probes.platform) {
    const r = await platformEval(api, valuesCore, p.entry, p.contextJson);
    if (!r.ok) throw new Error(`值树 ${p.name}: 平台求值失败 ${r.error}`);
    trees.push({ name: p.name, category: p.category, source: 'platform', treeJson: r.raw });
  }
  for (const s of probes.synthetic) trees.push({ name: s.name, category: s.category, source: 'synthetic', treeJson: s.treeJson, ...(s.error ? { error: true } : {}) });
  writeFileSync(join(SRC, 'value-trees.json'), `${JSON.stringify({ description: '由 --capture 生成：value-probes.json 的平台采集结果（result 原文）与 synthetic 边界值。', trees }, null, 2)}\n`);
  console.log(`captured ${baseNames.length} packages, ${trees.length} value trees`);
}

// ---------------------------------------------------------------------------
// --verify-engines：用兄弟仓交叉验证
// ---------------------------------------------------------------------------
async function verifyEngines() {
  const { out, defs, pkgs, display } = generate();
  // 参照检查读的是盘上的夹具：先确认盘上与生成结果一致
  const drift = check(out);
  if (drift.length) {
    for (const p of drift.slice(0, 20)) console.error(`✗ ${p}`);
    console.error('verify-engines: 仓内夹具与生成器输出不一致，先运行生成器');
    process.exitCode = 1;
    return;
  }
  const ts = await loadTs(resolve(opt('--ts', join(ROOT, '..', 'aster-lang-ts'))));
  const guardDir = resolve(opt('--guard', join(ROOT, '..', 'aster-guard')));
  // jcs.ts 用了 parameter property，Node 的「只剥类型」模式加载不了；用 ts 仓的 typescript 转译后以 data: URL 加载，
  // 免去构建 aster-guard。
  const tsc = ts.req('typescript');
  const jcsJs = tsc.transpileModule(readFileSync(join(guardDir, 'src/hash/jcs.ts'), 'utf8'), {
    compilerOptions: { module: tsc.ModuleKind.ESNext, target: tsc.ScriptTarget.ES2022 },
  }).outputText;
  const { canonicalize } = await import(`data:text/javascript;base64,${Buffer.from(jcsJs).toString('base64')}`);
  const Ajv2020 = ts.req('ajv/dist/2020.js');
  const ajv = new (Ajv2020.default ?? Ajv2020)({ strict: true, allErrors: true });
  const readJson = (p) => JSON.parse(readFileSync(join(PKG, p), 'utf8'));
  const manifestSchema10 = ajv.compile(readJson('schema/manifest-1.0.schema.json'));
  const manifestSchema11 = ajv.compile(readJson('schema/manifest-1.1.schema.json'));
  // 按 formatVersion 的次版本选 schema（ADR 0059 修订 4 D2）；1.0 包与修订前一样只用 1.0 schema
  const manifestSchemaOf = (minor) => (minor === 1 ? manifestSchema11 : manifestSchema10);
  const manifestSchema = (t) => {
    const ok = manifestSchemaOf(t?.formatVersion === '1.1' ? 1 : 0)(t);
    manifestSchema.errors = manifestSchemaOf(t?.formatVersion === '1.1' ? 1 : 0).errors;
    return ok;
  };
  const sigSchema = ajv.compile(readJson('schema/sig-1.0.schema.json'));
  const envelopeSchema = ajv.compile(readJson('envelope.schema.json'));
  const problems = [];
  const expect = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  let checks = 0;
  const count = () => checks++;
  const anchor = publicKeyFromRaw(TEST_KEY.publicRaw);

  // 1. 全部黄金包：schema（含包内 input schema 在 ajv strict 下可编译）、规范字节（jcs / ts / 本仓）、签名、
  //    ts 重编译的投影哈希、probes 无损复算
  for (const pkg of pkgs.values()) {
    const text = pkg.manifestBytes.toString('utf8');
    const tree = JSON.parse(text);
    expect(manifestSchema(tree), `${pkg.name}: manifest 不符合 schema ${JSON.stringify(manifestSchema.errors)}`);
    expect(canonicalize(tree) === text, `${pkg.name}: manifest 字节与 aster-guard jcs 不同`);
    expect(ts.canonicalJson(tree) === text, `${pkg.name}: manifest 字节与 ts canonicalJson 不同`);
    if (pkg.sig) {
      expect(sigSchema(pkg.sig), `${pkg.name}: 签名文件不符合 schema`);
      expect(verifyManifest(pkg.manifestBytes, pkg.sig.sig, anchor), `${pkg.name}: 签名不成立`);
    }
    for (const f of ['schema/input.json', 'schema/output.json']) {
      try {
        new (Ajv2020.default ?? Ajv2020)({ strict: true }).compile(JSON.parse(pkg.files.get(f).toString('utf8')));
      } catch (e) {
        problems.push(`${pkg.name}: ${f} 在 ajv strict 下无法编译：${e.message}`);
      }
    }
    ts.readCoreIr(pkg.def.platformCore);
    const local = tsCompile(ts, pkg.def);
    const pf = sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(local)))));
    expect(pf === pkg.manifest.coreIr.positionFreeSha256, `${pkg.name}: ts 重编译的投影哈希 ${pf} ≠ manifest`);
    // 无损读取：整数 token 解析为 BigInt，期望值按值规范 JSON 重新写出后逐字节比较（README「tests/probes.json」）
    const probes = parseValueTree(pkg.files.get('tests/probes.json').toString('utf8')).probes;
    probes.forEach((p, i) => {
      const same = probeMatches(ts, pkg.def.platformCore, pkg.manifest, p);
      const broken = pkg.def.corruptProbe?.index === i || (pkg.def.probeEdits ?? []).some((e) => e.index === i);
      expect(broken ? !same : same, `${pkg.name}: probes[${i}] 的复算结果与期望不符`);
    });
    count();
  }

  // 2. 所有 cases：expectedStdout 符合 envelope schema、message / 退出码与 exit-codes.json 一致
  const rows = [];
  for (const [rel, v] of out) {
    if (!rel.endsWith('cases.json') && rel !== 'tamper/test-time.json') continue;
    for (const c of JSON.parse(v.bytes.toString('utf8')).cases) rows.push({ rel, c });
  }
  for (const { rel, c } of rows) {
    if (c.expectedStdout === null || c.expectedStdout === '') continue; // compile 成功：只比较投影哈希（见 compile 一节）
    // show 成功时 stdout 不是 JSON（显示文本或规范源码 + \n，README「show」）
    if (c.args[0] === 'show' && c.expectedExit === 0) {
      expect(c.code === null && c.expectedStdout.endsWith('\n'), `${rel}/${c.name}: show 成功的 stdout 必须以 \n 结尾、code 为 null`);
      count();
      continue;
    }
    const env = JSON.parse(c.expectedStdout);
    expect(envelopeSchema(env), `${rel}/${c.name}: expectedStdout 不符合 envelope schema ${JSON.stringify(envelopeSchema.errors).slice(0, 300)}`);
    expect(c.expectedStdout.endsWith('\n') && !c.expectedStdout.slice(0, -1).includes('\n'), `${rel}/${c.name}: stdout 必须是一行 + \\n`);
    expect(env.checks || env.ok === (c.expectedExit === 0), `${rel}/${c.name}: ok 与退出码不一致`);
    if (env.error) expect(env.error.message === exitCodes[env.error.code].message && c.expectedExit === exitCodes[env.error.code].exit, `${rel}/${c.name}: message / 退出码与 exit-codes.json 不符`);
    expect(c.code === (env.error?.code ?? env.checks?.find((k) => !k.ok)?.code ?? null), `${rel}/${c.name}: code 字段与 stdout 不符`);
    count();
  }

  // 3. 参照流水线（reference-check.mjs + input.mjs）独立判定每条 run 用例：包级错误码与 meta.signed 必须吻合；
  //    其余用例包检查必须通过，且输入判定（INPUT_INVALID 与否）必须吻合；成功与 EVAL_ERROR 用例再由 ts 解释器复算
  const PACKAGE_CODES = new Set(['PKG_INTEGRITY', 'PKG_SIGNATURE', 'PKG_UNSIGNED', 'PKG_UNTRUSTED_KID', 'PKG_INVALID_MANIFEST', 'PKG_UNSUPPORTED_FORMAT', 'PKG_UNSUPPORTED_IR']);
  const refOpts = { validateManifest: (t, minor) => manifestSchemaOf(minor)(t), validateSig: (t) => sigSchema(t), readCoreIr: (x) => ts.readCoreIr(x) };
  const loadAnchor = (cwd, flags) => {
    const at = (f) => flags.indexOf(f);
    if (at('--pubkey') >= 0) {
      const text = readFileSync(join(cwd, flags[at('--pubkey') + 1]), 'utf8');
      if (text.trimStart().startsWith('{')) {
        const jwk = JSON.parse(text);
        return { kind: 'jwk', kid: jwk.kid, key: Buffer.from(jwk.x, 'base64url') };
      }
      return { kind: 'raw', key: Buffer.from(text.replace(/\n$/, ''), 'base64url') };
    }
    const keys = new Map();
    if (at('--jwks') >= 0) for (const k of JSON.parse(readFileSync(join(cwd, flags[at('--jwks') + 1]), 'utf8')).keys) keys.set(k.kid, Buffer.from(k.x, 'base64url'));
    return { kind: 'jwks', keys };
  };
  const LATER = new Set([null, 'INPUT_INVALID', 'ENTRY_NOT_FOUND', 'EVAL_ERROR', 'TIMEOUT', 'RESOURCE_EXHAUSTED', 'PKG_IR_DRIFT']);
  for (const { rel, c } of rows) {
    // display/ 的用例由下文 3f 按显示排版的阶段独立判定
    if (rel.startsWith('display/')) continue;
    if (rel === 'tamper/test-time.json' || c.code === 'USAGE' || c.args[0] !== 'run') continue;
    const cwd = join(PKG, dirname(rel));
    const { positional, flags } = splitArgs(c.args.slice(1));
    const target = join(cwd, positional[0]);
    const r = checkPackage(target, { ...refOpts, anchor: loadAnchor(cwd, flags), allowUnsigned: flags.includes('--allow-unsigned') });
    const env = JSON.parse(c.expectedStdout);
    const name = `${rel}/${c.name}`;
    if (PACKAGE_CODES.has(c.code)) {
      expect(!r.ok && r.code === c.code, `${name}: 参照流水线得 ${r.ok ? '通过' : `${r.code}@${r.stage}（${r.why}）`}，夹具期望 ${c.code}`);
      if (!r.ok) expect(env.meta.signed === ['integrity', 'ir'].includes(r.stage), `${name}: meta.signed 与参照阶段 ${r.stage} 不符`);
      count();
      continue;
    }
    expect(LATER.has(c.code), `${name}: 未分类的错误码 ${c.code}`);
    expect(r.ok, `${name}: 参照流水线应通过，得 ${r.code}@${r.stage}（${r.why}）`);
    if (!r.ok) continue;
    const ir = JSON.parse(r.manifest.mode === 'a' ? r.files.get('compiled/core.json').toString('utf8') : defsByModule(pkgs, r.manifest).def.platformCore);
    if (c.code === 'PKG_IR_DRIFT') {
      // 从盘上的 policy/ 本地编译：编译失败或投影哈希与 manifest 不同都是漂移
      const core = tsCompileFiles(ts, r.manifest, r.files);
      const pf = core === null ? null : sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(core)))));
      expect(pf !== r.manifest.coreIr.positionFreeSha256, `${name}: ts 重编译的投影哈希与 manifest 相等，不是漂移`);
      count();
      continue;
    }
    const entry = entryOfArgs(flags, r.manifest);
    // 取得 IR 之后的 meta 一律由盘上 manifest 推导
    expect(env.meta.coreIrSha256 === r.manifest.coreIr.sha256 && env.meta.irRecompiled === (r.manifest.mode === 'b') && env.meta.signed === r.signed && env.meta.entry === entry, `${name}: run meta 与盘上 manifest 不符`);
    if (!ir.decls.some((d) => d.kind === 'Func' && d.name === entry) || !r.manifest.policy.entries.some((e) => e.function === entry)) {
      expect(c.code === 'ENTRY_NOT_FOUND', `${name}: 入口 ${entry} 不存在，应为 ENTRY_NOT_FOUND`);
      count();
      continue;
    }
    const inputFlag = flags.indexOf('--input');
    const raw = flags[inputFlag + 1] === '-' ? (c.stdinB64 !== undefined ? Buffer.from(c.stdinB64, 'base64') : utf8(c.stdin ?? '')) : (existsSync(join(cwd, flags[inputFlag + 1])) ? readFileSync(join(cwd, flags[inputFlag + 1])) : null);
    let input = null;
    let inputError = null;
    if (raw === null) inputError = '输入文件不存在';
    else {
      try {
        input = validateInput(raw, ir, entry);
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        inputError = e.message;
      }
    }
    if (c.code === 'INPUT_INVALID') expect(inputError !== null, `${name}: 参照输入校验通过了，夹具期望 INPUT_INVALID`);
    else expect(inputError === null, `${name}: 参照输入校验拒绝（${inputError}）`);
    if (inputError === null && (c.code === null || c.code === 'EVAL_ERROR')) {
      const t = tsEval(ts, JSON.stringify(ir), entry, input);
      if (c.code === null) expect(t.ok && c.expectedStdout.endsWith(`,"ok":true,"value":${t.value}}\n`), `${name}: ts 结果 ${t.value ?? t.error} ≠ 期望`);
      else expect(!t.ok, `${name}: ts 应求值失败`);
    }
    count();
  }
  // 3b. verify / inspect 的期望一律由**目标包在盘上的字节**独立推导（不用生成器的 base 包对象）：
  //     参照流水线给出失败阶段与已通过校验的 manifest / 文件；之后按 README 的 verify 规则逐项复算
  //     （A 包 ir、--recompile 的投影哈希、--probes 的求值），并比对 meta 与 inspect 内容。
  const CHECK_OF_STAGE = { manifest: 'schema', signature: 'signature', integrity: 'integrity' };
  for (const { rel, c } of rows) {
    const cmd = c.args[0];
    if (!['verify', 'inspect'].includes(cmd) || rel === 'tamper/test-time.json' || c.code === 'USAGE' || rel.startsWith('display/')) continue;
    const cwd = join(PKG, dirname(rel));
    const { positional, flags } = splitArgs(c.args.slice(1));
    const r = checkPackage(join(cwd, positional[0]), { ...refOpts, anchor: loadAnchor(cwd, flags), allowUnsigned: flags.includes('--allow-unsigned') });
    const env = JSON.parse(c.expectedStdout);
    const name = `${rel}/${c.name}`;
    const early = !r.ok && r.stage !== 'ir';
    if (cmd === 'inspect') {
      if (early) {
        expect(env.ok === false && env.error?.code === r.code, `${name}: 参照流水线得 ${r.code}@${r.stage}，inspect 期望 ${env.error?.code ?? '成功'}`);
      } else {
        const m = r.manifest;
        const want = {
          effects: m.effects, governance: m.governance, policy: m.policy, runtime: m.runtime,
          schemas: { input: JSON.parse(r.files.get('schema/input.json').toString('utf8')), output: JSON.parse(r.files.get('schema/output.json').toString('utf8')) },
          tests: m.tests,
        };
        expect(env.ok === true && canonicalJson(env.inspect) === canonicalJson(want), `${name}: inspect 内容与盘上 manifest / schema 不符`);
        expect(env.meta?.coreIrSha256 === m.coreIr.sha256 && env.meta.entry === m.policy.entries.find((e) => e.default).function && env.meta.signed === r.signed && env.meta.irRecompiled === false, `${name}: inspect meta 与盘上 manifest 不符`);
      }
      count();
      continue;
    }
    // verify：独立复算检查项序列
    const checks = [];
    let meta = { coreIrSha256: null, entry: null, irRecompiled: false, signed: false };
    let failed = null;
    if (early) {
      const nm = r.stage === 'read' ? (r.code === 'PKG_INVALID_MANIFEST' ? 'schema' : 'integrity') : CHECK_OF_STAGE[r.stage];
      for (const k of ['schema', 'signature', 'integrity']) {
        if (k === nm) break;
        if (r.stage !== 'read') checks.push({ name: k, ok: true });
      }
      checks.push({ code: r.code, name: nm, ok: false });
      failed = r.code;
      meta.signed = r.stage === 'integrity';
    } else {
      const m = r.manifest;
      checks.push({ name: 'schema', ok: true }, { name: 'signature', ok: true }, { name: 'integrity', ok: true });
      meta = { coreIrSha256: m.coreIr.sha256, entry: m.policy.entries.find((e) => e.default).function, irRecompiled: false, signed: r.signed };
      const stop = (nameK, code) => {
        checks.push({ code, name: nameK, ok: false });
        failed = code;
      };
      if (m.mode === 'a') {
        if (!r.ok) stop('ir', 'PKG_UNSUPPORTED_IR');
        else checks.push({ name: 'ir', ok: true });
      }
      const localIr = () => tsCompileFiles(ts, m, r.files);
      const pfOf = (core) => sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(core)))));
      if (!failed && flags.includes('--recompile')) {
        const core = localIr();
        if (core === null || pfOf(core) !== m.coreIr.positionFreeSha256) stop('recompile', 'PKG_IR_DRIFT');
        else {
          checks.push({ name: 'recompile', ok: true });
          meta.irRecompiled = true;
        }
      }
      if (!failed && flags.includes('--probes')) {
        let core = null;
        if (m.mode === 'a') core = r.files.get('compiled/core.json').toString('utf8');
        else {
          core = localIr();
          if (core === null || pfOf(core) !== m.coreIr.positionFreeSha256) {
            stop('probes', 'PKG_IR_DRIFT');
            core = null;
          }
        }
        if (core !== null) {
          const probes = parseValueTree(r.files.get('tests/probes.json').toString('utf8')).probes;
          const allOk = probes.every((p) => probeMatches(ts, core, m, p));
          if (allOk) checks.push({ name: 'probes', ok: true });
          else stop('probes', 'PROBE_MISMATCH');
        }
      }
    }
    const wantStdout = `${canonicalJson({ checks, meta: { cliVersion: '<CLI_VERSION>', engine: '<ENGINE>', ...meta }, ok: failed === null })}\n`;
    expect(c.expectedStdout === wantStdout, `${name}: verify 期望与盘上包的独立复算不符\n      期望 ${c.expectedStdout.trim()}\n      复算 ${wantStdout.trim()}`);
    expect(c.expectedExit === (failed === null ? 0 : exitCodes[failed].exit), `${name}: verify 退出码`);
    count();
  }

  const compileCaptured = JSON.parse(readFileSync(join(SRC, 'compile', 'expected.json'), 'utf8'));
  const cpFile = opt('--cp-file');
  const liveCompile = cpFile ? (() => {
    const dir = join(SRC, 'compile');
    const doc = JSON.parse(readFileSync(join(dir, 'compile.json'), 'utf8'));
    const reqs = doc.cases.filter((c) => c.platform).map((c) => ({
      id: c.name, source: decodeSource(readFileSync(join(dir, c.platform.source))), locale: c.platform.locale,
      aliasSet: c.platform.aliasSet ? JSON.parse(readFileSync(join(dir, c.platform.aliasSet), 'utf8')) : null,
      vocabulary: c.platform.vocabulary ? JSON.parse(readFileSync(join(dir, c.platform.vocabulary), 'utf8')) : null,
      allowStructural: c.platform.allowStructural === true,
    }));
    const res = spawnSync('java', ['-cp', readFileSync(cpFile, 'utf8').trim(), join(ROOT, 'scripts/package-v1/PlatformCompile.java')], { input: `${reqs.map((q) => JSON.stringify(q)).join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 28 });
    return new Map(res.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((o) => [o.id, o.ok]));
  })() : null;
  /** 平台编译序列对某个 compile 用例的结论：有 --cp-file 时现场重算，否则读采集结果。 */
  const platformCompile = (id) => (liveCompile ? liveCompile.get(id) : compileCaptured[id]?.ok);

  // 3c. compile：源码类成功用例由 ts 本地编译复算投影哈希（ts 尚无 aliasSet 校验，校验失败类用例的期望来自平台采集）；
  //     包类用例先过参照流水线，再从盘上 policy/ 编译复算；包类失败用例的错误码由参照流水线判定
  const compileRows = JSON.parse(out.get('compile/cases.json').bytes.toString('utf8')).cases;
  // 源夹具的 pinnedTsDivergence（只在 src，不进 cases.json）：两个 CLI 期望已一致，但本 job 固定的 ts 版本早于修复、仍给出不同结论
  const pinnedTsDivergence = new Map(JSON.parse(readFileSync(join(SRC, 'compile', 'compile.json'), 'utf8')).cases
    .filter((c) => c.pinnedTsDivergence).map((c) => [c.name, c.pinnedTsDivergence]));
  const VALUED_COMPILE = new Set(['--locale', '--alias-set', '--vocabulary', '--out', '--jwks', '--pubkey']);
  for (const c of compileRows) {
    const cwd = join(PKG, 'compile');
    const positional = [];
    const opts = {};
    for (let i = 1; i < c.args.length; i++) {
      if (c.args[i] === '--') {
        positional.push(...c.args.slice(i + 1));
        break;
      }
      if (VALUED_COMPILE.has(c.args[i])) opts[c.args[i]] = c.args[++i];
      else if (c.args[i].startsWith('--')) opts[c.args[i]] = true;
      else positional.push(c.args[i]);
    }
    const target = join(cwd, positional[0]);
    const isSource = positional[0].endsWith('.aster');
    const name = `compile/${c.name}`;
    if (c.code === 'USAGE') {
      count();
      continue; // 由 3d 的命令行参照实现判定
    }
    if (isSource) {
      if (c.code === 'COMPILE_ERROR') {
        const tsCore = opts['--alias-set'] ? undefined : tsCompileFiles(ts, { source: { locale: opts['--locale'] ?? 'en-US' } }, new Map([['policy/policy.aster', readFileSync(target)], ['policy/compile/alias-set.json', utf8('null')]]));
        // 已知的 ts / Java 解析分歧（knownEngineDivergence 指向跟踪 issue）：断言分歧仍在，修复后此处会提醒去掉标记
        if (c.knownEngineDivergence) expect(tsCore !== null && tsCore !== undefined, `${name}: ts 已与平台一致（${c.knownEngineDivergence} 已修？），去掉 knownEngineDivergence`);
        // 固定版本的 ts 尚未含修复：断言分歧仍在，升级固定版本后此处会提醒去掉 pinnedTsDivergence
        else if (pinnedTsDivergence.has(c.name)) expect(tsCore !== null && tsCore !== undefined, `${name}: 所用 ts 已与平台一致（${pinnedTsDivergence.get(c.name)} 已随升级生效？），去掉 pinnedTsDivergence`);
        else if (!opts['--alias-set']) expect(tsCore === null, `${name}: ts 应编译失败`);
        // aliasSet 校验失败类：ts 尚无 UserAliasValidator，期望来自平台编译序列——这里确认生成的行与采集结果一致；
        // 给出 --cp-file 时再以平台编译序列现场重算（本地；CI 无 aster-api）
        else expect(platformCompile(c.name) === false, `${name}: 平台编译序列应拒绝该 aliasSet`);
      } else {
        const files = new Map([['policy/policy.aster', readFileSync(target)], ['policy/compile/alias-set.json', opts['--alias-set'] ? readFileSync(join(cwd, opts['--alias-set'])) : utf8('null')]]);
        if (opts['--vocabulary']) files.set('policy/compile/vocabulary.json', readFileSync(join(cwd, opts['--vocabulary'])));
        const core = tsCompileFiles(ts, { source: { locale: opts['--locale'] ?? 'en-US' } }, files);
        expect(core !== null && sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(core))))) === c.expectedPositionFreeSha256, `${name}: ts 编译的投影哈希与期望不符`);
        if (opts['--alias-set']) expect(platformCompile(c.name) === true, `${name}: 平台编译序列应接受该 aliasSet`);
      }
      count();
      continue;
    }
    const anchor = opts['--jwks'] ? loadAnchor(cwd, ['--jwks', opts['--jwks']]) : opts['--pubkey'] ? loadAnchor(cwd, ['--pubkey', opts['--pubkey']]) : { kind: 'jwks', keys: new Map() };
    const r = checkPackage(target, { ...refOpts, anchor, allowUnsigned: opts['--allow-unsigned'] === true });
    if (c.code === 'COMPILE_ERROR') {
      // 包检查通过、盘上 policy/ 本地编译失败
      expect((r.ok || r.stage === 'ir') && r.manifest && tsCompileFiles(ts, r.manifest, r.files) === null, `${name}: 应包检查通过而本地编译失败`);
    } else if (c.code) {
      expect(!r.ok && r.code === c.code, `${name}: 参照流水线得 ${r.ok ? '通过' : r.code}，期望 ${c.code}`);
    } else {
      expect(r.ok || r.stage === 'ir', `${name}: 参照流水线应通过包检查，得 ${r.code}@${r.stage}`);
      if (r.manifest) {
        const core = tsCompileFiles(ts, r.manifest, r.files);
        expect(core !== null && sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(core))))) === c.expectedPositionFreeSha256, `${name}: 盘上 policy/ 编译的投影哈希与期望不符`);
      }
    }
    count();
  }

  // 3d. 命令行与信任锚（usage 阶段）：参照实现 argv.mjs 独立判定每条用例是否 USAGE
  for (const [rel, v] of out) {
    if (!rel.endsWith('cases.json')) continue;
    const cwd = join(PKG, dirname(rel));
    for (const c of JSON.parse(v.bytes.toString('utf8')).cases) {
      const r = parseCommand(c.args, cwd);
      expect(r.usage === (c.code === 'USAGE'), `${rel}/${c.name}: 命令行参照实现判定 ${r.usage ? `USAGE（${r.why}）` : '通过'}，期望 ${c.code ?? '成功'}`);
      count();
    }
  }

  // 3e. test-time 配方中体量小的（目录深度、目录数、文件数）在临时目录里实际生成，再由参照流水线判定
  {
    const { mkdtempSync, cpSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tt = JSON.parse(out.get('tamper/test-time.json').bytes.toString('utf8')).cases;
    for (const c of tt) {
      const r0 = c.recipe ?? {};
      if (!r0.copyPackage) continue;
      const bytes = (r0.add ?? []).reduce((n, a) => n + a.size, 0);
      if (bytes > 1024 * 1024) continue; // 几十 MiB 的配方留给 CLI 测试
      const tmp = mkdtempSync(join(tmpdir(), 'pkgv1-tt-'));
      try {
        const dst = join(tmp, 'pkg');
        cpSync(join(PKG, r0.copyPackage), dst, { recursive: true });
        for (const a of r0.add ?? []) {
          mkdirSync(dirname(join(dst, a.path)), { recursive: true });
          writeFileSync(join(dst, a.path), Buffer.alloc(a.size));
        }
        for (const d of r0.addDirs ?? []) mkdirSync(join(dst, d), { recursive: true });
        const r = checkPackage(dst, { ...refOpts, anchor: loadAnchor(PKG, ['--jwks', 'keys/test-jwks.json']), allowUnsigned: false });
        const env = JSON.parse(c.expectedStdout);
        expect(!r.ok && r.code === c.code && env.meta.signed === ['integrity', 'ir'].includes(r.stage), `tamper/test-time.json/${c.name}: 参照流水线得 ${r.ok ? '通过' : `${r.code}@${r.stage}（${r.why}）`}`);
        count();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // 黄金包本身（目录与 zip 形态）参照流水线必须通过
  for (const [rel] of out) {
    const m = /^packages\/([^/]+)\/manifest\.json$/.exec(rel);
    if (!m) continue;
    const r = checkPackage(join(PKG, 'packages', m[1]), { ...refOpts, anchor: { kind: 'raw', key: TEST_KEY.publicRaw }, allowUnsigned: true });
    expect(r.ok, `packages/${m[1]}: 参照流水线应通过，得 ${r.code}@${r.stage}（${r.why}）`);
  }

  // 3f. 包格式 1.1 显示排版（ADR 0059 修订 4）：见 verifyDisplay
  verifyDisplay({ ts, display, out, refOpts, loadAnchor, expect, count, envelopeSchema, manifestSchema11, canonicalize });

  // 4. 篡改 manifest 的层次：schema 层必须被 schema 拒绝；format 层与 semantic 层不得被 schema 拒绝之外的原因误判
  const tamper = JSON.parse(readFileSync(join(SRC, 'tamper.json'), 'utf8')).cases;
  for (const t of tamper) {
    const m = out.get(`tamper/${t.name}/manifest.json`);
    if (!m || !t.layer) continue;
    const tree = JSON.parse(m.bytes.toString('utf8'));
    if (t.layer === 'schema') expect(!manifestSchema(tree), `tamper/${t.name}: schema 应拒绝`);
    if (t.layer === 'semantic') expect(manifestSchema(tree), `tamper/${t.name}: schema 应通过（由语义规则拒绝）`);
    count();
  }

  // 5. 签名向量：规范字节三方一致；valid 与参照判定一致
  const sv = JSON.parse(out.get('vectors/signing.json').bytes.toString('utf8'));
  for (const v of sv.vectors) {
    const bytes = Buffer.from(v.manifestFileB64u, 'base64url');
    let canonicalOk = false;
    try {
      const tree = parseStrictJson(bytes, { maxDepth: 64 });
      const canon = ts.canonicalJson(tree);
      expect(canonicalize(tree) === canon, `signing/${v.name}: jcs 与 ts 不一致`);
      expect(v.canonicalUtf8B64u === null || Buffer.from(v.canonicalUtf8B64u, 'base64url').toString('utf8') === canon, `signing/${v.name}: canonicalUtf8 字段`);
      canonicalOk = utf8(canon).equals(bytes);
    } catch {
      canonicalOk = false;
    }
    let sig = null;
    try {
      sig = parseStrictJson(Buffer.from(v.sigFileB64u, 'base64url'), { maxDepth: 4 });
    } catch {
      sig = null;
    }
    const sigOk = sig !== null && sigSchema(sig) && Buffer.from(sig.sig, 'base64url').toString('base64url') === sig.sig;
    const kidOk = sigOk && sig.kid === TEST_KID;
    const cryptoOk = kidOk && verifyManifest(bytes, sig.sig, anchor);
    const code = !canonicalOk ? 'PKG_INVALID_MANIFEST' : !sigOk ? 'PKG_SIGNATURE' : !kidOk ? 'PKG_UNTRUSTED_KID' : !cryptoOk ? 'PKG_SIGNATURE' : null;
    expect(v.code === code && v.valid === (code === null), `signing/${v.name}: code ${v.code} ≠ 推导 ${code}`);
    count();
  }
  expect(sv.vectors.some((v) => v.sigFile?.kid === UNTRUSTED_KID), 'signing: 缺 kid 不在锚中的向量');

  // 6. position-free 向量：ts readCoreIr + ts canonicalJson 复算
  for (const v of JSON.parse(out.get('vectors/position-free-hash.json').bytes.toString('utf8')).vectors) {
    ts.readCoreIr(v.coreJson);
    expect(sha256Hex(utf8(v.coreJson)) === v.sha256, `position-free/${v.name}: sha256`);
    expect(sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(v.coreJson))))) === v.positionFreeSha256, `position-free/${v.name}: positionFreeSha256`);
    count();
  }

  // 7. 值向量：platform 来源的树经 ts 解释器序列化写法（serializeGuestValue 的树）无关，只校验参照实现自洽；error 向量确实失败
  for (const v of JSON.parse(out.get('vectors/value-json.json').bytes.toString('utf8')).vectors) {
    let got = null;
    try {
      got = valueJson(parseValueTree(v.treeJson));
    } catch {
      got = null;
    }
    expect(v.error ? got === null : got === v.expected, `value-json/${v.name}`);
    count();
  }

  // 8. 信任锚文件与测试密钥一致
  const jwks = JSON.parse(out.get('keys/test-jwks.json').bytes.toString('utf8'));
  expect(jwks.keys.length === 1 && jwks.keys[0].kid === TEST_KID && Buffer.from(jwks.keys[0].x, 'base64url').equals(TEST_KEY.publicRaw), 'keys: test-jwks.json 与测试密钥不符');

  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`verify-engines: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(`verify-engines: ok (${checks} checks, ${defs.size} packages, ${rows.length} cases)`);
  }
}

/**
 * 3f：显示排版夹具的独立复算：1.1 schema、规范字节、签名、参照流水线（read → manifest → signature → integrity）、
 * L1–L7（参照实现 display.mjs）、反向映射的结论与 canonicalSha256、每条用例的错误码与 meta；以及依赖编译器的部分
 * （本地重编译的投影哈希、L8 / L9 / L10、run --display 的求值与 matchesPackage），要求所用 ts 已含包格式 1.1（≥ 3.6.0，CI 固定于此）。
 * src/display/pending-ts-release.json 列出的条目需要更新的 ts（名字转义与 L10）：ts 版本 < tsNext 时跳过其引擎复算，
 * ts ≥ tsNext 时清单非空即报错（列车发布后升固定版本并清空清单）。
 */
function verifyDisplay({ ts, display, out, refOpts, loadAnchor, expect, count, envelopeSchema, manifestSchema11, canonicalize }) {
  const anchorKey = publicKeyFromRaw(TEST_KEY.publicRaw);
  const pfOf = (core) => sha256Hex(utf8(ts.canonicalJson(positionFreeTree(JSON.parse(core)))));
  const pending = JSON.parse(readFileSync(join(SRC, 'display', 'pending-ts-release.json'), 'utf8'));
  if (semverAtLeast(ts.version, pending.tsNext)) expect(pending.cases.length === 0, `display: ts ${ts.version} ≥ ${pending.tsNext}，pending-ts-release.json 应清空（${pending.cases.length} 条）`);
  // --assume-ts-display（只用于本地）：所给 ts 是尚未发布、但已含所需支持的同名分支构建，照常做全部引擎复算
  const pendingIds = has('--assume-ts-display') ? new Set() : new Set(pending.cases);
  for (const pkg of display.dpkgs.values()) {
    const text = pkg.manifestBytes.toString('utf8');
    const tree = JSON.parse(text);
    expect(manifestSchema11(tree), `display/${pkg.name}: manifest 不符合 1.1 schema ${JSON.stringify(manifestSchema11.errors)}`);
    expect(canonicalize(tree) === text && ts.canonicalJson(tree) === text, `display/${pkg.name}: manifest 字节与 jcs / ts canonicalJson 不同`);
    expect(verifyManifest(pkg.manifestBytes, pkg.sig.sig, anchorKey), `display/${pkg.name}: 签名不成立`);
    const r = checkPackage(join(PKG, 'display', 'packages', pkg.name), { ...refOpts, anchor: { kind: 'raw', key: TEST_KEY.publicRaw }, allowUnsigned: false });
    expect(r.ok, `display/${pkg.name}: 参照流水线应通过，得 ${r.code}@${r.stage}（${r.why}）`);
    const core = pendingIds.has(`packages/${pkg.name}`) ? undefined : tsCompileFiles(ts, pkg.manifest, pkg.files);
    if (core !== undefined) expect(core !== null && pfOf(core) === pkg.manifest.coreIr.positionFreeSha256, `display/${pkg.name}: ts 重编译的投影哈希与 manifest 不同`);
    if (core) {
      expect(structuralNameHits(pkg.def.layout, irNameStrings(core)).length === 0, `display/${pkg.name}: L8 命中`);
      const padded = tsCompileFiles(ts, pkg.manifest, new Map([...pkg.files, ['policy/policy.aster', utf8(padStructuralSpans(pkg.def.layout))]]));
      expect(padded !== null && pfOf(padded) === pfOf(core), `display/${pkg.name}: L9 补空格后投影哈希改变`);
    }
    count();
  }
  // 每条 display 用例：错误码 / 退出码与 exit-codes.json 一致，JSON stdout 符合 envelope schema；run --display 的结论与参照实现一致
  for (const [rel, v] of out) {
    if (!rel.startsWith('display/') || !rel.endsWith('cases.json')) continue;
    const cwd = join(PKG, dirname(rel));
    const doc = JSON.parse(v.bytes.toString('utf8'));
    for (const c of doc.cases) {
      const name = `${rel}/${c.name}`;
      expect(c.requiresFormat === '1.1', `${name}: display/ 的用例必须带 requiresFormat:"1.1"`);
      if (c.args[0] === 'show' && c.expectedExit === 0) continue; // 已在 2 中检查
      const env = JSON.parse(c.expectedStdout);
      expect(envelopeSchema(env), `${name}: expectedStdout 不符合 envelope schema`);
      if (c.code === 'USAGE') continue;
      const { positional, flags } = splitArgs(c.args.slice(1));
      const r = checkPackage(join(cwd, positional[0]), { ...refOpts, anchor: loadAnchor(cwd, flags), allowUnsigned: flags.includes('--allow-unsigned') });
      const early = !r.ok && r.stage !== 'ir';
      const PKG_STAGE_CODES = new Set(['PKG_INTEGRITY', 'PKG_SIGNATURE', 'PKG_UNSIGNED', 'PKG_UNTRUSTED_KID', 'PKG_INVALID_MANIFEST', 'PKG_UNSUPPORTED_FORMAT', 'PKG_UNSUPPORTED_IR']);
      const got = env.error?.code ?? env.checks?.find((k) => !k.ok)?.code ?? null;
      if (early) {
        expect(got === r.code, `${name}: 参照流水线得 ${r.code}@${r.stage}，夹具 ${got}`);
        count();
        continue;
      }
      expect(!PKG_STAGE_CODES.has(got), `${name}: 参照流水线通过，夹具却是 ${got}`);
      // 显示排版 L1–L7（参照实现）
      let layout = null;
      let layoutRule = null;
      const m = r.manifest;
      if (m.display) {
        try {
          const vocab = r.files.get('policy/compile/vocabulary.json');
          const aliasSet = JSON.parse(r.files.get('policy/compile/alias-set.json').toString('utf8'));
          layout = checkPackageLayout({
            layoutBytes: r.files.get('policy/display/layout.json'), displayBytes: r.files.get('policy/display/display.aster'),
            source: r.files.get('policy/policy.aster'), layoutVersion: m.display.layoutVersion,
            ...ruleContext(m.source.locale, aliasSet, vocab ? JSON.parse(vocab.toString('utf8')) : null),
          });
        } catch (e) {
          if (!(e instanceof DisplayRuleError)) throw e;
          layoutRule = e.rule;
        }
      }
      const cmd = c.args[0];
      const displayCheck = env.checks?.find((k) => k.name === 'display');
      if (cmd === 'verify') expect(Boolean(displayCheck) === Boolean(m.display) && (!displayCheck || displayCheck.ok === (layoutRule === null)), `${name}: verify 的 display 检查项与参照 L1–L7（${layoutRule ?? 'ok'}）不符`);
      // verify --recompile：包源码的重编译与包排版的 L8 / L9 / L10b（display-ir 检查项）依赖编译器
      if (cmd === 'verify' && flags.includes('--recompile') && layout && !pendingIds.has(name)) {
        const source = r.files.get('policy/policy.aster').toString('utf8');
        const core = tsCompileFiles(ts, m, r.files);
        const recompile = env.checks.find((k) => k.name === 'recompile');
        expect(recompile?.ok === (core !== null && pfOf(core) === m.coreIr.positionFreeSha256), `${name}: verify 的 recompile 检查项与 ts 复算不符`);
        if (core !== null) {
          const displayIr = env.checks.find((k) => k.name === 'display-ir');
          const rejected = displayIrRejected(ts, m, r.files, layout, source, core, pfOf);
          expect(displayIr?.ok === !rejected, `${name}: verify 的 display-ir 检查项与 ts 复算 L8/L9/L10（${rejected ? '拒绝' : '通过'}）不符`);
        }
      }
      const editIdx = flags.findIndex((f) => f === '--display' || f === '--from-display');
      if ((cmd === 'show' || editIdx >= 0) && m.display && layoutRule !== null) expect(got === 'PKG_DISPLAY_INVALID', `${name}: 包排版 ${layoutRule} 失败，应为 PKG_DISPLAY_INVALID`);
      if (editIdx >= 0 && !m.display) expect(got === 'PKG_DISPLAY_INVALID', `${name}: 包无排版，应为 PKG_DISPLAY_INVALID`);
      if (editIdx >= 0 && layout) {
        const f = readDisplayFile(join(cwd, flags[editIdx + 1]));
        const rec = f.oversize ? { kind: 'unmappable' } : reconstructFromDisplay(layout, f.text);
        const want = { unmappable: 'DISPLAY_UNMAPPABLE', ambiguous: 'DISPLAY_AMBIGUOUS' }[rec.kind];
        if (want) expect(got === want, `${name}: 参照反向映射得 ${rec.kind}，夹具 ${got}`);
        else {
          expect(!['DISPLAY_UNMAPPABLE', 'DISPLAY_AMBIGUOUS'].includes(got), `${name}: 参照反向映射唯一，夹具 ${got}`);
          const canonical = toCanonical(rec.layout);
          if (env.meta.display) expect(env.meta.display.canonicalSha256 === sha256Hex(utf8(canonical)), `${name}: canonicalSha256 与参照还原不符`);
          expect(env.meta.coreIrSha256 === null, `${name}: run --display 的 coreIrSha256 必须为 null`);
          // 派生排版的 L10a 在编译之前（derived 阶段）：失败即 DISPLAY_REJECTED，不依赖编译器
          let derivedL10a = false;
          try {
            hiddenEscapeTriples(rec.layout);
          } catch (e) {
            if (!(e instanceof DisplayRuleError)) throw e;
            derivedL10a = true;
          }
          if (derivedL10a) {
            expect(got === 'DISPLAY_REJECTED', `${name}: 派生排版 L10a 失败，应为 DISPLAY_REJECTED，夹具 ${got}`);
            count();
            continue;
          }
          // 依赖编译器的复算：派生程序编译、L8 / L9 / L10、matchesPackage、求值
          if (pendingIds.has(name)) {
            count();
            continue;
          }
          const files = new Map([...r.files, ['policy/policy.aster', utf8(canonical)]]);
          const core = tsCompileFiles(ts, m, files);
          if (got === 'COMPILE_ERROR') expect(core === null, `${name}: ts 编译派生源码成功，夹具为 COMPILE_ERROR`);
          else if (core !== null) {
            const rejected = displayIrRejected(ts, m, files, rec.layout, canonical, core, pfOf);
            expect(rejected === (got === 'DISPLAY_REJECTED'), `${name}: ts 复算 L8/L9/L10 ${rejected ? '拒绝' : '通过'}，夹具 ${got}`);
            if (env.meta.display) expect(env.meta.display.matchesPackage === (pfOf(core) === m.coreIr.positionFreeSha256), `${name}: matchesPackage 与 ts 复算不符`);
            if (cmd === 'run' && got === null) {
              const entry = entryOfArgs(flags, m);
              const input = validateInput(c.stdin !== undefined ? utf8(c.stdin) : utf8(''), JSON.parse(core), entry);
              const t = tsEval(ts, core, entry, input);
              expect(t.ok && c.expectedStdout.endsWith(`,"ok":true,"value":${t.value}}\n`), `${name}: ts 结果 ${t.value ?? t.error} ≠ 期望`);
            }
          } else expect(false, `${name}: ts 编译派生源码失败，夹具为 ${got}`);
        }
      }
      count();
    }
  }
}

/**
 * 依赖编译器的显示排版规则：L8（结构 span 不含 IR 名字）、L9（结构 span 补空格不改 IR）、L10a（形状）与 L10b
 * （去掉被隐藏反引号的每个非空子集编译失败或同一 IR，ADR 0059 修订 5）。canonical 为 layout 的规范源码，core 为其 IR。
 */
function displayIrRejected(ts, manifest, files, layout, canonical, core, pfOf) {
  const withSource = (text) => tsCompileFiles(ts, manifest, new Map([...files, ['policy/policy.aster', utf8(text)]]));
  if (structuralNameHits(layout, irNameStrings(core)).length > 0) return true;
  const padded = withSource(padStructuralSpans(layout));
  if (padded === null || pfOf(padded) !== pfOf(core)) return true;
  let triples;
  try {
    triples = hiddenEscapeTriples(layout);
  } catch (e) {
    if (!(e instanceof DisplayRuleError)) throw e;
    return true;
  }
  return Array.from({ length: (1 << triples.length) - 1 }, (_, k) => k + 1).some((subset) => {
    const variant = withSource(stripHiddenEscapes(canonical, triples, subset));
    return variant !== null && pfOf(variant) !== pfOf(core);
  });
}

/** a ≥ b（只比较 major.minor.patch）。 */
function semverAtLeast(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return true;
}

/** 参数拆成位置参数与选项（README「命令行」：带值选项 --entry --input --timeout --jwks --pubkey，可写成 --opt=value）。 */
function splitArgs(args) {
  const VALUED = new Set(['--entry', '--input', '--timeout', '--jwks', '--pubkey', '--display', '--from-display']);
  const positional = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (VALUED.has(a)) flags.push(a, args[++i]);
    else if (a.startsWith('--')) flags.push(...(a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
    else positional.push(a);
  }
  return { positional, flags };
}

/** 按 manifest 找回黄金包定义（篡改夹具与 zip 形态都指向某个黄金包的 manifest）。 */
function defsByModule(pkgs, manifest) {
  const hit = [...pkgs.values()].find((p) => p.manifest.coreIr.sha256 === manifest.coreIr.sha256 && p.manifest.policy.moduleName === manifest.policy.moduleName);
  if (!hit) throw new Error(`找不到 coreIr.sha256 为 ${manifest.coreIr.sha256} 的黄金包`);
  return hit;
}

function entryOfArgs(flags, manifest) {
  const i = flags.findIndex((f) => f === '--entry' || f.startsWith('--entry='));
  if (i < 0) return manifest.policy.entries.find((e) => e.default).function;
  return flags[i].startsWith('--entry=') ? flags[i].slice(8) : flags[i + 1];
}

/** --capture-compile：以平台编译序列采集 compile/ 源码类用例的结果（成功取投影哈希，失败记错误）。 */
function captureCompile() {
  const cpFile = opt('--cp-file');
  if (!cpFile) usage('--capture-compile 需要 --cp-file');
  const dir = join(SRC, 'compile');
  const doc = JSON.parse(readFileSync(join(dir, 'compile.json'), 'utf8'));
  const reqs = doc.cases.filter((c) => c.platform).map((c) => ({
    id: c.name,
    source: decodeSource(readFileSync(join(dir, c.platform.source))),
    locale: c.platform.locale,
    aliasSet: c.platform.aliasSet ? JSON.parse(readFileSync(join(dir, c.platform.aliasSet), 'utf8')) : null,
    vocabulary: c.platform.vocabulary ? JSON.parse(readFileSync(join(dir, c.platform.vocabulary), 'utf8')) : null,
    allowStructural: c.platform.allowStructural === true,
  }));
  const cp = readFileSync(cpFile, 'utf8').trim();
  const r = spawnSync('java', ['-cp', cp, join(ROOT, 'scripts/package-v1/PlatformCompile.java')], { input: `${reqs.map((q) => JSON.stringify(q)).join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
  const out = {};
  for (const line of r.stdout.split('\n').filter((l) => l.startsWith('{'))) {
    const o = JSON.parse(line);
    out[o.id] = o.ok ? { ok: true, positionFreeSha256: sha256Hex(utf8(canonicalJson(positionFreeTree(JSON.parse(o.coreJson))))) } : { ok: false, error: o.error };
  }
  writeFileSync(join(dir, 'expected.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`captured ${Object.keys(out).length} compile cases`);
}

function usage(msg) {
  console.error(`build-package-fixtures: ${msg}`);
  process.exit(2);
}

if (has('--capture-compile')) {
  captureCompile();
} else if (has('--capture')) {
  await capture();
} else if (has('--verify-engines')) {
  await verifyEngines();
} else {
  const { out } = generate();
  if (has('--check')) {
    const problems = check(out);
    if (problems.length) {
      for (const p of problems.slice(0, 50)) console.error(`✗ ${p}`);
      console.error(`build-package-fixtures --check: ${problems.length} difference(s); run \`node scripts/build-package-fixtures.mjs\` and commit the result`);
      process.exitCode = 1;
    } else {
      console.log(`build-package-fixtures --check: ok (${out.size} files)`);
    }
  } else {
    write(out);
    console.log(`build-package-fixtures: wrote ${out.size} files`);
  }
}
