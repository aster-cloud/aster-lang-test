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
 *   (without --write it's a dry run: reports agreement, writes nothing)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
const ALLOW_DROP = args.includes('--allow-drop');
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
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      const keyOf = (c, defEntry) => `${c.entry ?? defEntry} ${c.name}`;
      const now = new Set(cases.map((c) => keyOf(c, s.entry)));
      const lost = (prev.cases ?? []).filter((c) => !now.has(keyOf(c, prev.entry))).map((c) => `${c.entry ?? prev.entry}/${c.name}`);
      if (lost.length > 0 && !ALLOW_DROP) {
        console.error(
          `  ✗ ${s.name}: 拒绝写入——会抹掉既有 ${lost.length} 条 golden：\n` +
          lost.map((x) => `      - ${x}`).join('\n') +
          `\n    修法：把它们并入本 spec（同一 policy 的 case 必须写在同一个 spec 里）。` +
          `\n    若确实要**替换**（如占位样本补真实现后，旧的 "stub 0" golden 断言的是` +
          `\n    占位返回值、已不再正确），加 --allow-drop 并在 PR 说明为何这些 golden 该弃。`,
        );
        process.exitCode = 1;
        continue;
      }
      if (lost.length > 0) {
        // 显式放行：仍然把弃掉的 golden 逐条打出来，让「丢了什么」留在日志里可审。
        console.warn(
          `  ! ${s.name}: --allow-drop 生效，弃用既有 ${lost.length} 条 golden：\n` +
          lost.map((x) => `      - ${x}`).join('\n'),
        );
      }
    } catch (err) {
      // ★只放行**真正的 JSON 解析失败**（等价于重建）。其它异常——例如护栏
      //   代码自身的 ReferenceError——必须响亮失败：我就踩过一次，
      //   ALLOW_DROP 引用在声明之前，异常被这里吞掉、走进整体重建分支，
      //   于是 38 条已验证 golden 被一条覆盖掉。把 bug 伪装成文件损坏
      //   是这类兜底 catch 最危险的失效模式。
      if (!(err instanceof SyntaxError)) throw err;
      console.error(`  ~ ${s.name}: 既有 cases 文件 JSON 解析失败，将整体重建`);
    }
  }

  if (WRITE) {
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
    written++;
  }
}
console.log(WRITE ? `\n✅ wrote ${written} verified .cases.json file(s).` : `\n(dry run — pass --write to persist ${bySample.size} fully-verified sample(s))`);
process.exit(problems.length > 0 ? 1 : 0);
