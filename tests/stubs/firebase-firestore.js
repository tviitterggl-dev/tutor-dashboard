// Поддельный модуль firebase-firestore для тестов: хранит документы в
// localStorage["__fakeDb"] (переживает перезагрузку страницы, как сервер).
// window.__FAKE_DENY = ["/lessons"] — имитирует «правила ещё не обновлены»:
// любые операции с путём, содержащим подстроку, падают с permission-denied.

const STORE_KEY = "__fakeDb";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; }
}
function save(db) { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
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
  };
}

export async function getDoc(ref) {
  checkDeny(ref.path);
  return snapshotOf(ref.path, load()[ref.path]);
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

export async function setDoc(ref, data, opts) {
  checkDeny(ref.path);
  const db = load();
  applySet(db, ref, data, opts);
  save(db);
}
export async function updateDoc(ref, ...args) {
  checkDeny(ref.path);
  const db = load();
  applyUpdate(db, ref, args);
  save(db);
}
export async function deleteDoc(ref) {
  checkDeny(ref.path);
  const db = load();
  delete db[ref.path];
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
};

export async function getDocs(q) {
  checkDeny(q.path + "/");
  const db = load();
  const prefix = q.path + "/";
  let docs = Object.keys(db)
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => snapshotOf(p, db[p]));
  for (const c of q.constraints || []) {
    if (c.kind === "where") docs = docs.filter((d) => OPS[c.op](d.data()[c.field], c.value));
  }
  const ob = (q.constraints || []).find((c) => c.kind === "orderBy");
  if (ob) docs.sort((a, b) => (a.data()[ob.field] > b.data()[ob.field] ? 1 : -1) * (ob.dir === "desc" ? -1 : 1));
  window.__fakeQueries = (window.__fakeQueries || 0) + 1;
  return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
}

// Живые обновления: опрашиваем «базу» и зовём callback при изменениях
// (как настоящий onSnapshot, но через localStorage, общий для вкладок).
export function onSnapshot(target, onNext, onError) {
  let last = null;
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const snap = target.type === "document" ? await getDoc(target) : await getDocs(target);
      const sig = target.type === "document"
        ? JSON.stringify(snap.exists() ? snap.data() : null)
        : JSON.stringify(snap.docs.map((d) => [d.id, d.data()]));
      if (sig !== last) { last = sig; onNext(snap); }
    } catch (e) {
      stopped = true;
      if (onError) onError(e);
    }
  }
  tick();
  const t = setInterval(tick, 250);
  return () => { stopped = true; clearInterval(t); };
}

export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push((db) => { checkDeny(ref.path); applySet(db, ref, data, opts); }); return this; },
    update(ref, ...args) { ops.push((db) => { checkDeny(ref.path); applyUpdate(db, ref, args); }); return this; },
    delete(ref) { ops.push((db) => { checkDeny(ref.path); delete db[ref.path]; }); return this; },
    async commit() {
      if (ops.length > 500) throw new Error("batch too large: " + ops.length);
      const db = load();
      ops.forEach((op) => op(db));
      save(db);
    },
  };
}
