#!/usr/bin/env node
/**
 * Verify every Aster CNL code example embedded in the docs actually
 * parses with the real compiler.
 *
 * Why this exists: a CNL language's adoption hinges on the first code a
 * visitor reads being correct. A landing-page example that doesn't parse
 * is adoption poison. This walks the docs, extracts every ```aster fenced
 * block, and runs it through aster-lang-ts (canonicalize → lex → parse).
 * Broken blocks are reported with file:line.
 *
 * Scope (default): aster-lang-dev English docs + aster-cloud English MDX.
 * zh/de mirrors use different lexicons; pass --locale=zh / --locale=de to
 * check those (uses parseWithLexicon).
 *
 * Opt-out: a fence can declare it is intentionally not-runnable with an
 * info-string flag, e.g. ```aster ignore  or  ```aster expect-error
 *   - `ignore`       → skipped entirely (pseudo-code, partial snippets)
 *   - `expect-error` → MUST fail to parse (negative examples); passing
 *                      parse is then itself a failure.
 *
 * Exit codes:
 *   0  — every checked block parses (and every expect-error block fails)
 *   1  — at least one block is broken
 *   2  — infra (compiler not built, no docs found)
 *
 * Output: human summary + per-failure file:line:message.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TS_REPO = resolve(ROOT, '..', 'aster-lang-ts');
const DEV_DOCS = resolve(ROOT, '..', 'aster-lang-dev', 'docs');
const CLOUD_DOCS = resolve(ROOT, '..', 'aster-cloud', 'src', 'app', '[locale]', 'docs');

const args = process.argv.slice(2);
const localeArg = args.find((a) => a.startsWith('--locale='));
const LOCALE = localeArg ? localeArg.slice('--locale='.length) : 'en';

function fail(msg, code = 2) {
  console.error(`::error::${msg}`);
  process.exit(code);
}

async function loadCompiler() {
  const distIndex = join(TS_REPO, 'dist', 'src', 'index.js');
  if (!existsSync(distIndex)) {
    fail(`aster-lang-ts not built. Run: cd ${TS_REPO} && pnpm build`);
  }
  const mod = await import(distIndex);
  const { canonicalize, lex, parse } = mod;
  if (!canonicalize || !lex || !parse) {
    fail('aster-lang-ts missing exports (canonicalize/lex/parse)');
  }
  return mod;
}

/**
 * 按 locale 加载 TS 侧词法表**对象**。
 *
 * ★与 parity-tier1.mjs 的 loadTsLexicons 同源：canonicalize / lex / parseWithLexicon
 * 三处都必须拿到词法表**对象**，缺任何一处都会在第一个非 ASCII 字符上炸
 * （实测 `Unexpected character '模'`）。此前本脚本三处全没传、且把字符串
 * `'zh'` 当对象传给 parseWithLexicon —— zh/de 文档跑批**系统性假红**。
 */
const LEXICON_SPECS = {
  zh: ['config/lexicons/zh-CN.js', 'ZH_CN'],
  de: ['config/lexicons/de-DE.js', 'DE_DE'],
  hi: ['config/lexicons/hi-IN.js', 'HI_IN'],
};

async function loadLexicon(locale) {
  if (locale === 'en') return null;
  const spec = LEXICON_SPECS[locale];
  if (!spec) {
    fail(`unknown locale "${locale}" (supported: en, ${Object.keys(LEXICON_SPECS).join(', ')})`);
  }
  const [rel, exportName] = spec;
  let m;
  try {
    m = await import(join(TS_REPO, 'dist', 'src', rel));
  } catch (e) {
    fail(`locale "${locale}" 的词法表无法从 aster-lang-ts 加载（${rel}）：${e?.message ?? e}`);
  }
  if (!m[exportName]) {
    fail(`locale "${locale}" 的词法表模块缺少导出 ${exportName}（${rel}）`);
  }
  return m[exportName];
}

/** Recursively collect markdown/mdx files under a dir. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) walk(abs, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(abs);
  }
  return out;
}

/**
 * Extract ```aster fenced blocks from markdown. Returns
 * { code, startLine, flags } per block. `flags` is the fence info-string
 * tokens after the language (e.g. "ignore", "expect-error").
 */
function extractAsterBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let inBlock = false;
  let buf = [];
  let startLine = 0;
  let flags = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceOpen = line.match(/^\s*```+\s*aster\b(.*)$/i);
    if (!inBlock && fenceOpen) {
      inBlock = true;
      buf = [];
      startLine = i + 2; // first content line, 1-based
      flags = fenceOpen[1].trim().split(/\s+/).filter(Boolean);
      continue;
    }
    if (inBlock && /^\s*```+\s*$/.test(line)) {
      blocks.push({ code: buf.join('\n'), startLine, flags });
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

function parseBlock(mod, code, lexObj) {
  try {
    // ★词法表对象必须贯穿三处（canonicalize / lex / parseWithLexicon）。
    //   少传任何一处都会在第一个非 ASCII 关键词上抛 `Unexpected character`，
    //   使整批非 en 文档系统性假红。调用形态与 parity-tier1.mjs 保持一致。
    const canonical = lexObj ? mod.canonicalize(code, lexObj) : mod.canonicalize(code);
    const tokens = lexObj ? mod.lex(canonical, lexObj) : mod.lex(canonical);
    const result = lexObj && mod.parseWithLexicon
      ? mod.parseWithLexicon(tokens, lexObj)
      : mod.parse(tokens);
    const diags = result.diagnostics || [];
    const errs = diags.filter((d) => d.severity === 'error');
    return { ok: errs.length === 0 && !!result.ast, error: errs[0]?.message || (result.ast ? null : 'no AST') };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function main() {
  const mod = await loadCompiler();
  const lexObj = await loadLexicon(LOCALE);

  // Gather doc files for the requested locale.
  const files = [];
  if (LOCALE === 'en') {
    for (const f of walk(DEV_DOCS, ['.md'])) {
      const rel = relative(DEV_DOCS, f);
      // 非英文镜像（zh/de/hi）在 en-locale 运行中跳过——它们用各自的 lexicon，
      // 由 dev 仓自己的 check:examples（按 docs/<locale> 选 lexicon）覆盖。
      if (rel.startsWith('zh/') || rel.startsWith('de/') || rel.startsWith('hi/')) continue;
      files.push(f);
    }
    for (const f of walk(CLOUD_DOCS, ['.mdx'])) {
      if (f.endsWith('en.mdx')) files.push(f);
    }
  } else {
    for (const f of walk(join(DEV_DOCS, LOCALE), ['.md'])) files.push(f);
    for (const f of walk(CLOUD_DOCS, ['.mdx'])) {
      if (f.endsWith(`${LOCALE}.mdx`)) files.push(f);
    }
  }

  let total = 0;
  let skipped = 0;
  const failures = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const blocks = extractAsterBlocks(text);
    for (const b of blocks) {
      if (b.flags.includes('ignore') || b.flags.includes('no-verify')) {
        skipped++;
        continue;
      }
      if (!b.code.trim()) continue;
      total++;
      const expectError = b.flags.includes('expect-error');
      const res = parseBlock(mod, b.code, lexObj);
      if (expectError) {
        if (res.ok) {
          failures.push({ file, line: b.startLine, message: 'expected parse error but block parsed cleanly' });
        }
      } else if (!res.ok) {
        failures.push({ file, line: b.startLine, message: res.error });
      }
    }
  }

  console.log(`# Doc example verification (locale=${LOCALE})\n`);
  console.log(`- files scanned: ${files.length}`);
  console.log(`- aster blocks checked: ${total}`);
  console.log(`- skipped (ignore/no-verify): ${skipped}`);
  console.log(`- broken: ${failures.length}\n`);

  if (failures.length > 0) {
    console.log('## Broken examples\n');
    for (const f of failures) {
      const rel = relative(resolve(ROOT, '..'), f.file);
      console.log(`- ${rel}:${f.line} — ${(f.message || '').slice(0, 120)}`);
    }
    console.log('');
    process.exit(1);
  }
  console.log('All doc examples parse ✓');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
