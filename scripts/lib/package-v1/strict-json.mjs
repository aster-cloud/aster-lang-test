/**
 * 包格式 v1 的严格 JSON 读取（README「严格 JSON」）：manifest.json、manifest.sig.json、tests/probes.json 与 --input
 * 都按同一语法读，两个 CLI 才不会因为 JSON 库的缺省宽容度不同而给出不同的错误码。
 *
 *   - 字节必须是合法 UTF-8，且不得以 BOM（EF BB BF）开头；
 *   - RFC 8259 语法：恰好一个值，前后只允许空白（空格、\t、\n、\r）；字符串内不得有未转义的控制字符；
 *   - 对象内不得有重复键（按解码后的字符串比较）；
 *   - 字符串（含键）解码后不得含孤立代理项；
 *   - 嵌套深度（对象 / 数组层数）不超过 maxDepth；
 *   - 数字：lossless=true 时不含 . e E 的 token 解析为 BigInt（精确整数），其余为 double；溢出为 ±Infinity 即失败。
 *
 * 本文件是参照实现（--verify-engines 用它判定夹具），不进 CLI。
 */

export class StrictJsonError extends Error {
  constructor(reason, message) {
    super(`${reason}: ${message}`);
    this.name = 'StrictJsonError';
    this.reason = reason;
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const STRING = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

/** bytes（Buffer / Uint8Array）或已解码的字符串 → 值。 */
export function parseStrictJson(input, { maxDepth = 64, lossless = false } = {}) {
  let text;
  if (typeof input === 'string') text = input;
  else {
    const bytes = Buffer.from(input);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new StrictJsonError('bom', '以 UTF-8 BOM 开头');
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new StrictJsonError('utf8', '不是合法 UTF-8');
    }
  }
  let i = 0;
  const ws = () => {
    while (i < text.length && WS.has(text.charCodeAt(i))) i++;
  };
  const str = () => {
    const m = STRING.exec(text.slice(i, i + Math.min(text.length - i, 1 << 26)));
    if (!m) throw new StrictJsonError('syntax', `非法字符串（位置 ${i}）`);
    i += m[0].length;
    const s = JSON.parse(m[0]);
    if (!s.isWellFormed()) throw new StrictJsonError('surrogate', '字符串含孤立代理项');
    return s;
  };
  const value = (depth) => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth + 1 > maxDepth) throw new StrictJsonError('depth', `嵌套深度超过 ${maxDepth}`);
    }
    if (c === '{') {
      i++;
      const out = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new StrictJsonError('syntax', `期望键（位置 ${i}）`);
        const k = str();
        if (seen.has(k)) throw new StrictJsonError('duplicate', `重复键 ${k}`);
        seen.add(k);
        ws();
        if (text[i] !== ':') throw new StrictJsonError('syntax', `期望 :（位置 ${i}）`);
        i++;
        Object.defineProperty(out, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        throw new StrictJsonError('syntax', `期望 , 或 }（位置 ${i}）`);
      }
    }
    if (c === '[') {
      i++;
      const out = [];
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        throw new StrictJsonError('syntax', `期望 , 或 ]（位置 ${i}）`);
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    const m = NUMBER.exec(text.slice(i, i + 4096));
    if (!m) throw new StrictJsonError('syntax', `非法值（位置 ${i}）`);
    i += m[0].length;
    const tok = m[0];
    if (lossless && !/[.eE]/.test(tok)) return BigInt(tok);
    const n = Number(tok);
    if (!Number.isFinite(n)) throw new StrictJsonError('range', `数字溢出 ${tok}`);
    return n;
  };
  const v = value(0);
  ws();
  if (i !== text.length) throw new StrictJsonError('trailing', `值之后有多余内容（位置 ${i}）`);
  return v;
}

/** 数字 token 的原文是否为整数形态（无 . e E）——供输入校验判 Int / Long。lossless 解析后整数即 BigInt。 */
export const isIntegerValue = (v) => typeof v === 'bigint';
