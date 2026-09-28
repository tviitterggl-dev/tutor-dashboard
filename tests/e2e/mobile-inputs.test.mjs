// iPhone: поле ввода со шрифтом меньше 16px при нажатии увеличивает страницу
// (Safari), и она остаётся увеличенной. На телефоне все видимые поля — ≥ 16px:
// у учителя (вкладки, окно занятия, «+ Занятие») и в кабинете семьи (лента,
// «Предложить время», окно занятия с формой отмены). На компьютере — как было.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { devices } from "playwright";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const phone = devices["iPhone 13"];
const small = (page) => page.evaluate(() => [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), select, textarea")]
  .filter((e) => e.offsetParent).map((e) => `${e.id || e.className || e.name}=${getComputedStyle(e).fontSize}`).filter((x) => parseFloat(x.split("=")[1]) < 16));

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}

test("телефон: во всех полях ввода шрифт не меньше 16px (Safari не увеличивает страницу)", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  const app = await openApp({ seed, viewport: phone.viewport, userAgent: phone.userAgent, hasTouch: true, isMobile: true });
  const p = app.page;
  await p.waitForSelector("#lessonsList .lesson");
  const found = {};
  const note = async (where, page) => { const s = await small(page); if (s.length) found[where] = s; };
  for (const tab of ["lessons", "calendar", "notify", "stats", "students", "schedule", "settings"]) {
    await p.click(`.tab[data-tab="${tab}"]`); await p.waitForTimeout(500); await note("учитель/" + tab, p);
  }
  await p.click('.tab[data-tab="students"]');
  await p.locator(".pkg-edit-btn").first().click(); await note("учитель/пакет «Исправить»", p);
  await p.click('.tab[data-tab="lessons"]');
  await p.locator("#lessonsList .lesson").first().click(); await p.waitForSelector("#modalBack", { state: "visible" }); await note("учитель/окно занятия", p);
  await p.keyboard.press("Escape");
  await p.click('.tab[data-tab="calendar"]'); await p.click("#fcAddBtn"); await p.waitForSelector("#mStudent"); await note("учитель/+ Занятие", p);
  await p.keyboard.press("Escape");
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const base = p.url().replace(/\/index\.html.*$/, "");
  await p.goto(base + "/cabinet.html");
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(base + "/cabinet.html#p=" + PK);
  await cab.waitForSelector("#bookBtn"); await note("семья/лента", cab);
  await cab.tap("#bookBtn"); await cab.waitForSelector("#modalBack", { state: "visible" }); await note("семья/Предложить время", cab);
  await cab.keyboard.press("Escape");
  await cab.locator("#pane-lessons .lesson", { hasText: "7/8" }).first().tap();
  await cab.waitForSelector("#mCancel"); await cab.tap("#mCancel"); await note("семья/окно занятия (отмена)", cab);
  await cab.keyboard.press("Escape");
  await cab.tap('.ctab[data-ctab="hw"]'); await cab.waitForTimeout(400); await note("семья/ДЗ", cab);
  assert.deepEqual(found, {});
  await app.close();
});
