// Офлайн: кабинеты открываются без сети (service worker + сохранённые данные),
// сверху плашка «офлайн», а любые изменения честно говорят, что нужен интернет.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const statePath = `teacherSpaces/${T}/state/main`;

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("Не дождались: " + what);
}
function seedWithParent() {
  const s = defaultSeed();
  s[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  return s;
}

test("кабинет родителя без сети: открывается со значка (service worker), показывает последние данные с плашкой; «Оплачено» и пояснение — «нужен интернет»", async () => {
  const app = await openApp({ seed: seedWithParent(), serviceWorkers: "allow", persistent: { channel: "chromium" } });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  const cab = await app.context.newPage();
  const errors = [];
  cab.on("pageerror", (e) => errors.push(String(e)));
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(base + "/cabinet.html#p=" + PK);
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.equal(await cab.isVisible("#offlineBar"), false, "онлайн — плашки нет");
  // service worker установлен и управляет страницей → файлы и библиотеки в кэше
  await cab.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await cab.reload(); await cab.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
  await cab.reload();
  await cab.waitForSelector("#pane-lessons .lesson");
  const before = await cab.innerText("#pane-lessons");

  // без сети; и в «базе» на устройстве ничего нет — остаётся только сохранённое кабинетом
  await app.context.setOffline(true);
  await cab.addInitScript(() => { window.__FAKE_OFFLINE_NOCACHE = true; });
  await cab.reload();
  await cab.waitForSelector("#pane-lessons .lesson", { timeout: 15000 });
  assert.equal(await cab.innerText("#pane-lessons"), before, "то же расписание, что было загружено");
  assert.match(await cab.innerText("#offlineBar"), /Офлайн — показаны последние загруженные данные.*могут быть неактуальными/s);
  assert.doesNotMatch(await cab.innerText("#root, #pane-lessons"), /недействительна|отозван/, "нет сети ≠ доступ отозван");

  // «Оплачено» — сообщение, а не тишина
  const dialogs = [];
  cab.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  const paidBtn = cab.locator("#pane-lessons [data-paid]").first();
  assert.ok(await paidBtn.count(), "кнопка «Оплачено» есть");
  await paidBtn.click();
  await cab.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(dialogs.some((m) => /Нет подключения к интернету/.test(m)), JSON.stringify(dialogs));
  // пояснение к занятию
  const planned = cab.locator("#pane-lessons .lesson.planned, #pane-lessons .lesson").first();
  await planned.click();
  await cab.waitForSelector("#mNote");
  await cab.fill("#mNote", "Без сети");
  await cab.click("#mNoteSave");
  await cab.waitForFunction(() => /Нет подключения к интернету/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  assert.ok(!Object.entries(db).some(([p, d]) => p.startsWith("channels/") && (d.type === "paid" || d.comment === "Без сети")), "в базу ничего не ушло");

  // сеть вернулась — плашка пропадает, данные свежие
  await app.context.setOffline(false);
  await cab.evaluate(() => { window.__FAKE_OFFLINE_NOCACHE = false; });
  await cab.waitForFunction(() => document.querySelector("#offlineBar").hidden, null, { timeout: 8000 });
  assert.deepEqual(errors, []);
  await app.close();
});

test("кабинет родителя без сети и без сохранённых данных: понятное сообщение, а не «ссылка недействительна»", async () => {
  const app = await openApp({ seed: seedWithParent() });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`], "витрина");
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  const cab = await app.context.newPage();
  await cab.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", { get: () => false, configurable: true });
    window.__FAKE_OFFLINE_NOCACHE = true;
  });
  await cab.goto(base + "/cabinet.html#p=" + PK);
  await cab.waitForFunction(() => /Нет подключения к интернету/.test(document.querySelector("#root").textContent));
  assert.doesNotMatch(await cab.textContent("#root"), /недействительна/);
  // ключ не забыт — при появлении сети кабинет откроется
  assert.ok((await cab.evaluate(() => localStorage.getItem("cabinetKeys") || "")).includes(PK));
  await app.close();
});

test("кабинет учителя без сети: плашка, данные на месте, «Провёл»/сумма/перенос/шаблон — «нужен интернет», в базе без изменений", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  assert.equal(await page.isVisible("#offlineBar"), false);
  const dbBefore = JSON.stringify((await app.db())[statePath].marks);
  await app.context.setOffline(true);
  await page.waitForSelector("#offlineBar", { state: "visible" });
  assert.match(await page.innerText("#offlineBar"), /Офлайн — показаны последние загруженные данные/);
  // «Провёл» в списке
  const btn = page.locator("#lessonsList .mark-btn:not([disabled])").first();
  const label = await btn.textContent();
  await btn.click();
  await page.waitForSelector("#offlineToast", { state: "visible" });
  assert.match(await page.textContent("#offlineToast"), /Нет подключения к интернету — изменение не сохранено/);
  assert.equal(await btn.textContent(), label, "на экране отметка не поменялась");
  // окно занятия: «Сохранить» и прочее
  await page.locator("#lessonsList .lesson").first().click();
  await page.waitForSelector("#mClose");
  await page.evaluate(() => { document.querySelector("#offlineToast").hidden = true; });
  await page.click("#mPaid");
  await page.waitForSelector("#offlineToast", { state: "visible" });
  await page.click("#mClose");
  // шаблон
  await page.click('.tab[data-tab="settings"]');
  await page.click("#tplAdd");
  await page.fill("#tplText", "Офлайн-шаблон");
  await page.evaluate(() => { document.querySelector("#offlineToast").hidden = true; });
  await page.click("#tplSave");
  await page.waitForSelector("#offlineToast", { state: "visible" });
  // вкладки и просмотр работают
  await page.click('.tab[data-tab="students"]');
  await page.waitForSelector(".pkg-card");
  const after = await app.db();
  assert.equal(JSON.stringify(after[statePath].marks), dbBefore, "отметки в базе не изменились");
  assert.ok(!JSON.stringify(after[statePath].msgTemplates || {}).includes("Офлайн-шаблон"));
  // сеть вернулась — плашка ушла, отметка работает
  await app.context.setOffline(false);
  await page.waitForSelector("#offlineBar", { state: "hidden" });
  assert.deepEqual(app.errors.filter((e) => !/offline/i.test(e)), []);
  await app.close();
});

test("кабинет учителя открывается без сети после перезагрузки (service worker) — с плашкой и последними данными", async () => {
  const app = await openApp({ serviceWorkers: "allow", persistent: { channel: "chromium" } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson");
  await app.context.setOffline(true);
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson", { timeout: 15000 });
  await page.waitForSelector("#offlineBar", { state: "visible" });
  assert.match(await page.title(), /Тьютор Онлайн/);
  await app.context.setOffline(false);
  await app.close();
});
