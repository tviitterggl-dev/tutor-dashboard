// Service worker кабинета учителя. Нужен, чтобы Chrome на Android сам
// предлагал «Установить приложение», и чтобы оболочка открывалась без сети.
// Стратегия «сначала сеть»: всегда берём свежую версию с сайта, а сохранённую
// копию отдаём, только если сети нет. Поэтому обновления приходят сразу.
// Чужие адреса (Firebase, CDN, Cloudinary) не трогаем вообще.
const CACHE = "tutor-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      .then((hit) => hit || new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })))
  );
});
