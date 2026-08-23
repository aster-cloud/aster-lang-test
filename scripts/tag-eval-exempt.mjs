#!/usr/bin/env node
/**
 * Tag samples that cannot have a meaningful pure-eval golden with an
 * `evalExempt` flag (+ reason) in their .meta.json, and report eval coverage
 * as `cases / (total - exempt)`.
 *
 * A sample is eval-exempt when it:
 *   - calls a side-effecting builtin (Http/Db/Files/Sql/Secrets/Ai/Interop) —
 *     its runtime needs real IO, not a deterministic golden;
 *   - declares effects / capabilities (`It performs`, `eff_*`) — the sample
 *     exists to test effect inference/enforcement, a compile-time concern;
 *   - is PII-typed (the sample tests PII propagation/typing, not eval output);
 *   - is a `bad_*` sample designed to fail type-checking.
 *
 * Usage:
 *   node scripts/tag-eval-exempt.mjs            # report coverage only (dry)
 *   node scripts/tag-eval-exempt.mjs --write    # write evalExempt into meta.json
 *   node scripts/tag-eval-exempt.mjs --check    # exit 1 if stamped flags drift from live classification (CI rot gate, audit #95)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { collectEvalCaseProblem } from './lib/eval-cases.mjs';
import { upsertDailyHistory } from './lib/history.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const POLICIES = join(ROOT, 'corpus', 'tier1-equivalence', 'policies');
const INPUTS = join(ROOT, 'corpus', 'tier1-equivalence', 'inputs');
const WRITE = process.argv.includes('--write');
// --check（audit #95 豁免锈蚀检测）：meta.json 里**盖章**的 evalExempt 标记与**实时**
// 分类不一致时以退出码 1 失败——陈旧的 evalExempt:true 会让 parity-tier1 守卫静默跳过
// 已可 eval 的样本（分母漂移），漏盖/错因同样是分类漂移。此前只有 --write 会顺手清理，
// 干跑与 --history 模式永远绿灯，锈蚀积到有人手动重跑 --write 为止。CI 用 --check 守门。
const CHECK = process.argv.includes('--check');
// --history=<file>: append a trend row `timestamp,total,value,rate` (value =
// covered, total = eval-able) so the dashboard can chart eval coverage over time.
const HISTORY_FILE = (() => {
  const a = process.argv.find((x) => x.startsWith('--history='));
  return a ? resolve(a.slice('--history='.length)) : null;
})();

/** Decide exemption + reason for a sample, or null if it is eval-able. */
function exemptReason(name, src) {
  if (name.startsWith('bad_')) {
    return { reason: 'type-check-fail', detail: 'designed to fail type-checking; no runtime output to assert' };
  }
  if (name.startsWith('eff_') || /\bIt performs\b|\brequires\b/.test(src)) {
    return { reason: 'effects', detail: 'tests effect inference/enforcement (a compile-time concern), not runtime output' };
  }
  if (/\b(Http|Db|Files|Sql|Secrets|Ai|IO|Repo)\.\w+\(/.test(src)) {
    return { reason: 'io', detail: 'calls a side-effecting IO builtin; runtime needs real effects, not a deterministic golden' };
  }
  if (/\bInterop\.\w+\(/.test(src)) {
    return { reason: 'interop', detail: 'calls a host-interop builtin not available in the pure evaluator' };
  }
  // PII: only exempt samples that actually exercise PII *flow* (propagation,
  // http/network sinks, nested calls). `pii_type_*` that merely return a
  // constant are eval-able and counted toward coverage.
  if (/^pii_(propagation|http|nested|function_return)/.test(name)) {
    return { reason: 'pii', detail: 'tests PII propagation/sink flow (a type-system concern), not runtime output' };
  }
  // Parser-only fixtures that call a function never defined in the module (and
  // not a stdlib namespace call): they fail in BOTH engines with "Undefined
  // function", so there is no runtime output to assert. Detect statically — a
  // call to a bare lowercase identifier that is neither `Rule <name>` nor a
  // `Let <name> be function …` binding anywhere in the source.
  if (callsUndefinedFunction(src)) {
    return { reason: 'undefined-call', detail: 'calls a function never defined in the module; fails in both engines (parser-only fixture)' };
  }
  // Two construction/dispatch forms that are unsupported in BOTH pure evaluators
  // (each fails at runtime in TS and Java alike, verified via gen-cases):
  //   • positional struct construction `TypeName(a, b, …)` — only the
  //     `TypeName with f set to …` form is implemented;
  //   • enum static methods `EnumType.equals(a, b)` — not a stdlib namespace.
  const unsup = usesUnsupportedConstruction(src);
  if (unsup) {
    return { reason: 'unsupported-syntax', detail: unsup };
  }
  return null;
}

// ★Date / Decimal 是双引擎已实现的 stdlib 命名空间（aster-truffle Builtins.java +
// DateBuiltinTest / DecimalBuiltinTest；TS 引擎同款），此前遗漏在白名单中。
// 注意分类规则「有 cases 即 eval-able，否则才走 exemptReason（含此白名单）」：
//  - `Date` 修复实质影响 `stdlib_date`——它当时无 golden，`Date.*` 命中"非白名单静态方法
//    → unsupported"而被误剔出 eval 分母（143/143 隐藏 date 的"伪 100%"）。
//  - `Decimal` 仅补齐白名单声明；`stdlib_decimal` 自 PR #52 起就有 `compute` golden，按
//    "有 cases 即 eval-able"规则一直在分母内，其覆盖状态不因本次改动而变。
const STDLIB_NAMESPACES = new Set(['Text', 'List', 'Map', 'Maybe', 'Option', 'Result', 'Date', 'Decimal']);

/** Returns a reason string if the source uses a construction/dispatch form that
 *  fails in both pure evaluators, else null. */
function usesUnsupportedConstruction(src) {
  // Collect Define'd type names, then look for a positional call to one.
  const definedTypes = new Set();
  for (const m of src.matchAll(/\bDefine\s+([A-Z]\w*)\b/g)) definedTypes.add(m[1]);
  // ★先识别 `When Type(...)` 模式解构：它虽也不被纯 evaluator 支持，但语义上是**模式解构**
  //   而非位置式结构体构造，须给准确 detail（否则 --write 会写错并反复覆盖回错误描述）。
  for (const m of src.matchAll(/\bWhen\s+([A-Z]\w*)\s*\(/g)) {
    if (definedTypes.has(m[1])) return `pattern destructuring \`When ${m[1]}(…)\` unsupported in both pure evaluators`;
  }
  // 位置式结构体构造 `Type(...)`（排除上面已处理的 `When Type(...)`）。
  for (const m of src.matchAll(/(?<!\bWhen\s)(?<![A-Za-z0-9_.])([A-Z]\w*)\s*\(/g)) {
    if (definedTypes.has(m[1])) return `positional struct construction \`${m[1]}(…)\` (only the \`with … set to\` form is supported in both engines)`;
  }
  // Qualified static call on a non-stdlib type, e.g. `Action.equals(...)`.
  for (const m of src.matchAll(/\b([A-Z]\w*)\.([a-z]\w*)\s*\(/g)) {
    if (!STDLIB_NAMESPACES.has(m[1])) return `enum/type static method \`${m[1]}.${m[2]}(…)\` unsupported in both engines`;
  }
  return null;
}

// 语言关键字/运算符词形：它们后面跟 `(` 不是函数调用（如 `not (...)`、`Let x be (...)`）。
const RESERVED_WORDS = new Set([
  'be', 'not', 'and', 'or', 'of', 'if', 'set', 'to', 'is', 'as', 'given', 'produce',
  'return', 'let', 'match', 'when', 'otherwise', 'some', 'none', 'with', 'has',
  'greater', 'less', 'than', 'least', 'most', 'equal', 'equals', 'at', 'the', 'a', 'an',
  // 算术/逻辑运算符词形：后跟括号是括号子表达式，不是函数调用
  'plus', 'minus', 'times', 'divided', 'modulo', 'by', 'integer',
]);

/** 源码是否调用了从未定义的裸小写函数名（无 `Rule name`、无 `Let name be function`），
 *  且不是 stdlib 的 `X.y(` 命名空间调用、也不是关键字/运算符词形。 */
function callsUndefinedFunction(src) {
  const defined = new Set();
  for (const m of src.matchAll(/\bRule\s+([a-z]\w*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\bLet\s+([a-z]\w*)\s+be\s+function\b/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?<![A-Za-z0-9_.])([a-z]\w*)\s*\(/g)) {
    const fn = m[1];
    if (!defined.has(fn) && !RESERVED_WORDS.has(fn)) return true;
  }
  return false;
}

const all = readdirSync(POLICIES).filter((f) => f.endsWith('.aster')).map((f) => f.replace('.aster', ''));

// hasCases = 有**有效** golden 的样本。★用共享 helper（scripts/lib/eval-cases.mjs）验证每个
// .cases.json，与 parity-tier1 守卫同一事实源——损坏/缺 entry/空数组的 cases 不算 covered，
// 否则覆盖率会虚高（tag 报 100% 而 parity 才失败）。无效 cases 直接让本工具非零退出。
const invalidCases = [];
const hasCases = new Set();
for (const f of readdirSync(INPUTS).filter((n) => n.endsWith('.cases.json'))) {
  const name = f.replace('.cases.json', '');
  let doc = null;
  let parseError = null;
  try {
    doc = JSON.parse(readFileSync(join(INPUTS, f), 'utf8'));
  } catch (e) {
    parseError = (e && e.message) || String(e);
  }
  const problem = collectEvalCaseProblem({ exists: true, parseError, doc });
  if (problem) invalidCases.push(`${f}: ${problem}`);
  else hasCases.add(name);
}
if (invalidCases.length > 0) {
  console.error(`[tag-eval-exempt] ${invalidCases.length} 个 .cases.json 无效（不计入覆盖）:`);
  for (const c of invalidCases) console.error(`  - ${c}`);
  process.exit(1);
}

let exemptCount = 0;
let taggedCount = 0;
let clearedCount = 0; // --write 时清除的 stale evalExempt 标记数
const exemptByReason = {};
const evalableNoCases = [];
const drift = []; // --check：盖章标记 vs 实时分类的漂移清单

for (const name of all) {
  const metaPath = join(POLICIES, `${name}.meta.json`);
  if (!existsSync(metaPath)) continue;
  const src = readFileSync(join(POLICIES, `${name}.aster`), 'utf8');
  // A sample with golden cases is, by definition, eval-able — never exempt it
  // (some samples have one undefined-call rule but a separately-covered entry).
  const ex = hasCases.has(name) ? null : exemptReason(name, src);

  if (ex) {
    exemptCount++;
    exemptByReason[ex.reason] = (exemptByReason[ex.reason] || 0) + 1;
    if (CHECK) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.evalExempt !== true) {
        drift.push(`${name}: 应豁免（${ex.reason}）但 meta.json 未盖 evalExempt 章`);
      } else if (meta.evalExemptReason !== ex.reason) {
        drift.push(`${name}: 豁免原因漂移 —— 盖章 "${meta.evalExemptReason}"，实时分类 "${ex.reason}"`);
      }
    }
    if (WRITE) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.evalExempt !== true || meta.evalExemptReason !== ex.reason) {
        meta.evalExempt = true;
        meta.evalExemptReason = ex.reason;
        meta.evalExemptDetail = ex.detail;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        taggedCount++;
      }
    }
  } else {
    // 非豁免（eval-able）。★清除**陈旧**的 evalExempt 标记：样本一旦补了 golden（或分类
    // 改判为 eval-able），旧的 `evalExempt:true`/`not-yet-eval-verified` 必须清掉——否则
    // parity-tier1 的守卫信任 meta.evalExempt，stale 标记会让缺 cases 的样本被静默跳过，
    // 正是本机制要消灭的分母漂移（Codex 复审发现 enterprise/personal/pii_type_in_data 三处 stale）。
    if (CHECK) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.evalExempt !== undefined || meta.evalExemptReason !== undefined || meta.evalExemptDetail !== undefined) {
        drift.push(`${name}: 陈旧豁免章（evalExempt=${JSON.stringify(meta.evalExempt)}, reason=${JSON.stringify(meta.evalExemptReason)}）—— 实时分类已为 eval-able，须清除（否则 parity-tier1 守卫会静默跳过它）`);
      }
    }
    if (WRITE && existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.evalExempt !== undefined || meta.evalExemptReason !== undefined || meta.evalExemptDetail !== undefined) {
        delete meta.evalExempt;
        delete meta.evalExemptReason;
        delete meta.evalExemptDetail;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        clearedCount++;
      }
    }
    if (!hasCases.has(name)) evalableNoCases.push(name);
  }
}

const total = all.length;
const evalable = total - exemptCount;
const covered = all.filter((n) => hasCases.has(n)).length;
const pct = ((covered / evalable) * 100).toFixed(1);

console.log('=== tier1 eval coverage ===');
console.log(`total samples:        ${total}`);
console.log(`eval-exempt:          ${exemptCount}  ${JSON.stringify(exemptByReason)}`);
console.log(`eval-able:            ${evalable}`);
console.log(`with .cases.json:     ${covered}`);
console.log(`coverage:             ${covered}/${evalable} = ${pct}% of eval-able samples`);
console.log(`\neval-able WITHOUT cases (${evalableNoCases.length} remaining to backfill):`);
console.log('  ' + evalableNoCases.join(', '));
if (WRITE) console.log(`\n✅ tagged ${taggedCount} meta.json with evalExempt.`);
else console.log('\n(dry run — pass --write to tag meta.json)');

if (HISTORY_FILE) {
  const ts = new Date().toISOString();
  const rate = evalable > 0 ? covered / evalable : 0;
  // Per-day upsert: one row per UTC day (last run wins).
  upsertDailyHistory(HISTORY_FILE, 'timestamp,total,value,rate', `${ts},${evalable},${covered},${rate.toFixed(4)}`);
  console.error(`[tag-eval-exempt] recorded coverage history → ${HISTORY_FILE} (${covered}/${evalable})`);
}

// --check 的失败放在 history 落盘之后：趋势行照记，锈蚀照失败（audit #95）。
if (CHECK) {
  if (drift.length > 0) {
    console.error(`\n[tag-eval-exempt --check] ${drift.length} 处豁免章与实时分类漂移：`);
    for (const d of drift) console.error(`  - ${d}`);
    console.error('修复：node scripts/tag-eval-exempt.mjs --write （重盖/清除后提交 meta.json）');
    process.exit(1);
  }
  console.log('[tag-eval-exempt --check] 豁免章与实时分类一致 ✓');
}
