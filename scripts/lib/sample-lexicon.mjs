/**
 * 样本声明的词法表（`.meta.json` 的 `lexicon` 字段）与 TS 引擎的按词法表解析。
 *
 * ★为什么抽成共享模块：parity-tier1.mjs（PR-blocking）与 equivalence-nightly.mjs
 * 都要「按样本声明的词法表驱动 TS 引擎」。2026-08-17 审计只修了 parity-tier1，
 * nightly 仍按默认英语硬解，于是 test#199 引入第一个 zh-CN tier1 样本后 nightly
 * 整晚变红（issue #205）。两个 runner 共用同一实现，避免再次漂移。
 *
 * Java 侧不需要 runner 传词法表：aster-lang-core 的 TsSampleParseInventoryTest
 * 经 CorpusLoader 自行读取同一份 meta.lexicon（取不到即失败，不退回英语）。
 *
 * 两种读取口径：
 *   - lexiconOf：宽松，缺失退回 en-US（parity-tier1 既有语义，覆盖 manifest 外的语料）；
 *   - declaredLexiconOf：严格，缺 meta / 缺字段 / 空值 / 坏 JSON 均抛错（nightly 用）——
 *     非英语样本漏标 lexicon 时，静默退回英语只会把它变成一条莫名的 TS 解析失败。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_LEXICON = 'en-US';

// TS 构建产物里可按名加载的非英语词法表：[lexicon id, dist/src 下的相对路径, 导出名]。
const TS_LEXICON_MODULES = [
  ['zh-CN', 'config/lexicons/zh-CN.js', 'ZH_CN'],
  ['de-DE', 'config/lexicons/de-DE.js', 'DE_DE'],
  ['hi-IN', 'config/lexicons/hi-IN.js', 'HI_IN'],
];

const metaPathOf = (abs) => abs.replace(/\.aster$/, '.meta.json');

function readMetaStrict(abs) {
  const metaPath = metaPathOf(abs);
  if (!existsSync(metaPath)) throw new Error(`${abs}: 缺少 meta 文件 ${metaPath}，无法确定 lexicon`);
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new Error(`${abs}: meta 文件 ${metaPath} 不是合法 JSON（${e.message}），无法确定 lexicon`);
  }
}

/** 样本声明的词法表；未声明 / 无 meta / meta 不可读时退回 en-US。 */
export function lexiconOf(abs) {
  try {
    return declaredLexiconOf(abs);
  } catch {
    return DEFAULT_LEXICON;
  }
}

/** 样本**显式**声明的词法表；缺 meta、缺字段、空值或非字符串都抛错，绝不退回 en-US。 */
export function declaredLexiconOf(abs) {
  const { lexicon } = readMetaStrict(abs);
  if (typeof lexicon !== 'string' || lexicon === '') {
    throw new Error(`${abs}: meta 未声明 lexicon（缺字段或为空）；须显式写明，例如 "en-US" / "zh-CN"`);
  }
  return lexicon;
}

/** 加载 TS 侧非英语词法表对象 { id → lexicon }；当前构建缺失的词法表直接略过（声明它的样本会在 selectTsLexicon 失败）。 */
export async function loadTsLexicons(tsRepo) {
  const out = {};
  for (const [name, rel, exportName] of TS_LEXICON_MODULES) {
    try {
      const m = await import(join(tsRepo, 'dist', 'src', rel));
      if (m[exportName]) out[name] = m[exportName];
    } catch {
      // 该词法表在当前构建中不可用
    }
  }
  return out;
}

/** 声明的词法表 → TS 词法表对象；en-US 返回 undefined（默认路径），取不到的非 en-US 抛错。 */
export function selectTsLexicon(lexicons, lexName, rel) {
  if (lexName === DEFAULT_LEXICON) return undefined;
  const lexObj = lexicons[lexName];
  if (!lexObj) throw new Error(`sample ${rel} declares lexicon "${lexName}" but it could not be loaded from aster-lang-ts`);
  return lexObj;
}

/**
 * 单个样本的 TS 解析结果 { ok, err, line, crash }。
 * 错误诊断与 DiagnosticError 都是「解析错误」（带行号）；其余异常是崩溃，
 * must-reject 门不把崩溃当成拒绝。lexObj 为 undefined 时走默认（英语）路径，行为逐字节不变。
 */
export function tsParseOne({ canonicalize, lex, parse, parseWithLexicon }, src, lexObj) {
  try {
    const canonical = lexObj ? canonicalize(src, lexObj) : canonicalize(src);
    const tokens = lexObj ? lex(canonical, lexObj) : lex(canonical);
    const { ast, diagnostics } = lexObj && parseWithLexicon
      ? parseWithLexicon(tokens, lexObj)
      : parse(tokens);
    const diag = (diagnostics || []).find((d) => d.severity === 'error');
    if (diag) return { ok: false, err: diag.message, line: diag.span?.start?.line ?? null, crash: false };
    if (!ast) return { ok: false, err: 'parse returned no AST', line: null, crash: true };
    return { ok: true, err: null };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    const line = e?.diagnostic?.span?.start?.line ?? null;
    return { ok: false, err, line, crash: !e?.diagnostic };
  }
}
