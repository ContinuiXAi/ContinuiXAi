const CACHE_NAME = "continuixai-ops-shell-v9";
const SHELL_ASSETS = [
  "/",
  "/login",
  "/my-work",
  "/daily-summary",
  "/team-work",
  "/store-count",
  "/store-products",
  "/store-locations",
  "/settings",
  "/offline",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const keep = new Set([CACHE_NAME]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (
    request.url.includes("/api/") ||
    request.destination === "manifest" ||
    request.destination === "image" ||
    new URL(request.url).pathname === "/apple-touch-icon.png"
  ) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => {
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("/offline");
        return Response.error();
      })),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Continuixai Ops", body: "", url: "/my-work" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* malformed payload */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/icons/icon.svg",
    data: { url: data.url || "/my-work" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/my-work";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(url) && "focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
