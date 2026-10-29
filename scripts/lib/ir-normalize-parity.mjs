/**
 * parity 门禁比较 IR 时使用的归一化入口。
 *
 * parity-tier1.mjs 是带顶层副作用的脚本，无法被测试直接 import；把这一层抽到这里，
 * 门禁与回归测试（scripts/test-ir-normalize-parity.mjs）才能共用同一个函数，
 * 测试得以断言「门禁实际使用的归一化」的行为，而不是对脚本源码做文本匹配。
 *
 * 规则本身仍只在 packages/js/src/ir-normalize.ts 定义（单一真相源）；这里只固定 parity 的选项：
 * includeResolution=true，使 origin.written / role（含签名与字段类型上的记录）参与比较（ADR 0051）。
 * contentHash 不经此处，保持默认 includeResolution=false。
 */
import { normalizeIr, DEFAULT_ORIGIN_MODE } from '../../packages/js/src/ir-normalize.ts';

/**
 * @param {unknown} node Core IR 节点
 * @param {string} [originMode] origin 比较粒度；由调用方（脚本）从环境读取后注入，库不读进程环境
 */
export function normalizeForParity(node, originMode = DEFAULT_ORIGIN_MODE) {
  return normalizeIr(node, { originMode, includeResolution: true });
}
