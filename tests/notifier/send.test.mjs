// Фоновая рассылка (notifier/send.mjs) против локального эмулятора Firestore:
// читает настоящую структуру базы, шлёт «пуши» подделке, ведёт журнал.
// Запуск: cd tests && npm run test:notifier
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runOnce } from "../../notifier/send.mjs";

const req = createRequire(new URL("../../notifier/package.json", import.meta.url));
const core = createRequire(import.meta.url)("../../notify-core.js");
const { initializeApp } = req("firebase-admin/app");
const { getFirestore, Query, DocumentReference, Firestore } = req("firebase-admin/firestore");
const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const db = getFirestore(initializeApp({ projectId: "demo-tutor" }));

const T = "teacherUid0123456789abcdef";
const CH = "channel_shared_for_tests_0123456";
const H = 3600000, M = 60000;
const NOW = Date.parse("2026-09-26T10:00:00+03:00");
const SITE = "https://example.org/tutor/";
const tRef = db.collection("teacherSpaces").doc(T);

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/demo-tutor/databases/(default)/documents`, { method: "DELETE" });
  await tRef.collection("state").doc("main").set({
    marks: {}, studentChannels: { "Маша, 7 класс": { shared: CH, parent: "channel_parent_for_tests_0123456" } },
    studentProfiles: { "Маша, 7 класс": { name: "Маша", surname: "Иванова", cls: 7 } },
  });
  const keys = {
    parent_key_masha_0000000000000001: { role: "parent", studentId: "Маша, 7 класс", active: true },
    student_key_masha_000000000000002: { role: "student", studentId: "Маша, 7 класс", active: true },
    parent_key_revoked_00000000000003: { role: "parent", studentId: "Маша, 7 класс", active: false },
  };
  for (const [id, k] of Object.entries(keys)) await tRef.collection("accessKeys").doc(id).set(k);
  await tRef.collection("lessons").doc("m1").set({ title: "Маша 7 класс", studentId: "Маша, 7 класс", startMs: NOW + 90 * M, endMs: NOW + 150 * M, status: "planned" });
  await tRef.collection("lessons").doc("m2").set({ title: "Маша 7 класс", studentId: "Маша, 7 класс", startMs: NOW + 5 * 24 * H, endMs: NOW + 5 * 24 * H + H, status: "planned" });
  const items = db.collection("channels").doc(CH).collection("items");
  // новая подписка — отпечаток ключа (сам ключ в общий канал не пишется);
  // у ребёнка — старая, с самим ключом (до 2026-09-27), тоже должна работать
  await items.doc("pushMom").set({ type: "push", lessonId: "-", by: "parent", createdAt: 1, token: "tok-mom-" + "x".repeat(30), key: await core.pushKeyId("parent_key_masha_0000000000000001") });
  await items.doc("pushKid").set({ type: "push", lessonId: "-", by: "student", createdAt: 1, token: "tok-kid-DEAD" + "x".repeat(30), key: "student_key_masha_000000000000002" });
  await items.doc("pushOld").set({ type: "push", lessonId: "-", by: "parent", createdAt: 1, token: "tok-old-" + "x".repeat(30), key: "parent_key_revoked_00000000000003" });
  await items.doc("hw").set({ type: "homework", lessonId: "m1", by: "student", createdAt: 1, file: { url: "https://res.cloudinary.com/x/a.pdf", name: "a.pdf" } });
  await tRef.collection("notifications").doc("r90").set({ text: "В {время} занятие ({ученик})", mode: "before", offsetValue: 90, offsetUnit: "min", target: { scope: "all", role: "any" }, active: true, createdAt: 1 });
  await tRef.collection("notifications").doc("now1").set({ text: "Сегодня без ДЗ", mode: "now", times: 1, target: { scope: "student", role: "parent", studentId: "Маша, 7 класс" }, active: true, createdAt: NOW - M });
  await tRef.collection("notifications").doc("off").set({ text: "Выключено", mode: "once", times: 1, target: { scope: "all", role: "any" }, active: false, createdAt: 1 });
}
function fakeSend(sent) {
  return async (messages) => messages.map((m) => {
    sent.push(m);
    return m.token.includes("DEAD") ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true };
  });
}
const quiet = { log() {}, error() {} };

beforeEach(seed);

test("рассылка: напоминание за 90 минут и «сейчас» — своим, по ссылке в свой кабинет; повторно — ничего", async () => {
  const sent = [];
  const s = await runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet });
  assert.equal(s.teachers, 1);
  const byTag = (tag) => sent.filter((m) => m.data.tag === tag);
  // напоминание: маме и ребёнку (отозванному — нет)
  const rem = byTag("r90__m1");
  assert.deepEqual(rem.map((m) => m.token.slice(0, 7)).sort(), ["tok-kid", "tok-mom"]);
  assert.equal(rem[0].data.title, "Напоминание о занятии");
  assert.equal(rem[0].data.body, "В 11:30 занятие (Маша Иванова, 7 класс)");
  const momMsg = rem.find((m) => m.token.startsWith("tok-mom"));
  assert.equal(momMsg.data.url, `${SITE}cabinet.html#p=parent_key_masha_0000000000000001`);
  // «сейчас» — только родителям
  assert.deepEqual(byTag("now1__once").map((m) => m.token.slice(0, 7)), ["tok-mom"]);
  assert.equal(byTag("off__once").length, 0);
  assert.equal(byTag("r90__m2").length, 0, "до второго занятия ещё 5 дней");
  assert.equal(sent.length, 3);
  // мёртвая подписка удалена, остальное в канале цело
  const items = await db.collection("channels").doc(CH).collection("items").get();
  assert.deepEqual(items.docs.map((d) => d.id).sort(), ["hw", "pushMom", "pushOld"]);
  // журнал и отметка о запуске
  const log = await tRef.collection("notifLog").doc("r90__m1").get();
  assert.equal(log.data().delivered, 1);
  assert.equal(log.data().failed, 1);
  assert.equal(log.data().status, "done");
  assert.equal((await tRef.collection("state").doc("main").get()).data().notifier.lastRunAt, NOW);
  // следующий запуск через 15 минут — ничего нового
  const sent2 = [];
  await runOnce({ db, send: fakeSend(sent2), now: NOW + 15 * M, siteUrl: SITE, logger: quiet });
  assert.deepEqual(sent2, []);
});

test("два одновременных запуска не присылают одно и то же дважды", async () => {
  const sent = [];
  await Promise.all([
    runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet }),
    runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet }),
  ]);
  const tags = sent.filter((m) => m.token.startsWith("tok-mom")).map((m) => m.data.tag).sort();
  assert.deepEqual(tags, ["now1__once", "r90__m1"]);
});

test("без уведомлений — только отметка о запуске; без подписчиков — в журнале 0", async () => {
  const sent = [];
  await db.collection("channels").doc(CH).collection("items").doc("pushMom").delete();
  await db.collection("channels").doc(CH).collection("items").doc("pushKid").delete();
  await runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet });
  assert.equal(sent.length, 0);
  assert.equal((await tRef.collection("notifLog").doc("now1__once").get()).data().recipients, 0);
});

test("журнал: старше 60 дней чистится, но «разово»/«сейчас» (…__once) — никогда, иначе ушло бы повторно", async () => {
  await tRef.collection("notifications").doc("once1").set({ text: "Оплата до 5-го", mode: "once", times: 1, target: { scope: "all", role: "any" }, active: true, createdAt: 1 });
  const old = NOW - 90 * 24 * H;
  await tRef.collection("notifLog").doc("once1__once").set({ ruleId: "once1", sentAt: old, status: "done" });
  await tRef.collection("notifLog").doc("r90__oldlesson").set({ ruleId: "r90", sentAt: old, status: "done" });
  const sent = [];
  await runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet });
  assert.equal((await tRef.collection("notifLog").doc("once1__once").get()).exists, true, "запись «разово» осталась");
  assert.equal((await tRef.collection("notifLog").doc("r90__oldlesson").get()).exists, false, "старая запись напоминания удалена");
  // и через ещё 60+ дней «разово» не уходит повторно
  const again = [];
  await runOnce({ db, send: fakeSend(again), now: NOW + 70 * 24 * H, siteUrl: SITE, logger: quiet });
  assert.equal(again.filter((m) => m.data.tag === "once1__once").length, 0);
  assert.equal(sent.filter((m) => m.data.tag === "once1__once").length, 0, "уже было отправлено раньше");
});

test("пуши учителю: оплата/пояснение/ДЗ от родителя и ученика — один раз, со своим текстом; события учителя и до подписки — нет", async () => {
  const st = tRef.collection("state").doc("main");
  await st.set({ teacherDevices: { dev1: { token: "tok-teacher-" + "x".repeat(30), createdAt: NOW - 2 * H } }, teacherPush: { paid: true, note: true, homework: true } }, { merge: true });
  const L = tRef.collection("lessons");
  const lesson = { title: "Маша 7 класс", studentId: "Маша, 7 класс", startMs: Date.parse("2026-09-25T10:00:00+03:00"), endMs: Date.parse("2026-09-25T11:00:00+03:00"), status: "done" };
  await L.doc("p1").set(Object.assign({}, lesson, { paid: { value: true, by: "parent", at: NOW - H }, updatedAt: NOW - H }));
  await L.doc("p2").set(Object.assign({}, lesson, { paid: { value: true, by: "teacher", at: NOW - H }, updatedAt: NOW - H })); // сама учитель — не шлём
  await L.doc("p3").set(Object.assign({}, lesson, { paid: { value: true, by: "parent", at: NOW - 3 * H }, updatedAt: NOW - 3 * H })); // до подписки
  await L.doc("n1").set(Object.assign({}, lesson, { familyNote: { text: "Разберём пробник", by: "student", at: NOW - 30 * M }, updatedAt: NOW - 30 * M }));
  await L.doc("h1").set(Object.assign({}, lesson, { homework: [{ url: "https://res.cloudinary.com/x/1.jpg", by: "parent", uploadedAt: NOW - 20 * M }, { url: "https://res.cloudinary.com/x/2.jpg", by: "parent", uploadedAt: NOW - 19 * M }, { url: "https://res.cloudinary.com/x/t.pdf", by: "teacher", uploadedAt: NOW - 19 * M }], updatedAt: NOW - 19 * M }));
  // ещё не разобранное учителем сообщение в канале: «оплачено» в родительском канале
  await db.collection("channels").doc("channel_parent_for_tests_0123456").collection("items").doc("pd").set({ type: "paid", lessonId: "m1", by: "parent", createdAt: NOW - 10 * M, paid: true });
  const sent = [];
  await runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet });
  const mine = sent.filter((m) => m.token.startsWith("tok-teacher"));
  const bodies = mine.map((m) => `${m.data.title} | ${m.data.body}`).sort();
  assert.deepEqual(bodies, [
    "Домашнее задание | Маша Иванова, 7 класс: родитель прислал 2 файла ДЗ к занятию 25 сентября",
    "Оплата | Маша Иванова, 7 класс: родитель отметил «Оплачено» за занятие 25 сентября",
    "Оплата | Маша Иванова, 7 класс: родитель отметил «Оплачено» за занятие 26 сентября",
    "Пояснение к занятию | Маша Иванова, 7 класс: ученик написал пояснение к занятию 25 сентября",
  ]);
  assert.ok(mine.every((m) => m.data.url === `${SITE}index.html`));
  // второй запуск — ничего нового
  const again = [];
  await runOnce({ db, send: fakeSend(again), now: NOW + 15 * M, siteUrl: SITE, logger: quiet });
  assert.equal(again.filter((m) => m.token.startsWith("tok-teacher")).length, 0);
  // выключила «ДЗ» — новый файл не приходит, а новая оплата — приходит
  await st.set({ teacherPush: { paid: true, note: true, homework: false } }, { merge: true });
  await L.doc("h1").set({ homework: [{ url: "https://res.cloudinary.com/x/3.jpg", by: "student", uploadedAt: NOW + 20 * M }], updatedAt: NOW + 20 * M }, { merge: true });
  await L.doc("p4").set(Object.assign({}, lesson, { paid: { value: true, by: "parent", at: NOW + 21 * M }, updatedAt: NOW + 21 * M }));
  const third = [];
  await runOnce({ db, send: fakeSend(third), now: NOW + 30 * M, siteUrl: SITE, logger: quiet });
  assert.deepEqual(third.filter((m) => m.token.startsWith("tok-teacher")).map((m) => m.data.title), ["Оплата"]);
});

test("пуши учителю: нет подписанных устройств — ничего не читаем и не шлём; мёртвый токен удаляется", async () => {
  await tRef.collection("lessons").doc("p1").set({ title: "Маша 7 класс", studentId: "Маша, 7 класс", startMs: NOW, endMs: NOW + H, status: "done", paid: { value: true, by: "parent", at: NOW - M }, updatedAt: NOW - M });
  let sent = [];
  await runOnce({ db, send: fakeSend(sent), now: NOW, siteUrl: SITE, logger: quiet });
  assert.equal(sent.filter((m) => m.data.title === "Оплата").length, 0);
  await tRef.collection("state").doc("main").set({ teacherDevices: { dead: { token: "tok-teacher-DEAD" + "x".repeat(30), createdAt: NOW - H } } }, { merge: true });
  sent = [];
  await runOnce({ db, send: fakeSend(sent), now: NOW + M, siteUrl: SITE, logger: quiet });
  assert.equal(sent.filter((m) => m.data.title === "Оплата").length, 1);
  assert.equal(((await tRef.collection("state").doc("main").get()).data().teacherDevices || {}).dead, undefined, "мёртвая подписка удалена");
});

// Счётчик прочитанных документов (так Firestore и тарифицирует чтения):
// оборачиваем Query.get / DocumentReference.get / Firestore.getAll.
function countReads() {
  const orig = { q: Query.prototype.get, d: DocumentReference.prototype.get, a: Firestore.prototype.getAll };
  const c = { reads: 0 };
  Query.prototype.get = async function (...x) { const r = await orig.q.apply(this, x); c.reads += Math.max(1, r.size); return r; };
  DocumentReference.prototype.get = async function (...x) { const r = await orig.d.apply(this, x); c.reads += 1; return r; };
  Firestore.prototype.getAll = async function (...x) { const r = await orig.a.apply(this, x); c.reads += r.length; return r; };
  c.stop = () => { Query.prototype.get = orig.q; DocumentReference.prototype.get = orig.d; Firestore.prototype.getAll = orig.a; };
  return c;
}

test("экономия чтений: большая история журнала и старых «Отправить сейчас» не читается на каждом запуске", async () => {
  // 400 записей журнала и 200 старых «сейчас»/отчётов — как после пары месяцев работы
  let b = db.batch(); let n = 0;
  const flush = async () => { await b.commit(); b = db.batch(); n = 0; };
  for (let i = 0; i < 400; i++) { b.set(tRef.collection("notifLog").doc(`old${i}__l${i}`), { ruleId: "r90", sentAt: NOW - 10 * 24 * H, status: "done" }); if (++n === 400) await flush(); }
  await flush();
  for (let i = 0; i < 200; i++) { b.set(tRef.collection("notifications").doc(`now_old_${i}`), { text: "Отчёт " + i, mode: "now", times: 1, target: { scope: "all", role: "any" }, active: true, createdAt: NOW - 30 * 24 * H, source: "report" }); if (++n === 400) await flush(); }
  await flush();
  const first = [];
  await runOnce({ db, send: fakeSend(first), now: NOW, siteUrl: SITE, logger: quiet }); // первый запуск: отправки и суточная чистка
  const c = countReads();
  try {
    const sent = [];
    await runOnce({ db, send: fakeSend(sent), now: NOW + 5 * M, siteUrl: SITE, logger: quiet });
    assert.equal(sent.length, 0, "повторно ничего");
  } finally { c.stop(); }
  assert.ok(c.reads < 40, `чтений за запуск: ${c.reads} (раньше было бы 600+)`);
  // «разово/сейчас» после отправки помечено — дальше не проверяется по журналу
  assert.ok((await tRef.collection("notifications").doc("now1").get()).data().pushedAt, "now1 помечено pushedAt");
});
