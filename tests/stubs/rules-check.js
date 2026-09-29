// Проверки записи — копия firestore.rules для поддельной базы e2e-тестов.
// Чистые функции без браузера: их же гоняет tests/rules/parity.test.mjs
// рядом с настоящими правилами в эмуляторе на одной таблице случаев — если
// правила поменяли, а здесь нет (или наоборот), тест паритета упадёт.
// Иначе e2e-тесты могли бы «пропускать» запись, которую настоящая база
// отклонит (так и было: занятия, витрины и настройки тут не проверялись).
//
// checkWrite(path, next, prev) → null (можно) или строка-причина (нельзя).
//   path — путь документа; next — документ ПОСЛЕ записи (с учётом merge),
//   null — удаление; prev — документ до записи (undefined — его не было).

const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string";
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (d, keys) => Object.keys(d).every((k) => keys.includes(k));

export function validLesson(d) {
  return isInt(d.startMs) && isInt(d.endMs) && d.endMs > d.startMs
    && isStr(d.title) && d.title.length <= 200
    && ["planned", "done", "cancelled", "rescheduled"].includes(d.status);
}

export function validItem(d) {
  if (!onlyKeys(d, ["type", "lessonId", "by", "createdAt", "file", "newStartMs", "newEndMs", "comment", "paid", "token", "key"])) return false;
  if (!["homework", "reschedule", "cancel", "paid", "note", "push", "book"].includes(d.type)) return false;
  if (!isStr(d.lessonId) || d.lessonId.length < 1 || d.lessonId.length > 128) return false;
  if (!["parent", "student", "teacher"].includes(d.by)) return false;
  if (!isInt(d.createdAt)) return false;
  if ("comment" in d && !(isStr(d.comment) && (d.comment.length <= 500 || (d.type === "note" && d.comment.length <= 1000)))) return false;
  if (d.type === "note" && !isStr(d.comment)) return false;
  if (d.type === "homework" && !(isMap(d.file) && onlyKeys(d.file, ["url", "name"])
    && isStr(d.file.url) && d.file.url.length <= 500 && /^https:\/\/res[.]cloudinary[.]com\/.*$/.test(d.file.url)
    && isStr(d.file.name) && d.file.name.length <= 200)) return false;
  const timeOk = isInt(d.newStartMs) && isInt(d.newEndMs) && d.newEndMs > d.newStartMs;
  if (d.type === "reschedule" && !timeOk) return false;
  if (d.type === "book" && !(timeOk && d.newEndMs - d.newStartMs <= 8 * 3600000 && ["parent", "student"].includes(d.by))) return false;
  if (d.type === "paid" && typeof d.paid !== "boolean") return false;
  if (d.type === "push" && !(isStr(d.token) && d.token.length >= 20 && d.token.length <= 4096
    && isStr(d.key) && d.key.length >= 24 && d.key.length <= 64)) return false;
  if (d.type !== "push" && ("token" in d || "key" in d)) return false;
  return true;
}

export function validMaterial(m) {
  return isMap(m) && onlyKeys(m, ["url", "title"])
    && isStr(m.url) && m.url.length <= 500 && /^https?:\/\/.+$/.test(m.url)
    && (!("title" in m) || (isStr(m.title) && m.title.length <= 80));
}
export function validView(d) {
  return d.v === 1 && ["parent", "student"].includes(d.role)
    && Array.isArray(d.lessons) && d.lessons.length <= 500
    && Array.isArray(d.busy) && d.busy.length <= 1500
    && (!("materials" in d) || (Array.isArray(d.materials) && d.materials.length <= 10 && d.materials.every(validMaterial)))
    && (!("contacts" in d) || (Array.isArray(d.contacts) && d.contacts.length <= 6 && d.contacts.every(validMaterial)));
}

export const CAB_TAB_IDS = ["lessons", "calendar", "hw", "requests", "settings"];
export function validPrefs(d) {
  return onlyKeys(d, ["tabOrder", "updatedAt"])
    && Array.isArray(d.tabOrder) && d.tabOrder.length <= 12
    && d.tabOrder.every((t) => CAB_TAB_IDS.includes(t))
    && (!("updatedAt" in d) || isInt(d.updatedAt));
}

export function validNotification(d) {
  return isStr(d.text) && d.text.length > 0 && d.text.length <= 1000
    && ["once", "before", "now"].includes(d.mode) && isMap(d.target);
}

// Права учителя (вошёл ли он под этим uid) проверяет сама поддельная база;
// здесь — только то, что правила требуют от содержимого и пути.
export function checkWrite(path, next, prev) {
  const s = path.split("/");
  const del = next === null;
  if (s[0] === "teacherSpaces" && s.length === 4) {
    const col = s[2];
    if (col === "state" || col === "accessKeys" || col === "requests") return null;
    if (col === "lessons") return del || validLesson(next) ? null : "validLesson";
    if (col === "notifications") return del || validNotification(next) ? null : "validNotification";
    if (col === "notifLog") return del ? null : "notifLog пишет только фоновая рассылка";
    return "нет такой коллекции в правилах: " + col;
  }
  if (s[0] === "channels" && s.length === 4 && s[2] === "items") {
    if (s[1].length < 24) return "короткий ключ канала";
    if (del) return null;
    if (prev !== undefined) return "сообщение канала менять нельзя";
    return validItem(next) ? null : "validItem";
  }
  if ((s[0] === "parentAccess" || s[0] === "studentAccess") && s.length === 2) {
    if (s[1].length < 24) return "короткий ключ";
    return del || validView(next) ? null : "validView";
  }
  if (s[0] === "accessPrefs" && s.length === 2) {
    if (s[1].length < 24) return "короткий ключ";
    return del || validPrefs(next) ? null : "validPrefs";
  }
  return "путь закрыт правилами: " + path;
}

// Чтение (кроме прав учителя): каналы и настройки — только по длинному ключу.
export function checkRead(path) {
  const s = path.split("/");
  if (s[0] === "channels" && s[1] && s[1].length < 24) return "короткий ключ канала";
  if (s[0] === "accessPrefs" && s[1] && s[1].length < 24) return "короткий ключ";
  return null;
}
