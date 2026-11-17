/**
 * 跨 CLI 一致性门（scripts/package-conformance.mjs）的判定部分，独立成纯函数以便单测：
 *   coverageProblems：用例数下限（不给 --filter 时等于各 cases 文件的行数之和；给 --filter 时至少 1 条）。
 *   judgeRow：单条用例的结论 ok / known / fail。knownEngineDivergence 只豁免标明分歧的那一侧的期望比较，
 *     另一侧仍须等于期望；分歧一侧仍须正常运行（退出码在 exit-codes.json 表内、stdout 是 JSON）；分歧消失时判失败，提醒去掉标记。
 *   groupRouteSets：按 https 配方声明的 routes 分组，每组各起一个服务，配方之间不会拿到别人的路由。
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
