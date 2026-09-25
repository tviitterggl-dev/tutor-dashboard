// Дизайн по стиль-гайду: цвета обеих тем, шрифты, скругления и переключатель
// темы во вкладке «Ещё» у учителя, родителя и ученика.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";
const SK = "student_key_test_student_000000002";
const LIGHT_BG = "rgb(247, 245, 240)"; // #F7F5F0
const DARK_BG = "rgb(28, 29, 33)";     // #1C1D21

function seed() {
  const s = defaultSeed();
  const k = (role, createdAt) => ({ role, studentId: "Тест, 7 класс", label: "", createdAt, active: true, revokedAt: null });
  s[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", 1);
  s[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", 2);
  return s;
}
async function waitViews(app) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const db = await app.db();
    if (db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`]) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("витрины не опубликованы");
}
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
// после переключения цвета меняются плавно (~250 мс) — ждём конечный цвет
const waitBg = (page, color) => page.waitForFunction((c) => getComputedStyle(document.body).backgroundColor === c, color, { timeout: 3000 });
const themeState = (page) => page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-theme"),
  saved: localStorage.getItem("theme"),
  checked: document.querySelector("[data-theme-toggle]")?.checked,
  bar: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute("content"), m.getAttribute("media")]),
}));

test("по умолчанию тема как в системе: светлая и тёмная палитры стиль-гайда", async () => {
  const light = await openApp({ colorScheme: "light" });
  await light.page.waitForSelector("#lessonsList .lesson");
  assert.equal(await bg(light.page), LIGHT_BG);
  assert.equal((await themeState(light.page)).attr, null);
  await light.close();

  const dark = await openApp({ colorScheme: "dark" });
  await dark.page.waitForSelector("#lessonsList .lesson");
  assert.equal(await bg(dark.page), DARK_BG);
  assert.equal(await dark.page.evaluate(() => getComputedStyle(document.querySelector(".tab.active")).backgroundColor), "rgb(201, 162, 75)", "золото — активная вкладка");
  assert.deepEqual(dark.errors, []);
  await dark.close();
});

test("учитель: «Ещё» → ползунок темы; выбор запоминается; «Как в системе» сбрасывает", async () => {
  const app = await openApp({ colorScheme: "light" });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="more"]');
  await page.waitForSelector("#view-more .theme-switch");
  let st = await themeState(page);
  assert.equal(st.checked, false);
  assert.equal(await page.isVisible("[data-theme-system]"), false, "пока выбор не сделан — кнопки сброса нет");

  await page.click("#view-more .theme-switch");
  st = await themeState(page);
  assert.deepEqual([st.attr, st.saved, st.checked], ["dark", "dark", true]);
  await waitBg(page, DARK_BG);
  assert.ok(st.bar.every(([c, m]) => c === "#1C1D21" && m === null), "полоса браузера тоже тёмная: " + JSON.stringify(st.bar));
  assert.match(await page.textContent("[data-theme-state]"), /выбрано на этом устройстве/);

  // после перезагрузки — тёмная, хотя система светлая
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await waitBg(page, DARK_BG);

  // обратно на светлую вручную, потом «Как в системе»
  await page.click('.tab[data-tab="more"]');
  await page.click("#view-more .theme-switch");
  st = await themeState(page);
  assert.deepEqual([st.attr, st.saved, st.checked], ["light", "light", false]);
  await page.click("[data-theme-system]");
  st = await themeState(page);
  assert.deepEqual([st.attr, st.saved], [null, null]);
  assert.deepEqual(st.bar, [["#F7F5F0", "(prefers-color-scheme: light)"], ["#1C1D21", "(prefers-color-scheme: dark)"]]);
  await waitBg(page, LIGHT_BG);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("родитель и ученик: ползунок темы во вкладке «Ещё», выбор запоминается", async () => {
  const app = await openApp({ seed: seed(), colorScheme: "dark" });
  await waitViews(app);
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  for (const hash of [`#p=${PK}`, `#s=${SK}`]) {
    const cab = await app.context.newPage();
    const errors = [];
    cab.on("pageerror", (e) => errors.push(String(e)));
    await cab.clock.setFixedTime(new Date(NOW));
    await cab.goto(base + "/cabinet.html" + hash);
    await cab.waitForSelector("#pane-lessons .lesson");
    await waitBg(cab, DARK_BG);
    await cab.click('.ctab[data-ctab="more"]');
    await cab.waitForSelector("#pane-more .theme-switch");
    assert.equal((await themeState(cab)).checked, true);
    await cab.click("#pane-more .theme-switch");
    await waitBg(cab, LIGHT_BG);
    await cab.reload();
    await cab.waitForSelector("#pane-lessons .lesson");
    await waitBg(cab, LIGHT_BG);
    await cab.click('.ctab[data-ctab="more"]');
    await cab.click("[data-theme-system]");
    await waitBg(cab, DARK_BG);
    assert.deepEqual(errors, []);
    await cab.close();
  }
  await app.close();
});

test("шрифты и скругления по стиль-гайду", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const css = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      h1: cs("h1").fontFamily, body: cs("body").fontFamily, tab: cs(".tab").fontFamily,
      card: cs(".card").borderRadius, cardBorder: cs(".card").borderTopStyle, cardShadow: cs(".card").boxShadow,
      input: cs(".rate-field input").borderRadius, mark: cs(".mark-btn").borderRadius,
    };
  });
  assert.match(css.h1, /^"?Spectral/);
  assert.match(css.body, /^"?Manrope/);
  assert.match(css.tab, /^"?Manrope/);
  assert.equal(css.card, "16px");
  assert.equal(css.cardBorder, "none", "карточки — тень вместо обводки");
  assert.notEqual(css.cardShadow, "none");
  assert.equal(css.input, "8px");
  assert.equal(css.mark, "999px", "«Провёл» — таблетка");
  // модалка — 20px
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  await page.waitForSelector("#modalBack", { state: "visible" });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#modalBack .modal")).borderRadius), "20px");
  assert.match(await page.evaluate(() => getComputedStyle(document.querySelector(".modal h2")).fontFamily), /^"?Spectral/);
  await app.close();
});

test("«Ещё» → резервная копия: JSON со всеми данными и таблица для Excel", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="more"]');
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupJsonBtn")]);
  assert.match(dl.suggestedFilename(), /^zanyatiya-backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await (await import("node:fs")).promises.readFile(await dl.path(), "utf8"));
  const db = await app.db();
  const lessonPaths = Object.keys(db).filter((p) => p.startsWith(`teacherSpaces/${T}/lessons/`));
  assert.equal(data.app, "tutor-dashboard");
  assert.equal(data.lessons.length, lessonPaths.length, "все занятия");
  assert.ok(data.lessons.every((l) => l.id && l.title && l.startMs));
  assert.deepEqual(data.state.marks, db[`teacherSpaces/${T}/state/main`].marks, "отметки «Провёл»");
  assert.deepEqual(Object.keys(data.state.studentProfiles).sort(), ["Анна, 6 класс", "Борис, 8 класс", "Тест, 7 класс"]);
  assert.ok(Array.isArray(data.accessKeys) && Array.isArray(data.requests));
  assert.equal(data.account, "teacher@example.org");
  await page.waitForFunction(() => /Готово: занятий/.test(document.querySelector("#backupMsg").textContent));

  const [csvDl] = await Promise.all([page.waitForEvent("download"), page.click("#backupCsvBtn")]);
  assert.match(csvDl.suggestedFilename(), /\.csv$/);
  const csv = await (await import("node:fs")).promises.readFile(await csvDl.path(), "utf8");
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM для Excel");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Дата;Время;Минут;Ученик;Название;Статус;Провёл;Сумма, ₽;Оплачено;Отчёт;Пояснение;Файлы ДЗ");
  assert.equal(lines.length - 1, lessonPaths.length);
  assert.ok(lines.some((l) => /^2026-09-14;10:00;60;Тест, 7 класс;Тест 7 класс 1\/8;проведено;да;2000;/.test(l)), lines.slice(0, 4).join("\n"));
  assert.deepEqual(app.errors, []);
  await app.close();
});
