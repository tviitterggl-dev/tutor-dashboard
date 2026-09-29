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
  assert.equal(v.busyFrom, Date.parse("2026-08-24T00:00:00+03:00"), "с понедельника 4 недели назад");
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
  // Неделя 21–27.09; назад на 14–20.09 можно (окно — 4 недели, подробно в calendar-window)
  await cab.click("#cal .fc-prev-button");
  await cab.waitForFunction(() => /14/.test(document.querySelector("#cal .fc-toolbar-title").textContent));
  assert.ok(await cab.$$eval("#cal .fc-event.own", (e) => e.length) >= 3, "уроки прошлой недели видны");
  // Контакты: учитель их не задал — карточки «Если что — пишите» нет, сами не подставляются
  assert.equal(await cab.getAttribute("#contactsCard", "hidden"), "");
  assert.equal(await cab.locator("#contactsList a").count(), 0);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("«Забыть это устройство» стирает ключ; без ссылки кабинет не открывается", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#s=${SK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.equal(new URL(cab.url()).hash, `#s=${SK_T}`, "ключ остаётся в адресе");
  await cab.goto(app.base + "/cabinet.html"); // без ключа в ссылке — из памяти устройства
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.waitForSelector("#pane-lessons .lesson"); // запомнился
  assert.equal(await cab.textContent("#title"), "Кабинет ученика");
  await cab.click('.ctab[data-ctab="settings"]');
  await cab.click("#forgetBtn");
  await cab.waitForFunction(() => /забыт/.test(document.body.textContent));
  assert.equal(await cab.evaluate(() => localStorage.getItem("cabinetKeys")), null);
  assert.equal(new URL(cab.url()).hash, "", "и из адреса ключ убран");
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
  // кнопка-переключатель прямо в карточке списка (как «Провёл» у учителя)
  const card8 = parent.locator(".lesson", { hasText: "8/8" }).first();
  assert.equal(await card8.locator("[data-paid]").textContent(), "Оплачено");
  await card8.locator("[data-paid]").click();
  await parent.waitForFunction(() => [...document.querySelectorAll(".lesson")].some((l) => /8\/8/.test(l.textContent) && /Благодарю за оплату!/.test(l.textContent)));
  assert.match(await parent.locator(".lesson", { hasText: "8/8" }).first().locator("[data-paid]").getAttribute("class"), /\bpaid\b/);
  assert.equal(await parent.locator(".lesson", { hasText: "8/8" }).first().locator("[data-paid]").textContent(), "✓ Оплачено (снять)");
  assert.equal(await parent.isVisible("#modalBack"), false, "нажатие на кнопку не открывает окно занятия");
  await waitFor(async () => (await app.db())[L("serA_20260930T070000Z")].paid?.value === true, "paid 8/8 у учителя");
  // и в окне занятия
  await parent.locator(".lesson", { hasText: "7/8" }).first().click();
  assert.equal(await parent.textContent("#mPaid"), "Оплачено");
  await parent.click("#mPaid");
  await parent.waitForFunction(() => /Благодарю за оплату!/.test(document.querySelector("#mMsg").textContent));
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

test("подделка «от учителя»: ДЗ, пояснение и «оплачено» с by: teacher из каналов семьи не применяются", async () => {
  // Правила не могут отличить учителя от семьи в канале (входа у семьи нет),
  // поэтому by: "teacher" в сообщении может подставить кто угодно с ключом
  // канала. Раньше учитель копировал by как есть: файл ребёнка выглядел как
  // ДЗ от учителя (и в групповом занятии уходил новым участникам — другой
  // семье), «оплачено» — как отметка самого учителя (без пуша ему).
  const app = await openFamily();
  const vT = (await app.db())[`parentAccess/${PK_T}`];
  const lesson = "serA_20260925T070000Z";
  const before = (await app.db())[L(lesson)];
  await app.page.evaluate(async ({ ch, pch, lesson }) => {
    const db = JSON.parse(localStorage.__fakeDb);
    const t = Date.now() + 1000;
    db[`channels/${ch}/items/fake1`] = { type: "homework", lessonId: lesson, by: "teacher", createdAt: t, file: { url: "https://res.cloudinary.com/x/fake.pdf", name: "fake.pdf" } };
    db[`channels/${ch}/items/fake2`] = { type: "note", lessonId: lesson, by: "teacher", createdAt: t, comment: "подделка" };
    db[`channels/${pch}/items/fake3`] = { type: "paid", lessonId: lesson, by: "teacher", createdAt: t, paid: true };
    // и настоящее — от родителя: применяется как раньше
    db[`channels/${ch}/items/real1`] = { type: "homework", lessonId: lesson, by: "parent", createdAt: t, file: { url: "https://res.cloudinary.com/x/real.pdf", name: "real.pdf" } };
    localStorage.__fakeDb = JSON.stringify(db);
  }, { ch: vT.channel, pch: vT.parentChannel, lesson });
  await waitFor(async () => ((await app.db())[L(lesson)].homework || []).some((h) => h.name === "real.pdf"), "настоящее ДЗ применено");
  await waitFor(async () => !Object.keys(await app.db()).some((p) => /\/items\/fake[12]$/.test(p)), "подделки ДЗ/пояснения выброшены");
  const l = (await app.db())[L(lesson)];
  assert.equal((l.homework || []).some((h) => h.name === "fake.pdf"), false, "файл «от учителя» не прикреплён");
  assert.equal((l.homework || []).find((h) => h.name === "real.pdf").by, "parent");
  assert.deepEqual(l.familyNote, before.familyNote, "пояснение «от учителя» не применено");
  assert.deepEqual(l.paid, before.paid, "«оплачено от учителя» из канала родителя не применено");
  assert.deepEqual(app.errors, []);
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
  app.expectErrors = /insufficient permissions/; // тест нарочно ломает это — ошибка в консоли ожидаема
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.evaluate(() => { window.__FAKE_DENY = ["channels/"]; });
  await cab.locator(".lesson", { hasText: "7/8" }).first().click();
  await cab.click("#mCancel");
  await cab.click("#mSend");
  await cab.waitForFunction(() => /ещё не включена у преподавателя/.test(document.querySelector("#mMsg").textContent));
  await app.close();
});


test("вкладки кабинета: Занятия по умолчанию, фильтр ленты, ДЗ с загрузкой, Настройки", async () => {
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

  // Настройки
  await cab.click('.ctab[data-ctab="settings"]');
  assert.deepEqual(await visible(), ["pane-settings"]);
  assert.equal(await cab.isVisible("#contactsCard"), false, "контактов нет — и карточки нет");
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
  for (const t of ["lessons", "calendar", "hw", "requests", "settings"]) {
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

test("«На экран «Домой»»: адрес всегда с ключом открытого кабинета; значок открывает кабинет на «чистом» устройстве", async () => {
  const app = await openFamily();
  const cab = await openCabinet(app, `#p=${PK_A}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.goto(app.base + "/cabinet.html#p=" + PK_T);
  await cab.waitForFunction(() => /Проведено/.test(document.body.innerText));
  assert.equal(new URL(cab.url()).hash, `#p=${PK_T}`);
  // переключатель детей меняет и ключ в адресе
  await cab.waitForSelector("#switchSel");
  await cab.selectOption("#switchSel", PK_A);
  await cab.waitForFunction((k) => location.hash === "#p=" + k, PK_A);
  // открыли без ключа (закладка) — кабинет из памяти, ключ снова в адресе
  await cab.goto(app.base + "/cabinet.html");
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.match(new URL(cab.url()).hash, /^#p=/);
  // теги для экрана «Домой»; manifest нарочно нет (иначе сохранится ссылка из него, без ключа)
  const tags = await cab.evaluate(() => ({
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
    icon: document.querySelector('link[rel="apple-touch-icon"]')?.href,
    manifest: !!document.querySelector('link[rel="manifest"]'),
    appName: document.querySelector('meta[name="application-name"]')?.content,
    doc: document.title,
  }));
  assert.equal(tags.capable, "yes");
  assert.equal(tags.title, "Тьютор Онлайн");
  assert.equal(tags.appName, "Тьютор Онлайн", "Android берёт имя значка отсюда");
  assert.equal(tags.doc, "Тьютор Онлайн");
  assert.equal(tags.manifest, false);
  assert.equal((await cab.request.get(tags.icon)).status(), 200);
  const saved = cab.url();

  // Установленное на iPhone приложение начинает с пустого хранилища:
  // стираем сохранённые кабинеты и открываем сохранённую ссылку — кабинет открывается
  await cab.evaluate(() => localStorage.removeItem("cabinetKeys"));
  await cab.goto(app.base + "/cabinet.html");
  await cab.waitForFunction(() => /нужна личная ссылка/.test(document.body.textContent), null, { timeout: 5000 });
  await cab.goto(saved);
  await cab.reload(); // настоящая загрузка страницы по сохранённой ссылке
  await cab.waitForSelector("#pane-lessons .lesson");
  assert.equal(cab.url(), saved);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("на карточке занятия в списке нет крестика-отмены; отмена — из окна занятия (родитель и ученик)", async () => {
  // Крестик «быстрая отмена» (bf76f94) убран: одним лишним нажатием нельзя
  // было случайно начать отмену. Отмена — как раньше: окно → «Отменить…».
  const app = await openFamily();
  for (const [hash, by] of [[`#p=${PK_T}`, "parent"], [`#s=${SK_T}`, "student"]]) {
    const cab = await openCabinet(app, hash);
    await cab.waitForSelector("#pane-lessons .lesson");
    assert.equal(await cab.locator(".quick-cancel, [data-quick-cancel], .lesson.can-cancel").count(), 0);
    const btns = await cab.locator("#pane-lessons .lesson button").evaluateAll((bs) => bs.map((b) => b.textContent.trim() + "|" + (b.getAttribute("aria-label") || "")));
    assert.ok(btns.every((t) => !/×|Отмен/.test(t)), "в карточках списка нет кнопки отмены: " + btns.join(", "));
    const card = cab.locator(".lesson", { hasText: by === "parent" ? "7/8" : "8/8" }).first();
    await card.click();
    await cab.waitForSelector("#modalBack", { state: "visible" });
    assert.equal(await cab.isVisible("#reqForm"), false, "окно открывается без формы отмены");
    await cab.click("#mCancel");
    await cab.waitForSelector("#reqForm", { state: "visible" });
    assert.equal(await cab.textContent("#mSend"), "Отправить заявку на отмену");
    assert.equal(await cab.isVisible("#moveFields"), false, "без полей переноса");
    await cab.fill("#mComment", "Заболели");
    await cab.click("#mSend");
    await cab.waitForFunction(() => /Заявка отправлена/.test(document.querySelector("#mMsg").textContent));
    await cab.click("#mClose");
    await cab.waitForSelector("#modalBack", { state: "hidden" });
    assert.deepEqual(cab.errors, []);
    await cab.close();
  }
  const db = await app.db();
  const cancels = Object.entries(db).filter(([p, d]) => p.startsWith("channels/") && d.type === "cancel").map(([, d]) => [d.by, d.comment]);
  assert.deepEqual(cancels.sort(), [["parent", "Заболели"], ["student", "Заболели"]]);
  await app.close();
});

test("«Отменить заявку»: только на своей ждущей заявке (родитель ↔ ученик); из «Заявок» и из окна занятия", async () => {
  const app = await openFamily();
  const vT = (await app.db())[`parentAccess/${PK_T}`];
  const L78 = "serA_20260928T070000Z", L88 = "serA_20260930T070000Z";
  await app.page.evaluate(({ ch, L78, L88 }) => {
    const db = JSON.parse(localStorage.__fakeDb);
    const t = Date.now();
    db[`channels/${ch}/items/mine1`] = { type: "cancel", lessonId: L78, by: "parent", createdAt: t, comment: "Заболели" };
    db[`channels/${ch}/items/theirs1`] = { type: "reschedule", lessonId: L88, by: "student", createdAt: t + 1, newStartMs: t + 5 * 86400000, newEndMs: t + 5 * 86400000 + 3600000 };
    db[`channels/${ch}/items/mine2`] = { type: "book", lessonId: "b_mine2", by: "parent", createdAt: t + 2, newStartMs: t + 6 * 86400000, newEndMs: t + 6 * 86400000 + 3600000 };
    localStorage.__fakeDb = JSON.stringify(db);
  }, { ch: vT.channel, L78, L88 });
  const cab = await openCabinet(app, `#p=${PK_T}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.click('.ctab[data-ctab="requests"]');
  await cab.waitForFunction(() => document.querySelectorAll("#pane-requests .req-item .pill.pending").length === 3);
  // кнопки — только на двух заявках родителя, не на заявке ученика
  assert.equal(await cab.locator("#pane-requests [data-withdraw]").count(), 2);
  assert.deepEqual((await cab.locator("#pane-requests [data-withdraw]").evaluateAll((bs) => bs.map((b) => b.dataset.withdraw))).sort(), ["mine1", "mine2"]);
  // отзываем «новое занятие» из «Заявок»
  await cab.click('[data-withdraw="mine2"]');
  await waitFor(async () => !(await app.db())[`channels/${vT.channel}/items/mine2`], "заявка удалена из канала");
  await cab.waitForFunction(() => document.querySelectorAll("#pane-requests .req-item .pill.pending").length === 2);
  assert.match(cab.dialogs.join("|"), /Отменить заявку на новое занятие\?/);
  // окно занятия с заявкой ученика: «Ученик попросил…», кнопки нет
  await cab.click('.ctab[data-ctab="lessons"]');
  await cab.locator("#pane-lessons .lesson", { hasText: "8/8" }).first().click();
  await cab.waitForSelector("#modalBack", { state: "visible" });
  assert.match(await cab.textContent("#modal"), /Ученик попросил перенести/);
  assert.equal(await cab.locator("#modal [data-withdraw]").count(), 0);
  await cab.click("#modal .modal-x");
  // окно своей заявки: «Вы попросили…» + «Отменить заявку» → снова можно перенести/отменить
  await cab.locator("#pane-lessons .lesson", { hasText: "7/8" }).first().click();
  await cab.waitForSelector("#modal [data-withdraw]");
  assert.match(await cab.textContent("#modal"), /Вы попросили отменить/);
  await cab.click("#modal [data-withdraw]");
  await cab.waitForSelector("#modal #mCancel");
  await waitFor(async () => !(await app.db())[`channels/${vT.channel}/items/mine1`], "своя заявка удалена");
  assert.ok((await app.db())[`channels/${vT.channel}/items/theirs1`], "заявка ученика цела");
  // у учителя в «Заявках» осталась только заявка ученика
  await app.page.click('.tab[data-tab="requests"]');
  await app.page.waitForFunction(() => document.querySelectorAll("#requestsList .req").length === 1);
  assert.deepEqual(cab.errors, []);
  await cab.close();
  await app.close();
});

test("заявку отозвали, пока учитель подтверждал, — изменения не применяются", async () => {
  let other = null, ch = null;
  const dialogs = [];
  const vKey = `parentAccess/${PK_T}`;
  const app = await openFamily({ onDialog: async (d) => {
    dialogs.push(d.message());
    if (/^Перенести/.test(d.message())) {
      // пока открыт вопрос «Перенести …?», семья нажала «Отменить заявку»
      // (из другой вкладки: страница учителя стоит на окне подтверждения)
      await other.evaluate((p) => { const db = JSON.parse(localStorage.__fakeDb); delete db[p]; localStorage.__fakeDb = JSON.stringify(db); }, `channels/${ch}/items/wd1`);
    }
    return true;
  } });
  other = await app.context.newPage();
  await other.goto(app.base + "/cabinet.html");
  ch = (await app.db())[vKey].channel;
  const L78 = "serA_20260928T070000Z";
  const t = Date.parse("2026-10-02T12:00:00+03:00");
  await app.page.evaluate(({ ch, L78, t }) => {
    const db = JSON.parse(localStorage.__fakeDb);
    db[`channels/${ch}/items/wd1`] = { type: "reschedule", lessonId: L78, by: "parent", createdAt: Date.now(), newStartMs: t, newEndMs: t + 3600000 };
    localStorage.__fakeDb = JSON.stringify(db);
  }, { ch, L78, t });
  await app.page.click('.tab[data-tab="requests"]');
  await app.page.waitForSelector('#requestsList .req[data-id="wd1"] [data-req="approve"]');
  await app.page.click('#requestsList .req[data-id="wd1"] [data-req="approve"]');
  await waitFor(() => dialogs.some((m) => /уже отозвали/.test(m)), "учителю сказали, что заявку отозвали: " + JSON.stringify(dialogs));
  const db = await app.db();
  assert.equal(db[L(L78)].status, "planned", "занятие не перенесено");
  assert.equal(db[`teacherSpaces/${T}/requests/wd1`], undefined, "решение не записано");
  await app.close();
});
