import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_ROOT,
  listSamples,
  listTier1,
  listTier3Bucket,
  readSample,
} from '../loader.js';

// 本文件位于 <pkg>/{src,dist}/test，仓库 corpus 为 <pkg>/../../corpus。
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..', '..');
const REPO_CORPUS = resolve(PKG, '..', '..', 'corpus');
const SNAPSHOT_CORPUS = resolve(PKG, 'corpus');

describe('CorpusLoader', () => {
  it('resolves CORPUS_ROOT to an existing directory', () => {
    assert.ok(CORPUS_ROOT.endsWith('corpus'), `got ${CORPUS_ROOT}`);
  });

  it('prefers the repo corpus over the prepack snapshot inside the monorepo (issue #151)', (t) => {
    if (!existsSync(REPO_CORPUS)) {
      return t.skip(`no repo corpus at ${REPO_CORPUS} (installed tarball)`);
    }
    assert.equal(CORPUS_ROOT, REPO_CORPUS);
    assert.notEqual(CORPUS_ROOT, SNAPSHOT_CORPUS);
  });

  it('listSamples returns the full corpus (≥ 300 samples after dedup)', () => {
    const all = listSamples();
    assert.ok(all.length >= 300, `expected ≥ 300 samples, got ${all.length}`);
  });

  it('listTier1 returns >= 160 samples and all have engines=[java,ts]', () => {
    const t1 = listTier1();
    assert.ok(t1.length >= 160, `expected ≥ 160 tier1 samples, got ${t1.length}`);
    for (const s of t1) {
      assert.deepEqual([...s.meta.engines].sort(), ['java', 'ts']);
    }
  });

  it('listTier3Bucket("lossless") returns the pretty-printer goldens', () => {
    const lossless = listTier3Bucket('lossless');
    assert.ok(lossless.length >= 25, `expected ≥ 25 lossless samples, got ${lossless.length}`);
  });

  it('readSample reads source content', () => {
    const t1 = listTier1();
    assert.ok(t1.length > 0, 'need at least one tier1 sample');
    const source = t1[0].readSource();
    assert.ok(source.includes('Module') || source.includes('Rule'),
      `tier1 sample should contain Module/Rule, got: ${source.slice(0, 100)}`);
  });

  it('readCases returns cases for tier1 samples with .cases.json', () => {
    const t1 = listTier1();
    const withCases = t1.find((s) => s.readCases() !== null);
    assert.ok(withCases, 'expected ≥ 1 tier1 sample with .cases.json');
    const cases = withCases!.readCases()!;
    assert.ok(cases.cases.length > 0, 'cases array should be non-empty');
    assert.ok(typeof cases.entry === 'string', 'cases.entry should be a string');
  });

  it('every sample has a corresponding .meta.json', () => {
    const all = listSamples();
    for (const s of all) {
      assert.ok(s.meta.tier, `${s.path} missing meta.tier`);
      assert.ok(s.meta.engines, `${s.path} missing meta.engines`);
    }
  });
});
