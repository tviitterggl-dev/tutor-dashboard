// Вкладка «Аналитика» (только учителю): доход по месяцам («Провёл»/«Оплачено»),
// отмены по ученикам, загрузка по дням недели, доход по неделям.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, defaultSeed } from "./harness.mjs";

after(shutdown);
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const rows = (page, id) => page.$$eval(`#${id} tbody tr`, (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));

test("аналитика: цифры из базы, три графика с подсказками и таблицами, период 3/6/12 мес, не в кабинетах семей", async () => {
  const seed = defaultSeed();
  seed[L("anna2")].status = "cancelled";          // 08.09 Анна — отмена
  seed[L("boris1")].status = "cancelled";         // 17.09 Борис — отмена
  seed[L("anna4")].status = "rescheduled";        // 22.09 Анна — перенос
  seed[L("serA_20260914T070000Z")].paid = { value: true, by: "parent", at: 1 };
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="analytics"]');
  await page.waitForSelector("#anIncome svg");
  // плитки: «Провёл» 2000+2000 (Тест) + 1400 (Анна, своя сумма) = 5400; «Оплачено» 2000
  const tiles = await page.innerText("#anTiles");
  assert.match(tiles, /5\s400 ₽[\s\S]*заработано/);
  assert.match(tiles, /2\s000 ₽[\s\S]*оплачено/);
  // прошедшие до 24.09 12:00: Тест 14,16,18,21,23 (5) + Анна 01,08,15 (3; 22 — перенос) + Борис 17 (1) = 9, отмен 2
  assert.match(tiles, /22%[\s\S]*отмен \(2 из 9\)/);
  // доход по месяцам: 6 столбцов-групп, сентябрь с суммами
  const inc = await rows(page, "anIncomeTable");
  assert.equal(inc.length, 6);
  assert.deepEqual(inc[5].slice(1), ["5 400 ₽", "2 000 ₽"].map((x) => x.replace(" ", " ")));
  assert.equal(await page.locator("#anIncome .an-hit").count(), 6);
  // подсказка по касанию
  await page.locator("#anIncome .an-hit").last().click();
  await page.waitForSelector("#anIncome .an-tip:not([hidden])");
  assert.match(await page.textContent("#anIncome .an-tip"), /сентябрь 2026[\s\S]*Провёл: 5\s400 ₽ \(3 зан\.\)[\s\S]*Оплачено: 2\s000 ₽/);
  // отмены: Борис 1 из 1 (100%) выше Анны 1 из 3 (33%); у Анны — 1 перенос
  const names = await page.$$eval("#anCancel .an-name", (t) => t.map((x) => x.textContent));
  assert.deepEqual(names, ["Борис, 8 класс", "Анна, 6 класс"]);
  const cancel = await rows(page, "anCancelTable");
  assert.deepEqual(cancel.find((r) => r[0] === "Анна, 6 класс"), ["Анна, 6 класс", "1", "3", "33%", "1"]);
  assert.deepEqual(cancel.find((r) => r[0] === "Тест, 7 класс"), ["Тест, 7 класс", "0", "5", "0%", "0"]);
  // загрузка: 7 дней, отменённые не считаются (Борис 17.09, чт — отменён → в четверг 0)
  const week = await rows(page, "anWeekTable");
  assert.deepEqual(week.map((r) => r[0]), ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
  assert.equal(week[3][3], "0", "четверг — только отменённое");
  assert.equal(week[1][3], "2", "вторники: Анна 01 и 15 (08 — отмена, 22 — перенос)");
  assert.equal(week[0][3], "2", "понедельники: Тест 14 и 21");
  // период 3 месяца — 3 группы; вернуться на 12 — 12
  await page.click('[data-anmonths="3"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 3);
  await page.click('[data-anmonths="12"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 12);
  // доход по неделям переехал сюда из «Итогов»
  await page.waitForSelector("#trendChart svg");
  assert.equal(await page.locator("#view-summary #trendChart").count(), 0);
  // в витрины семей аналитика не уходит
  const db = await app.db();
  const views = Object.entries(db).filter(([p]) => p.startsWith("parentAccess/") || p.startsWith("studentAccess/"));
  assert.ok(views.every(([, v]) => !JSON.stringify(v).match(/anIncome|cancelled":\d|analytics/)));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("аналитика на телефоне: графики по ширине экрана, ничего не вылезает", async () => {
  const app = await openApp({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="analytics"]');
  await page.waitForSelector("#anWeek svg");
  const over = await page.evaluate(() => [...document.querySelectorAll("#view-analytics .an-svg")].filter((s) => s.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
  assert.equal(over, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "нет горизонтальной прокрутки страницы");
  await app.close();
});
