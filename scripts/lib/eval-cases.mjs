/**
 * eval-parity 的 cases-golden 验证 —— tag-eval-exempt.mjs 与 parity-tier1.mjs 共享的
 * **单一事实源**，消除"实时分类"与"守卫判定"两处逻辑漂移（Codex 复审要求）。
 *
 * validateEvalCasesDocument(doc) 判定一个已解析的 .cases.json 文档是否是**有效** golden：
 *   - null            = 有效（有 entry + 非空 cases 数组）
 *   - 字符串（原因）  = 无效（缺 entry / cases 非数组 / cases 空数组）
 *
 * 由 collectEvalCaseProblem(...) 把"文件层"失效（缺文件 / JSON 损坏）与文档层失效统一成
 * 一个"该样本是否缺有效 golden"的判定。非豁免样本命中即为 eval 盲区。
 */

/** 文档层校验：doc 已 JSON.parse。返回 null（有效）或原因字符串（无效）。 */
export function validateEvalCasesDocument(doc) {
  if (!doc || typeof doc !== 'object') return 'cases 文档非对象';
  if (!doc.entry) return '缺 entry';
  if (!Array.isArray(doc.cases)) return 'cases 非数组';
  if (doc.cases.length === 0) return 'cases 空数组';
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
