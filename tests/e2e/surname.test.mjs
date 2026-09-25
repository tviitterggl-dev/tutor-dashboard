// Фамилия как дополнительный признак ученика: две «Маши, 7 класс»,
// показ фамилии везде, старые ученики и занятия — как были.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T } from "./harness.mjs";

after(shutdown);
const statePath = `teacherSpaces/${T}/state/main`;
const lessonsOf = (db) => Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/lessons/`)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));

async function addStudent(page, name, surname, cls, rate) {
  if (!(await page.isVisible("#stAddForm"))) await page.click("#stAddToggle");
  await page.fill("#stAddName", name);
  await page.fill("#stAddSurname", surname);
  await page.fill("#stAddCls", String(cls));
  await page.fill("#stAddRate", rate == null ? "" : String(rate));
  await page.click("#stAddSave");
}
async function createLesson(page, studentValue, date, time) {
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  await page.selectOption("#mStudent", studentValue);
  await page.fill("#mDate", date);
  await page.fill("#mTime", time);
  await page.click("#mCreate");
  await page.waitForSelector("#modalBack", { state: "hidden" });
}

test("фамилия: две «Маши, 7 класс» — разные ученики со своими ставками и занятиями", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');

  await addStudent(page, "Маша", "", 7, 1500);
  await page.waitForSelector('.student-card[data-student="Маша, 7 класс"]');
  // вторая Маша без фамилии — нельзя, с подсказкой
  await addStudent(page, "Маша", "", 7, 1900);
  await page.waitForFunction(() => /уже есть.*укажи фамилию/.test(document.querySelector("#stAddMsg").textContent));
  // с фамилией — можно (регистр поправится сам)
  await addStudent(page, "маша", "иванова", 7, 1900);
  await page.waitForSelector('.student-card[data-student="Маша Иванова, 7 класс"]');
  let profs = (await app.db())[statePath].studentProfiles;
  assert.equal(profs["Маша Иванова, 7 класс"].surname, "Иванова");
  assert.equal(profs["Маша Иванова, 7 класс"].rate, 1900);
  assert.equal(profs["Маша, 7 класс"].rate, 1500, "первая Маша не тронута");
  assert.match(await page.innerText('.student-card[data-student="Маша Иванова, 7 класс"] .name'), /Маша Иванова/);
  // и снова та же — отказ
  await addStudent(page, "Маша", "Иванова", 7, null);
  await page.waitForFunction(() => /уже есть/.test(document.querySelector("#stAddMsg").textContent));
  // ошибка в фамилии
  await addStudent(page, "Даша", "Ivanova", 7, null);
  await page.waitForFunction(() => /Фамилия — одним словом/.test(document.querySelector("#stAddMsg").textContent));

  // В окне занятия — обе, с фамилией в подписи
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  const opts = await page.$$eval("#mStudent option", (o) => o.map((x) => [x.value, x.textContent]));
  assert.ok(opts.some(([v, t]) => v === "Маша 7 класс" && t === "Маша, 7 класс"));
  assert.ok(opts.some(([v, t]) => v === "Маша Иванова 7 класс" && t === "Маша Иванова, 7 класс"));
  await page.keyboard.press("Escape");
  await page.waitForSelector("#modalBack", { state: "hidden" });

  await createLesson(page, "Маша Иванова 7 класс", "2026-09-25", "16:00");
  await createLesson(page, "Маша 7 класс", "2026-09-25", "18:00");
  const ls = lessonsOf(await app.db()).filter((l) => /^Маша/.test(l.title));
  const iv = ls.find((l) => l.title === "Маша Иванова 7 класс");
  const plain = ls.find((l) => l.title === "Маша 7 класс");
  assert.ok(iv && plain, JSON.stringify(ls.map((l) => l.title)));
  assert.equal(iv.studentId, "Маша Иванова, 7 класс");
  assert.equal(plain.studentId, "Маша, 7 класс");

  // Ставка своя у каждой
  for (const [text, rate] of [["Маша Иванова 7 класс", "1900"], ["Маша 7 класс", "1500"]]) {
    await page.locator("#fcRoot .fc-event", { has: page.locator(".fc-event-title", { hasText: new RegExp(`^${text}$`) }) }).first().click();
    await page.waitForSelector("#mAmount");
    assert.equal(await page.getAttribute("#mAmount", "placeholder"), rate, text);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#modalBack", { state: "hidden" });
  }
  // В списке занятий — «Маша Иванова, 7 класс»
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.waitForFunction(() => /Маша Иванова, 7 класс/.test(document.querySelector("#lessonsList").innerText));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("фамилия у старого ученика: только показ — названия занятий и связи не меняются", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  const before = lessonsOf(await app.db()).filter((l) => l.studentId === "Анна, 6 класс").map((l) => [l.id, l.title]);
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Анна, 6 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-surname").fill("петрова");
  await card.locator("[data-pf-save]").click();
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector('.student-card[data-student="Анна, 6 класс"] .pf-msg').textContent));
  const db = await app.db();
  assert.equal(db[statePath].studentProfiles["Анна, 6 класс"].surname, "Петрова");
  assert.deepEqual(lessonsOf(db).filter((l) => l.studentId === "Анна, 6 класс").map((l) => [l.id, l.title]), before, "занятия не тронуты");
  assert.match(await card.locator(".name").innerText(), /Анна Петрова/);
  // В календаре и списке — с фамилией
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.waitForFunction(() => [...document.querySelectorAll("#fcRoot .fc-event")].some((e) => /Анна Петрова 6 класс/.test(e.textContent)));
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.waitForFunction(() => /Анна Петрова, 6 класс/.test(document.querySelector("#lessonsList").innerText));
  // Ставка находится как раньше
  assert.match(await page.innerText("#lessonsList"), /Анна Петрова, 6 класс/);
  assert.equal(/ставка не найдена/.test(await page.locator("#lessonsList .lesson", { hasText: "Анна Петрова" }).first().innerText()), false);
  // Убрать фамилию — снова «Анна, 6 класс»
  await page.click('.tab[data-tab="students"]');
  await card.locator(".student-head").click().catch(() => {});
  if (!(await card.locator(".pf-surname").isVisible())) await card.locator(".student-head").click();
  await card.locator(".pf-surname").fill("");
  await card.locator("[data-pf-save]").click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("__fakeDb"))[`teacherSpaces/teacherUid0123456789abcdef/state/main`].studentProfiles["Анна, 6 класс"].surname) === "");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("фамилия в идентификаторе: смена фамилии переименовывает занятия; кабинет показывает «Имя Фамилия»", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  await addStudent(page, "Маша", "Иванова", 7, 1900);
  await page.waitForSelector('.student-card[data-student="Маша Иванова, 7 класс"]');
  await createLesson(page, "Маша Иванова 7 класс", "2026-09-25", "16:00");
  // доступ родителю
  await page.click('.tab[data-tab="students"]');
  await page.selectOption("#akStudent", "Маша Иванова, 7 класс");
  await page.click("#akIssue");
  await page.waitForSelector("#freshLink");
  assert.match(await page.textContent("#accessBody .banner"), /Маша Иванова, 7 класс/);
  const key = (await page.textContent("#freshLink")).match(/#p=([A-Za-z0-9_-]+)$/)[1];
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem("__fakeDb"))[`parentAccess/${k}`], key);
  let view = (await app.db())[`parentAccess/${key}`];
  assert.equal(view.studentLabel, "Маша Иванова, 7 класс");
  assert.equal(view.lessons.length, 1);

  // смена фамилии → переименование (с подтверждением)
  const card = page.locator('.student-card[data-student="Маша Иванова, 7 класс"]');
  if (!(await card.locator(".pf-surname").isVisible())) await card.locator(".student-head").click();
  await card.locator(".pf-surname").fill("Смирнова");
  await card.locator("[data-pf-save]").click();
  await page.waitForSelector('.student-card[data-student="Маша Смирнова, 7 класс"]');
  const db = await app.db();
  const l = lessonsOf(db).find((x) => /^Маша/.test(x.title));
  assert.equal(l.title, "Маша Смирнова 7 класс");
  assert.equal(l.studentId, "Маша Смирнова, 7 класс");
  assert.equal(db[statePath].studentProfiles["Маша Иванова, 7 класс"], undefined);
  assert.equal(db[statePath].studentProfiles["Маша Смирнова, 7 класс"].rate, 1900);
  assert.equal(db[`teacherSpaces/${T}/accessKeys/${key}`].studentId, "Маша Смирнова, 7 класс", "доступ переехал");
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem("__fakeDb"))[`parentAccess/${k}`].studentLabel === "Маша Смирнова, 7 класс", key);

  // кабинет родителя: заголовок с фамилией, занятие на месте
  const cab = await app.context.newPage();
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${key}`);
  await cab.waitForFunction(() => /Маша Смирнова, 7 класс/.test(document.querySelector("#subtitle").textContent));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("пакет вручную: с фамилией — отдельный пакет, без — как раньше", async () => {
  const dialogs = [];
  const app = await openApp({ onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  const add = async (name, surname, cls) => {
    if (!(await page.isVisible("#pkgAddForm"))) await page.click("#pkgAddBtn");
    await page.fill("#pkgAddName", name);
    await page.fill("#pkgAddSurname", surname);
    await page.fill("#pkgAddCls", String(cls));
    await page.click("#pkgAddSaveBtn");
  };
  await add("Маша", "", 7);
  await page.waitForFunction(() => /Маша, 7 класс/.test(document.querySelector("#packagesList").innerText));
  await add("Маша", "", 7);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(dialogs.some((m) => /уже есть.*фамилию/.test(m)), JSON.stringify(dialogs));
  await add("Маша", "Иванова", 7);
  await page.waitForFunction(() => /Маша Иванова, 7 класс/.test(document.querySelector("#packagesList").innerText));
  const ov = (await app.db())[statePath].pkgOverrides;
  assert.ok(ov["Маша, 7 класс"]?.manual && ov["Маша Иванова, 7 класс"]?.manual, JSON.stringify(Object.keys(ov)));
  await app.close();
});
