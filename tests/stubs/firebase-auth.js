// Поддельный firebase-auth для тестов. Пользователи — в localStorage
// ["__fakeAuthUsers"] = { email: { password, uid } }, текущий вход —
// ["__fakeAuthUser"] = { uid, email } (переживает перезагрузку, как настоящий).
// window.__FAKE_AUTH_DISABLED = true — «вход по email не включён в Firebase».
// window.__FAKE_NEXT_UID — какой uid выдать при регистрации.
const USER = "__fakeAuthUser";
const USERS = "__fakeAuthUsers";
const listeners = [];

function err(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; }
}
function current() { return read(USER, null); }
function emit() { const u = current(); listeners.forEach((cb) => cb(u)); }
function checkEnabled() { if (window.__FAKE_AUTH_DISABLED) throw err("auth/configuration-not-found"); }

export function getAuth() { return { __fake: true }; }

export function onAuthStateChanged(auth, cb) {
  listeners.push(cb);
  setTimeout(() => cb(current()), 0);
  return () => {};
}

export async function signInWithEmailAndPassword(auth, email, password) {
  checkEnabled();
  const u = read(USERS, {})[String(email).toLowerCase()];
  if (!u || u.password !== password) throw err("auth/invalid-credential");
  localStorage.setItem(USER, JSON.stringify({ uid: u.uid, email }));
  emit();
  return { user: current() };
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  checkEnabled();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err("auth/invalid-email");
  if (String(password).length < 6) throw err("auth/weak-password");
  const users = read(USERS, {});
  const key = String(email).toLowerCase();
  if (users[key]) throw err("auth/email-already-in-use");
  const uid = window.__FAKE_NEXT_UID || "uid_" + Math.random().toString(36).slice(2, 14);
  users[key] = { password, uid };
  localStorage.setItem(USERS, JSON.stringify(users));
  localStorage.setItem(USER, JSON.stringify({ uid, email }));
  emit();
  return { user: current() };
}

export async function sendPasswordResetEmail(auth, email) {
  checkEnabled();
  const list = read("__fakeResetEmails", []);
  list.push(email);
  localStorage.setItem("__fakeResetEmails", JSON.stringify(list));
}

export async function signOut() {
  localStorage.removeItem(USER);
  emit();
}
