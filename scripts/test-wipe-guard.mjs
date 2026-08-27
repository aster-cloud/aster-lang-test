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
 * ★为何秒级、可进 CI（原注释说「用不存在的样本名」，**已不成立**——
 * 现在用的是真实的 test_eligibility）：两条捷径共同保证不启动引擎——
 *   · `cases: []` 的 spec 触发 gen-cases 的零 case 短路（requests 为空即跳过引擎）；
 *   · 非空写入路径用 GEN_CASES_FAKE_ENGINE 注入引擎结果。
 * 全套约 33 秒，其中绝大部分是逐条 spawn node 进程的开销。
 *
 * 用法：node scripts/test-wipe-guard.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

/**
 * 跑 gen-cases，返回 {code, out}。绝不让异常逃逸成假绿。
 * ★out 必须是 stdout + stderr 合并：拒绝(console.error)与授权(console.warn)
 *   都在 **stderr**，汇总行在 stdout；只取其一断言就瞎一半（我已误判过一次）。
 */
function runGen(args) {
  const r = spawnSync('node', [GEN, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 写一个「声明 cases 为空」的 spec，指向真实存在且有 golden 的样本。 */
function wipeSpec(dir, sample, entry) {
  const p = join(dir, 'wipe.json');
  writeFileSync(p, JSON.stringify({ samples: [{ name: sample, entry, cases: [] }] }));
  return p;
}

// ---- 非空写入路径的装置 ----
//
// ★变异审计用插桩证明：上面 9 条（全部用 cases: []）走的是早退分支，
//   非空写入分支**命中 0 次**。于是 partial 拦截、prev 解析分流、
//   detectGoldenLoss、主拒绝块、writeFileSync 全部零覆盖——
//   把主护栏条件**整个反转**（真丢失被写入、安全写入被拒）时 75 条测试仍全绿。
//   要覆盖它就必须有 case 通过验证，而那本来要真跑两个引擎（分钟级）。
//   故用 GEN_CASES_FAKE_ENGINE 注入引擎结果：只让「引擎算出了什么」可控，
//   护栏逻辑一行不碰（见 gen-cases.mjs 中该注入点的安全边界说明）。

/** 造 spec + 对应的假引擎输出，使每条 case 都「双引擎一致且等于期望」。 */
function nonEmptySpec(dir, sample, entry, caseNames, tag = 'ne') {
  const cases = caseNames.map((n, i) => ({ name: n, input: [i], expectedOutput: i }));
  const specPath = join(dir, `${tag}.json`);
  writeFileSync(specPath, JSON.stringify({ samples: [{ name: sample, entry, cases }] }));
  const fake = join(dir, `${tag}.jsonl`);
  writeFileSync(fake, cases.map((c, i) => JSON.stringify({ gIndex: i, value: i })).join('\n') + '\n');
  return { specPath, fake };
}

/** 只让前 n 条通过验证（其余引擎给出不匹配的值）→ 触发 partial 拦截。 */
function partialSpec(dir, sample, entry, total, passing) {
  const cases = Array.from({ length: total }, (_, i) => ({ name: `c${i}`, input: [i], expectedOutput: i }));
  const specPath = join(dir, 'partial.json');
  writeFileSync(specPath, JSON.stringify({ samples: [{ name: sample, entry, cases }] }));
  const fake = join(dir, 'partial.jsonl');
  writeFileSync(
    fake,
    cases.map((c, i) => JSON.stringify({ gIndex: i, value: i < passing ? i : 9999 })).join('\n') + '\n',
  );
  return { specPath, fake };
}

/**
 * 造一个「既有 golden 的**超集**」spec：保留全部既有 case 再加一条。
 * 用于验证「不丢失时应放行」，以及 dry-run 是否偷偷落盘。
 * ★必须沿用既有 case 的 entry/input/expectedOutput，否则写出来的是另一种形状。
 */
function supersetSpec(dir, tag) {
  const prev = JSON.parse(before);
  const cases = prev.cases.map((c) => ({
    name: c.name, entry: c.entry, input: c.input,
    ...(c.expectError ? { expectError: true } : { expectedOutput: c.expectedOutput }),
  }));
  cases.push({ name: `zz-added-${tag}`, input: [0], expectedOutput: 0 });
  const specPath = join(dir, `${tag}.json`);
  writeFileSync(specPath, JSON.stringify({ samples: [{ name: SAMPLE, entry: prev.entry, cases }] }));
  const fake = join(dir, `${tag}.jsonl`);
  writeFileSync(
    fake,
    cases.map((c, i) => JSON.stringify(
      c.expectError ? { gIndex: i, error: 'expected-rejection' } : { gIndex: i, value: c.expectedOutput },
    )).join('\n') + '\n',
  );
  return { specPath, fake, total: cases.length };
}

function runGenFake(args, fake) {
  // ★必须**合并 stdout 与 stderr**。原注释说授权日志走 console.log/stdout，
  //   **说错了**：它走 console.warn，而 console.warn 在 Node 里输出到 **stderr**
  //   （实测 `node -e "console.warn('X')" 2>/dev/null` 无输出）。
  //   真正的原因是：拒绝(console.error)与授权(console.warn)都在 stderr，
  //   而汇总行「✅ wrote N」在 stdout；断言要同时看到两类信息就必须合并。
  const r = spawnSync('node', [GEN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GEN_CASES_FAKE_ENGINE: fake },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
  // ---- 非空写入路径（变异审计暴露的零覆盖区）----
  //
  // 下面每条都对应一个此前**存活**的变异。括号里是变异编号。

  check('★首次生成（无既有文件）必须成功创建（杀 prev=FILE_ABSENT→undefined）', () => {
    // FILE_ABSENT 哨兵在集成层此前零覆盖：改成 undefined 会让首次生成从
    // "放行"翻成"拒绝"，等于任何新样本都建不出 golden，却无人发现。
    const fresh = `zz_fresh_${process.pid}`;
    const freshPolicy = join(INPUTS, '..', 'policies', `${fresh}.aster`);
    const freshGolden = join(INPUTS, `${fresh}.cases.json`);
    writeFileSync(freshPolicy, 'Module zz.fresh.\n\nRule ident given x, produce:\n  Return x.\n');
    try {
      const { specPath, fake } = nonEmptySpec(tmp, fresh, 'ident', ['a', 'b'], 'fresh');
      const { code, out } = runGenFake([specPath, '--write'], fake);
      assert.strictEqual(code, 0, `首次生成应成功，实际 ${code}。输出：${out}`);
      assert.ok(existsSync(freshGolden), '必须真的创建了 golden 文件');
      assert.strictEqual(JSON.parse(readFileSync(freshGolden, 'utf8')).cases.length, 2);
    } finally {
      rmSync(freshPolicy, { force: true });
      rmSync(freshGolden, { force: true });
    }
  });

  check('★既有文件损坏（非 ENOENT）必须拒绝而非当作"不存在"放行（杀 ENOENT→true）', () => {
    // 文件头注释警告过这个失效模式（把 bug 伪装成"文件损坏→整体重建"，
    // 38 条变 1 条），却一直没有测试锁住它。
    const broken = `zz_broken_${process.pid}`;
    const brokenPolicy = join(INPUTS, '..', 'policies', `${broken}.aster`);
    const brokenGolden = join(INPUTS, `${broken}.cases.json`);
    writeFileSync(brokenPolicy, 'Module zz.broken.\n\nRule ident given x, produce:\n  Return x.\n');
    writeFileSync(brokenGolden, '{{{ not json');
    try {
      const { specPath, fake } = nonEmptySpec(tmp, broken, 'ident', ['a'], 'broken');
      const { code, out } = runGenFake([specPath, '--write'], fake);
      assert.strictEqual(code, 1, `损坏文件必须拒绝覆盖，实际 exit ${code}`);
      assert.ok(out.includes('无法解析'), `拒绝信息应说明无法解析。实际：${out}`);
      assert.strictEqual(readFileSync(brokenGolden, 'utf8'), '{{{ not json', '文件必须原样不动');
    } finally {
      rmSync(brokenPolicy, { force: true });
      rmSync(brokenGolden, { force: true });
    }
  });

  check('★主护栏：真丢失必须拒绝且 exit 1（杀主分支 exitCode=1→0、条件反转）', () => {
    // 与"清空分支"那条同构，但走的是**非空**路径——正是零覆盖的那条。
    const { specPath, fake } = nonEmptySpec(tmp, SAMPLE, ENTRY, ['only-one'], 'loss');
    const { code, out } = runGenFake([specPath, '--write'], fake);
    assert.strictEqual(code, 1, `会抹掉既有 ${beforeCount} 条，必须 exit 1，实际 ${code}`);
    assert.ok(out.includes('✗'), '必须打印拒绝');
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before, '文件必须逐字节不变');
  });

  check('★主护栏：安全新增（新集合是旧集合超集）必须放行（与上一条成对，杀条件反转）', () => {
    // ★必须成对：只测"拒绝"时，把条件反转仍可能只红一条而另一条恰好也红；
    //   两个方向都钉住，反转就无处可逃。
    const { specPath, fake, total } = supersetSpec(tmp, 'superset');
    const { code, out } = runGenFake([specPath, '--write'], fake);
    try {
      assert.strictEqual(code, 0, `超集写入不丢任何 golden，应放行，实际 ${code}。输出：${out}`);
      const after = JSON.parse(readFileSync(goldenPath, 'utf8'));
      assert.strictEqual(after.cases.length, total, `应写入 ${total} 条（原 ${beforeCount} + 1）`);
    } finally {
      writeFileSync(goldenPath, before); // 立刻还原，避免影响后续断言
    }
  });

  check('★dry-run 绝不落盘（杀去掉 if (WRITE) 的写入门）', () => {
    // 原有的 dry-run 测试只断言 exit 0，管不住"它偷偷写了"。
    // ★用**超集** spec：不丢任何 golden，故 dry-run 应 exit 0；
    //   若用会丢 golden 的 spec，护栏会正确报 exit 1（我第一版写错了期望，
    //   把「护栏正常工作」当成了测试失败）。这里要隔离的是「写没写」这一件事。
    const { specPath, fake } = supersetSpec(tmp, 'dryrun');
    const { code } = runGenFake([specPath], fake); // 不加 --write
    assert.strictEqual(code, 0, 'dry-run 超集 spec 不丢 golden，应 exit 0');
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before, 'dry-run 必须一个字节都不写');
  });

  check('★partial（部分 case 未通过验证）不得写入（杀摘除 partial 护栏）', () => {
    const fresh = `zz_partial_${process.pid}`;
    const p = join(INPUTS, '..', 'policies', `${fresh}.aster`);
    const g = join(INPUTS, `${fresh}.cases.json`);
    writeFileSync(p, 'Module zz.partial.\n\nRule ident given x, produce:\n  Return x.\n');
    try {
      const { specPath, fake } = partialSpec(tmp, fresh, 'ident', 3, 2);
      const { code, out } = runGenFake([specPath, '--write'], fake);
      assert.ok(out.includes('partial'), `应报告 partial。实际：${out}`);
      assert.ok(!existsSync(g), 'partial 时不得创建文件');
      assert.strictEqual(code, 1, '有 case 未通过验证应 exit 1');
    } finally {
      rmSync(p, { force: true });
      rmSync(g, { force: true });
    }
  });

  check('★同键改写断言必须被拒（Codex 第五轮实证的注入绕过）', () => {
    // ★这是我自己开的洞：GEN_CASES_FAKE_ENGINE 本意只让「引擎算出了什么」
    //   可控，但护栏当时只比 entry+name，于是保持键不变、把 input/expected
    //   从 100 改成 999，无需 --allow-drop 就能 exit 0 静默改写 golden。
    //   单测已在 test-golden-overwrite 覆盖 detectGoldenLoss；这里从 CLI
    //   观测**接线后果**——单测证明不了入口真的照它接线（本 session 的主线教训）。
    const prev = JSON.parse(before);
    const cases = prev.cases.map((c) => ({
      name: c.name, entry: c.entry, input: c.input,
      ...(c.expectError ? { expectError: true } : { expectedOutput: c.expectedOutput }),
    }));
    cases[0] = { ...cases[0], input: [999], expectedOutput: 999 }; // 键不变，内容改
    const specPath = join(tmp, 'rewrite.json');
    writeFileSync(specPath, JSON.stringify({ samples: [{ name: SAMPLE, entry: prev.entry, cases }] }));
    const fake = join(tmp, 'rewrite.jsonl');
    writeFileSync(fake, cases.map((c, i) => JSON.stringify(
      c.expectError ? { gIndex: i, error: 'x' } : { gIndex: i, value: c.expectedOutput },
    )).join('\n') + '\n');
    const { code, out } = runGenFake([specPath, '--write'], fake);
    assert.strictEqual(code, 1, `无授权改写断言必须 exit 1，实际 ${code}`);
    assert.ok(out.includes('改写'), `拒绝信息须指出是改写。实际：${out.slice(-300)}`);
    assert.strictEqual(readFileSync(goldenPath, 'utf8'), before, '文件必须逐字节不变');
  });

  check('★--allow-drop 在主路径上真的放行且理由进日志（正向锁 + 审计留痕）', () => {
    // 此前只有 helper 层测了 DROP_REASON 解析，集成层从未验证它**进过日志**。
    // ★用既有 golden 的第一条（沿用其 entry/input/期望值），故这是一次
    //   真正的**缩减**写入（N 条 → 1 条），必须靠 --allow-drop 才放行。
    const prev = JSON.parse(before);
    const c0 = prev.cases[0];
    const cases = [{
      name: c0.name, entry: c0.entry, input: c0.input,
      ...(c0.expectError ? { expectError: true } : { expectedOutput: c0.expectedOutput }),
    }];
    const specPath = join(tmp, 'authz.json');
    writeFileSync(specPath, JSON.stringify({ samples: [{ name: SAMPLE, entry: prev.entry, cases }] }));
    const fake = join(tmp, 'authz.jsonl');
    writeFileSync(fake, JSON.stringify(
      c0.expectError ? { gIndex: 0, error: 'expected-rejection' } : { gIndex: 0, value: c0.expectedOutput },
    ) + '\n');
    const reason = 'ZZ-TEST-REASON-VISIBLE-IN-LOG';
    const { code, out } = runGenFake(
      [specPath, '--write', `--allow-drop=${SAMPLE}`, `--drop-reason=${reason}`],
      fake,
    );
    try {
      assert.strictEqual(code, 0, `授权后应放行，实际 ${code}。输出：${out}`);
      assert.ok(out.includes(reason), `理由必须打进日志供审计。实际输出：${out.slice(-400)}`);
      assert.strictEqual(JSON.parse(readFileSync(goldenPath, 'utf8')).cases.length, 1, '应按 spec 重建为 1 条');
    } finally {
      writeFileSync(goldenPath, before);
    }
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
