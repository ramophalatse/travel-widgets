/* Offline support for the trip itinerary.
   ─────────────────────────────────────────────────────────────────────────
   Two caches, deliberately separate:

   SHELL is the page itself plus fonts and icons, a megabyte or so. It is
   precached on install so the itinerary opens with no signal at all.

   MEDIA is the 42MB of trip photos. It is filled only when the page asks,
   so a first visit on cellular does not quietly pull down 42MB. Photos also
   land here as they are viewed online, so a partial save is still useful.

   Supabase is never cached here. Saved edits are the page's own business and
   it keeps its own snapshot in IndexedDB, where it can be read and merged
   rather than replayed blindly out of an HTTP cache. */

const VERSION = 'v3';
const SHELL = 'ti-shell-' + VERSION;
const MEDIA = 'ti-media-' + VERSION;
const SCOPE = new URL(self.registration.scope);

const SHELL_URLS = [
  'trip-itinerary.html',
  'offline-manifest.json',
  'assets/nyc-miami-2026/icons/tesla.svg',
  'assets/nyc-miami-2026/icons/battery.svg',
  'https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Hanken+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'
].map(u => new URL(u, SCOPE).href);

/* Matched on path rather than on the full URL, so media is recognised whatever
   origin the page is served from: the deployed site, a local server, a preview
   host. Asset links in the page are relative and would resolve correctly
   either way, but this keeps a stray absolute link from silently going
   uncached. */
const MEDIA_PATH = /\/assets\//;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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
  })());
});

self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') return self.skipWaiting();
  if (msg.type === 'SAVE_MEDIA') event.waitUntil(saveMedia(event.source));
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

let saving = false;
async function saveMedia(client) {
  if (saving) return;
  saving = true;
  try {
    const { files, bytes } = await manifest();
    const cache = await caches.open(MEDIA);
    let done = 0, failed = 0, next = 0;
    // A few at a time. One at a time is latency-bound and takes minutes; a
    // burst of 161 tends to time out in clumps on weak wifi and makes the
    // progress bar meaningless. Four keeps the pipe busy and the count honest.
    const CONCURRENCY = 4;
    async function worker() {
      while (next < files.length) {
        const url = new URL(files[next++], SCOPE).href;
        try {
          if (!(await cache.match(url))) {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) throw new Error(res.status);
            await cache.put(url, res);
          }
        } catch (e) {
          failed++;
        }
        done++;
        if (client) client.postMessage({ type: 'MEDIA_PROGRESS', done, total: files.length, failed, bytes });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    if (client) client.postMessage({ type: 'MEDIA_DONE', done, total: files.length, failed });
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

/* Network first, so an online visit always gets the current itinerary rather
   than yesterday's copy, with the cache as the offline floor. */
async function navigateFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req)) ||
      (await cache.match(new URL('trip-itinerary.html', SCOPE).href)) ||
      new Response('Offline and this page was never saved.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
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
