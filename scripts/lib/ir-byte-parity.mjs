/**
 * Core IR v2 逐字节 parity 判定（ADR 0055 §6），供 parity-tier1.mjs `--mode=ir --full` 使用。
 *
 * 判定步骤（与 ADR §6 的 1–4 一一对应）：
 *   1. 两引擎各自输出规范字节（ts `serializeCoreIr`，Java `CoreIrJson.serialize` → `irCanonical`）；
 *   2. 每一侧必须是规范字节（重新规范化后逐字节不变），并通过 schema 与 validateCoreIrInvariants，
 *      任一侧不通过即 `schema-invalid`；
 *   3. 比较投影：删除全部 `origin.start.col` / `origin.end.col`（全局投影，不是豁免，不参与 stale 统计），
 *      再把仍在有效期内的值层豁免位置替换为 `{"$exempt":"<类别>"}`；
 *   4. 逐字节比较；不等时键集合、`kind`、数组长度或容器类型不同的报 `shape-diff`，其余报 `value-diff`，
 *      两类都附带 `{path, ts, java}`。
 *
 * 值层豁免只能落在 ADR §6 表列出的位置上：本模块对每次命中做位置校验（POSITION_GUARDS），
 * 匹配器越界（例如 V1 命中了非类型节点）直接抛错，而不是静默放宽比较范围。
 * 豁免表本身（VALUE_EXEMPTIONS）放在 parity-tier1.mjs，每项带 issue 链接、owner 角色与 `expires`。
 *
 * 规范序列化由调用方注入（`canonicalJson`，取自已构建的 aster-lang-ts，与 core CanonicalJson 字节一致），
 * schema / 不变式校验同样注入（`validate(tree) → problems[]`），本模块不依赖兄弟仓的加载方式。
 */

/** 判定结果的全部取值。前六个是逐样本判定，stale / expired 是一轮运行结束后对豁免表的判定。 */
export const IR_VERDICTS = Object.freeze([
  'identical', 'schema-invalid', 'shape-diff', 'value-diff', 'ts-failed', 'java-failed',
  'stale-exemption', 'expired-exemption',
]);

/** ADR §6 的值层分期类别。 */
export const EXEMPTION_CATEGORIES = Object.freeze({
  V1: '类型推断',
  V2: '能力推断',
  V3: '闭包捕获',
  V4: 'origin 行号',
});

/** ADR §6：每个类别的截止日最晚为 2027-01-31。 */
export const LATEST_EXPIRY = '2027-01-31';

/** Core IR v2 schema `$defs/Type` 的 kind 取值。 */
const TYPE_KINDS = new Set(['TypeName', 'TypeVar', 'TypeApp', 'Result', 'Maybe', 'Option', 'List', 'Map', 'FuncType', 'PiiType']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;
const V4_PATH = /\.origin\.end\.line$/;

/** 豁免表配置错误（缺 expires、类别未知、作用域不合法等）。门禁遇到即以基础设施错误退出。 */
export class ExemptionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExemptionConfigError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isContainer = (v) => v !== null && typeof v === 'object';
const isValidDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * 各类别允许命中的位置（ADR §6 表）。key 是该节点在父对象中的字段名。
 *   V1：`retTypeInferred:true` 的 `Func.ret`，或 `typeInferred:true` 的 Param / Field 的 `type`，且节点是类型节点；
 *   V2：`effectCapsExplicit:false` 的 `Func.effectCaps` 数组；
 *   V3：`Lambda.captures` 数组；
 *   V4：`origin.end.line` 整数标量。
 */
const POSITION_GUARDS = {
  V1: (key, node, parent) => isObject(node) && TYPE_KINDS.has(node.kind) && (
    (key === 'ret' && parent?.kind === 'Func' && parent.retTypeInferred === true) ||
    (key === 'type' && parent?.typeInferred === true && !('kind' in parent))),
  V2: (key, node, parent) => key === 'effectCaps' && Array.isArray(node) && parent?.kind === 'Func' && parent.effectCapsExplicit === false,
  V3: (key, node, parent) => key === 'captures' && Array.isArray(node) && parent?.kind === 'Lambda',
  V4: (key, node, parent, path) => key === 'line' && V4_PATH.test(path) && Number.isInteger(node),
};

/** 校验豁免表；不合法即抛 ExemptionConfigError。 */
export function validateExemptions(exemptions) {
  if (!Array.isArray(exemptions)) throw new ExemptionConfigError('VALUE_EXEMPTIONS 必须是数组');
  const seen = new Set();
  for (const e of exemptions) {
    const where = `VALUE_EXEMPTIONS[${isObject(e) ? e.id : '?'}]`;
    if (!isObject(e) || !Object.hasOwn(EXEMPTION_CATEGORIES, e.id)) throw new ExemptionConfigError(`${where}: id 必须是 V1–V4 之一`);
    if (seen.has(e.id)) throw new ExemptionConfigError(`${where}: 类别重复`);
    seen.add(e.id);
    if (typeof e.issue !== 'string' || !ISSUE_URL.test(e.issue)) throw new ExemptionConfigError(`${where}: issue 必须是 GitHub issue 链接`);
    if (typeof e.owner !== 'string' || e.owner.trim() === '') throw new ExemptionConfigError(`${where}: owner 角色必填`);
    if (!isValidDate(e.expires)) throw new ExemptionConfigError(`${where}: expires 必填，格式为 ISO 日期 YYYY-MM-DD`);
    if (e.expires > LATEST_EXPIRY) throw new ExemptionConfigError(`${where}: expires 最晚为 ${LATEST_EXPIRY}（ADR 0055 §6）`);
    if (e.id === 'V4') validateEntries(where, e);
    else validateCategory(where, e);
  }
}

/** V4 按 (语料文件, JSON 路径) 逐项登记，路径必须指向 origin.end.line。 */
function validateEntries(where, e) {
  if (e.scope !== 'entries') throw new ExemptionConfigError(`${where}: V4 的 scope 必须是 'entries'`);
  if (!Array.isArray(e.entries) || e.entries.length === 0) throw new ExemptionConfigError(`${where}: entries 不能为空`);
  const keys = new Set();
  for (const x of e.entries) {
    if (!isObject(x) || typeof x.file !== 'string' || typeof x.path !== 'string') throw new ExemptionConfigError(`${where}: 每项须为 {file, path}`);
    if (!x.path.startsWith('$.') || !V4_PATH.test(x.path)) throw new ExemptionConfigError(`${where}: ${x.file} ${x.path} 不是 origin.end.line 路径`);
    const k = entryKey(x.file, x.path);
    if (keys.has(k)) throw new ExemptionConfigError(`${where}: 登记项重复 ${x.file} ${x.path}`);
    keys.add(k);
  }
}

/** V1–V3 按类别判定位置，作用范围限定在显式列出的语料文件内。 */
function validateCategory(where, e) {
  if (e.scope !== 'category') throw new ExemptionConfigError(`${where}: scope 必须是 'category'`);
  if (typeof e.match !== 'function') throw new ExemptionConfigError(`${where}: match 必须是函数`);
  if (!Array.isArray(e.files) || e.files.length === 0 || !e.files.every((f) => typeof f === 'string')) {
    throw new ExemptionConfigError(`${where}: files 必须是非空的语料文件列表`);
  }
  if (new Set(e.files).size !== e.files.length) throw new ExemptionConfigError(`${where}: files 有重复项`);
}

const entryKey = (file, path) => `${file}\u0000${path}`;

/**
 * 建立一轮运行的豁免台账。`today`（YYYY-MM-DD）晚于 `expires` 的类别失效：不再豁免任何差异，
 * 并在 exemptionFindings 中报 expired-exemption。
 */
export function createExemptionLedger(exemptions, { today }) {
  validateExemptions(exemptions);
  if (!isValidDate(today)) throw new ExemptionConfigError(`运行日期必须是 YYYY-MM-DD：${today}`);
  return {
    today,
    active: exemptions.filter((e) => today <= e.expires).map(prepare),
    expired: exemptions.filter((e) => today > e.expires),
    /** 类别 id → Map(文件或登记项 → 被豁免的差异数) */
    masked: new Map(exemptions.map((e) => [e.id, new Map()])),
  };
}

function prepare(e) {
  return e.id === 'V4'
    ? { ...e, entryKeys: new Set(e.entries.map((x) => entryKey(x.file, x.path))) }
    : { ...e, fileSet: new Set(e.files) };
}

/** 比较投影第一步：删除全部 origin.start.col / origin.end.col。返回新树，不修改入参。 */
export function projectForCompare(tree) {
  return dropOriginCols(structuredClone(tree));
}

function dropOriginCols(node) {
  if (Array.isArray(node)) {
    node.forEach(dropOriginCols);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'origin' && isObject(value)) {
        if (isObject(value.start)) delete value.start.col;
        if (isObject(value.end)) delete value.end.col;
      } else {
        dropOriginCols(value);
      }
    }
  }
  return node;
}

/**
 * 判定单个语料文件。
 * @param {object} args
 * @param {string} args.file 语料相对路径（与 manifest 一致）
 * @param {{ok: boolean, bytes?: string, error?: string}} args.ts
 * @param {{ok: boolean, bytes?: string, error?: string}} args.java
 * @param {(tree: unknown) => {path: string, code: string}[]} args.validate schema + 不变式校验
 * @param {(value: unknown) => string} args.canonicalJson 规范序列化
 * @param {object} args.ledger createExemptionLedger 的返回值（被就地累计）
 * @returns {{verdict: string, diffs: object[], problems: object[], exempted: Record<string, number>, shapeCount: number, valueCount: number}}
 */
export function judgeSample({ file, ts, java, validate, canonicalJson, ledger }) {
  const row = { verdict: 'identical', diffs: [], problems: [], exempted: {}, shapeCount: 0, valueCount: 0 };
  if (!ts.ok) return { ...row, verdict: 'ts-failed' };
  if (!java.ok) return { ...row, verdict: 'java-failed' };

  const trees = {};
  for (const [side, bytes] of [['ts', ts.bytes], ['java', java.bytes]]) {
    const { tree, problems } = checkSide(bytes, validate, canonicalJson);
    trees[side] = tree;
    row.problems.push(...problems.map((p) => ({ side, ...p })));
  }
  if (row.problems.length > 0) return { ...row, verdict: 'schema-invalid' };
  if (ts.bytes === java.bytes) return row;

  const a = projectForCompare(trees.ts);
  const b = projectForCompare(trees.java);
  maskExemptions(a, b, '$', { file, ledger, canonicalJson, exempted: row.exempted });
  if (canonicalJson(a) === canonicalJson(b)) return row;

  collectDiffs(a, b, '$', row.diffs);
  row.shapeCount = row.diffs.filter((d) => d.class === 'shape').length;
  row.valueCount = row.diffs.length - row.shapeCount;
  // 形状差异优先列出：第一个 shape 差异即为该文件的主要失败点
  row.diffs.sort((x, y) => (x.class === y.class ? 0 : x.class === 'shape' ? -1 : 1));
  return { ...row, verdict: row.shapeCount > 0 ? 'shape-diff' : 'value-diff' };
}

/** 第 2 步：JSON 可解析、字节已是规范形式、schema 与不变式通过。 */
function checkSide(bytes, validate, canonicalJson) {
  let tree;
  try {
    tree = JSON.parse(bytes);
  } catch (e) {
    return { tree: null, problems: [{ path: '', code: 'invalid-json', message: e.message }] };
  }
  if (canonicalJson(tree) !== bytes) return { tree, problems: [{ path: '', code: 'non-canonical-bytes' }] };
  return { tree, problems: validate(tree) };
}

/**
 * 第 3 步的豁免替换：两侧并行遍历，只在结构对齐处（同 kind 的对象、等长数组）向下走。
 * 两侧都命中同一有效豁免时，把该位置替换为 {"$exempt": id}；两侧原值不同则记一次被豁免的差异。
 */
function maskExemptions(a, b, path, ctx) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return;
    for (let i = 0; i < a.length; i++) maskExemptions(a[i], b[i], `${path}[${i}]`, ctx);
    return;
  }
  if (!isObject(a) || !isObject(b) || a.kind !== b.kind) return;
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) continue;
    const childPath = `${path}.${key}`;
    const exemption = exemptionAt(ctx, childPath, key, a, b);
    if (!exemption) {
      maskExemptions(a[key], b[key], childPath, ctx);
      continue;
    }
    if (ctx.canonicalJson(a[key]) !== ctx.canonicalJson(b[key])) record(ctx, exemption, childPath);
    a[key] = { $exempt: exemption.id };
    b[key] = { $exempt: exemption.id };
  }
}

/** 返回在该位置对两侧都生效的豁免；匹配器命中 ADR 范围之外的位置时抛错。 */
function exemptionAt(ctx, path, key, parentA, parentB) {
  for (const e of ctx.ledger.active) {
    if (e.id === 'V4') {
      if (!e.entryKeys.has(entryKey(ctx.file, path))) continue;
      guard(e, path, key, parentA[key], parentA, 'ts');
      guard(e, path, key, parentB[key], parentB, 'java');
      return e;
    }
    if (!e.fileSet.has(ctx.file)) continue;
    const hitA = e.match(path, parentA[key], parentA) === true;
    const hitB = e.match(path, parentB[key], parentB) === true;
    if (hitA) guard(e, path, key, parentA[key], parentA, 'ts');
    if (hitB) guard(e, path, key, parentB[key], parentB, 'java');
    if (hitA && hitB) return e;
  }
  return null;
}

function guard(e, path, key, node, parent, side) {
  if (!POSITION_GUARDS[e.id](key, node, parent, path)) {
    throw new Error(`${e.id}（${EXEMPTION_CATEGORIES[e.id]}）匹配器命中了 ADR 0055 §6 范围之外的位置：${side} ${path}`);
  }
}

function record(ctx, e, path) {
  const bucket = ctx.ledger.masked.get(e.id);
  const k = e.id === 'V4' ? entryKey(ctx.file, path) : ctx.file;
  bucket.set(k, (bucket.get(k) ?? 0) + 1);
  ctx.exempted[e.id] = (ctx.exempted[e.id] ?? 0) + 1;
}

/** 第 4 步：找出全部差异路径并分类。容器类型、键集合、kind、数组长度不同即 shape。 */
function collectDiffs(a, b, path, out) {
  if (a === b) return;
  const shape = (p) => out.push({ class: 'shape', path: p.path ?? path, ts: summarize(p.ts), java: summarize(p.java) });
  if (isContainer(a) !== isContainer(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (isContainer(a) || isContainer(b)) return shape({ ts: a, java: b });
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return shape({ ts: a, java: b });
    for (let i = 0; i < a.length; i++) collectDiffs(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isObject(a) && isObject(b)) {
    if (a.kind !== b.kind) return shape({ path: `${path}.kind`, ts: a.kind, java: b.kind });
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) shape({ path: childPath, ts: a[key], java: b[key] });
      else collectDiffs(a[key], b[key], childPath, out);
    }
    return;
  }
  out.push({ class: 'value', path, ts: summarize(a), java: summarize(b) });
}

/** 差异值的展示形式：JSON 文本，过长截断；缺失的字段记为 undefined。 */
function summarize(v) {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/**
 * 一轮全语料运行结束后对豁免表的判定（ADR 0055 §6），结果都使门禁失败：
 *   expired-exemption：运行日期晚于 expires；
 *   stale-exemption：V1–V3 整个类别一处差异都没有被豁免（按类别判定）；V4 某个登记项不再有差异（按登记项判定）。
 * 两者都要求删掉对应项，以防豁免永久残留。
 */
export function exemptionFindings(ledger) {
  const findings = ledger.expired.map((e) => ({ verdict: 'expired-exemption', id: e.id, issue: e.issue, expires: e.expires, today: ledger.today }));
  for (const e of ledger.active) {
    const bucket = ledger.masked.get(e.id);
    if (e.id === 'V4') {
      for (const x of e.entries) {
        if (!bucket.has(entryKey(x.file, x.path))) findings.push({ verdict: 'stale-exemption', id: e.id, issue: e.issue, file: x.file, path: x.path });
      }
    } else if (bucket.size === 0) {
      findings.push({ verdict: 'stale-exemption', id: e.id, issue: e.issue });
    }
  }
  return findings;
}

/**
 * V1–V3 作用范围中本轮已没有被豁免差异的文件（类别仍有别处的差异，故不是 stale）。
 * 只用于报告，提示该文件可从 files 中删除以收窄范围；不使门禁失败——ADR §6 对这些类别按类别判定 stale，
 * 引擎修好一部分文件时不应让门禁变红。
 */
export function narrowableScopes(ledger) {
  const out = [];
  for (const e of ledger.active) {
    const bucket = ledger.masked.get(e.id);
    if (e.id === 'V4' || bucket.size === 0) continue;
    for (const f of e.files) if (!bucket.has(f)) out.push({ id: e.id, file: f });
  }
  return out;
}

/** 各类别本轮被豁免的差异总数（报告用）。 */
export function maskedCounts(ledger) {
  const out = {};
  for (const [id, bucket] of ledger.masked) out[id] = [...bucket.values()].reduce((s, n) => s + n, 0);
  return out;
}
