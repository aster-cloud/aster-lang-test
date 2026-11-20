/**
 * aster-lang-core `TsSampleParseInventoryTest` 输出的解析与逐样本判定。
 *
 * ★为什么抽成共享模块：parity-tier1.mjs（PR-blocking）与 equivalence-nightly.mjs
 * 都靠这份 gradle 输出判定「Java 引擎能否解析某样本」。该测试**只打印失败行**，
 * 所以 runner 天然倾向于「不在失败清单 = 通过」——这在样本被 Java 真正看过时才成立。
 * 陈旧的 Maven 语料缺少某个新增样本时，它既不在失败行也不在任何地方，
 * 若默认通过就是假绿（issue #132）。因此判定必须以 core 逐条输出的
 * `OBSERVED <path>` 清单为准：未观测 ≠ 通过。两个 runner 共用同一实现，避免漂移。
 *
 * 输出格式（由 core 侧 TsSampleParseInventoryTest 约定）：
 *   `=== TS-engine sample → Java parser inventory ===`   marker，证明测试跑到了
 *   `Discovered N samples (...)`                          总数
 *   `| corpus/<path> | ❌ | <err> |`                       失败行（仅失败）
 *   `OBSERVED corpus/<path>`                               逐样本观测行
 *   `Total: T, Pass: P, Fail: F, Pass-rate: X%`           汇总（inventoryCountProblem 据此核对逐行解析的计数）
 *
 * ★注意 core 只扫描 meta.engines 含 "ts" 且 tier != 3 的样本；
 * tier2-divergent/java-only（engines=["java"]）不在其中，放进去的样本会被判为未观测。
 */

export const INVENTORY_MARKER = '=== TS-engine sample → Java parser inventory ===';

/**
 * 输出完整性检查。返回 null 表示可信；否则返回可直接报错的说明。
 * 基础设施失败（依赖缺失、编译错、语料未 publish）时 gradle 非零且没有表格，
 * 输出里不会有任何失败行——这正是最容易被误判为「全过」的情形。
 */
export function inventoryOutputProblem(status, output) {
  if (status !== 0 && !output.includes(INVENTORY_MARKER)) {
    return 'aster-lang-core inventory test failed:\n' + output.slice(-2000);
  }
  if (!output.includes('Discovered ') || !output.includes('Pass-rate:')) {
    return 'aster-lang-core inventory test output incomplete:\n' + output.slice(-2000);
  }
  return null;
}

/**
 * 从输出中提取已观测集合、失败集合与失败样本的首个错误文本，路径均为相对 corpus/ 的形式。
 * 错误文本供 must-reject 门取行号（`L4:9 ...`）并区分崩溃（`THROWN: ...`）。
 */
export function parseInventoryOutput(output) {
  const observed = new Set();
  const failed = new Set();
  const errors = new Map();
  let summary = null;
  for (const line of output.split('\n')) {
    const t = line.match(/^\s*Total:\s*(\d+),\s*Pass:\s*(\d+),\s*Fail:\s*(\d+),/);
    if (t) summary = { total: Number(t[1]), pass: Number(t[2]), fail: Number(t[3]) };
    const o = line.match(/^\s*OBSERVED\s+(\S+\.aster)\s*$/);
    if (o) observed.add(o[1].replace(/^corpus\//, ''));
    // 错误文本用 [^\n]* 而不是 .*：`.` 不匹配 U+2028 / U+2029，Java 报「token recognition error at: '<U+2028>'」时
    // 整行失配，该样本会被当成「不在失败清单 = 通过」（aster-lang-ts#348 的必拒样本即如此，fail-open）
    const f = line.match(/^\s*\|\s*(corpus\/[^|]+?\.aster)\s*\|\s*❌\s*\|([^\n]*)\|\s*$/);
    if (!f) continue;
    const rel = f[1].trim().replace(/^corpus\//, '');
    failed.add(rel);
    errors.set(rel, f[2].trim());
  }
  return { observed, failed, errors, summary };
}

/**
 * 计数交叉核对（aster-lang-test#226 m-1）。返回 null 表示一致；否则返回可直接报错的说明。
 *
 * 失败行与 OBSERVED 行都靠正则逐行识别，任何一行因格式意外（例如错误文本里出现原始换行）失配，
 * 该样本就会悄悄变成「不在失败清单 = 通过」。core 的汇总行 `Total: T, Pass: P, Fail: F` 与逐行输出出自同一次扫描，
 * 解析出的失败样本数必须等于 F、已观测样本数必须等于 T，否则拒绝给出结论（fail-closed）。
 */
export function inventoryCountProblem({ observed, failed, summary }) {
  if (summary === null || summary === undefined) {
    return 'aster-lang-core inventory output has no "Total: T, Pass: P, Fail: F" summary line; refusing to report a verdict.';
  }
  const problems = [];
  if (failed.size !== summary.fail) {
    problems.push(`parsed ${failed.size} failure row(s) but the summary says Fail: ${summary.fail}`);
  }
  if (observed.size !== summary.total) {
    problems.push(`parsed ${observed.size} OBSERVED line(s) but the summary says Total: ${summary.total}`);
  }
  if (problems.length === 0) return null;
  return 'aster-lang-core inventory output does not add up — some rows were not recognised and would fail open:\n  - '
    + problems.join('\n  - ');
}

/**
 * 逐样本判定。rels 为相对 corpus/ 的样本路径。
 * 已观测：ok = 不在失败清单；未观测：ok=false 并写明原因，同时汇总到 unobserved，
 * 由调用方决定是拒绝给出结论（PR 门）还是记为失败进入统计（nightly）。
 */
export function judgeSamples(rels, { observed, failed, errors = new Map() }) {
  const results = {};
  const unobserved = [];
  for (const rel of rels) {
    if (!observed.has(rel)) {
      unobserved.push(rel);
      results[rel] = { ok: false, err: 'not observed by Java inventory (stale corpus artifact or not scanned)' };
    } else {
      results[rel] = failed.has(rel) ? { ok: false, err: errors.get(rel) ?? null } : { ok: true };
    }
  }
  return { results, unobserved };
}
