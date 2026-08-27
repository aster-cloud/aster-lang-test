#!/usr/bin/env node
/**
 * 「spec 声明 cases 为空」这条**集成路径**的回归测试。
 *
 * ★为什么单测挡不住、必须走真实 CLI：
 * 此前 `test-golden-overwrite.mjs` 已有一条断言
 * `detectGoldenLoss(prev, [], entry)` 必须报出全部旧 case（N25），**并且是绿的**；
 * 但 `gen-cases.mjs` 在抵达护栏之前就 `if (!cases || cases.length === 0) continue`，
 * 于是那个函数**在这条路径上从未被调用**。
 * 结果：helper 单测绿着，集成路径整条绕过，`--write` 一个 `cases: []` 的 spec
 * 会打印「✅ wrote 0 verified files」并 exit 0。文件当时没被清空纯属侥幸
 * ——写入循环压根没进，不是护栏拦住了。
 *
 * 教训：单测证明的是「函数被调用时行为正确」，不能证明「它会被调用」。
 * 最极端的事故形态（38 条 golden → 0 条）只能在 CLI 层面钉死。
 *
 * 本测试刻意使用**不存在的样本名**，因此 gen-cases 会在参数校验阶段就返回，
 * 不会真跑两个引擎（秒级），可安全放进 CI。
 *
 * 用法：node scripts/test-wipe-guard.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, 'gen-cases.mjs');
const INPUTS = join(HERE, '..', 'corpus', 'tier1-equivalence', 'inputs');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** 跑 gen-cases，返回 {code, out}。绝不让异常逃逸成假绿。 */
function runGen(args) {
  try {
    const out = execFileSync('node', [GEN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 写一个「声明 cases 为空」的 spec，指向真实存在且有 golden 的样本。 */
function wipeSpec(dir, sample, entry) {
  const p = join(dir, 'wipe.json');
  writeFileSync(p, JSON.stringify({ samples: [{ name: sample, entry, cases: [] }] }));
  return p;
}

const tmp = mkdtempSync(join(tmpdir(), 'wipe-guard-'));
const SAMPLE = 'test_eligibility';
const ENTRY = 'determineMinorCoverage';
const goldenPath = join(INPUTS, `${SAMPLE}.cases.json`);
const before = readFileSync(goldenPath, 'utf8');
const beforeCount = JSON.parse(before).cases.length;

try {
  check(`前置：${SAMPLE} 确有 golden（否则本测试无意义）`, () => {
    assert.ok(beforeCount > 0, `期望有 golden，实际 ${beforeCount} 条`);
  });

  check('★无授权声明清空 → 拒绝写入（exit 1）且指出将丢失多少条', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code, out } = runGen([spec, '--write']);
    assert.strictEqual(code, 1, `期望 exit 1，实际 ${code}。输出：${out}`);
    assert.ok(out.includes(SAMPLE), '拒绝信息必须点名样本');
    assert.ok(
      out.includes(String(beforeCount)),
      `拒绝信息必须说明将清空多少条（期望含 ${beforeCount}）。实际：${out}`,
    );
  });

  check('★拒绝后文件必须逐字节不变（不能"报错了但已经写坏"）', () => {
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before);
  });

  check('★授权了别的样本 → 仍然拒绝（授权按样本隔离）', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code } = runGen([spec, '--write', '--allow-drop=some_other', '--drop-reason=x']);
    assert.strictEqual(code, 1, '授权 other 不得放行 test_eligibility 的清空');
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before, '文件仍须不变');
  });

  check('★缺 --drop-reason 的授权无效 → 参数校验 exit 2', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code } = runGen([spec, '--write', `--allow-drop=${SAMPLE}`]);
    assert.strictEqual(code, 2, '缺理由必须在参数校验阶段就失败');
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before);
  });

  check('dry-run（不加 --write）不得因清空意图而失败', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code } = runGen([spec]);
    assert.strictEqual(code, 0, `dry-run 只是预演，期望 exit 0，实际 ${code}`);
  });

  // ---- 入口接线保护（第四轮 Codex 的主阻塞项）----
  //
  // ★Codex 抓出：把入口的两根线同时改坏——绕过 parseDropArgs、
  //   恢复会覆盖失败码的旧 `process.exit(problems>0?1:0)`——
  //   **66 条测试仍全绿**。helper 单测证明的是「函数被调用时行为正确」，
  //   证明不了「入口真的照它说的接线」。下面几条直接从 CLI 观测接线后果。

  check('★入口必须真的走 parseDropArgs：裸 --allow-drop 在 CLI 层 exit 2', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code } = runGen([spec, '--write', '--allow-drop', '--drop-reason=x']);
    assert.strictEqual(code, 2, '绕过 parseDropArgs 会让裸 flag 不再是 exit 2');
  });

  check('★入口必须真的走 parseDropArgs：伪装 flag 不得获得授权', () => {
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    // --allow-dropfoo 不是授权 → 清空仍须被拒（exit 1），而非放行（exit 0）
    const { code } = runGen([
      spec, '--write', `--allow-dropfoo=${SAMPLE}`, '--drop-reason=x',
    ]);
    assert.strictEqual(code, 1, '前缀伪装的 flag 不得放行清空');
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before);
  });

  check('★入口必须真的走 finalExitCode：拒绝写入时不得被 problems=0 降级成 0', () => {
    // 这正是历史事故：护栏打印拒绝、进程却 exit 0。
    // 本 spec 没有任何 case，problems 必为 0；若入口恢复旧的
    // `process.exit(problems>0?1:0)`，这里就会退化成 exit 0。
    const spec = wipeSpec(tmp, SAMPLE, ENTRY);
    const { code, out } = runGen([spec, '--write']);
    assert.ok(out.includes('✗'), '必须确实打印了拒绝');
    assert.strictEqual(code, 1, '打印了拒绝就必须 exit 非 0，否则 CI 读成成功');
  });
} finally {
  // 无论断言成败都必须还原，避免把仓库留在脏状态
  writeFileSync(goldenPath, before);
  rmSync(tmp, { recursive: true, force: true });
}

// 兜底：确认 finally 真的还原了
assert.strictEqual(readFileSync(goldenPath, 'utf8'), before, '测试结束后 golden 必须原样');

console.log(`\nwipe-guard (集成): ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
