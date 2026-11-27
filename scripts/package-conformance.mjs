#!/usr/bin/env node
/**
 * 跨 CLI 一致性门（ADR 0059 P1 T11）：用 Node CLI（aster-lang-ts 的 dist/runner/aster.mjs）与 JVM CLI（aster-lang-truffle 的
 * aster-cli fat jar）各跑一遍 conformance/package-v1 的全部用例：
 *   packages/*.cases.json、tamper/cases.json、inputs-invalid/cases.json、compile/cases.json、tamper/test-time.json（运行时生成），
 *   以及包格式 1.1 的 display/packages/*.cases.json、display/tamper/cases.json（ADR 0059 修订 4）。
 * 原生侧（ADR 0063 T4）：再给 --native <exe> 时，aster-cli 的 GraalVM 原生可执行文件作为第三侧以同样的规则参与比较；
 * 只给 --node 与 --native（不给 --jar）时比较 Node ↔ 原生两侧。下文的「两侧」此时指全部参与比较的侧。
 * 带 requiresFormat 的用例只在两侧 `version` 的 formatVersions 都含该版本时运行，否则记为 skipped 并列入报告；
 * 给 --strict-formats 时（列车之后）任一侧不支持即失败。show 成功时 stdout 不是 JSON，按字节与 expectedStdout 比较。
 * 每条用例两侧的 stdout 先经 normalize-stdout.mjs 归一（修订 A0），再比较：①两侧归一后的 stdout 与退出码逐字节相同；
 * ②每一侧都等于用例的 expectedStdout / expectedExit。compile 成功用例比较投影哈希（README「compile」）。
 * 带 knownEngineDivergence 的用例只豁免 knownDivergentEngine 那一侧的期望比较：另一侧仍须等于期望，分歧一侧仍须正常运行；
 * native 与 jre 是同一个引擎，标 jre 的分歧同样豁免 native，但 jar 与原生两侧归一后仍须一致；
 * 分歧消失（两侧一致且等于期望）判失败，提醒去掉标记（判定见 lib/package-v1/gate.mjs）。
 * 用例数有下限：不给 --filter 时须跑完各 cases 文件的全部行（每个文件都不得缺失或为空），给 --filter 时至少匹配一条。
 * 报告列出运行环境（并发、核数、前后负载）与每条用例两侧耗时（aster-lang-test#226 m-3），用来区分负载抖动与真分歧。
 *
 * 用法：
 *   node scripts/package-conformance.mjs --node <aster.mjs> (--jar <aster-cli.jar> | --native <aster> | 两者都给)
 *        [--report-only] [--concurrency 4] [--filter <子串>] [--report <file.md>] [--strict-formats]
 *   --report-only：只出报告，退出码恒为 0（接入 CI 之前用）。
 * 退出码：0 全部一致（或 --report-only）；1 有不一致或用例数不足；2 用法错误（含 CLI 文件不存在）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStdout } from '../conformance/package-v1/normalize-stdout.mjs';
import { positionFreeSha256 } from './lib/package-v1/position-free.mjs';
import { coverageProblems, formatGate, groupRouteSets, judgeRow, routeSetKey, timingSummary } from './lib/package-v1/gate.mjs';
import { materializePackage, recipeStdin, selfSignedCert, startRecipeServer } from './lib/package-v1/recipes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'conformance', 'package-v1');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const nodeCli = opt('--node');
const jar = opt('--jar');
const nativeExe = opt('--native');
if (!nodeCli || (!jar && !nativeExe)) {
  console.error('用法：node scripts/package-conformance.mjs --node <aster.mjs> (--jar <aster-cli.jar> | --native <aster>) [--report-only] [--concurrency N] [--filter s] [--report f] [--strict-formats]');
  process.exit(2);
}
for (const f of [nodeCli, jar, nativeExe].filter(Boolean)) {
  if (!existsSync(f)) {
    console.error(`package-conformance: ${f} 不存在`);
    process.exit(2);
  }
}
const reportOnly = argv.includes('--report-only');
const concurrency = Number(opt('--concurrency', '4'));
const filter = opt('--filter');
const strictFormats = argv.includes('--strict-formats');
const PROCESS_TIMEOUT_MS = 120_000;

/**
 * 各侧 CLI 的调用方式（键序即报告里的列序）。每次都清掉会影响结果的环境变量（ASTER_TRUFFLE_FUNC 会使 JVM CLI 直接 USAGE，
 * 原生可执行文件读同一组环境变量）。
 */
const SIDES = {
  node: (args) => [process.execPath, [resolve(nodeCli), ...args]],
  ...(jar && { jre: (args) => ['java', ['-jar', resolve(jar), ...args]] }),
  ...(nativeExe && { native: (args) => [resolve(nativeExe), args] }),
};
const SIDE_LIST = Object.keys(SIDES);
/** 两侧时报告措辞与加原生侧之前逐字节相同。 */
const SIDES_WORD = SIDE_LIST.length === 2 ? '两侧' : '各侧';
function baseEnv() {
  const env = { ...process.env };
  delete env.ASTER_TRUFFLE_FUNC;
  delete env.ASTER_ANCHOR_CA_FILE;
  return env;
}

function run(side, args, { cwd, stdin, env }) {
  const [cmd, full] = SIDES[side](args);
  return new Promise((resolveRun) => {
    const child = spawn(cmd, full, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);
    let settled = false;
    const done = (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exit });
    };
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    // 起不来（如找不到 java）记为非表内退出码，判定时视为没有正常运行
    child.on('error', (e) => done(`spawn error ${e.code ?? e.message}`));
    child.on('close', (code, signal) => done(signal ? `signal ${signal}` : code));
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// 收集用例
// ---------------------------------------------------------------------------
// 每个 cases 文件都必须存在且非空；用例总数（下限）由这些文件推导，夹具树缺失或放错位置时直接失败
function loadCases() {
  const rows = [];
  const add = (rel, extra = {}) => {
    const file = join(PKG, rel);
    if (!existsSync(file)) throw new Error(`缺少用例文件 ${rel}`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(doc.cases) || doc.cases.length === 0) throw new Error(`用例文件 ${rel} 没有用例`);
    for (const c of doc.cases) rows.push({ file: rel, cwd: join(PKG, dirname(rel)), c, ...extra });
  };
  const packageCases = readdirSync(join(PKG, 'packages')).filter((n) => n.endsWith('.cases.json')).sort();
  if (packageCases.length === 0) throw new Error('packages/ 下没有 *.cases.json');
  for (const f of packageCases) add(`packages/${f}`);
  add('tamper/cases.json');
  add('inputs-invalid/cases.json');
  add('compile/cases.json', { compile: true });
  add('tamper/test-time.json', { testTime: true });
  // 包格式 1.1（显示排版）：单独目录，现有 CLI 的运行器不读（计划裁决 PR1）
  const displayCases = readdirSync(join(PKG, 'display', 'packages')).filter((n) => n.endsWith('.cases.json')).sort();
  if (displayCases.length === 0) throw new Error('display/packages/ 下没有 *.cases.json');
  for (const f of displayCases) add(`display/packages/${f}`);
  add('display/tamper/cases.json');
  return filter ? rows.filter((r) => `${r.file}/${r.c.name}`.includes(filter)) : rows;
}

// ---------------------------------------------------------------------------
// 单条用例：准备 → 两侧各跑一遍 → 判定
// ---------------------------------------------------------------------------
async function prepare(row, ctx) {
  const { c } = row;
  const cleanups = [];
  let args = [...c.args];
  const env = baseEnv();
  let stdin = c.stdinB64 !== undefined ? Buffer.from(c.stdinB64, 'base64') : c.stdin !== undefined ? Buffer.from(c.stdin, 'utf8') : undefined;
  if (row.testTime) {
    const recipe = c.recipe ?? {};
    const pkg = materializePackage(recipe, PKG);
    if (pkg) cleanups.push(pkg.cleanup);
    if (c.stdinRecipe) stdin = recipeStdin(c.stdinRecipe);
    for (const [k, v] of Object.entries(recipe.env ?? {})) env[k] = v.replace('<CA_PEM>', ctx.cert?.certFile ?? '');
    args = args.map((a) => a.replaceAll('<PACKAGE_V1>', PKG).replaceAll('<PKG>', pkg?.path ?? '').replaceAll('<PORT>', String(ctx.servers?.get(routeSetKey(recipe.httpsServer?.routes))?.port ?? 0)));
  }
  // compile --out <OUT>：每一侧各用一个临时路径（目录先建好，文件不存在）
  return { args, env, stdin, cleanups };
}

function judgeOne(row, res, outFile) {
  const { c } = row;
  const problems = [];
  if (res.exit !== c.expectedExit) problems.push(`退出码 ${res.exit}，期望 ${c.expectedExit}`);
  if (c.expectedStdout === null || (c.expectedStdout === '' && c.expectedPositionFreeSha256)) {
    // compile 成功：stdout 为 IR + \n（无 --out）或空（--out）；比较投影哈希
    let ir;
    if (c.outFile) {
      if (res.stdout !== '') problems.push('给 --out 时 stdout 应为空');
      ir = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
      if (ir === null) problems.push('--out 文件未生成');
    } else {
      if (!res.stdout.endsWith('\n')) problems.push('stdout 应以 \\n 结尾');
      ir = res.stdout.slice(0, -1);
    }
    if (ir !== null) {
      let pf = null;
      try {
        pf = positionFreeSha256(ir);
      } catch (e) {
        problems.push(`stdout 不是 Core IR：${e.message}`);
      }
      if (pf !== null && pf !== c.expectedPositionFreeSha256) problems.push(`投影哈希 ${pf}，期望 ${c.expectedPositionFreeSha256}`);
    }
    return { problems, comparable: `pf:${problems.length ? 'x' : c.expectedPositionFreeSha256}|${res.exit}` };
  }
  const norm = normalizeStdout(res.stdout);
  if (norm !== c.expectedStdout) problems.push(`stdout 不符\n      实际 ${norm.trim().slice(0, 400)}\n      期望 ${c.expectedStdout.trim().slice(0, 400)}`);
  if (c.outFileMustNotExist && existsSync(outFile)) problems.push('失败时不得写出 --out 文件');
  return { problems, comparable: `${norm}|${res.exit}` };
}

async function runRow(row, ctx) {
  const prep = await prepare(row, ctx);
  const results = {};
  try {
    for (const side of Object.keys(SIDES)) {
      let args = prep.args;
      let outFile;
      if (args.includes('<OUT>')) {
        const d = mkdtempSync(join(tmpdir(), 'pkgv1-out-'));
        prep.cleanups.push(() => rmSync(d, { recursive: true, force: true }));
        outFile = join(d, 'core.json');
        args = args.map((a) => (a === '<OUT>' ? outFile : a));
      }
      const t0 = Date.now();
      const res = await run(side, args, { cwd: row.cwd, stdin: prep.stdin, env: prep.env });
      res.ms = Date.now() - t0;
      results[side] = { res, ...judgeOne(row, res, outFile) };
    }
  } finally {
    for (const f of prep.cleanups) f();
  }
  const { status, reasons } = judgeRow(row, results);
  const sameAcross = SIDE_LIST.every((s) => results[s].comparable === results.node.comparable);
  return { row, results, sameAcross, status, reasons, known: row.c.knownEngineDivergence };
}

// ---------------------------------------------------------------------------
/** 一侧 CLI 的 version.formatVersions；读不出为 null。 */
async function formatsOf(side) {
  const r = await run(side, ['version'], { cwd: PKG, stdin: undefined, env: baseEnv() });
  try {
    const v = JSON.parse(r.stdout);
    return Array.isArray(v.formatVersions) ? v.formatVersions : null;
  } catch {
    return null;
  }
}

async function main() {
  const loaded = loadCases();
  const sideFormats = {};
  for (const side of SIDE_LIST) sideFormats[side] = await formatsOf(side);
  const gateOf = new Map(loaded.map((r) => [r, formatGate(r, sideFormats, { strict: strictFormats })]));
  const skipped = loaded.filter((r) => gateOf.get(r) === 'skipped');
  const gateFailed = loaded.filter((r) => gateOf.get(r) === 'fail');
  const rows = loaded.filter((r) => gateOf.get(r) === 'run');
  const ctx = {};
  // https 配方按声明的 routes 分组，每组各起一个服务（共用一张自签名证书）
  const routeSets = groupRouteSets(rows);
  if (routeSets.size) {
    ctx.cert = selfSignedCert();
    if (!ctx.cert) throw new Error('需要 openssl 生成本地 https 配方用的自签名证书');
    ctx.servers = new Map();
    for (const [key, routes] of routeSets) ctx.servers.set(key, await startRecipeServer(routes, ctx.cert, join(PKG, 'keys/test-jwks.json')));
  }
  const outcomes = [];
  const loadBefore = loadavg();
  const started = Date.now();
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const o = await runRow(row, ctx);
      outcomes.push(o);
      if (o.status !== 'ok') process.stderr.write(`${o.status === 'known' ? '~' : '✗'} ${row.file}/${row.c.name}\n`);
    }
  });
  await Promise.all(workers);
  const wallMs = Date.now() - started;
  const loadAfter = loadavg();
  for (const server of ctx.servers?.values() ?? []) server.close();
  if (ctx.cert) rmSync(ctx.cert.dir, { recursive: true, force: true });

  outcomes.sort((a, b) => `${a.row.file}/${a.row.c.name}`.localeCompare(`${b.row.file}/${b.row.c.name}`));
  const failing = outcomes.filter((o) => o.status === 'fail');
  const knownDiverging = outcomes.filter((o) => o.status === 'known');
  const identical = outcomes.filter((o) => o.status === 'ok').length;
  const coverage = coverageProblems({ expected: loaded.length, ran: outcomes.length + skipped.length + gateFailed.length, filter });
  const formatLine = `- formatVersions：${SIDE_LIST.map((s) => `${s} ${JSON.stringify(sideFormats[s])}`).join('，')}；按 requiresFormat 跳过：${skipped.length}${strictFormats ? '（--strict-formats）' : ''}`;
  const lines = [
    '# 跨 CLI 一致性门（ADR 0059 P1 T11）',
    '',
    `- Node CLI：\`${nodeCli}\``,
    ...(jar ? [`- JVM CLI：\`${jar}\``] : []),
    ...(nativeExe ? [`- 原生 CLI：\`${nativeExe}\``] : []),
    `- 用例：${outcomes.length}；${SIDES_WORD}一致且等于期望：**${identical}/${outcomes.length}**；不一致：**${failing.length}**；已知引擎分歧（不计失败）：${knownDiverging.length}`,
    formatLine,
    `- 运行环境：并发 ${concurrency}，${cpus().length} 核，墙钟 ${wallMs} ms；1 分钟负载 开始 ${loadBefore[0].toFixed(2)} / 结束 ${loadAfter[0].toFixed(2)}（单进程超时 ${PROCESS_TIMEOUT_MS} ms）`,
    ...coverage.map((p) => `- **用例数不足**：${p}`),
    ...gateFailed.map((r) => `- **CLI 不支持 requiresFormat ${r.c.requiresFormat}**：${r.file}/${r.c.name}`),
    '',
  ];
  const describe = (o) => {
    const out = [`### ${o.row.file} / ${o.row.c.name}${o.known ? `（已知分歧：${o.known}）` : ''}`, '', `- 参数：\`${JSON.stringify(o.row.c.args)}\``, `- ${SIDES_WORD}归一后一致：${o.sameAcross ? '是' : '否'}`, ...o.reasons.map((r) => `- **${r}**`)];
    for (const side of SIDE_LIST) {
      const r = o.results[side];
      out.push(`- ${side}（${r.res.ms} ms，退出码 ${r.res.exit}）：${r.problems.length ? '' : '符合期望'}`);
      for (const p of r.problems) out.push(`  - ${p}`);
      if (r.problems.length && r.res.stderr.trim()) out.push(`  - stderr：${r.res.stderr.trim().split('\n').slice(0, 3).join(' / ').slice(0, 300)}`);
    }
    out.push('');
    return out;
  };
  if (failing.length) lines.push('## 不一致', '', ...failing.flatMap(describe));
  if (knownDiverging.length) lines.push('## 已知引擎分歧', '', ...knownDiverging.flatMap(describe));
  // 每条用例各侧耗时（#226 m-3）：不一致的行若耗时远高于同侧中位数、或接近超时，多半是负载抖动而非真分歧
  const timingRows = outcomes.map((o) => ({ name: `${o.row.file}/${o.row.c.name}`, status: o.status, ...Object.fromEntries(SIDE_LIST.map((s) => [s, o.results[s].res.ms])) }));
  const timing = timingSummary(timingRows, { timeoutMs: PROCESS_TIMEOUT_MS, sides: SIDE_LIST });
  const fmt = (x) => (x === null || x === undefined ? '-' : `${x}`);
  const caseHeader = [`| 用例 | 结论 | ${SIDE_LIST.map((s) => `${s} ms`).join(' | ')} |`, `|---|---|${SIDE_LIST.map(() => '---|').join('')}`];
  const caseRow = (r) => `| ${r.name} | ${r.status} | ${SIDE_LIST.map((s) => fmt(r[s])).join(' | ')} |`;
  lines.push(
    '## 耗时',
    '',
    '| 侧 | 中位数 ms | p95 ms | 最大 ms |',
    '|---|---|---|---|',
    ...SIDE_LIST.map((side) => `| ${side} | ${fmt(timing.sides[side].median)} | ${fmt(timing.sides[side].p95)} | ${fmt(timing.sides[side].max)} |`),
    '',
    ...(timing.slow.length ? [`- **耗时达到超时一半的用例**（${timing.slow.length}）：${timing.slow.join('、')}`, ''] : []),
    `最慢的 ${timing.slowest.length} 条：`,
    '',
    ...caseHeader,
    ...timing.slowest.map(caseRow),
    '',
    '<details><summary>全部用例耗时</summary>',
    '',
    ...caseHeader,
    ...timingRows.map(caseRow),
    '',
    '</details>',
    '',
  );
  if (skipped.length) lines.push('## 按 requiresFormat 跳过', '', ...skipped.map((r) => `- ${r.file} / ${r.c.name}（requiresFormat ${r.c.requiresFormat}）`), '');
  const report = `${lines.join('\n')}\n`;
  const reportFile = opt('--report');
  if (reportFile) writeFileSync(reportFile, report);
  process.stdout.write(report);
  console.log(`identical ${identical}/${outcomes.length}, ${failing.length} divergent${knownDiverging.length ? `, ${knownDiverging.length} known divergence` : ''}`);
  for (const p of coverage) console.error(`package-conformance: ${p}`);
  if (skipped.length) console.log(`skipped ${skipped.length} case(s) requiring a format one of the CLIs does not support`);
  process.exitCode = reportOnly || (failing.length === 0 && coverage.length === 0 && gateFailed.length === 0) ? 0 : 1;
}

await main();
