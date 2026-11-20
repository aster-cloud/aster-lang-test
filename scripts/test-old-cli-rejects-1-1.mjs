#!/usr/bin/env node
/**
 * 旧 CLI 遇到包格式 1.1（ADR 0059 修订 4 D4；计划 T1 Step 6）：不支持 1.1 的已发布 CLI（ts v3.5.0 的 aster.mjs、
 * truffle v1.0.52 的 aster-cli-1.0.52.jar）对黄金包 display/packages/b-jingyesi 的 verify / run / inspect 一律以
 * PKG_UNSUPPORTED_FORMAT、退出码 4 明确失败，不会静默忽略排版。
 *
 * 用法：
 *   node scripts/test-old-cli-rejects-1-1.mjs [--cache <dir>] [--node <aster.mjs>] [--jar <aster-cli.jar>]
 *   缺省从 GitHub Release 下载两个产物到 --cache（缺省 .cache/old-cli），并核对各自 Release 的 .sha256；
 *   给 --node / --jar 时用本地文件（仍核对与 Release 记录的 sha256 相同，防止误用新构建）。
 * 退出码：0 全部符合；1 有不符；2 用法或下载失败。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = join(ROOT, 'conformance', 'package-v1', 'display', 'packages');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};

/** 已发布的、只支持 1.0 的两个 CLI（ADR 0059 修订 4 §1.1 实测所用的同一产物）。 */
const OLD = {
  node: { file: 'aster.mjs', url: 'https://github.com/aster-cloud/aster-lang-ts/releases/download/v3.5.0/aster.mjs' },
  jre: { file: 'aster-cli-1.0.52.jar', url: 'https://github.com/aster-cloud/aster-lang-truffle/releases/download/v1.0.52/aster-cli-1.0.52.jar' },
};

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 取得产物并核对 Release 的 .sha256（`<hex>  <name>` 或只有 hex）。 */
async function obtain(side, cache) {
  const o = OLD[side];
  const expected = (await fetchBytes(`${o.url}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
  const local = opt(side === 'node' ? '--node' : '--jar');
  const path = local ? resolve(local) : join(cache, o.file);
  if (!local && (!existsSync(path) || sha256(readFileSync(path)) !== expected)) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(path, await fetchBytes(o.url));
  }
  const got = sha256(readFileSync(path));
  if (got !== expected) throw new Error(`${path} 的 sha256 ${got} ≠ Release 记录的 ${expected}`);
  return path;
}

function run(side, path, args, stdin) {
  const [cmd, full] = side === 'node' ? [process.execPath, [path, ...args]] : ['java', ['-jar', path, ...args]];
  const env = { ...process.env };
  delete env.ASTER_TRUFFLE_FUNC;
  const r = spawnSync(cmd, full, { cwd: CASES_DIR, input: stdin ?? '', encoding: 'utf8', env, timeout: 120_000 });
  return { exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function main() {
  const cache = resolve(opt('--cache', join(ROOT, '.cache', 'old-cli')));
  let paths;
  try {
    paths = { node: await obtain('node', cache), jre: await obtain('jre', cache) };
  } catch (e) {
    console.error(`test-old-cli-rejects-1-1: ${e.message}`);
    process.exit(2);
  }
  const anchor = ['--jwks', '../../keys/test-jwks.json'];
  const commands = [
    ['verify', 'b-jingyesi', ...anchor],
    ['verify', 'b-jingyesi', '--recompile', ...anchor],
    ['run', 'b-jingyesi', '--input', '-', ...anchor],
    ['inspect', 'b-jingyesi', ...anchor],
  ];
  const problems = [];
  let n = 0;
  for (const side of ['node', 'jre']) {
    const version = JSON.parse(run(side, paths[side], ['version']).stdout);
    if (JSON.stringify(version.formatVersions) !== '["1.0"]') problems.push(`${side}: 不是只支持 1.0 的旧 CLI（formatVersions ${JSON.stringify(version.formatVersions)}）`);
    for (const args of commands) {
      const r = run(side, paths[side], args, args[0] === 'run' ? '{}' : undefined);
      let env = null;
      try {
        env = JSON.parse(r.stdout);
      } catch {
        env = null;
      }
      const code = env?.error?.code ?? env?.checks?.find((c) => !c.ok)?.code ?? null;
      const ok = r.exit === 4 && code === 'PKG_UNSUPPORTED_FORMAT'
        && (env.error ? env.error.message === 'package format version is not supported' : env.checks.length === 1 && env.checks[0].name === 'schema');
      if (!ok) problems.push(`${side} ${args.join(' ')}：退出码 ${r.exit}、错误码 ${code}（期望 4 / PKG_UNSUPPORTED_FORMAT）\n    ${r.stdout.trim().slice(0, 300)}`);
      n++;
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`test-old-cli-rejects-1-1: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(`test-old-cli-rejects-1-1: ok (${n} commands; ts v3.5.0 ${paths.node}, aster-cli 1.0.52 ${paths.jre})`);
  }
}

await main();
