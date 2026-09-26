// Вкладка «Уведомления»: конструктор (текст, когда, кому, к каким занятиям),
// «Отправить сейчас», показ в кабинетах, подписка на пуш.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";
const PK2 = "parent_key_test_student_second_0002";
const SK = "student_key_test_student_000000002";
const PA = "parent_key_anna_student_0000000003";
const N = (id) => `teacherSpaces/${T}/notifications/${id}`;
const notifs = (db) => Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/notifications/`)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
async function openFamily(opts = {}) {
  const seed = defaultSeed();
  const k = (role, studentId, label, createdAt) => ({ role, studentId, label, createdAt, active: true, revokedAt: null });
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", "Тест, 7 класс", "мама", 1);
  seed[`teacherSpaces/${T}/accessKeys/${PK2}`] = k("parent", "Тест, 7 класс", "папа", 2);
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", "Тест, 7 класс", "", 3);
  seed[`teacherSpaces/${T}/accessKeys/${PA}`] = k("parent", "Анна, 6 класс", "", 4);
  const app = await openApp(Object.assign({ seed }, opts));
  await waitFor(async () => { const db = await app.db(); return db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`] && db[`parentAccess/${PA}`]; }, "витрины");
  app.base = app.page.url().replace(/\/index\.html.*$/, "");
  return app;
}
async function openCabinet(app, hash) {
  const cab = await app.context.newPage();
  cab.errors = [];
  cab.on("pageerror", (e) => cab.errors.push(String(e)));
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(app.base + "/cabinet.html" + hash);
  await cab.waitForSelector("#pane-lessons .lesson");
  return cab;
}
const noticeTexts = (cab) => cab.$$eval("#notices .notice-text", (els) => els.map((e) => e.textContent));

test("конструктор: «перед занятием» (свободное время, выбранные занятия) и «разово N раз» — сохраняются, видны в кабинетах только адресатам", async () => {
  const app = await openFamily();
  const { page } = app;
  await page.click('.tab[data-tab="notify"]');
  await page.waitForSelector("#nfList .empty, #nfList .nf-item");
  // адресаты: все / роли / ученик / конкретный человек
  const opts = await page.$$eval("#nfTo option", (o) => o.map((x) => x.textContent));
  for (const t of ["Все родители и ученики", "Все родители", "Все ученики", "Тест, 7 класс — родители", "Тест, 7 класс — ученик", "Тест, 7 класс — папа (родитель)", "Анна, 6 класс — все"]) {
    assert.ok(opts.includes(t), t + " в " + JSON.stringify(opts));
  }
  // ошибки формы
  await page.click("#nfSave");
  await page.waitForFunction(() => /Напиши текст/.test(document.querySelector("#nfMsg").textContent));

  // 1) «За 1 день 2 часа» → 26 часов; только родителям Теста; только к занятию 25.09 (6/8)
  await page.fill("#nfText", "Напоминаю: {дата} в {время} занятие у {ученик}");
  await page.fill("#nfOffset", "26");
  await page.selectOption("#nfUnit", "hour");
  await page.selectOption("#nfTo", { label: "Тест, 7 класс — родители" });
  await page.waitForSelector("#nfLessonsWrap", { state: "visible" });
  await page.waitForSelector("#nfLessons input");
  const lessonLabels = await page.$$eval("#nfLessons label", (l) => l.map((x) => x.textContent.trim()));
  assert.ok(lessonLabels.some((t) => /6\/8/.test(t)), JSON.stringify(lessonLabels));
  await page.locator("#nfLessons label", { hasText: "6/8" }).locator("input").check();
  assert.equal(await page.isChecked('input[name="nfLessonsMode"][value="some"]'), true, "выбор занятия включает «только к выбранным»");
  await page.click("#nfSave");
  await page.waitForFunction(() => /Уведомление сохранено/.test(document.querySelector("#nfMsg").textContent));
  // 2) «Разово 2 раза» — всем
  await page.fill("#nfText", "Оплата за октябрь — до 5-го числа");
  await page.check('input[name="nfMode"][value="once"]');
  await page.fill("#nfTimes", "2");
  await page.selectOption("#nfTo", { label: "Все родители и ученики" });
  assert.equal(await page.isVisible("#nfLessonsWrap"), false, "для «всех» занятий не выбрать");
  await page.click("#nfSave");
  await page.waitForFunction(() => /Уведомление сохранено/.test(document.querySelector("#nfMsg").textContent));

  const list = notifs(await app.db());
  const before = list.find((n) => n.mode === "before");
  const once = list.find((n) => n.mode === "once");
  assert.deepEqual([before.offsetValue, before.offsetUnit, before.target.scope, before.target.role, before.target.studentId], [26, "hour", "student", "parent", "Тест, 7 класс"]);
  assert.deepEqual(before.lessonIds, ["serA_20260925T070000Z"]);
  assert.equal(once.times, 2);
  assert.deepEqual(once.target, { scope: "all", role: "any" });
  assert.match(await page.innerText("#nfList"), /Перед занятием — за 26 часов · к 1 занятию/);
  assert.match(await page.innerText("#nfList"), /Разово — при открытии кабинета 2 раза/);

  // Витрины: родителю Теста — оба, ученику Теста и родителю Анны — только «разово»
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`].notices?.length === 2, "уведомления в витрине");
  const db = await app.db();
  assert.deepEqual(db[`studentAccess/${SK}`].notices.map((n) => n.mode), ["once"]);
  assert.deepEqual(db[`parentAccess/${PA}`].notices.map((n) => n.mode), ["once"]);

  // Кабинет родителя: «разово» + напоминание (25.09 10:00 − 26 ч = 24.09 08:00 ≤ сейчас 12:00)
  const mom = await openCabinet(app, `#p=${PK}`);
  await mom.waitForSelector("#notices .notice");
  const texts = await noticeTexts(mom);
  assert.ok(texts.includes("Оплата за октябрь — до 5-го числа"));
  assert.ok(texts.includes("Напоминаю: 25 сентября в 10:00 занятие у Тест, 7 класс"), JSON.stringify(texts));
  assert.match(await mom.textContent("#notices"), /Напоминание о занятии/);
  // «разово 2 раза»: второе открытие — ещё видно, третье — уже нет (напоминание остаётся)
  await mom.reload(); await mom.waitForSelector("#notices .notice");
  assert.ok((await noticeTexts(mom)).includes("Оплата за октябрь — до 5-го числа"));
  await mom.reload(); await mom.waitForSelector("#pane-lessons .lesson"); await mom.waitForTimeout(300);
  assert.deepEqual(await noticeTexts(mom), ["Напоминаю: 25 сентября в 10:00 занятие у Тест, 7 класс"]);
  // «Понятно, скрыть» у напоминания
  await mom.click("[data-notice-close]");
  assert.equal(await mom.locator("#notices .notice").count(), 0);
  await mom.reload(); await mom.waitForSelector("#pane-lessons .lesson"); await mom.waitForTimeout(300);
  assert.equal(await mom.locator("#notices .notice").count(), 0, "скрытое не возвращается");

  // Кабинет ученика: только «разово», без родительского напоминания
  const kid = await openCabinet(app, `#s=${SK}`);
  await kid.waitForSelector("#notices .notice");
  assert.deepEqual(await noticeTexts(kid), ["Оплата за октябрь — до 5-го числа"]);

  // Выключить и удалить
  await page.locator(".nf-item", { hasText: "Оплата за октябрь" }).locator("[data-nf-toggle]").click();
  await waitFor(async () => notifs(await app.db()).find((n) => n.mode === "once").active === false, "выключено");
  await waitFor(async () => (await app.db())[`studentAccess/${SK}`].notices.length === 0, "из витрины пропало");
  await page.locator(".nf-item", { hasText: "Напоминаю" }).locator("[data-nf-delete]").click();
  await waitFor(async () => !notifs(await app.db()).some((n) => n.mode === "before"), "удалено");
  assert.deepEqual(mom.errors, []);
  assert.deepEqual(kid.errors, []);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("изменить уведомление: форма заполняется, «перед занятием» сохраняет id; разовое после правки — новое", async () => {
  const app = await openFamily();
  const { page } = app;
  await page.click('.tab[data-tab="notify"]');
  await page.fill("#nfText", "За 90 минут");
  await page.fill("#nfOffset", "90");
  await page.selectOption("#nfUnit", "min");
  await page.selectOption("#nfTo", { label: "Все ученики" });
  await page.click("#nfSave");
  await page.waitForFunction(() => /сохранено/.test(document.querySelector("#nfMsg").textContent));
  const id = notifs(await app.db())[0].id;
  await page.locator(".nf-item").first().locator("[data-nf-edit]").click();
  assert.equal(await page.inputValue("#nfText"), "За 90 минут");
  assert.equal(await page.inputValue("#nfOffset"), "90");
  assert.equal(await page.textContent("#nfTitle"), "Изменить уведомление");
  await page.fill("#nfOffset", "1.5");
  await page.selectOption("#nfUnit", "hour");
  await page.click("#nfSave");
  await page.waitForFunction(() => /Изменения сохранены/.test(document.querySelector("#nfMsg").textContent));
  const after1 = notifs(await app.db());
  assert.deepEqual(after1.map((n) => [n.id, n.offsetValue, n.offsetUnit]), [[id, 1.5, "hour"]]);
  assert.match(await page.innerText("#nfList"), /за 1,5 часа/);
  await app.close();
});

test("«Отправить сейчас»: конкретному человеку — сразу появляется в открытом кабинете; другим — нет", async () => {
  const app = await openFamily();
  const { page } = app;
  const dad = await openCabinet(app, `#p=${PK2}`);
  const mom = await openCabinet(app, `#p=${PK}`);
  await page.click('.tab[data-tab="notify"]');
  await page.selectOption("#nwTo", { label: "Тест, 7 класс — папа (родитель)" });
  await page.fill("#nwText", "Сегодня занятие в 19:00, не в 18:00");
  await page.click("#nwSend");
  await page.waitForFunction(() => /Отправлено/.test(document.querySelector("#nwMsg").textContent));
  assert.match(await page.textContent("#nwMsg"), /1 кабинет/);
  const n = notifs(await app.db())[0];
  assert.deepEqual([n.mode, n.times, n.target.scope, n.target.key, n.push], ["now", 1, "key", PK2, true]);
  // открытый кабинет папы обновился сам
  await dad.waitForFunction(() => /Сегодня занятие в 19:00/.test(document.querySelector("#notices").textContent), null, { timeout: 8000 });
  assert.match(await dad.textContent("#notices"), /Сообщение от преподавателя/);
  await mom.waitForTimeout(600);
  assert.equal(await mom.locator("#notices .notice").count(), 0, "маме не приходило");
  assert.match(await page.innerText("#nfList"), /Отправлено сейчас/);
  assert.deepEqual(dad.errors, []);
  await app.close();
});

test("пуш: без ключа — кнопки нет; с ключом — «Включить» создаёт подписку (токен + ключ), учитель видит устройство; отзыв и «Выключить» её убирают", async () => {
  // без публичного ключа
  const app0 = await openFamily({ vapidKey: "" });
  const c0 = await openCabinet(app0, `#p=${PK}`);
  await c0.click('.ctab[data-ctab="more"]');
  assert.match(await c0.innerText("#pushBody"), /пока не включены у преподавателя/);
  assert.equal(await c0.locator("#pushOnBtn").count(), 0);
  await app0.close();

  const app = await openFamily({ vapidKey: "BTestPublicVapidKey_for_tests_only_0123456789", serviceWorkers: "allow", persistent: { channel: "chromium" } });
  await app.context.grantPermissions(["notifications"], { origin: app.base });
  const cab = await openCabinet(app, `#p=${PK}`);
  await cab.click('.ctab[data-ctab="more"]');
  await cab.click("#pushOnBtn");
  await cab.waitForFunction(() => /Уведомления будут приходить/.test(document.querySelector("#pushMsg").textContent), null, { timeout: 8000 });
  assert.match(await cab.innerText("#pushBody"), /включены на этом устройстве/);
  const ch = (await app.db())[`parentAccess/${PK}`].channel;
  const pushItems = async () => { const db = await app.db(); return Object.entries(db).filter(([p, d]) => p.startsWith(`channels/${ch}/items/`) && d.type === "push").map(([, d]) => d); };
  const items = await pushItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].key, PK);
  assert.equal(items[0].by, "parent");
  assert.match(items[0].token, /^fake-fcm-token-/);
  // повторное «Включить» на том же устройстве не плодит подписки
  await cab.reload(); await cab.waitForSelector("#pane-lessons .lesson");
  await cab.click('.ctab[data-ctab="more"]');
  assert.equal(await cab.locator("#pushOnBtn").count(), 0, "уже включено");
  // учитель видит устройство; сообщения о занятиях канал не ломают
  const { page } = app;
  await page.click('.tab[data-tab="notify"]');
  await page.waitForFunction(() => /Тест, 7 класс\s*1 устройство/.test(document.querySelector("#nfPushStatus").innerText));
  assert.match(await page.innerText("#nfPushStatus"), /ещё ни разу не запускалась/);
  await page.waitForTimeout(800);
  assert.equal((await pushItems()).length, 1, "обработка канала учителем не удаляет подписку");

  // «Выключить»
  await cab.click("#pushOff");
  await cab.waitForFunction(() => /выключены/.test(document.querySelector("#pushMsg").textContent));
  assert.equal((await pushItems()).length, 0);
  assert.deepEqual(cab.errors, []);
  await app.close();
});

test("пуш: при отзыве доступа подписка этого человека не переезжает в новый канал, у остальных — переезжает", async () => {
  const app = await openFamily({ vapidKey: "BTestPublicVapidKey_for_tests_only_0123456789", serviceWorkers: "allow", persistent: { channel: "chromium" } });
  await app.context.grantPermissions(["notifications"], { origin: app.base });
  for (const [hash, seedTok] of [[`#p=${PK}`, "mom"], [`#p=${PK2}`, "dad"]]) {
    const cab = await openCabinet(app, hash);
    await cab.evaluate((s) => localStorage.setItem("__fakeFcmSeed", s), seedTok);
    await cab.click('.ctab[data-ctab="more"]');
    await cab.click("#pushOnBtn");
    await cab.waitForFunction(() => /Уведомления будут приходить/.test(document.querySelector("#pushMsg").textContent), null, { timeout: 8000 });
    await cab.close();
  }
  const { page } = app;
  await page.click('.tab[data-tab="students"]');
  await page.waitForSelector(`[data-key-revoke="${PK2}"]`);
  await page.click(`[data-key-revoke="${PK2}"]`);
  await page.waitForFunction(() => /Доступ отозван/.test(document.querySelector("#akMsg").textContent));
  const db = await app.db();
  const ch = db[`parentAccess/${PK}`] ? db[`teacherSpaces/${T}/state/main`].studentChannels["Тест, 7 класс"].shared : null;
  const items = Object.entries(db).filter(([p, d]) => p.startsWith(`channels/${ch}/items/`) && d.type === "push").map(([, d]) => d.key);
  assert.deepEqual(items, [PK], "осталась только мама");
  await app.close();
});

test("service worker: пуш в формате FCM показывает уведомление с текстом и ссылкой на кабинет", async () => {
  const app = await openFamily({ vapidKey: "BTestPublicVapidKey_for_tests_only_0123456789", serviceWorkers: "allow", persistent: { channel: "chromium" } });
  await app.context.grantPermissions(["notifications"], { origin: app.base });
  const cab = await openCabinet(app, `#p=${PK}`);
  await cab.click('.ctab[data-ctab="more"]');
  await cab.click("#pushOnBtn");
  await cab.waitForFunction(() => /Уведомления будут приходить/.test(document.querySelector("#pushMsg").textContent), null, { timeout: 8000 });
  const cdp = await app.context.newCDPSession(cab);
  const regs = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
  await cdp.send("ServiceWorker.enable");
  await waitFor(async () => regs.some((r) => !r.isDeleted), "регистрация service worker");
  const reg = regs.find((r) => !r.isDeleted);
  const url = `${app.base}/cabinet.html#p=${PK}`;
  // так FCM доставляет data-сообщение из notifier/send.mjs
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: app.base, registrationId: reg.registrationId,
    data: JSON.stringify({ data: { title: "Напоминание о занятии", body: "В 10:00 занятие", url, tag: "r1__m1" }, from: "580713659609" }),
  });
  const shown = await waitFor(async () => {
    const list = await cab.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, url: n.data && n.data.url, tag: n.tag })));
    return list.length ? list : null;
  }, "уведомление показано");
  assert.deepEqual(shown, [{ title: "Напоминание о занятии", body: "В 10:00 занятие", url, tag: "r1__m1" }]);
  await app.close();
});

test("заголовок: свой — в кабинете вместо стандартной подписи и в пуше; пустой — как раньше", async () => {
  const app = await openFamily();
  const { page } = app;
  await page.click('.tab[data-tab="notify"]');
  await page.waitForSelector("#nfList .empty, #nfList .nf-item");
  // подсказка в пустом поле — стандартный заголовок выбранного режима
  assert.equal(await page.getAttribute("#nfHead", "placeholder"), "Напоминание о занятии");
  await page.check('input[name="nfMode"][value="once"]');
  assert.equal(await page.getAttribute("#nfHead", "placeholder"), "Сообщение от преподавателя");
  await page.check('input[name="nfMode"][value="before"]');

  // «перед занятием» со своим заголовком и подстановкой
  await page.fill("#nfHead", "Важно: {ученик}");
  await page.fill("#nfText", "Завтра в {время}");
  await page.fill("#nfOffset", "26");
  await page.selectOption("#nfUnit", "hour");
  await page.selectOption("#nfTo", { label: "Тест, 7 класс — родители" });
  await page.click("#nfSave");
  await page.waitForFunction(() => /Уведомление сохранено/.test(document.querySelector("#nfMsg").textContent));
  assert.equal(await page.inputValue("#nfHead"), "", "форма очистилась");
  // «Отправить сейчас»: один со своим заголовком, второй без
  await page.selectOption("#nwTo", { label: "Тест, 7 класс — папа (родитель)" });
  await page.fill("#nwHead", "Отчёт о прошедшем занятии");
  await page.fill("#nwText", "Всё получилось");
  await page.click("#nwSend");
  await page.waitForFunction(() => /Отправлено/.test(document.querySelector("#nwMsg").textContent));
  assert.equal(await page.inputValue("#nwHead"), "");
  await page.fill("#nwText", "Без заголовка");
  await page.click("#nwSend");
  await page.waitForFunction(() => /Отправлено/.test(document.querySelector("#nwMsg").textContent) && !document.querySelector("#nwText").value);

  const list = notifs(await app.db());
  assert.equal(list.find((n) => n.mode === "before").title, "Важно: {ученик}");
  assert.equal(list.find((n) => n.text === "Всё получилось").title, "Отчёт о прошедшем занятии");
  assert.equal(list.find((n) => n.text === "Без заголовка").title, "");
  // в списке учителя — заголовок над текстом (стандартный — бледнее)
  await page.waitForFunction(() => document.querySelectorAll("#nfList .nf-item").length === 3);
  const heads = await page.$$eval("#nfList .nf-head", (h) => h.map((x) => [x.textContent, x.classList.contains("dflt")]));
  assert.deepEqual(heads.sort(), [["Важно: {ученик}", false], ["Отчёт о прошедшем занятии", false], ["Сообщение от преподавателя", true]]);

  // кабинет папы: свой заголовок, стандартный у пустого, подстановка в напоминании
  await waitFor(async () => (await app.db())[`parentAccess/${PK2}`].notices?.length === 3, "витрина");
  const dad = await openCabinet(app, `#p=${PK2}`);
  await dad.waitForFunction(() => document.querySelectorAll("#notices .notice").length === 3);
  const cards = await dad.$$eval("#notices .notice", (els) => els.map((e) => [e.querySelector(".notice-head").textContent, e.querySelector(".notice-text").textContent]));
  assert.deepEqual(cards.sort(), [
    ["Важно: Тест, 7 класс", "Завтра в 10:00"],
    ["Отчёт о прошедшем занятии", "Всё получилось"],
    ["Сообщение от преподавателя", "Без заголовка"],
  ]);

  // правка: заголовок подставляется в форму и меняется
  await page.locator(".nf-item", { hasText: "Завтра в" }).locator("[data-nf-edit]").click();
  assert.equal(await page.inputValue("#nfHead"), "Важно: {ученик}");
  await page.fill("#nfHead", "");
  await page.click("#nfSave");
  await page.waitForFunction(() => /Изменения сохранены/.test(document.querySelector("#nfMsg").textContent));
  assert.equal(notifs(await app.db()).find((n) => n.mode === "before").title, "");
  await waitFor(async () => !(await app.db())[`parentAccess/${PK2}`].notices.find((n) => n.mode === "before").title, "витрина без заголовка");
  assert.deepEqual(dad.errors, []);
  assert.deepEqual(app.errors, []);
  await app.close();
});
