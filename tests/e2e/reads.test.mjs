// Экономия чтений Firestore в кабинете учителя (квота Spark — 50 000 в сутки
// на весь проект, её же тратит фоновая рассылка). Инцидент 2026-09-27:
// каждое «Провёл»/правка перечитывало всю историю занятий дважды (пакеты —
// 180 дней назад и 240 вперёд, витрины семей — 120/90 дней и ещё раз окно
// пакетов, плюс журнал заявок за год). С сотнями занятий — тысячи чтений на
// одно нажатие, лимит кончился к вечеру, рассылка упала.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed, lessonDoc } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;

// ~400 занятий: 4 в день по будням, полгода назад и два месяца вперёд
function bigSeed() {
  const seed = defaultSeed();
  const iso = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
  const base = Date.parse(NOW);
  let n = 0;
  for (let d = -170; d <= 60; d++) {
    const day = new Date(base + d * 86400000);
    if ([0, 6].includes(day.getDay())) continue;
    for (const h of [9, 11]) {
      const s = Date.parse(day.toISOString().slice(0, 10) + `T${String(h).padStart(2, "0")}:00:00+03:00`);
      const id = `bulk${n++}`;
      seed[L(id)] = Object.assign(lessonDoc({ id, summary: "Борис 8 класс", start: { dateTime: iso(s) }, end: { dateTime: iso(s + 3600000) } }), { source: "app" });
    }
  }
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  return { seed, n };
}
async function settle(page, ms = 4500) { await page.waitForTimeout(ms); } // пакеты — 0,8 с, витрины — 2,5 с после изменения

test("одно «Провёл» при большой истории — десятки чтений, а не вся история", async () => {
  const { seed, n } = bigSeed();
  assert.ok(n > 300);
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await settle(page);
  await page.evaluate(() => { window.__fakeReads = 0; });
  // три отметки подряд, как в обычный день
  for (let i = 0; i < 3; i++) {
    await page.locator("#lessonsList .lesson").nth(i).locator(".mark-btn:not([disabled])").click();
    await settle(page, 1500);
  }
  await settle(page);
  const reads = await page.evaluate(() => window.__fakeReads);
assert.ok(reads < 60, `три «Провёл» — ${reads} чтений (история: ${n} занятий)`);
  // витрина семьи при этом обновилась
  const v = (await app.db())[`parentAccess/${PK}`];
  assert.ok(v && v.generatedAt >= Date.parse(NOW));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("правка занятия → пакеты и витрины обновились без повторного чтения истории", async () => {
  const { seed } = bigSeed();
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await settle(page);
  await page.evaluate(() => { window.__fakeReads = 0; });
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс" }).first().click();
  await page.waitForSelector("#mSaveReport");
  await page.fill("#mReport", "Прошли дроби");
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /Отчёт/.test(document.querySelector("#mMsg").textContent));
  await page.click("#mClose");
  await settle(page);
  const reads = await page.evaluate(() => window.__fakeReads);
assert.ok(reads < 80, `открыть календарь + отчёт — ${reads} чтений`);
  await app.close();
});
