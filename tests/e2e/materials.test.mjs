// «Доска» и «Материалы» — две разные вещи. Доска — одна постоянная ссылка
// (profile.accessUrl, в витрине boardUrl), материалы — список ссылок с
// необязательными названиями (profile.materials, в витрине materials, до 10;
// общий materials.js). Учитель ведёт их в карточке ученика; видны у занятий
// учителю и в кабинете семьи.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { devices } from "playwright";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";
import { validView } from "../stubs/rules-check.js";

after(shutdown);
const Materials = createRequire(import.meta.url)("../../materials.js");
const PK = "parent_key_test_student_0000000001";
const S = `teacherSpaces/${T}/state/main`;
const SID = "Тест, 7 класс";

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
function seedWithKey() {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: SID, label: "", createdAt: 1, active: true, revokedAt: null };
  return seed;
}
const card = (page) => page.locator(`.student-card[data-student="${SID}"]`);
async function openCard(page) {
  await page.click('.tab[data-tab="students"]');
  await card(page).locator(".student-head").click();
  await card(page).locator("[data-mat-add]").waitFor();
}
async function addMat(page, title, url) {
  await card(page).locator("[data-mat-add]").click();
  const row = card(page).locator(".pf-mat-row").last();
  await row.locator(".pf-mat-title").fill(title);
  await row.locator(".pf-mat-url").fill(url);
}
const save = async (page) => card(page).locator("[data-pf-save]").click();
const msgText = (page) => card(page).locator(".pf-msg").textContent();

test("Materials.clean: всё, что уходит в витрину, проходит правила (validView)", () => {
  const junk = [{ url: " HTTPS://a.ru/x ", title: "  Учебник  " }, { url: "javascript:alert(1)" }, { url: "http://" }, { url: "https://b.ru/a b" },
    { url: "https://c.ru/" + "x".repeat(600) }, { url: "https://d.ru", title: "т".repeat(200) }, null, "https://e.ru", { url: "https://f.ru", title: 5, extra: 1 },
    ...Array.from({ length: 15 }, (_, i) => ({ url: `https://g.ru/${i}` }))];
  const out = Materials.clean(junk);
  assert.equal(out.length, 10, "не больше 10");
  assert.deepEqual(out[0], { url: "https://a.ru/x", title: "Учебник" });
  assert.equal(out.some((m) => /javascript|\s/.test(m.url)), false);
  assert.ok(validView({ v: 1, role: "parent", lessons: [], busy: [], materials: out }), "правила пропускают");
});

test("карточка ученика: «Доска» и список «Материалы» — добавить, убрать, ошибки, не больше 10", async () => {
  const app = await openApp({ seed: seedWithKey() });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await openCard(page);
  assert.match(await card(page).textContent(), /Доска \(постоянная ссылка/);
  await card(page).locator(".pf-access").fill("https://miro.com/app/board/abc");
  await addMat(page, "Учебник", "https://disk.yandex.ru/d/book");
  await addMat(page, "Лишнее", "https://example.org/remove-me");
  await addMat(page, "", "https://docs.google.com/doc1");
  // убрать ненужную (вторую)
  await card(page).locator(".pf-mat-row").nth(1).locator("[data-mat-del]").click();
  assert.equal(await card(page).locator(".pf-mat-row").count(), 2);
  // название без ссылки — ошибка, ничего не сохраняется
  await addMat(page, "Без ссылки", "");
  await save(page);
  await page.waitForFunction((s) => /нет ссылки/.test(document.querySelector(`.student-card[data-student="${s}"] .pf-msg`).textContent), SID);
  await card(page).locator(".pf-mat-row").last().locator(".pf-mat-url").fill("ftp://old");
  await save(page);
  await page.waitForFunction((s) => /должна начинаться с https/.test(document.querySelector(`.student-card[data-student="${s}"] .pf-msg`).textContent), SID);
  assert.equal((await app.db())[S].studentProfiles?.[SID]?.materials, undefined, "с ошибкой не сохраняется");
  await card(page).locator(".pf-mat-row").last().locator("[data-mat-del]").click();
  // пустая строка просто пропускается
  await card(page).locator("[data-mat-add]").click();
  await save(page);
  await page.waitForFunction((s) => /Сохранено/.test(document.querySelector(`.student-card[data-student="${s}"] .pf-msg`).textContent), SID);
  const prof = (await app.db())[S].studentProfiles[SID];
  assert.equal(prof.accessUrl, "https://miro.com/app/board/abc");
  assert.deepEqual(prof.materials, [{ url: "https://disk.yandex.ru/d/book", title: "Учебник" }, { url: "https://docs.google.com/doc1" }]);
  assert.match(await card(page).locator(".agg").textContent(), /доска · материалы 2/);
  // не больше 10
  for (let i = 0; i < 8; i++) await addMat(page, "М" + i, `https://example.org/${i}`);
  await card(page).locator("[data-mat-add]").click();
  assert.equal(await card(page).locator(".pf-mat-row").count(), 10);
  assert.match(await msgText(page), /не больше 10/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("черновик материалов не пропадает, когда список учеников перерисовывается", async () => {
  const app = await openApp({ seed: seedWithKey() });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await openCard(page);
  await addMat(page, "Черновик", "https://example.org/draft");
  await page.evaluate(() => document.querySelector('.tab[data-tab="students"]').click()); // перерисовка (как фоновая)
  await card(page).locator(".pf-mat-row").first().waitFor();
  assert.equal(await card(page).locator(".pf-mat-row .pf-mat-title").inputValue(), "Черновик");
  assert.equal(await card(page).locator(".pf-mat-row .pf-mat-url").inputValue(), "https://example.org/draft");
  await app.close();
});

test("у занятия: «доска» и «материалы N» в карточке (без «изменить»), в окне — доска и все материалы; витрина и кабинет семьи", async () => {
  const seed = seedWithKey();
  seed[S].studentProfiles = Object.assign({}, seed[S].studentProfiles, {
    [SID]: Object.assign({}, (seed[S].studentProfiles || {})[SID], { callUrl: "https://telemost.yandex.ru/j/1", accessUrl: "https://miro.com/app/board/abc",
      materials: [{ url: "https://disk.yandex.ru/d/book", title: "Учебник" }, { url: "https://docs.google.com/doc1" }, { url: "https://example.org/3", title: "Задачи" }] }),
  });
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.subtab[data-lessonmode="week"]');
  const row = page.locator("#lessonsList .lesson", { hasText: SID }).first();
  await row.waitFor();
  assert.equal(await page.locator("#lessonsList button.edit-link").count(), 0, "кнопки «изменить» больше нет");
  assert.equal(await row.locator("a.edit-link", { hasText: "доска" }).getAttribute("href"), "https://miro.com/app/board/abc");
  assert.equal((await row.locator(".mats > summary").textContent()).trim(), "материалы 3");
  // раскрыть список — окно занятия НЕ открывается
  await row.locator(".mats > summary").click();
  assert.deepEqual(await row.locator(".mats .mat-link").allTextContents(), ["Учебник", "docs.google.com", "Задачи"]);
  await page.waitForTimeout(400);
  assert.equal(await page.isVisible("#modalBack"), false, "клик по «материалы» не открывает окно");
  // клик по самой карточке — открывает
  await row.locator(".lesson-name").click();
  await page.waitForSelector("#modalBack", { state: "visible" });
  assert.equal(await page.getAttribute("#mBoardOpen", "href"), "https://miro.com/app/board/abc");
  assert.equal(await page.locator("#modal .mat-pill").count(), 3);
  assert.match(await page.textContent("#modal"), /Созвон, доска и материалы/);
  await page.click("#modal .modal-x");
  // витрина: доска и материалы (только ссылки и названия)
  const v = await waitFor(async () => { const x = (await app.db())[`parentAccess/${PK}`]; return x && x.materials && x.materials.length === 3 && x; }, "витрина с материалами");
  assert.equal(v.boardUrl, "https://miro.com/app/board/abc");
  assert.deepEqual(v.materials[0], { url: "https://disk.yandex.ru/d/book", title: "Учебник" });
  // кабинет семьи (телефон): у ближайшего занятия — «Доска →» и «Материалы 3»; в окне — все три
  const base = page.url().replace(/\/index\.html.*$/, "");
  await page.goto(base + "/cabinet.html");
  const cab = await app.context.newPage();
  await cab.setViewportSize(devices["iPhone 13"].viewport);
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(base + "/cabinet.html#p=" + PK);
  await cab.waitForSelector("#pane-lessons .lesson.next");
  const next = cab.locator("#pane-lessons .lesson.next");
  assert.equal((await next.locator(".mats > summary").textContent()).trim(), "Материалы 3");
  await next.locator(".mats > summary").click();
  assert.equal(await next.locator(".mat-link").count(), 3);
  await cab.waitForTimeout(300);
  assert.equal(await cab.isVisible("#modalBack"), false, "раскрытие материалов не открывает окно занятия");
  const overflow = await cab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "на телефоне ничего не вылезает вбок");
  await next.locator(".lesson-when").click();
  await cab.waitForSelector("#modal .mat-pill");
  assert.equal(await cab.locator("#modal .mat-pill").count(), 3);
  assert.equal(await cab.getAttribute("#mBoard", "href"), "https://miro.com/app/board/abc");
  await cab.close();
  await app.close();
});

test("без материалов — ни «материалы», ни пустых блоков; доска по-прежнему видна", async () => {
  const seed = seedWithKey();
  seed[S].studentProfiles = Object.assign({}, seed[S].studentProfiles, { [SID]: Object.assign({}, (seed[S].studentProfiles || {})[SID], { accessUrl: "https://miro.com/app/board/abc" }) });
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.subtab[data-lessonmode="week"]');
  const row = page.locator("#lessonsList .lesson", { hasText: SID }).first();
  await row.waitFor();
  assert.equal(await row.locator(".mats").count(), 0);
  assert.equal(await row.locator("a.edit-link", { hasText: "доска" }).count(), 1);
  const v = await waitFor(async () => (await app.db())[`parentAccess/${PK}`], "витрина");
  assert.deepEqual(v.materials, []);
  await app.close();
});
