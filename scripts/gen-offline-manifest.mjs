#!/usr/bin/env node
/* Rebuilds offline-manifest.json: the list of media the service worker pulls
   down when "Save for offline" is tapped. Kept as a generated file rather than
   a directory walk at runtime, because GitHub Pages has no directory listing.

   Run after adding or removing anything under the asset folders below:
     node scripts/gen-offline-manifest.mjs
*/
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// Every widget is kept offline, so the whole assets tree is in scope.
const MEDIA_DIRS = ['assets'];
const OUT = join(root, 'offline-manifest.json');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const media = MEDIA_DIRS.flatMap(d => walk(join(root, d)))
  .map(f => relative(root, f).split('\\').join('/'))
  .filter(f => !f.endsWith('.DS_Store'))
  .sort();

// Every widget page, so any of them opens with no signal rather than only the
// one that happened to register the worker.
const pages = readdirSync(root).filter(f => f.endsWith('.html')).sort();

const files = [...pages, ...media];
const bytes = files.reduce((n, f) => n + statSync(join(root, f)).size, 0);

// Bump whenever the list changes, so the worker can tell a stale saved copy
// from a current one without diffing every entry.
const prev = (() => {
  try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return null; }
})();
const same = prev && JSON.stringify(prev.files) === JSON.stringify(files);
const revision = same ? prev.revision : new Date().toISOString().slice(0, 10) + '-' + files.length;

writeFileSync(OUT, JSON.stringify({ revision, bytes, files }, null, 2) + '\n');
console.log(`offline-manifest.json: ${files.length} files, ${(bytes / 1048576).toFixed(1)}MB, revision ${revision}`);
