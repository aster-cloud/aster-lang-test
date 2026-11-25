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
  if (row.sourceB64 !== undefined) delete row.source;
  else if (row.source === undefined) throw new Error(`${id}: 需要 source`);
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
  // 非法 UTF-8 的 policy.aster：L2 在字节上数（与解码无关），超限为 L2、否则 L3
  const badSource = (n) => Buffer.concat([Buffer.alloc(n - 1, 0x61), Buffer.from([0xff])]).toString('base64');
  cases.push(lv('invalid-utf8-source-over-limit', { v: 1, spans: [C('a')] }, 'L2', { source: undefined, sourceB64: badSource(12289) }));
  cases.push(lv('invalid-utf8-source-within-limit', { v: 1, spans: [C('a')] }, 'L3', { source: undefined, sourceB64: badSource(12288) }));
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
      id: 'perf-same-anchor-one-missing',
      description: '400 span、可见锚点都是「，」且其后各有一个内容；E 中只有 199 个「，」（各接 120 个 y），差一个锚点（结论 unmappable，状态表须跑完）',
      unit: [{ canonical: ',', display: '，' }, { text: 'x' }], units: 200, editUnit: `，${'y'.repeat(120)}`, editRepeat: 199, editTail: '', expect: 'unmappable',
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


// ---------------------------------------------------------------------------
// L10 隐藏转义符（ADR 0059 修订 5 §6）
// ---------------------------------------------------------------------------

/** 合并相邻内容 span、去掉空内容（规范形态）。 */
const mergeSpans = (spans) => spans.reduce((out, s) => {
  if ('text' in s && s.text === '') return out;
  const last = out[out.length - 1];
  if ('text' in s && last && 'text' in last) out[out.length - 1] = C(last.text + s.text);
  else out.push(s);
  return out;
}, []);

/**
 * 把 canonical 里第 n 次出现的 `name` 做成转义三元组（hidden: [[name, n]]），structural: [[text, n, display]] 做成结构 span。
 */
function hide(canonical, hidden, structural = []) {
  const nth = (text, n) => {
    let at = -1;
    for (let k = 0; k <= n; k++) at = canonical.indexOf(text, at + 1);
    if (at < 0) throw new Error(`hide: 找不到第 ${n} 个 ${text}`);
    return at;
  };
  const marks = [
    ...hidden.map(([name, n]) => ({ at: nth(`\`${name}\``, n), len: name.length + 2, esc: name })),
    ...structural.map(([text, n, display]) => ({ at: nth(text, n), len: text.length, display })),
  ].sort((a, b) => a.at - b.at);
  const spans = [];
  let pos = 0;
  for (const m of marks) {
    spans.push(C(canonical.slice(pos, m.at)));
    if (m.esc !== undefined) spans.push(S('`', ''), C(m.esc), S('`', ''));
    else spans.push(S(canonical.slice(m.at, m.at + m.len), m.display));
    pos = m.at + m.len;
  }
  spans.push(C(canonical.slice(pos)));
  return { v: 1, spans: mergeSpans(spans) };
}

const ZHM = '模块 探针.样例。\n\n';
const ENM = 'Module probe.sample.\n\n';
const SRC = {
  E1: `${ZHM}规则 取值 给定 \`如果\` 作为 整数，产出 整数：\n  返回 \`如果\`。\n`,
  E2: `${ZHM}定义 软件 包含 \`版本\` 作为 整数。\n`,
  E3: `${ENM}Rule f given \`count\` as Int, produce Int:\n  Return \`count\`.\n`,
  E4: `${ENM}Rule f given x as Int, produce Int:\n  Let \`none\` be x.\n  Return \`none\`.\n`,
  E5: `${ZHM}规则 甲，产出 文本：\n  令 \`思故乡\` 定义为 「床前」。\n  返回 \`思故乡\`。\n`,
  E6: `${ZHM}规则 取值，产出 文本：\n  返回 "a\`b\`c"。\n`,
  E8: `${ENM}Rule f given x as Int, produce Int:\n  Return \`a\`x\`b\`.\n`,
  E9: `${ENM}Rule g given x as Int, produce Int:\n  Return x.\n\nRule f given x as Int, produce Int:\n  \`g\`(x).\n  Return x.\n`,
  E10: `${ENM}# 床前\`当\`明月光\nRule f given x as Int, produce Int:\n  Return x.\n`,
  E11: `${ENM}Rule f given \`x\` as Int, produce Int:\n  Return \`x\`.\n`,
  E14: `${ZHM}规则 取值 给定 x 作为 整数，产出 整数：\n  如果 x 大于 1：\n    返回 1。\n  返回 2。\n`,
  E16: `${ENM}Rule f given \`a\` as Int, \`b\` as Int, \`c\` as Int, \`d\` as Int, \`e\` as Int, produce Int:\n  Return a.\n`,
  E17: `${ZHM}规则 取值 给定 \`低头\` 作为 整数，产出 整数：\n  低头 \`低头\`。\n`,
  E18: `${ZHM}定义 软件 包含 \`版本\` 作为 整数。\n\n规则 取值 给定 s 作为 软件，产出 整数：\n  返回 s.\`版本\`。\n`,
  E19: `${ZHM}定义 明月光 包含 长度 作为 整数。\n\n规则 床前 给定 \`当\` 作为 明月光，产出 整数：\n  返回 \`当\`.长度。\n`,
};
const POEM_VOCAB = {
  id: 'probe.poem', name: '静夜思', locale: 'zh-CN', version: '1.0.0', structs: [], fields: [], functions: [], enumValues: [],
  literals: [{ canonical: '静夜思', localized: '思故乡', kind: 'literal' }],
};
const E19_LAYOUT = hide(SRC.E19, [['当', 0]], [['规则 ', 0, ''], [' 给定 ', 0, ''], [' 作为 ', 1, '']]);

/** 与 SRC 逐个对应的排版；E11–E16 是手工改坏的形状。 */
function escapeLayouts() {
  const e11 = hide(SRC.E11, [['x', 0], ['x', 1]]);
  e11.spans[0] = C(e11.spans[0].text.slice(0, -1));
  e11.spans[1] = S(' `', '');
  const e13 = hide(SRC.E11, [['x', 0]]);
  e13.spans[1] = S('`', '`');
  const e13b = hide(SRC.E11, [['x', 0]]);
  e13b.spans[1] = S('`', '「');
  const strHead = `${ENM}Rule f given x as Int, produce Text:\n  Return "`;
  return {
    E1: hide(SRC.E1, [['如果', 0], ['如果', 1]]),
    E2: hide(SRC.E2, [['版本', 0]]),
    E3: hide(SRC.E3, [['count', 0], ['count', 1]]),
    E4: hide(SRC.E4, [['none', 1]]),
    E5: hide(SRC.E5, [['思故乡', 0], ['思故乡', 1]]),
    E6: hide(SRC.E6, [['b', 0]]),
    E8: { v: 1, spans: [C(`${ENM}Rule f given x as Int, produce Int:\n  Return \`a`), S('`', ''), C('x'), S('`', ''), C('b`.\n')] },
    E9: hide(SRC.E9, [['g', 0]]),
    E10: hide(SRC.E10, [['当', 0]]),
    E11: e11,
    E12: { v: 1, spans: [C(`${ENM}Rule f given `), S('`', ''), C('x` as Int, produce Int:\n  Return x.\n')] },
    E13: e13,
    E13b: e13b,
    E14: hide(SRC.E14, [], [['如果', 0, '`如果`']]),
    E15: { v: 1, spans: [C(strHead), S('`', ''), C('a.b'), S('`', ''), C('".\n')] },
    E15b: { v: 1, spans: [C(strHead), S('`', ''), C('当 前'), S('`', ''), C('".\n')] },
    E16: hide(SRC.E16, [['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 0]]),
    E17: hide(SRC.E17, [['低头', 0], ['低头', 1]]),
    E18: hide(SRC.E18, [['版本', 1]]),
    E19: E19_LAYOUT,
    E20a: hide(SRC.E1, [['如果', 0], ['如果', 1]], [['返回', 0, '还给']]),
    E20b: hide(SRC.E18, [['版本', 0], ['版本', 1]], [['返回', 0, '还给']]),
  };
}

/** display-escape.json 的用例：expect 手写（L10a 不编译；L9、L10b 由 core / ts 用各自编译器判定）。 */
function escapeCases() {
  const L = escapeLayouts();
  const firstGone = (src, name) => src.replace(`\`${name}\``, name);
  const lastGone = (src, name) => {
    const at = src.lastIndexOf(`\`${name}\``);
    return src.slice(0, at) + name + src.slice(at + name.length + 2);
  };
  const rows = [
    ['E1', 'zh 形参 `如果`（结构关键词）在声明与使用两处，两组都隐藏：每个子集去掉反引号后 如果 出现在名字位置报 E901，编译失败', 'zh-CN', 'ok',
      { triples: ['如果', '如果'], stripped: [firstGone(SRC.E1, '如果'), lastGone(SRC.E1, '如果'), SRC.E1.replaceAll('`', '')] }],
    ['E2', 'zh 字段 `版本` 隐藏：C⁻ 编译成字段 version，IR 不同', 'zh-CN', 'L10b', { triples: ['版本'] }],
    ['E3', 'en 冗余转义 `count` 两处都隐藏：每个子集的 C⁻ 都是同一 IR', 'en-US', 'ok', { triples: ['count', 'count'] }],
    ['E4', 'en 局部变量 `none` 的使用处隐藏：C⁻ 返回空值字面量，能编译且 IR 不同', 'en-US', 'L10b', { triples: ['none'] }],
    ['E5', '词汇字面量 思故乡 → "静夜思"；`思故乡` 作局部变量，定义处与使用处都隐藏：子集 {使用处} 的 C⁻ 返回 "静夜思"（能编译、IR 不同），子集 {两处} 编译失败——必须穷举子集',
      'zh-CN', 'L10b', { vocabulary: POEM_VOCAB, triples: ['思故乡', '思故乡'] }],
    ['E6', '字符串 "a`b`c" 里把 b 两侧的反引号做成三元组：L9 在外侧边界补的空格进入字符串，值改变', 'zh-CN', 'L9', { triples: ['b'] }],
    ['E9', '行首（缩进后）的真转义 `g` 作语句首词并隐藏：o_k 因缩进条件不补空格，C⁻ 同一 IR', 'en-US', 'ok', { triples: ['g'] }],
    ['E10', '注释里的 `当` 隐藏：整个三元组在注释里，无害', 'en-US', 'ok', { triples: ['当'] }],
    ['E11', '结构 span {canonical:" `", display:""}（空格与反引号合并）', 'en-US', 'L10a', {}],
    ['E12', '只有一个反引号结构 span（不成对）', 'en-US', 'L10a', {}],
    ['E13', '反引号结构 span 的 display 为 "`"', 'en-US', 'L10a', {}],
    ['E13b', '反引号结构 span 的 display 为 「', 'en-US', 'L10a', {}],
    ['E14', '结构 span {canonical:"如果", display:"`如果`"}（把关键词伪装成转义名）', 'zh-CN', 'L10a', {}],
    ['E15', '三元组内容为 a.b（不是单个名字）', 'en-US', 'L10a', {}],
    ['E15b', '三元组内容为 当 前（含空格）', 'en-US', 'L10a', {}],
    ['E16', '5 个三元组', 'en-US', 'L10a', {}],
    ['E17', 'aliasSet RETURN=低头；`低头` 作名字并隐藏，正文另有别名 低头 作关键词：C⁻ 里 低头 出现在名字位置，编译失败', 'zh-CN', 'ok',
      { aliasSet: { RETURN: ['低头'] }, allowStructural: true, triples: ['低头', '低头'] }],
    ['E18', '限定名 s.`版本` 只隐藏成员这一段：C⁻ 的 s.版本 读作 s.version，字段 版本 下查不到，编译失败（实测；ADR 表中的「拒绝」对应 E20b 的两处都隐藏）',
      'zh-CN', 'ok', { triples: ['版本'] }],
    ['E19', '隐藏空格与隐藏反引号相邻（床前 `当` 明月光 的诗句排版）：它们是独立的结构 span，L9 只免去内侧边界', 'zh-CN', 'ok', { triples: ['当'] }],
    ['E20a', '两个三元组都隐藏，另有结构 span {返回 → 还给} 紧邻第二个三元组：三个子集都编译失败', 'zh-CN', 'ok', { triples: ['如果', '如果'] }],
    ['E20b', '字段声明与访问两处 `版本` 都隐藏，结构 span 同 E20a：子集 {两处} 的 C⁻ 编译通过、字段与访问都成了 version，IR 不同', 'zh-CN', 'L10b',
      { triples: ['版本', '版本'] }],
  ];
  return rows.map(([id, intent, lexicon, expect, extra]) => ({ id, intent, lexicon, layoutText: ser(L[id]), ...extra, expect }));
}

/** L9 补空格：转义三元组的内侧边界不补（padded 手写）。 */
function escapePaddingCases() {
  const L = escapeLayouts();
  return [
    { id: 'escape-E1', layout: L.E1, padded: `${ZHM}规则 取值 给定  \`如果\`  作为 整数，产出 整数：\n  返回  \`如果\` 。\n` },
    { id: 'escape-E9', layout: L.E9, padded: `${ENM}Rule g given x as Int, produce Int:\n  Return x.\n\nRule f given x as Int, produce Int:\n  \`g\` (x).\n  Return x.\n` },
    { id: 'escape-E19', layout: L.E19, padded: `${ZHM}定义 明月光 包含 长度 作为 整数。\n\n规则  床前  给定  \`当\`  作为  明月光，产出 整数：\n  返回 \`当\`.长度。\n` },
    { id: 'escape-E6', layout: L.E6, padded: `${ZHM}规则 取值，产出 文本：\n  返回 "a \`b\` c"。\n` },
    { id: 'escape-E8', layout: L.E8, padded: `${ENM}Rule f given x as Int, produce Int:\n  Return \`a \`x\` b\`.\n` },
  ].map((r) => ({ id: r.id, layoutText: ser(r.layout), padded: r.padded }));
}

/** 反向映射：E19 的诗句形状（字符串层面，不编译）。 */
function escapeReconstructCases() {
  const layout = { v: 1, spans: [C('床前'), S(' ', ''), S('`', ''), C('当'), S('`', ''), S(' ', ''), C('明月光')] };
  const rows = [
    ['escape-R1', '床前当明月光', 'unique', '床前 `当` 明月光'],
    ['escape-R2', '床前若明月光', 'unique', '床前 `若` 明月光'],
    ['escape-R3', '床前当当明月光', 'ambiguous'],
    ['escape-R4', '床后若明月照', 'unmappable'],
    ['escape-R5', '床前甲 乙明月光', 'unique', '床前 `甲 乙` 明月光'],
    ['escape-R6', '床前版本明月光', 'unique', '床前 `版本` 明月光'],
    ['escape-R7', '床前明月光', 'unmappable'],
  ];
  return rows.map(([id, edited, expect, canonical]) => ({ id, layoutText: ser(layout), edited, expect, ...(canonical !== undefined ? { canonical } : {}) }));
}

/** 五个向量文件的内容（generate() 写盘）。 */
export function displayVectors() {
  return {
    'vectors/layout.json': {
      description: '显示排版 L1–L7 向量（ADR 0059 修订 4 §4）：layoutText 为 policy/display/layout.json 的 UTF-8 文本，source 为 policy/policy.aster 的文本（或 sourceB64：其原始字节的 base64，用于非法 UTF-8；L2 的源码字节数与行数在字节上数），displayText 缺省为 toDisplay(layout)，layoutVersion 缺省为 1；expect 为 ok 或第一条失败的规则号。serialized 给出时 serializeLayout 的结果必须逐字等于它。vocabularyLocalized / literalKeywords / operatorSpellings 是 checkPackageLayout 的同名参数（拼写取自 keyword-spellings.json 并入 aliasSet 别名）。',
      version: 1,
      cases: layoutCases(),
    },
    'vectors/display-reconstruct.json': {
      description: '反向映射向量（ADR 0059 修订 4 D7）：edited 为已严格 UTF-8 解码、已去 BOM 的编辑后显示文本（文末换行规则由 reconstruct 处理）；expect 为 unique / unmappable / ambiguous，unique 时 canonical 为 toCanonical(L′)。performance 为配方：layout = unit 重复 units 次，edited = editUnit 重复 editRepeat 次接 editTail，各须在 2 s 内给出结论；canonicalUnit 给出时 toCanonical(L′) = canonicalUnit 重复 units 次。',
      version: 1,
      cases: [...reconstructCases(), ...escapeReconstructCases()],
      performance: performanceCases(),
    },
    'vectors/display-padding.json': {
      description: 'L9 补空格向量（ADR 0059 修订 4 §4）：padded 为 padStructuralSpans(layout) 的结果 P。 escape-* 为隐藏转义符（ADR 0059 修订 5 §2.2）：转义三元组的两个内侧边界（开反引号之后、闭反引号之前）不补空格，外侧边界照原条件补；escape-E6（字符串里的反引号）与 escape-E8（前一个转义的闭反引号当开）补空格后编译失败或值改变，由 L9 拒绝。',
      version: 1,
      cases: [...paddingCases(), ...escapePaddingCases()],
    },
    'vectors/display-escape.json': {
      description: 'L10 隐藏转义符向量（ADR 0059 修订 5 §6）：layoutText 为 policy/display/layout.json 的 UTF-8 文本，规范源码为其 toCanonical；lexicon / aliasSet / allowStructural / vocabulary 是编译输入。expect 为 ok 或第一条失败的规则：L10a（形状，不编译）、L9（补空格后编译失败或投影哈希改变）、L10b（某个非空子集去掉反引号后编译成另一个程序）；按 L1–L7、L10a、L8–L9、L10b 的次序判定。triples 为 L10a 通过时各三元组的名字（按出现顺序），stripped 给出时第 k 项为子集 {k}（k < 三元组数）与全部去掉的 C⁻(S)。参照实现只判 L10a 与 C⁻(S)，L9 / L10b 由 core 与 ts 用各自的编译器判定。E7（跨行字符串）不再适用：两引擎的字符串都不得跨行（#357）；E8 只能以补空格向量覆盖（见 display-padding.json）；E21 测的是显示面给出切分与标记，由包一致性（show 的 stderr）覆盖。',
      version: 1,
      cases: escapeCases(),
    },
    'vectors/keyword-spellings.json': KEYWORD_SPELLINGS,
  };
}
