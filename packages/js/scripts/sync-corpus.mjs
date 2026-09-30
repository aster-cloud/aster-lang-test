#!/usr/bin/env node
/**
 * Copy ../../corpus into packages/js/corpus before packing.
 * This makes the npm tarball self-contained.
 *
 * `--clean` only removes the snapshot (postpack). 快照留在工作树里会遮蔽仓库
 * corpus——loader 虽已在仓库内优先取 monorepo 根，但陈旧副本本身没有任何用途，
 * pack 完成后立即清理，避免它被误当作真源（issue #151）。
 */
import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'corpus');
const dst = resolve(here, '..', 'corpus');

await rm(dst, { recursive: true, force: true });
if (process.argv.includes('--clean')) {
  console.log(`Removed corpus snapshot: ${dst}`);
  process.exit(0);
}
await mkdir(dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`Synced corpus: ${src} → ${dst}`);
