// Кабинет: ближайшее занятие выделено, «Подключиться» и «Доска» — только у
// двух ближайших; «Пояснение» к занятию от родителя/ученика → учителю.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";
const SK = "student_key_test_student_000000002";
const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const FIRST = "serA_20260925T070000Z"; // пт 25.09 10:00 — ближайшее у «Тест, 7 класс»

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
async function openFamily() {
  const seed = defaultSeed();
  seed[statePath].studentProfiles["Тест, 7 класс"] = Object.assign({}, seed[statePath].studentProfiles["Тест, 7 класс"], {
    callUrl: "https://telemost.yandex.ru/j/777", accessUrl: "https://miro.com/app/board/xyz",
  });
  const k = (role, createdAt) => ({ role, studentId: "Тест, 7 класс", label: "", createdAt, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", 1);
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", 2);
  const app = await openApp({ seed });
  await waitFor(async () => { const db = await app.db(); return db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`]; }, "витрины");
  app.base = app.page.url().replace(/\/index\.html.*$/, "");
  return app;
}
async function openCabinet(app, hash) {
  const cab = await app.context.newPage();
  cab.errors = [];
  cab.on("pageerror", (e) => cab.errors.push(String(e)));
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + "/cabinet.html" + hash);
  await cab.waitForSelector("#pane-lessons .lesson");
  return cab;
}

test("кабинет: ближайшее выделено, «Подключиться» и «Доска» только у двух ближайших; в окне занятия — обе ссылки", async () => {
  const app = await openFamily();
  for (const hash of [`#p=${PK}`, `#s=${SK}`]) {
    const cab = await openCabinet(app, hash);
    const cards = cab.locator("#pane-lessons .lesson");
    assert.equal(await cards.count(), 3, "три ближайших занятия");
    assert.equal(await cards.nth(0).getAttribute("data-lesson"), FIRST);
    assert.match(await cards.nth(0).getAttribute("class"), /\bnext\b/);
    assert.match(await cards.nth(0).innerText(), /Ближайшее занятие/i);
    assert.equal(await cab.locator("#pane-lessons .lesson.next").count(), 1, "выделено только одно");
    const links = async (i) => cards.nth(i).locator("a").evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.href]));
    assert.deepEqual(await links(0), [["Подключиться к занятию →", "https://telemost.yandex.ru/j/777"], ["Доска →", "https://miro.com/app/board/xyz"]]);
    assert.equal((await links(1)).length, 2, "у следующего тоже");
    assert.deepEqual(await links(2), [], "у остальных ссылок нет");
    // В «Истории» ссылок и выделения нет
    await cab.click('[data-filter="past"]');
    assert.equal(await cab.locator("#pane-lessons .lesson.next, #pane-lessons .lesson a").count(), 0);
    await cab.click('[data-filter="upcoming"]');
    // Окно третьего занятия: и созвон, и доска
    await cards.nth(2).click();
    await cab.waitForSelector("#mCall");
    assert.equal(await cab.getAttribute("#mCall", "href"), "https://telemost.yandex.ru/j/777");
    assert.equal(await cab.getAttribute("#mBoard", "href"), "https://miro.com/app/board/xyz");
    assert.deepEqual(cab.errors, []);
    await cab.close();
  }
  await app.close();
});

test("«Пояснение»: родитель пишет → видно ученику и учителю (в карточке занятия и списке); можно убрать", async () => {
  const app = await openFamily();
  const { page } = app;
  const parent = await openCabinet(app, `#p=${PK}`);
  await parent.locator(`#pane-lessons .lesson[data-lesson="${FIRST}"]`).click();
  await parent.waitForSelector("#mNote");
  assert.equal(await parent.inputValue("#mNote"), "");
  await parent.fill("#mNote", "Хотим разобрать задачи 5–7 из пробника.\nСсылка: https://example.org/probnik");
  await parent.click("#mNoteSave");
  await parent.waitForFunction(() => /Пояснение сохранено/.test(document.querySelector("#mMsg").textContent));
  await parent.click("#mClose");
  assert.match(await parent.locator(`#pane-lessons .lesson[data-lesson="${FIRST}"] .note-line`).innerText(), /разобрать задачи 5–7/);
  // пустое поле у занятия без пояснения — ничего лишнего
  assert.equal(await parent.locator("#pane-lessons .lesson").nth(1).locator(".note-line").count(), 0);

  // Учитель: пояснение переносится в занятие
  const noteOf = async () => (await app.db())[L(FIRST)].familyNote;
  await waitFor(async () => (await noteOf())?.text?.includes("пробника"), "пояснение в занятии");
  assert.equal((await noteOf()).by, "parent");
  // открываем карточку через список «Неделя» во вкладке «Занятия»
  await page.click('.subtab[data-lessonmode="week"]');
  await page.waitForFunction(() => /пояснение/.test(document.querySelector("#lessonsList").innerText));
  const row = page.locator("#lessonsList .lesson", { hasText: "пояснение" }).first();
  await row.locator("button.edit-link").click();
  await page.waitForSelector(".family-note");
  assert.match(await page.innerText(".family-note"), /разобрать задачи 5–7/);
  assert.match(await page.textContent("#modal"), /Пояснение от родителя/);

  // Ученик видит то же пояснение и может его убрать
  const student = await openCabinet(app, `#s=${SK}`);
  await student.clock.setFixedTime(new Date(Date.parse(NOW) + 5 * 60000)); // ученик правит позже
  assert.match(await student.locator(`#pane-lessons .lesson[data-lesson="${FIRST}"] .note-line`).innerText(), /разобрать задачи/);
  await student.locator(`#pane-lessons .lesson[data-lesson="${FIRST}"]`).click();
  await student.waitForSelector("#mNote");
  await student.fill("#mNote", "");
  await student.click("#mNoteSave");
  await student.waitForFunction(() => /Пояснение убрано/.test(document.querySelector("#mMsg").textContent));
  await waitFor(async () => (await noteOf())?.text === "", "пояснение убрано у учителя");
  await student.click("#mClose");
  // кабинет обновляется по данным из базы — даём ему дойти до итогового вида
  await student.waitForFunction((id) => !document.querySelector(`#pane-lessons .lesson[data-lesson="${id}"] .note-line`), FIRST, { timeout: 5000 });
  // старые сообщения чистятся — в канале остаётся одно последнее
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  await waitFor(async () => { const db = await app.db(); return Object.keys(db).filter((p) => p.startsWith(`channels/${ch}/items/`) && db[p].type === "note").length === 1; }, "одно последнее пояснение в канале");
  assert.deepEqual(parent.errors, []);
  assert.deepEqual(student.errors, []);
  await app.close();
});
