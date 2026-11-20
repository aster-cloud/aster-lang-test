/**
 * 包检查流水线的参照实现（README「检查顺序」「zip 规则」「manifest 语义规则」），从 read 到 ir 阶段。
 * --verify-engines 用它独立判定每个篡改夹具与黄金包，断言夹具声明的错误码与阶段（从而 meta）正确。
 * 两个 CLI 各自实现同一流水线；本文件不进 CLI，也不做求值。
 *
 * checkPackage(path, opts) → { ok: true, ... } | { ok: false, stage, code, why }
 *   opts.anchor：{ kind: 'jwks', keys: Map<kid, raw32> } | { kind: 'raw', key } | { kind: 'jwk', kid?, key }
 *   opts.allowUnsigned、opts.validateManifest(tree) → bool（ajv）、opts.validateSig(tree) → bool、
 *   opts.readCoreIr(text)（严格读入，失败抛错）
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { canonicalJson } from './canonical.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { crc32 } from './zip.mjs';
import { publicKeyFromRaw, verifyManifest } from './signing.mjs';

/** 显示排版的两个固定路径（ADR 0059 修订 4 D1）。 */
export const DISPLAY_PATHS = Object.freeze(['policy/display/display.aster', 'policy/display/layout.json']);
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_SIG_BYTES = 64 * 1024;
/** 包内条目数上限：目录形态数普通文件与子目录（不含包根），zip 数中央目录条目（含目录条目）。 */
export const MAX_PACKAGE_FILES = 1024;
const META_FILES = new Set(['manifest.json', 'manifest.sig.json', 'SHA256SUMS']);
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*(?![\s\S])/;
const FORMAT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?![\s\S])/;
const B64U_86 = /^[A-Za-z0-9_-]{86}$/;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const utf8 = (s) => Buffer.from(s, 'utf8');

class Fail extends Error {
  constructor(stage, code, why) {
    super(why);
    this.stage = stage;
    this.code = code;
  }
}
const fail = (stage, code, why) => {
  throw new Fail(stage, code, why);
};

/** 包内相对路径规则（files[].path 与 zip 去掉根之后的条目名共用）。 */
export function isPackagePath(p) {
  return PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
}

/** zip 根目录段：非空、NFC、不是 . / ..、不含 / \ 与控制字符（C0、DEL、C1）。 */
export function isSafeRoot(r) {
  return r.length > 0 && r !== '.' && r !== '..' && r === r.normalize('NFC') && !/[/\\\u0000-\u001f\u007f-\u009f]/.test(r);
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------
/** 目录形态的子目录嵌套深度上限（包根的直接子目录为第 1 层）。 */
export const MAX_DIR_DEPTH = 32;

function readDirectory(root) {
  const files = new Map();
  let total = 0;
  let count = 0;
  // 遍历顺序固定为每层目录内按名字的 UTF-8 字节序（两侧失败时报的是同一个条目）。对每个条目依次：
  // 符号链接 → 失败；子目录 → 判深度（> 32 失败）、计入条目数（> 1 024 失败）、递归；普通文件 → 计入条目数、再判大小
  const walk = (dir, rel, depth) => {
    const names = readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    for (const name of names) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) fail('read', 'PKG_INTEGRITY', `符号链接 ${r}`);
      if (st.isDirectory()) {
        if (depth + 1 > MAX_DIR_DEPTH) fail('read', 'PKG_INTEGRITY', `目录嵌套超过 ${MAX_DIR_DEPTH} 层`);
        count += 1;
        if (count > MAX_PACKAGE_FILES) fail('read', 'PKG_INTEGRITY', `条目数超过 ${MAX_PACKAGE_FILES}`);
        walk(abs, r, depth + 1);
        continue;
      }
      if (!st.isFile()) fail('read', 'PKG_INTEGRITY', `不是普通文件 ${r}`);
      count += 1;
      if (count > MAX_PACKAGE_FILES) fail('read', 'PKG_INTEGRITY', `条目数超过 ${MAX_PACKAGE_FILES}`);
      if (st.size > MAX_PACKAGE_BYTES || total + st.size > MAX_PACKAGE_BYTES) fail('read', 'PKG_INTEGRITY', '目录形态超过 64 MiB');
      total += st.size;
      files.set(r, readFileSync(abs));
    }
  };
  walk(root, '', 0);
  return files;
}

function decodeName(bytes, flags) {
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('read', 'PKG_INTEGRITY', '条目名不是合法 UTF-8');
  }
  if (/[^\u0000-\u007f]/.test(s) && !(flags & 0x0800)) fail('read', 'PKG_INTEGRITY', '非 ASCII 条目名未置 UTF-8 标志');
  return s;
}

function readZip(buf) {
  const z = (why) => fail('read', 'PKG_INTEGRITY', why);
  if (buf.length > MAX_PACKAGE_BYTES) z('zip 超过 64 MiB');
  if (buf.length < 22 || buf.readUInt32LE(buf.length - 22) !== 0x06054b50) z('EOCD 不在文件末尾（有注释、尾随字节或不是 zip）');
  const e = buf.length - 22;
  const count = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOff = buf.readUInt32LE(e + 16);
  if (buf.readUInt16LE(e + 4) !== 0 || buf.readUInt16LE(e + 6) !== 0 || buf.readUInt16LE(e + 8) !== count) z('多卷 zip');
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) z('ZIP64');
  if (cdOff + cdSize !== e) z('中央目录与 EOCD 之间有间隙');
  if (count === 0) z('空 zip');
  if (count > MAX_PACKAGE_FILES) z(`条目数超过 ${MAX_PACKAGE_FILES}`);
  // 中央目录
  const cds = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > e || buf.readUInt32LE(p) !== 0x02014b50) z('中央目录损坏');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    cds.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      nameBytes: buf.subarray(p + 46, p + 46 + nameLen),
      extra: buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      offset: buf.readUInt32LE(p + 42),
    });
    if (commentLen !== 0) z('条目注释');
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== e) z('中央目录长度不符');
  // 本地头按顺序紧密排列：首个在偏移 0，最后一个的数据之后紧接中央目录
  let at = 0;
  const entries = [];
  let budget = MAX_PACKAGE_BYTES;
  let root = null;
  const seen = new Set();
  for (const cd of cds) {
    if (cd.offset !== at || at + 30 > cdOff || buf.readUInt32LE(at) !== 0x04034b50) z('本地头位置与中央目录不符（或有前置字节）');
    const flags = buf.readUInt16LE(at + 6);
    const method = buf.readUInt16LE(at + 8);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const nameBytes = buf.subarray(at + 30, at + 30 + nameLen);
    const extra = buf.subarray(at + 30 + nameLen, at + 30 + nameLen + extraLen);
    if (flags !== cd.flags || method !== cd.method || !nameBytes.equals(cd.nameBytes)) z('本地头与中央目录不一致（标志 / 方法 / 名字）');
    if (flags & ~0x0808) z('不支持的通用标志位（加密等）');
    for (const x of [extra, cd.extra]) {
      for (let k = 0; k + 4 <= x.length; k += 4 + x.readUInt16LE(k + 2)) if (x.readUInt16LE(k) === 0x0001) z('ZIP64 extra');
    }
    if (cd.csize === 0xffffffff || cd.usize === 0xffffffff) z('ZIP64 大小');
    if (method !== 0 && method !== 8) z(`不支持的压缩方法 ${method}`);
    const descriptor = (flags & 0x0008) !== 0;
    if (descriptor && method !== 8) z('存储条目不得使用数据描述符');
    const lcrc = buf.readUInt32LE(at + 14);
    const lcs = buf.readUInt32LE(at + 18);
    const lus = buf.readUInt32LE(at + 22);
    if (descriptor ? lcrc || lcs || lus : lcrc !== cd.crc || lcs !== cd.csize || lus !== cd.usize) z('本地头与中央目录不一致（crc / 大小）');
    const dataAt = at + 30 + nameLen + extraLen;
    let next = dataAt + cd.csize;
    if (descriptor) {
      if (next + 16 > cdOff || buf.readUInt32LE(next) !== 0x08074b50) z('缺少带签名的数据描述符');
      if (buf.readUInt32LE(next + 4) !== cd.crc || buf.readUInt32LE(next + 8) !== cd.csize || buf.readUInt32LE(next + 12) !== cd.usize) z('数据描述符与中央目录不一致');
      next += 16;
    }
    if (next > cdOff) z('条目越过中央目录');
    const name = decodeName(nameBytes, flags);
    const slash = name.indexOf('/');
    const r = slash < 0 ? name : name.slice(0, slash);
    if (root === null) root = r;
    if (r !== root || slash < 0 || !isSafeRoot(r)) z(`条目不在唯一的安全根目录下：${name}`);
    const rest = name.slice(slash + 1);
    const isDir = rest === '' || rest.endsWith('/');
    const rel = isDir ? rest.slice(0, -1) : rest;
    // 去掉根之后只有根目录条目本身（`<root>/`）可以为空；`<root>//` 之类去掉末尾 / 后为空的条目一律拒绝
    if (rel === '' ? rest !== '' : !isPackagePath(rel)) z(`条目路径不合法：${name}`);
    if (seen.has(name)) z(`重复条目 ${name}`);
    seen.add(name);
    // 逐条目的大小 / CRC / deflate 消耗规则对目录条目同样适用；目录条目只是不进入文件表
    if (isDir && cd.usize !== 0) z(`目录条目的声明大小不为 0：${name}`);
    const raw = buf.subarray(dataAt, dataAt + cd.csize);
    let data;
    if (method === 0) data = raw;
    else {
      let consumed;
      try {
        const r = inflateRawSync(raw, { maxOutputLength: Math.min(cd.usize, budget) + 1, info: true });
        data = r.buffer;
        consumed = r.engine.bytesWritten;
      } catch {
        z(`解压失败或超过声明大小 / 64 MiB：${name}`);
      }
      // 压缩数据必须恰好是一个完整的 deflate 流：最终块之后、csize 之内不得有多余字节
      if (consumed !== raw.length) z(`deflate 流之后有多余字节：${name}`);
    }
    if (data.length !== cd.usize) z(`实际大小与声明不符：${name}`);
    if (data.length > budget) z('累计解压超过 64 MiB');
    budget -= data.length;
    if (crc32(data) !== cd.crc) z(`CRC 不符：${name}`);
    if (!isDir) entries.push([rel, data]);
    at = next;
  }
  if (at !== cdOff) z('最后一个条目与中央目录之间有多余字节');
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
const byteOrder = (a, b) => Buffer.compare(utf8(a), utf8(b));

function checkManifest(bytes, opts) {
  const bad = (code, why) => fail('manifest', code, why);
  if (bytes.length > MAX_MANIFEST_BYTES) bad('PKG_INVALID_MANIFEST', 'manifest 超过 1 MiB');
  let tree;
  try {
    tree = parseStrictJson(bytes, { maxDepth: 64 });
  } catch (e) {
    bad('PKG_INVALID_MANIFEST', `不是严格 JSON：${e.message}`);
  }
  let canon;
  try {
    canon = utf8(canonicalJson(tree));
  } catch (e) {
    bad('PKG_INVALID_MANIFEST', `不在规范域内：${e.message}`);
  }
  if (!canon.equals(bytes)) bad('PKG_INVALID_MANIFEST', '文件字节不是规范 JSON');
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) bad('PKG_INVALID_MANIFEST', '顶层不是对象');
  if (tree.format !== 'aster-policy-package') bad('PKG_INVALID_MANIFEST', 'format');
  const fv = typeof tree.formatVersion === 'string' ? FORMAT_VERSION.exec(tree.formatVersion) : null;
  if (!fv) bad('PKG_INVALID_MANIFEST', 'formatVersion 语法');
  // 主版本 1、次版本 ≤ 1（ADR 0059 修订 4 D2），再按该次版本自己的 schema 严格校验
  const minor = Number(fv[2]);
  if (Number(fv[1]) !== 1 || minor > 1) bad('PKG_UNSUPPORTED_FORMAT', `formatVersion ${tree.formatVersion}`);
  if (!opts.validateManifest(tree, minor)) bad('PKG_INVALID_MANIFEST', 'schema');
  // 语义规则
  const paths = tree.files.map((f) => f.path);
  for (let k = 1; k < paths.length; k++) if (byteOrder(paths[k - 1], paths[k]) >= 0) bad('PKG_INVALID_MANIFEST', 'files[] 不是按字节严格升序（含重复）');
  const lower = new Set(paths.map((x) => x.toLowerCase()));
  if (lower.size !== paths.length) bad('PKG_INVALID_MANIFEST', 'files[] 有大小写不敏感的重复');
  const fns = tree.policy.entries.map((x) => x.function);
  if (new Set(fns).size !== fns.length) bad('PKG_INVALID_MANIFEST', '入口函数重复');
  for (const x of tree.policy.entries) {
    if (x.inputSchema !== `#/$defs/entry.${x.function}` || x.outputSchema !== `#/$defs/entry.${x.function}`) bad('PKG_INVALID_MANIFEST', '入口 schema 指针');
    if (x.function !== x.function.normalize('NFC')) bad('PKG_INVALID_MANIFEST', '函数名不是 NFC');
  }
  if (tree.policy.moduleName !== tree.policy.moduleName.normalize('NFC')) bad('PKG_INVALID_MANIFEST', '模块名不是 NFC');
  // display 存在 ⇔ files[] 同时含两个显示排版路径（1.1；display 不存在时这两个路径只是普通载荷）
  if (tree.display !== undefined && !DISPLAY_PATHS.every((x) => paths.includes(x))) bad('PKG_INVALID_MANIFEST', 'display 存在但 files[] 缺显示排版文件');
  if (tree.coreIr.version !== 2) bad('PKG_UNSUPPORTED_IR', `coreIr.version ${tree.coreIr.version}`);
  return tree;
}

// ---------------------------------------------------------------------------
// signature / integrity / ir
// ---------------------------------------------------------------------------
function checkSignature(files, manifestBytes, opts) {
  const bad = (code, why) => fail('signature', code, why);
  const sigBytes = files.get('manifest.sig.json');
  if (!sigBytes) {
    if (opts.allowUnsigned) return false;
    bad('PKG_UNSIGNED', '无签名');
  }
  if (sigBytes.length > MAX_SIG_BYTES) bad('PKG_SIGNATURE', '签名文件过大');
  let sig;
  try {
    sig = parseStrictJson(sigBytes, { maxDepth: 4 });
  } catch (e) {
    bad('PKG_SIGNATURE', `签名文件不是严格 JSON：${e.message}`);
  }
  if (!opts.validateSig(sig)) bad('PKG_SIGNATURE', '签名文件 schema');
  if (!B64U_86.test(sig.sig) || Buffer.from(sig.sig, 'base64url').toString('base64url') !== sig.sig) bad('PKG_SIGNATURE', '签名编码');
  const a = opts.anchor;
  let raw;
  if (a.kind === 'raw') raw = a.key;
  else if (a.kind === 'jwk') {
    if (a.kid !== undefined && a.kid !== sig.kid) bad('PKG_UNTRUSTED_KID', 'kid 与 --pubkey 的 JWK 不符');
    raw = a.key;
  } else {
    raw = a.keys.get(sig.kid);
    if (!raw) bad('PKG_UNTRUSTED_KID', `kid ${sig.kid} 不在锚中`);
  }
  if (!verifyManifest(manifestBytes, sig.sig, publicKeyFromRaw(raw))) bad('PKG_SIGNATURE', '验签失败');
  return true;
}

function checkIntegrity(files, manifest, manifestBytes) {
  const bad = (why) => fail('integrity', 'PKG_INTEGRITY', why);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const f of manifest.files) {
    const b = files.get(f.path);
    if (!b) bad(`缺文件 ${f.path}`);
    if (b.length !== f.size || sha256(b) !== f.sha256) bad(`哈希 / 大小不符 ${f.path}`);
  }
  for (const p of files.keys()) if (!listed.has(p) && !META_FILES.has(p)) bad(`多余文件 ${p}`);
  const all = new Map([...manifest.files.map((f) => [f.path, files.get(f.path)]), ['manifest.json', manifestBytes]]);
  const sums = [...all.keys()].sort(byteOrder).map((p) => `${sha256(all.get(p))}  ${p}\n`).join('');
  if (!files.get('SHA256SUMS')?.equals(utf8(sums))) bad('SHA256SUMS');
  if (manifest.mode === 'a' && sha256(files.get('compiled/core.json')) !== manifest.coreIr.sha256) bad('compiled/core.json ≠ coreIr.sha256');
  if (sha256(files.get('policy/policy.aster')) !== manifest.source.sha256) bad('source.sha256');
  const probes = files.get('tests/probes.json');
  if (sha256(probes) !== manifest.tests.probesSha256) bad('tests.probesSha256');
  let doc;
  try {
    doc = parseStrictJson(probes, { maxDepth: 64, lossless: true });
  } catch {
    bad('tests/probes.json 不是严格 JSON');
  }
  if (!Array.isArray(doc?.probes) || doc.probes.length !== manifest.tests.probes) bad('tests.probes 条数');
}

/** 完整流水线（read → manifest → signature → integrity → A 包的 ir 严格读入）。 */
export function checkPackage(path, opts) {
  try {
    if (!existsSync(path)) fail('read', 'PKG_INTEGRITY', '包路径不存在');
    const st = statSync(path);
    // zip 先按 stat 的大小判上限，再读入内存（不得先读入再判断）
    if (st.isFile() && st.size > MAX_PACKAGE_BYTES) fail('read', 'PKG_INTEGRITY', 'zip 超过 64 MiB');
    const files = st.isDirectory() ? readDirectory(path) : st.isFile() ? readZip(readFileSync(path)) : fail('read', 'PKG_INTEGRITY', '既不是目录也不是文件');
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) fail('read', 'PKG_INVALID_MANIFEST', '缺 manifest.json');
    const manifest = checkManifest(manifestBytes, opts);
    const signed = checkSignature(files, manifestBytes, opts);
    checkIntegrity(files, manifest, manifestBytes);
    if (manifest.mode === 'a') {
      try {
        opts.readCoreIr(files.get('compiled/core.json').toString('utf8'));
      } catch (e) {
        // ir 阶段失败时仍带回已通过完整性校验的 manifest 与文件（inspect 不取 IR，verify 的前三项照常通过）
        return { ok: false, stage: 'ir', code: 'PKG_UNSUPPORTED_IR', why: `compiled/core.json 严格读入失败：${e.message}`, files, manifest, signed };
      }
    }
    return { ok: true, files, manifest, signed };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, stage: e.stage, code: e.code, why: e.message };
    throw e;
  }
}
