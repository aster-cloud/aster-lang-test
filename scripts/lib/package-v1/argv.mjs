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
  run: { valued: ['--entry', '--input', '--timeout', ...COMMON_ANCHOR], switches: ['--allow-unsigned'], positional: 1 },
  verify: { valued: ['--timeout', ...COMMON_ANCHOR], switches: ['--allow-unsigned', '--recompile', '--probes'], positional: 1 },
  inspect: { valued: [...COMMON_ANCHOR], switches: ['--allow-unsigned'], positional: 1 },
  compile: { valued: ['--locale', '--alias-set', '--vocabulary', '--out', ...COMMON_ANCHOR], switches: ['--allow-unsigned', '--allow-structural'], positional: 1 },
  version: { valued: [], switches: [], positional: 0 },
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

function readFileOrUsage(path, what) {
  if (!existsSync(path) || !statSync(path).isFile()) usage(`${what} 不存在或不是文件`);
  return readFileSync(path);
}

function checkAnchor(options, cwd) {
  if (options['--jwks'] !== undefined && options['--pubkey'] !== undefined) usage('--jwks 与 --pubkey 同时给出');
  const jwks = options['--jwks'];
  if (jwks !== undefined) {
    if (URL_LIKE.test(jwks) && !jwks.startsWith('https://')) usage('--jwks 只接受 https:// URL');
    if (jwks.startsWith('https://')) return; // 参照实现不联网；夹具不含 https URL
    let doc;
    try {
      doc = parseStrictJson(readFileOrUsage(join(cwd, jwks), '--jwks 文件'), { maxDepth: 8 });
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
    const bytes = readFileOrUsage(join(cwd, pub), '--pubkey 文件');
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
}

function checkCompile(positional, options, cwd) {
  checkOut(options, cwd);
  const target = positional[0];
  const path = join(cwd, target);
  const isSource = target.endsWith('.aster') && existsSync(path) && statSync(path).isFile();
  if (target.endsWith('.aster') && !isSource) usage('源码文件不存在或不可读');
  if (isSource) {
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
    return { usage: false, command, positional, options };
  } catch (e) {
    if (e instanceof Usage) return { usage: true, why: e.message };
    throw e;
  }
}

/**
 * https 信任锚的取回参照实现（README「信任锚」）：只接受字面量 https://；总超时 10 s；至多跟随 3 次重定向且只能 https → https；
 * 响应体 ≤ 1 MiB；只认 2xx；用系统信任库，测试时可经环境变量 ASTER_ANCHOR_CA_FILE 追加一个 PEM（仅测试用）。
 * 任何失败都抛 Usage（调用方报 USAGE）。代理：生产实现须遵守 HTTPS_PROXY / NO_PROXY；本参照实现只用于离线测试，不经代理。
 */
export async function fetchJwks(url, { ca, timeoutMs = 10_000, maxRedirects = 3, maxBytes = 1024 * 1024 } = {}) {
  const https = await import('node:https');
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!current.startsWith('https://')) throw new Usage('重定向到非 https 地址');
    const res = await new Promise((resolve, reject) => {
      const req = https.get(current, { ca, timeout: Math.max(1, deadline - Date.now()) }, (r) => {
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Usage('响应超过 1 MiB'));
          } else chunks.push(c);
        });
        r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Usage('超时')));
      req.on('error', (e) => reject(e instanceof Usage ? e : new Usage(`请求失败：${e.message}`)));
    });
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop + 1 > maxRedirects) throw new Usage('重定向超过 3 次');
      current = new URL(res.location, current).toString();
      continue;
    }
    if (res.status < 200 || res.status > 299) throw new Usage(`HTTP ${res.status}`);
    try {
      return parseStrictJson(res.body, { maxDepth: 8 });
    } catch {
      throw new Usage('响应不是严格 JSON');
    }
  }
}

export { Usage };
