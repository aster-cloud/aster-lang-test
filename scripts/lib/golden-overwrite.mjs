/**
 * golden 覆盖前的丢失检测（gen-cases.mjs 的写入护栏）。
 *
 * ★抽成独立模块**是为了可测**：这段逻辑原本内联在 gen-cases.mjs 里，
 * 而 gen-cases 需要真跑两个引擎（分钟级），没法为它写快速回归测试。
 * 于是最该被锁住的分支反而零覆盖——我因此把 38 条已验证 golden
 * 覆盖成了 1 条（护栏自身的 ReferenceError 被兜底 catch 吞掉，
 * 伪装成「文件损坏 → 整体重建」）。
 */

/**
 * 「既有文件不存在」的哨兵。
 *
 * ★不能用 `null` 表达：JSON 内容本身就可能是合法的 `null`，
 * 两者混用会让一个内容为 `null` 的文件被当成"没有文件"而无授权覆盖。
 */
export const FILE_ABSENT = Symbol('file-absent');

/** case 的唯一键：entry 缺省时用文档级 entry。 */
export function caseKey(c, defaultEntry) {
  return `${c.entry ?? defaultEntry} ${c.name}`;
}

/**
 * case 的**断言内容**指纹：输入 + 期望（或 expectError 契约）。
 *
 * ★为什么必须有：护栏原先只比 `entry + name`，于是「键相同、断言内容被改」
 * 读作「没有丢失」而静默放行。实测可把一条名为
 * `未成年 premium = 100` 的 golden 改写成 `expectedOutput: 999` 且 exit 0。
 * 名字承诺 100、断言体断言 999——正是本仓最该防的那类腐坏。
 */
export function caseAssertion(c) {
  return JSON.stringify(
    c.expectError === true
      ? { input: c.input ?? null, expectError: true }
      : { input: c.input ?? null, expectedOutput: c.expectedOutput ?? null },
  );
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
  // ★「文件不存在」必须由调用方用**独立哨兵** FILE_ABSENT 表达，不能用 null：
  //   既有文件的内容完全可能是合法 JSON `null`，若把它也当成"不存在"，
  //   就会无授权整体覆盖（Codex 复审抓出）。
  if (prevDoc === FILE_ABSENT) return { ok: true };
  if (
    prevDoc === undefined ||
    prevDoc === null ||
    typeof prevDoc !== 'object' ||
    !Array.isArray(prevDoc.cases)
  ) {
    // ★两个清单都给空数组：调用方（现在或将来）读 `.length` 时不会因
    //   字段缺失而崩。Codex 指出 unparseable 的 lost 目前无人消费——属实，
    //   但缺字段的代价是运行时崩溃，保留的代价只是一个空数组。
    return { ok: false, reason: 'unparseable', lost: [], rewritten: [] };
  }
  // 键 → 断言内容，用于同时检出「整条消失」与「键在但断言被改写」。
  const now = new Map(nextCases.map((c) => [caseKey(c, nextEntry), caseAssertion(c)]));
  const lost = [];
  const rewritten = [];
  for (const c of prevDoc.cases) {
    const k = caseKey(c, prevDoc.entry);
    const label = `${c.entry ?? prevDoc.entry}/${c.name}`;
    if (!now.has(k)) {
      lost.push(label);
      continue;
    }
    // ★键相同不代表内容相同。断言被改写同样是「既有 golden 不再成立」，
    //   必须与整条丢失走同一道授权闸门，否则可以静默把 100 改成 999。
    const before = caseAssertion(c);
    const after = now.get(k);
    if (before !== after) rewritten.push(`${label}: ${before} → ${after}`);
  }
  if (lost.length > 0 || rewritten.length > 0) {
    return { ok: false, reason: lost.length > 0 ? 'lost' : 'rewritten', lost, rewritten };
  }
  return { ok: true };
}
