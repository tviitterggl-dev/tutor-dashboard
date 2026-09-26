// Правки по списку из 9 пунктов: зона для файлов ДЗ и вставка из буфера,
// «Оплачено» у родителя (в family.test.mjs), «Отчёт» с рассылкой, замена в
// (было: замена в конец пакета при отмене — убрано, пакет теперь счётчик «Провёл»), клик по карточке, ДЗ к
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

const card = (page, sid) => page.locator(`.pkg-card[data-key="${sid}"]`);
const waitCard = (page, sid, re) => page.waitForFunction(([k, r]) => new RegExp(r).test(document.querySelector(`.pkg-card[data-key="${k}"]`)?.textContent || ""), [sid, re.source], { timeout: 8000 });
const later = (page, min) => page.clock.setFixedTime(new Date(Date.parse(NOW) + min * 60000));

test("пакет: отмена занятия — просто отмена; счётчик и названия других занятий не меняются", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const before = Object.fromEntries(lessonsOf(await app.db(), "Тест, 7 класс").map((l) => [l.id, [l.title, l.startMs]]));
  await openLesson(page, "Тест 7 класс 6/8");
  assert.equal(await page.locator("#mMakeup").count(), 0, "галочки «замена в конец пакета» больше нет");
  await page.click("#mCancelLesson");
  await page.waitForFunction(() => /Занятие отменено/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  assert.equal(db[L(S("20260925"))].status, "cancelled");
  const own = lessonsOf(db, "Тест, 7 класс");
  assert.equal(own.length, 8, "замена не создаётся");
  for (const l of own) assert.deepEqual([l.title, l.startMs], before[l.id], "не тронуто: " + l.id);
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /2 из 8, осталось 6/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("пакет = счётчик «Провёл»: отметка +1, снятие −1; «Исправить»; «Новый пакет» — с нуля; правка суммы не считается повторно", async () => {
  const dialogs = [];
  const app = await openApp({ onDialog: (d) => { dialogs.push(d.message()); return d.type() === "prompt" ? "10" : true; } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /2 из 8/);
  assert.equal(await card(page, "Тест, 7 класс").locator(".pkg-shift-btn").count(), 0, "«Сдвинуть номера» больше нет");
  // «Исправить»: проведено 3
  await later(page, 1);
  await card(page, "Тест, 7 класс").locator(".pkg-edit-btn").click();
  await card(page, "Тест, 7 класс").locator(".pkg-edit-done").fill("3");
  await card(page, "Тест, 7 класс").locator(".pkg-save-btn").click();
  await waitCard(page, "Тест, 7 класс", /3 из 8/);
  let ov = (await app.db())[statePath].pkgOverrides["Тест, 7 класс"];
  assert.deepEqual([ov.manual, ov.doneBase, ov.totalOverride, ov.countFrom], [true, 3, 8, Date.parse(NOW) + 60000]);
  // «Провёл» у занятия (любого, номер в названии не важен) → 4 из 8
  await later(page, 2);
  await openLesson(page, "Тест 7 класс 3/8", true);
  await page.click("#mMark");
  await page.waitForFunction(() => /Провёл \(снять\)/.test(document.querySelector("#mMark").textContent));
  const mark = (await app.db())[statePath].marks[S("20260918")];
  assert.equal(mark.markedAt, Date.parse(NOW) + 120000);
  // правка суммы у отмеченного — время отметки прежнее
  await later(page, 3);
  await page.fill("#mAmount", "1900");
  await page.dispatchEvent("#mAmount", "change");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("__fakeDb"))["teacherSpaces/teacherUid0123456789abcdef/state/main"].marks["serA_20260918T070000Z"].overrideAmount === 1900);
  assert.equal((await app.db())[statePath].marks[S("20260918")].markedAt, Date.parse(NOW) + 120000);
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /4 из 8, осталось 4/);
  // сняли «Провёл» — снова 3 (календарь всё ещё на прошлой неделе)
  await openLesson(page, "Тест 7 класс 3/8");
  await page.click("#mMark");
  await page.waitForFunction(() => /Провёл занятие/.test(document.querySelector("#mMark").textContent));
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /3 из 8, осталось 5/);
  // «Новый пакет» на 10: 0 из 10, старые отметки не считаются
  await later(page, 4);
  await card(page, "Тест, 7 класс").locator(".pkg-new-btn").click();
  await waitCard(page, "Тест, 7 класс", /0 из 10, осталось 10/);
  assert.ok(dialogs.some((m) => /Новый пакет для Тест, 7 класс/.test(m)), JSON.stringify(dialogs));
  // снятие «Провёл» со старого занятия нового пакета не трогает; новая отметка — +1
  await later(page, 5);
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.locator("#lessonsList .lesson", { hasText: "Тест" }).locator(".mark-btn:not(.done):not([disabled])").first().click();
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /1 из 10, осталось 9/);

  // пакет вручную для Анны: 0 из 4 → отметка «Провёл» у её занятия → 1 из 4
  await page.click("#pkgAddBtn");
  await page.fill("#pkgAddName", "Анна");
  await page.fill("#pkgAddCls", "6");
  await page.fill("#pkgAddTotal", "4");
  await page.fill("#pkgAddDone", "0");
  await page.click("#pkgAddSaveBtn");
  await waitCard(page, "Анна, 6 класс", /0 из 4/);
  await later(page, 6);
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  const row = page.locator("#lessonsList .lesson", { hasText: "Анна" }).first();
  await row.locator(".mark-btn").click();
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Анна, 6 класс", /1 из 4, осталось 3/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("переход со старых номеров «k/M»: счётчик сохраняется, номера из названий убираются", async () => {
  const seed = defaultSeed({ legacyPackages: true });
  seed[statePath].pkgOverrides = { "Тест, 7 класс": { doneAdjust: 1, totalOverride: 8 } }; // было «3 из 8»
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await waitFor(async () => (await app.db())[statePath].pkgTitlesClean === 1, "перенос");
  assert.equal((await app.db())[statePath].pkgByMarks, 1);
  const db = await app.db();
  const own = lessonsOf(db, "Тест, 7 класс");
  assert.ok(own.length === 8 && own.every((l) => l.title === "Тест 7 класс"), JSON.stringify(own.map((l) => l.title)));
  assert.ok(lessonsOf(db, "Анна, 6 класс").every((l) => l.title === "Анна 6 класс"), "остальные названия как были");
  const ov = db[statePath].pkgOverrides["Тест, 7 класс"];
  assert.deepEqual([ov.manual, ov.totalOverride, ov.doneBase, ov.countFrom], [true, 8, 3, Date.parse(NOW)]);
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /3 из 8, осталось 5/);
  // дальше — по отметкам
  await later(page, 1);
  await page.click('.tab[data-tab="lessons"]');
  await page.click('.subtab[data-lessonmode="week"]');
  await page.locator("#lessonsList .lesson", { hasText: "Тест" }).locator(".mark-btn:not(.done):not([disabled])").first().click();
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /4 из 8, осталось 4/);
  // окно нового занятия — без нумерации
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  assert.equal(await page.locator("#mPkg").count(), 0);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("«Провёл» снять и поставить снова у занятия, отмеченного до начала пакета, — без двойного счёта", async () => {
  // A) перенос со старых номеров: известно, какие отметки вошли в счётчик (baseIds)
  const seed = defaultSeed({ legacyPackages: true });
  seed[statePath].pkgOverrides = { "Тест, 7 класс": { doneAdjust: 1, totalOverride: 8 } }; // 2 отметки + 1 = 3
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await waitFor(async () => (await app.db())[statePath].pkgTitlesClean === 1, "перенос");
  assert.deepEqual((await app.db())[statePath].pkgOverrides["Тест, 7 класс"].baseIds.sort(), [S("20260914"), S("20260916")]);
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /3 из 8/);
  await later(page, 1);
  await openLesson(page, "Тест 7 класс", true); // пн 14.09 — первое на прошлой неделе, отмечено
  assert.match(await page.textContent("#mMark"), /Провёл \(снять\)/);
  await page.click("#mMark"); // снять
  await page.waitForFunction(() => /Провёл занятие/.test(document.querySelector("#mMark").textContent));
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /2 из 8/);
  await later(page, 2);
  await openLesson(page, "Тест 7 класс");
  await page.click("#mMark"); // поставить снова
  await page.waitForFunction(() => /Провёл \(снять\)/.test(document.querySelector("#mMark").textContent));
  await page.click("#mClose");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /3 из 8/);
  await page.waitForTimeout(1200);
  assert.match(await card(page, "Тест, 7 класс").textContent(), /3 из 8/, "не 4");
  assert.deepEqual(app.errors, []);
  await app.close();

  // B) после «Исправить» неизвестно, что вошло в число: снятие не меняет, повтор не добавляет
  const app2 = await openApp();
  const p2 = app2.page;
  await p2.waitForSelector("#lessonsList .lesson");
  await p2.click('.tab[data-tab="students"]');
  await waitCard(p2, "Тест, 7 класс", /2 из 8/);
  await later(p2, 1);
  await card(p2, "Тест, 7 класс").locator(".pkg-edit-btn").click();
  await card(p2, "Тест, 7 класс").locator(".pkg-edit-done").fill("5");
  await card(p2, "Тест, 7 класс").locator(".pkg-save-btn").click();
  await waitCard(p2, "Тест, 7 класс", /5 из 8/);
  for (const step of [2, 3]) { // снять, затем поставить снова
    await later(p2, step);
    await openLesson(p2, "Тест 7 класс 1/8", step === 2);
    await p2.click("#mMark");
    await p2.waitForFunction((on) => new RegExp(on ? "Провёл \\(снять\\)" : "Провёл занятие").test(document.querySelector("#mMark").textContent), step === 3);
    await p2.click("#mClose");
    await p2.click('.tab[data-tab="students"]');
    await p2.waitForTimeout(1200);
    assert.match(await card(p2, "Тест, 7 класс").textContent(), /5 из 8/, "шаг " + step);
  }
  assert.equal((await app2.db())[statePath].marks[S("20260914")].markedAt < Date.parse(NOW) + 60000, true, "вернулось прежнее время отметки");
  // новая отметка другого занятия — +1
  await later(p2, 4);
  await openLesson(p2, "Тест 7 класс 3/8");
  await p2.click("#mMark");
  await p2.waitForFunction(() => /Провёл \(снять\)/.test(document.querySelector("#mMark").textContent));
  await p2.click("#mClose");
  await p2.click('.tab[data-tab="students"]');
  await waitCard(p2, "Тест, 7 класс", /6 из 8/);
  assert.deepEqual(app2.errors, []);
  await app2.close();
});

test("перенос прервался после сохранения счётчиков: при следующем открытии названия дочищаются, счётчики не пересчитываются", async () => {
  // шаг 1 уже сделан (счётчик «5 из 8» и флаг сохранены), шаг 2 (названия) — нет
  const seed = defaultSeed({ legacyPackages: true });
  seed[statePath].pkgByMarks = 1;
  seed[statePath].pkgOverrides = { "Тест, 7 класс": { manual: true, totalOverride: 8, doneBase: 5, countFrom: Date.parse(NOW) } };
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await waitFor(async () => (await app.db())[statePath].pkgTitlesClean === 1, "названия дочищены");
  const db = await app.db();
  assert.ok(lessonsOf(db, "Тест, 7 класс").every((l) => l.title === "Тест 7 класс"));
  assert.deepEqual(db[statePath].pkgOverrides["Тест, 7 класс"], { manual: true, totalOverride: 8, doneBase: 5, countFrom: Date.parse(NOW) }, "счётчик не тронут (не пересчитан по номерам)");
  await page.click('.tab[data-tab="students"]');
  await waitCard(page, "Тест, 7 класс", /5 из 8/);
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
  assert.equal(n[0].title, "Отчёт о занятии");
  // родитель видит сообщение с отчётом
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForFunction(() => /Разобрали дроби/.test(document.querySelector("#notices")?.textContent || ""));
  assert.equal(await cab.textContent("#notices .notice-head"), "Отчёт о занятии");
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
