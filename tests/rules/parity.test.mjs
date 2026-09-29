// Паритет: поддельная база e2e-тестов (tests/stubs/rules-check.js) решает
// «можно / нельзя» так же, как настоящие firestore.rules в эмуляторе. Одна
// таблица случаев прогоняется через оба. Разошлись — значит, правила
// поменяли, а копию для тестов нет (или наоборот): e2e-тесты стали бы
// «пропускать» запись, которую настоящая база отклонит.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWrite } from "../stubs/rules-check.js";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const BASE = `http://${HOST}/v1/projects/demo-tutor/databases/(default)/documents`;
const T = "teacherUid0123456789abcdef";
const CH = "channel_key_for_parity_0000000001";
const KEY = "access_key_for_parity_00000000001";

function enc(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
function tokenFor(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: "none", typ: "JWT" }) + "." + b64({
    iss: "https://securetoken.google.com/demo-tutor", aud: "demo-tutor", auth_time: now, iat: now, exp: now + 3600,
    sub: uid, user_id: uid, email: uid + "@example.org", firebase: { sign_in_provider: "password", identities: {} },
  }) + ".";
}
async function call(method, path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokenFor(T) },
    body: body ? JSON.stringify({ fields: enc(body).mapValue.fields }) : undefined,
  });
  return res.status;
}
// сброс эмулятора в обход правил (как в rules.test.mjs нет — делаем сами)
async function wipe() {
  await fetch(`http://${HOST}/emulator/v1/projects/demo-tutor/databases/(default)/documents`, { method: "DELETE" });
}

let n = 0;
const uid = () => `p${++n}`;
const lesson = { title: "Тест 7 класс", startMs: 1790000000000, endMs: 1790003600000, status: "planned" };
const view = { v: 1, role: "parent", studentId: "Тест, 7 класс", lessons: [], busy: [] };
const item = { type: "cancel", lessonId: "l1", by: "parent", createdAt: 1 };
const hw = { type: "homework", lessonId: "l1", by: "student", createdAt: 1, file: { url: "https://res.cloudinary.com/x/a.pdf", name: "a.pdf" } };
const long = (k) => "x".repeat(k);

// [название, коллекция-путь без id, документ, предыдущий документ (для «изменить») ]
const CASES = [
  ["занятие", `teacherSpaces/${T}/lessons`, lesson],
  ["занятие: конец раньше начала", `teacherSpaces/${T}/lessons`, { ...lesson, endMs: lesson.startMs }],
  ["занятие: чужой статус", `teacherSpaces/${T}/lessons`, { ...lesson, status: "personal" }],
  ["занятие: длинное название", `teacherSpaces/${T}/lessons`, { ...lesson, title: long(201) }],
  ["занятие: startMs не целое", `teacherSpaces/${T}/lessons`, { ...lesson, startMs: 1.5 }],
  ["занятие: изменить с неверным полем", `teacherSpaces/${T}/lessons`, { ...lesson, status: "bad" }, lesson],
  ["уведомление", `teacherSpaces/${T}/notifications`, { text: "Привет", mode: "once", target: { scope: "all" } }],
  ["уведомление: пустой текст", `teacherSpaces/${T}/notifications`, { text: "", mode: "once", target: {} }],
  ["уведомление: чужой режим", `teacherSpaces/${T}/notifications`, { text: "a", mode: "daily", target: {} }],
  ["журнал рассылки — учителю не писать", `teacherSpaces/${T}/notifLog`, { ruleId: "r" }],
  ["state", `teacherSpaces/${T}/state`, { marks: {} }],
  ["решение по заявке", `teacherSpaces/${T}/requests`, { status: "approved" }],
  ["неизвестная коллекция учителя", `teacherSpaces/${T}/secrets`, { a: 1 }],
  ["канал: отмена", `channels/${CH}/items`, item],
  ["канал: изменить сообщение", `channels/${CH}/items`, { ...item, comment: "x" }, item],
  ["канал: лишнее поле", `channels/${CH}/items`, { ...item, extra: 1 }],
  ["канал: by чужой", `channels/${CH}/items`, { ...item, by: "admin" }],
  ["канал: ДЗ", `channels/${CH}/items`, hw],
  ["канал: ДЗ не с Cloudinary", `channels/${CH}/items`, { ...hw, file: { url: "https://evil.example/a.pdf", name: "a" } }],
  ["канал: ДЗ с лишним полем файла", `channels/${CH}/items`, { ...hw, file: { ...hw.file, size: 1 } }],
  ["канал: ДЗ длинное имя", `channels/${CH}/items`, { ...hw, file: { ...hw.file, name: long(201) } }],
  ["канал: комментарий 501", `channels/${CH}/items`, { ...item, comment: long(501) }],
  ["канал: пояснение 1000", `channels/${CH}/items`, { type: "note", lessonId: "l1", by: "parent", createdAt: 1, comment: long(1000) }],
  ["канал: пояснение без текста", `channels/${CH}/items`, { type: "note", lessonId: "l1", by: "parent", createdAt: 1 }],
  ["канал: перенос", `channels/${CH}/items`, { ...item, type: "reschedule", newStartMs: 10, newEndMs: 20 }],
  ["канал: перенос без времени", `channels/${CH}/items`, { ...item, type: "reschedule" }],
  ["канал: book 8 ч", `channels/${CH}/items`, { ...item, type: "book", newStartMs: 0, newEndMs: 8 * 3600000 }],
  ["канал: book 9 ч", `channels/${CH}/items`, { ...item, type: "book", newStartMs: 0, newEndMs: 9 * 3600000 }],
  ["канал: book от учителя", `channels/${CH}/items`, { ...item, type: "book", by: "teacher", newStartMs: 0, newEndMs: 3600000 }],
  ["канал: оплачено", `channels/${CH}/items`, { ...item, type: "paid", paid: true }],
  ["канал: оплачено не bool", `channels/${CH}/items`, { ...item, type: "paid", paid: "yes" }],
  ["канал: пуш", `channels/${CH}/items`, { ...item, type: "push", token: long(30), key: long(24) }],
  ["канал: пуш короткий ключ", `channels/${CH}/items`, { ...item, type: "push", token: long(30), key: long(10) }],
  ["канал: токен вне пуша", `channels/${CH}/items`, { ...item, token: long(30) }],
  ["канал: короткий ключ канала", `channels/short/items`, item],
  ["витрина", `parentAccess`, view],
  ["витрина: v2", `parentAccess`, { ...view, v: 2 }],
  ["витрина: роль", `studentAccess`, { ...view, role: "teacher" }],
  ["витрина: 501 занятие", `parentAccess`, { ...view, lessons: Array(501).fill(0) }],
  ["витрина: 1501 занято", `parentAccess`, { ...view, busy: Array(1501).fill(0) }],
  ["витрина: материалы", `parentAccess`, { ...view, materials: [{ url: "https://a.example/x", title: "Учебник" }, { url: "http://b.example/y" }] }],
  ["витрина: 10 материалов", `parentAccess`, { ...view, materials: Array.from({ length: 10 }, (_, i) => ({ url: `https://a.example/${i}` })) }],
  ["витрина: 11 материалов", `parentAccess`, { ...view, materials: Array.from({ length: 11 }, (_, i) => ({ url: `https://a.example/${i}` })) }],
  ["витрина: материал не http", `parentAccess`, { ...view, materials: [{ url: "https://a.example/" }, { url: "javascript:x" }] }],
  ["витрина: 10-й материал плохой", `parentAccess`, { ...view, materials: [...Array.from({ length: 9 }, (_, i) => ({ url: `https://a.example/${i}` })), { url: "ftp://x" }] }],
  ["витрина: материал длинное название", `parentAccess`, { ...view, materials: [{ url: "https://a.example/", title: long(81) }] }],
  ["витрина: материал длинная ссылка", `parentAccess`, { ...view, materials: [{ url: "https://" + long(500) }] }],
  ["витрина: материал лишнее поле", `parentAccess`, { ...view, materials: [{ url: "https://a.example/", note: "x" }] }],
  ["витрина: материал строкой", `parentAccess`, { ...view, materials: ["https://a.example/"] }],
  ["витрина: материалы не список", `parentAccess`, { ...view, materials: "https://a.example/" }],
  ["витрина: перевод строки в ссылке", `parentAccess`, { ...view, materials: [{ url: "https://a.example/\nx" }] }],
  ["витрина: контакты", `parentAccess`, { ...view, contacts: [{ url: "https://t.me/example", title: "Telegram" }, { url: "http://a.example/chat" }] }],
  ["витрина: 6 контактов", `parentAccess`, { ...view, contacts: Array.from({ length: 6 }, (_, i) => ({ url: `https://a.example/${i}` })) }],
  ["витрина: 7 контактов", `parentAccess`, { ...view, contacts: Array.from({ length: 7 }, (_, i) => ({ url: `https://a.example/${i}` })) }],
  ["витрина: 6-й контакт плохой", `parentAccess`, { ...view, contacts: [...Array.from({ length: 5 }, (_, i) => ({ url: `https://a.example/${i}` })), { url: "javascript:x" }] }],
  ["витрина: контакт длинное название", `parentAccess`, { ...view, contacts: [{ url: "https://a.example/", title: long(81) }] }],
  ["витрина: контакт длинная ссылка", `parentAccess`, { ...view, contacts: [{ url: "https://" + long(500) }] }],
  ["витрина: контакт лишнее поле", `parentAccess`, { ...view, contacts: [{ url: "https://a.example/", phone: "1" }] }],
  ["витрина: контакты не список", `parentAccess`, { ...view, contacts: "https://t.me/x" }],
  ["настройки кабинета", `accessPrefs`, { tabOrder: ["lessons"], updatedAt: 1 }],
  ["настройки: лишнее поле", `accessPrefs`, { tabOrder: [], theme: "dark" }],
  ["настройки: 13 вкладок", `accessPrefs`, { tabOrder: Array(13).fill("a") }],
  ["настройки: время не целое", `accessPrefs`, { tabOrder: [], updatedAt: "вчера" }],
  ["настройки: неизвестная вкладка", `accessPrefs`, { tabOrder: ["lessons", "evil"] }],
  ["настройки: не строка", `accessPrefs`, { tabOrder: [1] }],
  ["настройки: все пять вкладок", `accessPrefs`, { tabOrder: ["settings", "hw", "requests", "calendar", "lessons"] }],
  ["закрытая коллекция", `secrets`, { a: 1 }],
];

test("поддельная база e2e решает так же, как firestore.rules (таблица случаев)", async () => {
  await wipe();
  const diff = [];
  for (const [name, col, doc, prev] of CASES) {
    const top = col.split("/")[0];
    const id = top === "parentAccess" || top === "studentAccess" || top === "accessPrefs" ? KEY + uid() : uid();
    const path = `${col}/${id}`;
    if (prev) assert.equal(await call("PATCH", path, prev), 200, `${name}: подготовка`);
    const real = (await call("PATCH", path, doc)) === 200;
    const why = checkWrite(path, doc, prev);
    if (real !== (why === null)) diff.push(`${name}: правила — ${real ? "можно" : "нельзя"}, заглушка — ${why === null ? "можно" : "нельзя (" + why + ")"}`);
  }
  assert.deepEqual(diff, []);
  assert.ok(CASES.length > 40);
});
