#!/usr/bin/env node
/**
 * Golden-cases generator / verifier for tier1-equivalence eval coverage.
 *
 * Reads a spec file describing, per sample, the entry function and a set of
 * input vectors (with the EXPECTED output the author intends). For each case it
 * runs BOTH engines (TS via dual-engine-runner, Java via CoreIrEvalCli) and:
 *   - writes the case into corpus/tier1-equivalence/inputs/<sample>.cases.json
 *     ONLY when both engines agree AND match the author's expected value;
 *   - otherwise reports the disagreement and SKIPS the file, so a single-engine
 *     bug is never frozen into a golden.
 *
 * The author still supplies `expected` (the intended semantics) — the engines
 * are a cross-check, not the source of truth. This prevents codifying whatever
 * the engines happen to do today.
 *
 * Spec format (cases-spec.json):
 *   {
 *     "samples": [
 *       { "name": "03-if-else", "entry": "grade",
 *         "cases": [
 *           { "name": "95 → A", "input": [95], "expectedOutput": "A" },
 *           ...
 *         ] }
 *     ]
 *   }
 *
 * A case may carry its own `"entry"` to override the sample-level default, so a
 * policy with several rules can have every rule evaluated instead of only one:
 *
 *   { "name": "not-precedence", "entry": "notCompare",
 *     "cases": [
 *       { "name": "...", "input": [5, 3], "expectedOutput": false },
 *       { "name": "...", "entry": "notNot", "input": [true], "expectedOutput": true }
 *     ] }
 *
 * The override is echoed into the generated .cases.json so the parity gate
 * evaluates each case against the same entry it was verified with.
 *
 * A case may instead carry `"expectError": true` to assert that **both engines
 * must reject** the input (issue #69) — used for divide-by-zero, invalid ISO
 * dates, and other runtime-error paths that value-only goldens never exercise.
 * Verification passes only when neither engine produced a value; error messages
 * are deliberately NOT compared (Java prefixes the exception class and uses
 * Chinese hints, TS emits a short sentence — the contract is "rejected or not",
 * not the wording).
 *
 *   { "name": "10 / 0 must be rejected", "input": [10, 0], "expectError": true }
 *
 * Usage:
 *   node scripts/gen-cases.mjs <spec.json> [--write] [--only=NAME,NAME]
 *   node scripts/gen-cases.mjs <spec.json> --write \\
 *     --allow-drop=NAME --drop-reason="为何这些 golden 该弃"
 *
 *   ★--allow-drop 是**逐样本**授权且必须给理由：默认拒绝任何会抹掉既有
 *   golden 的写入（含既有文件无法解析的情况——无法比对恰恰最需要人看一眼）。
 *   仅用于「占位样本补真实现」这类有意替换；理由会打进日志供审计。
 *   (without --write it's a dry run: reports agreement, writes nothing)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectGoldenLoss } from './lib/golden-overwrite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CORPUS = join(ROOT, 'corpus');
const POLICIES = join(CORPUS, 'tier1-equivalence', 'policies');
const INPUTS = join(CORPUS, 'tier1-equivalence', 'inputs');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const TRUFFLE_REPO = resolve(ROOT, '..', 'aster-lang-truffle');
const TS_RUNNER = join(TS_REPO, 'scripts', 'dual-engine-runner.mjs');

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
// ★仅用于「占位样本补真实现」这类**有意替换**：旧 golden 断言的是占位返回值，
//   保留它等于把占位值固化成正确答案。默认不开，且开了也会把弃用清单打进日志。
// ★弃用既有 golden 必须**逐样本授权**并给出理由，而非一个全局开关：
//   `--allow-drop=NAME[,NAME]` 指定允许弃用的 sample，`--drop-reason="..."` 说明为何该弃。
//   全局布尔开关的问题是「批准了 A 的替换，顺手也放行了 B 的误覆盖」——
//   而误覆盖恰恰是这道护栏要防的（我已因此丢过 38 条 golden）。
//   理由会打进日志：日后回看「这些 golden 是被谁、以什么理由弃掉的」有据可查。
const dropArg = args.find((a) => a.startsWith('--allow-drop'));
const ALLOW_DROP_SAMPLES = dropArg
  ? new Set(
      (dropArg.includes('=') ? dropArg.slice(dropArg.indexOf('=') + 1) : '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
  : null;
const dropReasonArg = args.find((a) => a.startsWith('--drop-reason='));
const DROP_REASON = dropReasonArg ? dropReasonArg.slice('--drop-reason='.length).trim() : '';

if (dropArg && ALLOW_DROP_SAMPLES.size === 0) {
  console.error(
    "错误：--allow-drop 必须指定样本名，如 --allow-drop=test_eligibility。\n" +
      "  不接受无参形式——全局放行会让本该被拦下的误覆盖一并通过。",
  );
  process.exit(2);
}
if (dropArg && !DROP_REASON) {
  console.error(
    '错误：--allow-drop 必须同时给出 --drop-reason="为何这些 golden 该弃"。\n' +
      '  理由会打进日志，供日后审计。',
  );
  process.exit(2);
}

/** 该样本是否被显式授权弃用既有 golden。 */
const allowDropFor = (name) => ALLOW_DROP_SAMPLES !== null && ALLOW_DROP_SAMPLES.has(name);
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

if (!specPath) {
  console.error('usage: gen-cases.mjs <spec.json> [--write] [--only=NAME,...]');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const samples = spec.samples.filter((s) => !ONLY || ONLY.has(s.name));

// ---- flatten to per-case requests ----
// Java's CoreIrEvalCli reads caseIndex as an int and joins on (samplePath,
// caseIndex). We give each request a GLOBAL integer index so the join key is
// unique even across samples; `key()` mirrors what each engine echoes back.
const requests = [];
let gIdx = 0;
for (const s of samples) {
  const samplePath = join(POLICIES, `${s.name}.aster`);
  if (!existsSync(samplePath)) {
    console.error(`!! sample not found: ${s.name}.aster`);
    continue;
  }
  s.cases.forEach((c, i) => {
    // case 级 `entry` 覆盖 sample 级默认——让一个 policy 内的多条 rule 都能生成 golden。
    requests.push({
      sample: s.name, samplePath, entry: c.entry || s.entry, input: c.input,
      caseEntry: c.entry, localIndex: i, gIndex: gIdx++, name: c.name, expected: c.expectedOutput,
      // 错误路径用例（issue #69）：断言两引擎都应拒绝，而非比对返回值
      expectError: c.expectError === true,
    });
  });
}
const javaKey = (r) => `${r.samplePath}#${r.gIndex}`;

// ---- TS engine (one spawn per case) ----
function runTs(reqs) {
  const out = new Map();
  for (const r of reqs) {
    const source = readFileSync(r.samplePath, 'utf8');
    const proc = spawnSync('node', [TS_RUNNER], {
      input: JSON.stringify({ source, entry: r.entry, input: r.input }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    let res;
    try {
      res = JSON.parse((proc.stdout || '').trim());
    } catch {
      res = { success: false, error: (proc.stderr || 'bad ts output').slice(0, 200) };
    }
    out.set(r.gIndex, res);
  }
  return out;
}

// ---- Java engine (batched CoreIrEvalCli) ----
function runJava(reqs) {
  const tmp = mkdtempSync(join(tmpdir(), 'gencases-'));
  const inFile = join(tmp, 'req.jsonl');
  const outFile = join(tmp, 'out.jsonl');
  writeFileSync(
    inFile,
    reqs.map((r) => JSON.stringify({ samplePath: r.samplePath, entry: r.entry, input: r.input, caseIndex: r.gIndex })).join('\n') + '\n',
  );
  const res = spawnSync(
    './gradlew',
    ['test', '--tests', 'CoreIrEvalCli', '--rerun-tasks', '-q', `-Dparity.eval.input=${inFile}`, `-Dparity.eval.output=${outFile}`],
    { cwd: TRUFFLE_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!existsSync(outFile)) {
    console.error('Java CoreIrEvalCli produced no output:\n', ((res.stdout || '') + (res.stderr || '')).slice(-1500));
    process.exit(2);
  }
  const out = new Map();
  for (const line of readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      // Join on (samplePath, caseIndex) — caseIndex is our global int index.
      if (rec.samplePath !== undefined && rec.caseIndex !== undefined) {
        out.set(`${rec.samplePath}#${rec.caseIndex}`, rec);
      }
    } catch {}
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return out;
}

console.error(`[gen-cases] ${requests.length} cases across ${samples.length} samples — running TS…`);
const ts = runTs(requests);
console.error('[gen-cases] running Java (gradle, ~1min)…');
const java = runJava(requests);

// ---- compare + decide ----
const J = (v) => JSON.stringify(v);
const bySample = new Map();
let agree = 0;
const problems = [];
for (const r of requests) {
  const key = `${r.sample}#${r.localIndex}`;
  const t = ts.get(r.gIndex) || { success: false, error: 'no ts' };
  const jr = java.get(javaKey(r)) || { ok: false, error: 'no java' };
  const tVal = t.success ? t.value : undefined;
  const jVal = jr.ok ? jr.value : undefined;
  const exp = r.expected;
  // expectError：契约是"两侧都必须拒绝"，不比对错误消息（消息是实现细节）。
  const verified = r.expectError
    ? (!t.success && !jr.ok)
    : (t.success && J(tVal) === J(exp) && jr.ok && J(jVal) === J(exp));
  if (verified) {
    agree++;
    if (!bySample.has(r.sample)) bySample.set(r.sample, []);
    // 只有显式写了 case 级 entry 的才回写该字段——避免给存量单-entry 文件平添噪声。
    const base = r.caseEntry
      ? { name: r.name, entry: r.caseEntry, input: r.input }
      : { name: r.name, input: r.input };
    bySample.get(r.sample).push(
      r.expectError ? { ...base, expectError: true } : { ...base, expectedOutput: exp },
    );
  } else {
    problems.push({
      key, name: r.name,
      expected: r.expectError ? '<both engines must fail>' : exp,
      ts: t.success ? tVal : `ERR:${t.error}`,
      java: jr.ok ? jVal : `ERR:${jr.error}`,
    });
  }
}

console.log(`\n=== gen-cases: ${agree}/${requests.length} cases verified (both engines == expected) ===`);
if (problems.length) {
  console.log(`\n⚠️  ${problems.length} case(s) NOT verified (skipped — needs author review):`);
  for (const p of problems) {
    console.log(`  ${p.key} "${p.name}": expected=${J(p.expected)} ts=${J(p.ts)} java=${J(p.java)}`);
  }
}

// ---- write verified samples ----
let written = 0;
for (const s of samples) {
  const cases = bySample.get(s.name);
  if (!cases || cases.length === 0) continue;
  if (cases.length !== s.cases.length) {
    console.log(`  ~ ${s.name}: only ${cases.length}/${s.cases.length} cases verified — NOT writing (partial)`);
    continue;
  }
  const doc = { policy: `tier1-equivalence/policies/${s.name}.aster`, entry: s.entry, cases };
  const outPath = join(INPUTS, `${s.name}.cases.json`);

  // ★写入是**整文件覆盖**而非合并。若既有 cases 文件里有本 spec 未涵盖的 case
  // （常见于分批补覆盖：先写了 A 组，后写 B 组时忘了把 A 组并进同一个 spec），
  // 直接覆盖会**静默抹掉**已验证的 golden——实际发生过两次
  // （patient-record 丢 8 条、enterprise 丢 4 条），都是靠 coverage 报告
  // 「已清零的 policy 又冒出未执行规则」才发现的。
  // 这里主动比对并拒绝写入，把静默数据丢失变成响亮失败。
  if (existsSync(outPath)) {
    // ★丢失检测抽到 lib/golden-overwrite.mjs：内联在这里就没法为它写快测
    //   （gen-cases 要真跑两个引擎，分钟级），而这恰恰是最该被锁住的分支——
    //   我因此把 38 条已验证 golden 覆盖成了 1 条。
    //   回归测试见 scripts/test-golden-overwrite.mjs。
    let prev;
    try {
      prev = JSON.parse(readFileSync(outPath, 'utf8'));
    } catch (err) {
      // 只把**真正的 JSON 解析失败**转成 unparseable；其它异常（护栏自身的
      // ReferenceError、文件权限错误等）必须响亮抛出——把 bug 伪装成
      // 「文件损坏」是这类兜底 catch 最危险的失效模式。
      if (!(err instanceof SyntaxError)) throw err;
      prev = undefined;
    }
    const verdict = detectGoldenLoss(prev, cases, s.entry);
    if (!verdict.ok && !allowDropFor(s.name)) {
      if (verdict.reason === 'unparseable') {
        // ★无法解析**不等于**可以随便覆盖：无法比对恰恰最需要人看一眼。
        console.error(
          `  \u2717 ${s.name}: 既有 cases 文件无法解析，拒绝覆盖。` +
            `\n    无法解析就无法确认会丢失哪些 golden——请先人工查看该文件；` +
            `\n    确认可弃后加 --allow-drop=${s.name} --drop-reason="..." 重建。`,
        );
      } else {
        console.error(
          `  \u2717 ${s.name}: 拒绝写入——会抹掉既有 ${verdict.lost.length} 条 golden：\n` +
            verdict.lost.map((x) => `      - ${x}`).join('\n') +
            `\n    修法：把它们并入本 spec（同一 policy 的 case 必须写在同一个 spec 里）。` +
            `\n    若确实要**替换**（如占位样本补真实现后，旧 golden 断言的是占位` +
            `\n    返回值、已不再正确），加 --allow-drop=${s.name} --drop-reason="..."。`,
        );
      }
      process.exitCode = 1;
      continue;
    }
    if (!verdict.ok) {
      // 显式放行：仍把弃掉的内容打进日志，让「丢了什么」可审。
      console.warn(
        verdict.reason === 'unparseable'
          ? `  ! ${s.name}: 既有文件无法解析，--allow-drop 生效，整体重建（理由：${DROP_REASON}）`
          : `  ! ${s.name}: --allow-drop 生效（理由：${DROP_REASON}），弃用既有 ${verdict.lost.length} 条 golden：\n` +
              verdict.lost.map((x) => `      - ${x}`).join('\n'),
      );
    }
  }

  if (WRITE) {
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
    written++;
  }
}
console.log(WRITE ? `\n✅ wrote ${written} verified .cases.json file(s).` : `\n(dry run — pass --write to persist ${bySample.size} fully-verified sample(s))`);
process.exit(problems.length > 0 ? 1 : 0);
