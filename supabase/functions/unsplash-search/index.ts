// Unsplash proxy for the travel-widgets itinerary pages (ramophalatse.github.io).
// Keeps the Unsplash Access Key server-side (secret UNSPLASH_ACCESS_KEY).
// verify_jwt is off because the pages call with a publishable key, which is not
// a JWT. The function only reads from Unsplash, and requests from other
// origins are refused.
//   GET ?q=<query>&page=<n>      search landscape photos, trimmed results
//   GET ?download=<location>     Unsplash's required download ping when a photo is picked
// Deployed to project cwnlofcrstwxoemzyazm as `unsplash-search` (verify_jwt: false).

const ALLOWED_ORIGINS = ['https://ramophalatse.github.io', 'http://localhost:8731'];
const API = 'https://api.unsplash.com';

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin not allowed' }, 403, origin);

  const key = Deno.env.get('UNSPLASH_ACCESS_KEY');
  if (!key) return json({ error: 'UNSPLASH_ACCESS_KEY is not set' }, 503, origin);
  const headers = { Authorization: 'Client-ID ' + key, 'Accept-Version': 'v1' };
  const url = new URL(req.url);

  const download = url.searchParams.get('download');
  if (download) {
    if (!/^https:\/\/api\.unsplash\.com\/photos\/[A-Za-z0-9_-]+\/download(\?|$)/.test(download)) {
      return json({ error: 'bad download location' }, 400, origin);
    }
    const r = await fetch(download, { headers });
    return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
  }

  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return json({ error: 'missing q' }, 400, origin);
  const page = Math.max(1, Math.min(20, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const search = new URL(API + '/search/photos');
  search.searchParams.set('query', q);
  search.searchParams.set('page', String(page));
  search.searchParams.set('per_page', '18');
  search.searchParams.set('orientation', 'landscape');
  search.searchParams.set('content_filter', 'high');
  const r = await fetch(search, { headers });
  if (!r.ok) return json({ error: 'unsplash ' + r.status }, 502, origin);
  const data = await r.json();
  const results = (data.results || []).map((p: any) => ({
    id: p.id,
    alt: p.alt_description || p.description || '',
    color: p.color,
    thumb: p.urls?.small,
    raw: p.urls?.raw,
    link: p.links?.html,
    download: p.links?.download_location,
    name: p.user?.name,
    profile: p.user?.links?.html,
  }));
  return json({ total: data.total, totalPages: data.total_pages, page, results }, 200, origin);
});
