/**
 * 命令行与信任锚的参照实现（README「命令行」「信任锚」「compile」中属于 usage 阶段的规则）。
 * --verify-engines 用它独立判定每条用例「是否 USAGE」：期望 USAGE 的必须被拒，其余必须被接受。不进 CLI，也不发网络请求。
 *
 * parseCommand(args, cwd) → { usage: false, command, positional, options } | { usage: true, why }
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStrictJson } from './strict-json.mjs';

const COMMON_ANCHOR = ['--jwks', '--pubkey'];
const SPEC = {
  run: { valued: ['--entry', '--input', '--timeout', '--display', ...COMMON_ANCHOR], switches: ['--allow-unsigned'], positional: 1 },
  verify: { valued: ['--timeout', ...COMMON_ANCHOR], switches: ['--allow-unsigned', '--recompile', '--probes'], positional: 1 },
  inspect: { valued: [...COMMON_ANCHOR], switches: ['--allow-unsigned'], positional: 1 },
  compile: { valued: ['--locale', '--alias-set', '--vocabulary', '--out', ...COMMON_ANCHOR], switches: ['--allow-unsigned', '--allow-structural'], positional: 1 },
  version: { valued: [], switches: [], positional: 0 },
  // ADR 0059 修订 4 D6：show 打印显示文本（或 --canonical 的规范源码、--from-display 还原出的规范源码）
  show: { valued: ['--from-display', ...COMMON_ANCHOR], switches: ['--allow-unsigned', '--canonical'], positional: 1 },
};
const TIMEOUT = /^(0|[1-9][0-9]*)(ms|s)(?![\s\S])/;
/** compile --locale 支持的词法表（两侧都内置的四个）；形态合法但不在表中同样是 USAGE。 */
export const SUPPORTED_LOCALES = new Set(['en-US', 'zh-CN', 'de-DE', 'hi-IN']);
/** 「是 URL」的判定：scheme://；只有字面量小写 https:// 被接受，其他（含 HTTPS://、http://、ftp://）为 USAGE。 */
export const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const B64U_32 = /^[A-Za-z0-9_-]{43}(?![\s\S])/;

class Usage extends Error {}
const usage = (why) => {
  throw new Usage(why);
};

function canonicalKey(x) {
  if (typeof x !== 'string' || !B64U_32.test(x)) return null;
  const raw = Buffer.from(x, 'base64url');
  return raw.length === 32 && raw.toString('base64url') === x ? raw : null;
}

/** 单个 JWK 的合法性（README「信任锚」）。 */
function checkJwk(k, requireKid) {
  if (k === null || typeof k !== 'object' || Array.isArray(k)) usage('JWK 不是对象');
  if (k.kty !== 'OKP' || k.crv !== 'Ed25519') usage('JWK 不是 OKP / Ed25519');
  if (!canonicalKey(k.x)) usage('JWK 的 x 不是 32 字节的规范 base64url');
  if (requireKid ? typeof k.kid !== 'string' || k.kid === '' : k.kid !== undefined && (typeof k.kid !== 'string' || k.kid === '')) usage('JWK 的 kid 不合法');
  if (k.alg !== undefined && k.alg !== 'EdDSA') usage('JWK 的 alg 不是 EdDSA');
  if (k.use !== undefined && k.use !== 'sig') usage('JWK 的 use 不是 sig');
}

/** 本地信任锚文件（--jwks / --pubkey）的大小上限。 */
export const MAX_ANCHOR_FILE_BYTES = 1024 * 1024;

function readFileOrUsage(path, what, maxBytes = Infinity) {
  if (!existsSync(path) || !statSync(path).isFile()) usage(`${what} 不存在或不是文件`);
  if (statSync(path).size > maxBytes) usage(`${what} 超过 1 MiB`);
  return readFileSync(path);
}

/** 显示文本文件的大小上限：LAYOUT_LIMITS.displayBytes + 开头 BOM（3 字节）。超出不读内容，在 reconstruct 阶段为 DISPLAY_UNMAPPABLE。 */
export const MAX_DISPLAY_FILE_BYTES = 24576 + 3;

/**
 * --display / --from-display 的文件（README「run --display」）：usage 阶段判定。不存在、不是普通文件、不可读、
 * 非法 UTF-8 为 USAGE；大小超过 MAX_DISPLAY_FILE_BYTES 时不读内容（oversize:true，之后为 DISPLAY_UNMAPPABLE）；
 * 否则严格 UTF-8 解码并去掉至多一个开头 BOM。
 */
export function readDisplayFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) usage('显示文本文件不存在或不是文件');
  if (statSync(path).size > MAX_DISPLAY_FILE_BYTES) return { oversize: true, text: null };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch {
    usage('显示文本文件不是合法 UTF-8');
  }
  return { oversize: false, text: text.startsWith('\uFEFF') ? text.slice(1) : text };
}

/** .aster 源码的解码（README「compile」）：严格 UTF-8，非法即 USAGE；去掉至多一个开头的 BOM。 */
export function decodeSource(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    usage('源码不是合法 UTF-8');
  }
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** 「空白源码」只看 ASCII 空白：U+0020、\t、\n、\r（U+00A0、U+3000 等不算，照常交给编译器）。 */
export const isBlankSource = (text) => /^[ \t\n\r]*$/.test(text);

function checkAnchor(options, cwd) {
  if (options['--jwks'] !== undefined && options['--pubkey'] !== undefined) usage('--jwks 与 --pubkey 同时给出');
  const jwks = options['--jwks'];
  if (jwks !== undefined) {
    if (URL_LIKE.test(jwks) && !jwks.startsWith('https://')) usage('--jwks 只接受 https:// URL');
    if (jwks.startsWith('https://')) {
      // 初始 URL 与 Location 同一套规则：先是合法 URI-reference（字符级），再满足请求目标规则；违反即 usage 阶段 USAGE，不发任何请求
      if (!URI_REFERENCE_CHARS.test(jwks)) usage(`--jwks URL 不是合法的 URI-reference：${JSON.stringify(jwks)}`);
      validateRequestTarget(jwks);
      return; // 参照实现在 parseCommand 里不联网
    }
    let doc;
    try {
      doc = parseStrictJson(readFileOrUsage(join(cwd, jwks), '--jwks 文件', MAX_ANCHOR_FILE_BYTES), { maxDepth: 8 });
    } catch (e) {
      if (e instanceof Usage) throw e;
      usage(`--jwks 文件不是严格 JSON：${e.message}`);
    }
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.keys)) usage('JWKS 没有 keys 数组');
    const kids = new Set();
    for (const k of doc.keys) {
      checkJwk(k, true);
      if (kids.has(k.kid)) usage('JWKS 的 kid 重复');
      kids.add(k.kid);
    }
  }
  const pub = options['--pubkey'];
  if (pub !== undefined) {
    const bytes = readFileOrUsage(join(cwd, pub), '--pubkey 文件', MAX_ANCHOR_FILE_BYTES);
    const text = bytes.toString('utf8');
    if (text.trimStart().startsWith('{')) {
      let jwk;
      try {
        jwk = parseStrictJson(bytes, { maxDepth: 8 });
      } catch (e) {
        usage(`--pubkey JWK 不是严格 JSON：${e.message}`);
      }
      checkJwk(jwk, false);
    } else {
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      if (!canonicalKey(body)) usage('--pubkey 原始公钥格式不对');
    }
  }
}

/** --out：父目录必须已存在且是目录（<OUT> 占位符由测试替换为临时路径，参照实现跳过）。 */
function checkOut(options, cwd) {
  const out = options['--out'];
  if (out === undefined || out.includes('<OUT>')) return;
  const parent = dirname(join(cwd, out));
  if (!existsSync(parent) || !statSync(parent).isDirectory()) usage('--out 的父目录不存在');
  if (existsSync(join(cwd, out)) && statSync(join(cwd, out)).isDirectory()) usage('--out 指向一个目录');
}

function checkCompile(positional, options, cwd) {
  checkOut(options, cwd);
  const target = positional[0];
  const path = join(cwd, target);
  const isSource = target.endsWith('.aster') && existsSync(path) && statSync(path).isFile();
  if (target.endsWith('.aster') && !isSource) usage('源码文件不存在或不可读');
  if (isSource) {
    decodeSource(readFileSync(path));
    for (const o of ['--jwks', '--pubkey', '--allow-unsigned']) if (options[o] !== undefined) usage(`源码形态不接受 ${o}`);
    if (options['--allow-structural'] && options['--alias-set'] === undefined) usage('--allow-structural 只能与 --alias-set 同用');
    if (options['--locale'] !== undefined && !SUPPORTED_LOCALES.has(options['--locale'])) usage('--locale 不受支持');
    for (const o of ['--alias-set', '--vocabulary']) {
      if (options[o] === undefined) continue;
      try {
        parseStrictJson(readFileOrUsage(join(cwd, options[o]), `${o} 文件`), { maxDepth: 64 });
      } catch (e) {
        if (e instanceof Usage) throw e;
        usage(`${o} 文件不是严格 JSON`);
      }
    }
    return;
  }
  for (const o of ['--locale', '--alias-set', '--vocabulary', '--allow-structural']) if (options[o] !== undefined) usage(`包形态不接受 ${o}`);
  checkAnchor(options, cwd);
}

/** 解析命令行；usage 阶段的全部检查（含读锚文件、compile 的源码与配置文件）。 */
export function parseCommand(args, cwd) {
  try {
    const [command, ...rest] = args;
    const spec = SPEC[command];
    if (!spec) usage(`未知子命令 ${command}`);
    const known = new Set([...spec.valued, ...spec.switches]);
    const options = {};
    const positional = [];
    let endOfOptions = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (endOfOptions) {
        positional.push(a);
        continue;
      }
      if (a === '--') {
        endOfOptions = true; // `--` 之后一律是位置参数
        continue;
      }
      if (!a.startsWith('--')) {
        positional.push(a);
        continue;
      }
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (!known.has(name)) usage(`未知选项 ${name}`);
      if (Object.hasOwn(options, name)) usage(`选项重复 ${name}`);
      if (spec.valued.includes(name)) {
        if (eq >= 0) {
          if (eq === a.length - 1) usage(`${name}= 的值为空`);
          options[name] = a.slice(eq + 1);
        }
        else {
          const next = rest[i + 1];
          if (next === undefined || next === '--') usage(`${name} 缺值`);
          if (known.has(next.includes('=') ? next.slice(0, next.indexOf('=')) : next)) usage(`${name} 的值是另一个选项`);
          if (next === '') usage(`${name} 的值为空`);
          options[name] = next;
          i++;
        }
      } else {
        if (eq >= 0) usage(`开关 ${name} 不带值`);
        options[name] = true;
      }
    }
    if (positional.length !== spec.positional) usage(`位置参数个数应为 ${spec.positional}`);
    if (command === 'run' && options['--input'] === undefined) usage('run 缺 --input');
    if (options['--timeout'] !== undefined) {
      const m = TIMEOUT.exec(options['--timeout']);
      if (!m) usage('--timeout 语法');
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (ms <= 0 || ms > 300_000) usage('--timeout 超出 (0, 300 s]');
    }
    if (command === 'compile') checkCompile(positional, options, cwd);
    else if (command !== 'version') checkAnchor(options, cwd);
    if (command === 'show' && options['--canonical'] && options['--from-display'] !== undefined) usage('--canonical 与 --from-display 互斥');
    const edited = options['--display'] ?? options['--from-display'];
    if (edited !== undefined) readDisplayFile(join(cwd, edited));
    return { usage: false, command, positional, options };
  } catch (e) {
    if (e instanceof Usage) return { usage: true, why: e.message };
    throw e;
  }
}

/**
 * 重定向 Location 的解析（README「信任锚」）：Location 必须是合法的 RFC 3986 URI-reference（只含 unreserved / reserved 字符与
 * 合法的 %XX；空串、原始空格、反斜杠、控制字符、原始非 ASCII 字符一律 USAGE——不得像 WHATWG URL 那样悄悄修正），
 * 然后按 RFC 3986 §5.2.2（含 §5.2.4 remove_dot_segments）相对当前请求 URL 解析。scheme 不区分大小写，解析结果中统一为小写。
 */
const URI_REFERENCE_CHARS = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+$/;
const RFC3986 = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

function splitReference(s) {
  const m = RFC3986.exec(s);
  return { scheme: m[1], authority: m[2], path: m[3], query: m[4], fragment: m[5] };
}

/** RFC 3986 §5.2.4。 */
function removeDotSegments(path) {
  let input = path;
  let output = '';
  while (input.length > 0) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = input.slice(2);
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) {
      input = input.slice(3);
      output = output.slice(0, Math.max(0, output.lastIndexOf('/')));
    } else if (input === '/..') {
      input = '/';
      output = output.slice(0, Math.max(0, output.lastIndexOf('/')));
    } else if (input === '.' || input === '..') input = '';
    else {
      const start = input.startsWith('/') ? 1 : 0;
      const next = input.indexOf('/', start);
      const seg = next < 0 ? input : input.slice(0, next);
      output += seg;
      input = next < 0 ? '' : input.slice(next);
    }
  }
  return output;
}

export function resolveReference(baseUrl, reference) {
  if (typeof reference !== 'string' || reference === '' || !URI_REFERENCE_CHARS.test(reference)) usage(`Location 不是合法的 URI-reference：${JSON.stringify(reference)}`);
  const r = splitReference(reference);
  if (r.scheme !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(r.scheme)) usage(`Location 的 scheme 不合法：${reference}`);
  const b = splitReference(baseUrl);
  const t = {};
  if (r.scheme !== undefined) {
    t.scheme = r.scheme;
    t.authority = r.authority;
    t.path = removeDotSegments(r.path);
    t.query = r.query;
  } else {
    if (r.authority !== undefined) {
      t.authority = r.authority;
      t.path = removeDotSegments(r.path);
      t.query = r.query;
    } else {
      if (r.path === '') {
        t.path = b.path;
        t.query = r.query !== undefined ? r.query : b.query;
      } else {
        if (r.path.startsWith('/')) t.path = removeDotSegments(r.path);
        else {
          // §5.2.3 merge
          const merged = b.authority !== undefined && b.path === '' ? `/${r.path}` : `${b.path.slice(0, b.path.lastIndexOf('/') + 1)}${r.path}`;
          t.path = removeDotSegments(merged);
        }
        t.query = r.query;
      }
      t.authority = b.authority;
    }
    t.scheme = b.scheme;
  }
  t.fragment = r.fragment;
  // §5.3 重组；scheme 统一小写（scheme 不区分大小写）
  let out = `${t.scheme.toLowerCase()}:`;
  if (t.authority !== undefined) out += `//${t.authority}`;
  out += t.path;
  if (t.query !== undefined) out += `?${t.query}`;
  if (t.fragment !== undefined) out += `#${t.fragment}`;
  return out;
}

/**
 * https 信任锚的取回参照实现（README「信任锚」）：只接受字面量 https://；总超时 10 s；至多跟随 3 次重定向且只能 https → https；
 * 重定向只认 301/302/303/307/308（相对 Location 按 RFC 3986 解析）；请求 Accept-Encoding: identity，响应带非 identity 的 Content-Encoding 即失败；
 * 响应体 ≤ 1 MiB；只认 2xx；运行时标准信任配置（Node：default ∪ system，含 NODE_EXTRA_CA_CERTS），测试时经 ASTER_ANCHOR_CA_FILE 追加一个 PEM；不使用任何代理（v1）。
 * 任何失败都抛 Usage（调用方报 USAGE）。
 */
/**
 * 请求目标在发出请求之前的合法性（README「信任锚」），初始 --jwks URL 与每个解析出的重定向目标都适用：https URL 必须有非空 host；
 * port 可选，十进制 1–65535；不得含 userinfo（`u:p@`、`u@`、`@`）；`[` `]` 只能作为 IP-literal host 的边界出现（`https://[::1]/`），
 * 其他位置一律拒绝；非 IP-literal 的 host 不得含 `:`（`a:b:443`、`h::443`）。任何违反都是 USAGE。
 */
export function validateRequestTarget(url) {
  const m = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  if (!m) usage(`请求目标不是 https URL：${url}`);
  const [, authority, path, query = '', fragment = ''] = m;
  if (authority.includes('@')) usage(`请求目标不得含 userinfo：${url}`);
  let host = authority;
  let port;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) usage(`IP-literal 缺少 ]：${url}`);
    host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) usage(`IP-literal 之后只能是 :port：${url}`);
    if (rest !== '') port = rest.slice(1);
    // RFC 3986 IP-literal = "[" ( IPv6address / IPvFuture ) "]"
    if (!/^\[(?:[0-9A-Fa-f:.]+|[vV][0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+)\]$/.test(host)) usage(`IP-literal 不合法：${url}`);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    if (/[[\]]/.test(host)) usage(`[ ] 只能用于 IP-literal host：${url}`);
    if (host.includes(':')) usage(`非 IP-literal 的 host 不得含 ':'：${url}`);
  }
  if (host === '') usage(`请求目标的 host 为空：${url}`);
  if (port !== undefined && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) usage(`请求目标的端口不合法：${url}`);
  if (/[[\]]/.test(path + query + fragment)) usage(`[ ] 只能用于 IP-literal host：${url}`);
  return url;
}

export async function fetchJwks(url, { extraCa, timeoutMs = 10_000, maxRedirects = 3, maxBytes = 1024 * 1024 } = {}) {
  const https = await import('node:https');
  const tls = await import('node:tls');
  // 信任库 = 运行时的标准信任配置：Node 为 getCACertificates('default')（内置 CA ∪ NODE_EXTRA_CA_CERTS ∪ 启用时的系统 CA）
  // ∪ getCACertificates('system')；ASTER_ANCHOR_CA_FILE 在其上追加（不是替换）。企业 CA 经这些标准途径安装即可生效。
  const ca = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system'), ...(extraCa ? [extraCa] : [])])];
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  // 总时限：从第一次请求开始，到读完最后一个响应体为止（含重定向），不是套接字空闲超时
  const signal = AbortSignal.timeout(timeoutMs);
  let current = validateRequestTarget(url);
  for (let hop = 0; ; hop++) {
    if (!current.startsWith('https://')) throw new Usage('重定向到非 https 地址'); // resolveReference 已把 scheme 统一为小写
    if (signal.aborted) throw new Usage('超过 10 s 总时限');
    // 不经代理：直连（HTTPS_PROXY 等环境变量一律忽略）；只要 identity 编码
    const res = await new Promise((resolve, reject) => {
      const onAbort = () => req.destroy(new Usage('超过 10 s 总时限'));
      const req = https.get(current, { ca, agent: false, signal, headers: { 'accept-encoding': 'identity' } }, (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Usage('响应超过 1 MiB'));
          } else chunks.push(c);
        });
        r.on('error', (e) => reject(e instanceof Usage ? e : new Usage(`读取响应失败：${e.message}`)));
        r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location, encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
      req.on('error', (e) => reject(e instanceof Usage ? e : new Usage(signal.aborted ? '超过 10 s 总时限' : `请求失败：${e.message}`)));
    });
    if (REDIRECTS.has(res.status)) {
      if (!res.location) throw new Usage('重定向缺少 Location');
      if (hop + 1 > maxRedirects) throw new Usage('重定向超过 3 次');
      // RFC 3986 §5.2 相对当前请求 URL 解析（非法即 USAGE），再在发出请求之前校验目标
      current = validateRequestTarget(resolveReference(current, res.location));
      continue;
    }
    if (res.status < 200 || res.status > 299) throw new Usage(`HTTP ${res.status}`);
    if (res.encoding !== undefined && res.encoding.toLowerCase() !== 'identity') throw new Usage(`不接受 Content-Encoding: ${res.encoding}`);
    try {
      return parseStrictJson(res.body, { maxDepth: 8 });
    } catch {
      throw new Usage('响应不是严格 JSON');
    }
  }
}

export { Usage };
