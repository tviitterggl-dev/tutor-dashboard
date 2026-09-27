// Вкладка «Аналитика» (только учителю): доход по месяцам/неделям («Оплачено»,
// потенциальный), общая доля отмен, загрузка по дням недели.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, defaultSeed } from "./harness.mjs";

after(shutdown);
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const rows = (page, id) => page.$$eval(`#${id} tbody tr`, (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));

test("аналитика: один период на всю вкладку (месяцы 3/6/12 или недели 5/10/15); по умолчанию оплаченное, по галочке — потенциальный заработок", async () => {
  const seed = defaultSeed();
  seed[L("anna2")].status = "cancelled";          // 08.09 Анна — отмена
  seed[L("boris1")].status = "cancelled";         // 17.09 Борис — отмена
  seed[L("anna4")].status = "rescheduled";        // 22.09 Анна — перенос
  seed[L("serA_20260914T070000Z")].paid = { value: true, by: "parent", at: 1 };
  // 01.09 Анна — 90 минут: загрузка считается по длительности, а не штуками
  Object.assign(seed[L("anna1")], { endMs: seed[L("anna1")].startMs + 90 * 60000, durationMin: 90 });
  const app = await openApp({ seed });
  const { page } = app;
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("an.")) localStorage.removeItem(k); });
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="stats"]'); await page.click('.subtab[data-statsmode="analytics"]');
  await page.waitForSelector("#anIncome svg");
  const nb = (x) => x.replace(" ", "\u00a0");
  // по умолчанию: по месяцам, 3 мес; все переключатели — в карточке «Доход»
  assert.equal(await page.getAttribute("#anIncomeCard [data-anstep].active", "data-anstep"), "month");
  assert.equal(await page.getAttribute("#anIncomeCard [data-anmonths].active", "data-anmonths"), "3");
  assert.equal(await page.locator("#view-analytics [data-anmonths]").count(), 4, "кнопки месяцев (1/3/6/12) только одни — в «Доходе»");
  // плитки: оплачено 2000 (14.09); по расписанию сентября: Тест 8×2000 + Анна 1500+1400+1500 + Борис 1800 (24.09) = 22200
  const tiles = await page.innerText("#anTiles");
  assert.match(tiles, /2\s000 ₽[\s\S]*оплачено/);
  assert.match(tiles, /22\s200 ₽[\s\S]*по расписанию/);
  // прошедшие до 24.09 12:00: Тест 14,16,18,21,23 (5) + Анна 01,08,15 (3; 22 — перенос) + Борис 17 (1) = 9, отмен 2
  assert.match(tiles, /22%[\s\S]*отмен \(2 из 9\)/);
  // график по умолчанию — только оплаченное, одна серия, без легенды
  assert.equal(await page.isVisible("#anIncomeLegend"), false);
  assert.equal(await page.locator("#anIncome path").count(), 1);
  const inc = await rows(page, "anIncomeTable");
  assert.equal(inc.length, 3);
  assert.deepEqual(inc[2].slice(1), ["2 000 ₽", "5 400 ₽", "22 200 ₽", "20 200 ₽"].map(nb), "сентябрь: оплачено / провёл / по расписанию / ещё не оплачено");
  await page.locator("#anIncome .an-hit").last().click();
  assert.match(await page.textContent("#anIncome .an-tip"), /сентябрь 2026[\s\S]*оплачено: 2\s000 ₽[\s\S]*проведено \(«Провёл»\): 5\s400 ₽ \(3 зан\.\)/);
  // галочка — потенциальный заработок: сверху «ещё не оплачено»
  await page.check("#anPotential");
  await page.waitForSelector("#anIncomeLegend", { state: "visible" });
  assert.equal(await page.locator("#anIncome path").count(), 2);
  await page.locator("#anIncome .an-hit").last().click();
  assert.match(await page.textContent("#anIncome .an-tip"), /ещё не оплачено: 20\s200 ₽[\s\S]*всего по расписанию: 22\s200 ₽/);
  // карточки «Отмены по ученикам» больше нет — только общая доля в плитке
  assert.equal(await page.locator("#anCancel, #anCancelTable").count(), 0);
  assert.doesNotMatch(await page.innerText("#view-analytics"), /Отмены по ученикам/);
  // загрузка по дням: отменённые не считаются
  const week = await rows(page, "anWeekTable");
  assert.deepEqual(week.map((r) => r[0]), ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
  assert.deepEqual(await page.$$eval("#anWeekTable thead th", (t) => t.map((x) => x.textContent)), ["День", "Часов в неделю", "Занятий в неделю", "Всего занятий", "Всего часов"]);
  assert.equal(week[3][3], "0", "четверг — только отменённое");
  assert.equal(week[1][3], "2", "вторники: Анна 01 и 15");
  assert.equal(week[1][4], "2,5", "вторники: 1,5 ч (01.09, 90 мин) + 1 ч (15.09)");
  assert.equal(week[0][4], "2", "понедельники: Тест 14.09 и 21.09 по часу");
  // столбик — часы (длительность из карточки занятия)
  await page.locator("#anWeek .an-hit").nth(1).click();
  assert.match(await page.textContent("#anWeek .an-tip"), /Вт[\s\S]*ч в неделю[\s\S]*всего за период: 2 зан\., 2,5 ч/);
  // 6 и 12 месяцев
  await page.click('[data-anmonths="12"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 12);
  // по неделям: свой выбор 5/10/15, и он же — период плиток, отмен и загрузки
  await page.click('[data-anstep="week"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 10, null, { timeout: 8000 });
  assert.equal(await page.isVisible('[data-anmonths="3"]'), false, "в режиме недель — кнопки недель, не месяцев");
  await page.click('[data-anweeks="5"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 5);
  const wk = await rows(page, "anIncomeTable");
  assert.equal(wk[3][0], "14.09 – 20.09");
  assert.deepEqual(wk[3].slice(1, 3), ["2 000 ₽", "5 400 ₽"].map(nb));
  // 5 недель (с 24.08): отмены — Анна 08.09 и Борис 17.09
  assert.match(await page.innerText("#anTiles"), /отмен \(2 из/);
  await page.click('[data-anweeks="15"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 15);
  // выбор запоминается на устройстве
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="stats"]'); await page.click('.subtab[data-statsmode="analytics"]');
  await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 15, null, { timeout: 8000 });
  assert.equal(await page.isChecked("#anPotential"), true);
  // в витрины семей аналитика не уходит
  const db = await app.db();
  const views = Object.entries(db).filter(([p]) => p.startsWith("parentAccess/") || p.startsWith("studentAccess/"));
  assert.ok(views.every(([, v]) => !JSON.stringify(v).match(/anIncome|potential|analytics/)));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("аналитика на телефоне: графики по ширине экрана, ничего не вылезает", async () => {
  const app = await openApp({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="stats"]'); await page.click('.subtab[data-statsmode="analytics"]');
  await page.waitForSelector("#anWeek svg");
  const over = await page.evaluate(() => [...document.querySelectorAll("#view-analytics .an-svg")].filter((s) => s.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
  assert.equal(over, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "нет горизонтальной прокрутки страницы");
  await app.close();
});

test("аналитика: период «1 мес» и «1 нед» — одна группа, подписи и подсказка на месте", async () => {
  const seed = defaultSeed();
  seed[L("serA_20260914T070000Z")].paid = { value: true, by: "parent", at: 1 };
  seed[L("serA_20260921T070000Z")].paid = { value: true, by: "parent", at: 1 };
  for (const vp of [{ width: 1100, height: 900 }, { width: 360, height: 780 }]) {
    const app = await openApp({ seed: JSON.parse(JSON.stringify(seed)), viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const { page } = app;
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("an.")) localStorage.removeItem(k); });
    await page.waitForSelector("#lessonsList .lesson");
    await page.click('.tab[data-tab="stats"]'); await page.click('.subtab[data-statsmode="analytics"]');
    await page.waitForSelector("#anIncome svg");
    await page.click('[data-anmonths="1"]');
    await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 1);
    assert.equal(await page.textContent('[data-anmonths="1"]'), "1 мес");
    assert.equal(await page.locator("#anIncome .an-hit").count(), 1);
    assert.match(await page.textContent("#anIncome svg"), /сен/, "подпись месяца под столбиком");
    await page.locator("#anIncome .an-hit").click();
    const box = await page.evaluate(() => { const t = document.querySelector("#anIncome .an-tip").getBoundingClientRect(), c = document.querySelector("#anIncomeCard").getBoundingClientRect(); return { in: t.left >= c.left - 1 && t.right <= c.right + 1, vis: t.width > 0 }; });
    assert.deepEqual(box, { in: true, vis: true }, `подсказка внутри карточки (${vp.width}px)`);
    await page.click('[data-anstep="week"]');
    await page.click('[data-anweeks="1"]');
    await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 1);
    assert.equal(await page.textContent('[data-anweeks="1"]'), "1 нед");
    assert.equal((await page.$$eval("#anIncomeTable tbody tr td", (t) => t.map((x) => x.textContent)))[0], "21.09 – 27.09");
    assert.match(await page.innerText("#anTiles"), /2\s000 ₽[\s\S]*оплачено/, "за неделю — оплата 21.09");
    const over = await page.evaluate(() => [...document.querySelectorAll("#view-analytics .an-svg")].some((s) => s.getBoundingClientRect().right > document.documentElement.clientWidth + 1));
    assert.equal(over, false, "графики в ширину экрана");
    assert.deepEqual(app.errors, []);
    await app.close();
  }
});

// Ширина столбика: потолок 34 px (был 24 — при 5–7 группах много пустоты),
// при многих группах ограничивает ширина полосы — столбики не касаются.
const barBoxes = (page, sel) => page.$$eval(`${sel} svg path`, (ps) => ps.map((p) => { const b = p.getBBox(); return { x: b.x, w: b.width }; }).filter((b) => b.w > 0));
test("аналитика: столбики шире при малом числе групп и не касаются при большом", async () => {
  for (const vp of [{ width: 1100, height: 900 }, { width: 360, height: 780 }]) {
    const app = await openApp({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const { page } = app;
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("an.")) localStorage.removeItem(k); });
    await page.waitForSelector("#lessonsList .lesson");
    await page.click('.tab[data-tab="stats"]'); await page.click('.subtab[data-statsmode="analytics"]');
    await page.waitForSelector("#anWeek svg");
    await page.check("#anPotential");
    const check = async (what) => {
      for (const sel of ["#anIncome", "#anWeek"]) {
        const bs = (await barBoxes(page, sel)).sort((a, b) => a.x - b.x);
        for (let i = 1; i < bs.length; i++) if (Math.abs(bs[i].x - bs[i - 1].x) > 0.5) assert.ok(bs[i].x - (bs[i - 1].x + bs[i - 1].w) >= 2, `${what} ${sel} ${vp.width}px: столбики не касаются`);
      }
    };
    await page.click('[data-anstep="week"]');
    await page.click('[data-anweeks="5"]');
    await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 5);
    if (vp.width > 500) {
      const w = Math.max(...(await barBoxes(page, "#anWeek")).map((b) => b.w));
      assert.ok(w >= 30, `дни недели на компьютере: столбик ${w.toFixed(1)} px`);
      const wi = Math.max(...(await barBoxes(page, "#anIncome")).map((b) => b.w));
      assert.ok(wi >= 30, `5 недель на компьютере: столбик ${wi.toFixed(1)} px`);
    }
    await check("5 нед");
    await page.click('[data-anweeks="15"]');
    await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 15);
    await check("15 нед");
    await page.click('[data-anstep="month"]');
    await page.click('[data-anmonths="12"]');
    await page.waitForFunction(() => document.querySelectorAll("#anIncomeTable tbody tr").length === 12);
    await check("12 мес");
    await app.close();
  }
});
