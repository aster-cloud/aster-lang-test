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
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);

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
      if (req.url === '/trickle') {
        // 只给单测：头立即返回，之后每 100 ms 一字节——空闲超时永远不触发，只有总时限能截住
        res.writeHead(200);
        const iv = setInterval(() => res.write(' '), 100);
        res.on('close', () => clearInterval(iv));
        return undefined;
      }
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
    // 总时限（不是套接字空闲超时）：细水长流的响应体在总时限到点时必须失败
    {
      const t0 = Date.now();
      try {
        await fetchJwks(`https://localhost:${port}/trickle`, { extraCa, timeoutMs: 600 });
        fail++;
        console.error('✗ https: 总时限未生效（trickle 成功了）');
      } catch (e) {
        const took = Date.now() - t0;
        if (e instanceof Usage && took < 2000) pass++;
        else {
          fail++;
          console.error(`✗ https: 总时限 ${took} ms：${e.message}`);
        }
      }
    }
    server.closeAllConnections?.();
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

// ---- 重定向目标在发出请求之前的合法性（README「信任锚」N-1） ----
{
  const { validateRequestTarget, Usage } = await import('./lib/package-v1/argv.mjs');
  for (const ok of ['https://h/x', 'https://h:1/x', 'https://h:65535/x', 'https://[::1]:8443/x', 'https://[v1.fe]/x', 'https://h', 'https://h/x?q#f']) {
    try {
      validateRequestTarget(ok);
      pass++;
    } catch (e) {
      fail++;
      console.error(`✗ 重定向目标应接受 ${ok}：${e.message}`);
    }
  }
  for (const bad of ['https:///x', 'https://:443/x', 'https://h:0/x', 'https://h:65536/x', 'https://h:/x', 'https://h:8a/x', 'https://u:p@h/x', 'https://u@h/x', 'https://@h/x', 'https://h/a[b]', 'https://h/x?a]', 'https://h[::1]/x', 'https://[::1/x', 'https://a:b:443/x', 'https://h::443/x', 'https://a:b/x']) {
    try {
      validateRequestTarget(bad);
      fail++;
      console.error(`✗ 重定向目标应拒绝 ${bad}`);
    } catch (e) {
      if (e instanceof Usage) pass++;
      else {
        fail++;
        console.error(`✗ ${bad} 抛了非 Usage：${e.message}`);
      }
    }
  }
}

// ---- 跨 CLI 一致性门的判定（package-conformance.mjs，T11 评审 G-1 / G-2 / G-3） ----
{
  const { coverageProblems, judgeRow, groupRouteSets, routeSetKey } = await import('./lib/package-v1/gate.mjs');
  const check = (cond, msg) => (cond ? pass++ : (fail++, console.error(`✗ ${msg}`)));
  // G-1：零用例或少跑都是失败
  check(coverageProblems({ expected: 0, ran: 0, filter: 'no-such-case' }).length === 1, '--filter 零匹配应失败');
  check(coverageProblems({ expected: 0, ran: 0 }).length === 1, '无 --filter 时零用例应失败');
  check(coverageProblems({ expected: 554, ran: 553 }).length === 1, '少跑一条应失败');
  check(coverageProblems({ expected: 554, ran: 554 }).length === 0, '全部跑完应通过');
  {
    const { timingSummary } = await import('./lib/package-v1/gate.mjs');
    const rows = [
      { name: 'a', status: 'ok', node: 100, jre: 300 },
      { name: 'b', status: 'fail', node: 70_000, jre: 400 },
      { name: 'c', status: 'ok', node: 200, jre: 500 },
      { name: 'd', status: 'ok', node: 300, jre: 200 },
    ];
    const t = timingSummary(rows, { timeoutMs: 120_000, top: 2 });
    check(t.sides.node.median === 200 && t.sides.node.max === 70_000 && t.sides.jre.p95 === 500, '耗时：每侧中位数 / p95 / 最大值（#226 m-3）');
    check(t.slowest.map((r) => r.name).join() === 'b,c', '耗时：最慢的行按两侧较大耗时降序');
    check(t.slow.join() === 'b', '耗时：达到超时一半的行被标出');
    check(timingSummary([], { timeoutMs: 1 }).sides.jre.median === null, '耗时：无用例时为 null');
  }
  check(coverageProblems({ expected: 1, ran: 1, filter: 'x' }).length === 0, '--filter 至少一条匹配应通过');

  const ok = { res: { exit: 0, stdout: '{"ok":true}\n' }, problems: [], comparable: 'A' };
  const tsDiverges = { res: { exit: 4, stdout: '{"ok":false}\n' }, problems: ['退出码 4，期望 0'], comparable: 'B' };
  const crashed = { res: { exit: 'signal SIGKILL', stdout: '' }, problems: ['退出码 signal SIGKILL，期望 0'], comparable: 'C' };
  const missing = { res: { exit: 1, stdout: '' }, problems: ['退出码 1，期望 0'], comparable: 'D' };
  const spawnFail = { res: { exit: 'spawn error ENOENT', stdout: '' }, problems: ['x'], comparable: 'E' };
  const plain = { c: { name: 'p' } };
  const marked = { c: { name: 'm', knownEngineDivergence: 'aster-cloud/aster-lang-ts#348', knownDivergentEngine: 'node' } };
  const st = (row, node, jre) => judgeRow(row, { node, jre }).status;
  check(st(plain, ok, ok) === 'ok', '无标记、两侧一致等于期望 → ok');
  check(st(plain, tsDiverges, ok) === 'fail', '无标记、一侧不符 → fail');
  check(st(plain, { ...ok, comparable: 'Z' }, ok) === 'fail', '无标记、两侧不一致 → fail');
  // G-2
  check(st(marked, tsDiverges, ok) === 'known', '标记、node 分歧且正常退出、jre 等于期望 → known');
  check(st(marked, tsDiverges, tsDiverges) === 'fail', '标记、未标分歧的 jre 不符 → fail');
  check(st(marked, crashed, ok) === 'fail', '标记、node 被信号杀掉 → fail');
  check(st(marked, missing, ok) === 'fail', '标记、node 脚本不存在（退出 1、stdout 空） → fail');
  check(st(marked, spawnFail, spawnFail) === 'fail', '标记、两侧都起不来 → fail');
  check(st(marked, crashed, crashed) === 'fail', '标记、两侧都崩 → fail');
  const stale = judgeRow(marked, { node: ok, jre: ok });
  check(stale.status === 'fail' && stale.reasons.some((r) => r.startsWith('stale knownEngineDivergence: remove marker')), '标记、分歧已消失 → stale 失败');
  check(st({ c: { name: 'n', knownEngineDivergence: 'x#1' } }, tsDiverges, ok) === 'fail', '标记缺 knownDivergentEngine → fail');
  check(st({ c: { ...marked.c, knownDivergentEngine: 'jre' } }, ok, tsDiverges) === 'known', '标 jre 分歧时对称');
  // G-3：不同 routes 的配方各自成组，相同的合并
  const r1 = { '/a': { status: 200 } };
  const rows = [
    { c: { recipe: { httpsServer: { routes: r1 } } } },
    { c: { recipe: { httpsServer: { routes: { '/a': { status: 200 } } } } } },
    { c: { recipe: { httpsServer: { routes: { '/b': { status: 302 } } } } } },
    { c: { recipe: {} } },
  ];
  const groups = groupRouteSets(rows);
  check(groups.size === 2, `两种 routes 应分成 2 组，得到 ${groups.size}`);
  check(groups.get(routeSetKey(r1)) === r1, '组内取到声明的 routes');
  check(routeSetKey({ '/b': 1, '/a': 2 }) === routeSetKey({ '/a': 2, '/b': 1 }), 'routes 键序不影响分组');
}

// ---- 初始 --jwks URL 在 usage 阶段校验（README「信任锚」V-1） ----
{
  const { parseCommand } = await import('./lib/package-v1/argv.mjs');
  const cwd = join(ROOT, 'conformance/package-v1/packages');
  const run = (url) => parseCommand(['run', 'b-credit-limit', '--input', '-', '--jwks', url], cwd);
  for (const ok of ['https://localhost:1/jwks.json', 'https://[::1]:8443/x?q=1#f', 'https://h/%5B', 'https://h']) {
    const r = run(ok);
    if (!r.usage) pass++;
    else (fail++, console.error(`✗ 初始 URL 应接受 ${ok}：${r.why}`));
  }
  for (const bad of ['https://localhost:1/é', 'https://localhost:1/a b', 'https://localhost:1/%zz', 'https://localhost:1/\\x', 'https://a:b:443/x', 'https://h::443/x', 'https://u@localhost:1/x', 'https://h:/x', 'https://h:0/x', 'https:///x', 'https://h/a[b]', 'https://localhost:1/x\u0001']) {
    const r = run(bad);
    if (r.usage) pass++;
    else (fail++, console.error(`✗ 初始 URL 应在 usage 阶段拒绝 ${JSON.stringify(bad)}`));
  }
}


// ---- 包格式 1.1 显示排版（ADR 0059 修订 4；display.mjs 参照实现 × 四组共享向量） ----
{
  const D = await import('./lib/package-v1/display.mjs');
  const { displayVectors } = await import('./lib/package-v1/display-vectors.mjs');
  const { formatGate } = await import('./lib/package-v1/gate.mjs');
  const { readDisplayFile, parseCommand } = await import('./lib/package-v1/argv.mjs');
  const vectors = displayVectors();
  const onDisk = (rel) => JSON.parse(readFileSync(join(ROOT, 'conformance/package-v1', rel), 'utf8'));
  for (const rel of Object.keys(vectors)) {
    check(`display: ${rel} 与生成器输出一致（--check 之外再确认向量是从同一份定义来的）`, () => {
      assert.deepStrictEqual(onDisk(rel), vectors[rel]);
    });
  }

  for (const c of vectors['vectors/layout.json'].cases) {
    check(`layout 向量 ${c.id} → ${c.expect}`, () => {
      let got = 'ok';
      let layout;
      try {
        const display = c.displayText ?? D.toDisplay(JSON.parse(c.layoutText));
        layout = D.checkPackageLayout({
          layoutBytes: Buffer.from(c.layoutText, 'utf8'), displayBytes: Buffer.from(display, 'utf8'), source: c.sourceB64 !== undefined ? Buffer.from(c.sourceB64, 'base64') : c.source,
          layoutVersion: c.layoutVersion ?? 1, vocabularyLocalized: c.vocabularyLocalized, literalKeywords: c.literalKeywords, operatorSpellings: c.operatorSpellings,
        });
      } catch (e) {
        if (!(e instanceof D.DisplayRuleError) && !(e instanceof SyntaxError)) throw e;
        got = e instanceof D.DisplayRuleError ? e.rule : 'L1';
      }
      assert.strictEqual(got, c.expect);
      if (c.serialized !== undefined) assert.strictEqual(D.serializeLayout(layout), c.serialized);
    });
  }

  for (const c of vectors['vectors/display-reconstruct.json'].cases) {
    check(`reconstruct 向量 ${c.id} → ${c.expect}`, () => {
      const r = D.reconstructFromDisplay(JSON.parse(c.layoutText), c.edited);
      assert.strictEqual(r.kind, c.expect);
      if (c.expect === 'unique') assert.strictEqual(D.toCanonical(r.layout), c.canonical);
    });
  }
  for (const p of vectors['vectors/display-reconstruct.json'].performance) {
    check(`reconstruct 性能 ${p.id}：2 s 内得 ${p.expect}`, () => {
      const layout = { v: 1, spans: Array.from({ length: p.units }, () => p.unit).flat() };
      const edited = p.editUnit.repeat(p.editRepeat) + p.editTail;
      assert.ok(D.utf8Length(edited) <= D.LAYOUT_LIMITS.displayBytes, '配方超出显示字节上限');
      const t0 = performance.now();
      const r = D.reconstructFromDisplay(layout, edited);
      const ms = performance.now() - t0;
      assert.strictEqual(r.kind, p.expect);
      if (p.canonicalUnit) assert.strictEqual(D.toCanonical(r.layout), p.canonicalUnit.repeat(p.units));
      assert.ok(ms < 2000, `用时 ${ms.toFixed(0)} ms`);
    });
  }

  for (const c of vectors['vectors/display-padding.json'].cases) {
    check(`padding 向量 ${c.id}`, () => assert.strictEqual(D.padStructuralSpans(JSON.parse(c.layoutText)), c.padded));
  }

  // 反向映射的定义（修订 D7）与实现无关：穷举全部切分作独立判官，在小规模随机排版上与 DP 比对结论与唯一解
  check('reconstruct：随机小排版上与按定义穷举的结论一致（2 000 例）', () => {
    let seed = 0x0059a4;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const ALPHA = ['a', 'b', '，', ' '];
    const word = (min, max) => Array.from({ length: min + rnd(max - min + 1) }, () => ALPHA[rnd(ALPHA.length)]).join('');
    const brute = (layout, edited) => {
      let E = edited;
      const display = D.toDisplay(layout);
      if (!display.endsWith('\n') && E.endsWith('\n')) E = E.slice(0, E.endsWith('\r\n') ? -2 : -1);
      const spans = layout.spans;
      const sols = [];
      const go = (i, at, ts, prevContentChanged, hiddenSinceContent) => {
        if (sols.length > 2) return;
        if (i === spans.length) {
          if (at === E.length) sols.push([...ts]);
          return;
        }
        const s = spans[i];
        if (!('text' in s)) {
          if (!E.startsWith(s.display, at)) return;
          // 隐藏串：只由 display 为空的结构 span 组成；遇到非空 display 即断开
          go(i + 1, at + s.display.length, ts, prevContentChanged, s.display === '' ? hiddenSinceContent : false);
          return;
        }
        for (let e = at + 1; e <= E.length; e++) {
          const t = E.slice(at, e);
          const changed = t !== s.text;
          const leftIsContent = hiddenSinceContent === true && prevContentChanged !== null;
          if (leftIsContent && prevContentChanged && changed) continue;
          ts.push(t);
          go(i + 1, e, ts, changed, true);
          ts.pop();
        }
      };
      // hiddenSinceContent：true 表示上一个内容 span 之后只经过了 display 为空的结构 span（可为零个，合并形态下不会是零个）
      go(0, 0, [], null, false);
      return sols.length;
    };
    for (let n = 0; n < 2000; n++) {
      const spans = [];
      const k = 1 + rnd(4);
      if (rnd(3) === 0) spans.push({ canonical: '#', display: rnd(2) ? '' : word(1, 1) });
      for (let j = 0; j < k; j++) {
        spans.push({ text: word(1, 2) });
        if (j < k - 1 || rnd(2)) {
          const m = 1 + rnd(2);
          for (let q = 0; q < m; q++) spans.push({ canonical: '_', display: rnd(2) ? '' : word(1, 1) });
        }
      }
      const layout = { v: 1, spans };
      const edited = rnd(3) === 0 ? D.toDisplay(layout) : word(1, 7);
      const want = brute(layout, edited);
      const r = D.reconstructFromDisplay(layout, edited);
      const kind = want === 0 ? 'unmappable' : want === 1 ? 'unique' : 'ambiguous';
      assert.strictEqual(r.kind, kind, `${JSON.stringify(layout)} / ${JSON.stringify(edited)}`);
      if (kind === 'unique') assert.strictEqual(D.toDisplay(r.layout), edited.endsWith('\n') && !D.toDisplay(layout).endsWith('\n') ? edited.slice(0, -1) : edited);
    }
  });

  check('foldKey：NFC + 简单折叠（ẞ → ß、Σ → σ、K（开尔文）→ k、全角 Ａ → ａ）', () => {
    assert.strictEqual(D.foldKey('ẞ'), 'ß');
    assert.strictEqual(D.foldKey('ΣΑΣ'), 'σασ');
    assert.strictEqual(D.foldKey('K'), 'k');
    assert.strictEqual(D.foldKey('Ａ'), 'ａ');
    assert.strictEqual(D.foldKey('é'), 'é');
  });

  check('keyword-spellings.json：拼写已 foldKey、按码点排序去重，四个 locale 齐全', () => {
    const k = vectors['vectors/keyword-spellings.json'];
    assert.deepStrictEqual(Object.keys(k.locales).sort(), ['de-DE', 'en-US', 'hi-IN', 'zh-CN']);
    const cmp = (a, b) => {
      const x = [...a].map((c) => c.codePointAt(0));
      const y = [...b].map((c) => c.codePointAt(0));
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    };
    for (const [loc, v] of Object.entries(k.locales)) {
      for (const list of [v.literal, v.operator]) {
        assert.deepStrictEqual(list, [...new Set(list.map(D.foldKey))].sort(cmp), loc);
      }
      assert.strictEqual(v.literal.length, 4, loc);
    }
    assert.strictEqual(k.operatorKinds.length, 11);
  });

  check('L7 运算符序列：最长匹配优先、含标识符字符的拼写须整词', () => {
    const table = D.operatorTable(['at least', 'plus']);
    assert.deepStrictEqual(D.operatorSequence(' a at least b ', table), ['at least']);
    assert.deepStrictEqual(D.operatorSequence(' plusx + ', table), ['+']);
    assert.deepStrictEqual(D.operatorSequence('<=!', table), ['<', '=', '!']);
  });

  check('formatGate：一侧不支持 → skipped；都支持 → run；strict → fail；无 requiresFormat → run', () => {
    const row = { c: { requiresFormat: '1.1' } };
    assert.strictEqual(formatGate(row, { node: ['1.0', '1.1'], jre: ['1.0'] }), 'skipped');
    assert.strictEqual(formatGate(row, { node: ['1.0', '1.1'], jre: ['1.0', '1.1'] }), 'run');
    assert.strictEqual(formatGate(row, { node: null, jre: ['1.0', '1.1'] }), 'skipped');
    assert.strictEqual(formatGate(row, { node: ['1.0'], jre: ['1.0'] }, { strict: true }), 'fail');
    assert.strictEqual(formatGate({ c: {} }, { node: ['1.0'], jre: ['1.0'] }, { strict: true }), 'run');
  });

  check('显示文本文件：去至多一个 BOM、超大不读、非法 UTF-8 与缺文件为 USAGE', () => {
    const { mkdtempSync, writeFileSync: wf, rmSync } = require('node:fs');
    const dir = mkdtempSync(join(require('node:os').tmpdir(), 'disp-'));
    try {
      wf(join(dir, 'bom'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('x')]));
      assert.deepStrictEqual(readDisplayFile(join(dir, 'bom')), { oversize: false, text: '﻿x' });
      wf(join(dir, 'big'), Buffer.alloc(24580, 0x61));
      assert.deepStrictEqual(readDisplayFile(join(dir, 'big')), { oversize: true, text: null });
      wf(join(dir, 'edge'), Buffer.alloc(24579, 0x61));
      assert.strictEqual(readDisplayFile(join(dir, 'edge')).oversize, false);
      wf(join(dir, 'bad'), Buffer.from([0x61, 0xff]));
      assert.strictEqual(parseCommand(['show', '.', '--from-display', 'bad'], dir).usage, true);
      assert.strictEqual(parseCommand(['run', '.', '--display', 'missing', '--input', '-'], dir).usage, true);
      assert.strictEqual(parseCommand(['show', '.', '--canonical', '--from-display', 'edge'], dir).usage, true);
      assert.strictEqual(parseCommand(['show', '.', '--from-display', 'edge'], dir).usage, false);
      assert.strictEqual(parseCommand(['verify', '.', '--display', 'edge'], dir).usage, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log(`test-package-v1: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
