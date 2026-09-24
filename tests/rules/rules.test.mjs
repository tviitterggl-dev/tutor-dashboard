// Проверка firestore.rules в локальном эмуляторе (без интернета).
// Запуск: cd tests && npm run test:rules
import { test } from "node:test";
import assert from "node:assert/strict";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const BASE = `http://${HOST}/v1/projects/demo-tutor/databases/(default)/documents`;
const T = "teacher_key_for_tests_0123456789";
const OLD_T = "2Vv0fLQi3MXbEgqpwlmWk5E1KnVRz9-q";
const PKEY = "parent_key_for_tests_0123456789";

function enc(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
async function call(method, path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify({ fields: enc(body).mapValue.fields }) : undefined,
  });
  return res.status;
}
const put = (path, data) => call("PATCH", path, data);
const get = (path) => call("GET", path);
const del = (path) => call("DELETE", path);

const lesson = { title: "Тест 7 класс", startMs: 1790000000000, endMs: 1790003600000, status: "planned" };
const view = { v: 1, role: "parent", studentId: "Тест, 7 класс", lessons: [], busy: [] };

test("учитель: state и lessons по своему ключу", async () => {
  assert.equal(await put(`teacherSpaces/${T}/state/main`, { marks: {} }), 200);
  assert.equal(await get(`teacherSpaces/${T}/state/main`), 200);
  assert.equal(await put(`teacherSpaces/${T}/lessons/l1`, lesson), 200);
  assert.equal(await get(`teacherSpaces/${T}/lessons/l1`), 200);
  assert.equal(await get(`teacherSpaces/${T}/lessons`), 200, "листинг занятий при известном ключе");
  assert.equal(await del(`teacherSpaces/${T}/lessons/l1`), 200);
  assert.equal(await put(`teacherSpaces/${T}/accessKeys/${PKEY}`, { role: "parent" }), 200);
  assert.equal(await get(`teacherSpaces/${T}/accessKeys`), 200);
});

test("занятие с неверными полями не записывается", async () => {
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad1`, { ...lesson, status: "whatever" }), 403);
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad2`, { ...lesson, endMs: lesson.startMs }), 403);
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad3`, { title: "x" }), 403);
});

test("старый засвеченный ключ учителя закрыт", async () => {
  assert.equal(await get(`teacherSpaces/${OLD_T}/state/main`), 403);
  assert.equal(await put(`teacherSpaces/${OLD_T}/state/main`, { marks: {} }), 403);
});

test("короткий ключ учителя не принимается", async () => {
  assert.equal(await put(`teacherSpaces/short/state/main`, { marks: {} }), 403);
});

test("перебор запрещён: листинг верхних коллекций", async () => {
  assert.equal(await get(`teacherSpaces`), 403);
  assert.equal(await get(`parentAccess`), 403);
  assert.equal(await get(`studentAccess`), 403);
  assert.equal(await get(`teacherSpaces/${T}/state`), 403, "state перечислять нельзя");
});

test("витрина родителя: точечное чтение, валидация, удаление", async () => {
  assert.equal(await put(`parentAccess/${PKEY}`, view), 200);
  assert.equal(await get(`parentAccess/${PKEY}`), 200);
  assert.equal(await put(`parentAccess/${PKEY}`, { ...view, v: 2 }), 403);
  assert.equal(await put(`parentAccess/${PKEY}`, { ...view, role: "admin" }), 403);
  assert.equal(await put(`studentAccess/${PKEY}`, { ...view, role: "student" }), 200);
  assert.equal(await del(`parentAccess/${PKEY}`), 200);
  assert.equal(await get(`parentAccess/${PKEY}`), 404);
  assert.equal(await put(`parentAccess/shortkey`, view), 403);
});

test("прочие коллекции закрыты", async () => {
  assert.equal(await put(`random/doc`, { a: 1 }), 403);
  assert.equal(await get(`random/doc`), 403);
});
