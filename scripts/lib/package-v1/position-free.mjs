/**
 * `coreIr.positionFreeSha256`（ADR 0059 修订 1 A2）的参照实现。
 *
 * 定义：把规范 Core IR v2 字节读入，只删除每个 `origin` 对象的 `start.col` 与 `end.col`，再按规范 JSON
 * （canonical.mjs，与 ts `canonicalJson` / core `CanonicalJson` 同字节）序列化，取 UTF-8 字节的 SHA-256（小写 hex）。
 * 与 scripts/lib/ir-byte-parity.mjs 的比较投影同一定义。Core IR v2 schema 要求每个 Origin 的 start / end 都带
 * 整数 `col`；缺失或非整数在严格读入阶段即失败（CLI 侧由 `readCoreIr` / `CoreIrJson.read` 报错，B 包按
 * PKG_IR_DRIFT 处理），这里以抛错模拟。不得用全局文本替换实现。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function dropOriginCols(node) {
  if (Array.isArray(node)) {
    node.forEach(dropOriginCols);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'origin' && isObject(value)) {
      for (const side of ['start', 'end']) {
        if (!isObject(value[side]) || !Number.isInteger(value[side].col)) {
          throw new Error(`origin.${side}.col 缺失或不是整数`);
        }
        delete value[side].col;
      }
    }
    dropOriginCols(value);
  }
}

/** 返回去掉 origin 列后的新树（不修改入参）。 */
export function positionFreeTree(tree) {
  const copy = structuredClone(tree);
  dropOriginCols(copy);
  return copy;
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 规范 Core IR 文本 → positionFreeSha256。 */
export function positionFreeSha256(coreJson) {
  return sha256Hex(Buffer.from(canonicalJson(positionFreeTree(JSON.parse(coreJson))), 'utf8'));
}
