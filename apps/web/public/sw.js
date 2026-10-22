/**
 * ChessEngram service worker (PB6 / T11 offline startup, APP-001 offline install).
 *
 * Zero-dependency, hand-written. It keeps the app shell AND the bundled puzzle
 * content available offline after the first successful load, so the app can be
 * installed to a phone home screen and played with no network at all:
 *   - install precaches the shell, icons, manifest and every bundled pack
 *     (each entry individually, so one missing pack cannot break the install)
 *   - navigations: network-first, falling back to the cached index.html
 *   - other same-origin GETs (hashed JS/CSS, pack JSONL, icons): cache-first,
 *     filling the cache from the network
 *   - `/sync-config.json`: network-first with a cache fallback (runtime config
 *     is picked up as soon as the device is online)
 *   - `/api/*`: **network-only** — never cached and never served from cache.
 *     Sync requests are private, user-specific and must not become stale.
 *
 * Cache versioning rule (REL-001): bump CACHE_VERSION on every release that
 * changes the shell, the precache list or hashed bundles. The old versioned
 * cache is deleted on activate, so only one `chessengram-shell-*` cache ever
 * survives. Training data lives in IndexedDB (never in this cache), so
 * activation never destroys user data. smoke.mjs asserts the single-version
 * invariant and the old -> new handover.
 */

const CACHE_VERSION = 'chessengram-shell-v10';

/** Everything required to boot and train offline. */
const CORE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/data/puzzles/lichess-900-1099-v1/pack.jsonl',
  '/data/puzzles/lichess-bands-v1/pack.jsonl',
  '/data/puzzles/lichess-bands-v1/bands.json',
];

/** Hashed entry assets referenced by the shell (Vite rewrites these per build). */
async function discoverShellAssets(cache) {
  try {
    const response = await fetch(new Request('/index.html', { cache: 'reload' }));
    if (!response.ok) return;
    const html = await response.text();
    const matches = html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g);
    await Promise.all(
      [...matches].map(async ([, url]) => {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          /* a stale reference must not break the install */
        }
      }),
    );
  } catch {
    /* offline install; the fetch handler will fill the bundle in later */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Fetch each entry from the network (reload) so a release cannot
      // repopulate the cache from a stale HTTP cache. Optional data files are
      // tolerated: the shell must still install if one is unavailable.
      await Promise.all(
        CORE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            /* keep installing; the fetch handler will fill it in later */
          }
        }),
      );
      // Cache the hashed JS/CSS too: on the very first load those requests
      // raced ahead of this worker, so without this the app would only be
      // offline-ready after a second visit.
      await discoverShellAssets(cache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sync API: network-only. Never cache a response and never serve a cached
  // one (letting the browser handle the request means it always hits the
  // network). This applies whether or not sync is currently enabled.
  if (url.pathname.startsWith('/api/')) return;

  // Runtime sync config: network-first so a fresh deploy is picked up, with the
  // last successfully fetched copy as the offline fallback.
  if (url.pathname === '/sync-config.json') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('/sync-config.json', copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match('/sync-config.json')
            .then(
              (cached) =>
                cached ||
                new Response('{}', {
                  status: 503,
                  headers: { 'content-type': 'application/json' },
                }),
            ),
        ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/')),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
