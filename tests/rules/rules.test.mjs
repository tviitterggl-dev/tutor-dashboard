// Проверка firestore.rules в локальном эмуляторе (без интернета).
// Запуск: cd tests && npm run test:rules
import { test } from "node:test";
import assert from "node:assert/strict";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const BASE = `http://${HOST}/v1/projects/demo-tutor/databases/(default)/documents`;
const T = "teacherUid0123456789abcdef";   // uid учителя (как выдаёт Firebase Auth)
const OTHER = "strangerUid0123456789abcd";   // другой зарегистрированный пользователь
const OLD_T = "legacyKeyForTests_0123456789ab"; // формат старого секретного ключа (вымышленный)
const PKEY = "parent_key_for_tests_0123456789";

function enc(v) {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
// Эмулятор принимает неподписанный JWT («alg: none») как вход пользователя.
function tokenFor(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: "none", typ: "JWT" }) + "." + b64({
    iss: "https://securetoken.google.com/demo-tutor", aud: "demo-tutor", auth_time: now, iat: now, exp: now + 3600,
    sub: uid, user_id: uid, email: uid + "@example.org", firebase: { sign_in_provider: "password", identities: {} },
  }) + ".";
}
let actingAs = null; // uid вошедшего пользователя или null (без входа)
async function as(uid, fn) { const prev = actingAs; actingAs = uid; try { return await fn(); } finally { actingAs = prev; } }

async function call(method, path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, actingAs ? { Authorization: "Bearer " + tokenFor(actingAs) } : {}),
    body: body ? JSON.stringify({ fields: enc(body).mapValue.fields }) : undefined,
  });
  return res.status;
}
const put = (path, data) => call("PATCH", path, data);
const get = (path) => call("GET", path);
const del = (path) => call("DELETE", path);

const lesson = { title: "Тест 7 класс", startMs: 1790000000000, endMs: 1790003600000, status: "planned" };
const view = { v: 1, role: "parent", studentId: "Тест, 7 класс", lessons: [], busy: [] };

test("учитель после входа: state, lessons, ключи доступа", async () => as(T, async () => {
  assert.equal(await put(`teacherSpaces/${T}/state/main`, { marks: {} }), 200);
  assert.equal(await get(`teacherSpaces/${T}/state/main`), 200);
  assert.equal(await put(`teacherSpaces/${T}/lessons/l1`, lesson), 200);
  assert.equal(await get(`teacherSpaces/${T}/lessons/l1`), 200);
  assert.equal(await get(`teacherSpaces/${T}/lessons`), 200, "листинг занятий при известном ключе");
  assert.equal(await del(`teacherSpaces/${T}/lessons/l1`), 200);
  assert.equal(await put(`teacherSpaces/${T}/lessons/p1`, { ...lesson, title: "Личное время", kind: "personal", note: "врач", studentId: null }), 200, "личное время");
  assert.equal(await put(`teacherSpaces/${T}/accessKeys/${PKEY}`, { role: "parent" }), 200);
  assert.equal(await get(`teacherSpaces/${T}/accessKeys`), 200);
}));

test("без входа и под чужим аккаунтом к данным учителя не попасть", async () => {
  await as(T, () => put(`teacherSpaces/${T}/state/main`, { marks: {} }));
  for (const who of [null, OTHER]) {
    await as(who, async () => {
      assert.equal(await get(`teacherSpaces/${T}/state/main`), 403, String(who));
      assert.equal(await put(`teacherSpaces/${T}/state/main`, { marks: {} }), 403);
      assert.equal(await get(`teacherSpaces/${T}/lessons`), 403);
      assert.equal(await get(`teacherSpaces/${T}/accessKeys`), 403);
      assert.equal(await get(`teacherSpaces/${T}/requests`), 403);
    });
  }
  // чужой пользователь может завести только СВОЮ пустую папку
  await as(OTHER, async () => assert.equal(await put(`teacherSpaces/${OTHER}/state/main`, { marks: {} }), 200));
});

test("занятие с неверными полями не записывается", async () => as(T, async () => {
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad1`, { ...lesson, status: "whatever" }), 403);
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad2`, { ...lesson, endMs: lesson.startMs }), 403);
  assert.equal(await put(`teacherSpaces/${T}/lessons/bad3`, { title: "x" }), 403);
}));

test("старые пути с секретным ключом закрыты для всех", async () => {
  for (const who of [null, OTHER, T]) {
    await as(who, async () => {
      assert.equal(await get(`teacherSpaces/${OLD_T}/state/main`), 403);
      assert.equal(await put(`teacherSpaces/${OLD_T}/state/main`, { marks: {} }), 403);
      assert.equal(await get(`teacherSpaces/${OLD_T}/lessons`), 403);
    });
  }
});

test("перебор запрещён: листинг верхних коллекций", async () => {
  assert.equal(await get(`teacherSpaces`), 403);
  assert.equal(await get(`parentAccess`), 403);
  assert.equal(await get(`studentAccess`), 403);
  assert.equal(await as(T, () => get(`teacherSpaces/${T}/state`)), 403, "state перечислять нельзя");
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

const CK = "channel_key_for_tests_012345678";
const item = { type: "reschedule", lessonId: "l1", by: "parent", createdAt: 1790000000000, newStartMs: 1790100000000, newEndMs: 1790103600000, comment: "можно позже?" };

test("канал: создание, чтение, удаление; изменение запрещено", async () => {
  assert.equal(await put(`channels/${CK}/items/i1`, item), 200);
  assert.equal(await get(`channels/${CK}/items/i1`), 200);
  assert.equal(await get(`channels/${CK}/items`), 200, "листинг своего канала");
  assert.equal(await put(`channels/${CK}/items/i1`, { ...item, comment: "подмена" }), 403, "update запрещён");
  assert.equal(await del(`channels/${CK}/items/i1`), 200);
  assert.equal(await get(`channels`), 403, "перечислить каналы нельзя");
  assert.equal(await put(`channels/short/items/i2`, item), 403);
});

test("канал: валидация сообщений", async () => {
  const hw = { type: "homework", lessonId: "l1", by: "student", createdAt: 1, file: { url: "https://res.cloudinary.com/xf4hvf5p/raw/upload/a.pdf", name: "a.pdf" } };
  assert.equal(await put(`channels/${CK}/items/h1`, hw), 200);
  assert.equal(await put(`channels/${CK}/items/h2`, { ...hw, file: { url: "javascript:alert(1)", name: "x" } }), 403, "только ссылки Cloudinary");
  assert.equal(await put(`channels/${CK}/items/h3`, { ...hw, file: { url: "https://evil.example/a.pdf", name: "x" } }), 403);
  assert.equal(await put(`channels/${CK}/items/h4`, { ...hw, extra: "поле" }), 403, "лишние поля");
  assert.equal(await put(`channels/${CK}/items/p1`, { type: "paid", lessonId: "l1", by: "parent", createdAt: 1, paid: true }), 200);
  assert.equal(await put(`channels/${CK}/items/p2`, { type: "paid", lessonId: "l1", by: "parent", createdAt: 1, paid: "да" }), 403);
  assert.equal(await put(`channels/${CK}/items/r1`, { ...item, newEndMs: item.newStartMs }), 403);
  assert.equal(await put(`channels/${CK}/items/r2`, { ...item, by: "admin" }), 403);
  assert.equal(await put(`channels/${CK}/items/r3`, { ...item, comment: "x".repeat(501) }), 403);
  assert.equal(await put(`channels/${CK}/items/c1`, { type: "cancel", lessonId: "l1", by: "student", createdAt: 1 }), 200);
  // «Пояснение» к занятию: до 1000 символов, пустое — убрать; без текста — нельзя
  assert.equal(await put(`channels/${CK}/items/n1`, { type: "note", lessonId: "l1", by: "parent", createdAt: 1, comment: "x".repeat(1000) }), 200);
  assert.equal(await put(`channels/${CK}/items/n2`, { type: "note", lessonId: "l1", by: "student", createdAt: 1, comment: "" }), 200);
  assert.equal(await put(`channels/${CK}/items/n3`, { type: "note", lessonId: "l1", by: "parent", createdAt: 1, comment: "x".repeat(1001) }), 403);
  assert.equal(await put(`channels/${CK}/items/n4`, { type: "note", lessonId: "l1", by: "parent", createdAt: 1 }), 403);
  assert.equal(await put(`channels/${CK}/items/n5`, { type: "cancel", lessonId: "l1", by: "parent", createdAt: 1, comment: "x".repeat(501) }), 403, "у заявок по-прежнему 500");
});

test("журнал решений по заявкам — только учителю", async () => {
  await as(T, async () => {
    assert.equal(await put(`teacherSpaces/${T}/requests/r1`, { status: "approved" }), 200);
    assert.equal(await get(`teacherSpaces/${T}/requests`), 200);
  });
  assert.equal(await get(`teacherSpaces/${T}/requests`), 403);
});

test("уведомления: только учитель; журнал рассылки учителю — только читать", async () => {
  const n = { text: "Напоминаю о занятии", mode: "before", offsetValue: 90, offsetUnit: "min", target: { scope: "all", role: "any" }, active: true, createdAt: 1 };
  await as(T, async () => {
    assert.equal(await put(`teacherSpaces/${T}/notifications/n1`, n), 200);
    assert.equal(await get(`teacherSpaces/${T}/notifications`), 200);
    assert.equal(await put(`teacherSpaces/${T}/notifications/n2`, { ...n, mode: "spam" }), 403);
    assert.equal(await put(`teacherSpaces/${T}/notifications/n3`, { ...n, text: "" }), 403);
    assert.equal(await put(`teacherSpaces/${T}/notifications/n4`, { ...n, text: "x".repeat(1001) }), 403);
    assert.equal(await get(`teacherSpaces/${T}/notifLog`), 200);
    assert.equal(await put(`teacherSpaces/${T}/notifLog/l1`, { sentAt: 1 }), 403, "журнал пишет только фоновая рассылка");
    assert.equal(await del(`teacherSpaces/${T}/notifications/n1`), 200);
  });
  for (const who of [null, OTHER]) {
    await as(who, async () => {
      assert.equal(await get(`teacherSpaces/${T}/notifications`), 403);
      assert.equal(await put(`teacherSpaces/${T}/notifications/x`, n), 403);
      assert.equal(await get(`teacherSpaces/${T}/notifLog`), 403);
    });
  }
});

test("канал: подписка на пуш — токен и ключ, только у type push", async () => {
  const p = { type: "push", lessonId: "-", by: "parent", createdAt: 1, token: "t".repeat(152), key: "parent_key_for_tests_0123456789" };
  const { token, ...noToken } = p;
  assert.equal(await put(`channels/${CK}/items/push_p1`, p), 200);
  assert.equal(await put(`channels/${CK}/items/push_p2`, { ...p, token: "short" }), 403);
  assert.equal(await put(`channels/${CK}/items/push_p3`, { ...p, key: "short" }), 403);
  assert.equal(await put(`channels/${CK}/items/push_p4`, noToken), 403);
  assert.equal(await put(`channels/${CK}/items/push_p5`, { type: "cancel", lessonId: "l1", by: "parent", createdAt: 1, token }), 403, "токен — только в push");
});

test("прочие коллекции закрыты", async () => {
  assert.equal(await put(`random/doc`, { a: 1 }), 403);
  assert.equal(await get(`random/doc`), 403);
});
