// Групповые занятия: по копии занятия на каждого участника (свои «Провёл»,
// пакет, групповая цена, «Оплачено», кабинет) + общее: время, отчёт, ДЗ.
// Календарь, «Итоги»/«Аналитика» (часы, отмены) склеивают копии в одно.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed, lessonDoc } from "./harness.mjs";

after(shutdown);

const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const PK_A = "parent_key_anna_student_0000000003";   // родитель «Анна, 6 класс»
const PK_B = "parent_key_boris_student_000000004";   // родитель «Борис, 8 класс»
const A = "Анна, 6 класс", B = "Борис, 8 класс", TT = "Тест, 7 класс";
const lessonsOf = (db) => Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/lessons/`)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));
const mark = (page, id) => page.evaluate((i) => JSON.parse(localStorage.getItem("__fakeDb"))["teacherSpaces/teacherUid0123456789abcdef/state/main"].marks[i], id);

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
function doc(id, title, startMsk, durMin, extra) {
  const start = new Date(startMsk + "+03:00");
  const iso = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
  const d = lessonDoc({ id, summary: title, start: { dateTime: iso(start.getTime()) }, end: { dateTime: iso(start.getTime() + durMin * 60000) } });
  return Object.assign(d, { source: "app" }, extra);
}
// Группа «Мини»: Анна + Борис, вторники 17:00 (22.09 — прошло, 29.09, 06.10), серия serG.
function groupSeed() {
  const seed = defaultSeed();
  const st = seed[statePath];
  st.studentProfiles[A].groupRate = 1000;
  st.studentProfiles[B].groupRate = 1200;
  st.groups = { grp_mini: { name: "Мини", members: [A, B], callUrl: null, updatedAt: 1 } };
  st.pkgOverrides[A] = { manual: true, totalOverride: 4, doneBase: 0, countFrom: Date.parse(NOW) - 3600000, hidden: false };
  const occ = [["2026-09-22T17:00:00", "go_1"], ["2026-09-29T17:00:00", "go_2"], ["2026-10-06T17:00:00", "go_3"]];
  occ.forEach(([when, go], i) => {
    const g = { groupId: "grp_mini", groupOcc: go, recurrenceId: "serG" };
    seed[L(`gA${i + 1}`)] = doc(`gA${i + 1}`, "Анна 6 класс", when, 60, g);
    seed[L(`gB${i + 1}`)] = doc(`gB${i + 1}`, "Борис 8 класс", when, 60, g);
  });
  seed[L("gA2")].homework = [{ url: "https://res.cloudinary.com/demo/raw/upload/teacher-hw.pdf", name: "задачи.pdf", by: "teacher" }];
  seed[L("gB2")].homework = [{ url: "https://res.cloudinary.com/demo/raw/upload/teacher-hw.pdf", name: "задачи.pdf", by: "teacher" }];
  const k = (studentId) => ({ role: "parent", studentId, label: "", createdAt: 1, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK_A}`] = k(A);
  seed[`teacherSpaces/${T}/accessKeys/${PK_B}`] = k(B);
  return seed;
}
async function openGroupEvent(page, nextWeek) {
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  if (nextWeek) { await page.click(".fc-next-button"); await page.waitForTimeout(200); }
  await page.locator("#fcRoot .fc-event", { hasText: "Группа «Мини»" }).first().click();
  await page.waitForSelector("#gMembers");
}
const row = (page, name) => page.locator("#gMembers .g-member", { hasText: name });

test("создание группы: «Группа» → несколько учеников; копия на каждого; в календаре одно событие", async () => {
  const dialogs = [];
  const app = await openApp({ onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click("#fcAddBtn");
  await page.waitForSelector("#modal #mStudent");
  await page.check("#mGroup");
  assert.equal(await page.isVisible("#mStudent"), false, "одиночный выбор ученика спрятан");
  await page.fill("#mGroupName", "Мини");
  await page.check(`#mMembers [data-member="${A}"]`);
  await page.fill("#mDate", "2026-09-29");
  await page.fill("#mTime", "17:00");
  await page.click("#mCreate");
  await page.waitForFunction(() => /хотя бы двух/.test(document.querySelector("#mMsg").textContent), null, { timeout: 3000 });
  await page.check(`#mMembers [data-member="${B}"]`);
  await page.check("#mRepeat");
  await page.fill("#mCount", "3");
  await page.click("#mCreate");
  await page.waitForSelector("#modalBack", { state: "hidden" });

  const db = await app.db();
  const groups = db[statePath].groups;
  const [gid, g] = Object.entries(groups)[0];
  assert.deepEqual([g.name, g.members], ["Мини", [A, B]]);
  const created = lessonsOf(db).filter((l) => l.groupId === gid).sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  assert.equal(created.length, 6, "3 занятия × 2 ученика");
  assert.deepEqual(created.map((l) => `${l.date} ${l.time} ${l.studentId}`), [
    `2026-09-29 17:00 ${A}`, `2026-09-29 17:00 ${B}`, `2026-10-06 17:00 ${A}`, `2026-10-06 17:00 ${B}`, `2026-10-13 17:00 ${A}`, `2026-10-13 17:00 ${B}`,
  ]);
  assert.deepEqual(created.map((l) => l.title).slice(0, 2), ["Анна 6 класс", "Борис 8 класс"]);
  assert.equal(new Set(created.map((l) => l.groupOcc)).size, 3, "одно groupOcc на время");
  assert.equal(new Set(created.map((l) => l.recurrenceId)).size, 1, "общая серия");
  assert.ok(created[0].recurrenceId);
  // календарь: одно событие на занятие группы
  await page.click(".fc-next-button");
  await page.waitForTimeout(200);
  const evs = await page.locator("#fcRoot .fc-event", { hasText: "Группа «Мини»" }).allTextContents();
  assert.equal(evs.length, 1);
  assert.match(evs[0], /Анна, Борис/);
  assert.equal(await page.locator("#fcRoot .fc-event", { hasText: "Анна 6 класс" }).filter({ hasText: "17:00" }).count(), 0, "копии не видны по отдельности");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("окно группы: «Провёл»/«Оплачено» у каждого свои, групповая цена, пакет ученика, общее ДЗ и отчёт; витрины без чужих имён", async () => {
  const app = await openApp({ seed: groupSeed(), onDialog: () => true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await openGroupEvent(page); // 22.09 17:00 (прошло)
  assert.equal(await page.locator("#gMembers .g-member").count(), 2);
  assert.equal(await row(page, "Анна").locator("[data-g-amount]").getAttribute("placeholder"), "1000", "групповая цена Анны");
  assert.equal(await row(page, "Борис").locator("[data-g-amount]").getAttribute("placeholder"), "1200");
  // «Провёл» — только Анне
  await row(page, "Анна").locator("[data-g-mark]").click();
  await waitFor(async () => (await mark(page, "gA1"))?.marked, "отметка Анны");
  assert.equal((await mark(page, "gA1")).lockedRate, 1000);
  assert.equal(await mark(page, "gB1"), undefined, "у Бориса отметки нет");
  // «Оплачено» — только Борису
  await row(page, "Борис").locator("[data-g-paid]").click();
  await waitFor(async () => (await app.db())[L("gB1")].paid?.value === true, "оплата Бориса");
  let db = await app.db();
  assert.equal(db[L("gA1")].paid, undefined);
  assert.equal(db[L("gA1")].status, "done");
  assert.equal(db[L("gB1")].status, "planned");
  // общее ДЗ: один файл — в обеих копиях
  await page.setInputFiles("#gHwFile", [{ name: "лист.pdf", mimeType: "application/pdf", buffer: Buffer.from("pdf") }]);
  await page.waitForFunction(() => /Файл загружен/.test(document.querySelector("#mMsg").textContent));
  assert.equal(app.calls.cloudinary.length, 1, "загрузка одна");
  db = await app.db();
  const hwA = db[L("gA1")].homework || [], hwB = db[L("gB1")].homework || [];
  assert.equal(hwA.length, 1);
  assert.deepEqual(hwA, hwB);
  // отчёт — обоим
  await page.fill("#gReport", "Решали задачи на проценты");
  await page.click("#gSaveReport");
  await page.waitForFunction(() => /Отчёт опубликован/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.equal(db[L("gA1")].report, "Решали задачи на проценты");
  assert.equal(db[L("gB1")].report, "Решали задачи на проценты");
  const notes = Object.entries(db).filter(([p, n]) => p.startsWith(`teacherSpaces/${T}/notifications/`) && n.source === "report").map(([, n]) => n.target.studentId).sort();
  assert.deepEqual(notes, [A, B]);
  await page.click("#mClose");
  // пакет Анны: +1 (Борису — нет)
  await page.click('.tab[data-tab="students"]');
  await page.waitForFunction(() => /1 из 4/.test(document.querySelector('.pkg-card[data-key="Анна, 6 класс"]')?.textContent || ""));
  // витрины: у Анны — её копия с пометкой «групповое», без Бориса; своё время не «занято»
  await waitFor(async () => { const v = (await app.db())[`parentAccess/${PK_A}`]; return v && v.lessons.some((l) => l.id === "gA1" && l.report); }, "витрина Анны с отчётом");
  db = await app.db();
  const va = db[`parentAccess/${PK_A}`];
  const own = va.lessons.find((l) => l.id === "gA1");
  assert.equal(own.group, true);
  assert.equal(va.lessons.some((l) => /^gB/.test(l.id)), false);
  assert.doesNotMatch(JSON.stringify(va), /Борис|gB\d|grp_mini|Мини/);
  const s1 = Date.parse("2026-09-22T17:00:00+03:00");
  assert.equal(va.busy.some((b) => b.s === s1), false, "своё групповое занятие не «занято»");
  const vb = db[`parentAccess/${PK_B}`];
  assert.equal(vb.lessons.find((l) => l.id === "gB1").paid, true);
  assert.equal(va.lessons.find((l) => l.id === "gA1").paid, false);
  assert.doesNotMatch(JSON.stringify(vb), /Анна|gA\d/);
  // обычное занятие Анны в 15:00 для Бориса — «занято» (одна запись, без имени)
  assert.ok(vb.busy.some((b) => b.s === Date.parse("2026-09-22T15:00:00+03:00")));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("аналитика и «Итоги»: групповое занятие в часах и отменах — один раз, деньги — по каждому участнику", async () => {
  const seed = groupSeed();
  seed[statePath].marks.gA1 = { marked: true, overrideAmount: null, lockedRate: 1000, markedAt: 1, updatedAt: 1 };
  seed[statePath].marks.gB1 = { marked: true, overrideAmount: null, lockedRate: 1200, markedAt: 1, updatedAt: 1 };
  seed[L("gA1")].status = "done"; seed[L("gB1")].status = "done";
  const app = await openApp({ seed });
  const { page } = app;
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("an.")) localStorage.removeItem(k); });
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="analytics"]');
  await page.waitForFunction(() => /отмен \(/.test(document.querySelector("#anTiles").textContent)); // оплаченных нет — график пустой
  // прошедшие с учеником: Тест 5 + Анна 4 + Борис 1 = 10, + группа 22.09 — одно = 11
  assert.match(await page.innerText("#anTiles"), /отмен \(0 из 11\)/);
  const week = await page.$$eval("#anWeekTable tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.equal(week[1][3], "5", "вторники: Анна 01, 08, 15, 22 + группа 22.09 (одна)");
  // «Провёл» за сентябрь: Тест 2×2000 + Анна 1400 + группа 1000 + 1200 = 7600
  const inc = await page.$$eval("#anIncomeTable tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.equal(inc[2][2], "7 600 ₽");
  // «Итоги» за сентябрь: отмечены Тест 14 и 16, Анна 15, группа 22.09 (двое)
  await page.click('.tab[data-tab="summary"]');
  await page.waitForSelector("#statHours");
  await page.click('.subtab[data-summode="month"]');
  await page.waitForFunction(() => /7\s600/.test(document.querySelector("#view-summary").textContent), null, { timeout: 8000 });
  // часов: Тест 2 + Анна 1 + группа 1 (не 2) = 4
  assert.equal(await page.textContent("#statHours"), "4");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("состав группы из карточки ученика: добавить и убрать участника; групповая цена в профиле; смена класса", async () => {
  const dialogs = [];
  const app = await openApp({ seed: groupSeed(), onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  const card = page.locator(`.student-card[data-student="${A}"]`);
  await card.locator(".student-head").click();
  assert.match(await card.textContent(), /Группа «Мини»: Анна, Борис/);
  await card.locator("[data-g-edit]").click();
  await page.waitForSelector("#geSave");
  await page.check(`[data-ge-member="${TT}"]`);
  await page.uncheck(`[data-ge-member="${B}"]`);
  await page.fill("#geCall", "https://telemost.yandex.ru/j/group");
  await page.click("#geSave");
  await page.waitForFunction(() => /Состав сохранён/.test(document.querySelector("#mMsg").textContent));
  assert.ok(dialogs.some((m) => /Убрать из группы: Борис/.test(m)));
  const db = await app.db();
  assert.deepEqual(db[statePath].groups.grp_mini.members, [A, TT]);
  const g = lessonsOf(db).filter((l) => l.groupId === "grp_mini");
  const who = (occ) => g.filter((l) => l.groupOcc === occ).map((l) => l.studentId).sort();
  assert.deepEqual(who("go_1"), [A, B], "прошедшее занятие не меняется");
  assert.deepEqual(who("go_2"), [A, TT]);
  assert.deepEqual(who("go_3"), [A, TT]);
  const t2 = g.find((l) => l.groupOcc === "go_2" && l.studentId === TT);
  assert.equal(t2.title, "Тест 7 класс");
  assert.equal(t2.recurrenceId, "serG");
  assert.deepEqual((t2.homework || []).map((h) => h.name), ["задачи.pdf"], "общее ДЗ учителя — и новому участнику");
  await page.click("#mClose");
  // ссылка группы уходит в кабинет Анны
  await waitFor(async () => (await app.db())[`parentAccess/${PK_A}`]?.lessons.some((l) => l.id === "gA2" && l.callUrl === "https://telemost.yandex.ru/j/group"), "ссылка группы в витрине");
  // групповая цена в профиле Бориса
  const cb = page.locator(`.student-card[data-student="${B}"]`);
  await cb.locator(".student-head").click();
  await cb.locator(".pf-grate").fill("1100");
  await cb.locator("[data-pf-save]").click();
  await waitFor(async () => (await app.db())[statePath].studentProfiles[B].groupRate === 1100, "групповая цена");
  // смена класса Анны — в составе группы новый идентификатор
  const ca = page.locator(`.student-card[data-student="${A}"]`);
  await ca.locator(".student-head").click();
  await ca.locator(".pf-cls").fill("7");
  await ca.locator("[data-pf-save]").click();
  await waitFor(async () => (await app.db())[statePath].groups.grp_mini.members.includes("Анна, 7 класс"), "состав после смены класса");
  assert.deepEqual((await app.db())[statePath].groups.grp_mini.members, ["Анна, 7 класс", TT]);
  // «Распустить группу»: будущие занятия группы удалены, прошедшее осталось, в карточке группы нет
  const ca7 = page.locator(`.student-card[data-student="Анна, 7 класс"]`);
  await ca7.locator("[data-g-edit]").click();
  await page.click("#geDisband");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  const db2 = await app.db();
  assert.equal(db2[statePath].groups.grp_mini, undefined);
  assert.deepEqual(lessonsOf(db2).filter((l) => l.groupId === "grp_mini").map((l) => l.groupOcc).sort(), ["go_1", "go_1"]);
  await page.waitForFunction(() => !/Группа «Мини»/.test(document.querySelector("#studentsRosterList").textContent));
  assert.ok(dialogs.some((m) => /Распустить группа «мини»/i.test(m)));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("перетаскивание группы в календаре переносит всех участников", async () => {
  const app = await openApp({ seed: groupSeed(), onDialog: (d) => /Перенести/.test(d.message()) });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  const ev = page.locator("#fcRoot .fc-event", { hasText: "Группа «Мини»" }).first();
  await ev.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await ev.boundingBox();
  const slotH = (await page.locator(".fc-timegrid-slot-lane").first().boundingBox()).height;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + box.width / 2, box.y + 8 + (i * slotH * 2) / 10); await page.waitForTimeout(20); }
  await page.mouse.up();
  await waitFor(async () => { const db = await app.db(); return db[L("gA1")].status === "rescheduled" && db[L("gB1")].status === "rescheduled"; }, "перенос обеих копий");
  const db = await app.db();
  const a = db[L(db[L("gA1")].rescheduledTo)], b = db[L(db[L("gB1")].rescheduledTo)];
  assert.match(a.time, /^18:/);
  assert.equal(a.time, b.time);
  assert.equal(a.groupOcc, b.groupOcc);
  assert.deepEqual([a.studentId, b.studentId], [A, B]);
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll("#fcRoot .fc-event")].map((e) => e.textContent).filter((x) => /Группа «Мини»/.test(x));
    return t.length === 2 && t.filter((x) => /перенос/.test(x)).length === 1;
  }, null, { timeout: 5000 }); // новое время — одним событием, старое — «перенос»
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("группа: «не придёт» — отмена только для одного; правка «это и следующие» и перенос — для всех, названия свои", async () => {
  const app = await openApp({ seed: groupSeed(), onDialog: () => true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await openGroupEvent(page, true); // 29.09
  await row(page, "Борис").locator("[data-g-skip]").click();
  await page.waitForFunction(() => /Борис: занятие отменено/.test(document.querySelector("#mMsg").textContent));
  let db = await app.db();
  assert.equal(db[L("gB2")].status, "cancelled");
  assert.equal(db[L("gA2")].status, "planned");
  await page.click("#mClose");
  await page.waitForFunction(() => [...document.querySelectorAll("#fcRoot .fc-event")].some((e) => /Борис \(отм\.\)/.test(e.textContent)));
  // «это и следующие»: 18:00 для всей группы
  await page.locator("#fcRoot .fc-event", { hasText: "Группа «Мини»" }).first().click();
  await page.waitForSelector("#gSave");
  await page.fill("#mTime", "18:00");
  await page.selectOption("#mScope", "following");
  await page.click("#gSave");
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.deepEqual(["gA2", "gA3", "gB3"].map((id) => db[L(id)].time), ["18:00", "18:00", "18:00"]);
  assert.deepEqual([db[L("gB2")].time, db[L("gB2")].status], ["18:00", "cancelled"], "отменённая копия двигается вместе с группой и остаётся отменённой");
  assert.deepEqual(["gA2", "gA3", "gB3"].map((id) => db[L(id)].title), ["Анна 6 класс", "Анна 6 класс", "Борис 8 класс"], "названия у каждого свои");
  assert.equal(db[L("gA1")].time, "17:00", "прошлое не трогаем");
  // «вернуть в занятие» у Бориса после сдвига — копия находится
  await page.waitForSelector('#gMembers .g-member:has-text("Борис") [data-g-back]');
  await row(page, "Борис").locator("[data-g-back]").click();
  await page.waitForFunction(() => /Борис: снова в занятии/.test(document.querySelector("#mMsg").textContent));
  assert.equal((await app.db())[L("gB2")].status, "planned");
  // перенос занятия 06.10 на 07.10 18:00 — для всех, с историей
  await page.click("#mClose");
  await page.click(".fc-next-button");
  await page.waitForTimeout(200);
  await page.locator("#fcRoot .fc-event", { hasText: "Группа «Мини»" }).first().click();
  await page.waitForSelector("#gMove");
  await page.fill("#mDate", "2026-10-07");
  await page.click("#gMove");
  await page.waitForFunction(() => /Перенесено для всей группы/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.equal(db[L("gA3")].status, "rescheduled");
  assert.equal(db[L("gB3")].status, "rescheduled");
  const movedA = db[L(db[L("gA3")].rescheduledTo)], movedB = db[L(db[L("gB3")].rescheduledTo)];
  assert.deepEqual([movedA.date, movedA.time, movedA.studentId, movedA.groupId], ["2026-10-07", "18:00", A, "grp_mini"]);
  assert.equal(movedA.groupOcc, movedB.groupOcc);
  assert.notEqual(movedA.groupOcc, "go_3");
  assert.equal(movedB.studentId, B);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("заявка семьи на перенос группового занятия: переносится только этот ученик, уже как личное занятие", async () => {
  const app = await openApp({ seed: groupSeed(), onDialog: () => true });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK_A}`]?.channel, "витрина Анны");
  const base = page.url().replace(/\/index\.html.*$/, "");
  const cab = await app.context.newPage();
  cab.on("dialog", (d) => d.accept());
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(base + `/cabinet.html#p=${PK_A}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  const item = cab.locator(".lesson", { hasText: "29 сентября" }).filter({ hasText: "17:00" }).first();
  assert.match(await item.textContent(), /групповое/);
  assert.doesNotMatch(await cab.textContent("body"), /Борис/);
  await item.click();
  await cab.waitForSelector("#mMove");
  await cab.click("#mMove");
  await cab.fill("#mDate", "2026-10-01");
  await cab.fill("#mTime", "12:00");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector('#requestsList [data-req="approve"]');
  await page.click('#requestsList [data-req="approve"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const db = await app.db();
  assert.equal(db[L("gA2")].status, "rescheduled");
  const moved = db[L(db[L("gA2")].rescheduledTo)];
  assert.deepEqual([moved.date, moved.time, moved.studentId], ["2026-10-01", "12:00", A]);
  assert.equal(moved.groupId, undefined, "ушёл из группы на своё время");
  assert.equal(moved.recurrenceId, null, "и из серии группы");
  assert.equal(db[L("gB2")].status, "planned", "у Бориса занятие на месте");
  assert.equal(db[L("gB2")].time, "17:00");
  assert.deepEqual(app.errors, []);
  await app.close();
});
