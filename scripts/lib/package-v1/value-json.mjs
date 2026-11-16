/**
 * 值规范 JSON 的参照实现（ADR 0059 修订 1 A1；规则见 conformance/package-v1/VALUE-FORMS.md）。
 *
 * `run` 信封里的 `value` 与 probes 比较都用它：对象键按 Unicode 码点升序；无空白；字符串按 RFC 8785 §3.2.2.2
 * 转义（与 JSON.stringify 相同）；整数（含 Long，不限 2⁵³）输出精确十进制；非整数 Double 按 RFC 8785 §3.2.2.3
 * （ECMAScript Number::toString）；`-0` 输出 `0`；NaN / ±Infinity 不可能出现（出现即报错）。
 *
 * 树的表示（与引擎无关，供向量使用）：JSON 文本里不含 `.`、`e`、`E` 的数字 token 是精确整数（解析为 BigInt），
 * 其余数字 token 是 IEEE-754 double（解析为 Number）。ts T3 `value-json.ts` 与 JVM T8 `ValueJson.java` 各实现一份，
 * 跑同一组 `vectors/value-json.json`。本文件只供夹具生成器与向量生成使用。
 */
import { compareByCodePoint } from './canonical.mjs';

export class ValueJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueJsonError';
  }
}

const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;

/** 无损解析值树：整数 token → BigInt，其他数字 token → Number（非有限值报错）。 */
export function parseValueTree(text) {
  return JSON.parse(text, function reviver(_key, value, context) {
    if (typeof value !== 'number') return value;
    const source = context.source;
    if (INTEGER_TOKEN.test(source)) return BigInt(source);
    if (!Number.isFinite(value)) throw new ValueJsonError(`数字超出 double 范围：${source}`);
    return value;
  });
}

/** 由 16 位十六进制位模式构造 double（大端，`vectors/value-json.json` 随机向量的表示）。 */
export function doubleFromBits(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 8) throw new ValueJsonError(`位模式必须是 8 字节：${hex}`);
  return buf.readDoubleBE(0);
}

/** double 的位模式（16 位小写十六进制，大端）。 */
export function bitsOfDouble(x) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(x, 0);
  return buf.toString('hex');
}

function string(s) {
  if (!s.isWellFormed()) throw new ValueJsonError('字符串含孤立代理项');
  return JSON.stringify(s);
}

/** 值树 → 值规范 JSON 文本。 */
export function valueJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isFinite(value)) throw new ValueJsonError(`值中不得出现 ${value}`);
      // ECMAScript Number::toString 即 RFC 8785 §3.2.2.3；String(-0) === "0"。
      return String(value);
    case 'string':
      return string(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(valueJson).join(',')}]`;
      const keys = Object.keys(value).sort(compareByCodePoint);
      return `{${keys.map((k) => `${string(k)}:${valueJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new ValueJsonError(`不支持的值类型：${typeof value}`);
  }
}
