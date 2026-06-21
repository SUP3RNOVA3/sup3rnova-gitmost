// Gitmost PWA service worker.
// Conservative strategy:
//   - Never intercept API, websocket or collaboration traffic (always network).
//   - Navigations: network-first, fall back to the cached app shell offline.
//   - Other same-origin GET assets: stale-while-revalidate.
// Bump CACHE_VERSION to invalidate stale assets on deploy.
const CACHE_VERSION = "gitmost-v1";
const APP_SHELL_URL = "/";

// Path prefixes that must always hit the network (auth/state/realtime).
const NETWORK_ONLY_PREFIXES = ["/api", "/socket.io", "/collab"];

self.addEventListener("install", (event) => {
  // Activate this worker immediately without waiting for old tabs to close.
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.add(APP_SHELL_URL))
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GET requests; everything else goes to the network.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)))
    return;

  // Navigations: network-first with an offline fallback to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          const cached = await cache.match(APP_SHELL_URL);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          // Only cache successful, same-origin (basic) responses.
          if (response && response.status === 200 && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);
      return cached || (await network) || Response.error();
    })(),
  );
});
