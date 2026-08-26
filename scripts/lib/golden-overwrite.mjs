/**
 * golden 覆盖前的丢失检测（gen-cases.mjs 的写入护栏）。
 *
 * ★抽成独立模块**是为了可测**：这段逻辑原本内联在 gen-cases.mjs 里，
 * 而 gen-cases 需要真跑两个引擎（分钟级），没法为它写快速回归测试。
 * 于是最该被锁住的分支反而零覆盖——我因此把 38 条已验证 golden
 * 覆盖成了 1 条（护栏自身的 ReferenceError 被兜底 catch 吞掉，
 * 伪装成「文件损坏 → 整体重建」）。
 */

/** case 的唯一键：entry 缺省时用文档级 entry。 */
export function caseKey(c, defaultEntry) {
  return `${c.entry ?? defaultEntry} ${c.name}`;
}

/**
 * 判断把 `nextCases` 写入会不会丢掉 `prevDoc` 里的 golden。
 *
 * @param prevDoc   既有 cases 文档；`null` 表示文件不存在，
 *                  `undefined` 表示存在但解析失败（调用方区分）
 * @returns `{ok:true}` | `{ok:false, reason:'lost'|'unparseable', lost:string[]}`
 *
 * ★`unparseable` 不等于「可以随便覆盖」：无法比对恰恰是最需要人看一眼的时刻。
 * 调用方须在 ALLOW_DROP 下才放行，与「有意替换」走同一道授权。
 */
export function detectGoldenLoss(prevDoc, nextCases, nextEntry) {
  if (prevDoc === null) return { ok: true };
  if (
    prevDoc === undefined ||
    typeof prevDoc !== 'object' ||
    !Array.isArray(prevDoc.cases)
  ) {
    return { ok: false, reason: 'unparseable', lost: [] };
  }
  const now = new Set(nextCases.map((c) => caseKey(c, nextEntry)));
  const lost = prevDoc.cases
    .filter((c) => !now.has(caseKey(c, prevDoc.entry)))
    .map((c) => `${c.entry ?? prevDoc.entry}/${c.name}`);
  return lost.length > 0 ? { ok: false, reason: 'lost', lost } : { ok: true };
}
