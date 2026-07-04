const CACHE_NAME = "tennis-edge-v10";
const STATIC_ASSETS = [
  ".",
  "index.html",
  "styles.css?v=20260704",
  "app.js?v=20260704",
  "manifest.webmanifest",
  "icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isLocalAppRequest = url.origin === self.location.origin;
  const isLiveDataRequest = isLocalAppRequest && (
    url.pathname.endsWith(".json") ||
    url.pathname.startsWith("/api/")
  );

  if (isLiveDataRequest) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isLocalAppRequest && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
