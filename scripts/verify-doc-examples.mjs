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

function parseBlock(mod, code, locale) {
  try {
    const canonical = mod.canonicalize(code);
    const tokens = mod.lex(canonical);
    let result;
    if (locale !== 'en' && mod.parseWithLexicon) {
      // best-effort multi-lexicon; falls back to parse if unsupported
      result = mod.parseWithLexicon(tokens, locale);
    } else {
      result = mod.parse(tokens);
    }
    const diags = result.diagnostics || [];
    const errs = diags.filter((d) => d.severity === 'error');
    return { ok: errs.length === 0 && !!result.ast, error: errs[0]?.message || (result.ast ? null : 'no AST') };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function main() {
  const mod = await loadCompiler();

  // Gather doc files for the requested locale.
  const files = [];
  if (LOCALE === 'en') {
    for (const f of walk(DEV_DOCS, ['.md'])) {
      const rel = relative(DEV_DOCS, f);
      if (rel.startsWith('zh/') || rel.startsWith('de/')) continue;
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
      const res = parseBlock(mod, b.code, LOCALE);
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
