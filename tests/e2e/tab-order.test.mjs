// Порядок вкладок и «Настройки» — у учителя (state/main.tabOrder), у родителя
// и ученика (accessPrefs/{ключ}); перетаскивание и кнопки ↑↓; одинаково на
// всех устройствах аккаунта (ссылки).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const SK = "student_key_test_student_000000002";
const statePath = `teacherSpaces/${T}/state/main`;
async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("Не дождались: " + what);
}
const tabs = (page, sel, attr) => page.$$eval(sel, (els, a) => els.map((e) => e.getAttribute(a)), attr);
// перетащить строку за ручку ⠿ мышью/пальцем (pointer events)
async function dragRow(page, from, to) {
  const h = page.locator(`.to-item[data-to="${from}"] .to-handle`);
  const t = page.locator(`.to-item[data-to="${to}"]`);
  const hb = await h.boundingBox(), tb = await t.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + ((tb.y + 2 - hb.y) * i) / 6);
  await page.mouse.up();
}

test("учитель: «Настройки» (бывшее «Ещё») — туда переехали аккаунт, уведомления мне, шаблоны, статус пушей; порядок вкладок: ↑↓ и перетаскивание, в базе, после перезагрузки и первая — главная", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const def = await tabs(page, ".tabs .tab", "data-tab");
  assert.deepEqual(def, ["lessons", "calendar", "requests", "notify", "summary", "analytics", "students", "schedule", "settings"]);
  assert.equal(await page.textContent('.tab[data-tab="settings"]'), "Настройки");
  await page.click('.tab[data-tab="settings"]');
  for (const id of ["#tabOrderEditor", "#accountSignOutBtn", "#tpCard", "#tplCard", "#nfPushStatus", "#backupJsonBtn", "#themeToggle"]) {
    assert.equal(await page.locator(`#view-settings ${id}`).count(), 1, id + " — в «Настройках»");
  }
  assert.equal(await page.locator("#view-notify #tplCard, #view-notify #tpCard, #view-students #accountSignOutBtn").count(), 0, "не дублируется");
  assert.equal(await page.locator("#view-notify #nwTpl").count(), 1, "выбор шаблона — остался в форме отправки");

  // кнопки: «Аналитика» ↑ ×5 → на первое место
  for (let i = 0; i < 5; i++) await page.click('[data-to-up="analytics"]');
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector("#tabOrderMsg").textContent));
  assert.deepEqual((await tabs(page, ".tabs .tab", "data-tab")).slice(0, 2), ["analytics", "lessons"], "полоса вкладок переставилась сразу");
  // перетаскивание: «Настройки» на место «Календаря»
  await dragRow(page, "settings", "calendar");
  await waitFor(async () => (await app.db())[statePath].tabOrder?.indexOf("settings") === 2, "порядок в базе");
  const saved = (await app.db())[statePath].tabOrder;
  assert.deepEqual(saved, ["analytics", "lessons", "settings", "calendar", "requests", "notify", "summary", "students", "schedule"]);
  assert.deepEqual(await tabs(page, ".tabs .tab", "data-tab"), saved);

  // «другое устройство»: чистое хранилище, порядок — из базы; первая вкладка открыта
  await page.evaluate(() => localStorage.removeItem("teacherTabOrder"));
  await page.reload();
  await page.waitForSelector("#view-analytics", { state: "visible" });
  assert.deepEqual(await tabs(page, ".tabs .tab", "data-tab"), saved);
  assert.equal(await page.getAttribute(".tab.active", "data-tab"), "analytics", "первая вкладка — главная");
  // по умолчанию
  await page.click('.tab[data-tab="settings"]');
  await page.click("[data-to-reset]");
  await waitFor(async () => (await app.db())[statePath].tabOrder?.[0] === "lessons", "сброс");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("родитель и ученик: вкладка «Настройки» вместо «Ещё»; свой порядок у каждой ссылки — в базе (accessPrefs), на всех устройствах; первая открывается при входе", async () => {
  const seed = defaultSeed();
  const k = (role, createdAt) => ({ role, studentId: "Тест, 7 класс", label: "", createdAt, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", 1);
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", 2);
  const app = await openApp({ seed });
  await waitFor(async () => { const db = await app.db(); return db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`]; }, "витрины");
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  const open = async (hash) => {
    const cab = await app.context.newPage();
    cab.errors = [];
    cab.on("pageerror", (e) => cab.errors.push(String(e)));
    await cab.clock.setFixedTime(new Date(NOW));
    await cab.goto(base + "/cabinet.html" + hash);
    await cab.waitForSelector("#tabs .ctab");
    return cab;
  };
  const mom = await open(`#p=${PK}`);
  await mom.waitForSelector("#pane-lessons .lesson");
  assert.deepEqual(await tabs(mom, "#tabs .ctab", "data-ctab"), ["lessons", "calendar", "hw", "requests", "settings"]);
  await mom.click('.ctab[data-ctab="settings"]');
  for (const id of ["#tabOrderEditor", "#pushCard", "#themeToggle", "#forgetBtn", "#tgLink"]) assert.equal(await mom.locator(`#pane-settings ${id}`).count(), 1, id);
  // «ДЗ» — наверх
  await mom.click('[data-to-up="hw"]');
  await mom.click('[data-to-up="hw"]');
  await mom.waitForFunction(() => /Сохранено/.test(document.querySelector("#tabOrderMsg").textContent));
  await waitFor(async () => (await app.db())[`accessPrefs/${PK}`]?.tabOrder?.[0] === "hw", "порядок в базе");
  assert.deepEqual((await app.db())[`accessPrefs/${PK}`].tabOrder, ["hw", "lessons", "calendar", "requests", "settings"]);
  // у ученика — свой, не тронут
  const kid = await open(`#s=${SK}`);
  await kid.waitForSelector("#pane-lessons .lesson");
  assert.deepEqual(await tabs(kid, "#tabs .ctab", "data-ctab"), ["lessons", "calendar", "hw", "requests", "settings"]);
  assert.equal((await app.db())[`accessPrefs/${SK}`], undefined);
  // «другое устройство» родителя: порядок с устройства стёрт — берётся из базы
  await mom.evaluate(() => localStorage.removeItem("cabinetTabOrder"));
  await mom.reload();
  await mom.waitForFunction(() => document.querySelector("#tabs .ctab").dataset.ctab === "hw");
  // на этом устройстве запомнилось — при следующем входе «ДЗ» открывается первой
  await mom.reload();
  await mom.waitForSelector("#pane-hw", { state: "visible" });
  assert.equal(await mom.getAttribute(".ctab.active", "data-ctab"), "hw");
  // перетаскивание у ученика: «Заявки» на первое место
  await kid.click('.ctab[data-ctab="settings"]');
  await dragRow(kid, "requests", "lessons");
  await waitFor(async () => (await app.db())[`accessPrefs/${SK}`]?.tabOrder?.[0] === "requests", "порядок ученика в базе");
  assert.deepEqual(mom.errors, []);
  assert.deepEqual(kid.errors, []);
  await app.close();
});
