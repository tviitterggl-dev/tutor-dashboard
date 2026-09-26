// Ручной сдвиг номеров пакета (вперёд/назад), без изменения дат;
// переименование кабинета учителя; вкладки не наезжают друг на друга.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T } from "./harness.mjs";

after(shutdown);
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const S = (d) => `serA_${d}T070000Z`;
const titles = async (app) => {
  const db = await app.db();
  return Object.fromEntries(["20260923", "20260925", "20260928", "20260930"].map((d) => [d, db[L(S(d))].title]));
};
const starts = async (app) => { const db = await app.db(); return Object.keys(db).filter((p) => p.includes("/lessons/serA_")).map((p) => db[p].startMs); };
const preview = (page) => page.$$eval('.pkg-card[data-key="Тест, 7 класс"] .pkg-shift-preview .session-row', (r) => r.map((x) => x.textContent.replace(/\s+/g, " ").trim()));

test("пакет: «Сдвинуть номера» вперёд и назад — только номера, даты те же; переход в следующий пакет", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.pkg-card[data-key="Тест, 7 класс"]');
  await page.waitForFunction(() => /2 из 8/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"]')?.textContent || ""));
  const datesBefore = (await starts(app)).sort();

  await card.locator(".pkg-shift-btn").click();
  await card.locator(".pkg-shift-from").waitFor();
  // по умолчанию — ближайшее будущее занятие (25.09, 6/8) и сдвиг +1
  assert.equal(await card.locator(".pkg-shift-from").inputValue(), S("20260925"));
  assert.equal(await card.locator(".pkg-shift-delta").textContent(), "+1");
  let pv = await preview(page);
  assert.equal(pv.length, 3);
  assert.match(pv[0], /25\.09.*6\/8 → 7\/8/);
  assert.match(pv[2], /30\.09.*8\/8 → 1\/8 \(след\. пакет\)/);
  // +2
  await card.locator('[data-shift-step="1"]').click();
  assert.equal(await card.locator(".pkg-shift-delta").textContent(), "+2");
  assert.match((await preview(page))[1], /7\/8 → 1\/8/);
  assert.equal(await card.locator(".pkg-shift-warn").count(), 0, "вперёд — без предупреждения");
  // обратно к +1 и применить
  await card.locator('[data-shift-step="-1"]').click();
  await card.locator(".pkg-shift-apply").click();
  await page.waitForFunction(() => /номера сдвинуты у 3 занятий/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"] .pkg-shift-panel')?.textContent || ""));
  assert.deepEqual(await titles(app), { 20260923: "Тест 7 класс 5/8", 20260925: "Тест 7 класс 7/8", 20260928: "Тест 7 класс 8/8", 20260930: "Тест 7 класс 1/8" });
  assert.deepEqual((await starts(app)).sort(), datesBefore, "даты и время не менялись");
  // текущий пакет — тот, что идёт сейчас, а не следующий (30.09 1/8)
  await page.waitForFunction(() => /2 из 8/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"]').textContent));

  // назад на 2 с 25.09: 7→5, 8→6, 1/8 след. пакета → 7/8 (вернулся в текущий)
  await card.locator('[data-shift-step="-1"]').click();
  assert.equal(await card.locator(".pkg-shift-delta").textContent(), "-1", "ноль пропускается");
  await card.locator('[data-shift-step="-1"]').click();
  pv = await preview(page);
  assert.match(pv[2], /30\.09.*1\/8 → 7\/8 \(пред\. пакет\)/);
  assert.match(await card.locator(".pkg-shift-warn").textContent(), /23\.09.*5\/8.*новый пакет/);
  await card.locator(".pkg-shift-apply").click();
  await page.waitForFunction(() => /номера сдвинуты/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"] .pkg-shift-panel').textContent));
  assert.deepEqual(await titles(app), { 20260923: "Тест 7 класс 5/8", 20260925: "Тест 7 класс 5/8", 20260928: "Тест 7 класс 6/8", 20260930: "Тест 7 класс 7/8" });

  // меньше 1 нельзя: с 16.09 (2/8) на −2
  await card.locator(".pkg-shift-from").selectOption(S("20260916"));
  await page.waitForFunction(() => /меньше 1/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"] .pkg-shift-panel').textContent));
  assert.equal(await card.locator(".pkg-shift-apply").isDisabled(), true);
  // «Закрыть»
  await card.locator(".pkg-shift-cancel").click();
  assert.equal(await card.locator(".pkg-shift-panel").isVisible(), false);
  // В списке занятий — новые номера
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.waitForFunction(() => /Тест, 7 класс/.test(document.querySelector("#lessonsList").innerText));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("название «Тьютор Онлайн» у кабинета учителя; вкладки не наезжают друг на друга на любой ширине", async () => {
  for (const width of [360, 430, 640, 700, 820, 1100]) {
    const app = await openApp({ viewport: { width, height: 800 } });
    const { page } = app;
    await page.waitForSelector("#lessonsList .lesson");
    if (width === 360) {
      assert.equal(await page.title(), "Тьютор Онлайн");
      assert.equal(await page.textContent("h1"), "Тьютор Онлайн");
      assert.equal(await page.getAttribute('meta[name="application-name"]', "content"), "Тьютор Онлайн");
    }
    const over = await page.$$eval(".tabs .tab", (ts) => ts.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent));
    assert.deepEqual(over, [], `ширина ${width}`);
    // соседние вкладки не перекрываются
    const boxes = await page.$$eval(".tabs .tab", (ts) => ts.map((t) => { const r = t.getBoundingClientRect(); return [r.left, r.right]; }));
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1] - 0.5, `ширина ${width}: вкладка ${i}`);
    await app.close();
  }
});
