// notify-core.js: кому и когда — чистая логика (без базы и браузера).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const core = createRequire(import.meta.url)("../../notify-core.js");

const H = 3600000, M = 60000;
const NOW = Date.parse("2026-09-26T10:00:00+03:00");
const keys = [
  { id: "kMashaMom", role: "parent", studentId: "Маша, 7 класс", active: true, label: "мама" },
  { id: "kMashaDad", role: "parent", studentId: "Маша, 7 класс", active: true, label: "папа" },
  { id: "kMasha", role: "student", studentId: "Маша, 7 класс", active: true },
  { id: "kPetya", role: "parent", studentId: "Петя, 5 класс", active: true },
  { id: "kOld", role: "parent", studentId: "Петя, 5 класс", active: false },
];
const lesson = (id, sid, startMs, status = "planned") => ({ id, studentId: sid, startMs, endMs: startMs + H, status, title: sid });
const lessons = [
  lesson("m1", "Маша, 7 класс", NOW + 90 * M),
  lesson("m2", "Маша, 7 класс", NOW + 3 * 24 * H),
  lesson("p1", "Петя, 5 класс", NOW + 60 * M),
  lesson("p2", "Петя, 5 класс", NOW + 90 * M, "cancelled"),
];
const devices = [
  { token: "tok-mom", key: "kMashaMom", path: "c/1" },
  { token: "tok-dad", key: "kMashaDad", path: "c/2" },
  { token: "tok-masha", key: "kMasha", path: "c/3" },
  { token: "tok-petya", key: "kPetya", path: "c/4" },
  { token: "tok-old", key: "kOld", path: "c/5" },
];

test("offset: любое число и единица — минуты, часы, дни", () => {
  assert.equal(core.offsetMs({ offsetValue: 90, offsetUnit: "min" }), 90 * M);
  assert.equal(core.offsetMs({ offsetValue: 3, offsetUnit: "hour" }), 3 * H);
  assert.equal(core.offsetMs({ offsetValue: 1, offsetUnit: "day" }), 24 * H);
  assert.equal(core.offsetMs({ offsetValue: 1.5, offsetUnit: "hour" }), 90 * M);
  assert.equal(core.offsetMs({ offsetValue: 0, offsetUnit: "hour" }), 0);
  assert.equal(core.offsetText({ offsetValue: 90, offsetUnit: "min" }), "90 минут");
  assert.equal(core.offsetText({ offsetValue: 1, offsetUnit: "day" }), "1 день");
  assert.equal(core.offsetText({ offsetValue: 3, offsetUnit: "hour" }), "3 часа");
});

test("адресаты: все / роль / ученик / конкретный человек; отозванный — никогда", () => {
  const who = (target) => keys.filter((k) => core.keyMatches(target, k)).map((k) => k.id);
  assert.deepEqual(who({ scope: "all", role: "any" }), ["kMashaMom", "kMashaDad", "kMasha", "kPetya"]);
  assert.deepEqual(who({ scope: "all", role: "student" }), ["kMasha"]);
  assert.deepEqual(who({ scope: "student", role: "parent", studentId: "Маша, 7 класс" }), ["kMashaMom", "kMashaDad"]);
  assert.deepEqual(who({ scope: "key", key: "kMashaDad" }), ["kMashaDad"]);
  assert.deepEqual(who({ scope: "key", key: "kOld" }), []);
});

test("«за 90 минут до занятия»: вовремя, своим адресатам, без повторов; отменённые и отозванные — нет", () => {
  const rule = { id: "r1", text: "В {время} занятие, {ученик}", mode: "before", offsetValue: 90, offsetUnit: "min", target: { scope: "all", role: "any" }, active: true };
  const label = (sid) => sid.replace(",", " Иванова,");
  const plan = (now, log = {}) => core.planPushes({ now, rules: [rule], lessons, keys, devices, log, label });
  // за 91 минуту до Маши — Маше рано; Петя (через 60 мин) уже в окне
  assert.deepEqual(plan(NOW - M).map((x) => x.lessonId), ["p1"]);
  const p = plan(NOW);
  assert.deepEqual(p.map((x) => x.lessonId), ["m1", "p1"]);
  assert.deepEqual(p[0].to.map((t) => t.token).sort(), ["tok-dad", "tok-masha", "tok-mom"], "только семья Маши");
  assert.deepEqual(p[1].to.map((t) => t.token), ["tok-petya"], "отозванный доступ Пети — без пуша");
  assert.equal(p[0].body, "В 11:30 занятие, Маша Иванова, 7 класс");
  assert.equal(p[0].logId, "r1__m1");
  assert.deepEqual(plan(NOW, { r1__m1: true }).map((x) => x.lessonId), ["p1"], "уже отправленное — не повторяем");
  assert.deepEqual(plan(NOW + 61 * M).map((x) => x.lessonId), ["m1"], "занятие Пети уже началось");
  assert.ok(!plan(NOW).some((x) => x.lessonId === "p2"), "отменённое — никогда");
  assert.deepEqual(core.planPushes({ now: NOW, rules: [{ ...rule, active: false }], lessons, keys, devices, log: {} }), []);
  assert.deepEqual(core.planPushes({ now: NOW, rules: [{ ...rule, push: false }], lessons, keys, devices, log: {} }), []);
});

test("«за 1 день»: опоздание больше 3 часов — не шлём; привязка к выбранным занятиям", () => {
  const rule = { id: "r2", text: "Завтра занятие", mode: "before", offsetValue: 1, offsetUnit: "day", target: { scope: "student", role: "any", studentId: "Маша, 7 класс" }, active: true };
  const at = (now, r = rule) => core.planPushes({ now, rules: [r], lessons, keys, devices, log: {} }).map((x) => x.lessonId);
  assert.deepEqual(at(NOW + 2 * 24 * H), ["m2"]);
  assert.deepEqual(at(NOW + 2 * 24 * H + 2 * H), ["m2"], "опоздали на 2 часа — ещё шлём");
  assert.deepEqual(at(NOW + 2 * 24 * H + 3 * H + M), [], "опоздали больше чем на 3 часа — поздно");
  const only = { ...rule, lessonIds: ["m1"] };
  assert.deepEqual(at(NOW + 2 * 24 * H, only), [], "m2 не выбрано");
  assert.deepEqual(core.ruleLessons(only, lessons, keys).map((l) => l.id), ["m1"]);
  assert.deepEqual(core.ruleLessons({ ...rule, target: { scope: "key", key: "kPetya" } }, lessons, keys).map((l) => l.id), ["p1"], "адресат — родитель Пети → занятия Пети");
});

test("«разово» и «отправить сейчас»: один пуш адресату; повтор — нет; старое «сейчас» — нет", () => {
  const once = { id: "o1", text: "Оплата за октябрь до 5-го", mode: "once", times: 3, target: { scope: "key", key: "kMashaDad" }, active: true, createdAt: NOW - H };
  const now = { id: "n1", text: "Сегодня в 19:00", mode: "now", times: 1, target: { scope: "student", role: "any", studentId: "Петя, 5 класс" }, active: true, createdAt: NOW - H };
  const p = core.planPushes({ now: NOW, rules: [once, now], lessons, keys, devices, log: {} });
  assert.deepEqual(p.map((x) => [x.logId, x.to.map((t) => t.token)]), [["o1__once", ["tok-dad"]], ["n1__once", ["tok-petya"]]]);
  assert.equal(p[0].title, "Сообщение от преподавателя");
  assert.deepEqual(core.planPushes({ now: NOW, rules: [once], lessons, keys, devices, log: { o1__once: true } }), []);
  const stale = { ...now, createdAt: NOW - 4 * 24 * H };
  assert.deepEqual(core.planPushes({ now: NOW, rules: [stale], lessons, keys, devices, log: {} }), [], "«сейчас» старше 3 дней уже не актуально");
});

test("кабинет: что опубликовать адресату и когда показать напоминание", () => {
  const rules = [
    { id: "a", text: "Всем", mode: "once", times: 2, target: { scope: "all", role: "any" }, active: true, createdAt: 1 },
    { id: "b", text: "Только папе", mode: "now", target: { scope: "key", key: "kMashaDad" }, active: true, createdAt: NOW },
    { id: "c", text: "За {время}", mode: "before", offsetValue: 2, offsetUnit: "hour", target: { scope: "student", role: "parent", studentId: "Маша, 7 класс" }, lessonIds: ["m1"], active: true, createdAt: 2 },
    { id: "d", text: "Выключено", mode: "once", target: { scope: "all", role: "any" }, active: false, createdAt: 3 },
  ];
  const ids = (k) => core.noticesForKey(rules, keys.find((x) => x.id === k), keys, NOW).map((n) => n.id).sort();
  assert.deepEqual(ids("kMashaMom"), ["a", "c"]);
  assert.deepEqual(ids("kMashaDad"), ["a", "b", "c"]);
  assert.deepEqual(ids("kMasha"), ["a"], "ученику родительское не уходит");
  assert.deepEqual(ids("kPetya"), ["a"]);
  const mom = core.noticesForKey(rules, keys[0], keys, NOW);
  assert.equal(mom.find((n) => n.id === "a").times, 2);
  assert.equal(mom.find((n) => n.id === "c").offsetMs, 2 * H);
  const due = (now) => core.dueReminders(mom, lessons.filter((l) => l.studentId === "Маша, 7 класс"), now, "Маша").map((r) => r.id);
  assert.deepEqual(due(NOW - 31 * M), [], "за 2 ч 1 мин — рано");
  assert.deepEqual(due(NOW - 30 * M), ["c__m1"], "ровно за 2 часа");
  assert.deepEqual(due(NOW + 2 * H), ["c__m1"], "идёт занятие — ещё висит");
  assert.deepEqual(due(NOW + 2 * H + 31 * M), [], "занятие кончилось");
  assert.equal(core.dueReminders(mom, lessons, NOW, "Маша")[0].text, "За 11:30");
});

test("свой заголовок: в пуше и в кабинете; пусто — стандартный, как раньше", () => {
  const own = { id: "t1", title: "  Важно:   {ученик} ", text: "Завтра в {время}", mode: "before", offsetValue: 2, offsetUnit: "hour", target: { scope: "student", role: "any", studentId: "Маша, 7 класс" }, lessonIds: ["m1"], active: true, createdAt: 1 };
  const plain = { id: "t2", title: "", text: "Оплата", mode: "once", times: 1, target: { scope: "key", key: "kMashaDad" }, active: true, createdAt: NOW - H };
  const msg = { id: "t3", title: "Отчёт о прошедшем занятии", text: "Всё хорошо", mode: "now", target: { scope: "key", key: "kMashaDad" }, active: true, createdAt: NOW - H };
  const p = core.planPushes({ now: NOW - 30 * M, rules: [own, plain, msg], lessons, keys, devices, log: {}, label: (s) => s.replace(",", "") });
  const byRule = Object.fromEntries(p.map((x) => [x.ruleId, x.title]));
  assert.equal(byRule.t1, "Важно: Маша 7 класс", "подстановка и лишние пробелы");
  assert.equal(byRule.t2, "Сообщение от преподавателя");
  assert.equal(byRule.t3, "Отчёт о прошедшем занятии");
  const dad = core.noticesForKey([own, plain, msg], keys.find((k) => k.id === "kMashaDad"), keys, NOW - 30 * M);
  assert.equal(dad.find((n) => n.id === "t1").title, "Важно: {ученик}");
  assert.equal("title" in dad.find((n) => n.id === "t2"), false, "пустой заголовок в витрину не пишем");
  assert.equal(core.titleFor(dad.find((n) => n.id === "t2")), "Сообщение от преподавателя");
  assert.equal(core.titleFor({ mode: "before" }), "Напоминание о занятии");
  assert.equal(core.titleFor({ mode: "now", title: "x".repeat(300) }).length, 100);
  const due = core.dueReminders(dad, lessons.filter((l) => l.studentId === "Маша, 7 класс"), NOW - 30 * M, "Маша");
  assert.equal(due[0].title, "Важно: Маша");
});

test("отпечаток ключа для подписки на пуш: 64 hex, не содержит ключ, сопоставляется; старая подписка — сам ключ", async () => {
  const k = "parent_key_masha_0000000000000001";
  const h = await core.pushKeyId(k);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(k));
  assert.equal(await core.pushKeyId(k), h, "стабилен");
  assert.notEqual(await core.pushKeyId("student_key_masha_000000000000002"), h);
  assert.equal(core.isPushKeyId(h), true);
  assert.equal(core.isPushKeyId(k), false);
  const map = await core.pushKeyMap([{ id: k }]);
  assert.equal(core.pushItemKey({ key: h }, map), k);
  assert.equal(core.pushItemKey({ key: k }, map), k, "старая подписка");
  assert.equal(core.pushItemKey({ key: "f".repeat(64) }, map), null, "чужой/отозванный отпечаток");
});
