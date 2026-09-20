/* Offline support for the travel widgets.
   ─────────────────────────────────────────────────────────────────────────
   Two caches, deliberately separate:

   SHELL is the pages themselves plus fonts and icons, a megabyte or so. It
   is precached on install, so a widget opens with no signal at all.

   MEDIA is the rest: every photo across every widget, about 56MB. It fills
   itself in the background once the worker is running, and picks up where it
   left off on the next load, so there is nothing to remember and a download
   cut short by a closed tab is not lost work. Photos also land here as they
   are viewed, so a partial copy is still useful.

   Supabase is never cached here. Saved edits are the page's own business and
   it keeps its own snapshot in IndexedDB, where it can be read and merged
   rather than replayed blindly out of an HTTP cache. */

const VERSION = 'v8';
const SHELL = 'ti-shell-' + VERSION;
const MEDIA = 'ti-media-' + VERSION;
const SCOPE = new URL(self.registration.scope);

const SHELL_URLS = [
  'trip-itinerary.html',
  'offline-manifest.json',
  'manifest.webmanifest',
  'assets/nyc-miami-2026/icons/tesla.svg',
  'assets/nyc-miami-2026/icons/battery.svg',
  'assets/nyc-miami-2026/icons/walk.svg',
  'assets/nyc-miami-2026/icons/timer.svg',
  'https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Hanken+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'
].map(u => new URL(u, SCOPE).href);

/* Matched on path rather than on the full URL, so media is recognised whatever
   origin the page is served from: the deployed site, a local server, a preview
   host. Asset links in the page are relative and would resolve correctly
   either way, but this keeps a stray absolute link from silently going
   uncached. */
const MEDIA_PATH = /\/assets\//;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* Background download pacing. Two at a time leaves room for the page's own
   requests inside the browser's per-origin connection limit, which four did
   not: a burst on activate left the tab unresponsive while it caught up. */
const CONCURRENCY = 2;
const START_DELAY_MS = 5000;
const BETWEEN_FILES_MS = 120;

self.addEventListener('install', event => {
  // The shell is small and every entry matters, so a single failure should not
  // leave a half-built cache claiming to be complete: addAll is all-or-nothing.
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_URLS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== MEDIA && k.startsWith('ti-')).map(k => caches.delete(k)));
    await self.clients.claim();
    // Fill the media cache without being asked, but not immediately: starting
    // 57MB while the page is still loading competes for the six connections
    // the browser allows per origin and makes first paint crawl. A short head
    // start costs nothing and keeps the download genuinely in the background.
    // saveMedia skips what it already holds, so this doubles as the resume for
    // anything an earlier visit did not finish.
    setTimeout(() => saveMedia(), START_DELAY_MS);
  })());
});

self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') return self.skipWaiting();
  // Kept so a page that loads while a download is incomplete can nudge it
  // along, which is how a run cut short by a closed tab gets picked back up.
  if (msg.type === 'SAVE_MEDIA') event.waitUntil(saveMedia(true));
  if (msg.type === 'MEDIA_STATUS') event.waitUntil(reportStatus(event.source));
  if (msg.type === 'FORGET_MEDIA') event.waitUntil(caches.delete(MEDIA).then(() => reportStatus(event.source)));
});

async function manifest() {
  const cache = await caches.open(SHELL);
  const url = new URL('offline-manifest.json', SCOPE).href;
  const res = (await cache.match(url)) || (await fetch(url, { cache: 'no-cache' }));
  return res.json();
}

async function reportStatus(client) {
  if (!client) return;
  const { files, bytes } = await manifest();
  const cache = await caches.open(MEDIA);
  const held = await cache.keys();
  const wanted = new Set(files.map(f => new URL(f, SCOPE).href));
  let have = 0;
  held.forEach(r => { if (wanted.has(r.url)) have++; });
  client.postMessage({ type: 'MEDIA_STATUS', have, total: files.length, bytes });
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(msg));
}

let saving = false;
async function saveMedia(force) {
  if (saving) return;
  // Data Saver is an explicit "do not spend my bandwidth", so the automatic
  // run respects it. An explicit request from the page still goes ahead.
  if (!force && self.navigator.connection && self.navigator.connection.saveData) return;
  saving = true;
  try {
    const { files, bytes } = await manifest();
    const cache = await caches.open(MEDIA);
    let done = 0, failed = 0, next = 0;
    async function worker() {
      while (next < files.length) {
        const url = new URL(files[next++], SCOPE).href;
        try {
          if (!(await cache.match(url))) {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) throw new Error(res.status);
            await cache.put(url, res);
            // Breathe between files. This is background work and should never
            // be the reason a page feels slow.
            await new Promise(r => setTimeout(r, BETWEEN_FILES_MS));
          }
        } catch (e) {
          failed++;
        }
        done++;
        // Throttled: one message per file across 190 files is noise, and the
        // page only needs enough to move a progress readout.
        if (done % 5 === 0 || done === files.length) {
          broadcast({ type: 'MEDIA_PROGRESS', done, total: files.length, failed, bytes });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    broadcast({ type: 'MEDIA_DONE', done, total: files.length, failed });
  } finally {
    saving = false;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Saved edits and photo uploads must always hit the network, so that being
  // offline fails loudly enough for the page to queue the write itself.
  if (url.hostname.endsWith('.supabase.co')) return;

  if (req.mode === 'navigate') return event.respondWith(navigateFirst(req));

  if (FONT_HOSTS.includes(url.hostname)) return event.respondWith(cacheFirst(req, SHELL));

  if (MEDIA_PATH.test(url.pathname)) return event.respondWith(cacheFirst(req, MEDIA));

  if (url.origin === SCOPE.origin) return event.respondWith(cacheFirst(req, SHELL));
});

/* Network first, so an online visit always gets the current page rather than
   yesterday's copy, with the cache as the offline floor. */
async function navigateFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch (e) {
    // Searched across both caches: pages arrive in SHELL when precached on
    // install and in MEDIA when pulled in by the manifest, and a lookup in
    // only one of them silently misses half the widgets.
    //
    // No cross-page fallback. An earlier version answered any miss with the
    // trip itinerary, so asking for the Cape Town page offline returned New
    // York under the Cape Town URL. Handing back the wrong trip is worse than
    // admitting the page was never saved.
    const hit = (await caches.match(req)) || (await caches.match(req.url, { ignoreSearch: true }));
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Not saved for offline</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#0a0f14;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center;line-height:1.6}a{color:#4ade80}</style>' +
      '<div><h1>Not saved for offline</h1><p>This page was never downloaded, and there is no connection to fetch it.</p>' +
      '<p><a href="trip-itinerary.html">Open the trip itinerary</a></p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Opaque cross-origin font responses are still worth keeping: they render
    // fine from cache even though we cannot inspect their status.
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return hit || Response.error();
  }
}
