// Service worker сайта. Нужен, чтобы Chrome на Android сам предлагал
// «Установить приложение», чтобы оболочка открывалась без сети и чтобы
// принимать пуш-уведомления (Firebase Cloud Messaging) в кабинетах
// родителя/ученика.
// Стратегия «сначала сеть»: всегда берём свежую версию с сайта, а сохранённую
// копию отдаём, только если сети нет. Поэтому обновления приходят сразу.
// Чужие адреса (Firebase, CDN, Cloudinary) не трогаем вообще.
const CACHE = "tutor-shell-v5";
const SHELL = ["./", "./index.html", "./design.css", "./theme.js", "./notify-core.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

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

// Пуш от фоновой рассылки (notifier/): FCM присылает { data: { title, body,
// url, tag } } — показываем уведомление сами (без библиотеки Firebase в SW).
self.addEventListener("push", (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (_) { payload = { data: { body: e.data ? e.data.text() : "" } }; }
  const d = payload.data || {};
  const n = payload.notification || {};
  const title = d.title || n.title || "Тьютор Онлайн";
  const options = {
    body: d.body || n.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./cabinet.html" },
  };
  if (d.tag) options.tag = d.tag;
  e.waitUntil(self.registration.showNotification(title, options));
});

// Нажатие на уведомление — открыть (или показать уже открытый) кабинет.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./cabinet.html", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const same = list.find((c) => c.url.split("#")[0] === url.split("#")[0]);
    if (same && "focus" in same) return same.focus();
    return self.clients.openWindow(url);
  }));
});
