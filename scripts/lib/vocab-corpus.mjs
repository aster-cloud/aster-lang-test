/**
 * 语料自带词汇（ADR 0051 §8）：manifest 条目形态、语料守卫与逐样本判定。
 *
 * ★为什么需要：领域词汇按位置解析后，同一份本地化源码的规范 IR 取决于词汇；
 * 不带词汇的 parity 门只能证明「两引擎都能解析」，证明不了「两引擎把同一个本地化名字
 * 解析到同一个规范名」。样本旁放同名 `<case>.vocab.json`（DomainVocabulary JSON，
 * 两引擎共用的输入形态），manifest 条目写成 `{ "path": …, "vocab": true }`，
 * parse / ir / eval 三门把词汇同时传给两个引擎。
 *
 * 带词汇的样本在 parse 门里走「解析 + 名称解析（R1 → lower → R2）」：
 *   - samples：两侧都成功，且两侧的警告码（如 W800）一致；meta.expectWarnings 声明时须与之相同；
 *   - mustReject：两侧都在**名称解析阶段**拒绝，且错误码集合相同并包含 meta.expectCode。
 *     诊断位置默认不比对（历史上 Java AST 无逐项 span，字段声明 / 构造字段 / 枚举成员处位置与 TS 不同）；
 *     样本 meta 声明 `compareDiagnosticLines: true` 后，两侧的「码 + 起始行」多重集合必须相同。
 *     列号不比对：两引擎的列基准与区间终点定义不同，行才是稳定契约。
 *
 * parity-tier1.mjs 与 test-vocab-corpus.mjs 共用本模块（单一事实源）。
 */

/** `<case>.aster` 旁的词汇文件后缀。 */
export const VOCAB_SUFFIX = '.vocab.json';

/** 带词汇的正例所在目录（相对 corpus/），其下每个 .aster 都必须登记在 manifest.samples。 */
export const VOCAB_SAMPLE_DIR = 'tier1-parity';

/** 样本路径对应的词汇文件路径。 */
export function vocabPathOf(asterPath) {
  return asterPath.replace(/\.aster$/, VOCAB_SUFFIX);
}

/**
 * 带词汇样本的 eval golden：`<目录>/inputs/<case>.cases.json`（与 tier1-equivalence 的 policies/inputs 布局同构）。
 * ★刻意不放在样本旁：aster-lang-test JVM 包的 CorpusLoader.readCases() 会把旁边的 `<case>.cases.json`
 * 当作 tier1 golden，交给不传词汇的消费方（如 core 的 DualEngineCrossLangTest）执行，必然失败。
 */
export function casesPathOf(asterPath) {
  return asterPath.replace(/([^/]+)\.aster$/, 'inputs/$1.cases.json');
}

/**
 * 规范化 manifest 列表：条目为字符串（无词汇）或 `{ path, vocab: true }`。
 * 返回 { entries: [{ rel, vocab }], problems }。
 */
export function normalizeEntries(list, field) {
  const entries = [];
  const problems = [];
  if (list === undefined) return { entries, problems };
  if (!Array.isArray(list)) return { entries, problems: [`manifest.${field} must be an array`] };
  for (const item of list) {
    if (typeof item === 'string') {
      entries.push({ rel: item, vocab: false });
      continue;
    }
    const problem = objectEntryProblem(item);
    if (problem) {
      problems.push(`manifest.${field}: ${problem}`);
      continue;
    }
    entries.push({ rel: item.path, vocab: true });
  }
  return { entries, problems };
}

function objectEntryProblem(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return `entry must be a path string or { "path", "vocab": true }, got ${JSON.stringify(item)}`;
  }
  const extra = Object.keys(item).filter((k) => k !== 'path' && k !== 'vocab');
  if (extra.length > 0) return `${JSON.stringify(item)} has unknown key(s): ${extra.join(', ')}`;
  if (typeof item.path !== 'string' || item.path === '') return `${JSON.stringify(item)} needs a non-empty "path"`;
  // 无词汇的样本写成字符串：对象形态只为携带词汇，避免出现两种等价写法
  if (item.vocab !== true) return `${item.path}: object entries must set "vocab": true (plain samples are strings)`;
  return null;
}

/**
 * 语料守卫。返回问题列表（空 = 一致）。
 *
 * samples / mustReject：normalizeEntries 的 entries；
 * vocabOnDisk：corpus 下全部 `.vocab.json`（相对 corpus/）；
 * parityAsterOnDisk：tier1-parity/ 下全部 `.aster`（相对 corpus/）；
 * parityCasesOnDisk：tier1-parity/ 下全部 `.cases.json`（相对 corpus/）；
 * metaOf(rel)：读取样本 meta（无则 null）。
 */
export function checkVocabCorpus({ samples, mustReject, vocabOnDisk, parityAsterOnDisk, parityCasesOnDisk = [], metaOf }) {
  const problems = [];
  const all = [...samples, ...mustReject];
  const vocabSet = new Set(vocabOnDisk);
  const claimed = new Set(all.filter((e) => e.vocab).map((e) => vocabPathOf(e.rel)));
  for (const e of all) {
    if (e.vocab && !vocabSet.has(vocabPathOf(e.rel))) {
      problems.push(`${e.rel}: manifest says "vocab": true but ${vocabPathOf(e.rel)} does not exist`);
    }
  }
  for (const rel of vocabOnDisk) {
    if (!claimed.has(rel)) {
      problems.push(`${rel} is not claimed by any manifest entry with "vocab": true — the engines would never see it`);
    }
  }
  const sampleRels = new Set(samples.map((e) => e.rel));
  for (const rel of parityAsterOnDisk) {
    if (!sampleRels.has(rel)) {
      problems.push(`${rel} is under ${VOCAB_SAMPLE_DIR}/ but not in manifest.samples — all three gates would SKIP it silently`);
    }
  }
  const loadableCases = new Set(samples.filter((e) => e.vocab).map((e) => casesPathOf(e.rel)));
  for (const rel of parityCasesOnDisk) {
    if (!loadableCases.has(rel)) {
      problems.push(`${rel} cannot be loaded by any vocab sample (expected <dir>/inputs/<case>.cases.json beside a manifest entry) — its cases would never run`);
    }
  }
  for (const e of mustReject) problems.push(...expectCodeProblems(e, metaOf(e.rel) || {}));
  for (const e of samples) {
    if (!e.vocab && (metaOf(e.rel) || {}).compareDiagnosticLines !== undefined) {
      problems.push(`${e.rel}: compareDiagnosticLines is only checked for vocab entries`);
    }
  }
  for (const e of all.filter((x) => x.vocab)) {
    const value = (metaOf(e.rel) || {}).compareDiagnosticLines;
    if (value !== undefined && typeof value !== 'boolean') {
      problems.push(`${e.rel}: compareDiagnosticLines must be a boolean, got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/**
 * 带词汇样本是否比较两引擎诊断的「码@起始行」。默认比较（两引擎逐项 span 已对齐，aster-lang-test#174-2）；
 * 只有 meta 显式写 `"compareDiagnosticLines": false` 才关闭，关闭时应在 meta.source 写明原因。
 */
export function compareLinesOf(meta) {
  return meta?.compareDiagnosticLines !== false;
}

function expectCodeProblems(entry, meta) {
  const code = meta.expectCode;
  if (!entry.vocab && meta.compareDiagnosticLines !== undefined) {
    return [`${entry.rel}: compareDiagnosticLines is only checked for vocab entries`];
  }
  if (!entry.vocab) {
    // 无词汇的必拒样本只在语法阶段判定，expectCode 不会被检查——写了也是谎言
    return code === undefined ? [] : [`${entry.rel}: expectCode is only checked for vocab entries`];
  }
  if (typeof code !== 'string' || !/^E\d{3}$/.test(code)) {
    return [`${entry.rel}: vocab mustReject meta must declare "expectCode" (e.g. "E804")`];
  }
  return [];
}

const uniqSorted = (codes) => [...new Set(codes || [])].sort();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 诊断位置比较：两侧各自给出 locs（[{ code, line, col }]），按「码@起始行」的有序多重集合比较。
 * 返回 null 表示通过，否则 { verdict, reason }。任一侧缺 locs 是 'locs-missing'——
 * 声明了要比位置却拿不到位置，不能当作通过。
 */
function compareLocs(ts, java) {
  if (!Array.isArray(ts.locs)) return { verdict: 'locs-missing', reason: 'TS result carries no diagnostic locations' };
  if (!Array.isArray(java.locs)) return { verdict: 'locs-missing', reason: 'Java result carries no diagnostic locations (engine/CLI too old?)' };
  const keyOf = (locs) => locs.map((l) => `${l.code}@${l.line}`).sort();
  const tk = keyOf(ts.locs);
  const jk = keyOf(java.locs);
  if (sameList(tk, jk)) return null;
  return { verdict: 'line-mismatch', reason: `diagnostic lines differ: ts=[${tk}] java=[${jk}]` };
}

/**
 * 带词汇正例的判定。ts / java 形如 { ok, stage?, codes?, warnings?, err?, crash? }。
 * 返回 { verdict, reason }，verdict 为 'pass' 才算通过。compareLines 为真时另外比较诊断位置。
 */
export function judgeVocabSample({ ts, java, expectWarnings = null, compareLines = false }) {
  if (!ts.ok && !java.ok) return { verdict: 'both-fail', reason: `ts: ${ts.err}; java: ${java.err}` };
  if (!ts.ok) return { verdict: 'divergent', reason: `TS failed: ${ts.err}` };
  if (!java.ok) return { verdict: 'divergent', reason: `Java failed: ${java.err}` };
  const tw = uniqSorted(ts.warnings);
  const jw = uniqSorted(java.warnings);
  if (!sameList(tw, jw)) {
    return { verdict: 'warning-mismatch', reason: `warnings differ: ts=[${tw}] java=[${jw}]` };
  }
  if (expectWarnings !== null && !sameList(tw, uniqSorted(expectWarnings))) {
    return { verdict: 'warning-mismatch', reason: `expected warnings [${uniqSorted(expectWarnings)}], both engines gave [${tw}]` };
  }
  const locProblem = compareLines ? compareLocs(ts, java) : null;
  return locProblem ?? { verdict: 'pass', reason: null };
}

/**
 * 带词汇必拒样本的判定：两侧都在名称解析阶段拒绝，错误码集合相同且包含 expectCode。
 * 返回 { verdict, reason }，verdict 为 'rejected' 才算通过。
 */
export function judgeVocabReject({ ts, java, expectCode, compareLines = false }) {
  if (ts.ok && java.ok) return { verdict: 'both-accepted', reason: 'TS accepted and Java accepted' };
  if (ts.ok) return { verdict: 'ts-accepted', reason: 'TS accepted (only Java rejects)' };
  if (java.ok) return { verdict: 'java-accepted', reason: 'Java accepted (only TS rejects)' };
  // 语法错误或崩溃也是「拒绝」，但不是本例要锁定的名称解析拒绝：样本写错时不得假通过
  if (ts.stage !== 'resolve') return { verdict: 'ts-wrong-stage', reason: `TS did not fail in name resolution: ${ts.err}` };
  if (java.stage !== 'resolve') return { verdict: 'java-wrong-stage', reason: `Java did not fail in name resolution: ${java.err}` };
  const tc = uniqSorted(ts.codes);
  const jc = uniqSorted(java.codes);
  if (!sameList(tc, jc)) return { verdict: 'code-mismatch', reason: `error codes differ: ts=[${tc}] java=[${jc}]` };
  if (!tc.includes(expectCode)) return { verdict: 'code-mismatch', reason: `expected ${expectCode}, both engines gave [${tc}]` };
  const locProblem = compareLines ? compareLocs(ts, java) : null;
  return locProblem ?? { verdict: 'rejected', reason: null };
}
