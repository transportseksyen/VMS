const CACHE_NAME = "fms-static-shell-v1";
const BASE_PATH = new URL("./", self.location.href).pathname;
const SHELL_ASSETS = [
  BASE_PATH,
  BASE_PATH + "manifest.webmanifest",
  BASE_PATH + "fms-icon.svg",
  BASE_PATH + "fms-maskable-icon.svg"
];
const NEVER_CACHE = ["/rest/v1/", "/functions/v1/", "/auth/v1/", "/storage/v1/", "/realtime/v1/"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("fms-static-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.some(path => url.pathname.includes(path))) return;
  if (!url.pathname.startsWith(BASE_PATH)) return;

  if (url.pathname.includes("/assets/")) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }).catch(() => new Response("This FMS asset is not available offline.", { status: 503 })));
    return;
  }

  if (request.mode === "navigate" || SHELL_ASSETS.includes(url.pathname) || url.pathname.endsWith("/index.html")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
        return response;
      } catch {
        return await cache.match(request) || await cache.match(BASE_PATH) ||
          new Response("FMS is offline. Reconnect to the internet to access secure operational data.", { status: 503 });
      }
    })());
  }
});
