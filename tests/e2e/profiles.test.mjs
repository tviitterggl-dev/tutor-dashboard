// Профили учеников (ссылка на созвон, материалы, заметки) — только учитель.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T } from "./harness.mjs";

after(shutdown);
const statePath = `teacherSpaces/${T}/state/main`;

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("Не дождались: " + what);
}

test("профиль ученика: сохранить ссылки и заметки; созвон сам подставляется в занятие, можно заменить разово", async () => {
  const app = await openApp();
  const { page } = app;
  await app.page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Тест, 7 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-call").fill("ftp://плохо");
  await card.locator("[data-pf-save]").click();
  await page.waitForFunction(() => /https:\/\//.test(document.querySelector('.student-card[data-student="Тест, 7 класс"] .pf-msg').textContent));
  await card.locator(".pf-call").fill("https://telemost.yandex.ru/j/111");
  await card.locator(".pf-access").fill("https://miro.com/board/abc");
  await card.locator(".pf-notes").fill("Прошли дроби. Дальше — уравнения.");
  await card.locator("[data-pf-save]").click();
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector('.student-card[data-student="Тест, 7 класс"] .pf-msg').textContent));
  const prof = (await app.db())[statePath].studentProfiles["Тест, 7 класс"];
  assert.equal(prof.callUrl, "https://telemost.yandex.ru/j/111");
  assert.equal(prof.accessUrl, "https://miro.com/board/abc");
  assert.equal(prof.notes, "Прошли дроби. Дальше — уравнения.");
  assert.match(await card.locator(".agg").textContent(), /созвон · материалы · заметки/);

  // После перезагрузки — на месте
  await page.reload();
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  await card.locator(".student-head").click();
  assert.equal(await card.locator(".pf-notes").inputValue(), "Прошли дроби. Дальше — уравнения.");

  // Во вкладке «Занятия» — быстрая ссылка «созвон»
  await page.click('.tab[data-tab="lessons"]');
  await page.waitForSelector("#lessonsList .lesson");
  const quick = page.locator(".lesson", { hasText: "Тест, 7 класс" }).first().locator('a.edit-link');
  assert.equal(await quick.getAttribute("href"), "https://telemost.yandex.ru/j/111");

  // Карточка занятия: ссылка из профиля
  await page.click('.tab[data-tab="calendar"]');
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 6/8" }).click();
  await page.waitForSelector("#mCallOpen");
  assert.equal(await page.getAttribute("#mCallOpen", "href"), "https://telemost.yandex.ru/j/111");
  assert.match(await page.textContent("#mCallSrc"), /из профиля ученика/);
  // Разовая замена только для этого занятия
  await page.fill("#mCallUrl", "https://zoom.us/j/999");
  await page.click("#mCallSave");
  await page.waitForFunction(() => /Разовая ссылка сохранена/.test(document.querySelector("#mMsg").textContent));
  assert.equal(await page.getAttribute("#mCallOpen", "href"), "https://zoom.us/j/999");
  let db = await app.db();
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260925T070000Z`].callUrl, "https://zoom.us/j/999");
  await page.click("#mClose");
  // Соседнее занятие — по-прежнему обычная ссылка
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 5/8" }).click();
  await page.waitForSelector("#mCallOpen");
  assert.equal(await page.getAttribute("#mCallOpen", "href"), "https://telemost.yandex.ru/j/111");
  await page.click("#mClose");
  // Вернуть обычную
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 6/8" }).click();
  await page.click("#mCallReset");
  await page.waitForFunction(() => /Вернули обычную/.test(document.querySelector("#mMsg").textContent));
  assert.equal(await page.getAttribute("#mCallOpen", "href"), "https://telemost.yandex.ru/j/111");
  db = await app.db();
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260925T070000Z`].callUrl, null);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("в кабинет уходит только ссылка на созвон; заметки и материалы — нет", async () => {
  const PK = "parent_key_test_student_0000000001";
  const seed = (await import("./harness.mjs")).defaultSeed();
  seed[statePath].studentProfiles = { "Тест, 7 класс": { callUrl: "https://telemost.yandex.ru/j/SECRET", accessUrl: "https://miro.com/SECRET2", notes: "заметка-SECRET3" } };
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", createdAt: 1, active: true };
  const app = await openApp({ seed });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`], "витрина");
  const v = JSON.stringify((await app.db())[`parentAccess/${PK}`]);
  for (const secret of ["SECRET2", "SECRET3", "miro", "заметка"]) assert.equal(v.includes(secret), false, secret);
  const view = (await app.db())[`parentAccess/${PK}`];
  const upcoming = view.lessons.filter((l) => l.status === "planned");
  assert.ok(upcoming.length && upcoming.every((l) => l.callUrl === "https://telemost.yandex.ru/j/SECRET"), "созвон — у каждого занятия");
  assert.ok(view.lessons.filter((l) => l.status === "rescheduled" || l.status === "cancelled").every((l) => !l.callUrl));
  await app.close();
});


test("баг «созвон не виден родителю»: ссылка из профиля появляется в кабинете сразу после сохранения, разовая — заменяет", async () => {
  const PK = "parent_key_test_student_0000000001";
  const seed = (await import("./harness.mjs")).defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", createdAt: 1, active: true };
  const app = await openApp({ seed });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date("2026-09-24T12:00:00+03:00"));
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.equal(await cab.$(".call-link"), null, "пока ссылки нет");

  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Тест, 7 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-call").fill("https://telemost.yandex.ru/j/777");
  await card.locator("[data-pf-save]").click();
  // кабинет обновился сам (живая подписка), без перезагрузки
  await cab.waitForSelector(".call-link");
  assert.equal(await cab.getAttribute(".call-link", "href"), "https://telemost.yandex.ru/j/777");
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.waitForSelector("#mCall");
  assert.equal(await cab.getAttribute("#mCall", "href"), "https://telemost.yandex.ru/j/777");
  await cab.click("#mClose");

  // разовая ссылка для 7/8
  await page.click('.tab[data-tab="calendar"]');
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 7/8" }).click();
  await page.fill("#mCallUrl", "https://zoom.us/j/1");
  await page.click("#mCallSave");
  await page.waitForFunction(() => /Разовая ссылка сохранена/.test(document.querySelector("#mMsg").textContent));
  await cab.waitForFunction(() => [...document.querySelectorAll(".lesson")].some((l) => /7\/8/.test(l.textContent) && l.querySelector('.call-link[href="https://zoom.us/j/1"]')));
  const cards = await cab.$$eval(".lesson", (ls) => ls.map((l) => [l.textContent.includes("8/8"), l.querySelector(".call-link")?.getAttribute("href")]));
  assert.ok(cards.some(([is8, href]) => is8 && href === "https://telemost.yandex.ru/j/777"), "у соседнего занятия — обычная");
  await app.close();
});
