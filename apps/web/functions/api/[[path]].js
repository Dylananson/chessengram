/**
 * Same-origin API proxy for the deployed PWA (ONL-021).
 *
 * Why this exists: the app is served from `<project>.pages.dev` and the sync API
 * lives on `<worker>.<account>.workers.dev`. Those are different *sites*, so the
 * BFF session cookie (`HttpOnly; Secure; SameSite=Lax`) is **not** sent on the
 * app's `fetch` calls — `SameSite=Lax` only rides along on top-level
 * navigations. The result is a 401 on the first session-authenticated call, which
 * is exactly what the Vite dev proxy avoids locally (see `apps/web/vite.config.ts`).
 *
 * So the production deploy gets the same treatment: the client talks to `/api/…`
 * on its own origin, this Function forwards to the Worker, and the session cookie
 * becomes first-party (set for the Pages origin by the proxied response).
 *
 * `_routes.json` in the build output limits Function invocation to `/api/*`, so
 * static assets stay on the unlimited/free static path.
 *
 * Config: `SYNC_API_ORIGIN` (Pages project env var, set by Terraform) is the
 * Worker base URL. It is the only input; nothing is hard-coded.
 */

/** Headers the proxy must not forward verbatim (the runtime owns them). */
const REQUEST_HEADERS_TO_DROP = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
/** Response headers that describe a body we may be re-streaming. */
const RESPONSE_HEADERS_TO_DROP = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

function jsonError(status, error, message) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** `/api/devices/abc?x=1` -> `{ suffix: 'devices/abc', search: '?x=1' }`. */
function splitApiPath(pathname) {
  const suffix = pathname.replace(/^\/api\/?/, '');
  return suffix;
}

export function onRequest(context) {
  const { request, env } = context;
  const configured = env && typeof env.SYNC_API_ORIGIN === 'string' ? env.SYNC_API_ORIGIN.trim() : '';
  if (configured === '') {
    return jsonError(503, 'proxy_unconfigured', 'SYNC_API_ORIGIN is not set for this deployment');
  }
  const origin = configured.replace(/\/+$/, '');

  const url = new URL(request.url);
  const target = `${origin}/${splitApiPath(url.pathname)}${url.search}`;

  const headers = new Headers(request.headers);
  for (const name of REQUEST_HEADERS_TO_DROP) headers.delete(name);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  // `context.fetch` is a test seam; in a Pages Function this is the global fetch.
  const doFetch = typeof context.fetch === 'function' ? context.fetch : fetch;

  return Promise.resolve(doFetch(target, init)).then((response) => {
    const outHeaders = new Headers(response.headers);
    for (const name of RESPONSE_HEADERS_TO_DROP) outHeaders.delete(name);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  });
}
