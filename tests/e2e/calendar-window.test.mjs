// Календарь: часы 08:00–24:00 у учителя и в кабинете семьи; кнопка «месяц» в
// кабинете (телефон и компьютер); окно видимости семьи — ±4 недели от сегодня
// (с понедельника), NOW = чт 24.09.2026.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
const lastSlot = (page, root) => page.$$eval(`${root} .fc-timegrid-slot-lane[data-time]`, (els) => els.map((e) => e.dataset.time).pop());

async function openWithFamily(opts = {}) {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  const app = await openApp({ seed, ...opts });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  return app;
}
async function openCab(app, viewport) {
  const cab = await app.context.newPage();
  if (viewport) await cab.setViewportSize(viewport);
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-view"); // на телефоне — вид «день», сегодня у Теста занятий нет
  return cab;
}

test("часы календаря 08:00–24:00 у учителя и в кабинете семьи", async () => {
  const app = await openWithFamily();
  const { page } = app;
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  assert.equal(await lastSlot(page, "#fcRoot"), "23:30:00", "у учителя последняя строка — 23:30");
  const first = await page.$eval("#fcRoot .fc-timegrid-slot-lane[data-time]", (e) => e.dataset.time);
  assert.equal(first, "08:00:00");
  const cab = await openCab(app);
  await cab.waitForSelector("#cal .fc-event.own");
  assert.equal(await lastSlot(cab, "#cal"), "23:30:00", "в кабинете — тоже до полуночи");
  await app.close();
});

test("кабинет семьи: кнопка «месяц» (телефон и компьютер) открывает месяц", async () => {
  const app = await openWithFamily();
  for (const vp of [null, { width: 375, height: 800 }]) {
    const cab = await openCab(app, vp);
    const btn = cab.locator("#cal .fc-dayGridMonth-button");
    assert.equal(await btn.textContent(), "месяц", vp ? "телефон" : "компьютер");
    await btn.click();
    await cab.waitForSelector("#cal .fc-dayGridMonth-view");
    assert.ok(await cab.locator("#cal .fc-daygrid-event").count() > 0, "занятия видны в месяце");
    await cab.close();
  }
  await app.close();
});

test("окно видимости семьи: ±4 недели от сегодня, с понедельника", async () => {
  const app = await openWithFamily();
  const v = (await app.db())[`parentAccess/${PK}`];
  // сегодня чт 24.09: −28 дней = чт 27.08 → пн 24.08; пн этой недели 21.09 + 28 = пн 19.10
  assert.equal(v.busyFrom, Date.parse("2026-08-24T00:00:00+03:00"));
  assert.equal(v.busyTo, Date.parse("2026-10-19T00:00:00+03:00"));
  // в кабинете: четыре раза назад можно, дальше — нет
  const cab = await openCab(app);
  for (let i = 0; i < 4; i++) { await cab.click("#cal .fc-prev-button"); await cab.waitForTimeout(80); }
  assert.match(await cab.textContent("#cal .fc-toolbar-title"), /24/);
  assert.equal(await cab.isDisabled("#cal .fc-prev-button"), true, "раньше чем 4 недели назад — нельзя");
  await app.close();
});
