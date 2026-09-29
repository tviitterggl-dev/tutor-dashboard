"use strict";
// Кабинет семьи — общее: функции SDK из модуля в cabinet.html
// (window.CabFB), константы и форматы дат, ключи на этом устройстве,
// состояние кабинета, модальное окно (openModal / closeModal).
// Файлы cabinet/*.js делят одно пространство имён — см. REVIEW.md,
// «Как устроен код кабинетов».

const { db, firebaseApp, FCM_VAPID_KEY, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot } = window.CabFB;

const FCM_URL = "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js";

const FC_JS = "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.19/index.global.min.js";
const FC_RU = "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.19/locales/ru.global.min.js";
const CLOUDINARY_CLOUD = "xf4hvf5p";
const CLOUDINARY_PRESET = "tutor-dashboard";
const CLOUDINARY_MAX_BYTES = 10 * 1024 * 1024;
const STORE = "cabinetKeys";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const p2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const STATUS = { planned: "запланировано", done: "проведено", cancelled: "отменено", rescheduled: "перенесено" };
const ROLE = { parent: "родитель", student: "ученик", teacher: "преподаватель" };
const safeUrl = (u) => /^https:\/\//.test(u || "");

function fmtDay(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function fmtTime(s, e) {
  const a = new Date(s);
  const out = `${p2(a.getHours())}:${p2(a.getMinutes())}`;
  if (!e) return out;
  const b = new Date(e);
  return `${out}–${p2(b.getHours())}:${p2(b.getMinutes())}`;
}
const fmtWhen = (s, e) => `${fmtDay(s)}, ${fmtTime(s, e)}`;
function toDateInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function toTimeInput(ms) { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function newId() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function mondayOf(ms) {
  const d = new Date(ms);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------- ключи на этом устройстве ----------
// Ссылка #p=… / #s=… сохраняется в браузере и ОСТАЁТСЯ в адресной строке:
// «На экран «Домой»» запоминает именно её, и значок открывает этот кабинет
// (у установленного на iPhone приложения своё хранилище, без ключа в ссылке
// оно пустое). Адрес всегда показывает открытый сейчас кабинет.
// «Забыть это устройство» стирает всё сохранённое и ключ из адреса.
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || "[]").filter((x) => x && x.key && x.role); } catch (e) { return []; }
}
function saveSaved(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) { /* приватный режим */ }
}
function takeFromHash() {
  const m = location.hash.match(/(?:^#|&)([ps])=([A-Za-z0-9_-]{24,64})/);
  if (!m) return null;
  const entry = { role: m[1] === "p" ? "parent" : "student", key: m[2] };
  const list = loadSaved().filter((x) => x.key !== entry.key);
  list.unshift(entry);
  saveSaved(list);
  return entry;
}

// ---------- состояние ----------
let current = null;       // { role, key }
let view = null;          // витрина от учителя
let shared = [];          // сообщения общего канала (ДЗ, заявки)
let parentItems = [];     // сообщения родительского канала (оплата)
let unsubs = [];
let pastLimit = 10;
let cal = null;
let openLessonId = null;
let activeTab = "lessons";      // lessons | calendar | hw | requests | settings
// Порядок вкладок — свой у каждой ссылки: accessPrefs/{ключ}.tabOrder (как
// витрина, «ключ = пароль»), копия на устройстве — чтобы был сразу.
const CAB_TABS = ["lessons", "calendar", "hw", "requests", "settings"];
const TAB_ORDER_STORE = "cabinetTabOrder"; // { [ключ]: [...] }
const tabOrders = () => { try { return JSON.parse(localStorage.getItem(TAB_ORDER_STORE) || "{}") || {}; } catch (e) { return {}; } };
function tabOrderFor(key) { return TabOrder.normalize(tabOrders()[key], CAB_TABS); }
function rememberTabOrder(key, order) {
  const all = tabOrders();
  all[key] = order;
  try { localStorage.setItem(TAB_ORDER_STORE, JSON.stringify(all)); } catch (e) { /* приватный режим */ }
}
const applyCabTabOrder = (order) => TabOrder.apply($("tabs"), "data-ctab", order);
let lessonsFilter = "upcoming"; // upcoming | past
let hwSelected = null;          // занятие, выбранное для загрузки во вкладке «ДЗ»
let uploading = false;          // во время загрузки ленту ДЗ не перерисовываем

function stopWatching() {
  unsubs.forEach((u) => u());
  unsubs = [];
  shared = [];
  parentItems = [];
}

function setPanesVisible(on) {
  $("tabs").style.display = on ? "flex" : "none";
  $("root").style.display = on ? "none" : "block";
  document.querySelectorAll(".pane").forEach((p) => { p.style.display = on && p.id === "pane-" + activeTab ? "block" : "none"; });
}

function showMessage(text) {
  $("offlineBar").hidden = true;
  $("title").textContent = "Тьютор Онлайн";
  $("subtitle").textContent = "";
  $("root").innerHTML = `<div class="card"><div class="empty">${esc(text)}</div></div>`;
  $("notices").innerHTML = "";
  setPanesVisible(false);
  $("updatedAt").textContent = "";
}

function viewRef(entry) {
  return doc(db, entry.role === "parent" ? "parentAccess" : "studentAccess", entry.key);
}

function hashOf(entry) { return "#" + (entry.role === "parent" ? "p" : "s") + "=" + entry.key; }
function showInAddress(entry) {
  const url = location.pathname + location.search + (entry ? hashOf(entry) : "");
  try { history.replaceState(null, "", url); } catch (e) { /* не страшно */ }
}

let modalPaste = null; // вставка из буфера в открытое окно занятия (ставит окно занятия, сбрасывают openModal/closeModal)

// ---------- окно занятия ----------
const MODAL_X = '<button type="button" class="modal-x" data-modal-x aria-label="Закрыть" title="Закрыть">×</button>';
function openModal(html) {
  modalPaste = null;
  // × в углу — один раз здесь, для всех окон; в конце разметки, чтобы не менять порядок кнопок
  $("modal").innerHTML = html + MODAL_X;
  $("modalBack").style.display = "flex";
  document.body.style.overflow = "hidden";
}
function closeModal() {
  openLessonId = null;
  modalPaste = null;
  $("modalBack").style.display = "none";
  $("modal").innerHTML = "";
  document.body.style.overflow = "";
}
$("modalBack").addEventListener("click", (e) => { if (e.target === $("modalBack")) closeModal(); });
$("modal").addEventListener("click", (e) => { if (e.target.closest("[data-modal-x]")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
const mq = (s) => $("modal").querySelector(s);
function msg(text, kind) {
  const el = mq("#mMsg");
  if (el) { el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
}
