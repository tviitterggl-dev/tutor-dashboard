// Скидка за предоплату пакета (только у учителя): процент от ставки или общая
// цена за весь пакет → цена одного занятия пакета. «Провёл» фиксирует её в
// отметке (lockedRate); после конца пакета — снова обычная ставка. В витрины
// родителя/ученика цена не попадает.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const statePath = `teacherSpaces/${T}/state/main`;
const card = (page, key) => page.locator(`.pkg-card[data-key="${key}"]`);
const waitCard = (page, key, re) => page.waitForFunction(([k, src]) => {
  const el = document.querySelector(`.pkg-card[data-key="${k}"]`);
  return el && new RegExp(src).test(el.textContent);
}, [key, re.source], { timeout: 8000 });
const later = (page, min) => page.clock.setFixedTime(new Date(Date.parse(NOW) + min * 60000));
const PK = "parent_key_test_student_0000000001";
async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
const nb = (s) => s.replace(/ (?=\d{3}\b)/g, " ");

test("предоплата пакета: скидка % и цена за весь пакет → цена занятия; фиксируется при «Провёл»; в кабинет семьи не уходит", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true };
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /2 из 8/);

  // 1) новый пакет Анне: 4 занятия, скидка 10% от 1 500 → 1 350 за занятие
  await page.click("#pkgAddBtn");
  await page.fill("#pkgAddName", "Анна");
  await page.fill("#pkgAddCls", "6");
  await page.fill("#pkgAddTotal", "4");
  await page.selectOption("#pkgAddForm .pkg-price-mode", "pct");
  await page.fill("#pkgAddForm .pkg-price-val", "10");
  await page.waitForFunction(() => /1\s350 ₽ за занятие[\s\S]*вместо 1\s500[\s\S]*5\s400 ₽ за 4/.test(document.querySelector("#pkgAddForm .pkg-price-hint").textContent));
  await page.click("#pkgAddSaveBtn");
  await waitCard(page, "Анна, 6 класс", /0 из 4/);
  let ov = (await app.db())[statePath].pkgOverrides["Анна, 6 класс"];
  assert.deepEqual(ov.price, { mode: "pct", value: 10 });
  assert.match(await card(page, "Анна, 6 класс").locator(".pkg-price-line").textContent(), /Предоплата: 5\s400 ₽ за 4 · 1\s350 ₽ за занятие \(скидка 10%\)/);

  // «Провёл» у её занятия этой недели (22.09) → сумма 1 350, зафиксирована
  await later(page, 1);
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  const row = page.locator("#lessonsList .lesson", { hasText: "Анна" }).first();
  assert.equal(await row.locator("input").getAttribute("placeholder"), "1350", "подсказка суммы — цена пакета");
  await row.locator(".mark-btn").click();
  await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem("__fakeDb"))["teacherSpaces/teacherUid0123456789abcdef/state/main"].marks).some((m) => m.marked && m.lockedRate === 1350));
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Анна, 6 класс", /1 из 4, осталось 3/);
  assert.match(await card(page, "Анна, 6 класс").textContent(), new RegExp(nb("1 350 ₽ отработано")));

  // 2) «Новый пакет» Тесту: 8 занятий за 14 000 → 1 750 за занятие
  await later(page, 2);
  await card(page, "Тест, 7 класс").locator(".pkg-new-btn").click();
  const np = card(page, "Тест, 7 класс").locator(".pkg-new-panel");
  await np.locator(".pkg-new-total").fill("8");
  await np.locator(".pkg-price-mode").selectOption("total");
  await np.locator(".pkg-price-val").fill("14000");
  await page.waitForFunction(() => /1\s750 ₽ за занятие[\s\S]*вместо 2\s000/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"] .pkg-new-panel .pkg-price-hint').textContent));
  await np.locator(".pkg-new-save").click();
  await waitCard(page, "Тест, 7 класс", /0 из 8/);
  ov = (await app.db())[statePath].pkgOverrides["Тест, 7 класс"];
  assert.deepEqual([ov.totalOverride, ov.doneBase, ov.price], [8, 0, { mode: "total", value: 14000 }]);
  assert.match(await card(page, "Тест, 7 класс").locator(".pkg-price-line").textContent(), /Предоплата: 14\s000 ₽ за 8 · 1\s750 ₽ за занятие \(скидка 12,5%\)/);
  // будущее занятие Теста (28.09) — в карточке сумма по пакету
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест" }).first().click();
  await page.waitForSelector("#mAmount");
  assert.equal(await page.getAttribute("#mAmount", "placeholder"), "1750");
  await page.click("#mClose");

  // 3) «Исправить» → «без скидки»: цена пакета убрана, снова обычная ставка
  await page.click('.tab[data-tab="students"]');
  await card(page, "Тест, 7 класс").locator(".pkg-edit-btn").click();
  const ep = card(page, "Тест, 7 класс").locator(".pkg-edit-panel");
  assert.equal(await ep.locator(".pkg-price-mode").inputValue(), "total", "в «Исправить» — текущая цена пакета");
  assert.equal(await ep.locator(".pkg-price-val").inputValue(), "14000");
  await ep.locator(".pkg-price-mode").selectOption("");
  await ep.locator(".pkg-save-btn").click();
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem("__fakeDb"))["teacherSpaces/teacherUid0123456789abcdef/state/main"].pkgOverrides["Тест, 7 класс"].price);
  await page.waitForFunction(() => !document.querySelector('.pkg-card[data-key="Тест, 7 класс"] .pkg-price-line'));

  // 4) в витрины семей — только «X из N», без цен
  await waitFor(async () => { const v = (await app.db())[`parentAccess/${PK}`]; return v && v.package && v.package.total === 8 && v.package.done === 0; }, "витрина с новым пакетом");
  const db = await app.db();
  const views = Object.entries(db).filter(([p]) => p.startsWith("parentAccess/") || p.startsWith("studentAccess/"));
  assert.ok(views.length > 0);
  for (const [, v] of views) {
    assert.doesNotMatch(JSON.stringify(v), /price|lockedRate|1350|14000/);
    if (v.package) assert.deepEqual(Object.keys(v.package).sort(), ["done", "remaining", "total"]);
  }
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("пакет со скидкой закончился — следующие занятия снова по обычной ставке", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /2 из 8/);
  // пакет на 1 занятие за 1 000 у Анны
  await page.click("#pkgAddBtn");
  await page.fill("#pkgAddName", "Анна");
  await page.fill("#pkgAddCls", "6");
  await page.fill("#pkgAddTotal", "1");
  await page.selectOption("#pkgAddForm .pkg-price-mode", "total");
  await page.fill("#pkgAddForm .pkg-price-val", "1000");
  await page.click("#pkgAddSaveBtn");
  await waitCard(page, "Анна, 6 класс", /0 из 1/);
  await later(page, 1);
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.locator("#lessonsList .lesson", { hasText: "Анна" }).first().locator(".mark-btn").click();
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Анна, 6 класс", /1 из 1, осталось 0/);
  // следующее занятие Анны (29.09) — снова 1 500
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Анна" }).first().click();
  await page.waitForSelector("#mAmount");
  assert.equal(await page.getAttribute("#mAmount", "placeholder"), "1500");
  const marks = Object.values((await app.db())[statePath].marks).filter((m) => m.lockedRate === 1000);
  assert.equal(marks.length, 1, "проведённое по пакету — 1 000");
  assert.deepEqual(app.errors, []);
  await app.close();
});
