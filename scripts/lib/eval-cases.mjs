/**
 * eval-parity 的 cases-golden 验证 —— tag-eval-exempt.mjs 与 parity-tier1.mjs 共享的
 * **单一事实源**，消除"实时分类"与"守卫判定"两处逻辑漂移（Codex 复审要求）。
 *
 * validateEvalCasesDocument(doc) 判定一个已解析的 .cases.json 文档是否是**有效** golden：
 *   - null            = 有效（有 entry + 非空 cases 数组）
 *   - 字符串（原因）  = 无效（缺 entry / cases 非数组 / cases 空数组 / case 级 entry 非字符串）
 *
 * 由 collectEvalCaseProblem(...) 把"文件层"失效（缺文件 / JSON 损坏）与文档层失效统一成
 * 一个"该样本是否缺有效 golden"的判定。非豁免样本命中即为 eval 盲区。
 *
 * **多 entry 支持**：一个 policy 常含多条 rule，早期约定一个 .cases.json 只能测一个
 * `doc.entry`，导致同文件其余 rule 只被解析、从不被求值（隐性 eval 盲区——正是
 * not-precedence 里 notNot/notAnd 的处境）。现允许单个 case 用可选的 `entry` 字段覆盖
 * 文档级默认值：
 *
 *   { "entry": "notCompare",            // 文档级默认（仍必填，兼容存量文件）
 *     "cases": [
 *       { "name": "...", "input": [5,3], "expectedOutput": false },              // 用默认
 *       { "name": "...", "entry": "notNot", "input": [true], "expectedOutput": true }  // 覆盖
 *     ] }
 *
 * 保留 `doc.entry` 必填是刻意的：它既是默认值，也让"缺 entry"守卫对存量文件继续生效。
 *
 * **错误路径用例（`expectError`）**：全部 golden 原本只断言正常返回值，跨引擎的**错误
 * 语义**从未被触发过——不是"测了没发现"，而是"从未被输入触发"（issue #69）。
 * `classifyEval` 本就能区分 ts-only-failed / java-only-failed / both-failed，却没有
 * 任何 case 会走到那里，且 `both-failed` 一律算失败，无法表达"两侧都**应该**失败"。
 *
 *   { "name": "除零", "input": [10, 0], "expectError": true }
 *
 * 语义：**两个引擎都必须失败**才算通过；任一侧返回值即判失败（说明该引擎没拒绝非法
 * 输入）。刻意**不比对错误消息**——消息是实现细节（Java 带堆栈与中文提示、TS 是短句），
 * 强行对齐只会制造脆弱断言；契约是"拒绝与否"，不是"怎么措辞"。
 * 带 `expectError` 时不应再写 `expectedOutput`（写了会被忽略，故校验直接拒绝）。
 */

/** 取某个 case 实际使用的 entry：case 级覆盖优先，否则回落文档级默认。 */
export function entryForCase(doc, testCase) {
  return (testCase && testCase.entry) || doc.entry;
}

/** 该 case 是否断言"两引擎都应失败"。 */
export function expectsError(testCase) {
  return testCase != null && testCase.expectError === true;
}

/** 文档层校验：doc 已 JSON.parse。返回 null（有效）或原因字符串（无效）。 */
export function validateEvalCasesDocument(doc) {
  if (!doc || typeof doc !== 'object') return 'cases 文档非对象';
  if (!doc.entry) return '缺 entry';
  if (!Array.isArray(doc.cases)) return 'cases 非数组';
  if (doc.cases.length === 0) return 'cases 空数组';
  // case 级 entry 是可选的；一旦出现就必须是非空字符串，否则会静默回落到文档默认
  // 而把本想测的 rule 悄悄换掉——那正是本机制要消灭的盲区。
  for (let i = 0; i < doc.cases.length; i++) {
    const e = doc.cases[i].entry;
    if (e !== undefined && (typeof e !== 'string' || e.length === 0)) {
      return `cases[${i}].entry 非空字符串`;
    }
    // expectError 只接受字面 true：写成 "true" / 1 之类会被 === true 判否而**静默
    // 退回值比对**，把一条本想测错误路径的用例悄悄变成 happy-path。
    const ee = doc.cases[i].expectError;
    if (ee !== undefined && ee !== true) {
      return `cases[${i}].expectError 只能是 true（省略即普通值断言）`;
    }
    // expectError 与 expectedOutput 互斥：两者同时出现时 expectedOutput 必然被忽略，
    // 留着只会让读者误以为它生效。
    if (ee === true && Object.prototype.hasOwnProperty.call(doc.cases[i], 'expectedOutput')) {
      return `cases[${i}] 同时有 expectError 与 expectedOutput（互斥）`;
    }
  }
  return null;
}

/**
 * 综合判定一个样本是否缺**有效** golden（供守卫用）。
 * @param {object} p
 * @param {boolean} p.exists      cases 文件是否存在
 * @param {string|null} p.parseError  读取/解析 cases 文件的错误信息（null=无错）
 * @param {object|null} p.doc     已解析的 cases 文档（parseError 非 null 时为 null）
 * @returns {string|null} 缺有效 golden 的原因；有效则 null。
 */
export function collectEvalCaseProblem({ exists, parseError, doc }) {
  if (!exists) return '缺 .cases.json';
  if (parseError) return `.cases.json 解析失败: ${parseError}`;
  const docProblem = validateEvalCasesDocument(doc);
  return docProblem ? `.cases.json ${docProblem}` : null;
}
