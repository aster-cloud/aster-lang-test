/**
 * Aster Lang test corpus loader (Node).
 *
 * Provides path-based access to the bundled corpus. Browsers should bundle the
 * corpus via their bundler's asset pipeline; this module assumes a Node-style
 * filesystem.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Corpus root directory. Resolved relative to this module so the path is
 * stable whether the package is consumed via `node_modules`, a workspace
 * symlink, or a local checkout.
 *
 * Layout searched, in order:
 *   - <pkg>/corpus           (post-prepack: bundled into the tarball)
 *   - <pkg>/../../../corpus  (dev: monorepo root)
 */
function resolveCorpusRoot(): string {
  const candidates = [
    resolve(__dirname, '..', 'corpus'),
    resolve(__dirname, '..', '..', '..', '..', 'corpus'),
    resolve(__dirname, '..', '..', '..', 'corpus'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `aster-lang-test: corpus not found in any of:\n  ${candidates.join('\n  ')}`,
  );
}

export const CORPUS_ROOT = resolveCorpusRoot();

export type Tier = 1 | 2 | 3;

export interface SampleMeta {
  tier: Tier;
  engines: ('java' | 'ts')[];
  lexicon?: string;
  capabilities?: string[];
  knownGaps?: string[];
  divergenceType?: 'grammar-gap' | 'sample-bug' | 'intentional' | 'unexpected';
  bucket?: string;
  source?: string;
  tags?: string[];
  notes?: string;
}

export interface Sample {
  /** Relative to CORPUS_ROOT, e.g. "tier1-equivalence/policies/01-arithmetic-add.aster". */
  path: string;
  /** Absolute path; convenient for shelling out. */
  absPath: string;
  /** Parsed .meta.json contents. */
  meta: SampleMeta;
  /** Convenience: read source on demand. */
  readSource(): string;
  /** If a `.cases.json` exists for this sample, returns parsed object; else null. */
  readCases(): CasesGolden | null;
}

export interface CasesGolden {
  /** Path (corpus-relative) to the .aster file. */
  policy: string;
  /** Entry function name to invoke. */
  entry: string;
  cases: CaseDef[];
}

export interface CaseDef {
  name: string;
  input: unknown[];
  expectedOutput: unknown;
}

export interface ListOpts {
  /** Filter by tier. */
  tier?: Tier;
  /** Filter to samples whose engines list includes this engine. */
  engine?: 'java' | 'ts';
  /** Filter by tier3 bucket. */
  bucket?: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.aster')) out.push(full);
  }
  return out;
}

function loadMeta(asterAbs: string): SampleMeta {
  const metaAbs = asterAbs.replace(/\.aster$/, '.meta.json');
  if (!existsSync(metaAbs)) {
    throw new Error(`Missing .meta.json beside ${asterAbs}`);
  }
  return JSON.parse(readFileSync(metaAbs, 'utf8'));
}

function makeSample(asterAbs: string): Sample {
  const rel = relative(CORPUS_ROOT, asterAbs);
  const meta = loadMeta(asterAbs);
  return {
    path: rel,
    absPath: asterAbs,
    meta,
    readSource: () => readFileSync(asterAbs, 'utf8'),
    readCases: () => {
      const casesAbs = asterAbs
        .replace('/policies/', '/inputs/')
        .replace(/\.aster$/, '.cases.json');
      if (!existsSync(casesAbs)) return null;
      return JSON.parse(readFileSync(casesAbs, 'utf8'));
    },
  };
}

/** List every sample under CORPUS_ROOT. */
export function listSamples(opts: ListOpts = {}): Sample[] {
  const all = walk(CORPUS_ROOT).map(makeSample);
  return all.filter((s) => {
    if (opts.tier !== undefined && s.meta.tier !== opts.tier) return false;
    if (opts.engine && !s.meta.engines.includes(opts.engine)) return false;
    if (opts.bucket && s.meta.bucket !== opts.bucket) return false;
    return true;
  });
}

/** Convenience: just tier1 samples (the equivalence set). */
export function listTier1(): Sample[] {
  return listSamples({ tier: 1 });
}

/** Convenience: list samples in a specific tier3 bucket. */
export function listTier3Bucket(bucket: string): Sample[] {
  return listSamples({ tier: 3, bucket });
}

/** Read one sample by corpus-relative path. Throws if not found. */
export function readSample(relPath: string): Sample {
  const abs = resolve(CORPUS_ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`Sample not found: ${relPath}`);
  return makeSample(abs);
}
