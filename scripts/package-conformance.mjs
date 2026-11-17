#!/usr/bin/env node
/**
 * 跨 CLI 一致性门（ADR 0059 P1 T11）：用 Node CLI（aster-lang-ts 的 dist/runner/aster.mjs）与 JVM CLI（aster-lang-truffle 的
 * aster-cli fat jar）各跑一遍 conformance/package-v1 的全部用例：
 *   packages/*.cases.json、tamper/cases.json、inputs-invalid/cases.json、compile/cases.json、tamper/test-time.json（运行时生成）。
 * 每条用例两侧的 stdout 先经 normalize-stdout.mjs 归一（修订 A0），再比较：①两侧归一后的 stdout 与退出码逐字节相同；
 * ②每一侧都等于用例的 expectedStdout / expectedExit。compile 成功用例比较投影哈希（README「compile」）。
 * 带 knownEngineDivergence 的用例照常运行并报告，但不计为失败（已有跟踪 issue）。
 *
 * 用法：
 *   node scripts/package-conformance.mjs --node <aster.mjs> --jar <aster-cli.jar> [--report-only] [--concurrency 4]
 *        [--filter <子串>] [--report <file.md>]
 *   --report-only：只出报告，退出码恒为 0（接入 CI 之前用）。
 * 退出码：0 全部一致（或 --report-only）；1 有不一致；2 用法错误。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStdout } from '../conformance/package-v1/normalize-stdout.mjs';
import { positionFreeSha256 } from './lib/package-v1/position-free.mjs';
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
if (!nodeCli || !jar) {
  console.error('用法：node scripts/package-conformance.mjs --node <aster.mjs> --jar <aster-cli.jar> [--report-only] [--concurrency N] [--filter s] [--report f]');
  process.exit(2);
}
const reportOnly = argv.includes('--report-only');
const concurrency = Number(opt('--concurrency', '4'));
const filter = opt('--filter');
const PROCESS_TIMEOUT_MS = 120_000;

/** 两侧 CLI 的调用方式。每次都清掉会影响结果的环境变量（ASTER_TRUFFLE_FUNC 会使 JVM CLI 直接 USAGE）。 */
const SIDES = {
  node: (args) => [process.execPath, [resolve(nodeCli), ...args]],
  jre: (args) => ['java', ['-jar', resolve(jar), ...args]],
};
function baseEnv() {
  const env = { ...process.env };
  delete env.ASTER_TRUFFLE_FUNC;
  delete env.ASTER_ANCHOR_CA_FILE;
  return env;
}

function run(side, args, { cwd, stdin, env }) {
  const [cmd, full] = SIDES[side](args);
  return new Promise((done) => {
    const child = spawn(cmd, full, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exit: signal ? `signal ${signal}` : code });
    });
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// 收集用例
// ---------------------------------------------------------------------------
function loadCases() {
  const rows = [];
  const add = (rel, extra = {}) => {
    const doc = JSON.parse(readFileSync(join(PKG, rel), 'utf8'));
    for (const c of doc.cases) rows.push({ file: rel, cwd: join(PKG, dirname(rel)), c, ...extra });
  };
  for (const f of readdirSync(join(PKG, 'packages')).filter((n) => n.endsWith('.cases.json')).sort()) add(`packages/${f}`);
  add('tamper/cases.json');
  add('inputs-invalid/cases.json');
  add('compile/cases.json', { compile: true });
  add('tamper/test-time.json', { testTime: true });
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
    args = args.map((a) => a.replaceAll('<PACKAGE_V1>', PKG).replaceAll('<PKG>', pkg?.path ?? '').replaceAll('<PORT>', String(ctx.server?.port ?? 0)));
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
  const sameAcross = results.node.comparable === results.jre.comparable;
  const ok = sameAcross && results.node.problems.length === 0 && results.jre.problems.length === 0;
  return { row, results, sameAcross, ok, known: row.c.knownEngineDivergence };
}

// ---------------------------------------------------------------------------
async function main() {
  const rows = loadCases();
  const ctx = {};
  if (rows.some((r) => r.c.recipe?.httpsServer)) {
    ctx.cert = selfSignedCert();
    if (!ctx.cert) throw new Error('需要 openssl 生成本地 https 配方用的自签名证书');
    const routes = rows.find((r) => r.c.recipe?.httpsServer).c.recipe.httpsServer.routes;
    ctx.server = await startRecipeServer(routes, ctx.cert, join(PKG, 'keys/test-jwks.json'));
  }
  const outcomes = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const o = await runRow(row, ctx);
      outcomes.push(o);
      if (!o.ok) process.stderr.write(`${o.known ? '~' : '✗'} ${row.file}/${row.c.name}\n`);
    }
  });
  await Promise.all(workers);
  ctx.server?.close();
  if (ctx.cert) rmSync(ctx.cert.dir, { recursive: true, force: true });

  outcomes.sort((a, b) => `${a.row.file}/${a.row.c.name}`.localeCompare(`${b.row.file}/${b.row.c.name}`));
  const failing = outcomes.filter((o) => !o.ok && !o.known);
  const knownDiverging = outcomes.filter((o) => !o.ok && o.known);
  const identical = outcomes.filter((o) => o.ok).length;
  const lines = [
    '# 跨 CLI 一致性门（ADR 0059 P1 T11）',
    '',
    `- Node CLI：\`${nodeCli}\``,
    `- JVM CLI：\`${jar}\``,
    `- 用例：${outcomes.length}；两侧一致且等于期望：**${identical}/${outcomes.length}**；不一致：**${failing.length}**；已知引擎分歧（不计失败）：${knownDiverging.length}`,
    '',
  ];
  const describe = (o) => {
    const out = [`### ${o.row.file} / ${o.row.c.name}${o.known ? `（已知分歧：${o.known}）` : ''}`, '', `- 参数：\`${JSON.stringify(o.row.c.args)}\``, `- 两侧归一后一致：${o.sameAcross ? '是' : '否'}`];
    for (const side of ['node', 'jre']) {
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
  const report = `${lines.join('\n')}\n`;
  const reportFile = opt('--report');
  if (reportFile) writeFileSync(reportFile, report);
  process.stdout.write(report);
  console.log(`identical ${identical}/${outcomes.length}, ${failing.length} divergent${knownDiverging.length ? `, ${knownDiverging.length} known divergence` : ''}`);
  process.exitCode = reportOnly || failing.length === 0 ? 0 : 1;
}

await main();
