/**
 * 包格式 v1 的规范 JSON（manifest、manifest.sig.json、IR 投影、包内 JSON 载荷）。
 *
 * 规则与 ADR 0055 §5 / ts `canonicalJson`（空 TypeContext）/ core `CanonicalJson.canonicalJson` 相同：
 * 对象键按 Unicode 码点升序、数组保序、`null` 显式输出、无空白、字符串按 JSON.stringify 转义（RFC 8785 §3.2.2.2）、
 * 数字只允许安全整数（±(2⁵³−1)）。manifest schema 把键限制为 ASCII、数字限制为整数，所以在 manifest 域内
 * 本序列化与 RFC 8785 JCS 字节相同（`build-package-fixtures.mjs --verify-engines` 用 aster-guard `jcs.ts` 与
 * ts `canonicalJson` 逐条对照证明）。
 *
 * 本模块是夹具生成器自用的参照实现，不进任何 CLI；值（求值结果）的序列化用 value-json.mjs，不用这里。
 */
import { parseStrictJson } from './strict-json.mjs';

export class CanonicalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalError';
  }
}

/** 按 Unicode 码点比较（代理对按其码点，而非 UTF-16 码元）。 */
export function compareByCodePoint(a, b) {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0) - bi[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

function canonicalString(s) {
  if (!s.isWellFormed()) throw new CanonicalError('字符串含孤立代理项');
  return JSON.stringify(s);
}

function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 返回规范 JSON 文本；值不在规范域内（非整数、超安全整数、非 JSON 值）时抛 CanonicalError。 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalError(`数字不在规范域内（只允许安全整数）：${value}`);
      return String(value);
    case 'string':
      return canonicalString(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      if (!isPlainObject(value)) throw new CanonicalError('不是纯对象');
      return `{${Object.keys(value)
        .sort(compareByCodePoint)
        .map((k) => {
          if (value[k] === undefined) throw new CanonicalError(`键 ${k} 的值为 undefined`);
          return `${canonicalString(k)}:${canonicalJson(value[k])}`;
        })
        .join(',')}}`;
    default:
      throw new CanonicalError(`不支持的值类型：${typeof value}`);
  }
}

/**
 * manifest.json 的第一道检查（否则 PKG_INVALID_MANIFEST）：**文件字节**按严格 JSON 读入后，其规范 JSON 的 UTF-8 字节必须与原字节
 * 逐字节相同。按字节而不是按解码后的文本比较：BOM、非法 UTF-8、转义的孤立代理项在文本比较下可能被解码器吞掉或替换。
 * 重复键在严格 JSON 阶段即失败。
 */
export function isCanonicalJsonBytes(bytes) {
  let tree;
  try {
    tree = parseStrictJson(bytes, { maxDepth: 64 });
  } catch {
    return false;
  }
  try {
    return Buffer.from(canonicalJson(tree), 'utf8').equals(Buffer.from(bytes));
  } catch {
    return false;
  }
}
