import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp, shutdown, T } from "./harness.mjs";

after(shutdown);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const statePath = `teacherSpaces/${T}/state/main`;

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Не дождались: " + what);
}

test("в коде сайта нет ключа учителя (ни старого, ни какого-либо)", () => {
  for (const f of ["index.html", "cabinet.html"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.equal(/const TEACHER_ID = "/.test(src), false, f);
    const oldKeyMentions = src.split("2Vv0fLQi3MXbEgqpwlmWk5E1KnVRz9-q").length - 1;
    assert.equal(oldKeyMentions, 0, f + " не должен содержать старый ключ");
  }
});

test("выдача ключа родителю → кабинет → отзыв", async () => {
  const app = await openApp();
  const { page } = app;
  await app.page.waitForSelector("#appRoot", { state: "visible" });

  // Отчёт и домашка у занятия Теста, чтобы увидеть их в кабинете
  await page.evaluate((T) => {
    const db = JSON.parse(localStorage.__fakeDb);
    const p = `teacherSpaces/${T}/lessons/serA_20260921T070000Z`;
    db[p].report = "Решали уравнения <script>alert(1)</script>";
    db[p].homework = [{ url: "https://res.cloudinary.com/x/hw.pdf", name: "дз.pdf" }, { url: "javascript:alert(1)", name: "плохая" }];
    localStorage.__fakeDb = JSON.stringify(db);
  }, T);

  await page.click('.tab[data-tab="students"]');
  await page.waitForSelector("#akIssue");
  await page.selectOption("#akStudent", "Тест, 7 класс");
  await page.selectOption("#akRole", "parent");
  await page.fill("#akLabel", "мама");
  await page.click("#akIssue");
  await page.waitForSelector("#freshLink");
  const link = await page.textContent("#freshLink");
  const m = link.match(/cabinet\.html#p=([A-Za-z0-9_-]+)$/);
  assert.ok(m, link);
  const key = m[1];
  assert.ok(key.length >= 32);

  const db = await app.db();
  const reg = db[`teacherSpaces/${T}/accessKeys/${key}`];
  assert.equal(reg.role, "parent");
  assert.equal(reg.studentId, "Тест, 7 класс");
  assert.equal(reg.label, "мама");
  assert.equal(reg.active, true);
  const view = db[`parentAccess/${key}`];
  assert.equal(view.v, 1);
  assert.equal(view.role, "parent");
  assert.equal(view.lessons.length, 8, "все 8 занятий пакета");
  assert.deepEqual(view.package, { done: 2, total: 8, remaining: 6 });
  const serialized = JSON.stringify(view);
  for (const other of ["Анна", "Борис", "Пробное"]) assert.equal(serialized.includes(other), false, `в витрине нет имени «${other}»`);
  assert.ok(view.busy.length > 0, "чужие занятия есть как «занято»");

  // Открываем кабинет в той же «базе» (тот же origin → тот же localStorage)
  const cab = await app.context.newPage();
  const cabErrors = [];
  cab.on("pageerror", (e) => cabErrors.push(String(e)));
  let alerted = false;
  cab.on("dialog", async (d) => { alerted = true; await d.dismiss(); });
  await cab.clock.setFixedTime(new Date("2026-09-24T12:00:00+03:00"));
  await cab.goto(link.replace(/^.*\/cabinet\.html/, page.url().replace(/\/index\.html.*$/, "") + "/cabinet.html"));
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-event.own");
  assert.equal(await cab.textContent("#title"), "Кабинет родителя");
  assert.equal(await cab.textContent("#subtitle"), "Тест, 7 класс");
  await cab.click('.ctab[data-ctab="lessons"]');
  await cab.click('[data-filter="past"]'); // отчёт — у прошедшего урока, в «Истории»
  const body = await cab.textContent("body");
  assert.match(body, /Проведено 2 из 8/);
  assert.match(body, /Решали уравнения <script>/, "отчёт показан как текст");
  assert.equal(body.includes("Анна"), false);
  assert.equal(await cab.$$eval('a[href^="javascript"]', (a) => a.length), 0, "опасные ссылки отброшены");
  assert.equal(await cab.$$eval('#pane-lessons a[href^="https://res.cloudinary.com"]', (a) => a.length), 1);
  assert.equal(await cab.$$eval('#pane-hw a[href^="https://res.cloudinary.com"]', (a) => a.length), 1, "файл виден и во вкладке ДЗ");
  const evs = await cab.$$eval("#cal .fc-event", (els) => els.map((e) => ({ cls: e.className, text: e.textContent })));
  assert.ok(evs.some((e) => /\bown\b/.test(e.cls)), "свои занятия выделены");
  assert.ok(evs.some((e) => /\bbusy\b/.test(e.cls) && /занято/.test(e.text)), "чужие — «занято»");
  assert.ok(evs.filter((e) => /\bbusy\b/.test(e.cls)).every((e) => !/Анна|Борис|Пробное/.test(e.text)), "без имён");
  assert.equal(new URL(cab.url()).hash, `#p=${key}`, "ключ остаётся в адресе — для «На экран «Домой»»");
  assert.equal(alerted, false);
  assert.deepEqual(cabErrors, []);

  // Отзыв
  await page.click(`[data-key-revoke="${key}"]`);
  await page.waitForFunction(() => /Доступ отозван/.test(document.querySelector("#akMsg").textContent));
  const db2 = await app.db();
  assert.equal(db2[`parentAccess/${key}`], undefined);
  assert.equal(db2[`teacherSpaces/${T}/accessKeys/${key}`].active, false);
  assert.ok(db2[`teacherSpaces/${T}/accessKeys/${key}`].revokedAt);
  assert.match(await page.textContent("table.keys"), /отозван/);
  await cab.reload();
  await cab.waitForFunction(() => /доступ отозван/.test(document.body.textContent));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("кабинет ученика без пакета; изменения учителя попадают в кабинет", async () => {
  const app = await openApp();
  const { page } = app;
  await app.page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="students"]');
  await page.waitForSelector("#akIssue");
  await page.selectOption("#akStudent", "Борис, 8 класс");
  await page.selectOption("#akRole", "student");
  await page.click("#akIssue");
  await page.waitForSelector("#freshLink");
  const key = (await page.textContent("#freshLink")).match(/#s=([A-Za-z0-9_-]+)$/)[1];
  let view = (await app.db())[`studentAccess/${key}`];
  assert.equal(view.role, "student");
  assert.equal(view.package, undefined);

  // Учитель пишет отчёт → витрина обновляется сама
  await page.click('.tab[data-tab="calendar"]');
  await page.locator("#fcRoot .fc-event", { hasText: "Борис 8 класс" }).last().click();
  await page.waitForSelector("#mReport");
  await page.fill("#mReport", "Молодец");
  await page.click("#mSaveReport");
  await waitFor(async () => {
    const v = (await app.db())[`studentAccess/${key}`];
    return v.lessons.some((l) => l.report === "Молодец");
  }, "отчёт в витрине");
  await app.close();
});

test("кабинет без ключа / с неверным ключом", async () => {
  const app = await openApp({ path: "/cabinet.html" });
  await app.page.waitForFunction(() => /личная ссылка/.test(document.body.textContent));
  await app.page.goto(app.page.url().split("#")[0] + "#p=nonexistent_key_000000000000000");
  await app.page.waitForFunction(() => /недействительна/.test(document.body.textContent));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("iPhone: PNG расписания показывается в окне с картинкой, без window.open", async () => {
  const app = await openApp({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.evaluate(() => { window.__opened = 0; window.open = () => { window.__opened++; return null; }; });
  await page.click('.tab[data-tab="schedule"]');
  await page.waitForSelector("#schedTable td.free");
  await page.click("#schedExportBtn");
  await page.waitForSelector("#pngPreview");
  const src = await page.getAttribute("#pngPreview", "src");
  assert.match(src, /^data:image\/png;base64,/);
  assert.ok(src.length > 1000);
  assert.equal(await page.evaluate(() => window.__opened), 0);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("телефон: календарь открывается в виде «день», вкладки помещаются", async () => {
  const app = await openApp({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const { page } = app;
  await app.page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-timeGridDay-view");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, "нет горизонтальной прокрутки страницы: " + overflow);
  await app.close();
});
