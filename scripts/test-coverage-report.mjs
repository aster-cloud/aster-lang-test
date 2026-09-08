#!/usr/bin/env node
/**
 * coverage-report.py 的 cases 文件归属判定回归测试（纯 node:assert，调真实脚本）。
 *
 * ★为什么要锁这一点：eval 门（parity-tier1.mjs）查 golden 用的是**精确文件名**
 * `<sample>.cases.json`。覆盖率统计若用前缀 glob `<sample>*.cases.json`，policy `loan`
 * 会把 `loan_fixed.cases.json` 的 entry 当成自己的——度量说「已覆盖」、门禁实际没跑
 * （issue #130）。本测试构造一个最小语料，断言只有精确同名文件的 entry 参与可达性计算。
 *
 * 用法：node scripts/test-coverage-report.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'coverage-report.py');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

/** 在临时目录搭一个 corpus/tier1-equivalence，返回根目录。 */
function scaffold(files) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-report-'));
  const base = join(root, 'corpus', 'tier1-equivalence');
  mkdirSync(join(base, 'policies'), { recursive: true });
  mkdirSync(join(base, 'inputs'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(base, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function runReport(root) {
  const r = spawnSync('python3', [SCRIPT, '--json'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `coverage-report.py 退出码 ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const LOAN = [
  'Module test.loan.',
  '',
  'Rule entryA given x, produce:',
  '  Return x.',
  'Rule ruleB given x, produce:',
  '  Return x.',
  '',
].join('\n');

const cases = (policy, entry) => ({
  ...(policy ? { policy } : {}),
  entry,
  cases: [{ name: 'c', input: [1], expected: 1 }],
});

check('精确同名 cases 文件的 entry 参与可达性', () => {
  const root = scaffold({
    'policies/loan.aster': LOAN,
    'inputs/loan.cases.json': cases('tier1-equivalence/policies/loan.aster', 'entryA'),
  });
  try {
    const d = runReport(root);
    const row = d.detail.find((r) => r.policy === 'loan');
    assert.ok(row, 'loan 应出现在明细中');
    assert.deepStrictEqual(row.unreachable, ['ruleB']);
    assert.strictEqual(row.reason, 'unreachable-from-entry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('前缀同名文件（loan_fixed）的 entry 不得算到 loan 头上——即使它缺 policy 字段', () => {
  const root = scaffold({
    'policies/loan.aster': LOAN,
    'inputs/loan.cases.json': cases('tier1-equivalence/policies/loan.aster', 'entryA'),
    // 无 policy 字段：靠字段自证归属的兜底在这里失效，只有精确文件名判定能挡住。
    'inputs/loan_fixed.cases.json': cases(null, 'ruleB'),
  });
  try {
    const d = runReport(root);
    const row = d.detail.find((r) => r.policy === 'loan');
    assert.ok(row, 'loan 应出现在明细中（ruleB 仍不可达）');
    assert.deepStrictEqual(row.unreachable, ['ruleB']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('只有前缀同名文件、没有精确同名文件 → 视为 no-cases-file', () => {
  const root = scaffold({
    'policies/loan.aster': LOAN,
    'inputs/loan_fixed.cases.json': cases(null, 'entryA'),
  });
  try {
    const d = runReport(root);
    const row = d.detail.find((r) => r.policy === 'loan');
    assert.ok(row);
    assert.strictEqual(row.reason, 'no-cases-file');
    assert.strictEqual(d.policies_without_cases, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\ncoverage-report 归属判定: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
