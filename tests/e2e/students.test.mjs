// Добавление/удаление учеников, «пакет заканчивается», сводка «Оплата».
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("Не дождались: " + what);
}
async function openImported(opts = {}) {
  const app = await openApp(opts);
  await waitFor(async () => (await app.db())[statePath].lessonsSource === "firestore", "импорт");
  return app;
}

test("добавить ученика вручную: появляется в списках, ставка работает", async () => {
  const app = await openImported();
  const { page } = app;
  await page.click('.tab[data-tab="students"]');
  await page.click("#stAddToggle");
  await page.fill("#stAddName", "Мария Иванова");
  await page.fill("#stAddCls", "7");
  await page.click("#stAddSave");
  await page.waitForFunction(() => /одним словом/.test(document.querySelector("#stAddMsg").textContent));
  await page.fill("#stAddName", "маша");
  await page.fill("#stAddCls", "7");
  await page.fill("#stAddRate", "1700");
  await page.click("#stAddSave");
  await page.waitForSelector('.student-card[data-student="Маша, 7 класс"]');
  const prof = (await app.db())[statePath].studentProfiles["Маша, 7 класс"];
  assert.equal(prof.manual, true);
  assert.equal(prof.rate, 1700);
  assert.match(await page.textContent('.student-card[data-student="Маша, 7 класс"]'), /добавлен вручную/);
  assert.match(await page.textContent('.student-card[data-student="Маша, 7 класс"]'), /1\s700 ₽/);
  // дубль не создаётся
  await page.click("#stAddToggle");
  await page.fill("#stAddName", "Анна");
  await page.fill("#stAddCls", "6");
  await page.click("#stAddSave");
  await page.waitForFunction(() => /уже есть/.test(document.querySelector("#stAddMsg").textContent));
  // есть в выдаче доступа
  await page.waitForSelector("#akStudent");
  assert.ok((await page.$$eval("#akStudent option", (o) => o.map((x) => x.value))).includes("Маша, 7 класс"));
  // заметка сохраняется и не стирает «ручные» поля
  const card = page.locator('.student-card[data-student="Маша, 7 класс"]');
  await card.locator(".pf-notes").fill("Новенькая");
  await card.locator("[data-pf-save]").click();
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector('.student-card[data-student="Маша, 7 класс"] .pf-msg').textContent));
  const prof2 = (await app.db())[statePath].studentProfiles["Маша, 7 класс"];
  assert.equal(prof2.manual, true);
  assert.equal(prof2.rate, 1700);
  assert.equal(prof2.notes, "Новенькая");

  // Занятие для нового ученика: есть в списке, ставка подставляется
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  await page.selectOption("#mStudent", "Маша 7 класс");
  await page.fill("#mDate", "2026-09-26");
  await page.fill("#mTime", "12:00");
  await page.click("#mCreate");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  await page.locator("#fcRoot .fc-event", { hasText: "Маша 7 класс" }).click();
  await page.waitForSelector("#mMark");
  assert.equal(await page.isDisabled("#mMark"), false, "ставка найдена — можно отметить");
  assert.equal(await page.getAttribute("#mAmount", "placeholder"), "1700");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("удалить ученика из таблицы: будущие занятия и доступы убраны, прошлые — остаются; можно вернуть", async () => {
  const PK = "parent_key_anna_student_0000000003";
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Анна, 6 класс", createdAt: 1, active: true };
  seed[statePath].studentProfiles = { "Анна, 6 класс": { callUrl: "https://t.me/x", notes: "n" } };
  const app = await openImported({ seed });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  await page.click('.tab[data-tab="students"]');
  await page.locator('.student-card[data-student="Анна, 6 класс"] .student-head').click();
  await page.click('.student-card[data-student="Анна, 6 класс"] [data-st-delete]');
  await page.waitForSelector("#delConfirm");
  const warn = await page.textContent("#modal");
  assert.match(warn, /будущие занятия: 2/);
  assert.match(warn, /доступы родителей\/учеников: 1/);
  assert.match(warn, /прошедшие занятия \(4\)/);
  assert.match(warn, /строку в самой таблице удали вручную/);
  await page.click("#delConfirm");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  const db = await app.db();
  assert.equal(db[L("anna5")], undefined, "будущее удалено");
  assert.equal(db[L("anna6")], undefined);
  assert.ok(db[L("anna3")], "прошедшее осталось");
  assert.ok(db[statePath].marks.anna3, "отметка «Провёл» осталась");
  assert.equal(db[`parentAccess/${PK}`], undefined, "кабинет родителя закрыт");
  assert.equal(db[`teacherSpaces/${T}/accessKeys/${PK}`].active, false);
  assert.equal(db[statePath].studentChannels["Анна, 6 класс"], undefined);
  assert.deepEqual(db[statePath].studentProfiles["Анна, 6 класс"].hidden, true);
  assert.equal(db[statePath].studentProfiles["Анна, 6 класс"].notes, undefined, "заметки удалены");
  assert.equal(await page.$('.student-card[data-student="Анна, 6 класс"]'), null, "нет в списке");
  assert.equal((await page.$$eval("#akStudent option", (o) => o.map((x) => x.value))).includes("Анна, 6 класс"), false);
  // Вернуть
  await page.click("#stAddToggle");
  await page.fill("#stAddName", "Анна");
  await page.fill("#stAddCls", "6");
  await page.click("#stAddSave");
  await page.waitForSelector('.student-card[data-student="Анна, 6 класс"]');
  const back = (await app.db())[statePath].studentProfiles["Анна, 6 класс"];
  assert.equal(back.hidden, false);
  assert.equal(back.manual, false, "снова из таблицы ставок");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("удалить ученика вместе с прошедшими занятиями", async () => {
  const app = await openImported();
  const { page } = app;
  await page.click('.tab[data-tab="students"]');
  await page.locator('.student-card[data-student="Борис, 8 класс"] .student-head').click();
  await page.click('.student-card[data-student="Борис, 8 класс"] [data-st-delete]');
  await page.check("#delPast");
  await page.click("#delConfirm");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  const db = await app.db();
  assert.equal(db[L("boris1")], undefined);
  assert.equal(db[L("boris2")], undefined);
  assert.ok(db[L("anna1")], "чужие занятия не тронуты");
  await app.close();
});

test("пакет заканчивается: плашка, подсветка пакета, метка у ученика, предупреждение родителю", async () => {
  const PK = "parent_key_test_student_0000000001";
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", createdAt: 1, active: true };
  seed[statePath].pkgOverrides = { "Тест, 7 класс": { doneOverride: 7, totalOverride: 8 } };
  const app = await openImported({ seed });
  const { page } = app;
  await page.waitForSelector("#pkgAlert", { state: "visible" });
  assert.match(await page.textContent("#pkgAlert"), /Тест, 7 класс \(пакет: осталось 1\)/);
  await page.click("#pkgAlert");
  await page.waitForSelector(".pkg-card.pkg-warn");
  assert.match(await page.textContent(".pkg-card.pkg-warn"), /Осталось 1 занятие — пора предложить продление/);
  await page.waitForSelector('.student-card[data-student="Тест, 7 класс"] .pkg-tag');
  assert.equal(await page.$('.student-card[data-student="Борис, 8 класс"] .pkg-tag'), null);
  // пакет закончился
  await page.locator('.pkg-card[data-key="Тест, 7 класс"] .pkg-edit-btn').click();
  await page.fill('.pkg-card[data-key="Тест, 7 класс"] .pkg-edit-done', "8");
  await page.click('.pkg-card[data-key="Тест, 7 класс"] .pkg-save-btn');
  await page.waitForSelector(".pkg-card.pkg-over");
  await page.waitForFunction(() => /пакет закончился/.test(document.querySelector("#pkgAlert").textContent));
  // Родитель тоже видит
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.package?.remaining === 0, "витрина с пакетом");
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForSelector(".pkg-note.over");
  assert.match(await cab.textContent(".pkg-note"), /Пакет закончился/);
  await app.close();
});

test("Итоги → Оплата: кто оплатил и кто нет", async () => {
  const app = await openImported();
  const { page } = app;
  // anna3 — проведено и оплачено; serA 14/16 — проведены, не оплачены
  await page.evaluate((p) => {
    const d = JSON.parse(localStorage.__fakeDb);
    d[p].paid = { value: true, by: "parent", at: 1 };
    localStorage.__fakeDb = JSON.stringify(d);
  }, L("anna3"));
  await page.click('.tab[data-tab="summary"]');
  await page.click('.subtab[data-summode="month"]');
  await page.waitForSelector("#payUnpaid .session-row");
  const unpaid = await page.textContent("#payUnpaid");
  const paid = await page.textContent("#payPaid");
  assert.match(unpaid, /Тест, 7 класс/);
  assert.match(unpaid, /2 зан\. · 4\s000 ₽/);
  assert.match(unpaid, /14\.09, 16\.09/);
  assert.equal(/Анна/.test(unpaid), false);
  assert.match(paid, /Анна, 6 класс/);
  assert.match(paid, /1 зан\. · 1\s400 ₽/);
  assert.match(await page.textContent("#payCard"), /Не оплатили — 4\s000 ₽/);
  // отметили оплату у Теста — список обновится
  await page.click('.tab[data-tab="calendar"]');
  await page.click(".fc-prev-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 1/8" }).click();
  await page.click("#mPaid");
  await page.waitForFunction(() => /Отмечено: оплачено/.test(document.querySelector("#mMsg").textContent));
  await page.click("#mClose");
  await page.click('.tab[data-tab="summary"]');
  await page.waitForFunction(() => /1 зан\. · 2\s000 ₽/.test(document.querySelector("#payUnpaid")?.textContent || ""));
  assert.match(await page.textContent("#payPaid"), /Тест, 7 класс/);
  assert.deepEqual(app.errors, []);
  await app.close();
});
