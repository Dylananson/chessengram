#!/usr/bin/env node
/**
 * AN-001b — fetch the vendored Stockfish build.
 *
 * Deliberately **not** an npm dependency: the published `stockfish` tarball is
 * 161 MB / 205 MB unpacked because it carries four more flavours including two
 * ~99 MB wasm files, and we need exactly two files from the pinned release.
 * Downloading them here keeps the repo light, keeps `npm ci` fast, and — because
 * the service worker serves them from cache afterwards — the *user* is still
 * fully offline-capable.
 *
 * Pinned identity (see `docs/research/stockfish-evaluation.md`):
 *   stockfish.js 19.0.1 "lite-single" — 28,230 B JS + 1,845,971 B wasm
 *   (1.79 MiB raw / 1.16 MiB gz), GPL-3.0, no SharedArrayBuffer, no eval.
 *
 * Idempotent: a file that already matches its SHA256 is left alone, so a normal
 * build needs no network once the pair is cached. A mismatch fails loudly.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..');
const TARGET_DIR = join(WEB_ROOT, 'public', 'engine');

/** Pinned release: changing any of these means re-verifying and re-noticing. */
const RELEASE = 'v19.0.1';
const BASE_URL = `https://github.com/nmrugg/stockfish.js/releases/download/${RELEASE}`;
const FILES = [
  {
    name: 'stockfish-19-lite-single.js',
    sha256: 'ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a',
  },
  {
    name: 'stockfish-19-lite-single.wasm',
    sha256: 'ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de',
  },
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(file) {
  const target = join(TARGET_DIR, file.name);
  if (existsSync(target) && sha256(target) === file.sha256) {
    console.log(`ok    ${file.name} (${statSync(target).size} B, cached)`);
    return false;
  }
  const url = `${BASE_URL}/${file.name}`;
  console.log(`fetch ${file.name} <- ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed for ${file.name}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256) {
    throw new Error(
      `SHA256 mismatch for ${file.name}\n  expected ${file.sha256}\n  actual   ${digest}\n` +
        'Refusing to vendor an unexpected artifact: re-check the release and update the ' +
        'pinned SHA plus apps/web/THIRD-PARTY-NOTICE.md together.',
    );
  }
  mkdirSync(TARGET_DIR, { recursive: true });
  // Write via a temp file so an interrupted download cannot leave a bad artifact.
  const tmp = `${target}.partial`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  console.log(`ok    ${file.name} (${bytes.length} B, verified)`);
  return true;
}

let fetched = 0;
for (const file of FILES) {
  if (await download(file)) fetched += 1;
}
const total = FILES.reduce((sum, f) => sum + statSync(join(TARGET_DIR, f.name)).size, 0);
console.log(
  `engine ready: ${FILES.length} files, ${(total / 1024 / 1024).toFixed(2)} MiB ` +
    `(${fetched} downloaded, ${FILES.length - fetched} already cached) -> public/engine/`,
);
