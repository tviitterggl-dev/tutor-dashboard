// Поддельный модуль firebase-firestore для тестов: хранит документы в
// localStorage["__fakeDb"] (переживает перезагрузку страницы, как сервер).
// window.__FAKE_DENY = ["/lessons"] — имитирует «правила ещё не обновлены»:
// любые операции с путём, содержащим подстроку, падают с permission-denied.

import { checkWrite, checkRead } from "./rules-check.js";

const STORE_KEY = "__fakeDb";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; }
}
function save(db) { localStorage.setItem(STORE_KEY, JSON.stringify(db)); if (typeof notifyLive === "function") queueMicrotask(notifyLive); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// Упрощённые правила: teacherSpaces/{uid}/… — только вошедшему с этим uid
// (как firestore.rules). window.__FAKE_RULES = "old" — старые правила,
// когда туда пускали по секретному ключу в пути (нужно для теста переноса).
function checkDeny(path) {
  const denied = () => {
    const err = new Error("Missing or insufficient permissions.");
    err.code = "permission-denied";
    throw err;
  };
  const deny = window.__FAKE_DENY || [];
  if (deny.some((s) => path.includes(s))) denied();
  const seg = path.split("/");
  if (seg[0] === "teacherSpaces" && window.__FAKE_RULES !== "old") {
    let user = null;
    try { user = JSON.parse(localStorage.getItem("__fakeAuthUser") || "null"); } catch (e) { /* нет */ }
    if (!user || user.uid !== seg[1]) denied();
  }
}

const DELETE = { __fakeDelete: true };
export function deleteField() { return DELETE; }

export class FieldPath {
  constructor(...segments) { this.segments = segments; }
}

export function getFirestore() { return { __fake: true }; }
// Локальный кэш (как persistentLocalCache в настоящем SDK). Без сети
// (navigator.onLine === false) чтения отдаются «из кэша» (metadata.fromCache);
// window.__FAKE_OFFLINE_NOCACHE = true — кэша на устройстве нет (пусто).
export function initializeFirestore() { window.__fakePersistence = true; return { __fake: true }; }
export function persistentLocalCache(opts) { return { kind: "persistent", opts }; }
export function persistentMultipleTabManager() { return { kind: "multi-tab" }; }
const offlineNow = () => typeof navigator !== "undefined" && navigator.onLine === false;
const noCache = () => offlineNow() && window.__FAKE_OFFLINE_NOCACHE;

function joinPath(base, segs) {
  return [base, ...segs].filter(Boolean).join("/");
}
export function collection(parent, ...segs) {
  const base = parent && parent.path ? parent.path : "";
  return { type: "collection", path: joinPath(base, segs) };
}
export function doc(parent, ...segs) {
  const base = parent && parent.path ? parent.path : "";
  const path = joinPath(base, segs);
  return { type: "document", path, id: path.split("/").pop() };
}

function setIn(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (typeof cur[segs[i]] !== "object" || cur[segs[i]] === null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  const last = segs[segs.length - 1];
  if (value === DELETE) delete cur[last]; else cur[last] = clone(value);
}
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v === DELETE) { delete target[k]; continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = clone(v);
    }
  }
  return target;
}
function stripDeletes(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v !== DELETE) out[k] = clone(v);
  return out;
}

function snapshotOf(path, data) {
  return {
    id: path.split("/").pop(),
    ref: { type: "document", path, id: path.split("/").pop() },
    exists: () => data !== undefined,
    data: () => clone(data),
    metadata: { fromCache: offlineNow(), hasPendingWrites: false },
  };
}

// Счётчик чтений — как их считает Firestore в квоте Spark: getDoc — 1,
// getDocs — по документу в ответе (минимум 1), onSnapshot — все документы
// при подписке, дальше только изменившиеся. window.__fakeReads.
function countReads(n) { window.__fakeReads = (window.__fakeReads || 0) + n; }
export async function getDoc(ref) {
  // ответ — следующей задачей, как у настоящей сети (иначе запись из другой
  // вкладки, ещё не дошедшая до этой, не видна — чего с сервером не бывает).
  // Через MessageChannel, а не setTimeout: таймеры фоновой вкладки браузер
  // замедляет до секунды.
  await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  checkDeny(ref.path);
  const whyR = checkRead(ref.path);
  if (whyR) denyWith(whyR);
  countReads(1);
  return snapshotOf(ref.path, noCache() ? undefined : load()[ref.path]);
}

function applySet(db, ref, data, opts) {
  if (opts && opts.mergeFields) {
    const cur = db[ref.path] || {};
    for (const f of opts.mergeFields) {
      if (data[f] === undefined || data[f] === DELETE) delete cur[f]; else cur[f] = clone(data[f]);
    }
    db[ref.path] = cur;
  } else if (opts && opts.merge) {
    db[ref.path] = deepMerge(db[ref.path] || {}, data);
  } else {
    db[ref.path] = stripDeletes(data);
  }
}
function applyUpdate(db, ref, args) {
  if (db[ref.path] === undefined) {
    const err = new Error("No document to update: " + ref.path);
    err.code = "not-found";
    throw err;
  }
  const cur = db[ref.path];
  if (args[0] instanceof FieldPath) {
    for (let i = 0; i < args.length; i += 2) setIn(cur, args[i].segments, args[i + 1]);
  } else {
    for (const [k, v] of Object.entries(args[0])) setIn(cur, k.split("."), v);
  }
}

// Содержимое записи проверяем как firestore.rules (tests/stubs/rules-check.js;
// паритет с настоящими правилами — tests/rules/parity.test.mjs). Проверяется
// документ ПОСЛЕ записи (с учётом merge/update), как request.resource.data.
function denyWith(why) { const e = new Error("Missing or insufficient permissions. (" + why + ")"); e.code = "permission-denied"; throw e; }
function checkRules(path, next, prev) {
  if (window.__FAKE_RULES === "old" && path.startsWith("teacherSpaces/")) return; // старые правила (тест переноса)
  const why = checkWrite(path, next === undefined ? null : clone(next), prev === undefined ? undefined : clone(prev));
  if (why) denyWith(why);
}
// применить запись к копии базы и проверить результат; вернуть новую базу
function applyChecked(db, ref, fn) {
  const prev = db[ref.path];
  const tmp = { [ref.path]: prev === undefined ? undefined : clone(prev) };
  fn(tmp);
  checkRules(ref.path, tmp[ref.path] === undefined ? null : tmp[ref.path], prev);
  if (tmp[ref.path] === undefined) delete db[ref.path]; else db[ref.path] = tmp[ref.path];
}

export async function setDoc(ref, data, opts) {
  checkDeny(ref.path);
  const db = load();
  applyChecked(db, ref, (d) => applySet(d, ref, data, opts));
  save(db);
}
export async function updateDoc(ref, ...args) {
  checkDeny(ref.path);
  const db = load();
  applyChecked(db, ref, (d) => applyUpdate(d, ref, args));
  save(db);
}
export async function deleteDoc(ref) {
  checkDeny(ref.path);
  const db = load();
  applyChecked(db, ref, (d) => { delete d[ref.path]; });
  save(db);
}

export function where(field, op, value) { return { kind: "where", field, op, value }; }
export function orderBy(field, dir = "asc") { return { kind: "orderBy", field, dir }; }
export function query(col, ...constraints) { return { type: "query", path: col.path, constraints }; }

const OPS = {
  "==": (a, b) => a === b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  in: (a, b) => b.includes(a),
};

function queryDocs(q) {
  checkDeny(q.path + "/");
  const whyR = checkRead(q.path);
  if (whyR) denyWith(whyR);
  const db = load();
  const prefix = q.path + "/";
  let docs = Object.keys(noCache() ? {} : db)
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => snapshotOf(p, db[p]));
  for (const c of q.constraints || []) {
    if (c.kind === "where") docs = docs.filter((d) => OPS[c.op](d.data()[c.field], c.value));
  }
  const ob = (q.constraints || []).find((c) => c.kind === "orderBy");
  if (ob) docs.sort((a, b) => (a.data()[ob.field] > b.data()[ob.field] ? 1 : -1) * (ob.dir === "desc" ? -1 : 1));
  return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn), metadata: { fromCache: offlineNow() } };
}
export async function getDocs(q) {
  const snap = queryDocs(q);
  window.__fakeQueries = (window.__fakeQueries || 0) + 1;
  countReads(Math.max(1, snap.size));
  return snap;
}

// Живые обновления: опрашиваем «базу» и зовём callback при изменениях
// (как настоящий onSnapshot, но через localStorage, общий для вкладок).
export function onSnapshot(target, a, b, c) {
  // onSnapshot(ref, onNext, onError) или onSnapshot(ref, options, onNext, onError)
  const [onNext, onError] = typeof a === "function" ? [a, b] : [b, c];
  let last = null;
  let stopped = false;
  let seen = null; // id → JSON: для счёта чтений (платно только изменившееся)
  function tick() {
    if (stopped) return;
    try {
      let snap;
      if (target.type === "document") {
        checkDeny(target.path);
        snap = snapshotOf(target.path, noCache() ? undefined : load()[target.path]);
      } else snap = queryDocs(target);
      const docs = target.type === "document" ? [[target.path, snap.exists() ? snap.data() : null]] : snap.docs.map((d) => [d.id, d.data()]);
      const now = new Map(docs.map(([id, d]) => [id, JSON.stringify(d)]));
      if (!seen) countReads(Math.max(1, now.size));
      else now.forEach((v, id) => { if (seen.get(id) !== v) countReads(1); });
      seen = now;
      const sigFull = JSON.stringify(docs) + "|" + offlineNow();
      if (sigFull !== last) { last = sigFull; onNext(snap); }
    } catch (e) {
      stopped = true;
      liveTicks.delete(tick);
      if (onError) onError(e);
    }
  }
  // первый ответ — асинхронно (как у Firestore), свои записи — сразу (ниже)
  Promise.resolve().then(tick);
  liveTicks.add(tick);
  const t = setInterval(tick, 250);
  return () => { stopped = true; clearInterval(t); liveTicks.delete(tick); };
}
// Как у настоящего Firestore: своя запись сразу видна подпискам этой вкладки
// (раньше, чем завершится промис записи).
const liveTicks = new Set();
function notifyLive() { liveTicks.forEach((t) => t()); }

export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push((db) => { checkDeny(ref.path); applyChecked(db, ref, (d) => applySet(d, ref, data, opts)); }); return this; },
    update(ref, ...args) { ops.push((db) => { checkDeny(ref.path); applyChecked(db, ref, (d) => applyUpdate(d, ref, args)); }); return this; },
    delete(ref) { ops.push((db) => { checkDeny(ref.path); applyChecked(db, ref, (d) => { delete d[ref.path]; }); }); return this; },
    async commit() {
      if (ops.length > 500) throw new Error("batch too large: " + ops.length);
      const db = load();
      ops.forEach((op) => op(db));
      save(db);
    },
  };
}
