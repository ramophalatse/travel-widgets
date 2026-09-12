#!/usr/bin/env node
/**
 * Print every inline edit saved against a widget page, newest first.
 *
 * The edit store holds what Ramo has changed in the browser; the HTML file holds
 * only what was authored. Without this, an edit made in the page is invisible
 * from the terminal, and the two can silently disagree.
 *
 * Usage:
 *   node scripts/show-edits.mjs                  # text edits, values truncated
 *   node scripts/show-edits.mjs --full           # untruncated values
 *   node scripts/show-edits.mjs --images         # include image edits
 *   node scripts/show-edits.mjs --key <substr>   # only keys containing <substr>
 *   node scripts/show-edits.mjs --page <id>      # default: trip-itinerary
 *
 * Read-only: it issues a GET and never writes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const page = opt('--page', 'trip-itinerary');
const source = readFileSync(join(root, `${page}.html`), 'utf8');

// Reuse the page's own credentials rather than keeping a second copy in sync.
const url = source.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1];
const key = source.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];
if (!url || !key) {
  console.error(`Could not read Supabase config out of ${page}.html`);
  process.exit(1);
}

const res = await fetch(
  `${url}/rest/v1/travel_itinerary_edits?page=eq.${encodeURIComponent(page)}&select=eid,type,value,updated_at`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } }
);
if (!res.ok) {
  console.error(`Store request failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

let rows = await res.json();
const needle = opt('--key', '');
if (needle) rows = rows.filter((r) => r.eid.includes(needle));
if (!flag('--images')) rows = rows.filter((r) => r.type !== 'img-src');

rows.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) || a.eid.localeCompare(b.eid));

if (!rows.length) {
  console.log('No edits saved for this page' + (needle ? ` matching "${needle}"` : '') + '.');
  process.exit(0);
}

const clean = (v) => String(v).replace(/\s+/g, ' ').trim();
const show = (r) => {
  if (r.type === 'img-src') return `<${Math.round(r.value.length / 1024)}KB image>`;
  if (r.type === 'notes') {
    try { return JSON.parse(r.value).map((n) => `\n      • ${clean(n)}`).join('') || '(none)'; }
    catch { return clean(r.value); }
  }
  const t = clean(r.value);
  return flag('--full') || t.length <= 140 ? t : t.slice(0, 140) + '…';
};

console.log(`${rows.length} edit${rows.length === 1 ? '' : 's'} saved for "${page}"\n`);
for (const r of rows) {
  const when = r.updated_at ? new Date(r.updated_at).toISOString().replace('T', ' ').slice(0, 16) : '';
  console.log(`  ${r.eid}  [${r.type}]${when ? '  ' + when : ''}`);
  console.log(`      ${show(r)}\n`);
}

/* An edit whose key names a row the file no longer contains is stranded: it will
 * silently stop being applied. That happens when an authored .act-name is
 * renamed, which is the one edit to the file that moves a key. Derive the valid
 * row keys the same way the page does and compare. */
const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const validRowKeys = new Set();
const cards = source.split(/data-day-key="/).slice(1);
for (const card of cards) {
  const dayKey = card.slice(0, card.indexOf('"'));
  const names = [...card.split(/<div class="day-card"|data-day-key="/)[0]
    .matchAll(/class="act-name"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => slugify(m[1].replace(/<[^>]*>/g, '')));
  const counts = {};
  names.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
  names.forEach((n, i) => {
    const twins = names.filter((x) => x === n);
    validRowKeys.add(`${dayKey}:${n}` + (twins.length > 1 ? `~${twins.indexOf(n) + names.slice(0, i).filter((x) => x === n).length + 1}` : ''));
  });
}

if (validRowKeys.size) {
  const stranded = rows.filter((r) => {
    const rk = r.eid.replace(/^notes:/, '').replace(/\.[^.]*$/, '');
    return rk.includes(':') && !validRowKeys.has(rk);
  });
  if (stranded.length) {
    console.log(`Stranded — key names a row not in ${page}.html, so it is no longer applied:`);
    stranded.forEach((r) => console.log(`  ${r.eid}`));
  }
}
