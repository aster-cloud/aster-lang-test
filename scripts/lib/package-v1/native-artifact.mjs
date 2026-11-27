/**
 * 从 aster-lang-truffle CI 的 `native (<target>)` job 取原生可执行文件（ADR 0063 T4，scripts/fetch-native-cli.mjs 用）的选择规则，
 * 独立成纯函数以便单测。原生产物没有发布渠道（ADR 0063 §6.3 的签名凭据到位前不发布），唯一来源是 truffle CI 上传的
 * workflow artifact `aster-native-<target>`（保留 7 天）。
 *
 * 规则：
 *   1. 首选与检出的 truffle commit（checkout-sibling 解析出的同名分支或 main 的 tip）相同 head_sha 的 run；
 *      它的原生 job 还没结束时由调用方有界等待，结束后有可执行文件就用（一致性失败的 run 也上传了可执行文件，照样拿来复现），
 *      没有可执行文件（nativeCompile 失败）即失败，不回落旧产物，避免拿旧二进制掩盖构建失败。
 *   2. 没有该 commit 的 run（分支没开 PR、run 被取消、产物过期）时，回落到同一分支上最新一个带未过期产物的 run，
 *      并在报告里写明产物的 commit 与检出的 commit 不同。
 */

/** truffle ci.yml 里原生矩阵的 job 显示名与 artifact 名（两边改名时同步改这里）。 */
export const nativeJobName = (target) => `native (${target})`;
export const nativeArtifactName = (target) => `aster-native-${target}`;

/**
 * runs：GitHub `actions/workflows/ci.yml/runs` 的 workflow_runs（任意顺序）。返回 { exact, fallbacks }：
 * exact 为 head_sha 等于 sha 的最新 run（没有为 null）；fallbacks 为其余 run，按 id 降序（新的在前）。
 * 只看 push 与 pull_request 事件（与 checkout-sibling 的分支语义一致）。
 */
export function orderRuns(runs, sha) {
  const relevant = runs.filter((r) => r.event === 'push' || r.event === 'pull_request').sort((a, b) => b.id - a.id);
  const exact = relevant.find((r) => r.head_sha === sha) ?? null;
  return { exact, fallbacks: relevant.filter((r) => r.head_sha !== sha) };
}

/** jobs：某 run 最新 attempt 的 jobs；返回原生 job（缺失或重名为 null）。 */
export function nativeJob(jobs, target) {
  const hits = jobs.filter((j) => j.name === nativeJobName(target));
  return hits.length === 1 ? hits[0] : null;
}

/** artifacts：某 run 的 artifacts；返回未过期的 `aster-native-<target>`（没有为 null）。 */
export function nativeArtifact(artifacts, target) {
  return artifacts.find((a) => a.name === nativeArtifactName(target) && !a.expired) ?? null;
}
