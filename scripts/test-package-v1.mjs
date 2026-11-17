#!/usr/bin/env node
/**
 * 包格式 v1 真相源工具（scripts/lib/package-v1/*、conformance/package-v1/normalize-stdout.mjs）的回归测试
 * （无框架，纯 node:assert；ADR 0059 P1 T1）。
 *
 * ★为什么必须有：`build-package-fixtures.mjs --check` 只证明「仓内字节 = 生成器输出」，证明不了生成器本身对：
 * 规范 JSON 排序错了、zip 头字段写错了、手写 deflate 比特流错了，`--check` 照样全绿，错误会被两个 CLI 当作
 * 规范继承下去。这里用独立的判据（RFC 8785 例子、`zlib.inflateRawSync`、系统 `unzip` 无关的逐字段解析）钉住它们。
 *
 * 用法：node scripts/test-package-v1.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, CanonicalError, isCanonicalJsonBytes } from './lib/package-v1/canonical.mjs';
import { parseValueTree, valueJson, doubleFromBits, ValueJsonError } from './lib/package-v1/value-json.mjs';
import { deflateStored, deflateZeros, writeZip, readZipHeaders, crc32 } from './lib/package-v1/zip.mjs';
import { positionFreeTree, positionFreeSha256 } from './lib/package-v1/position-free.mjs';
import { keyPairFromSeed, signManifest, base64url } from './lib/package-v1/signing.mjs';
import { normalizeStdout } from '../conformance/package-v1/normalize-stdout.mjs';
import { parseStrictJson, StrictJsonError } from './lib/package-v1/strict-json.mjs';
import { validateInput, InputError } from './lib/package-v1/input.mjs';
import { isPackagePath, isSafeRoot } from './lib/package-v1/reference-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`✗ ${name}\n    ${err.stack ?? err.message}`);
  }
}

// ---- canonical.mjs：manifest / IR 用的规范 JSON（ADR 0055 §5；manifest 域内与 RFC 8785 相同） ----

check('canonical: 键按码点升序、无空白、null 显式输出', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: [true, null, 'x'], A: {} }), '{"A":{},"a":[true,null,"x"],"b":1}');
});

check('canonical: 码点序而非 UTF-16 码元序（非 BMP 字符排在 U+FFFF 之后）', () => {
  // U+1F600 的 UTF-16 首码元 0xD83D < 0xFFFD，按码元序会排在前面；按码点序 0x1F600 > 0xFFFD。
  assert.strictEqual(canonicalJson({ '\u{1F600}': 1, '\uFFFD': 2 }), '{"\uFFFD":2,"\u{1F600}":1}');
});

check('canonical: 字符串转义与 JSON.stringify 相同（RFC 8785 §3.2.2.2）', () => {
  assert.strictEqual(canonicalJson('a"\\\b\f\n\r\t\u0001\u007f/€'), '"a\\"\\\\\\b\\f\\n\\r\\t\\u0001\u007f/€"');
});

check('canonical: 拒绝非整数、超安全整数、NaN、孤立代理项', () => {
  for (const bad of [1.5, 2 ** 53, Number.NaN, '\uD800', { a: undefined }, 10n]) {
    assert.throws(() => canonicalJson(bad), CanonicalError, `应拒绝 ${String(bad)}`);
  }
  assert.strictEqual(canonicalJson(-0), '0');
  assert.strictEqual(canonicalJson(Number.MAX_SAFE_INTEGER), '9007199254740991');
});

check('canonical: isCanonicalJsonBytes 按字节识别键重排、空白、末尾换行、重复键、BOM、非法 UTF-8、孤立代理项', () => {
  const B = (s) => Buffer.from(s, 'utf8');
  assert.strictEqual(isCanonicalJsonBytes(B('{"a":1,"b":"é"}')), true);
  for (const bad of [
    B('{"b":2,"a":1}'), B('{"a":1, "b":2}'), B('{"a":1,"b":2}\n'), B('{"a":1,"a":1}'), B('not json'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B('{"a":1}')]), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    B('{"a":"\\ud800"}'), B('{"a":1.0}'),
  ]) assert.strictEqual(isCanonicalJsonBytes(bad), false, bad.toString('hex'));
});

// ---- value-json.mjs：值规范 JSON（ADR 0059 修订 1 A1） ----

const vj = (text) => valueJson(parseValueTree(text));

check('value-json: Double 按 ECMAScript Number::toString（RFC 8785 §3.2.2.3）', () => {
  const cases = [
    ['3.5', '3.5'],
    ['0.3333333333333333', '0.3333333333333333'],
    ['1.4285714285714284E14', '142857142857142.84'],
    ['1e21', '1e+21'],
    ['1.0E21', '1e+21'],
    ['1e-7', '1e-7'],
    ['1.0E-7', '1e-7'],
    ['5e-324', '5e-324'],
    ['4.9E-324', '5e-324'],
    ['-0.0', '0'],
    ['3.0', '3'],
    ['1.0E20', '100000000000000000000'],
    ['0.000001', '0.000001'],
  ];
  for (const [input, expected] of cases) assert.strictEqual(vj(input), expected, input);
});

check('value-json: 整数（含 Long，不限 2⁵³）输出精确十进制', () => {
  assert.strictEqual(vj('9007199254740993'), '9007199254740993');
  assert.strictEqual(vj('-9223372036854775808'), '-9223372036854775808');
  assert.strictEqual(vj('12000000000000000'), '12000000000000000');
  assert.strictEqual(vj('-0'), '0');
});

check('value-json: 对象键按码点升序、数组保序、无空白；插入序的 Jackson 输出被重排', () => {
  assert.strictEqual(
    vj('{"z":1, "b":[2,1], "__type":"Verdict", "outcome":"allow"}'),
    '{"__type":"Verdict","b":[2,1],"outcome":"allow","z":1}',
  );
  assert.strictEqual(vj('{"\u{1F600}":1,"\uFFFD":2}'), '{"\uFFFD":2,"\u{1F600}":1}');
});

check('value-json: 字符串、布尔、null', () => {
  assert.strictEqual(vj('"15.41"'), '"15.41"');
  assert.strictEqual(vj('[true,false,null]'), '[true,false,null]');
  assert.strictEqual(vj('"\\u0001\\u2028"'), '"\\u0001\u2028"');
});

check('value-json: 位模式构造 double（随机向量用）', () => {
  assert.strictEqual(String(doubleFromBits('400c000000000000')), '3.5');
  assert.strictEqual(Object.is(doubleFromBits('8000000000000000'), -0), true);
  assert.strictEqual(String(doubleFromBits('0000000000000001')), '5e-324');
});

check('value-json: NaN / Infinity 无法出现，序列化即报错', () => {
  assert.throws(() => valueJson(Number.POSITIVE_INFINITY), ValueJsonError);
  assert.throws(() => valueJson(Number.NaN), ValueJsonError);
  assert.throws(() => parseValueTree('1e400'), ValueJsonError);
});

// ---- position-free.mjs：coreIr.positionFreeSha256（修订 A2） ----

check('position-free: 只删 origin.start.col / origin.end.col，保留 line 与其他 col 字段', () => {
  const tree = {
    kind: 'Module',
    col: 7,
    origin: { start: { line: 1, col: 1 }, end: { line: 3, col: 9 }, file: null },
    decls: [{ origin: { start: { line: 2, col: 4 }, end: { line: 2, col: 5 } }, name: 'col' }],
  };
  assert.deepStrictEqual(positionFreeTree(tree), {
    kind: 'Module',
    col: 7,
    origin: { start: { line: 1 }, end: { line: 3 }, file: null },
    decls: [{ origin: { start: { line: 2 }, end: { line: 2 } }, name: 'col' }],
  });
  assert.strictEqual(tree.origin.start.col, 1, '不得修改入参');
});

check('position-free: 只差 col 的两份 IR 投影哈希相同，精确哈希不同', () => {
  const a = '{"origin":{"end":{"col":1,"line":2},"start":{"col":1,"line":1}}}';
  const b = '{"origin":{"end":{"col":6,"line":2},"start":{"col":1,"line":1}}}';
  assert.strictEqual(positionFreeSha256(a), positionFreeSha256(b));
  assert.notStrictEqual(positionFreeSha256(a), positionFreeSha256('{"origin":{"end":{"col":1,"line":3},"start":{"col":1,"line":1}}}'));
});

check('position-free: col 缺失或为 null 时失败（严格读入）', () => {
  assert.throws(() => positionFreeSha256('{"origin":{"end":{"line":2},"start":{"col":1,"line":1}}}'));
  assert.throws(() => positionFreeSha256('{"origin":{"end":{"col":null,"line":2},"start":{"col":1,"line":1}}}'));
});

// ---- zip.mjs：确定性 zip 与手写 deflate ----

check('zip: deflateStored 与 deflateZeros 均可被 zlib 还原', () => {
  const data = Buffer.from('hello, 包格式\n'.repeat(5000));
  assert.deepStrictEqual(inflateRawSync(deflateStored(data)), data);
  for (const n of [1, 2, 3, 258, 259, 1000, 70_000]) {
    const out = inflateRawSync(deflateZeros(n));
    assert.strictEqual(out.length, n, `zeros(${n})`);
    assert.ok(out.every((b) => b === 0));
  }
});

check('zip: deflateZeros 压缩比 > 1000（解压炸弹夹具的前提）', () => {
  const n = 64 * 1024 * 1024;
  const z = deflateZeros(n);
  assert.ok(n / z.length > 1000, `ratio ${n / z.length}`);
  assert.strictEqual(inflateRawSync(z).length, n);
});

check('zip: crc32 与已知值一致', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.alloc(0)), 0);
});

check('zip: 同一输入两次写出逐字节相同；头字段可逐项读回', () => {
  const entries = [
    { name: 'r/', directory: true },
    { name: 'r/a.txt', data: Buffer.from('aaa') },
    { name: 'r/b.txt', data: Buffer.from('bbbb'), method: 8 },
  ];
  const z1 = writeZip(entries);
  const z2 = writeZip(entries);
  assert.deepStrictEqual(z1, z2);
  const headers = readZipHeaders(z1);
  assert.deepStrictEqual(headers.map((h) => [h.name, h.method, h.uncompressedSize, h.dosTime, h.dosDate]), [
    ['r/', 0, 0, 0, 0x21],
    ['r/a.txt', 0, 3, 0, 0x21],
    ['r/b.txt', 8, 4, 0, 0x21],
  ]);
  assert.strictEqual(headers[1].crc, crc32(Buffer.from('aaa')));
  assert.deepStrictEqual(inflateRawSync(headers[2].compressed), Buffer.from('bbbb'));
});

check('zip: 畸形参数原样写入头部（声明大小、方法号、重复条目）', () => {
  const z = writeZip([
    { name: 'x', data: Buffer.from('12345'), method: 8, declaredUncompressedSize: 1 },
    { name: 'x', data: Buffer.from('12345') },
    { name: 'y', rawMethod: 12, compressed: Buffer.from('BZh9'), declaredUncompressedSize: 4, crc: 0 },
  ]);
  const h = readZipHeaders(z);
  assert.deepStrictEqual(h.map((e) => [e.name, e.method, e.uncompressedSize]), [['x', 8, 1], ['x', 0, 5], ['y', 12, 4]]);
});

check('zip: 黄金包的 zip 形态与目录形态逐文件相同（单一根目录、目录条目、deflate 存储块）', () => {
  const dir = join(ROOT, 'conformance/package-v1/packages/b-credit-limit');
  const headers = readZipHeaders(readFileSync(`${dir}.zip`));
  const files = headers.filter((h) => !h.name.endsWith('/'));
  const roots = new Set(headers.map((h) => h.name.split('/')[0]));
  assert.deepStrictEqual([...roots], ['aster.pilot.credit-v3-jre-b']);
  assert.ok(headers.some((h) => h.name.endsWith('/')), '应含目录条目');
  assert.ok(files.some((h) => h.method === 8), '应含 deflate 条目');
  for (const h of files) {
    const rel = h.name.slice(h.name.indexOf('/') + 1);
    const data = h.method === 8 ? inflateRawSync(h.compressed) : h.compressed;
    assert.deepStrictEqual(data, readFileSync(join(dir, rel)), rel);
    assert.strictEqual(h.crc, crc32(data), `${rel} crc`);
  }
  const onDisk = readdirSync(dir, { recursive: true }).filter((p) => !statSync(join(dir, p)).isDirectory());
  assert.strictEqual(files.length, onDisk.length);
});

// ---- signing.mjs：Ed25519，被签字节 = manifest 文件字节 ----

check('signing: 由种子派生密钥、签名确定性、base64url 无填充', () => {
  const seed = Buffer.alloc(32, 7);
  const kp = keyPairFromSeed(seed);
  assert.strictEqual(kp.publicRaw.length, 32);
  const bytes = Buffer.from('{"a":1}');
  const s1 = signManifest(bytes, kp, { issuer: 'i', kid: 'k' });
  const s2 = signManifest(bytes, kp, { issuer: 'i', kid: 'k' });
  assert.deepStrictEqual(s1, s2);
  assert.match(s1.sig, /^[A-Za-z0-9_-]{86}$/);
  assert.strictEqual(Buffer.from(s1.sig, 'base64url').length, 64);
  assert.strictEqual(base64url(Buffer.from([0xfb, 0xff])), '-_8');
});

// ---- normalize-stdout.mjs：修订 A0 ----

check('normalize-stdout: 只替换顶层 meta 的 engine / cliVersion 字符串值，其余字节不动', () => {
  const s = '{"meta":{"cliVersion":"3.3.0","coreIrSha256":null,"engine":"aster-lang-ts-interpreter","entry":null,"irRecompiled":false,"signed":false},"ok":true,"value":{"meta":{"engine":"x"}}}\n';
  assert.strictEqual(
    normalizeStdout(s),
    '{"meta":{"cliVersion":"<CLI_VERSION>","coreIrSha256":null,"engine":"<ENGINE>","entry":null,"irRecompiled":false,"signed":false},"ok":true,"value":{"meta":{"engine":"x"}}}\n',
  );
});

check('normalize-stdout: 非 JSON、无 meta、meta 非对象、值非字符串时原样返回', () => {
  for (const s of ['', 'boom\n', '{"cliVersion":"1","engine":"e"}\n', '{"meta":"x"}\n', '{"meta":{"engine":1}}\n', '[1]\n']) {
    assert.strictEqual(normalizeStdout(s), s);
  }
});

check('normalize-stdout: 共享向量全部通过', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'conformance/package-v1/vectors/stdout-normalize.json'), 'utf8'));
  assert.ok(doc.vectors.length >= 4);
  for (const v of doc.vectors) assert.strictEqual(normalizeStdout(v.stdout), v.expected, v.name);
});


// ---- strict-json.mjs：manifest / 签名文件 / probes / --input 共用的严格 JSON ----

check('strict-json: 拒绝 BOM、非法 UTF-8、尾随内容、重复键、孤立代理项、超深嵌套、溢出、未转义控制字符', () => {
  const bad = [
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    Buffer.from([0x22, 0xff, 0x22]),
    Buffer.from('{"a":1} {"b":2}'),
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from('"\\ud800"'),
    Buffer.from(`${'['.repeat(65)}${']'.repeat(65)}`),
    Buffer.from('1e400'),
    Buffer.from('"a\u0001b"'),
    Buffer.from(''),
    Buffer.from('{"a":01}'),
  ];
  for (const b of bad) assert.throws(() => parseStrictJson(b), StrictJsonError, b.toString('hex'));
});

check('strict-json: 接受前后空白；lossless 时整数 token 为 BigInt，小数 token 为 double', () => {
  assert.deepStrictEqual(parseStrictJson(Buffer.from(' {"x": [1, 2.5, "\\u00e9"]}\n'), { lossless: true }), { x: [1n, 2.5, 'é'] });
  assert.strictEqual(parseStrictJson(Buffer.from('9007199254740993'), { lossless: true }), 9007199254740993n);
  assert.doesNotThrow(() => parseStrictJson(Buffer.from(`${'['.repeat(64)}${']'.repeat(64)}`)));
});

// ---- input.mjs：--input 规则 ----

const IR = {
  decls: [
    { kind: 'Enum', name: 'Tier', variants: ['Gold', 'Silver'] },
    { kind: 'Func', name: 'f', params: [
      { name: 'i', type: { kind: 'TypeName', name: 'Int' } },
      { name: 'l', type: { kind: 'TypeName', name: 'Long' } },
      { name: 'd', type: { kind: 'TypeName', name: 'Decimal' } },
      { name: 'm', type: { kind: 'Maybe', type: { kind: 'TypeName', name: 'Tier' } } },
    ] },
  ],
};
const inp = (o) => Buffer.from(o);

check('input: 合法输入通过（Long 字符串、Decimal 字符串、Maybe null、Enum 变体名）', () => {
  validateInput(inp('{"i":2147483647,"l":"-9223372036854775808","d":"1.50","m":null}'), IR, 'f');
  validateInput(inp('{"i":-2147483648,"l":9007199254740991,"d":"0","m":"Gold"}'), IR, 'f');
});

check('input: int32 / int64 / 2⁵³ / Decimal 80 位 / 整数形态 / Enum / 键集合', () => {
  const bad = [
    '{"i":2147483648,"l":1,"d":"1","m":null}',
    '{"i":7.0,"l":1,"d":"1","m":null}',
    '{"i":1,"l":"9223372036854775808","d":"1","m":null}',
    '{"i":1,"l":9007199254740992,"d":"1","m":null}',
    `{"i":1,"l":1,"d":"${'9'.repeat(81)}","m":null}`,
    '{"i":1,"l":1,"d":1,"m":null}',
    '{"i":1,"l":1,"d":"1","m":"Bronze"}',
    '{"i":1,"l":1,"d":"1"}',
    '{"i":1,"l":1,"d":"1","m":null,"x":0}',
  ];
  for (const b of bad) assert.throws(() => validateInput(inp(b), IR, 'f'), InputError, b);
  assert.doesNotThrow(() => validateInput(inp(`{"i":1,"l":1,"d":"${'9'.repeat(80)}","m":null}`), IR, 'f'));
});

// ---- reference-check.mjs：路径与 zip 根规则 ----

check('reference: 包路径（ASCII 段、无 . / .. 段）与 zip 根（NFC、无分隔符与控制字符）', () => {
  for (const ok of ['README.md', 'policy/compile/alias-set.json', 'a.b-c_d']) assert.ok(isPackagePath(ok), ok);
  for (const bad of ['', '/x', 'x/', '../x', 'a/./b', 'a\\b', 'é.txt', 'a//b']) assert.ok(!isPackagePath(bad), bad);
  for (const ok of ['块.遮蔽-v1-node-b', 'aster.pilot.credit-v3-jre-b', 'ü']) assert.ok(isSafeRoot(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\u0001', 'a\u0085', 'u\u0308']) assert.ok(!isSafeRoot(bad), JSON.stringify(bad));
});

check('zip: ZipOutputStream 风格（数据描述符 + UTF-8 标志）可被 zlib 还原、本地头大小为 0', () => {
  const z = writeZip([{ name: '根/a.txt', data: Buffer.from('hello'), method: 8, descriptor: true, utf8: true }]);
  const [h] = readZipHeaders(z);
  assert.strictEqual(h.flags, 0x0808);
  assert.strictEqual(z.readUInt32LE(18), 0, '本地头 compressed size');
  assert.deepStrictEqual(inflateRawSync(h.compressed), Buffer.from('hello'));
});

check('value-json: 嵌套层级上限 64（与 ts SERIALIZE_MAX_DEPTH 相同）', () => {
  const nest = (n, inner) => '['.repeat(n) + inner + ']'.repeat(n);
  assert.doesNotThrow(() => vj(nest(64, '1')));
  assert.throws(() => vj(nest(65, '1')), ValueJsonError);
  assert.doesNotThrow(() => vj(nest(65, '')));
  assert.throws(() => vj(nest(66, '')), ValueJsonError);
  assert.throws(() => vj('"\\ud800"'), ValueJsonError);
});

check('长字符串（N1）：1 200 万字符的字符串值，严格 JSON、--input 校验与 stdout 归一都正常工作（不依赖会回溯溢栈的正则）', () => {
  const big = 'a'.repeat(12_000_000);
  const escaped = `${'\\"'.repeat(1_000_000)}${big}`;
  assert.strictEqual(parseStrictJson(Buffer.from(`{"s":"${big}"}`)).s.length, 12_000_000);
  assert.strictEqual(parseStrictJson(Buffer.from(`"${escaped}"`)).length, 13_000_000);
  const textIr = { decls: [{ kind: 'Func', name: 'echo', params: [{ name: 's', type: { kind: 'TypeName', name: 'Text' } }] }] };
  assert.strictEqual(validateInput(Buffer.from(`{"s":"${big}"}`), textIr, 'echo').s.length, 12_000_000);
  const stdout = `{"meta":{"cliVersion":"3.3.0","coreIrSha256":null,"engine":"aster-lang-ts-interpreter","entry":"echo","irRecompiled":false,"signed":true},"ok":true,"value":"${big}"}\n`;
  const want = stdout.replace('"3.3.0"', '"<CLI_VERSION>"').replace('"aster-lang-ts-interpreter"', '"<ENGINE>"');
  assert.ok(normalizeStdout(stdout) === want, '归一结果不对');
});

// ---- https 信任锚（README「信任锚」；tamper/test-time.json 的 https-jwks-* 配方）：本地自签名 https 服务，离线 ----
async function httpsAnchorTests() {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const https = await import('node:https');
  const { fetchJwks, Usage } = await import('./lib/package-v1/argv.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pkgv1-https-'));
  try {
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]);
    if (gen.status !== 0) {
      console.error(`(跳过 https 锚测试：openssl 不可用 ${gen.stderr})`);
      return;
    }
    const doc = JSON.parse(readFileSync(join(ROOT, 'conformance/package-v1/tamper/test-time.json'), 'utf8'));
    const routes = doc.cases.find((c) => c.name === 'https-jwks-trusted-via-test-ca').recipe.httpsServer.routes;
    const jwks = readFileSync(join(ROOT, 'conformance/package-v1/keys/test-jwks.json'));
    let port;
    const server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
      const r = routes[req.url];
      if (!r) return res.writeHead(404).end();
      if (r.location) return res.writeHead(r.status, { location: r.location.replace('<PORT>', port) }).end();
      if (r.contentEncoding === 'gzip') return res.writeHead(r.status, { 'content-encoding': 'gzip' }).end(gzipSync(jwks));
      if (r.contentEncodingHeader) return res.writeHead(r.status, { 'content-encoding': r.contentEncodingHeader }).end(jwks);
      if (r.file) return res.writeHead(r.status).end(jwks);
      if (r.zeros) return res.writeHead(r.status).end(Buffer.alloc(r.zeros, 0x20));
      if (r.jwksPaddedTo) return res.writeHead(r.status).end(Buffer.concat([jwks, Buffer.alloc(r.jwksPaddedTo - jwks.length, 0x20)]));
      return res.writeHead(r.status).end(r.body ?? '');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    port = server.address().port;
    const extraCa = readFileSync(join(dir, 'cert.pem'), 'utf8');
    // 与配方一致：代理变量指向不通的地址，参照实现必须照常直连
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) process.env[k] = 'http://127.0.0.1:9';
    const tt = JSON.parse(readFileSync(join(ROOT, 'conformance/package-v1/tamper/test-time.json'), 'utf8')).cases.filter((c) => c.recipe?.httpsServer);
    for (const c of tt) {
      const path = c.args.at(-1).replace('https://localhost:<PORT>', '');
      const withCa = c.recipe.env.ASTER_ANCHOR_CA_FILE !== undefined;
      try {
        const got = await fetchJwks(`https://localhost:${port}${path}`, withCa ? { extraCa } : {});
        if (c.code === null && Array.isArray(got.keys)) pass++;
        else {
          fail++;
          console.error(`✗ https: ${c.name} 应失败（USAGE）却成功`);
        }
      } catch (e) {
        if (c.code === 'USAGE' && e instanceof Usage) pass++;
        else {
          fail++;
          console.error(`✗ https: ${c.name}：${e.message}`);
        }
      }
    }
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
await httpsAnchorTests();

// ---- RFC 3986 §5.2 引用解析（README「信任锚」重定向 Location）：§5.4 的正常与异常例子 ----
{
  const { resolveReference, Usage } = await import('./lib/package-v1/argv.mjs');
  const base = 'http://a/b/c/d;p?q';
  const normal = {
    'g:h': 'g:h', g: 'http://a/b/c/g', './g': 'http://a/b/c/g', 'g/': 'http://a/b/c/g/', '/g': 'http://a/g', '//g': 'http://g', '?y': 'http://a/b/c/d;p?y',
    'g?y': 'http://a/b/c/g?y', '#s': 'http://a/b/c/d;p?q#s', 'g#s': 'http://a/b/c/g#s', 'g?y#s': 'http://a/b/c/g?y#s', ';x': 'http://a/b/c/;x', 'g;x': 'http://a/b/c/g;x',
    'g;x?y#s': 'http://a/b/c/g;x?y#s', '.': 'http://a/b/c/', './': 'http://a/b/c/', '..': 'http://a/b/', '../': 'http://a/b/', '../g': 'http://a/b/g', '../..': 'http://a/',
    '../../': 'http://a/', '../../g': 'http://a/g',
  };
  const abnormal = {
    '../../../g': 'http://a/g', '../../../../g': 'http://a/g', '/./g': 'http://a/g', '/../g': 'http://a/g', 'g.': 'http://a/b/c/g.', '.g': 'http://a/b/c/.g', 'g..': 'http://a/b/c/g..',
    '..g': 'http://a/b/c/..g', './../g': 'http://a/b/g', './g/.': 'http://a/b/c/g/', 'g/./h': 'http://a/b/c/g/h', 'g/../h': 'http://a/b/c/h', 'g;x=1/./y': 'http://a/b/c/g;x=1/y',
    'g;x=1/../y': 'http://a/b/c/y', 'g?y/./x': 'http://a/b/c/g?y/./x', 'g?y/../x': 'http://a/b/c/g?y/../x', 'g#s/./x': 'http://a/b/c/g#s/./x', 'g#s/../x': 'http://a/b/c/g#s/../x',
  };
  for (const [ref, want] of Object.entries({ ...normal, ...abnormal })) {
    try {
      assert.strictEqual(resolveReference(base, ref), want, ref);
      pass++;
    } catch (e) {
      fail++;
      console.error(`✗ RFC 3986 ${ref}: ${e.message}`);
    }
  }
  const more = [['https://h/a/b', '?q', 'https://h/a/b?q'], ['https://h/a/b', '../../x', 'https://h/x'], ['https://h/a/b', 'HTTPS://h2/y', 'https://h2/y']];
  for (const [b, ref, want] of more) {
    try {
      assert.strictEqual(resolveReference(b, ref), want, ref);
      pass++;
    } catch (e) {
      fail++;
      console.error(`✗ RFC 3986 ${ref}: ${e.message}`);
    }
  }
  for (const bad of ['', '/jw ks.json', '\\jwks.json', '/a\\b', '/a\u0001b', '/café', '/a%zz', '/a%2']) {
    try {
      resolveReference('https://h/a/b', bad);
      fail++;
      console.error(`✗ RFC 3986 应拒绝 ${JSON.stringify(bad)}`);
    } catch (e) {
      if (e instanceof Usage) pass++;
      else {
        fail++;
        console.error(`✗ RFC 3986 ${JSON.stringify(bad)} 抛了非 Usage：${e.message}`);
      }
    }
  }
}

console.log(`test-package-v1: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
