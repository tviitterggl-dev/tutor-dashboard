// Правки по списку из 9 пунктов: зона для файлов ДЗ и вставка из буфера,
// «Оплачено» у родителя (в family.test.mjs), «Отчёт» с рассылкой, замена в
// конец пакета при отмене, «Провёл» ↔ пакет, клик по карточке, ДЗ к
// следующему занятию, шапка, поле отчёта.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { devices } from "playwright";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";
const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const S = (d) => `serA_${d}T070000Z`; // «Тест 7 класс k/8», 10:00 МСК
const lessonsOf = (db, sid) => Object.entries(db).filter(([p, d]) => p.startsWith(`teacherSpaces/${T}/lessons/`) && (!sid || d.studentId === sid)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
async function openLesson(page, text, prevWeek) {
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  if (prevWeek) { await page.click(".fc-prev-button"); await page.waitForTimeout(200); }
  await page.locator("#fcRoot .fc-event", { hasText: text }).first().click();
  await page.waitForSelector("#mClose");
}
// «перетащить» файл в зону (как это делает браузер)
const dropFile = (page, zoneSel, name, type = "image/jpeg") => page.evaluate(([sel, n, t]) => {
  const dt = new DataTransfer();
  dt.items.add(new File(["x"], n, { type: t }));
  document.querySelector(sel).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [zoneSel, name, type]);
// вставить «скриншот» из буфера (Ctrl+V)
const pasteImage = (page) => page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(["png"], "image.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});

test("п.4: отмена занятия пакета — замена в конец, номера следующих −1, даты не двигаются; «Вернуть» откатывает", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const before = Object.fromEntries(lessonsOf(await app.db(), "Тест, 7 класс").map((l) => [l.id, l.startMs]));
  await openLesson(page, "Тест 7 класс 6/8");
  assert.equal(await page.isChecked("#mMakeup"), true, "по умолчанию — с заменой");
  await page.click("#mCancelLesson");
  await page.waitForFunction(() => /Замена —/.test(document.querySelector("#mMsg").textContent));
  let db = await app.db();
  const own = lessonsOf(db, "Тест, 7 класс");
  assert.equal(db[L(S("20260925"))].status, "cancelled");
  assert.equal(db[L(S("20260928"))].title, "Тест 7 класс 6/8");
  assert.equal(db[L(S("20260930"))].title, "Тест 7 класс 7/8");
  const mk = own.find((l) => l.makeupFor === S("20260925"));
  assert.ok(mk, "замена создана");
  assert.equal(mk.title, "Тест 7 класс 8/8");
  assert.equal(mk.start, "2026-10-07T10:00:00+03:00", "через неделю после последнего, в то же время");
  assert.equal(mk.status, "planned");
  for (const [id, s] of Object.entries(before)) assert.equal(db[L(id)].startMs, s, "даты не двигаются: " + id);
  // пакет по-прежнему 8 занятий, 2 проведено
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await page.waitForFunction(() => /2 из 8, осталось 6/.test(document.querySelector("#packagesList").textContent));

  // «Вернуть занятие» — всё назад
  await openLesson(page, "Тест 7 класс 6/8");
  await page.waitForFunction(() => document.querySelector("#mRestore"));
  await page.click("#mRestore");
  await page.waitForFunction(() => /Замена в конце пакета убрана/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.equal(db[L(S("20260925"))].status, "planned");
  assert.equal(db[L(S("20260928"))].title, "Тест 7 класс 7/8");
  assert.equal(db[L(S("20260930"))].title, "Тест 7 класс 8/8");
  assert.equal(db[L(mk.id)], undefined, "замена удалена");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("п.4: без галочки — просто отмена, остальные занятия не трогаются", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await openLesson(page, "Тест 7 класс 6/8");
  await page.uncheck("#mMakeup");
  await page.click("#mCancelLesson");
  await page.waitForFunction(() => /Занятие отменено/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  assert.equal(db[L(S("20260928"))].title, "Тест 7 класс 7/8");
  assert.equal(lessonsOf(db, "Тест, 7 класс").length, 8, "замены нет");
  await app.close();
});

test("п.5: «Провёл» сам меняет счётчик пакета — и после ручной правки, и у пакета, добавленного вручную", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.pkg-card[data-key="Тест, 7 класс"]');
  await page.waitForFunction(() => /2 из 8/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"]')?.textContent || ""));
  // ручная правка: «проведено 3»
  await card.locator(".pkg-edit-btn").click();
  await card.locator(".pkg-edit-done").fill("3");
  await card.locator(".pkg-save-btn").click();
  await page.waitForFunction(() => /3 из 8/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"]').textContent));
  assert.equal((await app.db())[statePath].pkgOverrides["Тест, 7 класс"].doneAdjust, 1);
  // отметка «Провёл» у занятия 3/8 — пакет сам становится 4 из 8
  await openLesson(page, "Тест 7 класс 3/8", true);
  await page.click("#mMark");
  await page.waitForFunction(() => /Провёл \(снять\)/.test(document.querySelector("#mMark").textContent));
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await page.waitForFunction(() => /4 из 8, осталось 4/.test(document.querySelector('.pkg-card[data-key="Тест, 7 класс"]').textContent), null, { timeout: 8000 });

  // пакет вручную для Анны: 0 из 4 → отметка «Провёл» у её занятия → 1 из 4
  await page.click("#pkgAddBtn");
  await page.fill("#pkgAddName", "Анна");
  await page.fill("#pkgAddCls", "6");
  await page.fill("#pkgAddTotal", "4");
  await page.fill("#pkgAddDone", "0");
  await page.click("#pkgAddSaveBtn");
  await page.waitForFunction(() => /0 из 4/.test(document.querySelector('.pkg-card[data-key="Анна, 6 класс"]')?.textContent || ""));
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  const row = page.locator("#lessonsList .lesson", { hasText: "Анна" }).first();
  await row.locator(".mark-btn").click();
  await page.click('.tab[data-tab="students"]');
  await page.waitForFunction(() => /1 из 4, осталось 3/.test(document.querySelector('.pkg-card[data-key="Анна, 6 класс"]').textContent), null, { timeout: 8000 });
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("п.6, п.8, п.9: карточка открывается по клику; в шапке нет почты и «выйти»; поле отчёта — во всю ширину и большое на телефоне", async () => {
  const d = devices["iPhone 13"];
  const app = await openApp({ viewport: d.viewport, userAgent: d.userAgent, isMobile: true, hasTouch: true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  // п.8
  assert.equal(await page.$("#logoutBtn"), null, "кнопки «выйти» в шапке нет");
  assert.equal(await page.isVisible("#userBadge"), false, "почта не в шапке");
  assert.equal(await page.evaluate(() => document.querySelector("#calBadge").closest("#view-more") !== null), true);
  await page.click('.tab[data-tab="more"]');
  assert.match(await page.textContent("#userBadge"), /teacher@example\.org/);
  assert.match(await page.textContent("#calBadge"), /Занятия: в дашборде/);
  assert.equal(await page.isVisible("#syncAlert"), false);
  // п.6: клик по названию в карточке (не по «изменить») открывает занятие
  await page.click('.tab[data-tab="lessons"]');
  await page.locator("#lessonsList .lesson .lesson-name").first().click();
  await page.waitForSelector("#mReport");
  // п.9
  const size = await page.evaluate(() => {
    const r = document.querySelector("#mReport").getBoundingClientRect();
    const box = document.querySelector("#mReport").closest(".section").getBoundingClientRect();
    return { w: r.width, box: box.width, h: r.height, vh: innerHeight, font: getComputedStyle(document.querySelector("#mReport")).fontSize };
  });
  assert.ok(Math.abs(size.w - size.box) < 2, `во всю ширину: ${size.w} из ${size.box}`);
  assert.ok(size.h >= size.vh * 0.4, `высота на телефоне ${size.h} при экране ${size.vh}`);
  assert.equal(size.font, "16px", "без автоприближения на iPhone");
  assert.equal(await page.textContent("#mSaveReport"), "Отчёт");
  await app.close();
});

test("п.3: «Отчёт» — публикация и уведомление родителю/ученику с текстом отчёта", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true };
  const app = await openApp({ seed });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  await openLesson(page, "Тест 7 класс 5/8");
  await page.fill("#mReport", "Разобрали дроби, ДЗ — №12–15.");
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /Отчёт опубликован и отправлен: 1 кабинет/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  assert.equal(db[L(S("20260923"))].report, "Разобрали дроби, ДЗ — №12–15.");
  const n = Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/notifications/`)).map(([, d]) => d);
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].mode, n[0].target.scope, n[0].target.studentId, n[0].push, n[0].source], ["now", "student", "Тест, 7 класс", true, "report"]);
  assert.match(n[0].text, /^Отчёт по занятию Ср 23\.09\.2026, 10:00–11:00:\nРазобрали дроби/);
  // родитель видит сообщение с отчётом
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForFunction(() => /Разобрали дроби/.test(document.querySelector("#notices")?.textContent || ""));
  // повторное нажатие без изменений — второго уведомления нет
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /изменений нет/.test(document.querySelector("#mMsg").textContent));
  assert.equal(Object.keys(await app.db()).filter((p) => p.startsWith(`teacherSpaces/${T}/notifications/`)).length, 1);
  await app.close();
});

test("п.7 и п.1 (учитель): ДЗ к следующему занятию ученика (тёзки не путаются); перетаскивание и вставка скриншота", async () => {
  const seed = defaultSeed();
  const sp = seed[statePath].studentProfiles;
  sp["Маша, 7 класс"] = { name: "Маша", cls: 7, rate: 1500 };
  sp["Маша Иванова, 7 класс"] = { name: "Маша", surname: "Иванова", cls: 7, rate: 1900 };
  const mk = (id, title, sid, iso) => { const s = Date.parse(iso); seed[L(id)] = { title, studentId: sid, startMs: s, endMs: s + 3600000, start: iso, end: iso, status: "planned" }; };
  mk("m1", "Маша 7 класс", "Маша, 7 класс", "2026-09-25T12:00:00+03:00");
  mk("iv1", "Маша Иванова 7 класс", "Маша Иванова, 7 класс", "2026-09-25T14:00:00+03:00");
  mk("iv2", "Маша Иванова 7 класс", "Маша Иванова, 7 класс", "2026-09-26T09:00:00+03:00");
  mk("m2", "Маша 7 класс", "Маша, 7 класс", "2026-09-26T16:00:00+03:00");
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  // Маша (без фамилии) 25.09 → следующее её — 26.09 16:00 (а не Ивановой 26.09 09:00)
  await openLesson(page, "Маша 7 класс");
  await page.waitForSelector('#mNextHw [data-drop="mNextHwFile"]');
  assert.match(await page.textContent("#mNextHw"), /26\.09\.2026, 16:00/);
  await dropFile(page, '[data-drop="mNextHwFile"]', "задание.jpg");
  await page.waitForFunction(() => /ДЗ к занятию/.test(document.querySelector("#mMsg").textContent));
  let db = await app.db();
  assert.deepEqual((db[L("m2")].homework || []).map((h) => h.name), ["задание.jpg"]);
  assert.equal(db[L("iv2")].homework, undefined, "Ивановой не досталось");
  // перетаскивание в «этому занятию» и вставка скриншота из буфера
  await dropFile(page, '[data-drop="mHwFile"]', "фото.jpg");
  await page.waitForFunction(() => /Файл загружен/.test(document.querySelector("#mMsg").textContent));
  await pasteImage(page);
  await waitFor(async () => ((await app.db())[L("m1")].homework || []).length === 2, "скриншот загружен");
  db = await app.db();
  const names = db[L("m1")].homework.map((h) => h.name);
  assert.equal(names[0], "фото.jpg");
  assert.match(names[1], /^скриншот-.*\.png$/);
  // Иванова: следующее — её 26.09 09:00
  await page.click("#mClose");
  await openLesson(page, "Маша Иванова 7 класс");
  await page.waitForFunction(() => /26\.09\.2026, 09:00/.test(document.querySelector("#mNextHw")?.textContent || ""));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("п.1 (кабинет): перетаскивание в окне занятия и вставка скриншота во вкладке «ДЗ»", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true };
  const app = await openApp({ seed });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  // файл либо ещё в канале, либо кабинет учителя уже перенёс его в занятие
  const hwItems = async () => {
    const db = await app.db();
    const inChannel = Object.entries(db).filter(([p, d]) => p.startsWith(`channels/${ch}/items/`) && d.type === "homework").map(([, d]) => d.file.name);
    const inLessons = lessonsOf(db, "Тест, 7 класс").flatMap((l) => (l.homework || []).map((h) => h.name));
    return inChannel.concat(inLessons);
  };
  await cab.locator("#pane-lessons .lesson").first().click();
  await cab.waitForSelector('[data-drop="mFile"]');
  await dropFile(cab, '[data-drop="mFile"]', "решение.jpg");
  await cab.waitForFunction(() => /Файл загружен/.test(document.querySelector("#mMsg").textContent));
  await waitFor(async () => (await hwItems()).includes("решение.jpg"), "ДЗ в канале");
  await cab.click("#mClose");
  await cab.click('.ctab[data-ctab="hw"]');
  await cab.waitForSelector('[data-drop="hwFile"]');
  await pasteImage(cab);
  await waitFor(async () => (await hwItems()).some((n) => /^скриншот-.*\.png$/.test(n)), "скриншот в канале");
  await app.close();
});
