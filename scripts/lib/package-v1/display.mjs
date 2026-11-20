/**
 * 包格式 1.1 显示排版的参照实现（ADR 0059 修订 4 §4 规则 L1–L9、D7 反向映射）。
 *
 * 两个 CLI（ts `./layout`、core `aster.core.layout`）照此实现，并跑同一组向量（conformance/package-v1/vectors/
 * layout.json、display-reconstruct.json、display-padding.json、keyword-spellings.json）。这里只用字符串运算、
 * foldKey（NFC + Unicode 15.1 简单折叠 C+S）与标识符字符类 [\p{L}\p{M}\p{Nd}_]，不依赖任何词法器：
 * 值是否被切进结构 span 由 L9 的补空格不变性交给编译器判定（见 README「显示排版」）。
 *
 * 共同约定：偏移单位为 UTF-16 code unit；换行符指 \n 与 \r，不归一。
 * 本文件是参照实现（--verify-engines 与单测用），不进 CLI。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, StrictJsonError } from './strict-json.mjs';

/** LAYOUT_LIMITS（ADR 0058 §7.6，数值不改）：字节按 UTF-8 计；单个结构 display 按码点计。 */
export const LAYOUT_LIMITS = Object.freeze({
  sourceBytes: 12288,
  sourceLines: 200,
  spans: 400,
  serializedBytes: 49152,
  displayBytes: 24576,
  structuralDisplayChars: 256,
});

/** L7 的 ASCII 运算符字符。 */
export const ASCII_OPERATORS = Object.freeze(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~']);

/** L5：结构 canonical 不得含的字符串字面量引号（ASCII 直引号、弯引号、中文「」『』）。 */
const QUOTES = /["“”「」『』]/u;
const IDENT = /[\p{L}\p{M}\p{Nd}_]/u;
const DIGIT = /\p{Nd}/u;

/** 规则失败：rule 为 'L1'…'L9'，message 只用于诊断（不跨实现比较）。 */
export class DisplayRuleError extends Error {
  constructor(rule, message) {
    super(`${rule}: ${message}`);
    this.name = 'DisplayRuleError';
    this.rule = rule;
  }
}
const fail = (rule, message) => {
  throw new DisplayRuleError(rule, message);
};

// ---------------------------------------------------------------------------
// foldKey（与 ts casefold.ts、core CaseFold.foldKey 同一定义）
// ---------------------------------------------------------------------------
const CASEFOLD = (() => {
  const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'casefold-15.1.json'), 'utf8'));
  return new Map(Object.entries(raw.map).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
})();

/** NFC(逐码点简单折叠(NFC(s)))。 */
export function foldKey(s) {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const mapped = CASEFOLD.get(ch.codePointAt(0));
    out += mapped === undefined ? ch : String.fromCodePoint(mapped);
  }
  return out.normalize('NFC');
}

// ---------------------------------------------------------------------------
// 基本形态（与 ts src/layout/format.ts 相同）
// ---------------------------------------------------------------------------
const isContent = (s) => 'text' in s;
export const canonicalOf = (s) => (isContent(s) ? s.text : s.canonical);
export const displayOf = (s) => (isContent(s) ? s.text : s.display);
export const toCanonical = (layout) => layout.spans.map(canonicalOf).join('');
export const toDisplay = (layout) => layout.spans.map(displayOf).join('');

/** UTF-8 字节数（孤立代理按替换字符 3 字节计，同 ts utf8Length）。 */
export function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasExactKeys = (o, keys) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** ts readLayout 的结构校验；失败为 L1。 */
export function readLayout(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['v', 'spans'])) fail('L1', 'layout must be exactly {v, spans}');
  if (value.v !== 1) fail('L1', 'layout.v must be 1');
  if (!Array.isArray(value.spans) || value.spans.length === 0) fail('L1', 'layout.spans must be a non-empty array');
  const spans = value.spans.map((raw, i) => {
    if (isPlainObject(raw) && hasExactKeys(raw, ['text'])) {
      if (typeof raw.text !== 'string' || raw.text === '') fail('L1', `spans[${i}].text must be a non-empty string`);
      return { text: raw.text };
    }
    if (isPlainObject(raw) && hasExactKeys(raw, ['canonical', 'display'])) {
      if (typeof raw.canonical !== 'string' || raw.canonical === '') fail('L1', `spans[${i}].canonical must be a non-empty string`);
      if (typeof raw.display !== 'string') fail('L1', `spans[${i}].display must be a string`);
      return { canonical: raw.canonical, display: raw.display };
    }
    return fail('L1', `spans[${i}] must be exactly {text} or {canonical, display}`);
  });
  for (const [view, of] of [['canonical', canonicalOf], ['display', displayOf]]) {
    let prev = '';
    for (const piece of spans.map(of)) {
      if (piece === '') continue;
      if (prev !== '' && isHigh(prev.charCodeAt(prev.length - 1)) && isLow(piece.charCodeAt(0))) {
        fail('L1', `a surrogate pair is split across spans in the ${view} view`);
      }
      prev = piece;
    }
  }
  return { v: 1, spans };
}

/** 相邻内容 span 合并。 */
export function mergeContentSpans(spans) {
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (isContent(s) && last && isContent(last)) out[out.length - 1] = { text: last.text + s.text };
    else out.push(s);
  }
  return out;
}

/** ECMAScript JSON.stringify 的字符串转义（ts 序列化即用它；Java 侧须逐字复刻）。 */
export const jsonString = (s) => JSON.stringify(s);

/** ADR 0058 §7.3 的确定性序列化（先结构校验、再合并相邻内容 span）。 */
export function serializeLayout(layout) {
  const spans = mergeContentSpans(readLayout(layout).spans);
  const one = (s) => (isContent(s)
    ? `{"text":${jsonString(s.text)}}`
    : `{"canonical":${jsonString(s.canonical)},"display":${jsonString(s.display)}}`);
  return `{"v":1,"spans":[${spans.map(one).join(',')}]}`;
}

/**
 * L1（与 L2 的序列化字节上限）：严格 JSON → 结构 → 文件字节等于 serializeLayout 的 UTF-8。
 * 先按 serializedBytes 判大小再解析（修订 §9「资源耗尽」），超出为 L2。
 */
export function parseLayoutStrict(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length > LAYOUT_LIMITS.serializedBytes) fail('L2', `layout.json exceeds ${LAYOUT_LIMITS.serializedBytes} bytes`);
  let value;
  try {
    value = parseStrictJson(buf);
  } catch (e) {
    if (e instanceof StrictJsonError) fail('L1', `layout.json is not strict JSON (${e.reason})`);
    throw e;
  }
  const layout = readLayout(value);
  if (!Buffer.from(serializeLayout(layout), 'utf8').equals(buf)) fail('L1', 'layout.json is not in canonical serialized form');
  return layout;
}

// ---------------------------------------------------------------------------
// L2–L7（字符串规则，不编译）
// ---------------------------------------------------------------------------
/** 源码行数：按 \r\n、\r、\n 断行，末尾换行不另计一行；空源码为 0 行（同 ts）。 */
function lineCount(source) {
  if (source === '') return 0;
  const breaks = source.match(/\r\n|\r|\n/g)?.length ?? 0;
  return /[\r\n]$/.test(source) ? breaks : breaks + 1;
}

function storedSpanCount(spans) {
  let n = 0;
  let prevText = false;
  for (const s of spans) {
    if (!(isContent(s) && prevText)) n++;
    prevText = isContent(s);
  }
  return n;
}

/**
 * 源码的两项规模：字节数与行数。给字节时直接在字节上数（\r、\n 在 UTF-8 中只作单字节出现），与解码无关，
 * 非法 UTF-8 的 policy.aster 同样有确定的结论；给文本时按 UTF-8 长度与 lineCount。合法 UTF-8 下两者相同。
 */
export function sourceMeasures(source) {
  if (typeof source === 'string') return { bytes: utf8Length(source), lines: lineCount(source) };
  const b = Buffer.from(source);
  if (b.length === 0) return { bytes: 0, lines: 0 };
  let breaks = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) breaks++;
    else if (b[i] === 0x0d) {
      breaks++;
      if (b[i + 1] === 0x0a) i++;
    }
  }
  const last = b[b.length - 1];
  return { bytes: b.length, lines: last === 0x0a || last === 0x0d ? breaks : breaks + 1 };
}

/** L2：六项上限，按 ts assertWithinLimits 的顺序，首个超出即失败。source 为规范源码的文本或字节。 */
export function checkLimits(layout, source) {
  const src = sourceMeasures(source);
  const measures = [
    ['sourceBytes', () => src.bytes],
    ['sourceLines', () => src.lines],
    ['spans', () => storedSpanCount(layout.spans)],
    ['serializedBytes', () => utf8Length(serializeLayout(layout))],
    ['displayBytes', () => utf8Length(toDisplay(layout))],
    ['structuralDisplayChars', () => Math.max(0, ...layout.spans.filter((s) => !isContent(s)).map((s) => [...s.display].length))],
  ];
  for (const [name, measure] of measures) {
    const actual = measure();
    if (actual > LAYOUT_LIMITS[name]) fail('L2', `${name} ${actual} exceeds ${LAYOUT_LIMITS[name]}`);
  }
}

/** ECMAScript String.prototype.trim 所认的空白（WhiteSpace ∪ LineTerminator）。 */
const ES_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const isEsBlank = (s) => [...s].every((ch) => ES_WHITESPACE.has(ch.codePointAt(0)));

/** L5：至少一个内容 span 去掉 ECMAScript 空白后非空；结构 canonical 不含引号。 */
export function checkContentParity(layout) {
  for (const s of layout.spans) {
    if (!isContent(s) && QUOTES.test(s.canonical)) fail('L5', `structural span canonical contains a string literal quote: ${jsonString(s.canonical)}`);
  }
  if (!layout.spans.some((s) => isContent(s) && !isEsBlank(s.text))) fail('L5', 'layout has no non-empty content span');
}

const isIdentChar = (ch) => ch !== undefined && IDENT.test(ch);
/** at 之前一个码点（不存在为 undefined）。 */
function codePointBefore(s, at) {
  if (at <= 0) return undefined;
  const c = s.charCodeAt(at - 1);
  if (isLow(c) && at >= 2 && isHigh(s.charCodeAt(at - 2))) return s.slice(at - 2, at);
  return s[at - 1];
}
function codePointAt(s, at) {
  if (at >= s.length) return undefined;
  return String.fromCodePoint(s.codePointAt(at));
}

/**
 * 「整词出现」：needle 在 haystack 中出现，且该出现的前一字符与后一字符（若有）都不属标识符字符类。
 * 两个参数都应已经 foldKey；空 needle 永不出现。
 */
export function containsWholeWord(haystack, needle) {
  if (needle === '') return false;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (!isIdentChar(codePointBefore(haystack, i)) && !isIdentChar(codePointAt(haystack, i + needle.length))) return true;
  }
  return false;
}

const foldAll = (list) => [...new Set(list.map(foldKey))].filter((s) => s !== '');

/** L6：结构 canonical 不含 \p{Nd}，不整词出现词汇 localized 与字面量关键词拼写。 */
export function checkStructuralValues(layout, vocabularyLocalized, literalKeywords) {
  const names = foldAll([...vocabularyLocalized, ...literalKeywords]);
  for (const s of layout.spans) {
    if (isContent(s)) continue;
    if (DIGIT.test(s.canonical)) fail('L6', `structural span canonical contains a digit: ${jsonString(s.canonical)}`);
    const folded = foldKey(s.canonical);
    const hit = names.find((n) => containsWholeWord(folded, n));
    if (hit !== undefined) fail('L6', `structural span canonical contains ${jsonString(hit)}: ${jsonString(s.canonical)}`);
  }
}

/**
 * L7 的运算符集合排序：码点数降序、同长按码点序。spellings 为全部拼写（ASCII 运算符字符由此函数并入），
 * 均经 foldKey、去重。
 */
export function operatorTable(operatorSpellings) {
  const all = foldAll([...ASCII_OPERATORS, ...operatorSpellings]);
  const cps = (s) => [...s].map((c) => c.codePointAt(0));
  return all
    .map((s) => ({ s, cps: cps(s), word: [...s].some(isIdentChar) }))
    .sort((a, b) => {
      if (a.cps.length !== b.cps.length) return b.cps.length - a.cps.length;
      for (let i = 0; i < a.cps.length; i++) if (a.cps[i] !== b.cps[i]) return a.cps[i] - b.cps[i];
      return 0;
    });
}

/** 一段文本的运算符序列（L7）：在 foldKey 后的文本上从左到右扫描，命中即记下并跳过，否则前进一个码点。 */
export function operatorSequence(text, table) {
  const t = foldKey(text);
  const out = [];
  let i = 0;
  while (i < t.length) {
    const hit = table.find((op) => t.startsWith(op.s, i)
      && (!op.word || (!isIdentChar(codePointBefore(t, i)) && !isIdentChar(codePointAt(t, i + op.s.length)))));
    if (hit) {
      out.push(hit.s);
      i += hit.s.length;
    } else {
      i += t.codePointAt(i) > 0xffff ? 2 : 1;
    }
  }
  return out;
}

/** L7：每个结构 span 的 canonical 与 display 的运算符序列完全相同。 */
export function checkOperators(layout, operatorSpellings) {
  const table = operatorTable(operatorSpellings);
  for (const s of layout.spans) {
    if (isContent(s)) continue;
    const c = operatorSequence(s.canonical, table);
    const d = operatorSequence(s.display, table);
    if (c.length !== d.length || c.some((op, i) => op !== d[i])) {
      fail('L7', `structural span hides or rewrites an operator: ${jsonString(s.canonical)} -> ${jsonString(s.display)}`);
    }
  }
}

/** 严格 UTF-8 解码（不去 BOM）；失败返回 null。 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 包排版 L1–L7（不编译）。source 为 policy/policy.aster 的字节或已解码文本；
 * 成功返回解析后的排版，失败抛 DisplayRuleError。
 */
export function checkPackageLayout({ layoutBytes, displayBytes, source, layoutVersion, vocabularyLocalized, literalKeywords, operatorSpellings }) {
  const layout = parseLayoutStrict(layoutBytes);
  if (layout.v !== layoutVersion) fail('L1', `layout v ${layout.v} differs from manifest display.layoutVersion ${layoutVersion}`);
  const text = typeof source === 'string' ? source : decodeUtf8(source);
  checkLimits(layout, source);
  if (text === null || toCanonical(layout) !== text) fail('L3', 'toCanonical(layout) differs from policy/policy.aster');
  if (!Buffer.from(toDisplay(layout), 'utf8').equals(Buffer.from(displayBytes))) fail('L4', 'display.aster differs from toDisplay(layout)');
  checkContentParity(layout);
  checkStructuralValues(layout, vocabularyLocalized, literalKeywords);
  checkOperators(layout, operatorSpellings);
  return layout;
}

/** 派生排版 L'（run --display / show --from-display）：L2、L5、L6、L7。 */
export function checkDerivedLayout(layout, vocabularyLocalized, literalKeywords, operatorSpellings) {
  checkLimits(layout, toCanonical(layout));
  checkContentParity(layout);
  checkStructuralValues(layout, vocabularyLocalized, literalKeywords);
  checkOperators(layout, operatorSpellings);
}

// ---------------------------------------------------------------------------
// L8 / L9 的字符串部分
// ---------------------------------------------------------------------------
/** IR 中键为 name 或 written 的全部字符串值，按 JSON 文本中的出现顺序去重。 */
export function irNameStrings(coreIrJson) {
  const out = [];
  const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'name' || k === 'written') && typeof x === 'string') {
          if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
          }
        } else walk(x);
      }
    }
  };
  walk(JSON.parse(coreIrJson));
  return out;
}

/** L8：整词出现在任一结构 canonical 中的 IR 名字（按 irNames 顺序）。 */
export function structuralNameHits(layout, irNames) {
  const structural = layout.spans.filter((s) => !isContent(s)).map((s) => foldKey(s.canonical));
  const hits = [];
  for (const name of irNames) {
    const n = foldKey(name);
    if (structural.some((c) => containsWholeWord(c, n))) hits.push(name);
  }
  return hits;
}

const isNewline = (c) => c === '\n' || c === '\r';

/**
 * L9 的 P：在全部结构 span 的起止偏移 p 处插入一个 U+0020，跳过文首文末、换行之后与行首缩进内的位置；
 * 按 p 从大到小插入。
 */
export function padStructuralSpans(layout) {
  const c = toCanonical(layout);
  const bounds = new Set();
  let at = 0;
  for (const s of layout.spans) {
    const len = canonicalOf(s).length;
    if (!isContent(s)) {
      bounds.add(at);
      bounds.add(at + len);
    }
    at += len;
  }
  const eligible = (p) => {
    if (p <= 0 || p >= c.length || isNewline(c[p - 1])) return false;
    let q = p - 1;
    while (q >= 0 && !isNewline(c[q])) {
      if (c[q] !== ' ' && c[q] !== '\t') return true;
      q--;
    }
    return false;
  };
  let out = c;
  for (const p of [...bounds].filter(eligible).sort((a, b) => b - a)) out = `${out.slice(0, p)} ${out.slice(p)}`;
  return out;
}

// ---------------------------------------------------------------------------
// D7：从改过的显示文本还原（解的个数 0 / 1 / ≥ 2）
// ---------------------------------------------------------------------------
/** KMP：pattern 在 text 中全部出现的起点标记（pattern 非空）。 */
function occurrences(text, pattern) {
  const marks = new Uint8Array(text.length + 1);
  const m = pattern.length;
  if (m === 0) {
    marks.fill(1);
    return marks;
  }
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1];
    if (pattern[i] === pattern[k]) k++;
    fail[i] = k;
  }
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) k = fail[k - 1];
    if (text[i] === pattern[k]) k++;
    if (k === m) {
      marks[i - m + 1] = 1;
      k = fail[k - 1];
    }
  }
  return marks;
}

const cap = (n) => (n > 2 ? 2 : n);

/** 合并形态 → D_0 c_1 D_1 … c_n D_n。groups[k] 为第 k 段结构 span 的下标列表。 */
function segments(layout) {
  const contents = [];
  const groups = [[]];
  layout.spans.forEach((s, i) => {
    if (isContent(s)) {
      contents.push(s.text);
      groups.push([]);
    } else groups[groups.length - 1].push(i);
  });
  const D = groups.map((g) => g.map((i) => layout.spans[i].display).join(''));
  return { contents, D };
}

function firstDivergence(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 反向映射（修订 D7）。edited 已严格 UTF-8 解码、去掉至多一个 BOM；文末换行规则在这里处理。
 * 返回 {kind:'unique', layout} | {kind:'unmappable', offset, crlf} | {kind:'ambiguous', offset}。
 * offset 只用于诊断，不跨实现比较。
 */
export function reconstructFromDisplay(layout, edited) {
  const display = toDisplay(layout);
  const crlf = edited.includes('\r\n') && !display.includes('\r\n');
  if (utf8Length(edited) > LAYOUT_LIMITS.displayBytes) return { kind: 'unmappable', offset: 0, crlf };
  let E = edited;
  if (!display.endsWith('\n') && E.endsWith('\n')) E = E.slice(0, E.endsWith('\r\n') ? -2 : -1);
  const unmappable = () => ({ kind: 'unmappable', offset: firstDivergence(E, display), crlf });
  const { contents, D } = segments(layout);
  const n = contents.length;
  const L = E.length;
  if (n === 0) return E === display ? { kind: 'unique', layout } : unmappable();
  const head = D[0];
  const tail = D[n];
  if (head.length + tail.length > L || !E.startsWith(head) || !E.endsWith(tail)) return unmappable();
  const lastEnd = L - tail.length;

  // F[k][2p+f]：c_k 从 p 开始、f=1 表示必须原样的部分解个数（截到 2）
  const F = Array.from({ length: n }, () => new Uint8Array(2 * (L + 1)));
  const origAt = contents.map((o) => occurrences(E, o));
  F[0][2 * head.length] = 1;
  const prefix = new Int32Array(L + 2);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const Fk = F[k];
    const o = contents[k];
    const om = origAt[k];
    // prefix[e] = Σ_{p<e} F[p][自由]（各项已截到 2，和精确，差也精确）
    prefix[0] = 0;
    for (let p = 0; p <= L; p++) prefix[p + 1] = prefix[p] + Fk[2 * p];
    // 终点 e 的「原样」与「改过」两类计数
    const orig = (e) => {
      const p = e - o.length;
      return p >= 0 && om[p] ? cap(Fk[2 * p] + Fk[2 * p + 1]) : 0;
    };
    const modified = (e) => {
      const p = e - o.length;
      const own = p >= 0 && om[p] ? Fk[2 * p] : 0;
      return cap(prefix[e] - own);
    };
    if (k === n - 1) {
      total = cap(orig(lastEnd) + modified(lastEnd));
      break;
    }
    const next = F[k + 1];
    const Dk = D[k + 1];
    if (Dk !== '') {
      const dm = occurrences(E, Dk);
      for (let e = 1; e + Dk.length <= L; e++) {
        if (!dm[e]) continue;
        const w = cap(orig(e) + modified(e));
        if (w) next[2 * (e + Dk.length)] = cap(next[2 * (e + Dk.length)] + w);
      }
    } else {
      for (let e = 1; e < L; e++) {
        const wo = orig(e);
        const wm = modified(e);
        if (wo) next[2 * e] = cap(next[2 * e] + wo);
        if (wm) next[2 * e + 1] = cap(next[2 * e + 1] + wm);
      }
    }
  }
  if (total === 0) return unmappable();
  if (total >= 2) return { kind: 'ambiguous', offset: firstDivergence(E, display) };

  // 唯一解：从文末沿前驱回溯各 c_k 的 [start, end)
  const starts = new Array(n);
  const ends = new Array(n);
  let end = lastEnd;
  let mustBeOriginalEnd = null; // null：终点任意；true：c_k 须原样结束；false：c_k 须改过
  for (let k = n - 1; k >= 0; k--) {
    const Fk = F[k];
    const o = contents[k];
    let found = null;
    for (let p = 0; p < end && found === null; p++) {
      const isOrig = end - p === o.length && origAt[k][p] === 1;
      if (mustBeOriginalEnd === true && !isOrig) continue;
      if (mustBeOriginalEnd === false && isOrig) continue;
      if (Fk[2 * p]) found = { p, f: 0 };
      else if (isOrig && Fk[2 * p + 1]) found = { p, f: 1 };
    }
    starts[k] = found.p;
    ends[k] = end;
    if (k === 0) break;
    const Dprev = D[k];
    if (Dprev !== '') {
      end = found.p - Dprev.length;
      mustBeOriginalEnd = null;
    } else {
      end = found.p;
      // c_k 必须原样（f=1）⇔ c_{k-1} 改过；c_k 自由 ⇔ c_{k-1} 原样
      mustBeOriginalEnd = found.f === 0;
    }
  }
  let ci = 0;
  const spans = layout.spans.map((s) => {
    if (!isContent(s)) return { canonical: s.canonical, display: s.display };
    const t = E.slice(starts[ci], ends[ci]);
    ci++;
    return { text: t };
  });
  return { kind: 'unique', layout: { v: 1, spans } };
}
