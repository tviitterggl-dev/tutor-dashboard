// Семья сама предлагает время ДОПОЛНИТЕЛЬНОГО занятия: заявка «book» в
// канал ученика → учитель подтверждает (занятие создаётся) или отказывает.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";   // родитель «Тест, 7 класс»
const SK = "student_key_test_student_000000002";   // ученик «Тест, 7 класс»
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const statePath = `teacherSpaces/${T}/state/main`;

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
async function openFamily(opts = {}) {
  const seed = defaultSeed();
  const k = (role, createdAt) => ({ role, studentId: "Тест, 7 класс", label: "", createdAt, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", 1);
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", 2);
  if (opts.editSeed) opts.editSeed(seed);
  const dialogs = [];
  const app = await openApp({ seed, onDialog: opts.onDialog || ((d) => { dialogs.push(d.message()); return opts.answer ?? true; }), viewport: opts.viewport });
  await waitFor(async () => { const db = await app.db(); return db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`]; }, "витрины");
  app.dialogs = dialogs;
  app.base = app.page.url().replace(/\/index\.html.*$/, "");
  return app;
}
// teacherOffline: страница учителя уходит — проверяем сам кабинет семьи
// (учитель, пока открыт, сразу разбирает заявки из канала)
async function openCabinet(app, hash, viewport, teacherOffline = true) {
  if (teacherOffline && /index\.html/.test(app.page.url())) await app.page.goto(app.base + "/cabinet.html");
  const cab = await app.context.newPage();
  if (viewport) await cab.setViewportSize(viewport);
  cab.errors = [];
  cab.on("pageerror", (e) => cab.errors.push(String(e)));
  cab.on("dialog", (d) => d.accept());
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + "/cabinet.html" + hash);
  await cab.waitForSelector("#pane-lessons .lesson");
  return cab;
}
const books = (db) => Object.entries(db).filter(([p, d]) => p.startsWith("channels/") && d.type === "book").map(([p, d]) => ({ path: p, ...d }));
const at = (s) => Date.parse(s + "+03:00");
// заявка через форму на вкладке «Занятия»
async function proposeViaForm(cab, date, time, dur, comment) {
  await cab.click("#bookBtn");
  await cab.waitForSelector("#bDate");
  await cab.fill("#bDate", date);
  await cab.fill("#bTime", time);
  if (dur) await cab.selectOption("#bDur", String(dur));
  if (comment != null) await cab.fill("#bComment", comment);
  await cab.click("#bSend");
}

test("кабинет: «Предложить время нового занятия» — проверка времени, отправка, видно в «Заявках» и календаре", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK}`);
  assert.match(await cab.textContent("#bookBtn"), /Предложить время нового занятия/);
  await cab.click("#bookBtn");
  await cab.waitForSelector("#bDate");
  assert.equal(await cab.inputValue("#bDur"), "60", "длительность — как у последнего занятия ученика");
  const tryAt = async (date, time, re) => {
    await cab.fill("#bDate", date);
    await cab.fill("#bTime", time);
    await cab.click("#bSend");
    await cab.waitForFunction((src) => new RegExp(src).test(document.querySelector("#mMsg").textContent), re.source);
  };
  await tryAt("2026-09-29", "15:00", /занято/);            // у Анны
  await tryAt("2026-09-28", "10:00", /ваше другое занятие/); // своё (7/8)
  await tryAt("2026-09-23", "12:00", /в будущем/);          // прошло
  await tryAt("2026-11-30", "12:00", /Так далеко/);         // за окном ±4 недели
  assert.equal(books(await app.db()).length, 0, "ничего не ушло");
  await cab.selectOption("#bDur", "90");
  await cab.fill("#bComment", "На этой неделе контрольная — можно ещё одно?");
  await tryAt("2026-09-29", "12:00", /Заявка отправлена/);
  const [b] = books(await app.db());
  assert.equal(b.by, "parent");
  assert.equal(b.newStartMs, at("2026-09-29T12:00:00"));
  assert.equal(b.newEndMs, at("2026-09-29T13:30:00"));
  assert.equal(b.comment, "На этой неделе контрольная — можно ещё одно?");
  assert.ok(typeof b.lessonId === "string" && b.lessonId.length > 8);
  assert.equal((await app.db())[L(b.lessonId)], undefined, "id — новый, не чьё-то занятие");
  await cab.click("#mClose");
  // «Заявки»: ждёт ответа — «Новое занятие», время и комментарий; точка на вкладке
  await cab.waitForSelector('.ctab[data-ctab="requests"] .dot');
  await cab.click('.ctab[data-ctab="requests"]');
  const pend = await cab.textContent("#pane-requests");
  assert.match(pend, /Новое занятие[\s\S]*ждёт ответа[\s\S]*Вт, 29 сентября, 12:00–13:30/i);
  assert.match(pend, /контрольная/);
  // календарь: «призрак» заявки на неделе 28.09
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-view");
  await cab.click("#cal .fc-next-button");
  await cab.waitForSelector("#cal .fc-event.ghost");
  assert.match(await cab.textContent("#cal .fc-event.ghost"), /новое занятие/);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("кабинет: пустое место в календаре → та же форма с датой и временем; у ученика тоже", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#s=${SK}`, { width: 1100, height: 900 });
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-timeGridWeek-view");
  await cab.click("#cal .fc-next-button");
  await cab.waitForTimeout(200);
  // ср 30.09, 14:00–15:00: зажать и провести по пустому месту
  const col = await cab.locator('#cal .fc-timegrid-col[data-date="2026-09-30"]').boundingBox();
  const s14 = cab.locator('#cal .fc-timegrid-slot-lane[data-time="14:00:00"]');
  await s14.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const r14 = await s14.boundingBox();
  const r1430 = await cab.locator('#cal .fc-timegrid-slot-lane[data-time="14:30:00"]').boundingBox();
  const x = col.x + col.width / 2;
  await cab.mouse.move(x, r14.y + 3);
  await cab.mouse.down();
  await cab.mouse.move(x, r1430.y + 5, { steps: 5 });
  await cab.mouse.move(x, r1430.y + r1430.height - 3, { steps: 3 });
  await cab.mouse.up();
  await cab.waitForSelector("#bDate");
  assert.equal(await cab.inputValue("#bDate"), "2026-09-30");
  assert.equal(await cab.inputValue("#bTime"), "14:00");
  assert.equal(await cab.inputValue("#bDur"), "60");
  await cab.click("#bSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  const [b] = books(await app.db());
  assert.deepEqual([b.by, b.newStartMs, b.newEndMs], ["student", at("2026-09-30T14:00:00"), at("2026-09-30T15:00:00")]);
  assert.equal("comment" in b, false, "пустой комментарий не отправляется");
  assert.deepEqual(cab.errors, []);
  await app.close();
});
