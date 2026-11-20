/**
 * 显示排版四组共享向量的生成（ADR 0059 修订 4 §4、D7、D9）：vectors/layout.json、display-reconstruct.json、
 * display-padding.json、keyword-spellings.json。每条用例的期望（expect / canonical / padded）在这里**手写**，
 * 由 test-package-v1.mjs 用参照实现 display.mjs 复算，再由 core 与 ts 各自的副本测试复算——期望不由参照实现产出，
 * 否则测试就成了同义反复。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** keyword-spellings.json 的内容：各 locale 的字面量关键词与运算符拼写（已 foldKey、按码点排序去重）。 */
export const KEYWORD_SPELLINGS = JSON.parse(readFileSync(join(HERE, 'keyword-spellings.source.json'), 'utf8'));

/** 《静夜思》（与 aster-cloud src/config/jingyesi-poem.ts、aster-api JingyesiPolicy 逐字相同）。 */
export const JINGYESI_SOURCE = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。\n';
export const JINGYESI_POEM = '床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。';
const SP = { canonical: ' ', display: '' };
export const JINGYESI_LAYOUT = {
  v: 1,
  spans: [
    { text: '床前' }, SP, { text: '明月光' }, { canonical: '。\n', display: '，\n' },
    { text: '疑是' }, SP, { text: '地上霜' }, { canonical: '，', display: '。\n' },
    { text: '举头' }, SP, { text: '望明月' }, { canonical: '：\n  ', display: '，\n' },
    { text: '低头' }, SP, { text: '思故乡' }, { canonical: '。\n', display: '。' },
  ],
};
/** cloud PolicyVersionLayout 存储的序列化文本（手写，不由 serializeLayout 产出）。 */
export const JINGYESI_LAYOUT_TEXT = '{"v":1,"spans":[{"text":"床前"},{"canonical":" ","display":""},{"text":"明月光"},{"canonical":"。\\n","display":"，\\n"},{"text":"疑是"},{"canonical":" ","display":""},{"text":"地上霜"},{"canonical":"，","display":"。\\n"},{"text":"举头"},{"canonical":" ","display":""},{"text":"望明月"},{"canonical":"：\\n  ","display":"，\\n"},{"text":"低头"},{"canonical":" ","display":""},{"text":"思故乡"},{"canonical":"。\\n","display":"。"}]}';
/** 《静夜思》的 aliasSet 与词汇（ADR 0060 §8）。 */
export const JINGYESI_ALIAS_SET = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
export const JINGYESI_VOCAB_LOCALIZED = ['望明月', '思故乡'];

const ser = (layout) => {
  // 向量里的 layoutText 用 JSON.stringify 逐字拼出规范形态（参照实现的 serializeLayout 另由测试比对）
  const one = (s) => ('text' in s ? `{"text":${JSON.stringify(s.text)}}` : `{"canonical":${JSON.stringify(s.canonical)},"display":${JSON.stringify(s.display)}}`);
  return `{"v":1,"spans":[${layout.spans.map(one).join(',')}]}`;
};
const canon = (layout) => layout.spans.map((s) => ('text' in s ? s.text : s.canonical)).join('');
const C = (text) => ({ text });
const S = (canonical, display) => ({ canonical, display });

const EN = KEYWORD_SPELLINGS.locales['en-US'];
const ZH = KEYWORD_SPELLINGS.locales['zh-CN'];
const zhLiterals = [...ZH.literal, ...EN.literal];
const zhOperators = [...ZH.operator, ...EN.operator];
const enCtx = { vocabularyLocalized: [], literalKeywords: EN.literal, operatorSpellings: EN.operator };

/** 一条 layout.json 用例：layout 给对象时 layoutText 按规范形态拼出；source 缺省为 toCanonical。 */
function lv(id, layout, expect, extra = {}) {
  const layoutText = typeof layout === 'string' ? layout : ser(layout);
  const source = extra.source ?? (typeof layout === 'string' ? undefined : canon(layout));
  const row = { id, layoutText, source, ...enCtx, ...extra, expect };
  if (row.source === undefined) throw new Error(`${id}: 需要 source`);
  return row;
}

const MINUS_SRC = 'Module demo.\n\nRule f given x as Int, produce Int:\n  Return x - 1.\n';
const minusLayout = (canonical, display) => ({
  v: 1,
  spans: [C('Module demo.\n\nRule f given x as Int, produce Int:\n  Return x'), S(canonical, display), C('1.\n')],
});
const plusLayout = (canonical, display) => ({ v: 1, spans: [C('Return a'), S(canonical, display), C('b.')] });

function layoutCases() {
  const cases = [];
  const poemCtx = { vocabularyLocalized: JINGYESI_VOCAB_LOCALIZED, literalKeywords: zhLiterals, operatorSpellings: [...zhOperators] };
  // L1：规范形态与转义
  cases.push(lv('jingyesi-ok', JINGYESI_LAYOUT_TEXT, 'ok', { source: JINGYESI_SOURCE, displayText: JINGYESI_POEM, serialized: JINGYESI_LAYOUT_TEXT, ...poemCtx }));
  const escapes = { v: 1, spans: [C('a"\\/\u0007\u001f\t\u2028\u2029\u007f\u{1F600}é'), S(' ', '\u0000\n'), C('b')] };
  const escapesText = '{"v":1,"spans":[{"text":"a\\"\\\\/\\u0007\\u001f\\t\u2028\u2029\u007f\u{1F600}é"},{"canonical":" ","display":"\\u0000\\n"},{"text":"b"}]}';
  cases.push(lv('escapes-ok', escapesText, 'ok', { source: canon(escapes), serialized: escapesText }));
  cases.push(lv('escape-solidus-not-canonical', escapesText.replace('/', '\\/'), 'L1', { source: canon(escapes) }));
  cases.push(lv('escape-unicode-not-canonical', escapesText.replace('é', '\\u00e9'), 'L1', { source: canon(escapes) }));
  cases.push(lv('escape-uppercase-hex-not-canonical', escapesText.replace('\\u001f', '\\u001F'), 'L1', { source: canon(escapes) }));
  cases.push(lv('unmerged-adjacent-content', '{"v":1,"spans":[{"text":"Return "},{"text":"x."}]}', 'L1', { source: 'Return x.' }));
  cases.push(lv('key-order', '{"spans":[{"text":"Return x."}],"v":1}', 'L1', { source: 'Return x.' }));
  cases.push(lv('structural-key-order', '{"v":1,"spans":[{"text":"a"},{"display":"","canonical":" "},{"text":"b"}]}', 'L1', { source: 'a b' }));
  cases.push(lv('duplicate-key', '{"v":1,"v":1,"spans":[{"text":"Return x."}]}', 'L1', { source: 'Return x.' }));
  cases.push(lv('whitespace', '{"v":1, "spans":[{"text":"Return x."}]}', 'L1', { source: 'Return x.' }));
  cases.push(lv('trailing-newline', '{"v":1,"spans":[{"text":"Return x."}]}\n', 'L1', { source: 'Return x.' }));
  cases.push(lv('bom', '\uFEFF{"v":1,"spans":[{"text":"Return x."}]}', 'L1', { source: 'Return x.' }));
  cases.push(lv('version-2', '{"v":2,"spans":[{"text":"Return x."}]}', 'L1', { source: 'Return x.' }));
  cases.push(lv('version-mismatch-manifest', '{"v":1,"spans":[{"text":"Return x."}]}', 'L1', { source: 'Return x.', layoutVersion: 2 }));
  cases.push(lv('empty-spans', '{"v":1,"spans":[]}', 'L1', { source: '' }));
  cases.push(lv('empty-text', '{"v":1,"spans":[{"text":""}]}', 'L1', { source: '' }));
  cases.push(lv('empty-structural-canonical', '{"v":1,"spans":[{"text":"a"},{"canonical":"","display":"x"}]}', 'L1', { source: 'a' }));
  cases.push(lv('extra-span-key', '{"v":1,"spans":[{"text":"a","x":1}]}', 'L1', { source: 'a' }));
  cases.push(lv('lone-surrogate', '{"v":1,"spans":[{"text":"\\ud83d"},{"canonical":" ","display":""},{"text":"\\ude00"}]}', 'L1', { source: 'x' }));
  cases.push(lv('not-json', '{"v":1,"spans":[{"text":"a"}]', 'L1', { source: 'a' }));
  // L2：每项上限各差 1 的超出与恰在上限
  const aN = (n) => 'a'.repeat(n);
  cases.push(lv('limit-source-bytes-at', { v: 1, spans: [C(aN(12288))] }, 'ok'));
  cases.push(lv('limit-source-bytes-over', { v: 1, spans: [C(aN(12289))] }, 'L2'));
  cases.push(lv('limit-source-lines-at', { v: 1, spans: [C('a\n'.repeat(200))] }, 'ok'));
  cases.push(lv('limit-source-lines-over', { v: 1, spans: [C('a\n'.repeat(201))] }, 'L2'));
  const spansOf = (n) => ({ v: 1, spans: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? C('a') : S(' ', ''))) });
  cases.push(lv('limit-spans-at', spansOf(400), 'ok'));
  cases.push(lv('limit-spans-over', spansOf(401), 'L2'));
  // 序列化字节：k 个 U+0001（每个转义为 6 字节）+ r 个 a；框架 29 字节
  const ctl = (k, r) => ({ v: 1, spans: [C('\u0001'.repeat(k) + aN(r))] });
  cases.push(lv('limit-serialized-bytes-at', ctl(8187, 1), 'ok'));
  cases.push(lv('limit-serialized-bytes-over', ctl(8187, 2), 'L2'));
  // display 字节：每个结构 span 的 display 至多 256 码点，用 4 字节字符堆到上限
  const emoji = (n) => '\u{1F600}'.repeat(n);
  const displayAt = { v: 1, spans: [C('a'), ...Array.from({ length: 23 }, () => S(' ', emoji(256))), S(' ', `${emoji(255)}€`)] };
  const displayOver = { v: 1, spans: [C('a'), ...Array.from({ length: 24 }, () => S(' ', emoji(256)))] };
  cases.push(lv('limit-display-bytes-at', displayAt, 'ok'));
  cases.push(lv('limit-display-bytes-over', displayOver, 'L2'));
  cases.push(lv('limit-structural-display-chars-at', { v: 1, spans: [C('a'), S(' ', '·'.repeat(256))] }, 'ok'));
  cases.push(lv('limit-structural-display-chars-over', { v: 1, spans: [C('a'), S(' ', '·'.repeat(257))] }, 'L2'));
  cases.push(lv('limit-structural-display-chars-astral-at', { v: 1, spans: [C('a'), S(' ', emoji(256))] }, 'ok'));
  // L3 / L4
  cases.push(lv('roundtrip-one-char', JINGYESI_LAYOUT_TEXT, 'L3', { source: JINGYESI_SOURCE.replace('明月光', '明月照'), displayText: JINGYESI_POEM, ...poemCtx }));
  cases.push(lv('roundtrip-bom-not-stripped', JINGYESI_LAYOUT_TEXT, 'L3', { source: `\uFEFF${JINGYESI_SOURCE}`, displayText: JINGYESI_POEM, ...poemCtx }));
  cases.push(lv('display-extra-newline', JINGYESI_LAYOUT_TEXT, 'L4', { source: JINGYESI_SOURCE, displayText: `${JINGYESI_POEM}\n`, ...poemCtx }));
  cases.push(lv('display-one-char', JINGYESI_LAYOUT_TEXT, 'L4', { source: JINGYESI_SOURCE, displayText: JINGYESI_POEM.replace('举头', '抬头'), ...poemCtx }));
  // L5
  cases.push(lv('structural-quote-corner', { v: 1, spans: [C('Return '), S('「', ''), C('a」.')] }, 'L5'));
  cases.push(lv('structural-quote-ascii', { v: 1, spans: [C('Return '), S('"', '“'), C('a".')] }, 'L5'));
  cases.push(lv('content-only-whitespace', { v: 1, spans: [C(' \u3000\uFEFF'), S('x', 'x')] }, 'L5'));
  cases.push(lv('content-nbsp-only', { v: 1, spans: [C('\u00a0\u2028'), S('y', '')] }, 'L5'));
  // L6
  cases.push(lv('structural-digit', { v: 1, spans: [C('Return '), S('42', ''), C('.')] }, 'L6'));
  cases.push(lv('structural-fullwidth-digit', { v: 1, spans: [C('Return '), S('４', ''), C('.')] }, 'L6'));
  cases.push(lv('structural-vocabulary-literal-trigger', { v: 1, spans: [C('床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头'), S(' 思故乡', ''), C('。\n')] }, 'L6', poemCtx));
  cases.push(lv('structural-vocabulary-not-whole-word', { v: 1, spans: [C('床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 '), S('我思故乡', ''), C('。\n')] }, 'ok', poemCtx));
  cases.push(lv('structural-literal-true', { v: 1, spans: [C('Return x is'), S(' true ', ' '), C('ok.')] }, 'L6'));
  cases.push(lv('structural-literal-case-folded', { v: 1, spans: [C('Return x is'), S(' TRUE ', ' '), C('ok.')] }, 'L6'));
  cases.push(lv('structural-literal-not-whole-word', { v: 1, spans: [C('Return x is'), S(' trueish ', ' '), C('ok.')] }, 'ok'));
  cases.push(lv('structural-literal-combining-mark-boundary', { v: 1, spans: [C('Return x is'), S(' true\u0332 ', ' '), C('ok.')] }, 'ok'));
  cases.push(lv('structural-literal-fullwidth-letter-boundary', { v: 1, spans: [C('Return x is'), S(' ａtrue ', ' '), C('ok.')] }, 'ok'));
  cases.push(lv('structural-literal-astral-letter-boundary', { v: 1, spans: [C('Return x is'), S(' \u{1D400}true ', ' '), C('ok.')] }, 'ok'));
  cases.push(lv('structural-literal-underscore-boundary', { v: 1, spans: [C('Return x is'), S(' _true ', ' '), C('ok.')] }, 'ok'));
  cases.push(lv('structural-literal-punctuation-boundary', { v: 1, spans: [C('Return x is'), S(' (true) ', ' '), C('ok.')] }, 'L6'));
  cases.push(lv('structural-zh-literal-in-zh', { v: 1, spans: [C('返回'), S(' 真值 ', ' '), C('。')] }, 'L6', poemCtx));
  cases.push(lv('structural-en-literal-in-zh', { v: 1, spans: [C('返回'), S(' none ', ' '), C('。')] }, 'L6', poemCtx));
  // L7
  cases.push(lv('operator-hidden-minus', minusLayout('-', '已获批准'), 'L7'));
  cases.push(lv('operator-spaces-around-minus-hidden', minusLayout(' - ', ' '), 'L7', { source: MINUS_SRC }));
  cases.push(lv('operator-kept-minus', minusLayout(' - ', ' − (-) '), 'ok', { source: MINUS_SRC }));
  cases.push(lv('operator-word-rewritten', plusLayout(' plus ', ' and '), 'L7'));
  cases.push(lv('operator-symbol-to-word', plusLayout(' + ', ' plus '), 'L7'));
  cases.push(lv('operator-fullwidth-plus-with-ascii-kept', plusLayout(' + ', ' ＋ (+) '), 'ok'));
  cases.push(lv('operator-extra', plusLayout('+', '++'), 'L7'));
  cases.push(lv('operator-order-swapped', plusLayout('+ -', '- +'), 'L7'));
  cases.push(lv('operator-word-split-not-whole-word', plusLayout(' plus ', ' plusx '), 'L7'));
  cases.push(lv('operator-word-case-folded-same', plusLayout(' plus ', ' PLUS '), 'ok'));
  cases.push(lv('operator-longest-match-first', plusLayout(' at least ', ' at  least '), 'L7'));
  cases.push(lv('operator-multiword-kept', plusLayout(' at least ', ' (at least) '), 'ok'));
  cases.push(lv('operator-zh-alias-hidden', { v: 1, spans: [C('返回 甲'), S(' 接 着 ', ''), C('乙。')] }, 'L7', { ...poemCtx, operatorSpellings: [...zhOperators, '接 着'] }));
  cases.push(lv('operator-zh-keyword-hidden', { v: 1, spans: [C('返回 甲'), S(' 加上 ', ''), C('乙。')] }, 'L7', poemCtx));
  cases.push(lv('operator-zh-keyword-kept', { v: 1, spans: [C('返回 甲'), S(' 加上 ', '加上'), C('乙。')] }, 'ok', poemCtx));
  cases.push(lv('operator-not-in-structural-ok', { v: 1, spans: [C('Return a + b'), S('.', '。')] }, 'ok'));
  cases.push(lv('operator-in-display-only', { v: 1, spans: [C('Return a'), S(' ', ' = '), C('b.')] }, 'L7'));
  return cases;
}

const poemEdit = (from, to) => {
  if (!JINGYESI_POEM.includes(from)) throw new Error(`poem has no ${from}`);
  return JINGYESI_POEM.replace(from, to);
};
const poemCanon = (from, to) => JINGYESI_SOURCE.replace(from, to);

/** 反向映射（D7）向量：期望手写。 */
function reconstructCases() {
  const P = JINGYESI_LAYOUT;
  const cases = [
    { id: 'jingyesi-unchanged', layout: P, edited: JINGYESI_POEM, expect: 'unique', canonical: JINGYESI_SOURCE },
    { id: 'jingyesi-last-line-literal', layout: P, edited: poemEdit('低头思故乡。', '低头「月光」。'), expect: 'unique', canonical: poemCanon('低头 思故乡。', '低头 「月光」。') },
    { id: 'jingyesi-first-line-edit', layout: P, edited: poemEdit('床前明月光', '床前明月照'), expect: 'unique', canonical: poemCanon('床前 明月光', '床前 明月照') },
    { id: 'jingyesi-entry-renamed', layout: P, edited: poemEdit('疑是地上霜', '疑是天上霜'), expect: 'unique', canonical: poemCanon('疑是 地上霜', '疑是 天上霜') },
    { id: 'jingyesi-both-sides', layout: P, edited: poemEdit('床前明月光', '床后明月照'), expect: 'unmappable' },
    { id: 'jingyesi-repeat-prefix', layout: P, edited: poemEdit('床前明月光', '床前床前明月光'), expect: 'ambiguous' },
    { id: 'jingyesi-punct-changed', layout: P, edited: poemEdit('明月光，', '明月光、'), expect: 'unmappable' },
    { id: 'jingyesi-punct-deleted', layout: P, edited: poemEdit('地上霜。', '地上霜'), expect: 'unmappable' },
    { id: 'jingyesi-trailing-newline', layout: P, edited: `${JINGYESI_POEM}\n`, expect: 'unique', canonical: JINGYESI_SOURCE },
    { id: 'jingyesi-trailing-crlf', layout: P, edited: `${JINGYESI_POEM}\r\n`, expect: 'unique', canonical: JINGYESI_SOURCE },
    { id: 'jingyesi-two-trailing-newlines', layout: P, edited: `${JINGYESI_POEM}\n\n`, expect: 'unmappable' },
    { id: 'jingyesi-crlf', layout: P, edited: JINGYESI_POEM.replaceAll('\n', '\r\n'), expect: 'unmappable' },
    { id: 'jingyesi-content-emptied', layout: P, edited: poemEdit('床前明月光', '床前'), expect: 'unmappable' },
    { id: 'hidden-run-at-start', layout: { v: 1, spans: [S(' ', ''), C('abc'), S('.', '。')] }, edited: 'xyz。', expect: 'unique', canonical: ' xyz.' },
    { id: 'hidden-run-at-end', layout: { v: 1, spans: [C('abc'), S('\n', '')] }, edited: 'zzz', expect: 'unique', canonical: 'zzz\n' },
    { id: 'hidden-run-at-end-editor-newline', layout: { v: 1, spans: [C('abc'), S('\n', '')] }, edited: 'zzz\n', expect: 'unique', canonical: 'zzz\n' },
    { id: 'unchanged-content-counted-once', layout: { v: 1, spans: [C('ab'), S(' ', ''), C('cd')] }, edited: 'abcd', expect: 'unique', canonical: 'ab cd' },
    { id: 'hidden-between-two-edits', layout: { v: 1, spans: [C('ab'), S(' ', ''), C('cd')] }, edited: 'xycd', expect: 'unique', canonical: 'xy cd' },
    { id: 'hidden-both-edited', layout: { v: 1, spans: [C('ab'), S(' ', ''), C('cd')] }, edited: 'xyzw', expect: 'unmappable' },
    { id: 'structural-only-prefix-mismatch', layout: { v: 1, spans: [S('# ', '§ '), C('x')] }, edited: 'x', expect: 'unmappable' },
    { id: 'structural-only-suffix-mismatch', layout: { v: 1, spans: [C('x'), S('.', '。')] }, edited: 'x.', expect: 'unmappable' },
    { id: 'two-adjacent-hidden', layout: { v: 1, spans: [C('ab'), S(' ', ''), S('\t', ''), C('cd')] }, edited: 'abXY', expect: 'unique', canonical: 'ab \tXY' },
    { id: 'hidden-next-to-visible-anchor', layout: { v: 1, spans: [C('ab'), S(' ', ''), S(',', '，'), C('cd')] }, edited: 'XY，ZW', expect: 'unique', canonical: 'XY ,ZW' },
    { id: 'visible-anchor-repeated', layout: { v: 1, spans: [C('a'), S(',', '，'), C('b')] }, edited: 'x，y，z', expect: 'ambiguous' },
    { id: 'adjacent-visible-anchors', layout: { v: 1, spans: [C('a'), S(',', '，'), S(';', '。'), C('b')] }, edited: 'q，。r', expect: 'unique', canonical: 'q,;r' },
    { id: 'content-may-contain-anchor-text', layout: { v: 1, spans: [C('a'), S(',', '，'), C('b'), S('.', '。')] }, edited: 'x，y。z。', expect: 'unique', canonical: 'x,y。z.' },
    { id: 'single-content-whole-text', layout: { v: 1, spans: [C('Return x.')] }, edited: 'Return y.', expect: 'unique', canonical: 'Return y.' },
    { id: 'single-content-emptied', layout: { v: 1, spans: [C('Return x.')] }, edited: '', expect: 'unmappable' },
    { id: 'oversize', layout: { v: 1, spans: [C('a')] }, edited: 'a'.repeat(24577), expect: 'unmappable' },
    { id: 'at-size-limit', layout: { v: 1, spans: [C('a')] }, edited: 'b'.repeat(24576), expect: 'unique', canonical: 'b'.repeat(24576) },
    { id: 'oversize-before-trailing-newline-strip', layout: { v: 1, spans: [C('a')] }, edited: `${'b'.repeat(24576)}\n`, expect: 'unmappable' },
  ];
  return cases.map((c) => ({ ...c, layoutText: ser(c.layout) })).map(({ layout, ...rest }) => ({ id: rest.id, layoutText: rest.layoutText, edited: rest.edited, expect: rest.expect, ...(rest.canonical !== undefined ? { canonical: rest.canonical } : {}) }));
}

/**
 * 性能用例：只给配方（规模大，不展开成文本），三处实现按同一配方构造后须在 2 s 内给出结论（T1 Step 2）。
 *   layout = units 次重复 unit（unit 为 span 列表），edited = editUnit 重复 editRepeat 次再接 editTail。
 */
function performanceCases() {
  return [
    {
      id: 'perf-same-anchor-everywhere',
      description: '400 span、全部可见锚点都是「，」，E 由「，」重复构成（大量候选，结论 ambiguous）',
      unit: [{ text: 'x' }, { canonical: ',', display: '，' }], units: 200, editUnit: '，', editRepeat: 8192, editTail: '', expect: 'ambiguous',
    },
    {
      id: 'perf-hidden-everywhere-no-original',
      description: '400 span、内容与隐藏 span 交替、E 中没有任何一个原文（结论 unmappable，必须跑完整个状态表）',
      unit: [{ text: 'a' }, { canonical: ' ', display: '' }], units: 200, editUnit: 'b', editRepeat: 24576, editTail: '', expect: 'unmappable',
    },
    {
      id: 'perf-hidden-and-visible-alternating',
      description: '隐藏串与可见锚点交替（c H c V），每段 E 为 a + 240 个 b + 「，」，24 400 字节，唯一解',
      unit: [{ text: 'a' }, { canonical: ' ', display: '' }, { text: 'c' }, { canonical: ',', display: '，' }], units: 100, editUnit: `a${'b'.repeat(240)}，`, editRepeat: 100, editTail: '', expect: 'unique',
      canonicalUnit: `a ${'b'.repeat(240)},`,
    },
  ];
}

/** 补空格（L9 的 P）向量：padded 手写。 */
function paddingCases() {
  const rows = [
    { id: 'jingyesi', layout: JINGYESI_LAYOUT, padded: '床前   明月光 。\n疑是   地上霜 ， 举头   望明月 ：\n  低头   思故乡 。\n' },
    { id: 'no-structural-spans', layout: { v: 1, spans: [C('Return x.')] }, padded: 'Return x.' },
    { id: 'structural-at-start-and-end', layout: { v: 1, spans: [S('# ', ''), C('x'), S('.', '')] }, padded: '#  x .' },
    { id: 'indentation-not-padded', layout: { v: 1, spans: [C('A'), S(':\n  ', '：'), C('B')] }, padded: 'A :\n  B' },
    { id: 'tab-indentation-not-padded', layout: { v: 1, spans: [C('A:\n\t'), S('x', 'y'), C('B')] }, padded: 'A:\n\tx B' },
    { id: 'after-newline-not-padded', layout: { v: 1, spans: [C('A'), S('\n', ' '), C('B')] }, padded: 'A \nB' },
    { id: 'after-cr-not-padded', layout: { v: 1, spans: [C('A'), S('\r', ' '), C('B')] }, padded: 'A \rB' },
    { id: 'adjacent-structural-boundary-once', layout: { v: 1, spans: [C('a'), S('+', '+'), S('-', '-'), C('b')] }, padded: 'a + - b' },
    { id: 'string-swallowed', layout: { v: 1, spans: [C('Return "x'), S(' ', '·'), C('y".')] }, padded: 'Return "x   y".' },
    { id: 'indent-then-text-padded', layout: { v: 1, spans: [C('A\n  b'), S(' ', ''), C('c')] }, padded: 'A\n  b   c' },
  ];
  return rows.map((r) => ({ id: r.id, layoutText: ser(r.layout), padded: r.padded }));
}

/** 四个向量文件的内容（generate() 写盘）。 */
export function displayVectors() {
  return {
    'vectors/layout.json': {
      description: '显示排版 L1–L7 向量（ADR 0059 修订 4 §4）：layoutText 为 policy/display/layout.json 的 UTF-8 文本，source 为 policy/policy.aster 的文本，displayText 缺省为 toDisplay(layout)，layoutVersion 缺省为 1；expect 为 ok 或第一条失败的规则号。serialized 给出时 serializeLayout 的结果必须逐字等于它。vocabularyLocalized / literalKeywords / operatorSpellings 是 checkPackageLayout 的同名参数（拼写取自 keyword-spellings.json 并入 aliasSet 别名）。',
      version: 1,
      cases: layoutCases(),
    },
    'vectors/display-reconstruct.json': {
      description: '反向映射向量（ADR 0059 修订 4 D7）：edited 为已严格 UTF-8 解码、已去 BOM 的编辑后显示文本（文末换行规则由 reconstruct 处理）；expect 为 unique / unmappable / ambiguous，unique 时 canonical 为 toCanonical(L′)。performance 为配方：layout = unit 重复 units 次，edited = editUnit 重复 editRepeat 次接 editTail，各须在 2 s 内给出结论；canonicalUnit 给出时 toCanonical(L′) = canonicalUnit 重复 units 次。',
      version: 1,
      cases: reconstructCases(),
      performance: performanceCases(),
    },
    'vectors/display-padding.json': {
      description: 'L9 补空格向量（ADR 0059 修订 4 §4）：padded 为 padStructuralSpans(layout) 的结果 P。',
      version: 1,
      cases: paddingCases(),
    },
    'vectors/keyword-spellings.json': KEYWORD_SPELLINGS,
  };
}
