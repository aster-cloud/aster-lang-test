#!/usr/bin/env node
/**
 * Copy ../../corpus into packages/js/corpus before packing.
 * This makes the npm tarball self-contained.
 */
import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'corpus');
const dst = resolve(here, '..', 'corpus');

await rm(dst, { recursive: true, force: true });
await mkdir(dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`Synced corpus: ${src} → ${dst}`);
