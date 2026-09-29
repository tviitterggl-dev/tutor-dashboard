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

test("витрина: материалы — список до 10 ссылок https/http с необязательным названием", async () => {
  const m = (i, extra) => Object.assign({ url: `https://disk.example.org/folder${i}`, title: "Папка " + i }, extra);
  const ok = (list) => put(`parentAccess/${PKEY}`, { ...view, materials: list });
  assert.equal(await ok([]), 200, "пустой список");
  assert.equal(await ok([{ url: "http://example.org/a" }]), 200, "без названия, http");
  assert.equal(await ok(Array.from({ length: 10 }, (_, i) => m(i))), 200, "десять");
  assert.equal(await ok(Array.from({ length: 11 }, (_, i) => m(i))), 403, "одиннадцать — много");
  assert.equal(await ok([m(0), { url: "javascript:alert(1)" }]), 403, "не http(s) — даже вторым");
  assert.equal(await ok([m(0), m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9, { url: "ftp://x" })]), 403, "проверяется и десятый");
  assert.equal(await ok([m(0, { title: "x".repeat(81) })]), 403, "длинное название");
  assert.equal(await ok([m(0, { url: "https://" + "x".repeat(500) })]), 403, "длинная ссылка");
  assert.equal(await ok([m(0, { extra: 1 })]), 403, "лишнее поле");
  assert.equal(await ok([m(0, { title: 5 })]), 403, "название — не строка");
  assert.equal(await ok(["https://example.org"]), 403, "элемент — не объект");
  assert.equal(await ok("https://example.org"), 403, "не список");
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

// Заявка семьи на ДОПОЛНИТЕЛЬНОЕ занятие: занятия ещё нет, lessonId — новый
// id, придуманный кабинетом; время — как у переноса; подаёт только семья.
test("канал: заявка на новое занятие (book)", async () => {
  const book = { type: "book", lessonId: "l_new_0123456789ab", by: "parent", createdAt: 1790000000000, newStartMs: 1790200000000, newEndMs: 1790203600000, comment: "Можно ещё одно на этой неделе?" };
  assert.equal(await put(`channels/${CK}/items/b1`, book), 200);
  const { comment, ...noComment } = book;
  assert.equal(await put(`channels/${CK}/items/b2`, { ...noComment, by: "student" }), 200, "без комментария, от ученика");
  const { newStartMs, ...noStart } = book;
  assert.equal(await put(`channels/${CK}/items/b3`, noStart), 403, "без newStartMs");
  const { newEndMs, ...noEnd } = book;
  assert.equal(await put(`channels/${CK}/items/b4`, noEnd), 403, "без newEndMs");
  assert.equal(await put(`channels/${CK}/items/b5`, { ...book, newEndMs: book.newStartMs }), 403, "конец не позже начала");
  assert.equal(await put(`channels/${CK}/items/b6`, { ...book, newEndMs: book.newStartMs - 60000 }), 403);
  assert.equal(await put(`channels/${CK}/items/b7`, { ...book, newStartMs: "завтра" }), 403, "время — число");
  assert.equal(await put(`channels/${CK}/items/b13`, { ...book, newEndMs: book.newStartMs + 8 * 3600000 }), 200, "8 часов — можно");
  assert.equal(await put(`channels/${CK}/items/b14`, { ...book, newEndMs: book.newStartMs + 8 * 3600000 + 60000 }), 403, "дольше 8 часов — нет");
  assert.equal(await put(`channels/${CK}/items/b8`, { ...book, studentId: "Маша, 7 класс" }), 403, "лишнее поле (ученика по ключу знает учитель)");
  assert.equal(await put(`channels/${CK}/items/b9`, { ...book, by: "teacher" }), 403, "подаёт только семья");
  assert.equal(await put(`channels/${CK}/items/b10`, { ...book, comment: "x".repeat(501) }), 403, "комментарий до 500");
  assert.equal(await put(`channels/${CK}/items/b11`, { ...book, lessonId: "" }), 403);
  assert.equal(await put(`channels/${CK}/items/b12`, { ...book, token: "t".repeat(30) }), 403, "поля подписки — только у push");
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

test("настройки кабинета (accessPrefs): по ключу — читать и писать порядок вкладок; перечислять нельзя; лишнее — нельзя", async () => {
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: ["hw", "lessons", "calendar", "requests", "settings"], updatedAt: 1 }), 200);
  assert.equal(await get(`accessPrefs/${PKEY}`), 200);
  assert.equal(await get("accessPrefs"), 403, "список всех настроек — нельзя");
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: ["a"], secret: "x" }), 403, "лишнее поле");
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: "hw,lessons" }), 403, "не список");
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: Array.from({ length: 13 }, (_, i) => "t" + i) }), 403, "слишком длинный");
  assert.equal(await put("accessPrefs/shortkey", { tabOrder: ["hw"] }), 403, "короткий ключ");
  // только известные вкладки кабинета — не произвольные строки (и не огромные)
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: ["lessons", "x".repeat(100000)] }), 403, "чужая вкладка");
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: ["lessons", 5] }), 403, "не строка");
  assert.equal(await put(`accessPrefs/${PKEY}`, { tabOrder: ["settings"] }), 200, "часть вкладок — можно (остальные встанут по умолчанию)");
  assert.equal(await del(`accessPrefs/${PKEY}`), 200);
});
