// Фоновая рассылка (notifier/send.mjs) против локального эмулятора Firestore:
// читает настоящую структуру базы, шлёт «пуши» подделке, ведёт журнал.
// Запуск: cd tests && npm run test:notifier
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runOnce } from "../../notifier/send.mjs";

const req = createRequire(new URL("../../notifier/package.json", import.meta.url));
const { initializeApp } = req("firebase-admin/app");
const { getFirestore } = req("firebase-admin/firestore");
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
  await items.doc("pushMom").set({ type: "push", lessonId: "-", by: "parent", createdAt: 1, token: "tok-mom-" + "x".repeat(30), key: "parent_key_masha_0000000000000001" });
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
