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

async function toCalendar(cab) {
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-event.own");
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
  await toCalendar(cab);
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
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.equal(new URL(cab.url()).hash, "");
  await cab.reload();
  await cab.waitForSelector("#pane-lessons .lesson"); // запомнился
  assert.equal(await cab.textContent("#title"), "Кабинет ученика");
  await cab.click('.ctab[data-ctab="more"]');
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
  await cab.waitForSelector("#pane-lessons .lesson");
  // Открываем ближайшее занятие из ленты (7/8, пн 28.09 10:00)
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
  await cab.waitForSelector('.ctab[data-ctab="requests"] .dot'); // точка на вкладке «Заявки»
  assert.equal(await cab.$("#requestsCard"), null, "во вкладке «Занятия» карточки заявки больше нет");
  assert.equal(/ждёт ответа/.test(await cab.textContent("#pane-lessons")), false);
  await toCalendar(cab);
  await cab.click("#cal .fc-next-button"); // заявка — на следующей неделе
  await cab.waitForSelector("#cal .fc-event.ghost");
  assert.match(await cab.textContent("#pane-requests"), /ждёт ответа/);
  assert.match(await cab.textContent("#pane-requests"), /Можно во вторник\?/);

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
  await cab.waitForFunction(() => /подтверждено/.test((document.querySelector("#pane-requests")?.textContent || "")));
  await cab.waitForFunction(() => /вт, 29 сентября, 12:00/i.test(document.body.textContent) || /Вт, 29 сентября, 12:00/.test(document.body.textContent));
  assert.deepEqual(cab.errors, []);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("заявка на отмену от ученика → отказ с причиной", async () => {
  const app = await openFamily({ promptAnswer: "Давай не будем" });
  const { page } = app;
  const cab = await openCabinet(app, `#s=${SK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
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
  await cab.waitForFunction(() => /отклонено/.test((document.querySelector("#pane-requests")?.textContent || "")) && /Давай не будем/.test(document.body.textContent));
  await app.close();
});

test("перетаскивание в кабинете = заявка, расписание не меняется само", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await toCalendar(cab);
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
  await student.waitForSelector("#pane-lessons .lesson");
  await student.click('[data-filter="past"]'); // 5/8 уже прошло — во вкладке «История»
  await student.locator(".lesson", { hasText: "5/8" }).first().click();
  await student.setInputFiles("#mFile", [{ name: "решение.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") }]);
  await student.waitForFunction(() => /Файл загружен/.test(document.querySelector("#mMsg").textContent));
  assert.equal(app.calls.cloudinary.length, 1);

  const parent = await openCabinet(app, `#p=${PK_T}`);
  await parent.waitForSelector("#pane-lessons .lesson");
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
  await parent.waitForSelector("#pane-lessons .lesson");
  await parent.locator(".lesson", { hasText: "7/8" }).first().click();
  assert.equal(await parent.textContent("#mPaid"), "Отметить оплату");
  await parent.click("#mPaid");
  await parent.waitForFunction(() => /Отмечено: оплачено/.test(document.querySelector("#mMsg").textContent));
  await waitFor(async () => (await app.db())[L("serA_20260928T070000Z")].paid?.value === true, "paid у учителя");
  assert.equal((await app.db())[L("serA_20260928T070000Z")].paid.by, "parent");

  await page.click('.tab[data-tab="calendar"]');
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 7/8" }).click();
  await page.waitForSelector("#mPaid");
  assert.match(await page.getAttribute("#mPaid", "class"), /\bpaid\b/, "зелёная обводка «Оплачено»");
  assert.match(await page.getAttribute("#mPaid", "class"), /\bmark-btn\b/, "тот же стиль, что у «Провёл»");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#mPaid")).borderTopWidth), "2px");
  assert.match(await page.textContent("#modal"), /отметил родитель/);
  await page.click("#mPaid");
  await page.waitForFunction(() => /снята/.test(document.querySelector("#mMsg").textContent));
  await parent.waitForFunction(() => !document.querySelector("#mPaid").classList.contains("paid"));

  const student = await openCabinet(app, `#s=${SK_T}`);
  await student.waitForSelector("#pane-lessons .lesson");
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
  await cab.waitForSelector("#pane-lessons .lesson");
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
  await student.waitForSelector("#pane-lessons .lesson");
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
  await student.waitForFunction(() => /ждёт ответа/.test(document.querySelector("#pane-requests")?.textContent || ""));
  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector('#requestsList [data-req="approve"]');
  await app.close();
});

test("пока правила не обновлены: в кабинете понятное сообщение, а не «проверьте интернет»", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.evaluate(() => { window.__FAKE_DENY = ["channels/"]; });
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.click("#mCancel");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /ещё не включена у преподавателя/.test(document.querySelector("#mMsg").textContent));
  await app.close();
});


test("вкладки кабинета: Занятия по умолчанию, фильтр ленты, ДЗ с загрузкой, Ещё", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  const visible = async () => cab.$$eval(".pane", (ps) => ps.filter((p) => p.style.display !== "none").map((p) => p.id));
  assert.deepEqual(await visible(), ["pane-lessons"]);
  assert.equal(await cab.getAttribute('.ctab[data-ctab="lessons"]', "class"), "ctab active");
  // Пакет сверху, лента «Ближайшие» ↔ «История»
  const lessonsText = await cab.textContent("#pane-lessons");
  assert.ok(lessonsText.indexOf("Пакет занятий") < lessonsText.indexOf("Ближайшие"));
  assert.match(lessonsText, /Ближайшие \(3\)/);
  assert.match(lessonsText, /История \(5\)/);
  assert.equal(await cab.$$eval("#pane-lessons .lesson", (l) => l.length), 3);
  await cab.click('[data-filter="past"]');
  assert.equal(await cab.$$eval("#pane-lessons .lesson", (l) => l.length), 5);
  assert.match(await cab.textContent("#pane-lessons .lesson"), /23 сентября/, "история — от новых к старым");

  // Календарь
  await toCalendar(cab);
  assert.deepEqual(await visible(), ["pane-calendar"]);

  // ДЗ: загрузка через выбор занятия, без календаря
  await cab.click('.ctab[data-ctab="hw"]');
  assert.deepEqual(await visible(), ["pane-hw"]);
  assert.match(await cab.textContent("#pane-hw"), /Пока нет ни заданий/);
  assert.match(await cab.$eval("#hwLesson", (s) => s.options[s.selectedIndex].textContent), /23 сентября/, "по умолчанию — последнее прошедшее");
  await cab.setInputFiles("#hwFile", [{ name: "дз-сентябрь.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") }]);
  await cab.waitForFunction(() => /Файл загружен/.test(document.querySelector("#hwMsg").textContent));
  await cab.waitForFunction(() => /дз-сентябрь\.pdf/.test(document.querySelector("#pane-hw").textContent));
  // «+ добавить файл» у карточки в ленте
  await cab.setInputFiles("#pane-hw [data-hw-add]", [{ name: "фото2.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") }]);
  await cab.waitForFunction(() => /фото2\.jpg/.test(document.querySelector("#pane-hw").textContent));
  // Файл лежит либо ещё в канале, либо уже перенесён учителем в занятие.
  await waitFor(async () => {
    const all = Object.values(await app.db());
    const names = new Set([
      ...all.filter((d) => d && d.type === "homework").map((d) => d.file.name),
      ...all.flatMap((d) => (d && Array.isArray(d.homework) ? d.homework : [])).map((h) => h.name),
    ]);
    return names.has("дз-сентябрь.pdf") && names.has("фото2.jpg");
  }, "файлы в канале/занятии");
  assert.equal(app.calls.cloudinary.length, 2);

  // Ещё
  await cab.click('.ctab[data-ctab="more"]');
  assert.deepEqual(await visible(), ["pane-more"]);
  assert.equal(await cab.isVisible("#tgLink"), true);
  assert.equal(await cab.isVisible("#forgetBtn"), true);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("телефон: вкладки кабинета помещаются, страница не скроллится вбок", async () => {
  const app = await openFamily();
  const cab = await app.context.newPage();
  await cab.setViewportSize({ width: 360, height: 740 });
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + `/cabinet.html#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  for (const t of ["lessons", "calendar", "hw", "requests", "more"]) {
    await cab.click(`.ctab[data-ctab="${t}"]`);
    await cab.waitForTimeout(t === "calendar" ? 600 : 100);
    const over = await cab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, `вкладка ${t}: горизонтальная прокрутка ${over}px`);
  }
  await app.close();
});


test("вкладка «Заявки» в кабинете: полная история — кто, когда, что просил, чем кончилось", async () => {
  const app = await openFamily({ promptAnswer: "Занято" });
  const { page } = app;
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  // Две заявки: перенос (подтвердим) и отмена (откажем)
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.click("#mMove");
  await cab.fill("#mTime", "12:00");
  await cab.fill("#mComment", "после школы");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  await cab.click("#mClose");
  await cab.locator(".lesson", { hasText: "8/8" }).first().click();
  await cab.click("#mCancel");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
  await cab.click("#mClose");
  await cab.click('.ctab[data-ctab="requests"]');
  await cab.waitForFunction(() => (document.querySelector("#pane-requests").textContent.match(/ждёт ответа/g) || []).length === 2);

  await page.click('.tab[data-tab="requests"]');
  await page.waitForFunction(() => document.querySelectorAll("#requestsList .req").length === 2);
  const reqs = page.locator("#requestsList .req");
  await reqs.filter({ hasText: "Перенос" }).locator('[data-req="approve"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#requestsList .req").length === 1);
  await reqs.filter({ hasText: "Отмена" }).locator('[data-req="reject"]').click();
  await page.waitForFunction(() => /Новых заявок нет/.test(document.querySelector("#requestsList").textContent));

  await cab.waitForFunction(() => /подтверждено/.test(document.querySelector("#pane-requests").textContent) && /отклонено/.test(document.querySelector("#pane-requests").textContent));
  const txt = await cab.textContent("#pane-requests");
  assert.match(txt, /Перенос занятия/);
  assert.match(txt, /Было: Пн, 28 сентября, 10:00–11:00/);
  assert.match(txt, /Просили: Пн, 28 сентября, 12:00–13:00/);
  assert.match(txt, /«после школы»/);
  assert.match(txt, /Отмена занятия/);
  assert.match(txt, /Подал\(а\): родитель, 24\.09\.2026/);
  assert.match(txt, /Ответ: 24\.09\.2026.*— Занято/);
  assert.equal(/ждёт ответа/.test(txt), false);
  assert.equal(await cab.$('.ctab[data-ctab="requests"] .dot'), null, "точка погасла");
  assert.deepEqual(cab.errors, []);
  await app.close();
});
