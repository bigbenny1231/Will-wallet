// Offline shell for /pulse. Navigations: network first, cached shell when offline.
// Hashed build assets: cache first. Cross-origin requests (NEAR RPC) are never touched.
const CACHE = "dmw-pulse-v1";
const SHELL = ["/pulse", "/manifest.webmanifest", "/icons/seal-192.png", "/icons/seal-512.png", "/icons/seal.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname.startsWith("/pulse")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/pulse", copy));
          }
          return res;
        })
        .catch(() => caches.match("/pulse").then((r) => r || caches.match("/"))),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
