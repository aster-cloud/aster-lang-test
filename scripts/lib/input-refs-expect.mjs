/**
 * 治理输入引用样本的期望值核对（ADR 0046 §11 D2 / §11.6，aster-lang-core#257 / aster-lang-ts#312）。
 *
 * IR parity 只证明「Java 与 TS 相同」；两引擎同时算错也会全绿。声明了 `expectedInputRefs` 的样本
 * （.meta.json）在 `--mode=ir --full` 下额外断言两引擎的 inputRefs 都等于期望值：
 *
 *   "expectedInputRefs": { "<函数名>": ["context.amount"] | null, … }   // 必须列出模块中的每个函数；null = 不写该字段
 *   "expectedInputRefConstructs": { "<函数名>": "dynamic-map-key", … }  // inputRefs 为 ["*"] 的函数各自的 E708 construct
 *
 * construct 不进 IR：TS 侧由 dist 的 analyzeInputRefs 计算，Java 侧由 CoreIrFingerprintCli 的 inputRefConstructs 字段给出。
 * parity-tier1.mjs 与 test-input-refs-expect.mjs 共用本模块（单一事实源）。
 */

/** Core IR 中各函数的 inputRefs：{ 函数名 → 数组 | null }（缺字段记 null）。 */
export function inputRefsOf(ir) {
  const out = {};
  for (const d of Array.isArray(ir?.decls) ? ir.decls : []) {
    if (d && d.kind === 'Func') out[d.name] = Array.isArray(d.inputRefs) ? [...d.inputRefs] : null;
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 核对一个引擎的结果。meta 没有 expectedInputRefs 时返回 []（不适用）。
 * constructs 为 undefined 表示该引擎没有给出 construct（旧版本）；期望中有 construct 时报问题。
 * 返回问题描述（字符串）数组，空数组 = 一致。
 */
export function inputRefsProblems(engine, meta, ir, constructs) {
  const expected = meta?.expectedInputRefs;
  if (expected === undefined) return [];
  const problems = [];
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return [`meta.expectedInputRefs 须为 { 函数名 → 数组 | null } 对象`];
  }
  const actual = inputRefsOf(ir);
  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!(name in actual)) problems.push(`${engine}: 期望中的函数 ${name} 不在 IR 中`);
    else if (!(name in expected)) problems.push(`${engine}: 函数 ${name} 未在 expectedInputRefs 中列出`);
    else if (!same(actual[name], expected[name])) {
      problems.push(`${engine}: ${name}.inputRefs=${JSON.stringify(actual[name])}，期望 ${JSON.stringify(expected[name])}`);
    }
  }
  const wantConstructs = meta.expectedInputRefConstructs ?? {};
  for (const [name, refs] of Object.entries(expected)) {
    const star = Array.isArray(refs) && refs.length === 1 && refs[0] === '*';
    if (star && !(name in wantConstructs)) problems.push(`meta: ${name} 的 inputRefs 为 ["*"]，须在 expectedInputRefConstructs 中写明 construct`);
  }
  for (const [name, want] of Object.entries(wantConstructs)) {
    if (constructs === undefined) {
      problems.push(`${engine}: 未给出 construct（引擎版本过旧？），期望 ${name}=${want}`);
      continue;
    }
    if (constructs[name] !== want) problems.push(`${engine}: ${name} 的 construct=${JSON.stringify(constructs[name] ?? null)}，期望 ${JSON.stringify(want)}`);
  }
  for (const name of Object.keys(constructs ?? {})) {
    if (!(name in wantConstructs)) problems.push(`${engine}: ${name} 有 construct ${constructs[name]}，期望中没有`);
  }
  return problems;
}
