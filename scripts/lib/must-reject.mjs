/**
 * 「双引擎都必须拒绝」（must-reject）样本的判定与 manifest 守卫。
 *
 * ★为什么需要：parse 门原本只能表达「两引擎都接受」，于是「两引擎都应拒绝」的输入
 * （例如运算符词前缀调用 `and(a, b)`）只有单引擎单测守着，另一侧放宽语法时没有任何
 * 跨引擎门会变红。must-reject 样本登记在 tier1-parity manifest 的 `mustReject` 中，
 * 仅参与 parse 门：两侧都以**解析错误**拒绝才算通过。
 *
 * 判定刻意不比对错误消息（两引擎措辞本就不同），只比对「是否拒绝」与可选的错误行号。
 * parity-tier1.mjs 与 test-must-reject.mjs 共用本模块（单一事实源）。
 */

/** must-reject 样本所在目录（相对 corpus/）。aster-lang-core 的 inventory 棘轮按同一前缀排除。 */
export const MUST_REJECT_DIR = 'tier1-reject';

/**
 * 判定一个 must-reject 样本。ts/java 形如 { ok, crash?, line?, err? }。
 * 返回 { verdict, reason }，verdict 为 'rejected' 才算通过。
 */
export function judgeMustReject({ ts, java, expectLine = null }) {
  if (ts.ok && java.ok) return { verdict: 'both-accepted', reason: 'TS accepted and Java accepted' };
  if (ts.ok) return { verdict: 'ts-accepted', reason: 'TS accepted (only Java rejects)' };
  if (java.ok) return { verdict: 'java-accepted', reason: 'Java accepted (only TS rejects)' };
  // 崩溃不是解析错误：引擎挂掉不能被当成「正确拒绝」
  if (ts.crash) return { verdict: 'ts-crashed', reason: `TS crashed instead of reporting a parse error: ${ts.err}` };
  if (java.crash) return { verdict: 'java-crashed', reason: `Java crashed instead of reporting a parse error: ${java.err}` };
  if (expectLine !== null && (ts.line !== expectLine || java.line !== expectLine)) {
    return {
      verdict: 'line-mismatch',
      reason: `expected error on L${expectLine}, got ts=L${ts.line ?? '?'} java=L${java.line ?? '?'}`,
    };
  }
  return { verdict: 'rejected', reason: null };
}

/**
 * 把 Java inventory 的逐样本结果转成拒绝信息。
 * inventory 的首个错误形如 `L4:9 mismatched input ...`（语法错误）或 `THROWN: ...`（崩溃）。
 */
export function javaRejection(res) {
  if (res.ok) return { ok: true };
  const err = res.err ?? null;
  const m = err ? /^L(\d+):\d+/.exec(err) : null;
  return {
    ok: false,
    crash: err !== null && err.startsWith('THROWN:'),
    line: m ? Number(m[1]) : null,
    err,
  };
}

/**
 * manifest 守卫。返回问题列表（空 = 一致）。
 * onDisk：tier1-reject/ 下实际存在的 .aster（相对 corpus/）；metaOf(rel)：读取样本 meta。
 */
export function checkMustRejectManifest({ mustReject, samples, onDisk, metaOf }) {
  const list = mustReject === undefined ? [] : mustReject;
  if (!Array.isArray(list)) return ['manifest.mustReject must be an array'];
  const problems = [];
  const listed = new Set(list);
  const sampleSet = new Set(samples);
  if (listed.size !== list.length) problems.push('manifest.mustReject has duplicate entries');
  for (const rel of list) problems.push(...entryProblems(rel, sampleSet, metaOf));
  for (const rel of onDisk) {
    if (!listed.has(rel)) {
      problems.push(`${rel} is under ${MUST_REJECT_DIR}/ but not in manifest.mustReject — the parse gate would SKIP it silently`);
    }
  }
  return problems;
}

function entryProblems(rel, sampleSet, metaOf) {
  if (!rel.startsWith(`${MUST_REJECT_DIR}/`)) {
    return [`${rel}: mustReject samples must live under corpus/${MUST_REJECT_DIR}/`];
  }
  if (sampleSet.has(rel)) return [`${rel}: listed in both samples and mustReject`];
  const meta = metaOf(rel) || {};
  const problems = [];
  if (meta.expect !== 'reject') problems.push(`${rel}: meta must declare "expect": "reject"`);
  const line = meta.expectErrorLine;
  if (line !== undefined && !(Number.isInteger(line) && line > 0)) {
    problems.push(`${rel}: meta.expectErrorLine must be a positive integer`);
  }
  return problems;
}
