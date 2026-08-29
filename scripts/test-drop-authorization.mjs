#!/usr/bin/env node
/**
 * drop 授权参数解析 + 最终退出码合并的回归测试（无框架，纯 node:assert）。
 *
 * ★为什么必须有：这两段逻辑此前内联在 gen-cases.mjs 里，而 gen-cases 要真跑
 * 两个引擎（分钟级），没人会为它写快测——于是**真实发生过的回归抓不到**：
 * 护栏正确打印「✗ 拒绝写入」，进程却 exit 0（末行 `process.exit(problems>0?1:0)`
 * 覆盖了中途设的 `exitCode = 1`），CI 把拒绝读成成功。
 *
 * 用法：node scripts/test-drop-authorization.mjs（退出码 0=全过，1=有失败）。
 */
import assert from 'node:assert';
import { parseDropArgs, finalExitCode, DROP_ARG_ERRORS } from './lib/drop-authorization.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

// ---- parseDropArgs ----

check('未传 --allow-drop → 无授权，不报错', () => {
  const r = parseDropArgs(['spec.json', '--write']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.samples.size, 0);
});

check('★裸 --allow-drop（无样本名）→ MISSING_SAMPLES', () => {
  const r = parseDropArgs(['--write', '--allow-drop', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('★--allow-drop= 空值 → MISSING_SAMPLES（不当作全局放行）', () => {
  const r = parseDropArgs(['--write', '--allow-drop=', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('★有样本名但缺 --drop-reason → MISSING_REASON', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('★--drop-reason 为空白 → 仍视为缺理由', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha', '--drop-reason=   ']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('★--allow-dropfoo=alpha 不是授权（精确匹配，防前缀误判）', () => {
  const r = parseDropArgs(['--write', '--allow-dropfoo=alpha', '--drop-reason=x']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.samples], [], '拼错的 flag 不得授予任何样本');
  // ★变异审计指出原断言 {ok:true, size:0} 与「未传 flag」返回同形，
  //   无法区分"拼错被忽略"和"识别了但样本为空"。补两条区分性断言：
  assert.strictEqual(r.reason, '', '既然没有合法授权，reason 不得被采纳');
  assert.deepStrictEqual(
    r,
    parseDropArgs(['--write']),
    '拼错的 flag 必须与"完全没传"等价',
  );
});

check('正确用法 → 解析出样本集合与理由', () => {
  const r = parseDropArgs(['--write', '--allow-drop=alpha,beta', '--drop-reason=补真实现']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.samples].sort(), ['alpha', 'beta']);
  assert.strictEqual(r.reason, '补真实现');
});

check('★样本名去空白、忽略空项', () => {
  const r = parseDropArgs(['--allow-drop= alpha , ,beta ', '--drop-reason=x']);
  assert.deepStrictEqual([...r.samples].sort(), ['alpha', 'beta']);
});

check('★授权 alpha 不等于授权 beta（逐样本隔离）', () => {
  const r = parseDropArgs(['--allow-drop=alpha', '--drop-reason=x']);
  // ★原断言 `!samples.has('beta')` 是**恒真**的——beta 从未出现在输入里，
  //   除非实现凭空造样本否则永远通过，零鉴别力（变异审计抓出：注入通配 `*`
  //   时这条不红，红的是别处）。必须断言集合的**精确内容与基数**。
  assert.deepStrictEqual([...r.samples], ['alpha'], '授权集合必须恰好等于列出的样本');
  assert.strictEqual(r.samples.size, 1, '不得注入通配或额外样本');
});

// ---- 重复 / 乱序 flag（第四轮复审要求枚举的绕过面）----
//
// 判定原则：授权只能**收窄**，绝不能因写法歧义而扩大。
// 下面每一条都确认了「首个匹配生效」或「直接拒绝」，没有取并集的路径。

check('★重复 --allow-drop → 只认第一个，不取并集', () => {
  const r = parseDropArgs(['--allow-drop=a', '--allow-drop=b', '--drop-reason=x']);
  assert.deepStrictEqual([...r.samples], ['a'], '第二个 flag 不得追加授权');
  assert.ok(!r.samples.has('b'));
});

check('★第一个 --allow-drop 为空值 → 拒绝，不被后一个补救', () => {
  // 若改成"找最后一个"或"取并集"，这里会静默授权 b —— 属放宽，必须拦住
  const r = parseDropArgs(['--allow-drop=', '--allow-drop=b', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('重复 --drop-reason → 取第一个（理由只影响日志，不影响授权范围）', () => {
  const r = parseDropArgs(['--allow-drop=a', '--drop-reason=first', '--drop-reason=second']);
  assert.strictEqual(r.reason, 'first');
});

check('参数顺序无关：--drop-reason 在 --allow-drop 之前也成立', () => {
  const r = parseDropArgs(['--drop-reason=x', '--allow-drop=a']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.samples], ['a']);
});

check('★空格分隔（--allow-drop a）→ 拒绝，而非把 a 当样本', () => {
  // 安全方向：不识别就拒绝。错误文案已明确提示"必须用等号"。
  const r = parseDropArgs(['--allow-drop', 'a', '--drop-reason=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_SAMPLES');
});

check('★--drop-reason 裸形式（无等号）→ 视为缺理由', () => {
  const r = parseDropArgs(['--allow-drop=a', '--drop-reason', 'x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('样本名含等号 → 只切第一个等号，保留其余', () => {
  const r = parseDropArgs(['--allow-drop=a=b', '--drop-reason=x']);
  assert.deepStrictEqual([...r.samples], ['a=b']);
});

// ★--drop-reason 的匹配严格性——与 --allow-drop **对称**的一组。
//   变异审计抓出：`--allow-drop` 的前缀误判有专测，同一类漏洞在
//   `--drop-reason` 上却零覆盖（改 startsWith / includes / lastIndexOf 全绿）。
//   「同一个 bug 换个马甲就能溜回来」是本仓最该堵的复发模式。

check('★--drop-reasonfoo=x 不是理由（精确匹配，与 --allow-drop 对称）', () => {
  const r = parseDropArgs(['--allow-drop=a', '--drop-reasonfoo=x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'MISSING_REASON');
});

check('★理由含等号 → 只切第一个等号（防 lastIndexOf 退化）', () => {
  const r = parseDropArgs(['--allow-drop=a', '--drop-reason=k=v']);
  assert.strictEqual(r.reason, 'k=v');
});

check('★样本名大小写敏感：授权不得因大小写折叠而扩大', () => {
  // ★变异审计抓出：给样本名加 .toLowerCase() 时全绿——授权的大小写语义
  //   此前既未定义也未测。文件名匹配在 Linux 上就是大小写敏感的，
  //   折叠会让 `--allow-drop=FOO` 意外放行 `foo`。授权只可收窄，故钉死原样保留。
  const r = parseDropArgs(['--allow-drop=Test_Eligibility', '--drop-reason=x']);
  assert.deepStrictEqual([...r.samples], ['Test_Eligibility'], '必须原样保留，不得折叠大小写');
  assert.ok(!r.samples.has('test_eligibility'), '大小写不同即不同样本');
});

check('★理由不得由别处的 --drop-reason 子串误配（防 includes 退化）', () => {
  const r = parseDropArgs(['--allow-drop=a', '--x--drop-reason=sneaky']);
  assert.strictEqual(r.ok, false, '仅"含有"该子串的参数不得被当成理由');
  assert.strictEqual(r.error, 'MISSING_REASON');
});

// ---- finalExitCode ----

check('★护栏已设 exitCode=1 → 不被 problems=0 覆盖成 0', () => {
  // 这正是上一轮真实发生的回归：拒绝写入却 exit 0
  assert.strictEqual(finalExitCode(1, 0), 1);
});

check('护栏未失败 + 有 problems → 1', () => {
  assert.strictEqual(finalExitCode(undefined, 3), 1);
  assert.strictEqual(finalExitCode(0, 3), 1);
});

check('★problemCount 边界：1 条不一致也必须 exit 1', () => {
  // ★变异审计抓出：原来只喂过 0 和 3，于是 `> 1`、`> 2`、`=== 3`、`!== 0`
  //   四种坏边界全部存活——**丢 1~2 条双引擎不一致会被静默放行**。
  //   边界必须钉在 0/1 交界上，否则「有问题」的判定形同虚设。
  assert.strictEqual(finalExitCode(0, 1), 1, '哪怕只有 1 条不一致也是失败');
  assert.strictEqual(finalExitCode(undefined, 1), 1);
  assert.strictEqual(finalExitCode(0, 2), 1);
  assert.strictEqual(finalExitCode(0, 0), 0);
});

check('★非法负数不得被当成"有问题"（防 !== 0 退化）', () => {
  assert.strictEqual(finalExitCode(0, -1), 0);
});

check('护栏未失败 + 无 problems → 0', () => {
  assert.strictEqual(finalExitCode(undefined, 0), 0);
  assert.strictEqual(finalExitCode(0, 0), 0);
});

check('★参数校验的 exit 2 不被降级', () => {
  assert.strictEqual(finalExitCode(2, 0), 2);
});

// ---- 错误文案 ----
//
// ★变异审计抓出：本文件此前**从未 import 过 DROP_ARG_ERRORS**，
//   两条文案整体清空成 '' 仍然全绿。文案是用户唯一的操作指引
//   （尤其"必须用等号"——写错会以为 flag 没生效转而改用更宽的写法），
//   删掉不该无人发现。

check('★MISSING_SAMPLES 文案非空且给出可操作指引', () => {
  const m = DROP_ARG_ERRORS.MISSING_SAMPLES;
  assert.ok(m && m.trim().length > 0, '文案不得为空');
  assert.ok(m.includes('--allow-drop='), '必须示范等号写法');
  assert.ok(m.includes('等号'), '必须明确"空格分隔不被识别"这一易错点');
});

check('★MISSING_REASON 文案非空且说明理由用途', () => {
  const m = DROP_ARG_ERRORS.MISSING_REASON;
  assert.ok(m && m.trim().length > 0, '文案不得为空');
  assert.ok(m.includes('--drop-reason'), '必须点名缺失的参数');
  assert.ok(m.includes('审计'), '必须说明理由会被留痕，供日后审计');
});

check('★两条错误码文案必须不同（防复制粘贴导致指引错位）', () => {
  assert.notStrictEqual(
    DROP_ARG_ERRORS.MISSING_SAMPLES,
    DROP_ARG_ERRORS.MISSING_REASON,
  );
});

console.log(`\ndrop-authorization guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
