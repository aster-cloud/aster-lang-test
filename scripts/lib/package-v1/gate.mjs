/**
 * 跨 CLI 一致性门（scripts/package-conformance.mjs）的判定部分，独立成纯函数以便单测：
 *   coverageProblems：用例数下限（不给 --filter 时等于各 cases 文件的行数之和；给 --filter 时至少 1 条）。
 *   judgeRow：单条用例的结论 ok / known / fail。knownEngineDivergence 只豁免标明分歧的那一侧的期望比较，
 *     另一侧仍须等于期望；分歧一侧仍须正常运行（退出码在 exit-codes.json 表内、stdout 是 JSON）；分歧消失时判失败，提醒去掉标记。
 *   groupRouteSets：按 https 配方声明的 routes 分组，每组各起一个服务，配方之间不会拿到别人的路由。
 *   formatGate：带 requiresFormat 的用例只在两侧 CLI 的 version.formatVersions 都含该版本时运行（计划裁决 PR1）。
 */

export const SIDE_NAMES = ['node', 'jre'];
/** exit-codes.json 定义的全部退出码；不在表内（含信号、启动失败）说明 CLI 没有正常结束。 */
const DEFINED_EXITS = new Set([0, 1, 2, 3, 4, 5]);

export function coverageProblems({ expected, ran, filter }) {
  if (expected === 0) return [filter ? `--filter ${JSON.stringify(filter)} 没有匹配任何用例` : '没有加载到任何用例'];
  if (ran < expected) return [`只跑了 ${ran}/${expected} 条用例`];
  return [];
}

/** CLI 正常结束：退出码在表内，stdout 是一个 JSON 值加结尾 \n（错误信封、run 结果或 Core IR）。 */
export function ranCleanly(res) {
  if (typeof res.exit !== 'number' || !DEFINED_EXITS.has(res.exit)) return false;
  if (!res.stdout.endsWith('\n')) return false;
  try {
    JSON.parse(res.stdout);
    return true;
  } catch {
    return false;
  }
}

/**
 * row.c 为用例；results[side] = { res: { exit, stdout }, problems: string[], comparable: string }。
 * 返回 { status: 'ok' | 'known' | 'fail', reasons: string[] }。
 */
export function judgeRow(row, results) {
  const sameAcross = results.node.comparable === results.jre.comparable;
  const clean = SIDE_NAMES.every((s) => results[s].problems.length === 0);
  const marker = row.c.knownEngineDivergence;
  if (!marker) return sameAcross && clean ? { status: 'ok', reasons: [] } : { status: 'fail', reasons: sameAcross ? [] : ['两侧归一后不一致'] };

  const divergent = row.c.knownDivergentEngine;
  if (!SIDE_NAMES.includes(divergent)) return { status: 'fail', reasons: [`knownEngineDivergence 缺少 knownDivergentEngine（node / jre），得到 ${JSON.stringify(divergent)}`] };
  const other = SIDE_NAMES.find((s) => s !== divergent);
  const reasons = [];
  if (results[other].problems.length) reasons.push(`未标分歧的一侧（${other}）不等于期望`);
  if (!ranCleanly(results[divergent].res)) reasons.push(`标分歧的一侧（${divergent}）没有正常运行：退出码 ${results[divergent].res.exit}`);
  if (reasons.length) return { status: 'fail', reasons };
  if (clean && sameAcross) return { status: 'fail', reasons: [`stale knownEngineDivergence: remove marker（${marker} 的分歧已消失）`] };
  return { status: 'known', reasons: [] };
}

/** 按 routes 的规范化 JSON 分组；返回 Map<key, routes>，配方用 routeSetKey 取自己那一组的服务。 */
export function routeSetKey(routes) {
  return JSON.stringify(Object.keys(routes ?? {}).sort().map((k) => [k, routes[k]]));
}

export function groupRouteSets(rows) {
  const groups = new Map();
  for (const r of rows) {
    const routes = r.c.recipe?.httpsServer?.routes;
    if (r.c.recipe?.httpsServer && !groups.has(routeSetKey(routes))) groups.set(routeSetKey(routes), routes);
  }
  return groups;
}

/**
 * 能力门控（ADR 0059 修订 4 计划裁决 PR1）：用例带 requiresFormat 时，两侧 `version` 的 formatVersions 都含该值才运行，
 * 否则 skipped（报告列出）；strict 为真时（列车之后，T5 Step 4）任一侧缺少即失败。
 * sideFormats = { node: string[] | null, jre: string[] | null }（null 表示 version 输出读不出）。
 * 返回 'run' | 'skipped' | 'fail'。
 */
export function formatGate(row, sideFormats, { strict = false } = {}) {
  const need = row.c.requiresFormat;
  if (need === undefined) return 'run';
  const both = SIDE_NAMES.every((s) => Array.isArray(sideFormats[s]) && sideFormats[s].includes(need));
  if (both) return 'run';
  return strict ? 'fail' : 'skipped';
}

/** 升序数组的 p 分位（最近秩法，p ∈ (0, 1]）；空数组为 null。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/**
 * 每条用例两侧耗时的汇总（aster-lang-test#226 m-3）：判断一次不一致是负载抖动还是真分歧。
 * 负载下的超时、被杀或启动慢会让某一侧的耗时远高于同侧其余用例，接近 timeoutMs 时更可疑。
 * rows：[{ name, status, node: ms, jre: ms }]；返回每侧的 { median, p95, max } 与按两侧较大耗时降序的前 top 条，
 * 并标出耗时达到 timeoutMs 一半的行（slow）。
 */
export function timingSummary(rows, { timeoutMs, top = 10 }) {
  const sides = {};
  for (const side of ['node', 'jre']) {
    const ms = rows.map((r) => r[side]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    sides[side] = { median: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: ms.length ? ms[ms.length - 1] : null };
  }
  const worst = (r) => Math.max(r.node ?? 0, r.jre ?? 0);
  const slowest = [...rows].sort((a, b) => worst(b) - worst(a) || a.name.localeCompare(b.name)).slice(0, top);
  const slow = rows.filter((r) => worst(r) >= timeoutMs / 2).map((r) => r.name);
  return { sides, slowest, slow };
}
