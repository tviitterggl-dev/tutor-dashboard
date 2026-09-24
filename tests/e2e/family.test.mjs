// Доработки по итогам проверки «от лица родителя»: прошлая неделя,
// «Забыть это устройство», заявки на перенос/отмену, ДЗ от родителя и
// ученика, «Оплачено», контакты — и приватность всего этого.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK_T = "parent_key_test_student_0000000001";   // родитель «Тест, 7 класс»
const SK_T = "student_key_test_student_000000002";   // ученик «Тест, 7 класс»
const PK_A = "parent_key_anna_student_0000000003";   // родитель «Анна, 6 класс»
const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;

function familySeed() {
  const seed = defaultSeed();
  const k = (role, studentId, createdAt) => ({ role, studentId, label: "", createdAt, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK_T}`] = k("parent", "Тест, 7 класс", 1);
  seed[`teacherSpaces/${T}/accessKeys/${SK_T}`] = k("student", "Тест, 7 класс", 2);
  seed[`teacherSpaces/${T}/accessKeys/${PK_A}`] = k("parent", "Анна, 6 класс", 3);
  return seed;
}

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("Не дождались: " + what);
}

// Учитель + опубликованные витрины для трёх ключей.
async function openFamily(opts = {}) {
  const dialogs = [];
  const app = await openApp({ seed: familySeed(), onDialog: opts.onDialog || ((d) => { dialogs.push(d.message()); return opts.promptAnswer ?? true; }) });
  await waitFor(async () => {
    const db = await app.db();
    return db[`parentAccess/${PK_T}`] && db[`parentAccess/${PK_T}`].channel && db[`studentAccess/${SK_T}`] && db[`parentAccess/${PK_A}`];
  }, "витрины с каналами");
  app.dialogs = dialogs;
  app.base = app.page.url().replace(/\/index\.html.*$/, "");
  return app;
}

async function openCabinet(app, hash) {
  const cab = await app.context.newPage();
  cab.errors = [];
  cab.dialogs = [];
  cab.on("pageerror", (e) => cab.errors.push(String(e)));
  cab.on("dialog", async (d) => { cab.dialogs.push(d.message()); await d.accept(); });
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + "/cabinet.html" + (hash || ""));
  return cab;
}

test("витрина: прошлая неделя доступна, id занятий и каналы на месте", async () => {
  const app = await openFamily();
  const db = await app.db();
  const v = db[`parentAccess/${PK_T}`];
  assert.equal(v.busyFrom, Date.parse("2026-09-14T00:00:00+03:00"), "с понедельника прошлой недели");
  assert.ok(v.lessons.every((l) => l.id), "у каждого занятия есть id");
  assert.ok(v.channel && v.parentChannel);
  const vs = db[`studentAccess/${SK_T}`];
  assert.equal(vs.channel, v.channel, "общий канал у родителя и ученика одного ребёнка");
  assert.equal(vs.parentChannel, undefined, "ученик не знает родительский канал");
  assert.equal(vs.lessons.some((l) => "paid" in l), false, "ученику оплата не передаётся");
  const va = db[`parentAccess/${PK_A}`];
  assert.notEqual(va.channel, v.channel, "у каждого ребёнка свой канал");
  assert.notEqual(va.parentChannel, v.parentChannel);

  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  // Неделя 21–27.09; назад на 14–20.09 можно, дальше — нет
  await cab.click("#cal .fc-prev-button");
  await cab.waitForFunction(() => /14/.test(document.querySelector("#cal .fc-toolbar-title").textContent));
  assert.ok(await cab.$$eval("#cal .fc-event.own", (e) => e.length) >= 3, "уроки прошлой недели видны");
  assert.equal(await cab.isDisabled("#cal .fc-prev-button"), true, "раньше прошлой недели нельзя");
  // Контакты
  assert.equal(await cab.getAttribute("#tgLink", "href"), "https://t.me/mat_repet");
  assert.equal(await cab.getAttribute("#telemostLink", "href"), "https://yandex.ru/chat/p/ad9c2706-f36a-940f-7a90-d15f170427e5?utm_source=invite");
  assert.match(await cab.textContent("body"), /Если что — пишите/);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("«Забыть это устройство» стирает ключ; без ссылки кабинет не открывается", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#s=${SK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  assert.equal(new URL(cab.url()).hash, "");
  await cab.reload();
  await cab.waitForSelector("#cal .fc-event.own"); // запомнился
  assert.equal(await cab.textContent("#title"), "Кабинет ученика");
  await cab.click("#forgetBtn");
  await cab.waitForFunction(() => /забыт/.test(document.body.textContent));
  assert.equal(await cab.evaluate(() => localStorage.getItem("cabinetKeys")), null);
  await cab.reload();
  await cab.waitForFunction(() => /нужна личная ссылка/.test(document.body.textContent));
  await app.close();
});

test("заявка на перенос по тапу → бейдж у учителя → подтверждение → видно в кабинете", async () => {
  const app = await openFamily();
  const { page } = app;
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  // Открываем ближайшее занятие из списка (7/8, пн 28.09 10:00)
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.waitForSelector("#mMove");
  await cab.click("#mMove");
  // Занятое время не принимается (у Анны вт 29.09 15:00)
  await cab.fill("#mDate", "2026-09-29");
  await cab.fill("#mTime", "15:00");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /уже занято/.test(document.querySelector("#mMsg").textContent));
  await cab.fill("#mTime", "12:00");
  await cab.fill("#mComment", "Можно во вторник?");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  await cab.click("#mClose");
  await cab.click("#cal .fc-next-button"); // заявка — на следующей неделе
  await cab.waitForSelector("#cal .fc-event.ghost");
  assert.match(await cab.textContent("#requestsCard"), /ждёт ответа/);

  // У учителя — бейдж
  await page.waitForFunction(() => document.querySelector("#reqBadge").textContent === "1");
  assert.equal(await page.isVisible("#reqAlert"), true);
  assert.match(await page.title(), /^\(1\)/);
  await page.click("#reqAlert");
  await page.waitForSelector("#requestsList .req");
  const reqText = await page.textContent("#requestsList");
  assert.match(reqText, /Тест, 7 класс/);
  assert.match(reqText, /Можно во вторник\?/);
  await page.click('#requestsList [data-req="approve"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));

  const db = await app.db();
  const old = db[L("serA_20260928T070000Z")];
  assert.equal(old.status, "rescheduled");
  const moved = db[L(old.rescheduledTo)];
  assert.equal(moved.date, "2026-09-29");
  assert.equal(moved.time, "12:00");
  assert.equal(Object.keys(db).filter((p) => p.startsWith("channels/") && p.includes("/items/")).length, 0, "заявка убрана из канала");
  const dec = Object.entries(db).find(([p]) => p.startsWith(`teacherSpaces/${T}/requests/`))[1];
  assert.equal(dec.status, "approved");
  assert.equal(await page.textContent("#reqBadge"), "0");

  // Кабинет сам обновился
  await cab.waitForFunction(() => /подтверждено/.test((document.querySelector("#requestsCard")?.textContent || "")));
  await cab.waitForFunction(() => /вт, 29 сентября, 12:00/i.test(document.body.textContent) || /Вт, 29 сентября, 12:00/.test(document.body.textContent));
  assert.deepEqual(cab.errors, []);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("заявка на отмену от ученика → отказ с причиной", async () => {
  const app = await openFamily({ promptAnswer: "Давай не будем" });
  const { page } = app;
  const cab = await openCabinet(app, `#s=${SK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  await cab.locator(".lesson", { hasText: "8/8" }).first().click();
  await cab.click("#mCancel");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector('#requestsList [data-req="reject"]');
  assert.match(await page.textContent("#requestsList"), /ученик/);
  await page.click('#requestsList [data-req="reject"]');
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));
  const db = await app.db();
  assert.equal(db[L("serA_20260930T070000Z")].status, "planned", "расписание не изменилось");
  await cab.waitForFunction(() => /отклонено/.test((document.querySelector("#requestsCard")?.textContent || "")) && /Давай не будем/.test(document.body.textContent));
  await app.close();
});

test("перетаскивание в кабинете = заявка, расписание не меняется само", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  await cab.click("#cal .fc-next-button"); // неделя 28.09–04.10
  const ev = cab.locator("#cal .fc-event.own", { hasText: "7/8" });
  await ev.waitFor();
  await ev.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await ev.boundingBox();
  const slotH = (await cab.locator(".fc-timegrid-slot-lane").first().boundingBox()).height;
  await cab.mouse.move(box.x + box.width / 2, box.y + 6);
  await cab.mouse.down();
  for (let i = 1; i <= 10; i++) { await cab.mouse.move(box.x + box.width / 2, box.y + 6 + (i * slotH * 4) / 10); await cab.waitForTimeout(20); }
  await cab.mouse.up();
  await waitFor(async () => cab.dialogs.some((m) => /заявку на перенос/.test(m)), "подтверждение заявки");
  await waitFor(async () => {
    const db = await app.db();
    return Object.entries(db).some(([p, d]) => p.startsWith("channels/") && d.type === "reschedule");
  }, "заявка в канале");
  const db = await app.db();
  assert.equal(db[L("serA_20260928T070000Z")].status, "planned");
  assert.equal(db[L("serA_20260928T070000Z")].time, "10:00", "само занятие не сдвинулось");
  await app.close();
});

test("ДЗ от ученика сразу видно родителю, а потом попадает в занятие у учителя", async () => {
  const app = await openFamily();
  await app.page.goto(app.base + "/cabinet.html"); // учитель пока не в сети (вкладка нужна только читать «базу»)
  const student = await openCabinet(app, `#s=${SK_T}`);
  await student.waitForSelector("#cal .fc-event.own");
  await student.locator(".lesson", { hasText: "5/8" }).first().click();
  await student.setInputFiles("#mFile", [{ name: "решение.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") }]);
  await student.waitForFunction(() => /Файл загружен/.test(document.querySelector("#mMsg").textContent));
  assert.equal(app.calls.cloudinary.length, 1);

  const parent = await openCabinet(app, `#p=${PK_T}`);
  await parent.waitForSelector("#cal .fc-event.own");
  await parent.waitForFunction(() => /решение\.jpg/.test(document.body.textContent) && /\(ученик\)/.test(document.body.textContent));

  // Учитель открывает дашборд — файл переезжает в занятие, канал пустеет
  const teacher = await app.context.newPage();
  await teacher.clock.setFixedTime(new Date(NOW));
  await teacher.goto(app.base + "/index.html");
  await waitFor(async () => {
    const db = await app.db();
    const hw = db[L("serA_20260923T070000Z")].homework || [];
    return hw.some((h) => h.name === "решение.jpg" && h.by === "student");
  }, "ДЗ в занятии");
  await waitFor(async () => !Object.keys(await app.db()).some((p) => p.startsWith("channels/") && p.includes("/items/")), "канал очищен");
  await parent.waitForTimeout(600);
  assert.match(await parent.textContent("body"), /решение\.jpg/, "у родителя файл не пропал");
  // В карточке у учителя — с пометкой
  await teacher.click('.tab[data-tab="calendar"]');
  await teacher.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 5/8" }).click();
  await teacher.waitForFunction(() => /решение\.jpg/.test(document.querySelector("#modal").textContent) && /\(ученик\)/.test(document.querySelector("#modal").textContent));
  await app.close();
});

test("«Оплачено»: родитель ↔ учитель в обе стороны; ученику недоступно", async () => {
  const app = await openFamily();
  const { page } = app;
  const parent = await openCabinet(app, `#p=${PK_T}`);
  await parent.waitForSelector("#cal .fc-event.own");
  await parent.locator(".lesson", { hasText: "7/8" }).first().click();
  await parent.check("#mPaid");
  await parent.waitForFunction(() => /Отмечено: оплачено/.test(document.querySelector("#mMsg").textContent));
  await waitFor(async () => (await app.db())[L("serA_20260928T070000Z")].paid?.value === true, "paid у учителя");
  assert.equal((await app.db())[L("serA_20260928T070000Z")].paid.by, "parent");

  await page.click('.tab[data-tab="calendar"]');
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 7/8" }).click();
  await page.waitForSelector("#mPaid");
  assert.equal(await page.isChecked("#mPaid"), true);
  assert.match(await page.textContent("#modal"), /отметил родитель/);
  await page.uncheck("#mPaid");
  await page.waitForFunction(() => /снята/.test(document.querySelector("#mMsg").textContent));
  await parent.waitForFunction(() => !document.querySelector("#mPaid").checked);

  const student = await openCabinet(app, `#s=${SK_T}`);
  await student.waitForSelector("#cal .fc-event.own");
  await student.locator(".lesson", { hasText: "7/8" }).first().click();
  await student.waitForSelector("#mClose");
  assert.equal(await student.$("#mPaid"), null, "у ученика нет галочки");
  const sb = await student.evaluate(() => document.body.innerText);
  assert.equal(/оплачено/i.test(sb), false, "ученик не видит оплату");
  await app.close();
});

test("приватность: чужое занятие в заявке/оплате/ДЗ не применяется и ничего не раскрывает", async () => {
  const app = await openFamily();
  const db0 = await app.db();
  const vA = db0[`parentAccess/${PK_A}`];
  const vT = db0[`parentAccess/${PK_T}`];

  // В витрине Анны нет ничего про Теста — ни имён, ни id, ни каналов
  const sA = JSON.stringify(vA);
  assert.equal(sA.includes("Тест"), false);
  assert.equal(sA.includes("serA_"), false, "нет id чужих занятий");
  assert.equal(sA.includes(vT.channel), false);
  assert.equal(sA.includes(vT.parentChannel), false);
  assert.ok(vA.busy.every((b) => Object.keys(b).sort().join() === "e,s"), "busy — только время");

  // Родитель Анны подделывает сообщения про занятие Теста в своих каналах
  const cab = await openCabinet(app, `#p=${PK_A}`);
  await cab.waitForSelector("#cal");
  const foreign = "serA_20260928T070000Z";
  // Пишем «как будто из кабинета» через вкладку учителя: в стенде общая
  // «база» — localStorage, и параллельные записи из разных вкладок могут
  // затирать друг друга (на настоящем Firestore такого нет).
  await app.page.evaluate(async ({ ch, pch, foreign }) => {
    const put = (c, id, data) => {
      const db = JSON.parse(localStorage.__fakeDb);
      db[`channels/${c}/items/${id}`] = data;
      localStorage.__fakeDb = JSON.stringify(db);
    };
    put(ch, "evil1", { type: "cancel", lessonId: foreign, by: "parent", createdAt: Date.now() });
    put(ch, "evil2", { type: "homework", lessonId: foreign, by: "parent", createdAt: Date.now(), file: { url: "https://res.cloudinary.com/x/evil.pdf", name: "evil.pdf" } });
    put(pch, "evil3", { type: "paid", lessonId: foreign, by: "parent", createdAt: Date.now(), paid: true });
  }, { ch: vA.channel, pch: vA.parentChannel, foreign });

  await waitFor(async () => !Object.keys(await app.db()).some((p) => p.startsWith("channels/") && /evil\d$/.test(p)), "подделки выброшены");
  const db = await app.db();
  const l = db[L(foreign)];
  assert.equal(l.status, "planned", "чужое занятие не отменено");
  assert.equal((l.homework || []).some((h) => h.name === "evil.pdf"), false, "чужое ДЗ не прикреплено");
  assert.equal(l.paid, undefined, "чужое занятие не помечено оплаченным");
  const dec = db[`teacherSpaces/${T}/requests/evil1`];
  assert.equal(dec.status, "rejected");
  assert.equal(dec.studentId, "Анна, 6 класс");
  assert.equal(dec.oldStartMs, null, "в решение не попало время чужого занятия");
  await waitFor(async () => ((await app.db())[`parentAccess/${PK_A}`].requests || []).some((r) => r.id === "evil1"), "решение в витрине Анны");
  const vA2 = (await app.db())[`parentAccess/${PK_A}`];
  assert.equal(JSON.stringify(vA2).includes("Тест"), false);
  assert.equal(((await app.db())[`parentAccess/${PK_T}`].requests || []).length, 0, "у Теста чужие решения не видны");
  await app.page.waitForFunction(() => document.querySelector("#reqBadge").textContent === "0"); // подделка не висит в заявках

  // Ученик ставит «оплачено» в общий канал (он не родитель) — игнорируется
  await app.page.evaluate(({ ch }) => {
    const db = JSON.parse(localStorage.__fakeDb);
    db[`channels/${ch}/items/fakepaid`] = { type: "paid", lessonId: "anna5", by: "parent", createdAt: Date.now(), paid: true };
    localStorage.__fakeDb = JSON.stringify(db);
  }, { ch: vA.channel });
  await waitFor(async () => !(await app.db())[`channels/${vA.channel}/items/fakepaid`], "выброшено");
  assert.equal((await app.db())[L("anna5")].paid, undefined);
  await app.close();
});

test("отзыв доступа меняет каналы: отозванный больше не видит заявки и ДЗ", async () => {
  const app = await openFamily();
  const { page } = app;
  const db0 = await app.db();
  const oldCh = db0[`parentAccess/${PK_T}`].channel;
  const student = await openCabinet(app, `#s=${SK_T}`);
  await student.waitForSelector("#cal .fc-event.own");
  await student.locator(".lesson", { hasText: "8/8" }).first().click();
  await student.click("#mCancel");
  await student.click("#mSend");
  await student.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));

  await page.click('.tab[data-tab="students"]');
  await page.waitForSelector(`[data-key-revoke="${PK_T}"]`);
  await page.click(`[data-key-revoke="${PK_T}"]`);
  await page.waitForFunction(() => /Доступ отозван/.test(document.querySelector("#akMsg").textContent));
  const db = await app.db();
  assert.equal(db[`parentAccess/${PK_T}`], undefined);
  const newCh = db[`studentAccess/${SK_T}`].channel;
  assert.notEqual(newCh, oldCh, "канал сменился");
  assert.equal(Object.keys(db).some((p) => p.startsWith(`channels/${oldCh}/`)), false, "старый канал пуст");
  assert.ok(Object.entries(db).some(([p, d]) => p.startsWith(`channels/${newCh}/`) && d.type === "cancel"), "заявка переехала");
  // Кабинет ученика продолжает работать на новом канале
  await student.waitForFunction(() => /ждёт ответа/.test(document.querySelector("#requestsCard")?.textContent || ""));
  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector('#requestsList [data-req="approve"]');
  await app.close();
});

test("пока правила не обновлены: в кабинете понятное сообщение, а не «проверьте интернет»", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#cal .fc-event.own");
  await cab.evaluate(() => { window.__FAKE_DENY = ["channels/"]; });
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.click("#mCancel");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /ещё не включена у преподавателя/.test(document.querySelector("#mMsg").textContent));
  await app.close();
});
