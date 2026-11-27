#!/usr/bin/env node
/**
 * 取 aster-cli 的 GraalVM 原生可执行文件，供 package-conformance.mjs --native 使用（ADR 0063 T4）。
 * 原生产物还没有发布渠道（ADR 0063 §6.3：签名凭据到位前不发布），唯一来源是 aster-lang-truffle CI 的 `native (<target>)` job
 * 上传的 workflow artifact `aster-native-<target>`（保留 30 天）。选择规则见 lib/package-v1/native-artifact.mjs：
 * 首选与 --sha（checkout-sibling 检出的 truffle commit）相同的 run，其原生 job 未结束时最多等 --wait-minutes；
 * 没有该 commit 的 run 时回落到 --branch 上最新一个带未过期产物的 run（--branch 不是 main 时其后再找 main），并写明 commit 不同。
 *
 * 用法：
 *   node scripts/fetch-native-cli.mjs --branch <truffle 分支> --sha <truffle commit> --target linux-x64 --out <dir>
 *        [--repo aster-cloud/aster-lang-truffle] [--wait-minutes 20]
 * 需要 gh（GH_TOKEN 对 --repo 有 actions 读权限）。成功时 stdout 末行为可执行文件的绝对路径；在 GitHub Actions 里
 * 另写 step output（exe、run-url、sha、exact）与 step summary。
 * 退出码：0 取到并能运行 `version`；1 没有可用产物或产物不能运行；2 用法错误。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nativeArtifact, nativeArtifactName, nativeJob, nativeJobName, orderRuns } from './lib/package-v1/native-artifact.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const repo = opt('--repo', 'aster-cloud/aster-lang-truffle');
const branch = opt('--branch');
const sha = opt('--sha');
const target = opt('--target');
const out = opt('--out');
const waitMinutes = Number(opt('--wait-minutes', '20'));
if (!branch || !/^[0-9a-f]{40}$/.test(sha ?? '') || !target || !out || !Number.isFinite(waitMinutes)) {
  console.error('用法：node scripts/fetch-native-cli.mjs --branch <b> --sha <40 位 commit> --target <linux-x64|…> --out <dir> [--repo o/r] [--wait-minutes N]');
  process.exit(2);
}
const POLL_MS = 30_000;

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const api = (path) => JSON.parse(gh('api', path));
const log = (s) => console.error(`fetch-native-cli: ${s}`);
const summary = (s) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => s.slice(0, 12);

const jobsOf = (run) => api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs;
const artifactsOf = (run) => api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts;

/** 等 run 的原生 job 结束（有界）；返回结束后的 job，超时或缺失为 null。 */
async function awaitNativeJob(run) {
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const job = nativeJob(jobsOf(run), target);
    if (job?.status === 'completed') return job;
    if (Date.now() >= deadline) return null;
    log(`${nativeJobName(target)} @ ${short(run.head_sha)}：${job?.status ?? '尚未出现'}，${POLL_MS / 1000} s 后再查（最多等 ${waitMinutes} 分钟）`);
    await sleep(POLL_MS);
  }
}

/** 下载 artifact 并找出其中的可执行文件（upload-artifact 按公共祖先目录保存，路径层级随 runner 而变，按文件名找）。 */
function download(run) {
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  gh('run', 'download', String(run.id), '-R', repo, '-n', nativeArtifactName(target), '-D', dir);
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const exe = walk(dir).find((f) => f.endsWith('/nativeCompile/aster') || f.endsWith('/nativeCompile/aster.exe'));
  if (!exe) return null;
  chmodSync(exe, 0o755);
  return exe;
}

function finish(run, exe, exact) {
  let version;
  try {
    version = execFileSync(exe, ['version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    log(`可执行文件不能运行 version：${e.message}`);
    process.exit(1);
  }
  const lines = [
    `### 原生 CLI（${target}）`,
    '',
    `- 来源：${repo} run [${run.id}](${run.html_url})（${run.event}，${run.head_branch} @ \`${short(run.head_sha)}\`）`,
    exact ? `- 与检出的 truffle commit \`${short(sha)}\` 相同` : `- ⚠️ 检出的 truffle commit 是 \`${short(sha)}\`，它没有可用的原生产物；用的是 \`${short(run.head_sha)}\` 的产物`,
    `- version：\`${version}\``,
  ];
  summary(lines.join('\n'));
  if (!exact) console.log(`::warning title=native CLI from another commit::truffle ${short(sha)} has no native artifact; using ${short(run.head_sha)} (run ${run.id})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `exe=${exe}\nrun-url=${run.html_url}\nsha=${run.head_sha}\nexact=${exact}\n`);
  log(lines.slice(2).join('；'));
  console.log(exe);
  process.exit(0);
}

/** ci.yml 的 run（翻完全部页）。query 为 head_sha=… 或 branch=…&created=>=…；--jq 逐条输出，避免多页 JSON 对象拼接。 */
const listRuns = (query) =>
  gh('api', '--paginate', `repos/${repo}/actions/workflows/ci.yml/runs?${query}&per_page=100`, '--jq', '.workflow_runs[] | tojson')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
// 产物保留 30 天（truffle ci.yml 的 retention-days）：回落只需看最近 31 天的 run
const since = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
const runsOn = (b) => listRuns(`branch=${encodeURIComponent(b)}&created=${encodeURIComponent(`>=${since}`)}`);

async function main() {
  // 同 commit 的 run 按 head_sha 直接查（不限分支：该 commit 只在 main 上有 run 时也能命中）
  const { exact } = orderRuns(listRuns(`head_sha=${sha}`), sha);
  const { fallbacks } = orderRuns(runsOn(branch), sha);
  if (exact) {
    const job = await awaitNativeJob(exact);
    if (!job) {
      log(`${exact.html_url} 的 ${nativeJobName(target)} 在 ${waitMinutes} 分钟内没有结束`);
      process.exit(1);
    }
    const exe = nativeArtifact(artifactsOf(exact), target) && download(exact);
    if (exe) return finish(exact, exe, true);
    // 该 commit 的原生构建没有产出可执行文件（nativeCompile 失败）：这本身就是结论，不回落旧产物
    log(`${exact.html_url} 的 ${nativeJobName(target)} 结论 ${job.conclusion}，没有可执行文件（${nativeArtifactName(target)} 缺失、过期或不含 aster）`);
    process.exit(1);
  }
  log(`${repo} ${branch} 上没有 ${short(sha)} 的 CI run，回落到该分支${branch === 'main' ? '' : '（其后 main）'}最新的原生产物`);
  const candidates = branch === 'main' ? fallbacks : [...fallbacks, ...orderRuns(runsOn('main'), sha).fallbacks];
  for (const run of candidates) {
    if (nativeJob(jobsOf(run), target)?.status !== 'completed' || !nativeArtifact(artifactsOf(run), target)) continue;
    const exe = download(run);
    if (exe) return finish(run, exe, false);
  }
  log(`${repo} ${branch}${branch === 'main' ? '' : ' / main'} 上没有带未过期 ${nativeArtifactName(target)} 的 run（产物保留 30 天）`);
  process.exit(1);
}

await main();
