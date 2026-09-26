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
