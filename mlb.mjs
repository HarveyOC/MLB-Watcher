// Optional CORS proxy. The MLB Stats API supports CORS for normal browser
// requests, so this is rarely needed. Enable by setting USE_PROXY = true
// in app.js. Hits /.netlify/functions/mlb?path=/v1/schedule?...
//
// (Netlify Functions do not need a build step — Netlify auto-bundles them.)

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) {
    return new Response(JSON.stringify({ error: 'missing path' }), {
      status: 400, headers: { 'content-type': 'application/json' }
    });
  }
  const target = `https://statsapi.mlb.com/api${path.startsWith('/') ? '' : '/'}${path}`;
  try {
    const upstream = await fetch(target, {
      headers: { 'accept': 'application/json' }
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { 'content-type': 'application/json' }
    });
  }
};

export const config = { path: '/api/mlb' };
