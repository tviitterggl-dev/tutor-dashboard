// sw.js: нажатие на уведомление открывает именно свой кабинет (ключ — во
// фрагменте #p=/#s=), даже если на устройстве открыты кабинеты и родителя, и ученика.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SCOPE = "https://example.org/tutor/";
function loadSw(windows) {
  const listeners = {};
  const calls = [];
  const clients = windows.map((url) => ({ url, focus: async () => { calls.push(["focus", url]); } }));
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    registration: { scope: SCOPE, showNotification: async () => {} },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => { calls.push(["open", url]); },
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../sw.js", import.meta.url), "utf8"), { self, caches: {}, fetch: () => {}, URL, Response: class {}, console });
  return {
    calls,
    async click(url) {
      let done;
      listeners.notificationclick({ notification: { data: { url }, close() {} }, waitUntil: (p) => { done = p; } });
      await done;
    },
  };
}
const P = `${SCOPE}cabinet.html#p=parent_key_000000000000000000001`;
const S = `${SCOPE}cabinet.html#s=student_key_00000000000000000002`;

test("уведомление родителя при открытых кабинетах ученика и родителя — фокус на родительском", async () => {
  const sw = loadSw([S, P]);
  await sw.click(P);
  assert.deepEqual(sw.calls, [["focus", P]]);
});

test("открыт только чужой кабинет (ученика) — не трогаем его, открываем свой в новом окне", async () => {
  const sw = loadSw([S]);
  await sw.click(P);
  assert.deepEqual(sw.calls, [["open", P]]);
});

// Свои файлы — «сначала сеть», но мимо HTTP-кэша браузера (GitHub Pages
// разрешает держать их 10 минут): иначе после публикации кабинет ещё долго
// показывал старую страницу. no-cache — условный запрос: не изменилось — 304.
test("свои страницы и стили — свежие с сайта (cache: no-cache), библиотеки CDN — из кэша", async () => {
  const listeners = {};
  const fetched = [];
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, location: { origin: "https://example.org" }, registration: { scope: SCOPE }, clients: {}, skipWaiting: () => {} };
  const fetchStub = async (input, init) => { fetched.push({ url: typeof input === "string" ? input : input.url, cache: init && init.cache }); return { ok: true, clone() { return this; } }; };
  const caches = { open: async () => ({ put: async () => {} }), match: async () => undefined };
  vm.runInNewContext(fs.readFileSync(new URL("../../sw.js", import.meta.url), "utf8"), { self, caches, fetch: fetchStub, URL, Response: class {}, console });
  const run = async (url, mode = "no-cors") => { let p; listeners.fetch({ request: { method: "GET", url, mode }, respondWith: (x) => { p = x; } }); await p; };
  await run(`${SCOPE}index.html`, "navigate");
  await run(`${SCOPE}design.css`);
  assert.deepEqual(fetched.map((f) => f.cache), ["no-cache", "no-cache"]);
});
