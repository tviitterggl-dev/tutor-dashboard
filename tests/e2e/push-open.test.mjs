// Нажатие на пуш с привязкой к занятию открывает карточку этого занятия.
// Ссылка пуша — index.html?lesson=<id> (учитель) или
// cabinet.html?lesson=<id>#p=<ключ> (семья). Если кабинет уже открыт, sw.js
// не открывает новую вкладку, а шлёт ей сообщение { type: "open-lesson" } —
// здесь оно имитируется событием на navigator.serviceWorker (сама логика
// sw.js — в tests/notifier/sw.test.mjs). Занятия нет — просто кабинет.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const L = "serA_20260925T070000Z"; // «Тест 7 класс 6/8», пт 25.09 10:00
const L2 = "serA_20260928T070000Z"; // 7/8, пн 28.09

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
const swMessage = (page, lessonId) => page.evaluate((id) => {
  navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "open-lesson", lessonId: id } }));
}, lessonId);
const teacherModalLesson = (page) => page.evaluate(() => (document.getElementById("modalBack").style.display !== "none" ? modalLessonId : null));

test("учитель: ссылка из пуша (?lesson=) открывает окно занятия после загрузки, адрес очищается", async () => {
  const dialogs = [];
  const app = await openApp({ path: `/index.html?lesson=${L}`, onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  await page.waitForFunction((id) => document.getElementById("modalBack").style.display !== "none" && modalLessonId === id, L);
  assert.match(await page.textContent("#modal"), /Тест/);
  assert.equal(new URL(page.url()).search, "", "?lesson= убран — обновление страницы не откроет окно снова");
  // кабинет под окном загружен как обычно
  await page.click("#modal .modal-x");
  await page.waitForSelector("#lessonsList .lesson");
  assert.deepEqual(dialogs, []);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("учитель: кабинет уже открыт — сообщение от sw.js открывает карточку без перезагрузки", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.evaluate(() => { window.__noReload = 1; });
  await swMessage(page, L2);
  await waitFor(async () => (await teacherModalLesson(page)) === L2, "окно занятия L2");
  assert.equal(await page.evaluate(() => window.__noReload), 1, "страница не перезагружалась");
  // второе уведомление — другое занятие в уже открытом окне
  await swMessage(page, L);
  await waitFor(async () => (await teacherModalLesson(page)) === L, "окно занятия L");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("учитель: занятия уже нет (удалено) — кабинет открывается как обычно, без окна и без ошибки", async () => {
  const dialogs = [];
  const seed = defaultSeed();
  const app = await openApp({ seed, path: "/index.html?lesson=l_deleted_000000", onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await swMessage(page, "l_deleted_111111");
  await page.waitForTimeout(800);
  assert.equal(await teacherModalLesson(page), null, "окно не открылось");
  assert.equal(new URL(page.url()).search, "");
  assert.deepEqual(dialogs, [], "без «Занятие не найдено»");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("учитель: перенесённое занятие — открывается новое время (куда перенесли)", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const newId = await page.evaluate(async (id) => {
    const l = await window.TutorFB.getLesson(id);
    return rescheduleLesson(l, l.startMs + 3600000, l.endMs + 3600000);
  }, L2);
  await swMessage(page, L2);
  await waitFor(async () => (await teacherModalLesson(page)) === newId, "окно нового занятия");
  assert.deepEqual(app.errors, []);
  await app.close();
});

// ---- кабинет семьи ----
async function familyApp() {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  const app = await openApp({ seed });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  app.base = app.page.url().replace(/\/index\.html.*$/, "");
  await app.page.goto(app.base + "/cabinet.html"); // учитель «не в сети»
  return app;
}
async function openCab(app, url, viewport) {
  const cab = await app.context.newPage();
  if (viewport) await cab.setViewportSize(viewport);
  cab.errors = []; cab.dialogs = [];
  cab.on("pageerror", (e) => cab.errors.push(String(e)));
  cab.on("dialog", async (d) => { cab.dialogs.push(d.message()); await d.accept(); });
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + url);
  return cab;
}
const cabModalText = (cab) => cab.evaluate(() => (document.getElementById("modalBack").style.display !== "none" ? document.getElementById("modal").textContent : null));

test("семья: ссылка из пуша (?lesson=…#p=…) открывает карточку занятия (компьютер и телефон)", async () => {
  const app = await familyApp();
  for (const viewport of [null, { width: 390, height: 844 }]) {
    const cab = await openCab(app, `/cabinet.html?lesson=${L}#p=${PK}`, viewport);
    await cab.waitForFunction(() => document.getElementById("modalBack").style.display !== "none");
    assert.match(await cabModalText(cab), /25 сентября/);
    const u = new URL(cab.url());
    assert.equal(u.search, "", "?lesson= убран");
    assert.equal(u.hash, `#p=${PK}`, "ключ кабинета в адресе остался");
    await cab.click("#modal .modal-x");
    await cab.waitForSelector("#pane-lessons .lesson");
    assert.deepEqual(cab.errors, []);
    await cab.close();
  }
  await app.close();
});

test("семья: кабинет уже открыт — сообщение от sw.js открывает карточку без перезагрузки; занятия нет — ничего", async () => {
  const app = await familyApp();
  const cab = await openCab(app, `/cabinet.html#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.evaluate(() => { window.__noReload = 1; });
  await swMessage(cab, L2);
  await waitFor(async () => /28 сентября/.test((await cabModalText(cab)) || ""), "карточка 28.09");
  assert.equal(await cab.evaluate(() => window.__noReload), 1);
  await cab.click("#modal .modal-x");
  // занятия нет в витрине (удалено / другое) — кабинет как был, без окна и ошибок
  await swMessage(cab, "l_deleted_000000");
  await cab.waitForTimeout(600);
  assert.equal(await cabModalText(cab), null);
  assert.deepEqual(cab.dialogs, []);
  assert.deepEqual(cab.errors, []);
  await cab.close();
  await app.close();
});

test("семья: ссылка на занятие, которого нет, — обычный кабинет без ошибки", async () => {
  const app = await familyApp();
  const cab = await openCab(app, `/cabinet.html?lesson=l_deleted_000000#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.waitForTimeout(600);
  assert.equal(await cabModalText(cab), null);
  assert.equal(new URL(cab.url()).search, "");
  assert.deepEqual(cab.dialogs, []);
  assert.deepEqual(cab.errors, []);
  await cab.close();
  await app.close();
});

test("настоящий service worker: сообщение из sw.js доходит до открытого кабинета учителя", async () => {
  const app = await openApp({ serviceWorkers: "allow", persistent: { channel: "chromium" } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
  await page.waitForSelector("#lessonsList .lesson");
  const sw = app.context.serviceWorkers()[0] || await app.context.waitForEvent("serviceworker");
  // то же, что делает notificationclick для уже открытой вкладки
  await sw.evaluate(async (id) => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: "open-lesson", lessonId: id }));
  }, L2);
  await waitFor(async () => (await teacherModalLesson(page)) === L2, "окно занятия по сообщению от SW");
  assert.deepEqual(app.errors, []);
  await app.close();
});
