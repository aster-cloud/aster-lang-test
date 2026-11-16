/**
 * 包格式 v1 夹具的纯函数生成（不读网络、不调用引擎）：输入是 conformance/package-v1/src/ 下入库的源夹具
 * （源码、fixture.json、采集好的平台 IR 与期望值），输出是「相对路径 → 字节」的映射。
 * build-package-fixtures.mjs 用它写盘或与仓内逐字节比较（--check）。同一输入永远产出同一字节。
 *
 * 结构与规则的说明在 conformance/package-v1/README.md；这里的注释只解释实现上的取舍。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { parseValueTree, valueJson, bitsOfDouble, doubleFromBits } from './value-json.mjs';
import { positionFreeSha256 } from './position-free.mjs';
import { keyPairFromSeed, signManifest, base64url } from './signing.mjs';
import { writeZip, deflateZeros, deflateStored, crc32 } from './zip.mjs';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (s) => Buffer.from(s, 'utf8');
const jsonFile = (v) => utf8(`${JSON.stringify(v, null, 2)}\n`);
/** 输入 JSON（stdin / probes.input）：键按码点升序、无空白；数字按值规范 JSON 写法（Double 入参可以是非整数）。 */
export const inputJson = (v) => valueJson(v);

// ---------------------------------------------------------------------------
// 测试密钥（仅测试，绝不用于发布）：种子由固定标签的 SHA-256 得出，任何人可复现，因此毫无保密性。
// ---------------------------------------------------------------------------
export const TEST_KEY_LABEL = 'aster-policy-package/v1 TEST-ONLY signing key test-2026-11 (public, never use for releases)';
export const TEST_KID = 'test-2026-11';
export const TEST_ISSUER = 'aster-conformance-test';
export const UNTRUSTED_KID = 'test-2026-11-untrusted';
export const TEST_KEY = keyPairFromSeed(createHash('sha256').update(TEST_KEY_LABEL).digest());

export const ANCHOR_JWKS = '../keys/test-jwks.json';
export const ANCHOR_PUBKEY = '../keys/test-ed25519.pub.b64u';

/** 平台 / 工具链的固定描述值（只作信息字段，v1 CLI 不据此放行或拒绝）。 */
const ECOSYSTEM = '1.0.49';
const TOOLCHAIN_ID = `abi=2.0;core=${ECOSYSTEM};validator=${ECOSYSTEM};resolver=1;casefold=15.1;build=fixture`;
const RUNTIME = {
  node: { engine: 'aster-lang-ts-interpreter', cli: { name: '@aster-cloud/aster-lang-ts', version: '3.2.0' }, requires: { node: '>=24' } },
  jre: { engine: 'aster-lang-truffle', cli: { name: 'cloud.aster-lang:aster-cli', version: ECOSYSTEM }, requires: { java: '>=25' } },
};
/** A 包在 P1 不放 runtime/ 文件（只测 compiled/ 路径）；schema 要求 runtime.cli.sha256，取空字节的哈希。 */
const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

// ---------------------------------------------------------------------------
// 检查阶段与 meta（README「检查顺序」）
// ---------------------------------------------------------------------------
export const STAGES = ['usage', 'read', 'manifest', 'signature', 'integrity', 'ir', 'entry', 'input', 'eval', 'done'];
const DEFAULT_STAGE = {
  USAGE: 'usage',
  PKG_INVALID_MANIFEST: 'manifest',
  PKG_UNSUPPORTED_FORMAT: 'manifest',
  PKG_UNSUPPORTED_IR: 'manifest',
  PKG_UNSIGNED: 'signature',
  PKG_SIGNATURE: 'signature',
  PKG_UNTRUSTED_KID: 'signature',
  PKG_INTEGRITY: 'integrity',
  PKG_IR_DRIFT: 'ir',
  ENTRY_NOT_FOUND: 'entry',
  INPUT_INVALID: 'input',
  EVAL_ERROR: 'eval',
  TIMEOUT: 'eval',
  RESOURCE_EXHAUSTED: 'eval',
};
const after = (stage, ref) => STAGES.indexOf(stage) > STAGES.indexOf(ref);

/** run 的 meta：signed 在签名检查通过后为真（无签名且 --allow-unsigned 时为假）；entry / coreIrSha256 在取得 IR 后填入。 */
function runMeta(pkg, stage, { entry, allowUnsigned }) {
  const haveIr = after(stage, 'ir');
  return {
    cliVersion: '<CLI_VERSION>',
    coreIrSha256: haveIr ? pkg.manifest.coreIr.sha256 : null,
    engine: '<ENGINE>',
    entry: haveIr ? entry : null,
    irRecompiled: haveIr && pkg.manifest.mode === 'b',
    signed: after(stage, 'signature') && pkg.signed && !(allowUnsigned && !pkg.signed),
  };
}

export function errorEnvelope(code, meta, exitCodes) {
  const { message } = exitCodes[code];
  return `${canonicalJson({ error: { code, message }, meta, ok: false })}\n`;
}

const okEnvelope = (meta, value) => `{"meta":${canonicalJson(meta)},"ok":true,"value":${value}}\n`;

// ---------------------------------------------------------------------------
// 源夹具
// ---------------------------------------------------------------------------
export function loadSources(srcDir) {
  const defs = new Map();
  for (const name of readdirSync(srcDir).sort()) {
    const dir = join(srcDir, name);
    if (!existsSync(join(dir, 'fixture.json'))) continue;
    defs.set(name, { name, dir, ...JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) });
  }
  // 派生夹具（base）：载荷与采集结果沿用 base，fixture.json 中的字段覆盖。
  for (const def of defs.values()) {
    if (!def.base) continue;
    const base = defs.get(def.base);
    if (!base || base.base) throw new Error(`${def.name}: base ${def.base} 不存在或本身是派生夹具`);
    for (const k of ['mode', 'target', 'locale', 'aliasSet', 'allowStructural', 'vocabulary', 'claimedRefVersion', 'entries', 'probes']) {
      if (!(k in def)) def[k] = base[k];
    }
    def.sourceDir = base.dir;
  }
  for (const def of defs.values()) {
    def.sourceDir ??= def.dir;
    def.signed ??= true;
    def.platformCore = readFileSync(join(def.sourceDir, 'platform-core.json'), 'utf8');
    const expectedPath = join(def.sourceDir, 'expected.json');
    def.expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : { cases: {}, probes: [] };
  }
  return defs;
}

// ---------------------------------------------------------------------------
// schema/input.json 与 schema/output.json：由 IR 形参 / 返回类型生成（README「输入 schema」）
// ---------------------------------------------------------------------------
const SAFE = Number.MAX_SAFE_INTEGER;
/** ECMA-262 与 java.util.regex（Matcher.find）下都只匹配输入末尾的锚（`$` 在 Java 中还会匹配末尾换行之前）。 */
export const END = '(?![\\s\\S])';
const INT32 = { min: -2147483648, max: 2147483647 };
/** Decimal 输入最多 80 位数字（不计符号与小数点），与 ts decimal.js `precision: 80` 一致；位数由 CLI 判（schema 只管形态）。 */
export const DECIMAL_MAX_DIGITS = 80;
const PRIMITIVE_INPUT = {
  // Truffle 的 Int 是 32 位（CoreModel.IntE.value 为 int），包格式把 Int 入参限定在 int32，超出即 INPUT_INVALID；大值用 Long。
  Int: { type: 'integer', minimum: INT32.min, maximum: INT32.max },
  // Long：安全整数 token，或 int64 范围内的十进制字符串（范围由 CLI 判：模式只限 19 位以内）。
  Long: {
    anyOf: [
      { type: 'integer', minimum: -SAFE, maximum: SAFE },
      { type: 'string', pattern: `^-?(0|[1-9][0-9]{0,18})${END}` },
    ],
  },
  Double: { type: 'number' },
  Decimal: { type: 'string', pattern: `^-?(0|[1-9][0-9]*)(\\.[0-9]+)?${END}` },
  Text: { type: 'string' },
  Bool: { type: 'boolean' },
};
const VERDICT_OUTPUT = {
  type: 'object',
  required: ['__type', 'outcome'],
  properties: {
    __type: { const: 'Verdict' },
    outcome: { enum: ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ESCALATE'] },
    reason: { type: 'string' },
    role: { type: 'string' },
  },
  additionalProperties: false,
};

function declsOf(ir, kind) {
  return new Map(ir.decls.filter((d) => d.kind === kind).map((d) => [d.name, d]));
}

/**
 * Core IR 类型 → JSON Schema。输入形态（README「输入」）：List → 数组；Map（键必须是 Text）→ 对象；
 * Maybe / Option → `null`（None）或内层形态（Some）；无载荷 Enum → 变体名字符串；Data → 全字段必填的对象。
 * Result、非 Text 键的 Map、嵌套 Maybe 不能作为输入（P2 导出以 E733 拒绝），这里直接报错。
 */
function typeSchema(type, ctx, defs, direction) {
  const input = direction === 'input';
  switch (type.kind) {
    case 'List':
      return { type: 'array', items: typeSchema(type.type, ctx, defs, direction) };
    case 'Map':
      if (type.key.kind !== 'TypeName' || type.key.name !== 'Text') throw new Error('Map 的键必须是 Text');
      return { type: 'object', additionalProperties: typeSchema(type.val, ctx, defs, direction) };
    case 'Maybe':
    case 'Option':
      if (input) {
        if (type.type.kind === 'Maybe' || type.type.kind === 'Option') throw new Error('嵌套 Maybe 不能作为输入');
        return { anyOf: [{ type: 'null' }, typeSchema(type.type, ctx, defs, direction)] };
      }
      return {
        anyOf: [
          { type: 'object', properties: { __type: { const: 'Some' }, value: typeSchema(type.type, ctx, defs, direction) }, required: ['__type', 'value'], additionalProperties: false },
          { type: 'object', properties: { __type: { const: 'None' } }, required: ['__type'], additionalProperties: false },
        ],
      };
    case 'Result':
      if (input) throw new Error('Result 不能作为输入');
      return { type: 'object', properties: { __type: { enum: ['Ok', 'Err'] }, value: {} }, required: ['__type', 'value'], additionalProperties: false };
    case 'TypeName':
      break;
    default:
      throw new Error(`夹具生成器不支持类型 ${type.kind}`);
  }
  if (input && PRIMITIVE_INPUT[type.name]) return PRIMITIVE_INPUT[type.name];
  if (!input) {
    if (type.name === 'Verdict') return VERDICT_OUTPUT;
    if (type.name === 'Decimal') return { type: 'string' };
    if (type.name === 'Long' || type.name === 'Int') return { type: 'integer' };
    if (type.name === 'Double') return { type: 'number' };
    if (PRIMITIVE_INPUT[type.name]) return { type: PRIMITIVE_INPUT[type.name].type };
  }
  const en = ctx.enums.get(type.name);
  if (en) {
    const names = en.variants.map((v) => (typeof v === 'string' ? v : v.name));
    if (en.variants.some((v) => typeof v !== 'string' && v.fields?.length)) throw new Error(`带载荷的 Enum ${type.name} 不能作为输入`);
    return input
      ? { type: 'string', enum: names }
      : { type: 'object', properties: { _enum: { const: type.name }, args: { type: 'array' }, value: { enum: names }, variant: { enum: names } }, required: ['_enum', 'args', 'value', 'variant'], additionalProperties: false };
  }
  const data = ctx.datas.get(type.name);
  if (!data) throw new Error(`未知类型 ${type.name}`);
  const key = `data.${type.name}`;
  if (!defs[key]) {
    defs[key] = {}; // 先占位，防递归类型无限展开
    const properties = {};
    for (const f of data.fields) properties[f.name] = typeSchema(f.type, ctx, defs, direction);
    defs[key] = input
      ? { type: 'object', properties, required: data.fields.map((f) => f.name), additionalProperties: false }
      : { type: 'object', properties: { __type: { const: type.name }, ...properties }, required: ['__type', ...data.fields.map((f) => f.name)], additionalProperties: false };
  }
  return { $ref: `#/$defs/${key}` };
}

export function entrySchemas(ir, entries) {
  const ctx = { datas: declsOf(ir, 'Data'), enums: declsOf(ir, 'Enum') };
  const input = {};
  const output = {};
  for (const { function: fn } of entries) {
    const func = ir.decls.find((d) => d.kind === 'Func' && d.name === fn);
    if (!func) throw new Error(`入口 ${fn} 不在 IR 中`);
    const properties = {};
    for (const p of func.params) properties[p.name] = typeSchema(p.type, ctx, input, 'input');
    input[`entry.${fn}`] = { type: 'object', properties, required: func.params.map((p) => p.name), additionalProperties: false };
    output[`entry.${fn}`] = typeSchema(func.ret, ctx, output, 'output');
  }
  const doc = (title, defs) => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', title, $defs: defs });
  return { input: doc(`${ir.name} entry inputs`, input), output: doc(`${ir.name} entry outputs`, output) };
}

// ---------------------------------------------------------------------------
// 黄金包
// ---------------------------------------------------------------------------
function annotationValues(func, name) {
  return func.annotations.filter((a) => a.name === name).map((a) => a.args[0]?.value).filter((v) => typeof v === 'string');
}

function probesFile(def) {
  const probes = def.probes.map((p, i) => {
    const exp = def.expected.probes[i];
    if (!exp || (exp.value === undefined && exp.error === undefined)) throw new Error(`${def.name}: probes[${i}] 缺少采集的期望值（先跑 --capture）`);
    // 期望求值失败的探针（只允许 EVAL_ERROR；超时与资源耗尽不在承诺内，P2 生成时丢弃这类探针）
    if (exp.error !== undefined) {
      if (p.expect !== 'EVAL_ERROR') throw new Error(`${def.name}: probes[${i}] 在平台上失败但未声明 expect:"EVAL_ERROR"`);
      return `{"entry":${canonicalJson(p.entry)},"expected":{"code":"EVAL_ERROR","ok":false},"input":${inputJson(p.input)}}`;
    }
    let value = exp.value;
    if (def.corruptProbe && def.corruptProbe.index === i) value = valueJson(def.corruptProbe.value);
    return `{"entry":${canonicalJson(p.entry)},"expected":{"ok":true,"value":${value}},"input":${inputJson(p.input)}}`;
  });
  return utf8(`{"probes":[${probes.join(',')}]}`);
}

function readme(def, ir) {
  return utf8(
    `# ${ir.name}（包格式 v1 测试夹具：${def.name}）\n\n` +
      '本包由 aster-lang-test `scripts/build-package-fixtures.mjs` 生成，只用于 ADR 0059 包格式 v1 的一致性测试。\n' +
      '签名使用公开的测试密钥（conformance/package-v1/keys/），不证明任何来源，绝不用于生产。\n',
  );
}

/** 构建一个黄金包：返回 { name, manifest, manifestBytes, sig, files: Map<path, Buffer>, signed, entries }。 */
export function buildPackage(def) {
  const ir = JSON.parse(def.platformCore);
  const sourceBytes = readFileSync(join(def.sourceDir, 'policy.aster'));
  const schemas = entrySchemas(ir, def.entries);
  const payload = new Map();
  payload.set('README.md', readme(def, ir));
  payload.set('policy/policy.aster', sourceBytes);
  payload.set('policy/compile/alias-set.json', utf8(canonicalJson(def.aliasSet ?? null)));
  if (def.vocabulary) {
    payload.set('policy/compile/vocabulary.json', utf8(canonicalJson(JSON.parse(readFileSync(join(def.sourceDir, 'vocabulary.json'), 'utf8')))));
  }
  payload.set('schema/input.json', utf8(canonicalJson(schemas.input)));
  payload.set('schema/output.json', utf8(canonicalJson(schemas.output)));
  payload.set('tests/probes.json', probesFile(def));
  if (def.mode === 'a') payload.set('compiled/core.json', utf8(def.platformCore));

  const funcs = def.entries.map((e) => ir.decls.find((d) => d.kind === 'Func' && d.name === e.function));
  const defaultFunc = funcs[def.entries.findIndex((e) => e.default)];
  const runtime = structuredClone(RUNTIME[def.target]);
  if (def.mode === 'a') runtime.cli.sha256 = EMPTY_SHA256;
  runtime.ecosystem = ECOSYSTEM;
  const sourceSha = sha256Hex(sourceBytes);
  const paths = [...payload.keys()].sort();
  const manifest = {
    coreIr: {
      positionFreeSha256: positionFreeSha256(def.platformCore),
      sha256: sha256Hex(utf8(def.platformCore)),
      toolchainId: TOOLCHAIN_ID,
      version: ir.schemaVersion,
    },
    effects: {
      declared: [...new Set(ir.decls.filter((d) => d.kind === 'Func').flatMap((d) => d.effects.map(String)))].sort(),
      io: false,
    },
    exportedBy: { issuer: 'aster-cloud', tenantId: 'tenant-fixture' },
    files: paths.map((p) => ({ path: p, sha256: sha256Hex(payload.get(p)), size: payload.get(p).length })),
    format: 'aster-policy-package',
    formatVersion: '1.0',
    governance: {
      enforced: false,
      factSources: [],
      verdict: funcs.some((f) => f.ret.kind === 'TypeName' && f.ret.name === 'Verdict'),
    },
    mode: def.mode,
    policy: {
      controls: [...new Set(funcs.flatMap((f) => annotationValues(f, 'control')))].sort(),
      entries: def.entries.map((e) => ({
        default: e.default,
        function: e.function,
        inputSchema: `#/$defs/entry.${e.function}`,
        outputSchema: `#/$defs/entry.${e.function}`,
      })),
      moduleName: ir.name,
      profile: ir.profile ?? null,
      ruleId: annotationValues(defaultFunc, 'id')[0] ?? null,
    },
    runtime,
    source: {
      allowStructural: def.allowStructural,
      claimedRef: { approvedAt: '2026-11-01T00:00:00Z', policyId: `pol-fixture-${def.name}`, status: 'APPROVED', version: def.claimedRefVersion },
      envelopeSha256: sha256Hex(utf8(`fixture-envelope\n${def.name}\n${sourceSha}`)),
      locale: def.locale,
      sha256: sourceSha,
    },
    target: def.target,
    tests: {
      nodeCheck: null,
      probes: def.probes.length,
      probesSha256: sha256Hex(payload.get('tests/probes.json')),
    },
  };
  return assemble({ name: def.name, def, ir, payload, manifest, signed: def.signed });
}

/** 由载荷与 manifest 对象算出 manifest 字节、签名与 SHA256SUMS（篡改夹具重新签名时也走这里）。 */
export function assemble(pkg, { kid = TEST_KID } = {}) {
  const manifestBytes = pkg.manifestBytes ?? utf8(canonicalJson(pkg.manifest));
  const sig = pkg.signed ? signManifest(manifestBytes, TEST_KEY, { issuer: TEST_ISSUER, kid }) : null;
  const files = new Map(pkg.payload);
  files.set('manifest.json', manifestBytes);
  if (sig) files.set('manifest.sig.json', utf8(canonicalJson(sig)));
  files.set('SHA256SUMS', sha256sums(pkg.payload, manifestBytes));
  return { ...pkg, manifestBytes, sig, files };
}

/** GNU sha256sum 格式（LF）：载荷 + manifest.json，按路径 UTF-8 字节序。 */
export function sha256sums(payload, manifestBytes) {
  const all = new Map(payload);
  all.set('manifest.json', manifestBytes);
  const lines = [...all.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b))).map((p) => `${sha256Hex(all.get(p))}  ${p}\n`);
  return utf8(lines.join(''));
}

/** zip 根目录名（ADR 0059 §2）：<moduleName>-v<version>-<target>-<mode>。 */
export function zipRoot(pkg) {
  const m = pkg.manifest;
  return `${m.policy.moduleName}-v${m.source.claimedRef.version}-${m.target}-${m.mode}`;
}

/**
 * 包的 zip 形态（packages/<name>.zip）。style：
 *   - 'plain'（缺省）：本地头带大小、无数据描述符、名字 ASCII 时不置 UTF-8 标志；
 *   - 'zipoutputstream'：与 aster-api 用 java.util.zip.ZipOutputStream 写出的形态相同——全部条目置标志位 11（UTF-8 名），
 *     DEFLATED 条目置标志位 3、本地头 crc / 大小为 0、数据后跟数据描述符；STORED（目录）条目照常在本地头给出大小。
 */
export const writeZipOf = (pkg) => writeZip(zipEntries(pkg, { style: pkg.def.zipStyle }));

/** 包 → zip 条目（含目录条目，验证读取方忽略目录条目；policy.aster 用 deflate 存储块，其余存储；zipoutputstream 风格全部文件 deflate）。 */
export function zipEntries(pkg, { root = zipRoot(pkg), style = 'plain' } = {}) {
  const paths = [...pkg.files.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
  const dirs = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const jos = style === 'zipoutputstream';
  const entries = [{ name: `${root}/`, directory: true, utf8: jos }];
  for (const d of [...dirs].sort()) entries.push({ name: `${root}/${d}/`, directory: true, utf8: jos });
  for (const p of paths) {
    const deflate = jos || p === 'policy/policy.aster';
    entries.push({ name: `${root}/${p}`, data: pkg.files.get(p), method: deflate ? 8 : 0, descriptor: jos, utf8: jos });
  }
  return entries.sort((a, b) => Buffer.compare(utf8(a.name), utf8(b.name)));
}

// ---------------------------------------------------------------------------
// cases.json
// ---------------------------------------------------------------------------
function anchorArgs(anchor) {
  if (anchor === 'none') return [];
  if (anchor === 'pubkey') return ['--pubkey', ANCHOR_PUBKEY];
  if (anchor && typeof anchor === 'object') return anchor.pubkey ? ['--pubkey', anchor.pubkey] : ['--jwks', anchor.jwks];
  return ['--jwks', ANCHOR_JWKS];
}

function expectedValue(def, c, defs) {
  const ref = c.sameAs ?? c.name;
  const [owner, caseName] = ref.includes('/') ? ref.split('/') : [def.base ?? def.name, ref];
  const src = defs.get(owner);
  const exp = (src.expected.cases ?? {})[caseName];
  if (!exp || exp.value === undefined) throw new Error(`${def.name}/${c.name}: 缺少期望值 ${ref}（先跑 --capture）`);
  return exp.value;
}

function defaultEntry(def) {
  return def.entries.find((e) => e.default).function;
}

const META_PLACEHOLDERS = { cliVersion: '<CLI_VERSION>', engine: '<ENGINE>' };

/**
 * verify 的输出（README「verify」）。failure = null（无故障）或 { stage, code, failsIn? }：
 *   - usage → 与 run 相同的错误信封；
 *   - read → 唯一一项 integrity 失败（缺 manifest.json 时为 schema 失败）；
 *   - manifest → schema 失败；signature → schema 通过、signature 失败；integrity → 前两项通过、integrity 失败；
 *   - ir → A 包的 compiled/core.json 读不出时普通 verify 即在 ir 检查项失败；B 包的漂移只在 failsIn 列出的 recompile / probes 检查中失败。
 * 在第一项失败处停止。
 */
export function verifyOutput(pkg, flags, failure, exitCodes) {
  const allowUnsigned = flags.includes('--allow-unsigned');
  if (failure?.stage === 'usage') return errorOut(failure.code, runMeta(pkg, 'usage', { entry: null, allowUnsigned }), exitCodes);
  const checks = [];
  let signed = false;
  let integrity = false;
  let recompiled = false;
  const meta = () => ({
    ...META_PLACEHOLDERS,
    coreIrSha256: integrity ? pkg.manifest.coreIr.sha256 : null,
    entry: integrity ? defaultEntry(pkg.def) : null,
    irRecompiled: recompiled,
    signed,
  });
  const done = (ok, code) => ({ stdout: `${canonicalJson({ checks, meta: meta(), ok })}\n`, exit: ok ? 0 : exitCodes[code].exit, code: ok ? null : code });
  const fail = (name, code) => {
    checks.push({ code, name, ok: false });
    return done(false, code);
  };
  if (failure?.stage === 'read') return fail(failure.code === 'PKG_INVALID_MANIFEST' ? 'schema' : 'integrity', failure.code);
  if (failure?.stage === 'manifest') return fail('schema', failure.code);
  checks.push({ name: 'schema', ok: true });
  if (failure?.stage === 'signature') return fail('signature', failure.code);
  if (!pkg.signed && !allowUnsigned) return fail('signature', 'PKG_UNSIGNED');
  signed = pkg.signed;
  checks.push({ name: 'signature', ok: true });
  if (failure?.stage === 'integrity') return fail('integrity', failure.code);
  integrity = true;
  checks.push({ name: 'integrity', ok: true });
  // A 包：普通 verify 也严格读入 compiled/core.json（ADR §4.1「运行时兼容」），失败即 PKG_UNSUPPORTED_IR，与 run 一致
  if (pkg.manifest.mode === 'a') {
    if (failure?.stage === 'ir' && failure.code === 'PKG_UNSUPPORTED_IR') return fail('ir', failure.code);
    checks.push({ name: 'ir', ok: true });
  }
  const irFails = (name) => failure?.stage === 'ir' && (failure.failsIn ?? []).includes(name);
  if (flags.includes('--recompile')) {
    if (irFails('recompile')) return fail('recompile', failure.code);
    checks.push({ name: 'recompile', ok: true });
    recompiled = true;
  }
  if (flags.includes('--probes')) {
    if (irFails('probes')) return fail('probes', failure.code);
    if (pkg.def.corruptProbe) return fail('probes', 'PROBE_MISMATCH');
    checks.push({ name: 'probes', ok: true });
  }
  return done(true, null);
}

/** inspect：与 run 同一信任流水线（manifest → signature → integrity），不取 IR；失败输出错误信封。 */
export function inspectOutput(pkg, flags, failure, exitCodes) {
  const allowUnsigned = flags.includes('--allow-unsigned');
  if (failure && failure.stage !== 'ir') return errorOut(failure.code, runMeta(pkg, failure.stage, { entry: null, allowUnsigned }), exitCodes);
  if (!pkg.signed && !allowUnsigned) return errorOut('PKG_UNSIGNED', runMeta(pkg, 'signature', { entry: null, allowUnsigned }), exitCodes);
  const m = pkg.manifest;
  const meta = { ...META_PLACEHOLDERS, coreIrSha256: m.coreIr.sha256, entry: defaultEntry(pkg.def), irRecompiled: false, signed: pkg.signed };
  const schemas = {
    input: JSON.parse(pkg.files.get('schema/input.json').toString('utf8')),
    output: JSON.parse(pkg.files.get('schema/output.json').toString('utf8')),
  };
  const inspect = { effects: m.effects, governance: m.governance, policy: m.policy, runtime: m.runtime, schemas, tests: m.tests };
  return { stdout: `${canonicalJson({ inspect, meta, ok: true })}\n`, exit: 0, code: null };
}

function errorOut(code, meta, exitCodes) {
  return { stdout: errorEnvelope(code, meta, exitCodes), exit: exitCodes[code].exit, code };
}

function entryOf(flags, def) {
  const i = flags.findIndex((f) => f === '--entry' || f.startsWith('--entry='));
  if (i < 0) return defaultEntry(def);
  return flags[i].startsWith('--entry=') ? flags[i].slice('--entry='.length) : flags[i + 1];
}

function runCase(pkg, c, defs, exitCodes) {
  const flags = c.rawArgs ?? c.args ?? [];
  const entry = entryOf(flags, pkg.def);
  const allowUnsigned = flags.includes('--allow-unsigned');
  if (typeof c.expect === 'object') {
    const { code } = c.expect;
    const stage = c.expect.stage ?? DEFAULT_STAGE[code];
    return errorOut(code, runMeta(pkg, stage, { entry, allowUnsigned }), exitCodes);
  }
  const value = expectedValue(pkg.def, c, defs);
  return { stdout: okEnvelope(runMeta(pkg, 'done', { entry, allowUnsigned }), value), exit: 0, code: null };
}

/** 一个黄金包的 cases.json 内容。 */
export function packageCases(pkg, defs, exitCodes) {
  const cases = [];
  for (const c of pkg.def.cases) {
    const target = c.target ?? (c.package === 'zip' ? `${pkg.name}.zip` : pkg.name);
    const flags = c.args ?? [];
    let args;
    let out;
    if (c.rawArgs) {
      // 命令行语法用例：参数原样给出（{pkg} 替换为包路径），期望由 expect 决定
      args = c.rawArgs.map((a) => a.replaceAll('{pkg}', target));
    } else {
      args = [c.command, target, ...flags];
      if (c.command === 'run' && !flags.includes('--input')) args.push('--input', '-');
      args.push(...anchorArgs(c.anchor));
    }
    const failure = typeof c.expect === 'object' ? { stage: c.expect.stage ?? DEFAULT_STAGE[c.expect.code], code: c.expect.code } : null;
    if (c.command === 'run') out = runCase(pkg, c, defs, exitCodes);
    else if (c.command === 'verify') out = verifyOutput(pkg, flags, failure, exitCodes);
    else if (c.command === 'inspect') out = inspectOutput(pkg, flags, failure, exitCodes);
    else if (failure) out = errorOut(failure.code, runMeta(pkg, failure.stage, { entry: null, allowUnsigned: false }), exitCodes);
    else throw new Error(`${pkg.name}/${c.name}: 未知命令 ${c.command}`);
    const row = { name: c.name, args };
    if (c.input !== undefined) row.stdin = inputJson(c.input);
    if (c.stdin !== undefined) row.stdin = c.stdin;
    Object.assign(row, { expectedStdout: out.stdout, expectedExit: out.exit, code: out.code });
    cases.push(row);
  }
  return { description: pkg.def.description, package: pkg.name, cases };
}

// ---------------------------------------------------------------------------
// 篡改与畸形 zip
// ---------------------------------------------------------------------------
function flipByte(buf, at = Math.floor(buf.length / 2)) {
  const out = Buffer.from(buf);
  out[at] ^= 0x01;
  return out;
}

/** 把 manifest 对象按键逆序写出（合法 JSON、值不变，但不是规范字节）。 */
function reorderedJson(v) {
  if (Array.isArray(v)) return `[${v.map(reorderedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().reverse().map((k) => `${JSON.stringify(k)}:${reorderedJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 64 字节 = 86 个 base64url 字符，末字符低 2 位不承载数据：改动它们解码结果不变，但不是规范编码。 */
function nonCanonicalB64u(s) {
  const out = s.slice(0, -1) + ALPHABET[ALPHABET.indexOf(s.at(-1)) ^ 0b01];
  if (!Buffer.from(out, 'base64url').equals(Buffer.from(s, 'base64url'))) throw new Error('非规范签名构造失败');
  return out;
}

/** Ed25519 签名可塑性：S 换成 S+L（L 为基点阶）。RFC 8032 要求验证方拒绝 S ≥ L。 */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
function malleatedSignature(sigB64u) {
  const sig = Buffer.from(sigB64u, 'base64url');
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
  s += ED25519_L;
  if (s >= 1n << 256n) throw new Error('S+L 溢出 32 字节');
  const out = Buffer.from(sig);
  for (let i = 0; i < 32; i++) {
    out[32 + i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return base64url(out);
}

const MANIFEST_EDITS = {
  tenantId: (m) => { m.exportedBy.tenantId = 'tenant-fixturf'; },
  'unknown-field': (m) => { m.exportedAt = '2026-11-17T00:00:00Z'; },
  'two-defaults': (m) => { m.policy.entries[1].default = true; },
  'duplicate-entry-function': (m) => { m.policy.entries.push({ ...m.policy.entries[0], default: false }); },
  'entry-schema-pointer-wrong': (m) => { m.policy.entries[0].inputSchema = '#/$defs/entry.other'; },
  'files-duplicate': (m) => { m.files.splice(1, 0, structuredClone(m.files[0])); },
  'files-unsorted': (m) => { [m.files[0], m.files[1]] = [m.files[1], m.files[0]]; },
  'file-sha256-trailing-newline': (m) => { m.files[0].sha256 += '\n'; },
  'module-name-not-nfc': (m) => { m.policy.moduleName = 'aster.pilot.crédit'; },
  'format-name': (m) => { m.format = 'aster-policy-bundle'; },
  'format-1.1': (m) => { m.formatVersion = '1.1'; },
  'format-1.1-new-field': (m) => { m.formatVersion = '1.1'; m.newOptionalField = true; },
  'format-2.0': (m) => { m.formatVersion = '2.0'; },
  'format-1.00': (m) => { m.formatVersion = '1.00'; },
  'format-01.0': (m) => { m.formatVersion = '01.0'; },
  'format-1.0.0': (m) => { m.formatVersion = '1.0.0'; },
  'format-1': (m) => { m.formatVersion = '1'; },
  'format-1.1-trailing-newline': (m) => { m.formatVersion = '1.1\n'; },
  'format-huge-major': (m) => { m.formatVersion = '99999999999999999999.0'; },
  'format-version-number': (m) => { m.formatVersion = 1; },
  'core-ir-3': (m) => { m.coreIr.version = 3; },
  'position-free-wrong': (m) => { m.coreIr.positionFreeSha256 = sha256Hex(utf8('not the position-free projection')); },
  'core-sha-wrong': (m) => { m.coreIr.sha256 = sha256Hex(utf8('not compiled/core.json')); },
  'source-sha-wrong': (m) => { m.source.sha256 = sha256Hex(utf8('not policy/policy.aster')); },
  'probes-sha-wrong': (m) => { m.tests.probesSha256 = sha256Hex(utf8('not tests/probes.json')); },
  'probes-count-wrong': (m) => { m.tests.probes += 1; },
};

/** manifest 改完后：resign=true 重新签名；否则保留原签名文件（只换 manifest 字节与 SHA256SUMS，使签名成为唯一的错误）。 */
function withManifest(base, manifest, { resign, payload = base.payload, unsigned = false }) {
  if (resign || unsigned) return assemble({ ...base, payload, manifest, manifestBytes: undefined, signed: !unsigned });
  const manifestBytes = utf8(canonicalJson(manifest));
  const files = new Map(base.files);
  files.set('manifest.json', manifestBytes);
  files.set('SHA256SUMS', sha256sums(base.payload, manifestBytes));
  return { ...base, manifest, manifestBytes, files };
}

/** 直接给出 manifest 文件字节；resign=true 时对这些字节本身签名（只让规范字节检查失败）。 */
function withManifestBytes(base, bytes, resign) {
  const files = new Map(base.files);
  files.set('manifest.json', bytes);
  files.set('SHA256SUMS', sha256sums(base.payload, bytes));
  if (resign) files.set('manifest.sig.json', utf8(canonicalJson(signManifest(bytes, TEST_KEY, { issuer: TEST_ISSUER, kid: TEST_KID }))));
  return { ...base, files };
}

function withFiles(base, mutate) {
  const files = new Map(base.files);
  mutate(files);
  return { ...base, files };
}

/** 载荷加一个文件并把它列入 files[]（重新签名），用于「manifest 语义规则」类夹具。 */
function withListedFile(base, path, bytes) {
  const payload = new Map(base.payload);
  payload.set(path, bytes);
  const manifest = structuredClone(base.manifest);
  const paths = [...payload.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
  manifest.files = paths.map((p) => ({ path: p, sha256: sha256Hex(payload.get(p)), size: payload.get(p).length }));
  return assemble({ ...base, payload, manifest, manifestBytes: undefined });
}

const MANIFEST_BYTE_VARIANTS = {
  reordered: (base, text) => utf8(reorderedJson(base.manifest)),
  pretty: (base, text) => utf8(JSON.stringify(JSON.parse(text), null, 2)),
  'trailing-newline': (base, text) => utf8(`${text}\n`),
  'float-version': (base, text) => utf8(text.replace(`"status":"APPROVED","version":${base.manifest.source.claimedRef.version}}`, `"status":"APPROVED","version":${base.manifest.source.claimedRef.version}.0}`)),
  bom: (base, text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text)]),
  'invalid-utf8': (base, text) => {
    const b = utf8(text);
    const at = b.indexOf(utf8('tenant-fixture')) + 'tenant-'.length;
    const out = Buffer.from(b);
    out[at] = 0xff;
    return out;
  },
  'lone-surrogate': (base, text) => utf8(text.replace('"tenant-fixture"', '"tenant-\\ud800"')),
  'duplicate-key': (base, text) => utf8(text.replace('"tenantId":"tenant-fixture"', '"tenantId":"tenant-fixture","tenantId":"tenant-fixture"')),
  'deep-nesting': (base, text) => utf8(text.replace('"tenant-fixture"', `${'['.repeat(10000)}${']'.repeat(10000)}`)),
  oversize: (base, text) => utf8(text.replace('"tenant-fixture"', `"${'x'.repeat(1024 * 1024)}"`)),
  'unsafe-integer': (base, text) => utf8(text.replace(`"status":"APPROVED","version":${base.manifest.source.claimedRef.version}}`, '"status":"APPROVED","version":9007199254740993}')),
};

function malformedZip(base, kind, pkgs) {
  const entries = zipEntries(base, { style: base.def.zipStyle });
  const root = zipRoot(base);
  const readme = base.files.get('README.md');
  const replace = (path, patch) => entries.map((e) => (e.name === `${root}/${path}` ? { ...e, ...patch } : e));
  const sorted = (list) => list.sort((a, b) => Buffer.compare(a.rawName ?? utf8(a.name), b.rawName ?? utf8(b.name)));
  const withRoot = (r) => entries.map((e) => ({ ...e, name: r + e.name.slice(root.length) }));
  switch (kind) {
    case 'garbage':
      return utf8('this is not a zip archive\n');
    case 'empty-zip':
      return writeZip([]);
    case 'dotdot':
      return writeZip([...entries, { name: '../x', data: utf8('x') }]);
    case 'root-dotdot':
      return writeZip([...entries, { name: `${root}/../x`, data: utf8('x') }]);
    case 'dir-entry-dotdot':
      return writeZip([...entries, { name: `${root}/../`, directory: true }]);
    case 'absolute':
      return writeZip([...entries, { name: '/x', data: utf8('x') }]);
    case 'backslash':
      return writeZip([...entries, { name: `${root}/policy\\x`, data: utf8('x') }]);
    case 'two-roots':
      return writeZip([...entries, { name: 'other-root/README.md', data: readme }]);
    case 'root-not-nfc':
      return writeZip(withRoot(root.normalize('NFD') === root ? `${root}é` : root.normalize('NFD')));
    case 'root-control-char':
      return writeZip(withRoot(`${root}\u0001`));
    case 'root-dot':
      return writeZip(withRoot('.'));
    case 'name-invalid-utf8':
      return writeZip([...entries, { name: 'unused', rawName: Buffer.concat([utf8(`${root}/x`), Buffer.from([0xff])]), data: utf8('x') }]);
    case 'duplicate':
      return writeZip([...entries, { name: `${root}/README.md`, data: readme }]);
    case 'bzip2':
      return writeZip(replace('README.md', { rawMethod: 12, compressed: Buffer.concat([utf8('BZh9'), readme]), crc: crc32(readme), declaredUncompressedSize: readme.length }));
    case 'encrypted':
      return writeZip(replace('README.md', { flags: 0x0001 }));
    case 'zip64':
      return writeZip(replace('README.md', { zip64: true }));
    case 'size-mismatch':
      return writeZip(replace('README.md', { method: 8, declaredUncompressedSize: readme.length + 1 }));
    case 'lfh-cd-name-mismatch':
      return writeZip(replace('README.md', { cd: { name: `${root}/READMF.md` } }));
    case 'lfh-cd-size-mismatch':
      return writeZip(replace('README.md', { cd: { uncompressedSize: readme.length + 7 } }));
    case 'lfh-name-wrong':
      // 本地头名字错、中央目录对：只读中央目录的实现（java.util.zip.ZipFile、fflate unzipSync）会照常通过，必须被拒绝
      return writeZip(replace('README.md', { lfh: { name: `${root}/READMF.md` } }));
    case 'lfh-size-wrong':
      return writeZip(replace('README.md', { lfh: { uncompressedSize: readme.length + 7 } }));
    case 'deflate-trailing-bytes':
      // deflate 流的最终块结束后、csize 之内还有多余字节：Node inflateRawSync 静默忽略，java.util.zip 会把它们当作下一个头
      return writeZip(replace('README.md', { method: 8, compressed: Buffer.concat([deflateStored(readme), utf8('JUNK')]) }));
    case 'prepended-bytes':
      return writeZip(entries, { prefix: utf8('#!/bin/sh\nexit 0\n') });
    case 'trailing-bytes':
      return writeZip(entries, { suffix: utf8('trailing') });
    case 'archive-comment':
      return writeZip(entries, { comment: utf8('comment') });
    case 'bomb-single': {
      // 声明 1 KiB、实际解压 1 GiB 的单条目（未列入 files[]）
      const n = 1024 * 1024 * 1024;
      return writeZip([...entries, { name: `${root}/bomb.bin`, rawMethod: 8, compressed: deflateZeros(n), crc: zerosCrc(n), declaredUncompressedSize: 1024 }]);
    }
    case 'bomb-listed': {
      // 列在 files[] 中的 README.md：声明大小等于真实大小，实际解压出 1 GiB 零字节
      const n = 1024 * 1024 * 1024;
      return writeZip(replace('README.md', { method: 8, compressed: deflateZeros(n), crc: crc32(readme), declaredUncompressedSize: readme.length }));
    }
    case 'bomb-many': {
      // 1 000 个各 1 MiB 的条目（每条声明大小与实际相符，累计 1 000 MiB > 64 MiB 上限）
      const n = 1024 * 1024;
      const compressed = deflateZeros(n);
      const crc = zerosCrc(n);
      const bombs = [];
      for (let i = 0; i < 1000; i++) {
        bombs.push({ name: `${root}/bomb/${String(i).padStart(4, '0')}.bin`, rawMethod: 8, compressed, crc, declaredUncompressedSize: n });
      }
      return writeZip([...entries, ...bombs]);
    }
    case 'extra-entry':
      return writeZip(sorted([...entries, { name: `${root}/notes.txt`, data: utf8('extra\n') }]));
    case 'case-collision': {
      const pkg = withListedFile(base, 'readme.md', utf8('lower-case twin of README.md\n'));
      return writeZip(zipEntries(pkg, { style: base.def.zipStyle }));
    }
    case 'windows-reserved-name': {
      const pkg = withListedFile(base, 'con.txt', utf8('reserved on Windows\n'));
      return writeZip(zipEntries(pkg, { style: base.def.zipStyle }));
    }
    default:
      throw new Error(`未知 zip 变换 ${kind}`);
  }
}

const ZERO_MIB = Buffer.alloc(1024 * 1024);
function zerosCrc(n) {
  let crc = 0;
  for (let left = n; left > 0; left -= ZERO_MIB.length) crc = crc32(ZERO_MIB.subarray(0, Math.min(left, ZERO_MIB.length)), crc);
  return crc;
}

const sigFile = (sig) => utf8(canonicalJson(sig));

/**
 * 生成一个篡改夹具：返回 { kind: 'dir', files: Map, links?: Map } | { kind: 'zip', bytes } | { kind: 'none' }。
 * links：路径 → 符号链接目标（相对路径）。
 */
export function buildTamper(t, pkgs) {
  const base = pkgs.get(t.base);
  const dir = (pkg) => ({ kind: 'dir', ...pkg });
  switch (t.kind) {
    case 'none':
      return { kind: 'none' };
    case 'flip-file-byte':
      return dir(withFiles(base, (f) => f.set(t.path, flipByte(f.get(t.path)))));
    case 'remove-file':
      return dir(withFiles(base, (f) => f.delete(t.path)));
    case 'add-file':
      return dir(withFiles(base, (f) => f.set(t.path, utf8('not listed in manifest.files\n'))));
    case 'corrupt-sha256sums':
      return dir(withFiles(base, (f) => f.set('SHA256SUMS', flipByte(f.get('SHA256SUMS'), 0))));
    case 'symlink-file': {
      const r = withFiles(base, (f) => f.delete(t.path));
      // 链接到同一黄金包里的同名文件：字节完全相同，只因是符号链接而必须拒绝
      return { ...dir(r), links: new Map([[t.path, `../../packages/${base.name}/${t.path}`]]) };
    }
    case 'edit-manifest': {
      const manifest = structuredClone(base.manifest);
      MANIFEST_EDITS[t.edit](manifest);
      return dir(withManifest(base, manifest, { resign: t.resign, unsigned: t.unsigned }));
    }
    case 'replace-compiled-core': {
      // A 包：compiled/core.json 换成不是合法 Core IR v2 的字节，files[] 与 coreIr.sha256 同步更新并重新签名，
      // 完整性成立、只在取 IR（严格读入）时失败；positionFreeSha256 保持原值（policy/ 重编译仍一致）。
      const payload = new Map(base.payload);
      const bad = utf8('{"decls":[],"kind":"Module","name":"fixture.decimal"}');
      payload.set('compiled/core.json', bad);
      const manifest = structuredClone(base.manifest);
      manifest.coreIr.sha256 = sha256Hex(bad);
      manifest.files = manifest.files.map((f) => (f.path === 'compiled/core.json' ? { path: f.path, sha256: sha256Hex(bad), size: bad.length } : f));
      return dir(withManifest(base, manifest, { resign: true, payload }));
    }
    case 'manifest-bytes': {
      const text = canonicalJson(base.manifest);
      const bytes = MANIFEST_BYTE_VARIANTS[t.bytes](base, text);
      if (bytes.equals(base.manifestBytes)) throw new Error(`${t.name}: 变换未改变字节`);
      return dir(withManifestBytes(base, bytes, t.resign));
    }
    case 'signature-from':
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', pkgs.get(t.from).files.get('manifest.sig.json'))));
    case 'flip-signature-bit':
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', sigFile({ ...base.sig, sig: base64url(flipByte(Buffer.from(base.sig.sig, 'base64url'), 10)) }))));
    case 'non-canonical-signature':
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', sigFile({ ...base.sig, sig: nonCanonicalB64u(base.sig.sig) }))));
    case 'malleated-signature':
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', sigFile({ ...base.sig, sig: malleatedSignature(base.sig.sig) }))));
    case 'signature-field':
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', sigFile({ ...base.sig, [t.field]: t.value.replace('@SIG@', base.sig.sig) }))));
    case 'signature-bytes': {
      const text = canonicalJson(base.sig);
      const variants = {
        'not-json': () => utf8(text.slice(0, -1)),
        'duplicate-key': () => utf8(text.replace('"alg":"Ed25519"', '"alg":"Ed25519","alg":"Ed25519"')),
        'extra-field': () => utf8(canonicalJson({ ...base.sig, signedAt: '2026-11-17T00:00:00Z' })),
        bom: () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text)]),
      };
      return dir(withFiles(base, (f) => f.set('manifest.sig.json', variants[t.bytes]())));
    }
    case 'resign-kid':
      return dir(assemble({ ...base, manifestBytes: base.manifestBytes }, { kid: t.kid }));
    case 'zip':
      return { kind: 'zip', bytes: malformedZip(base, t.zip, pkgs) };
    default:
      throw new Error(`${t.name}: 未知篡改 ${t.kind}`);
  }
}

/** 篡改夹具的路径（相对 tamper/）。 */
export function tamperTarget(t) {
  if (t.kind === 'zip') return `${t.name}.zip`;
  return t.name;
}

/**
 * 篡改用例：每个夹具 run、verify、inspect 各一条（全部在求值之前失败；ir 阶段的夹具 verify / inspect 照常通过，
 * 另加 verify --recompile 与 verify --probes 两条）。stdin 用 base 第一个成功 run 用例的输入。
 */
export function tamperCases(t, pkgs, exitCodes, built) {
  const base = pkgs.get(t.base);
  // 期望输出一律由**篡改后**的包推导（manifest、文件、签名状态）：目录形态的篡改夹具 buildTamper 返回完整的包视图；
  // zip 与不存在的路径都在 read / manifest 阶段失败，输出不依赖 manifest 内容，退回 base 只为取入口与输入。
  if (!built) throw new Error(`${t.name}: tamperCases 需要 buildTamper 的结果`);
  const pkg = built.kind === 'dir' ? built : base;
  const target = tamperTarget(t);
  const firstRun = base.def.cases.find((c) => c.command === 'run' && typeof c.expect === 'string');
  const failure = { stage: t.stage ?? DEFAULT_STAGE[t.code], code: t.code, failsIn: t.failsIn };
  if (failure.stage === 'ir' && !Array.isArray(t.failsIn)) throw new Error(`${t.name}: ir 阶段的篡改夹具必须用 failsIn 列出在哪些 verify 检查项中失败`);
  const extra = t.args ?? [];
  const anchor = ['--jwks', ANCHOR_JWKS];
  const allowUnsigned = extra.includes('--allow-unsigned');
  const rows = [];
  const push = (name, command, flags, out, stdin) => {
    const row = { name, base: t.base, args: [command, target, ...flags, ...anchor] };
    if (stdin !== undefined) row.stdin = stdin;
    rows.push(Object.assign(row, { expectedStdout: out.stdout, expectedExit: out.exit, code: out.code }));
  };
  const runMetaFor = runMeta(pkg, failure.stage, { entry: entryOf(extra, pkg.def), allowUnsigned });
  push(t.name, 'run', [...extra, '--input', '-'], errorOut(t.code, runMetaFor, exitCodes), inputJson(firstRun.input));
  push(`${t.name} (verify)`, 'verify', extra, verifyOutput(pkg, extra, failure, exitCodes));
  push(`${t.name} (inspect)`, 'inspect', extra, inspectOutput(pkg, extra, failure, exitCodes));
  if (failure.stage === 'ir') {
    push(`${t.name} (verify --recompile)`, 'verify', [...extra, '--recompile'], verifyOutput(pkg, [...extra, '--recompile'], failure, exitCodes));
    push(`${t.name} (verify --probes)`, 'verify', [...extra, '--probes'], verifyOutput(pkg, [...extra, '--probes'], failure, exitCodes));
  }
  return rows;
}

/** inputs-invalid 用例：取得 IR 并选定入口之后失败。 */
export function inputInvalidCase(c, pkgs, exitCodes) {
  const pkg = pkgs.get(c.package);
  const flags = c.args ?? [];
  const entry = entryOf(flags, pkg.def);
  const meta = runMeta(pkg, 'input', { entry, allowUnsigned: false });
  const row = {
    name: c.name,
    args: ['run', `../packages/${c.package}`, ...flags, '--input', c.inputFile ?? '-', '--jwks', ANCHOR_JWKS],
  };
  if (c.stdin !== undefined) row.stdin = c.stdin;
  if (c.stdinB64 !== undefined) row.stdinB64 = c.stdinB64;
  return Object.assign(row, { expectedStdout: errorEnvelope('INPUT_INVALID', meta, exitCodes), expectedExit: exitCodes.INPUT_INVALID.exit, code: 'INPUT_INVALID' });
}

// ---------------------------------------------------------------------------
// 向量
// ---------------------------------------------------------------------------
const NON_BMP_POLICY_ID = 'pol-\u{1F600}-grüße';

/** vectors/signing.json：每条给 manifest 文件字节、签名文件、规范字节与期望结果。 */
export function signingVectors(pkgs) {
  const base = pkgs.get('b-credit-limit');
  const vectors = [];
  const add = (name, description, manifestBytes, sig, valid, code) => {
    let canonicalUtf8B64u = null;
    try {
      canonicalUtf8B64u = base64url(utf8(canonicalJson(JSON.parse(manifestBytes.toString('utf8')))));
    } catch {
      canonicalUtf8B64u = null;
    }
    const sigBytes = Buffer.isBuffer(sig) ? sig : utf8(canonicalJson(sig));
    let sigFile = null;
    try {
      sigFile = JSON.parse(sigBytes.toString('utf8'));
    } catch {
      sigFile = null;
    }
    vectors.push({
      name,
      description,
      manifestFileB64u: base64url(manifestBytes),
      canonicalUtf8B64u,
      sigFileB64u: base64url(sigBytes),
      sigFile,
      valid,
      code,
    });
  };
  const signed = (manifest, kid = TEST_KID) => {
    const bytes = utf8(canonicalJson(manifest));
    return [bytes, signManifest(bytes, TEST_KEY, { issuer: TEST_ISSUER, kid })];
  };
  add('golden', '黄金包 b-credit-limit 的 manifest 与签名。', base.manifestBytes, base.sig, true, null);
  const nonAscii = structuredClone(base.manifest);
  nonAscii.source.claimedRef.policyId = NON_BMP_POLICY_ID;
  nonAscii.exportedBy.tenantId = 'tenant "quoted" \\ back\u0001slash\u007f';
  add('non-ascii-and-escapes', '字符串值含非 BMP 字符、引号、反斜杠、控制字符：被签字节是其 UTF-8 规范 JSON。', ...signed(nonAscii), true, null);
  const multi = pkgs.get('a-multi-entry');
  add('a-package-multi-entry', 'A 包、多个入口的 manifest。', multi.manifestBytes, multi.sig, true, null);
  add('keys-reordered', 'manifest 键逆序写出（值与签名都对应规范形）：文件字节不是规范 JSON → PKG_INVALID_MANIFEST，不验签。', utf8(reorderedJson(base.manifest)), base.sig, false, 'PKG_INVALID_MANIFEST');
  add('trailing-newline', '规范 JSON 后多一个 \\n → PKG_INVALID_MANIFEST。', Buffer.concat([base.manifestBytes, utf8('\n')]), base.sig, false, 'PKG_INVALID_MANIFEST');
  const edited = structuredClone(base.manifest);
  edited.exportedBy.tenantId = 'tenant-fixturf';
  add('one-byte-changed', 'manifest 改一个字节（仍是规范 JSON），沿用原签名 → PKG_SIGNATURE。', utf8(canonicalJson(edited)), base.sig, false, 'PKG_SIGNATURE');
  add('signature-bit-flipped', '签名第 10 字节翻转一位 → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, sig: base64url(flipByte(Buffer.from(base.sig.sig, 'base64url'), 10)) }, false, 'PKG_SIGNATURE');
  const nc = base.sig.sig;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  add('signature-non-canonical-base64url', '签名末字符的 2 个填充位非零：解码结果相同，但不是规范 base64url → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, sig: nc.slice(0, -1) + alphabet[alphabet.indexOf(nc.at(-1)) ^ 1] }, false, 'PKG_SIGNATURE');
  add('kid-not-in-anchor', '同一测试密钥签名，但 kid 不在 keys/test-jwks.json 中 → PKG_UNTRUSTED_KID。', ...signed(base.manifest, UNTRUSTED_KID), false, 'PKG_UNTRUSTED_KID');
  add('alg-wrong', 'manifest.sig.json 的 alg 不是 Ed25519 → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, alg: 'EdDSA' }, false, 'PKG_SIGNATURE');
  const other = pkgs.get('a-decimal');
  add('signature-of-other-manifest', '签名来自另一个包的 manifest → PKG_SIGNATURE。', base.manifestBytes, other.sig, false, 'PKG_SIGNATURE');
  const zh = pkgs.get('b-zh');
  add('non-ascii-identifiers', 'zh-CN 包：模块名与入口函数名为中文（块.遮蔽 / 分支遮蔽）。', zh.manifestBytes, zh.sig, true, null);
  add('signature-malleated-s-plus-l', 'S 换成 S+L（L 为 Ed25519 基点阶）：数学上同一签名的另一编码，RFC 8032 要求拒绝 S ≥ L → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, sig: malleatedSignature(base.sig.sig) }, false, 'PKG_SIGNATURE');
  add('kid-trailing-newline', 'kid 末尾多一个 \\n：schema 模式锚定在输入末尾，ajv 与 Java 都拒绝 → PKG_SIGNATURE（不是 PKG_UNTRUSTED_KID）。', base.manifestBytes, { ...base.sig, kid: `${TEST_KID}\n` }, false, 'PKG_SIGNATURE');
  add('sig-trailing-newline', 'sig 末尾多一个 \\n → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, sig: `${base.sig.sig}\n` }, false, 'PKG_SIGNATURE');
  const sigText = canonicalJson(base.sig);
  add('sig-file-not-json', 'manifest.sig.json 不是 JSON → PKG_SIGNATURE。', base.manifestBytes, utf8(sigText.slice(0, -1)), false, 'PKG_SIGNATURE');
  add('sig-file-duplicate-key', 'manifest.sig.json 有重复键 → PKG_SIGNATURE。', base.manifestBytes, utf8(sigText.replace('"alg":"Ed25519"', '"alg":"Ed25519","alg":"Ed25519"')), false, 'PKG_SIGNATURE');
  add('sig-file-extra-field', 'manifest.sig.json 多一个字段 → PKG_SIGNATURE。', base.manifestBytes, { ...base.sig, signedAt: '2026-11-17T00:00:00Z' }, false, 'PKG_SIGNATURE');
  add('sig-file-bom', 'manifest.sig.json 以 UTF-8 BOM 开头 → PKG_SIGNATURE。', base.manifestBytes, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(sigText)]), false, 'PKG_SIGNATURE');
  add('manifest-bom', 'manifest.json 以 BOM 开头（签名针对这些字节本身）：按字节比较规范形 → PKG_INVALID_MANIFEST。', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), base.manifestBytes]), signManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), base.manifestBytes]), TEST_KEY, { issuer: TEST_ISSUER, kid: TEST_KID }), false, 'PKG_INVALID_MANIFEST');
  return {
    description: '签名向量（ADR 0059 §6.2）。被签字节 = manifest.json 文件字节（manifestFileB64u），且必须逐字节等于其解析结果的规范 JSON 的 UTF-8（canonicalUtf8B64u；文件不是合法 JSON 时为 null）。sigFileB64u 是 manifest.sig.json 的原始字节（sigFile 为其 JSON.parse 结果，仅供阅读，不是严格 JSON 时为 null）。信任锚为 keys/test-jwks.json。检查顺序：manifest 规范字节 → 签名文件严格 JSON（无 BOM、无重复键）→ sig schema 与 base64url 规范编码 → kid 查锚 → Ed25519 验签（拒绝 S ≥ L）；code 为期望错误码（valid=true 时为 null）。',
    trustAnchor: 'keys/test-jwks.json',
    vectors,
  };
}

/** vectors/value-json.json。 */
export function valueJsonVectors(valueTrees) {
  const vectors = valueTrees.map((t) => {
    if (t.error) {
      let threw = false;
      try {
        valueJson(parseValueTree(t.treeJson));
      } catch {
        threw = true;
      }
      if (!threw) throw new Error(`值向量 ${t.name} 应当失败`);
      return { name: t.name, category: t.category, source: t.source, treeJson: t.treeJson, expected: null, error: true };
    }
    return { name: t.name, category: t.category, source: t.source, treeJson: t.treeJson, expected: valueJson(parseValueTree(t.treeJson)) };
  });
  for (const v of depthVectors()) vectors.push(v);
  return {
    description: '值规范 JSON 向量（VALUE-FORMS.md）。treeJson 是值树的 JSON 文本：不含 . e E 的数字 token 是精确整数（不限 2⁵³），其余数字 token 是 IEEE-754 double；source=platform 的 treeJson 为本地 aster-api /evaluate-json 响应中 result 的原文（Jackson 写法、插入序），source=synthetic 为按 Jackson / Java Double.toString 写法构造的边界值。expected 为值规范 JSON；error=true 的向量必须序列化失败（CLI 报 EVAL_ERROR）。randomDoubles：splitmix64 生成的 64 位位模式（大端十六进制），排除 NaN / ±Infinity；randomPlainDoubles：落在普通小数区间的 double（53 位尾数 × 10^k，k ∈ [−9, 22]，以及随机整数之商），覆盖 JVM 侧 Double.toString → ECMAScript 写法重排最容易出错的区间。期望为 ECMAScript Number::toString。',
    vectors,
    randomDoubles: randomDoubles(),
    randomPlainDoubles: randomPlainDoubles(),
  };
}

/** 嵌套层级边界：64 层数组包住一个标量可以，65 层不行；空数组本身算一个值（66 层空数组最深的值在第 65 层）。 */
function depthVectors() {
  const nest = (n, inner) => '['.repeat(n) + inner + ']'.repeat(n);
  const ok = (name, treeJson) => ({ name, category: 'Depth', source: 'synthetic', treeJson, expected: valueJson(parseValueTree(treeJson)) });
  const bad = (name, treeJson) => {
    let threw = false;
    try {
      valueJson(parseValueTree(treeJson));
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`${name} 应当失败`);
    return { name, category: 'Depth', source: 'synthetic', treeJson, expected: null, error: true };
  };
  return [ok('depth-64-arrays-around-scalar', nest(64, '1')), bad('depth-65-arrays-around-scalar', nest(65, '1')), ok('depth-65-empty-arrays', nest(65, '')), bad('depth-66-empty-arrays', nest(66, ''))];
}

const RANDOM_SEED = 0x0059_2026_1117n;
const MASK64 = (1n << 64n) - 1n;

/** splitmix64：确定性、跨语言易复现的 64 位伪随机序列。 */
function* splitmix64(seed) {
  let x = seed & MASK64;
  for (;;) {
    x = (x + 0x9e3779b97f4a7c15n) & MASK64;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    yield z ^ (z >> 31n);
  }
}

function randomDoubles() {
  const items = [];
  const gen = splitmix64(RANDOM_SEED);
  while (items.length < 10000) {
    const bits = gen.next().value.toString(16).padStart(16, '0');
    const x = doubleFromBits(bits);
    if (!Number.isFinite(x)) continue;
    if (bitsOfDouble(x) !== bits) throw new Error('位模式往返失败');
    items.push({ bits, expected: String(x) });
  }
  return { generator: 'splitmix64', seed: `0x${RANDOM_SEED.toString(16)}`, count: items.length, items };
}

const PLAIN_SEED = 0x0059_2026_1118n;

/**
 * 普通小数区间的 double：一半为 m × 10^k / m ÷ 10^−k（m 为 53 位随机整数，k ∈ [−9, 22]；10 的幂在此范围内都精确，
 * 乘除各一次正确舍入），一半为随机整数之商 a ÷ b（a < 10^9，0 < b < 10^6）。只记录位模式，两侧不必复现生成算法。
 */
function randomPlainDoubles() {
  const items = [];
  const gen = splitmix64(PLAIN_SEED);
  const next = () => gen.next().value;
  while (items.length < 10000) {
    let x;
    if (items.length % 2 === 0) {
      const m = Number(next() & ((1n << 53n) - 1n));
      const k = Number(next() % 32n) - 9;
      x = k >= 0 ? m * 10 ** k : m / 10 ** -k;
    } else {
      const a = Number(next() % 1_000_000_000n);
      const b = Number(next() % 999_999n) + 1;
      x = a / b;
    }
    if (next() & 1n) x = -x;
    if (!Number.isFinite(x)) continue;
    items.push({ bits: bitsOfDouble(x), expected: String(x) });
  }
  return { generator: 'splitmix64 + 10^k scaling / integer quotients', seed: `0x${PLAIN_SEED.toString(16)}`, count: items.length, items };
}

/** vectors/position-free-hash.json。 */
export function positionFreeVectors(pkgs, tsCoreByName) {
  const vectors = [];
  for (const name of ['b-credit-limit', 'a-decimal', 'b-vocab-de']) {
    const p = pkgs.get(name);
    vectors.push({ name: `${name}/platform`, source: 'aster-api InProcessCnlParser + CoreIrJson.serialize', coreJson: p.def.platformCore, sha256: p.manifest.coreIr.sha256, positionFreeSha256: p.manifest.coreIr.positionFreeSha256 });
  }
  for (const [name, tsCore] of tsCoreByName) {
    const p = pkgs.get(name);
    if (tsCore === p.def.platformCore) throw new Error(`${name}: ts IR 与平台 IR 逐字节相同，不能作为「只差 col」的向量`);
    vectors.push({ name: `${name}/platform`, source: 'aster-api InProcessCnlParser.parseWithUserAliases + CoreIrJson.serialize', coreJson: p.def.platformCore, sha256: p.manifest.coreIr.sha256, positionFreeSha256: p.manifest.coreIr.positionFreeSha256 });
    vectors.push({ name: `${name}/ts`, source: 'aster-lang-ts compile（叠加 aliasSet 的 lexicon）.coreJson；与上一条只差 origin.*.col', coreJson: tsCore, sha256: sha256Hex(utf8(tsCore)), positionFreeSha256: positionFreeSha256(tsCore) });
  }
  return {
    description: 'coreIr.positionFreeSha256 向量（ADR 0059 修订 1 A2）：sha256 = coreJson UTF-8 字节的 SHA-256；positionFreeSha256 = 严格读入后只删除每个 origin 的 start.col 与 end.col，再规范 JSON 序列化后的 SHA-256。成对的 */platform 与 */ts 两条 sha256 不同、positionFreeSha256 相同。',
    vectors,
  };
}

/** vectors/stdout-normalize.json（修订 A0）。 */
export function stdoutNormalizeVectors(pkgs, exitCodes) {
  const ok = '{"meta":{"cliVersion":"3.3.0","coreIrSha256":"' + pkgs.get('a-decimal').manifest.coreIr.sha256 + '","engine":"aster-lang-ts-interpreter","entry":"withTax","irRecompiled":false,"signed":true},"ok":true,"value":"10.82"}\n';
  const errMeta = { cliVersion: '1.0.49', coreIrSha256: null, engine: 'aster-lang-truffle', entry: null, irRecompiled: false, signed: false };
  const v = [];
  const add = (name, stdout, expected) => v.push({ name, stdout, expected });
  add('run-ok', ok, ok.replace('"3.3.0"', '"<CLI_VERSION>"').replace('"aster-lang-ts-interpreter"', '"<ENGINE>"'));
  const err = errorEnvelope('PKG_INTEGRITY', errMeta, exitCodes);
  add('run-error-entry-null', err, err.replace('"1.0.49"', '"<CLI_VERSION>"').replace('"aster-lang-truffle"', '"<ENGINE>"'));
  const tricky = `${canonicalJson({ error: { code: 'EVAL_ERROR', message: 'engine "aster-lang-truffle" cliVersion "1.0.49"' }, meta: errMeta, ok: false })}\n`;
  add('message-contains-engine-and-version', tricky, tricky.replace('"cliVersion":"1.0.49"', '"cliVersion":"<CLI_VERSION>"').replace('"engine":"aster-lang-truffle"', '"engine":"<ENGINE>"'));
  const nested = '{"meta":{"cliVersion":"3.3.0","coreIrSha256":null,"engine":"aster-lang-ts-interpreter","entry":"f","irRecompiled":true,"signed":true},"ok":true,"value":{"meta":{"cliVersion":"x","engine":"y"}}}\n';
  add('value-contains-meta', nested, nested.replace('"cliVersion":"3.3.0"', '"cliVersion":"<CLI_VERSION>"').replace('"engine":"aster-lang-ts-interpreter"', '"engine":"<ENGINE>"'));
  const verify = '{"checks":[{"name":"schema","ok":true}],"meta":{"cliVersion":"1.0.49","coreIrSha256":null,"engine":"aster-lang-truffle","entry":null,"irRecompiled":false,"signed":false},"ok":true}\n';
  add('verify', verify, verify.replace('"1.0.49"', '"<CLI_VERSION>"').replace('"aster-lang-truffle"', '"<ENGINE>"'));
  const escaped = '{"meta":{"cliVersion":"3.3.0-\\u0062eta","engine":"aster-lang-ts-interpreter"},"ok":true,"value":1}\n';
  add('escaped-string-value', escaped, '{"meta":{"cliVersion":"<CLI_VERSION>","engine":"<ENGINE>"},"ok":true,"value":1}\n');
  const version = '{"cliVersion":"3.3.0","coreIrVersions":[2],"engine":"aster-lang-ts-interpreter","formatVersions":["1.0"],"toolchainId":"t","trustAnchorKids":[]}\n';
  add('version-unchanged', version, version);
  add('no-trailing-newline', ok.slice(0, -1), ok.slice(0, -1).replace('"3.3.0"', '"<CLI_VERSION>"').replace('"aster-lang-ts-interpreter"', '"<ENGINE>"'));
  add('engine-not-a-string', '{"meta":{"cliVersion":1,"engine":null},"ok":true}\n', '{"meta":{"cliVersion":1,"engine":null},"ok":true}\n');
  add('not-json', 'Exception in thread "main"\n', 'Exception in thread "main"\n');
  add('empty', '', '');
  return {
    description: 'stdout 归一向量（ADR 0059 修订 1 A0；规则见 normalize-stdout.mjs 文件头）。只替换顶层 meta 的 engine / cliVersion 的字符串值；其余字节（含 message 里的同名文字、value 里的 meta、转义写法）不动；不是 JSON 对象时原样返回。',
    vectors: v,
  };
}

/** keys/：测试密钥文件。 */
export function keyFiles() {
  const priv = TEST_KEY.privateKey.export({ format: 'jwk' }).d;
  const pub = base64url(TEST_KEY.publicRaw);
  const jwks = { keys: [{ alg: 'EdDSA', crv: 'Ed25519', kid: TEST_KID, kty: 'OKP', use: 'sig', x: pub }] };
  return new Map([
    ['keys/test-ed25519.priv.b64u', utf8(`${priv}\n`)],
    ['keys/test-ed25519.pub.b64u', utf8(`${pub}\n`)],
    ['keys/test-jwks.json', jsonFile(jwks)],
  ]);
}

export { jsonFile };

/**
 * anchors/：信任锚夹具（相对 packages/ 为 ../anchors/）。合法：单个 JWK（带 / 不带 kid）。非法（一律 USAGE）：
 * JWKS 重复 kid、crv 不是 Ed25519、x 不是 32 字节、alg 不是 EdDSA、不是 JSON；原始公钥文件带 = 填充、CRLF 行尾、31 字节。
 */
export function anchorFiles() {
  const x = base64url(TEST_KEY.publicRaw);
  const jwk = { alg: 'EdDSA', crv: 'Ed25519', kid: TEST_KID, kty: 'OKP', use: 'sig', x };
  const { kid: _omit, ...noKid } = jwk;
  return new Map([
    ['anchors/test-pub.jwk.json', jsonFile(jwk)],
    ['anchors/test-pub-no-kid.jwk.json', jsonFile(noKid)],
    ['anchors/jwks-duplicate-kid.json', jsonFile({ keys: [jwk, jwk] })],
    ['anchors/jwks-wrong-curve.json', jsonFile({ keys: [{ ...jwk, crv: 'X25519' }] })],
    ['anchors/jwks-short-x.json', jsonFile({ keys: [{ ...jwk, x: base64url(TEST_KEY.publicRaw.subarray(0, 31)) }] })],
    ['anchors/jwks-wrong-alg.json', jsonFile({ keys: [{ ...jwk, alg: 'ES256' }] })],
    ['anchors/jwks-not-json.json', utf8('{"keys":[\n')],
    ['anchors/pub-padded.b64u', utf8(`${Buffer.from(TEST_KEY.publicRaw).toString('base64')}\n`)],
    ['anchors/pub-crlf.b64u', utf8(`${x}\r\n`)],
    ['anchors/pub-31-bytes.b64u', utf8(`${base64url(TEST_KEY.publicRaw.subarray(0, 31))}\n`)],
  ]);
}

/** 包的另两种路径形态：名字以 .zip 结尾的目录（按目录读）、没有 .zip 扩展名的 zip 文件（按 zip 读）。 */
export function extraForms(pkg) {
  const out = new Map();
  if (pkg.name !== 'b-credit-limit') return out;
  for (const [p, bytes] of pkg.files) out.set(`packages/${pkg.name}-dir.zip/${p}`, bytes);
  out.set(`packages/${pkg.name}-zip-no-extension`, writeZipOf(pkg));
  return out;
}

/**
 * tamper/test-time.json：体积类夹具不入库（几十 MiB），由各 CLI 的测试按 recipe 在临时目录里生成后运行。
 * recipe：copyPackage 复制黄金包目录后按 add 写入指定大小的零字节文件（不列入 files[]）；copyZip 复制 zip 后追加 appendZeros 个零字节（必须在读入之前按文件大小拒绝）；或按 stdinRecipe 生成超大输入。
 */
export function testTimeCases(pkgs, exitCodes) {
  const base = pkgs.get('b-credit-limit');
  const firstRun = base.def.cases.find((c) => c.command === 'run' && typeof c.expect === 'string');
  const pkgFail = (name, add) => ({
    name,
    recipe: { copyPackage: 'packages/b-credit-limit', add },
    args: ['run', '<PKG>', '--input', '-', '--jwks', '<PACKAGE_V1>/keys/test-jwks.json'],
    stdin: inputJson(firstRun.input),
    expectedStdout: errorEnvelope('PKG_INTEGRITY', runMeta(base, 'read', { entry: null, allowUnsigned: false }), exitCodes),
    expectedExit: exitCodes.PKG_INTEGRITY.exit,
    code: 'PKG_INTEGRITY',
  });
  const MiB = 1024 * 1024;
  return {
    description: '运行时生成的体积类夹具（README「体积上限」）。<PKG> 为按 recipe 生成的包目录，<PACKAGE_V1> 为 conformance/package-v1 的绝对路径。add：[{path, size}] 写入 size 个零字节；stdinRecipe：prefix + padding 个空格 + suffix。',
    cases: [
      pkgFail('dir-single-file-over-64MiB', [{ path: 'big.bin', size: 64 * MiB + 1 }]),
      pkgFail('dir-cumulative-over-64MiB', [{ path: 'a.bin', size: 40 * MiB }, { path: 'b.bin', size: 40 * MiB }]),
      {
        name: 'zip-file-over-64MiB',
        recipe: { copyZip: 'packages/b-credit-limit.zip', appendZeros: 64 * MiB },
        args: ['run', '<PKG>', '--input', '-', '--jwks', '<PACKAGE_V1>/keys/test-jwks.json'],
        stdin: inputJson(firstRun.input),
        expectedStdout: errorEnvelope('PKG_INTEGRITY', runMeta(base, 'read', { entry: null, allowUnsigned: false }), exitCodes),
        expectedExit: exitCodes.PKG_INTEGRITY.exit,
        code: 'PKG_INTEGRITY',
      },
      {
        name: 'input-over-16MiB',
        recipe: { usePackage: 'packages/b-credit-limit' },
        args: ['run', '<PACKAGE_V1>/packages/b-credit-limit', '--input', '-', '--jwks', '<PACKAGE_V1>/keys/test-jwks.json'],
        stdinRecipe: { prefix: '{"applicant":', padding: 16 * MiB, suffix: `${inputJson(firstRun.input.applicant)}}` },
        expectedStdout: errorEnvelope('INPUT_INVALID', runMeta(base, 'input', { entry: defaultEntry(base.def), allowUnsigned: false }), exitCodes),
        expectedExit: exitCodes.INPUT_INVALID.exit,
        code: 'INPUT_INVALID',
      },
    ],
  };
}
