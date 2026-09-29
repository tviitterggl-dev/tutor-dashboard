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

test("окно занятия и вкладка «Уведомления» при большой истории — без чтения всей истории ученика и каналов", async () => {
  // Раньше блок «ДЗ к следующему занятию» при КАЖДОМ открытии окна читал все
  // занятия ученика за всё время (listLessonsOfStudent), а статус пушей во
  // вкладке «Уведомления» заново читал каналы учеников, которые и так живые.
  const { seed, n } = bigSeed();
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await settle(page);
  await page.evaluate(() => { window.__fakeReads = 0; });
  for (let i = 0; i < 3; i++) {
    await page.locator("#lessonsList .lesson").nth(i).click();
    await page.waitForSelector("#mNextHw");
    await page.waitForFunction(() => !/Загрузка|Ищу/.test(document.getElementById("mNextHw").textContent));
    await page.keyboard.press("Escape");
  }
  await settle(page, 1500);
  const modalReads = await page.evaluate(() => window.__fakeReads);
  assert.ok(modalReads < 15, `три окна занятия — ${modalReads} чтений (история: ${n} занятий)`);
  // «ДЗ к следующему занятию» по-прежнему находит следующее занятие Бориса
  await page.locator("#lessonsList .lesson").first().click();
  await page.waitForSelector("#mNextHw"); // окно открывается после чтения занятия — не сразу
  await page.waitForFunction(() => /Борис|\d{2}\.\d{2}|сентяб|октяб/.test(document.getElementById("mNextHw").textContent));
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__fakeReads = 0; });
  await page.click('.tab[data-tab="notify"]');
  await settle(page, 2000);
  const notifyReads = await page.evaluate(() => window.__fakeReads);
  assert.ok(notifyReads < 15, `вкладка «Уведомления» — ${notifyReads} чтений`);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("диапазон шире живой подписки (аналитика за год, состав группы): напрямую читается только часть за окном", async () => {
  // Окно живой подписки на занятия — 200 дней назад и 250 вперёд. Раньше любой
  // запрос хоть чуть шире (аналитика за 12 месяцев, «все будущие занятия
  // группы») читал ВЕСЬ диапазон заново, мимо подписки.
  const seed = defaultSeed();
  const iso = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
  const base = Date.parse(NOW);
  let old = 0, n = 0;
  for (let d = -400; d <= 300; d += 2) {
    const s = base + d * 86400000;
    const id = `hist${n++}`;
    seed[L(id)] = Object.assign(lessonDoc({ id, summary: "Борис 8 класс", start: { dateTime: iso(s) }, end: { dateTime: iso(s + 3600000) } }), { source: "app" });
    if (d < -200 || d > 250) old++;
  }
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await settle(page, 2500);
  const r = await page.evaluate(async ({ from, to }) => {
    window.__fakeReads = 0;
    const got = await window.TutorFB.listLessons(from, to);
    const reads = window.__fakeReads;
    const db = JSON.parse(localStorage.getItem("__fakeDb"));
    const all = Object.entries(db).filter(([p, d]) => p.includes("/lessons/") && d.startMs >= from && d.startMs < to).map(([p]) => p.split("/").pop()).sort();
    return { reads, same: JSON.stringify(got.map((x) => x.id).sort()) === JSON.stringify(all), count: got.length, sorted: got.every((x, i) => !i || got[i - 1].startMs <= x.startMs) };
  }, { from: base - 400 * 86400000, to: base + 300 * 86400000 });
  assert.ok(r.same && r.sorted, "тот же список, что и полным чтением, по порядку");
  assert.ok(r.count > 300);
  assert.ok(r.reads <= old + 2, `прочитано ${r.reads} — только за окном подписки (${old} занятий), а не все ${r.count}`);
  // второй раз — части за окном из памяти сессии
  const again = await page.evaluate(async ({ from, to }) => { window.__fakeReads = 0; await window.TutorFB.listLessons(from, to); return window.__fakeReads; }, { from: base - 400 * 86400000, to: base + 300 * 86400000 });
  assert.ok(again <= 2, `повтор — ${again} чтений`);
  assert.deepEqual(app.errors, []);
  await app.close();
});
