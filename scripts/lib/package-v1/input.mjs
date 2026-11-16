/**
 * `--input` 校验的参照实现（README「输入」）。两个 CLI 必须对同一字节给出同一结论；--verify-engines 用它证明
 * 每个成功用例的 stdin 合法、每个 inputs-invalid 用例都被拒绝。不进 CLI。
 *
 * 判定（任一不满足即 INPUT_INVALID）：
 *   1. 字节 ≤ 16 MiB；严格 JSON（strict-json.mjs，嵌套深度 ≤ 64，整数 token 无损读取）；
 *   2. 顶层是对象，键恰为入口全部形参名；
 *   3. 按 Core IR 形参类型逐层校验（类型映射见 README 表）。
 */
import { parseStrictJson, StrictJsonError } from './strict-json.mjs';

export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_INPUT_DEPTH = 64;
export const DECIMAL_MAX_DIGITS = 80;
const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const LONG_STRING = /^-?(0|[1-9][0-9]{0,18})$/;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkType(v, type, ctx, path) {
  const fail = (why) => {
    throw new InputError(`${path}: ${why}`);
  };
  switch (type.kind) {
    case 'List':
      if (!Array.isArray(v)) fail('期望数组');
      v.forEach((x, i) => checkType(x, type.type, ctx, `${path}[${i}]`));
      return;
    case 'Map':
      if (!isObject(v)) fail('期望对象');
      for (const [k, x] of Object.entries(v)) checkType(x, type.val, ctx, `${path}.${k}`);
      return;
    case 'Maybe':
    case 'Option':
      if (v === null) return;
      checkType(v, type.type, ctx, path);
      return;
    case 'TypeName':
      break;
    default:
      fail(`不支持的入参类型 ${type.kind}`);
  }
  switch (type.name) {
    case 'Int':
      if (typeof v !== 'bigint') fail('Int 必须是整数 token');
      if (v < INT32_MIN || v > INT32_MAX) fail('Int 超出 int32');
      return;
    case 'Long':
      if (typeof v === 'bigint') {
        if (v < -SAFE || v > SAFE) fail('Long 的整数 token 超出 ±(2⁵³−1)，须用十进制字符串');
        return;
      }
      if (typeof v !== 'string' || !LONG_STRING.test(v)) fail('Long 必须是安全整数 token 或十进制字符串');
      if (BigInt(v) < INT64_MIN || BigInt(v) > INT64_MAX) fail('Long 超出 int64');
      return;
    case 'Double':
      if (typeof v !== 'bigint' && typeof v !== 'number') fail('Double 必须是数字');
      if (typeof v === 'bigint' && !Number.isFinite(Number(v))) fail('Double 溢出');
      return;
    case 'Decimal':
      if (typeof v !== 'string' || !DECIMAL.test(v)) fail('Decimal 必须是十进制字符串');
      if (v.replace(/[-.]/g, '').length > DECIMAL_MAX_DIGITS) fail(`Decimal 超过 ${DECIMAL_MAX_DIGITS} 位数字`);
      return;
    case 'Text':
      if (typeof v !== 'string') fail('期望字符串');
      return;
    case 'Bool':
      if (typeof v !== 'boolean') fail('期望布尔');
      return;
    default:
      break;
  }
  const en = ctx.enums.get(type.name);
  if (en) {
    if (typeof v !== 'string' || !en.variants.includes(v)) fail(`不是 ${type.name} 的变体名`);
    return;
  }
  const data = ctx.datas.get(type.name);
  if (!data) fail(`未知类型 ${type.name}`);
  if (!isObject(v)) fail('期望对象');
  checkKeys(v, data.fields.map((f) => f.name), path);
  for (const f of data.fields) checkType(v[f.name], f.type, ctx, `${path}.${f.name}`);
}

function checkKeys(obj, names, path) {
  const keys = Object.keys(obj);
  const want = new Set(names);
  if (keys.length !== want.size || keys.some((k) => !want.has(k))) throw new InputError(`${path}: 键必须恰为 ${[...want].join(', ')}`);
}

/** 校验原始输入字节；通过返回解析后的值（整数为 BigInt），否则抛 InputError。 */
export function validateInput(bytes, coreIr, entry) {
  if (bytes.length > MAX_INPUT_BYTES) throw new InputError('输入超过 16 MiB');
  let v;
  try {
    v = parseStrictJson(bytes, { maxDepth: MAX_INPUT_DEPTH, lossless: true });
  } catch (e) {
    if (e instanceof StrictJsonError) throw new InputError(e.message);
    throw e;
  }
  const func = coreIr.decls.find((d) => d.kind === 'Func' && d.name === entry);
  if (!func) throw new Error(`入口 ${entry} 不在 IR 中`);
  if (!isObject(v)) throw new InputError('顶层必须是对象');
  checkKeys(v, func.params.map((p) => p.name), '$');
  const ctx = {
    datas: new Map(coreIr.decls.filter((d) => d.kind === 'Data').map((d) => [d.name, d])),
    enums: new Map(coreIr.decls.filter((d) => d.kind === 'Enum').map((d) => [d.name, d])),
  };
  for (const p of func.params) checkType(v[p.name], p.type, ctx, `$.${p.name}`);
  return v;
}
