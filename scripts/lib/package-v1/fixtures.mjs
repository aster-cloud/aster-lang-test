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
import { writeZip, deflateZeros, crc32 } from './zip.mjs';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (s) => Buffer.from(s, 'utf8');
const jsonFile = (v) => utf8(`${JSON.stringify(v, null, 2)}\n`);

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
const PRIMITIVE_INPUT = {
  Int: { type: 'integer', minimum: -SAFE, maximum: SAFE },
  Long: { type: ['integer', 'string'], minimum: -SAFE, maximum: SAFE, pattern: '^-?(0|[1-9][0-9]*)$' },
  Double: { type: 'number' },
  Decimal: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
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

function dataDecls(ir) {
  return new Map(ir.decls.filter((d) => d.kind === 'Data').map((d) => [d.name, d]));
}

function typeSchema(type, datas, defs, direction) {
  if (type.kind !== 'TypeName') throw new Error(`夹具生成器只支持 TypeName 类型，得到 ${type.kind}`);
  if (direction === 'input' && PRIMITIVE_INPUT[type.name]) return PRIMITIVE_INPUT[type.name];
  if (direction === 'output') {
    if (type.name === 'Verdict') return VERDICT_OUTPUT;
    if (type.name === 'Decimal') return { type: 'string' };
    if (type.name === 'Long' || type.name === 'Int') return { type: 'integer' };
    if (PRIMITIVE_INPUT[type.name]) return { type: PRIMITIVE_INPUT[type.name].type };
  }
  const data = datas.get(type.name);
  if (!data) throw new Error(`未知类型 ${type.name}`);
  const key = `data.${type.name}`;
  if (!defs[key]) {
    defs[key] = {}; // 先占位，防递归类型无限展开
    const properties = {};
    for (const f of data.fields) properties[f.name] = typeSchema(f.type, datas, defs, direction);
    defs[key] = direction === 'input'
      ? { type: 'object', properties, required: data.fields.map((f) => f.name), additionalProperties: false }
      : { type: 'object', properties: { __type: { const: type.name }, ...properties }, required: ['__type', ...data.fields.map((f) => f.name)], additionalProperties: false };
  }
  return { $ref: `#/$defs/${key}` };
}

export function entrySchemas(ir, entries) {
  const datas = dataDecls(ir);
  const input = {};
  const output = {};
  for (const { function: fn } of entries) {
    const func = ir.decls.find((d) => d.kind === 'Func' && d.name === fn);
    if (!func) throw new Error(`入口 ${fn} 不在 IR 中`);
    const properties = {};
    for (const p of func.params) properties[p.name] = typeSchema(p.type, datas, input, 'input');
    input[`entry.${fn}`] = { type: 'object', properties, required: func.params.map((p) => p.name), additionalProperties: false };
    output[`entry.${fn}`] = typeSchema(func.ret, datas, output, 'output');
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
    if (!exp || exp.value === undefined) throw new Error(`${def.name}: probes[${i}] 缺少采集的期望值（先跑 --capture）`);
    let value = exp.value;
    if (def.corruptProbe && def.corruptProbe.index === i) value = valueJson(def.corruptProbe.value);
    return `{"entry":${canonicalJson(p.entry)},"expected":{"ok":true,"value":${value}},"input":${canonicalJson(p.input)}}`;
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

/** 包的 zip 形态（packages/<name>.zip）。 */
export const writeZipOf = (pkg) => writeZip(zipEntries(pkg));

/** 包 → zip 条目（含目录条目，验证读取方忽略目录条目；policy.aster 用 deflate 存储块，其余存储）。 */
export function zipEntries(pkg, root = zipRoot(pkg)) {
  const paths = [...pkg.files.keys()].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
  const dirs = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const entries = [{ name: `${root}/`, directory: true }];
  for (const d of [...dirs].sort()) entries.push({ name: `${root}/${d}/`, directory: true });
  for (const p of paths) entries.push({ name: `${root}/${p}`, data: pkg.files.get(p), method: p === 'policy/policy.aster' ? 8 : 0 });
  return entries.sort((a, b) => Buffer.compare(utf8(a.name), utf8(b.name)));
}

// ---------------------------------------------------------------------------
// cases.json
// ---------------------------------------------------------------------------
function anchorArgs(anchor) {
  if (anchor === 'none') return [];
  if (anchor === 'pubkey') return ['--pubkey', ANCHOR_PUBKEY];
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

function verifyCase(pkg, c, exitCodes) {
  const flags = c.args ?? [];
  const allowUnsigned = flags.includes('--allow-unsigned');
  const checks = [{ name: 'schema', ok: true }];
  const meta = (integrityPassed, recompiled) => ({
    cliVersion: '<CLI_VERSION>',
    coreIrSha256: integrityPassed ? pkg.manifest.coreIr.sha256 : null,
    engine: '<ENGINE>',
    entry: integrityPassed ? defaultEntry(pkg.def) : null,
    irRecompiled: recompiled,
    signed: pkg.signed,
  });
  const fail = (name, code, integrityPassed, recompiled) => {
    checks.push({ code, name, ok: false });
    return { stdout: `${canonicalJson({ checks, meta: meta(integrityPassed, recompiled), ok: false })}\n`, exit: exitCodes[code].exit, code };
  };
  if (!pkg.signed && !allowUnsigned) return fail('signature', 'PKG_UNSIGNED', false, false);
  checks.push({ name: 'signature', ok: true }, { name: 'integrity', ok: true });
  let recompiled = false;
  if (flags.includes('--recompile')) {
    checks.push({ name: 'recompile', ok: true });
    recompiled = true;
  }
  if (flags.includes('--probes')) {
    if (pkg.def.corruptProbe) return fail('probes', 'PROBE_MISMATCH', true, recompiled);
    checks.push({ name: 'probes', ok: true });
  }
  return { stdout: `${canonicalJson({ checks, meta: meta(true, recompiled), ok: true })}\n`, exit: 0, code: null };
}

function inspectCase(pkg) {
  const m = pkg.manifest;
  const meta = runMeta(pkg, 'done', { entry: defaultEntry(pkg.def), allowUnsigned: false });
  meta.irRecompiled = false;
  const inspect = { effects: m.effects, governance: m.governance, policy: m.policy, runtime: m.runtime, tests: m.tests };
  return { stdout: `${canonicalJson({ inspect, meta, ok: true })}\n`, exit: 0, code: null };
}

function runCase(pkg, c, defs, exitCodes) {
  const flags = c.args ?? [];
  const entryIdx = flags.indexOf('--entry');
  const entry = entryIdx >= 0 ? flags[entryIdx + 1] : defaultEntry(pkg.def);
  const allowUnsigned = flags.includes('--allow-unsigned');
  if (typeof c.expect === 'object') {
    const { code } = c.expect;
    const stage = c.expect.stage ?? DEFAULT_STAGE[code];
    return { stdout: errorEnvelope(code, runMeta(pkg, stage, { entry, allowUnsigned }), exitCodes), exit: exitCodes[code].exit, code };
  }
  const value = expectedValue(pkg.def, c, defs);
  return { stdout: okEnvelope(runMeta(pkg, 'done', { entry, allowUnsigned }), value), exit: 0, code: null };
}

/** 一个黄金包的 cases.json 内容。 */
export function packageCases(pkg, defs, exitCodes) {
  const cases = [];
  for (const c of pkg.def.cases) {
    const target = c.package === 'zip' ? `${pkg.name}.zip` : pkg.name;
    const args = [c.command, target, ...(c.args ?? [])];
    let out;
    if (c.command === 'run') {
      args.push('--input', '-');
      out = runCase(pkg, c, defs, exitCodes);
    } else if (c.command === 'verify') {
      out = verifyCase(pkg, c, exitCodes);
    } else if (c.command === 'inspect') {
      out = inspectCase(pkg);
    } else {
      throw new Error(`${pkg.name}/${c.name}: 未知命令 ${c.command}`);
    }
    args.push(...anchorArgs(c.anchor));
    const row = { name: c.name, args };
    if (c.command === 'run') row.stdin = canonicalJson(c.input);
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

const MANIFEST_EDITS = {
  tenantId: (m) => { m.exportedBy.tenantId = 'tenant-fixturf'; },
  'unknown-field': (m) => { m.exportedAt = '2026-11-17T00:00:00Z'; },
  'two-defaults': (m) => { m.policy.entries[1].default = true; },
  'format-name': (m) => { m.format = 'aster-policy-bundle'; },
  'format-1.1': (m) => { m.formatVersion = '1.1'; },
  'format-1.1-new-field': (m) => { m.formatVersion = '1.1'; m.newOptionalField = true; },
  'format-2.0': (m) => { m.formatVersion = '2.0'; },
  'core-ir-3': (m) => { m.coreIr.version = 3; },
  'position-free-wrong': (m) => { m.coreIr.positionFreeSha256 = sha256Hex(utf8('not the position-free projection')); },
  'core-sha-wrong': (m) => { m.coreIr.sha256 = sha256Hex(utf8('not compiled/core.json')); },
};

function editedManifest(base, edit, resign) {
  const manifest = structuredClone(base.manifest);
  MANIFEST_EDITS[edit](manifest);
  const manifestBytes = utf8(canonicalJson(manifest));
  if (resign) return assemble({ ...base, manifest, manifestBytes: undefined });
  // 不重签：保留原签名文件，只换 manifest 字节（SHA256SUMS 随之更新，使签名成为唯一的错误）。
  const files = new Map(base.files);
  files.set('manifest.json', manifestBytes);
  files.set('SHA256SUMS', sha256sums(base.payload, manifestBytes));
  return { ...base, manifest, manifestBytes, files };
}

function withFiles(base, mutate) {
  const files = new Map(base.files);
  mutate(files);
  return { ...base, files };
}

function malformedZip(base, kind) {
  const entries = zipEntries(base);
  const root = zipRoot(base);
  const readme = base.files.get('README.md');
  const replace = (path, patch) => entries.map((e) => (e.name === `${root}/${path}` ? { ...e, ...patch } : e));
  switch (kind) {
    case 'garbage':
      return utf8('this is not a zip archive\n');
    case 'dotdot':
      return writeZip([...entries, { name: '../x', data: utf8('x') }]);
    case 'root-dotdot':
      return writeZip([...entries, { name: `${root}/../x`, data: utf8('x') }]);
    case 'absolute':
      return writeZip([...entries, { name: '/x', data: utf8('x') }]);
    case 'backslash':
      return writeZip([...entries, { name: `${root}/policy\\x`, data: utf8('x') }]);
    case 'two-roots':
      return writeZip([...entries, { name: 'other-root/README.md', data: readme }]);
    case 'duplicate':
      return writeZip([...entries, { name: `${root}/README.md`, data: readme }]);
    case 'bzip2':
      return writeZip(replace('README.md', { rawMethod: 12, compressed: Buffer.concat([utf8('BZh9'), readme]), crc: crc32(readme), declaredUncompressedSize: readme.length }));
    case 'size-mismatch':
      return writeZip(replace('README.md', { method: 8, declaredUncompressedSize: readme.length + 1 }));
    case 'bomb-single': {
      // 声明 1 KiB、实际解压 1 GiB 的单条目
      const n = 1024 * 1024 * 1024;
      return writeZip([...entries, { name: `${root}/bomb.bin`, rawMethod: 8, compressed: deflateZeros(n), crc: zerosCrc(n), declaredUncompressedSize: 1024 }]);
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
      return writeZip([...entries, { name: `${root}/notes.txt`, data: utf8('extra\n') }].sort((a, b) => Buffer.compare(utf8(a.name), utf8(b.name))));
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

/**
 * 生成一个篡改夹具：返回 { kind: 'dir', files: Map, links: Map } 或 { kind: 'zip', bytes }。
 * links：路径 → 符号链接目标（相对路径）。
 */
export function buildTamper(t, pkgs) {
  const base = pkgs.get(t.base);
  switch (t.kind) {
    case 'flip-file-byte':
      return { kind: 'dir', ...withFiles(base, (f) => f.set(t.path, flipByte(f.get(t.path)))) };
    case 'remove-file':
      return { kind: 'dir', ...withFiles(base, (f) => f.delete(t.path)) };
    case 'add-file':
      return { kind: 'dir', ...withFiles(base, (f) => f.set(t.path, utf8('not listed in manifest.files\n'))) };
    case 'corrupt-sha256sums':
      return { kind: 'dir', ...withFiles(base, (f) => f.set('SHA256SUMS', flipByte(f.get('SHA256SUMS'), 0))) };
    case 'symlink-file': {
      const r = withFiles(base, (f) => f.delete(t.path));
      // 链接到同一黄金包里的同名文件：字节完全相同，只因是符号链接而必须拒绝
      return { kind: 'dir', ...r, links: new Map([[t.path, `../../packages/${base.name}/${t.path}`]]) };
    }
    case 'edit-manifest':
      return { kind: 'dir', ...editedManifest(base, t.edit, t.resign) };
    case 'signature-from': {
      const other = pkgs.get(t.from);
      return { kind: 'dir', ...withFiles(base, (f) => f.set('manifest.sig.json', other.files.get('manifest.sig.json'))) };
    }
    case 'flip-signature-bit': {
      const sig = { ...base.sig, sig: base64url(flipByte(Buffer.from(base.sig.sig, 'base64url'), 10)) };
      return { kind: 'dir', ...withFiles(base, (f) => f.set('manifest.sig.json', utf8(canonicalJson(sig))) ) };
    }
    case 'non-canonical-signature': {
      // 64 字节 = 86 个 base64url 字符，末字符低 2 位不承载数据：改动它们解码结果不变，但不是规范编码
      const s = base.sig.sig;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const last = alphabet.indexOf(s.at(-1));
      const sig = { ...base.sig, sig: s.slice(0, -1) + alphabet[last ^ 0b01] };
      if (!Buffer.from(sig.sig, 'base64url').equals(Buffer.from(s, 'base64url'))) throw new Error('非规范签名构造失败');
      return { kind: 'dir', ...withFiles(base, (f) => f.set('manifest.sig.json', utf8(canonicalJson(sig)))) };
    }
    case 'signature-field': {
      const sig = { ...base.sig, [t.field]: t.value };
      return { kind: 'dir', ...withFiles(base, (f) => f.set('manifest.sig.json', utf8(canonicalJson(sig)))) };
    }
    case 'resign-kid':
      return { kind: 'dir', ...assemble({ ...base, manifestBytes: base.manifestBytes }, { kid: t.kid }) };
    case 'manifest-bytes': {
      const text = canonicalJson(base.manifest);
      const variants = {
        reordered: () => reorderedJson(base.manifest),
        pretty: () => JSON.stringify(JSON.parse(text), null, 2),
        'trailing-newline': () => `${text}\n`,
        'float-version': () => text.replace(`"status":"APPROVED","version":${base.manifest.source.claimedRef.version}}`, `"status":"APPROVED","version":${base.manifest.source.claimedRef.version}.0}`),
      };
      const bytes = utf8(variants[t.bytes]());
      if (bytes.equals(base.manifestBytes)) throw new Error(`${t.name}: 变换未改变字节`);
      return { kind: 'dir', ...withFiles(base, (f) => f.set('manifest.json', bytes)) };
    }
    case 'zip':
      return { kind: 'zip', bytes: malformedZip(base, t.zip) };
    default:
      throw new Error(`${t.name}: 未知篡改 ${t.kind}`);
  }
}

/** 篡改用例：一律 run，stdin 用 base 第一个 run 用例的输入；都在求值前失败。 */
export function tamperCase(t, pkgs, exitCodes) {
  const base = pkgs.get(t.base);
  const target = t.kind === 'zip' ? `${t.name}.zip` : t.name;
  const firstRun = base.def.cases.find((c) => c.command === 'run' && typeof c.expect === 'string');
  const stage = t.stage ?? DEFAULT_STAGE[t.code];
  const meta = runMeta(base, stage, { entry: defaultEntry(base.def), allowUnsigned: false });
  return {
    name: t.name,
    base: t.base,
    args: ['run', target, '--input', '-', '--jwks', ANCHOR_JWKS],
    stdin: canonicalJson(firstRun.input),
    expectedStdout: errorEnvelope(t.code, meta, exitCodes),
    expectedExit: exitCodes[t.code].exit,
    code: t.code,
  };
}

/** inputs-invalid 用例：取得 IR 并选定入口之后失败。 */
export function inputInvalidCase(c, pkgs, exitCodes) {
  const pkg = pkgs.get(c.package);
  const flags = c.args ?? [];
  const entryIdx = flags.indexOf('--entry');
  const entry = entryIdx >= 0 ? flags[entryIdx + 1] : defaultEntry(pkg.def);
  const meta = runMeta(pkg, 'input', { entry, allowUnsigned: false });
  const row = {
    name: c.name,
    args: ['run', `../packages/${c.package}`, ...flags, '--input', c.inputFile ?? '-', '--jwks', ANCHOR_JWKS],
  };
  if (c.inputFile === undefined) row.stdin = c.stdin;
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
    vectors.push({
      name,
      description,
      manifestFileB64u: base64url(manifestBytes),
      canonicalUtf8B64u,
      sigFile: sig,
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
  return {
    description: '签名向量（ADR 0059 §6.2）。被签字节 = manifest.json 文件字节（manifestFileB64u），且必须等于其解析结果的规范 JSON（canonicalUtf8B64u；文件不是合法 JSON 时为 null）。sigFile 是 manifest.sig.json 的内容。信任锚为 keys/test-jwks.json。检查顺序：规范字节 → sig 文件 schema → kid 查锚 → Ed25519 验签；code 为期望错误码（valid=true 时为 null）。',
    trustAnchor: 'keys/test-jwks.json',
    vectors,
  };
}

/** vectors/value-json.json。 */
export function valueJsonVectors(valueTrees) {
  const vectors = valueTrees.map((t) => ({
    name: t.name,
    category: t.category,
    source: t.source,
    treeJson: t.treeJson,
    expected: valueJson(parseValueTree(t.treeJson)),
  }));
  return {
    description: '值规范 JSON 向量（VALUE-FORMS.md）。treeJson 是值树的 JSON 文本：不含 . e E 的数字 token 是精确整数（不限 2⁵³），其余数字 token 是 IEEE-754 double；source=platform 的 treeJson 为本地 aster-api /evaluate-json 响应中 result 的原文（Jackson 写法、插入序），source=synthetic 为按 Jackson / Java Double.toString 写法构造的边界值。expected 为值规范 JSON。randomDoubles：以 splitmix64（seed 见下）生成 64 位位模式（大端十六进制），排除 NaN / ±Infinity，期望为 ECMAScript Number::toString。',
    vectors,
    randomDoubles: randomDoubles(),
  };
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
