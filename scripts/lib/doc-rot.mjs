/**
 * 文档「内联计数」锈蚀检测：在指定文档区间内找出 `N/N` 计数与四位小数率字面量。
 *
 * ★为什么存在：DIVERGENT-MANIFEST.md / README.md 曾内联 parse/ir/eval 的实时数字
 * （217/217、206/206、131/131 …），而实时值只存在于 history CSV 的最新行，
 * 每一份手抄快照都在几周内过期，且互相矛盾（issue #147、#149）。与其每次比对
 * 「文档数字 vs 实时数字」，不如**禁止内联**——文档只允许指向单一事实源。
 * 抽成纯函数是为了可测（tag-eval-exempt.mjs 读真实文件，不便构造反例）。
 */

/** `N/N`、`N / N` 计数，或 `= 1.0000` 这类四位小数率字面量。 */
const INLINE_COUNT = /\b\d+\s*\/\s*\d+\b|=\s*[01]\.\d{4}\b/g;

/**
 * 从 `text` 中切出受检区间：`from` 命中处（缺省为文件开头）到其后 `until`
 * 命中处（缺省为文件结尾）。`from` 给了但找不到时返回 null，让调用方把
 * 「区间标题被改名」当成漂移报出来，而不是静默通过。
 */
export function sliceRegion(text, { from = null, until = null } = {}) {
  let start = 0;
  if (from) {
    const m = text.match(from);
    if (!m) return null;
    start = m.index;
  }
  let end = text.length;
  if (until) {
    const rest = text.slice(start);
    const m = rest.match(until);
    if (m) end = start + m.index;
  }
  return text.slice(start, end);
}

/**
 * 返回区间内每一处内联计数的 `{line, match}`（line 为整份文档中的 1-based 行号）。
 * 区间不存在时返回 `[{line: 0, match: '<region not found>'}]`，同样视为漂移。
 */
export function findInlineCounts(text, region = {}) {
  const body = sliceRegion(text, region);
  if (body === null) return [{ line: 0, match: '<region not found>' }];
  const offset = region.from ? text.match(region.from).index : 0;
  const hits = [];
  for (const m of body.matchAll(INLINE_COUNT)) {
    const line = text.slice(0, offset + m.index).split('\n').length;
    hits.push({ line, match: m[0] });
  }
  return hits;
}
