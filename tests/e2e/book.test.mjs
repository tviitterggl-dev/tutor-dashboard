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

test("«Предложить время»: занятое время по умолчанию не подставляется; проверка — сразу, при каждом изменении", async () => {
  // Раньше форма подставляла время последнего занятия (завтра, пт 25.09,
  // 10:00 — а это своё занятие 6/8) и говорила «занято» только после
  // «Отправить».
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK}`);
  await cab.click("#bookBtn");
  await cab.waitForSelector("#bDate");
  assert.equal(await cab.inputValue("#bDate"), "2026-09-25");
  assert.equal(await cab.inputValue("#bTime"), "", "занятое время не подставлено");
  assert.match(await cab.textContent("#mMsg"), /Обычное время — 10:00 — в этот день занято/);
  assert.equal(await cab.isDisabled("#bSend"), true);
  // свободное время — предупреждения нет, можно отправить
  await cab.fill("#bDate", "2026-09-29");
  await cab.fill("#bTime", "13:30");
  await cab.waitForFunction(() => !document.querySelector("#mMsg").textContent && !document.querySelector("#bSend").disabled);
  // длительность залезла на чужое занятие (у Анны в 15:00) — сразу предупреждение
  await cab.selectOption("#bDur", "120");
  await cab.waitForFunction(() => /занято/.test(document.querySelector("#mMsg").textContent) && document.querySelector("#bSend").disabled);
  await cab.selectOption("#bDur", "60");
  await cab.waitForFunction(() => !document.querySelector("#mMsg").textContent && !document.querySelector("#bSend").disabled);
  assert.equal(books(await app.db()).length, 0, "пока не нажали — ничего не ушло");
  await cab.close();
  await app.close();
});

test("кабинет: «Предложить время нового занятия» — проверка времени, отправка, видно в «Заявках» и календаре", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK}`);
  assert.match(await cab.textContent("#bookBtn"), /Предложить время нового занятия/);
  await cab.click("#bookBtn");
  await cab.waitForSelector("#bDate");
  assert.equal(await cab.inputValue("#bDur"), "60", "длительность — как у последнего занятия ученика");
  // проблема со временем видна сразу, «Отправить» — выключена (нажимать не нужно)
  const tryAt = async (date, time, re) => {
    await cab.fill("#bDate", date);
    await cab.fill("#bTime", time);
    await cab.waitForFunction((src) => new RegExp(src).test(document.querySelector("#mMsg").textContent), re.source);
    assert.equal(await cab.isDisabled("#bSend"), true, `${date} ${time}: «Отправить» выключена`);
  };
  await tryAt("2026-09-29", "15:00", /занято/);            // у Анны
  await tryAt("2026-09-28", "10:00", /ваше другое занятие/); // своё (7/8)
  await tryAt("2026-09-23", "12:00", /в будущем/);          // прошло
  await tryAt("2026-11-30", "12:00", /Так далеко/);         // за окном ±4 недели
  assert.equal(books(await app.db()).length, 0, "ничего не ушло");
  await cab.selectOption("#bDur", "90");
  await cab.fill("#bComment", "На этой неделе контрольная — можно ещё одно?");
  await cab.fill("#bDate", "2026-09-29");
  await cab.fill("#bTime", "12:00");
  await cab.waitForFunction(() => !document.querySelector("#bSend").disabled && !document.querySelector("#mMsg").textContent);
  await cab.click("#bSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
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

// ---------- кабинет учителя ----------
// заявка «с другого устройства»: пишем сообщение прямо в канал (как кабинет)
async function putBook(app, ch, id, fields) {
  await app.page.evaluate(({ ch, id, data }) => {
    const db = JSON.parse(localStorage.__fakeDb);
    db[`channels/${ch}/items/${id}`] = data;
    localStorage.__fakeDb = JSON.stringify(db);
  }, { ch, id, data: Object.assign({ type: "book", lessonId: "new_" + id, by: "parent", createdAt: Date.parse(NOW) }, fields) });
}
async function toRequests(page) {
  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector("#requestsList .req");
}

test("учитель: заявка на новое занятие — видна, подтверждение создаёт занятие ученика (цена по пакету), семья видит ответ", async () => {
  const app = await openFamily({ editSeed: (seed) => { seed[statePath].pkgOverrides["Тест, 7 класс"].price = { mode: "total", value: 12000 }; } });
  const { page } = app;
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  await putBook(app, ch, "bk1", { newStartMs: at("2026-09-29T12:00:00"), newEndMs: at("2026-09-29T13:30:00"), comment: "Контрольная в пятницу" });
  await page.waitForFunction(() => document.querySelector("#reqBadge").textContent === "1");
  await toRequests(page);
  const card = await page.textContent("#requestsList .req");
  assert.match(card, /Тест, 7 класс/);
  assert.match(card, /Новое занятие: Вт?\S* ?29\.09[\s\S]*12:00–13:30[\s\S]*90 мин/i);
  assert.match(card, /Контрольная в пятницу/);
  assert.doesNotMatch(card, /не найдено/, "занятия нет — это нормально для новой заявки");
  await page.waitForTimeout(600); // канал разобран — заявку никто не удалил
  assert.ok((await app.db())[`channels/${ch}/items/bk1`], "заявка ждёт решения");
  await page.click('#requestsList [data-req="approve"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const db = await app.db();
  const created = Object.entries(db).filter(([p, d]) => p.startsWith(`teacherSpaces/${T}/lessons/`) && d.startMs === at("2026-09-29T12:00:00"));
  assert.equal(created.length, 1);
  const [path, l] = created[0];
  assert.deepEqual([l.title, l.studentId, l.status, l.endMs, l.durationMin], ["Тест 7 класс", "Тест, 7 класс", "planned", at("2026-09-29T13:30:00"), 90]);
  assert.notEqual(path.split("/").pop(), "new_bk1", "id занятия — свой, не из заявки");
  assert.equal(db[`channels/${ch}/items/bk1`], undefined, "заявка убрана из канала");
  const dec = db[`teacherSpaces/${T}/requests/bk1`];
  assert.deepEqual([dec.type, dec.status, dec.newLessonId], ["book", "approved", path.split("/").pop()]);
  assert.match(await page.textContent("#requestsHistory"), /новое занятие[\s\S]*29\.09[\s\S]*подтверждено/i);
  // цена занятия — по пакету ученика (12 000 за 8 = 1 500)
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "12:00" }).first().click();
  await page.waitForSelector("#mAmount");
  assert.equal(await page.getAttribute("#mAmount", "placeholder"), "1500");
  await page.click("#mClose");
  // семья: ответ и новое занятие
  const cab = await openCabinet(app, `#p=${PK}`, null, false);
  await cab.waitForFunction(() => [...document.querySelectorAll("#pane-lessons .lesson")].some((c) => /29 сентября, 12:00–13:30/.test(c.textContent)));
  await cab.click('.ctab[data-ctab="requests"]');
  assert.match(await cab.textContent("#pane-requests"), /Новое занятие[\s\S]*подтверждено/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("учитель: отказ — занятие не создаётся, семья видит причину", async () => {
  const app = await openFamily({ answer: "На этой неделе всё занято" });
  const { page } = app;
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  const before = Object.keys(await app.db()).filter((p) => p.includes("/lessons/")).length;
  await putBook(app, ch, "bk2", { by: "student", newStartMs: at("2026-09-30T14:00:00"), newEndMs: at("2026-09-30T15:00:00") });
  await toRequests(page);
  await page.click('#requestsList [data-req="reject"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const db = await app.db();
  assert.equal(Object.keys(db).filter((p) => p.includes("/lessons/")).length, before, "занятий не прибавилось");
  const dec = db[`teacherSpaces/${T}/requests/bk2`];
  assert.deepEqual([dec.status, dec.reason], ["rejected", "На этой неделе всё занято"]);
  const cab = await openCabinet(app, `#s=${SK}`, null, false);
  await cab.click('.ctab[data-ctab="requests"]');
  await cab.waitForFunction(() => /отклонено[\s\S]*На этой неделе всё занято/.test(document.querySelector("#pane-requests").textContent));
  await app.close();
});

test("учитель: время заняли, пока заявка висела — подтвердить нельзя (предупреждение, ничего не создаётся)", async () => {
  const dialogs = [];
  const app = await openFamily({ onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  await putBook(app, ch, "bk3", { newStartMs: at("2026-09-30T14:00:00"), newEndMs: at("2026-09-30T15:00:00") });
  await toRequests(page);
  // тем временем в это время поставили занятие Анне
  await page.evaluate(({ path, data }) => { const db = JSON.parse(localStorage.__fakeDb); db[path] = data; localStorage.__fakeDb = JSON.stringify(db); },
    { path: L("race1"), data: { title: "Анна 6 класс", studentId: "Анна, 6 класс", startMs: at("2026-09-30T14:30:00"), endMs: at("2026-09-30T15:30:00"), start: "2026-09-30T14:30:00+03:00", end: "2026-09-30T15:30:00+03:00", status: "planned", source: "app", updatedAt: 1 } });
  await page.waitForTimeout(500); // живая подписка получила новое занятие
  await page.click('#requestsList [data-req="approve"]');
  await waitFor(async () => dialogs.some((m) => /уже занято[\s\S]*Анна/.test(m)), "предупреждение");
  const db = await app.db();
  assert.equal(Object.values(db).filter((d) => d && d.startMs === at("2026-09-30T14:00:00")).length, 0, "занятие не создано");
  assert.ok(db[`channels/${ch}/items/bk3`], "заявка по-прежнему ждёт решения (можно отклонить)");
  assert.equal(db[`teacherSpaces/${T}/requests/bk3`], undefined);
  await page.waitForFunction(() => /уже занято/.test(document.querySelector("#requestsList .req .warn")?.textContent || ""));
  assert.equal(await page.isDisabled('#requestsList [data-req="approve"]'), true);
  await app.close();
});

test("учитель: lessonId заявки — только метка: подделка с id чужого занятия ничего чужого не трогает", async () => {
  const app = await openFamily();
  const { page } = app;
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  const anna5 = (await app.db())[L("anna5")];
  await putBook(app, ch, "bk4", { lessonId: "anna5", newStartMs: at("2026-10-01T12:00:00"), newEndMs: at("2026-10-01T13:00:00") });
  await toRequests(page);
  await page.click('#requestsList [data-req="approve"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const db = await app.db();
  assert.deepEqual(db[L("anna5")], anna5, "занятие Анны не тронуто");
  const created = Object.entries(db).filter(([p, d]) => p.includes("/lessons/") && d.startMs === at("2026-10-01T12:00:00"));
  assert.equal(created.length, 1);
  assert.equal(created[0][1].studentId, "Тест, 7 класс", "занятие — ученика этого канала");
  assert.notEqual(created[0][0].split("/").pop(), "anna5");
  // заявки принимаются только из общего канала — из родительского отбрасываются
  const pch = db[`parentAccess/${PK}`].parentChannel;
  await putBook(app, pch, "bk5", { newStartMs: at("2026-10-02T12:00:00"), newEndMs: at("2026-10-02T13:00:00") });
  await waitFor(async () => !(await app.db())[`channels/${pch}/items/bk5`], "отброшено");
  assert.equal(await page.textContent("#reqBadge"), "0");
  await app.close();
});

test("учитель: подтверждение повторяемо — сбой после создания занятия, повтор и второе устройство не создают копий и не блокируют «Подтвердить»", async () => {
  const dialogs = [];
  const app = await openFamily({ onDialog: (d) => { dialogs.push(d.message()); return true; } });
  app.expectErrors = /Не удалось сохранить в Firestore Error: сеть пропала/; // тест нарочно ломает это — ошибка в консоли ожидаема
  const { page } = app;
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  await putBook(app, ch, "bk6", { newStartMs: at("2026-10-01T16:00:00"), newEndMs: at("2026-10-01T17:00:00") });
  await toRequests(page);
  // связь оборвалась после создания занятия: запись решения падает один раз
  await page.evaluate(() => {
    const fb = window.TutorFB, orig = fb.saveRequestDecision;
    let failed = false;
    fb.saveRequestDecision = (...a) => { if (!failed) { failed = true; return Promise.reject(new Error("сеть пропала")); } return orig.apply(fb, a); };
  });
  await page.click('#requestsList [data-req="approve"]');
  const created = async () => Object.entries(await app.db()).filter(([p, d]) => p.includes("/lessons/") && d.startMs === at("2026-10-01T16:00:00"));
  await waitFor(async () => (await created()).length === 1, "занятие создано");
  await page.waitForTimeout(700); // список перерисован
  assert.ok((await app.db())[`channels/${ch}/items/bk6`], "заявка ещё ждёт решения");
  // своё же занятие по этой заявке — не «занято»: подтвердить можно ещё раз
  assert.doesNotMatch(await page.textContent("#requestsList .req"), /уже занято/);
  assert.equal(await page.isDisabled('#requestsList [data-req="approve"]'), false);
  await page.click('#requestsList [data-req="approve"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const all = await created();
  assert.equal(all.length, 1, "одно занятие, без копии");
  const dec = (await app.db())[`teacherSpaces/${T}/requests/bk6`];
  assert.deepEqual([dec.status, dec.newLessonId], ["approved", all[0][0].split("/").pop()]);
  assert.ok(!dialogs.some((m) => /уже занято/.test(m)), "своё занятие не считалось помехой");
  await app.close();
});
