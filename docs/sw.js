const prefix = "archivus-shell-";
const cacheName = prefix + "17";
const files = ["./", "./style.css", "./app.js", "./config.js", "./manifest.webmanifest", "./brand-w.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) =>
    cache.addAll(files.map((file) => new Request(file, { cache: "reload" })))
  ).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key.startsWith(prefix) && key !== cacheName).map((key) => caches.delete(key)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request, { cache: "no-cache" }).catch(async () =>
      (await caches.open(cacheName)).match("./")
    ));
    return;
  }
  const asset = files.find((file) => new URL(file, scope).pathname === url.pathname);
  if (asset) event.respondWith(fetch(request).catch(async () => (await caches.open(cacheName)).match(asset)));
});
