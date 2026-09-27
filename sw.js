// Service worker сайта. Нужен, чтобы Chrome на Android сам предлагал
// «Установить приложение», чтобы кабинеты открывались без сети и чтобы
// принимать пуш-уведомления (Firebase Cloud Messaging).
//
// Свои файлы (страницы, стили, скрипты, значки) — «сначала сеть»: берём
// свежую версию, а сохранённую отдаём, только если сети нет. Поэтому
// обновления приходят сразу, а офлайн кабинет всё равно открывается.
// Запрос — мимо HTTP-кэша браузера (cache: "no-cache"): GitHub Pages
// разрешает держать файлы 10 минут, и после публикации кабинет ещё показывал
// старую страницу. no-cache — условный запрос: не изменилось — короткий 304.
// Библиотеки с CDN (Firebase SDK, FullCalendar, шрифты) — адреса с номером
// версии, не меняются: «сначала кэш». Данные (Firestore) SW не трогает —
// их кэширует сам Firestore (IndexedDB), а кабинет родителя ещё и хранит
// последнюю витрину в localStorage.
const CACHE = "tutor-shell-v11";
const SHELL = ["./", "./index.html", "./cabinet.html", "./design.css", "./theme.js", "./notify-core.js", "./tab-order.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png"];
const CDN = [
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js",
  "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.19/index.global.min.js",
  "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.19/locales/ru.global.min.js",
];
// что с чужих адресов можно хранить: только неизменяемые библиотеки и шрифты
function isCdn(url) {
  return (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))
    || url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com"
    || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([
    c.addAll(SHELL).catch(() => {}),
    ...CDN.map((u) => c.add(u).catch(() => {})), // по одному: сбой одного не мешает остальным
  ])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const offlineResponse = () => new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (!isCdn(url)) return; // Firebase API, Cloudinary и прочее — мимо
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    })).catch(() => offlineResponse()));
    return;
  }
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      // страница без сети: кабинет родителя/ученика — cabinet.html, иначе — кабинет учителя
      .then((hit) => hit || (req.mode === "navigate" ? caches.match(/cabinet\.html$/.test(url.pathname) ? "./cabinet.html" : "./index.html") : undefined))
      .then((hit) => hit || offlineResponse()))
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
    // Ключ кабинета — во фрагменте (#p=… / #s=…), поэтому сравниваем адрес
    // целиком: на одном устройстве могут быть открыты кабинеты и родителя, и
    // ученика — уведомление должно открыть именно свой. Нет такого окна —
    // открываем новое (чужой открытый кабинет не трогаем).
    const same = list.find((c) => c.url === url);
    if (same && "focus" in same) return same.focus();
    return self.clients.openWindow(url);
  }));
});
