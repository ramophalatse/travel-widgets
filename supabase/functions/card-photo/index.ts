// Card photo uploads for the travel-widgets itinerary pages (ramophalatse.github.io).
// The page resizes a photo to at most 1600 px and posts the JPEG bytes here; the
// function stores it in the public `travel-card-photos` bucket with the service
// role and returns its public URL. The page then saves that URL as an ordinary
// edit, so the edits table carries a short URL rather than the image itself.
// The bucket has no storage policies, so nothing but this function can write it.
// verify_jwt is off because the pages call with a publishable key, which is not
// a JWT. Requests from other origins are refused, and only JPEGs up to 2 MB for
// a well-formed row key are accepted.
//   POST ?page=<page id>&row=<row key>   body: image/jpeg bytes  ->  { url }
// Deployed to project cwnlofcrstwxoemzyazm as `card-photo` (verify_jwt: false).

const ALLOWED_ORIGINS = ['https://ramophalatse.github.io', 'http://localhost:8731'];
const BUCKET = 'travel-card-photos';
const MAX_BYTES = 2 * 1024 * 1024;

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin not allowed' }, 403, origin);

  const url = new URL(req.url);
  const page = url.searchParams.get('page') || '';
  const row = url.searchParams.get('row') || '';
  if (!/^[a-z0-9-]{1,40}$/.test(page)) return json({ error: 'bad page' }, 400, origin);
  if (!/^d\d{1,2}:[a-z0-9-]{1,48}(~\d{1,2})?$/.test(row)) return json({ error: 'bad row key' }, 400, origin);
  if ((req.headers.get('content-type') || '') !== 'image/jpeg') return json({ error: 'jpeg only' }, 415, origin);

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > MAX_BYTES) return json({ error: 'bad size' }, 413, origin);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: 'not a jpeg' }, 415, origin);

  const base = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !service) return json({ error: 'storage not configured' }, 503, origin);

  // A fresh name per upload, so a replaced photo never serves from a stale cache.
  const path = page + '/' + row.replace(/[:~]/g, '_') + '-' + Date.now().toString(36) + '.jpg';
  const put = await fetch(base + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + service,
      apikey: service,
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'x-upsert': 'false',
    },
    body: bytes,
  });
  if (!put.ok) return json({ error: 'upload failed ' + put.status }, 502, origin);
  return json({ url: base + '/storage/v1/object/public/' + BUCKET + '/' + path }, 200, origin);
});
