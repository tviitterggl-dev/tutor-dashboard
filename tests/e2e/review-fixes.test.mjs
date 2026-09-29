// Находки общего ревью (запись 51 в DEVLOG): у каждой — проверка, которая
// падала на старом коде.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);

const PK = "parent_key_test_student_0000000001";
const SK = "student_key_test_student_000000002";
const PA = "parent_key_anna_student_0000000003";
const S = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const N = (id) => `teacherSpaces/${T}/notifications/${id}`;
const CH_S = "channel_shared_test_0000000000001";
const CH_P = "channel_parent_test_0000000000001";
const CH_AS = "channel_shared_anna_0000000000001";
const CH_AP = "channel_parent_anna_0000000000001";
const now = Date.parse(NOW);
const H = 3600000, DAY = 24 * H;
const key = (role, studentId, extra) => Object.assign({ role, studentId, label: "", createdAt: 1, active: true, revokedAt: null }, extra || {});
const item = (ch, id) => `channels/${ch}/items/${id}`;

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
function seedWithChannels(channelsCreatedAt) {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = key("parent", "Тест, 7 класс");
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = key("student", "Тест, 7 класс");
  seed[S].studentChannels = { "Тест, 7 класс": { shared: CH_S, parent: CH_P, createdAt: channelsCreatedAt ?? now - DAY } };
  return seed;
}

test("каналы не копят «оплачено»/«пояснение»: учтённые в занятии и старше суток удаляются, свежие остаются до витрины", async () => {
  const seed = seedWithChannels();
  const paidAt = now - 5 * DAY, freshAt = now - H;
  // учтено в занятии давно — сообщение больше не нужно
  Object.assign(seed[L("serA_20260914T070000Z")], { paid: { value: true, by: "parent", at: paidAt }, familyNote: { text: "Болел", by: "parent", at: paidAt } });
  seed[item(CH_P, "p_old")] = { type: "paid", lessonId: "serA_20260914T070000Z", by: "parent", createdAt: paidAt, paid: true };
  seed[item(CH_S, "n_old")] = { type: "note", lessonId: "serA_20260914T070000Z", by: "parent", createdAt: paidAt, comment: "Болел" };
  // отметка учителя (её копия для родителя) — тоже учтена
  Object.assign(seed[L("serA_20260916T070000Z")], { paid: { value: true, by: "teacher", at: paidAt } });
  seed[item(CH_P, "t_old")] = { type: "paid", lessonId: "serA_20260916T070000Z", by: "teacher", createdAt: paidAt, paid: true };
  // свежее (час назад) — остаётся, пока витрина семьи не догонит
  Object.assign(seed[L("serA_20260918T070000Z")], { paid: { value: true, by: "parent", at: freshAt } });
  seed[item(CH_P, "p_fresh")] = { type: "paid", lessonId: "serA_20260918T070000Z", by: "parent", createdAt: freshAt, paid: true };
  // старое, но ещё НЕ учтённое (учитель давно не заходил) — сначала в занятие и витрину, потом удалить
  seed[item(CH_P, "p_new")] = { type: "paid", lessonId: "serA_20260921T070000Z", by: "parent", createdAt: now - 3 * DAY, paid: true };
  // заявка ждёт решения — не трогаем
  seed[item(CH_S, "req")] = { type: "cancel", lessonId: "serA_20260930T070000Z", by: "parent", createdAt: now - 3 * DAY };
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await waitFor(async () => { const db = await app.db(); return !db[item(CH_P, "p_new")] && !db[item(CH_P, "p_old")]; }, "чистка каналов");
  const db = await app.db();
  assert.equal(db[item(CH_S, "n_old")], undefined, "учтённое пояснение удалено");
  assert.equal(db[item(CH_P, "t_old")], undefined, "учтённая отметка учителя удалена");
  assert.ok(db[item(CH_P, "p_fresh")], "свежая отметка осталась");
  assert.ok(db[item(CH_S, "req")], "заявка осталась");
  assert.equal(db[L("serA_20260921T070000Z")].paid.value, true, "неучтённая отметка сначала попала в занятие");
  const lv = (id) => db[`parentAccess/${PK}`].lessons.find((l) => l.id === id);
  assert.equal(lv("serA_20260921T070000Z").paid, true, "…и в витрину родителя");
  assert.equal(lv("serA_20260914T070000Z").familyNote.text, "Болел", "пояснение видно из витрины");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("отзыв доступа, недошедший до смены каналов (сбой посреди отзыва), доделывается при следующем входе", async () => {
  const seed = seedWithChannels(now - 2 * DAY);
  seed[`teacherSpaces/${T}/accessKeys/${SK}`] = key("student", "Тест, 7 класс", { active: false, revokedAt: now - H }); // отозван ПОСЛЕ заведения каналов
  seed[item(CH_S, "req")] = { type: "cancel", lessonId: "serA_20260930T070000Z", by: "parent", createdAt: now - 3 * H };
  const app = await openApp({ seed });
  await app.page.waitForSelector("#lessonsList .lesson");
  const ch = await waitFor(async () => { const c = (await app.db())[S].studentChannels["Тест, 7 класс"]; return c && c.shared !== CH_S && c; }, "новые каналы");
  const db = await waitFor(async () => { const d = await app.db(); return d[`parentAccess/${PK}`] && d[`parentAccess/${PK}`].channel === ch.shared && d; }, "витрина с новым каналом");
  assert.notEqual(ch.parent, CH_P);
  assert.equal(Object.keys(db).some((p) => p.startsWith(`channels/${CH_S}/`)), false, "старый канал пуст");
  assert.ok(db[item(ch.shared, "req")], "ждущая заявка переехала");
  assert.equal(db[`parentAccess/${PK}`].parentChannel, ch.parent);
  await app.close();
});

test("у ученика не осталось доступов — его каналы удаляются (рассылка и кабинет их больше не читают)", async () => {
  const seed = seedWithChannels();
  seed[`teacherSpaces/${T}/accessKeys/${PA}`] = key("parent", "Анна, 6 класс", { active: false, revokedAt: now - 10 * DAY });
  seed[S].studentChannels["Анна, 6 класс"] = { shared: CH_AS, parent: CH_AP, createdAt: now - 30 * DAY };
  seed[item(CH_AP, "p1")] = { type: "paid", lessonId: "anna1", by: "parent", createdAt: now - 20 * DAY, paid: true };
  seed[item(CH_AS, "n1")] = { type: "note", lessonId: "anna1", by: "parent", createdAt: now - 20 * DAY, comment: "x" };
  const app = await openApp({ seed });
  await app.page.waitForSelector("#lessonsList .lesson");
  const db = await waitFor(async () => { const d = await app.db(); return !d[S].studentChannels["Анна, 6 класс"] && d; }, "каналы Анны удалены");
  assert.equal(Object.keys(db).some((p) => p.startsWith(`channels/${CH_AS}/`) || p.startsWith(`channels/${CH_AP}/`)), false);
  assert.equal(db[S].studentChannels["Тест, 7 класс"].shared, CH_S, "каналы ученика с доступом не тронуты");
  // отзыв ПОСЛЕДНЕГО доступа — каналы сразу удаляются, а не заводятся новые
  const { page } = app;
  await page.click('.tab[data-tab="students"]');
  await page.click(`[data-key-revoke="${SK}"]`);
  await page.waitForFunction(() => /Доступ отозван/.test(document.querySelector("#akMsg").textContent));
  await page.click(`[data-key-revoke="${PK}"]`);
  await page.waitForFunction(() => /Доступ отозван/.test(document.querySelector("#akMsg").textContent) && !document.querySelector("[data-key-revoke]"));
  const db2 = await waitFor(async () => { const d = await app.db(); return !d[S].studentChannels["Тест, 7 класс"] && d; }, "каналы Теста удалены");
  assert.equal(Object.keys(db2).some((p) => p.startsWith("channels/")), false, "каналов не осталось");
  await app.close();
});

test("«Отчёт»: уведомление не ушло — повторное нажатие отправляет, а не отвечает «изменений нет»", async () => {
  const seed = seedWithChannels();
  const app = await openApp({ seed });
  app.expectErrors = /нет сети для уведомления/;
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.evaluate(() => {
    const orig = window.TutorFB.saveNotification;
    let first = true;
    window.TutorFB.saveNotification = async (...a) => { if (first) { first = false; throw new Error("нет сети для уведомления"); } return orig.apply(window.TutorFB, a); };
  });
  await page.evaluate(() => openLessonModal("serA_20260923T070000Z"));
  await page.waitForSelector("#mSaveReport");
  await page.fill("#mReport", "Прошли дроби");
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /уведомление не ушло/.test(document.querySelector("#mMsg").textContent));
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /опубликован и отправлен/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  const sent = Object.entries(db).filter(([p, d]) => p.startsWith(`teacherSpaces/${T}/notifications/`) && d.source === "report");
  assert.equal(sent.length, 1, "уведомление ушло один раз");
  assert.match(sent[0][1].text, /Прошли дроби/);
  await app.close();
});

test("«убрать» файл ДЗ не стирает файл семьи, пришедший, пока окно было открыто (общая функция обычного и группового окна)", async () => {
  const seed = seedWithChannels();
  const teacherFile = { url: "https://res.cloudinary.com/x/teacher.pdf", name: "задание.pdf", by: "teacher" };
  const familyFile = { url: "https://res.cloudinary.com/x/kid.jpg", name: "решение.jpg", by: "student", uploadedAt: now };
  seed[L("serA_20260923T070000Z")].homework = [teacherFile];
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.evaluate(() => openLessonModal("serA_20260923T070000Z"));
  await page.waitForSelector("[data-hw-remove]");
  // пока окно открыто, ДЗ ученика дошло до занятия (как делает processChannel)
  await page.evaluate(([path, f]) => {
    const db = JSON.parse(localStorage.getItem("__fakeDb"));
    db[path].homework = db[path].homework.concat([f]);
    localStorage.setItem("__fakeDb", JSON.stringify(db));
  }, [L("serA_20260923T070000Z"), familyFile]);
  await page.click(`[data-hw-remove="${teacherFile.url}"]`);
  await page.waitForFunction(() => /убран/.test(document.querySelector("#mMsg").textContent));
  const hw = (await app.db())[L("serA_20260923T070000Z")].homework;
  assert.deepEqual(hw.map((h) => h.name), ["решение.jpg"], "файл учителя убран, файл ученика на месте");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("перенос обычного занятия сохраняет разовую ссылку на созвон (как перенос группы)", async () => {
  const seed = seedWithChannels();
  seed[L("serA_20260925T070000Z")].callUrl = "https://telemost.yandex.ru/j/once";
  const app = await openApp({ seed });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.evaluate(() => openLessonModal("serA_20260925T070000Z"));
  await page.waitForSelector("#mMove");
  await page.fill("#mTime", "12:00");
  await page.click("#mMove");
  await page.waitForFunction(() => /Перенесено/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  const old = db[L("serA_20260925T070000Z")];
  assert.equal(old.status, "rescheduled");
  assert.equal(db[L(old.rescheduledTo)].callUrl, "https://telemost.yandex.ru/j/once");
  assert.equal(await page.getAttribute("#mCallOpen", "href"), "https://telemost.yandex.ru/j/once");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("смена класса переносит и уведомления ученику: напоминания продолжают приходить", async () => {
  const seed = seedWithChannels();
  seed[N("b1")] = { text: "Через час занятие", mode: "before", offsetValue: 1, offsetUnit: "hour", target: { scope: "student", role: "parent", studentId: "Тест, 7 класс" }, active: true, createdAt: now - DAY };
  seed[N("k1")] = { text: "Лично", mode: "once", times: 1, target: { scope: "key", key: PK, studentId: "Тест, 7 класс" }, active: true, createdAt: now - DAY };
  seed[N("a1")] = { text: "Анне", mode: "once", times: 1, target: { scope: "student", role: "any", studentId: "Анна, 6 класс" }, active: true, createdAt: now - DAY };
  const app = await openApp({ seed, onDialog: () => true });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Тест, 7 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-cls").fill("8");
  await card.locator("[data-pf-save]").click();
  await page.waitForSelector('.student-card[data-student="Тест, 8 класс"] .pf-msg.ok');
  const db = await waitFor(async () => { const d = await app.db(); return d[`parentAccess/${PK}`] && d[`parentAccess/${PK}`].studentId === "Тест, 8 класс" && d; }, "витрина после смены класса");
  assert.equal(db[N("b1")].target.studentId, "Тест, 8 класс");
  assert.equal(db[N("b1")].target.role, "parent");
  assert.equal(db[N("k1")].target.studentId, "Тест, 8 класс");
  assert.equal(db[N("a1")].target.studentId, "Анна, 6 класс", "чужие не тронуты");
  // в витрине родителя уведомление по-прежнему есть (адресат совпадает с ключом)
  assert.ok(db[`parentAccess/${PK}`].notices.some((x) => x.text === "Лично"), "«разово» лично родителю видно в кабинете");
  await app.close();
});
