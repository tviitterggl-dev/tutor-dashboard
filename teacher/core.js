// Кабинет учителя — общее: открытая вкладка и порядок вкладок, состояние
// списка занятий, $(id) и модальное окно (openModal / closeModal).
// Файлы teacher/*.js делят одно пространство имён — см. REVIEW.md,
// «Как устроен код кабинета учителя».

let activeTab = "lessons"; // см. TEACHER_TABS
// Вкладки учителя — по умолчанию в этом порядке; свой порядок — state/main.tabOrder.
const TEACHER_TABS = ["lessons", "calendar", "requests", "notify", "stats", "students", "schedule", "settings"];
const TAB_ORDER_STORE = "teacherTabOrder"; // копия на устройстве — чтобы порядок был сразу, до загрузки базы
function currentTabOrder() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(TAB_ORDER_STORE) || "null"); } catch (e) { /* нет */ }
  return TabOrder.normalize(legacyStats((remoteStateReady && remoteState.tabOrder) || local), TEACHER_TABS);
}
// До 27.09 «Итоги» и «Аналитика» были отдельными вкладками. В сохранённом
// порядке «Статистика» встаёт на место первой из них, вторая убирается.
function legacyStats(order) {
  if (!Array.isArray(order) || !order.some(t => t === "summary" || t === "analytics")) return order;
  const out = [];
  order.forEach(t => {
    const id = t === "summary" || t === "analytics" ? "stats" : t;
    if (!out.includes(id)) out.push(id);
  });
  return out;
}
function applyTabOrder() {
  const order = currentTabOrder();
  TabOrder.apply(document.querySelector(".tabs"), "data-tab", order);
  try { localStorage.setItem(TAB_ORDER_STORE, JSON.stringify(order)); } catch (e) { /* приватный режим */ }
  return order;
}

// Занятия (день/неделя)
let lessonMode = "day"; // day | week — по умолчанию «День»
let dayOffset = 0;
let weekOffset = 0;
let events = [];
let marks = {};
let pollTimer = null;

const $ = (id) => document.getElementById(id);

// ---------- МОДАЛЬНОЕ ОКНО ----------

// Состояние открытого окна: какое занятие в нём (modalLessonId) и куда
// вставлять файлы из буфера (pasteTarget; ставят окна занятия, сбрасывают
// openModal/closeModal).
let modalLessonId = null;
let pasteTarget = null;
const MODAL_X = '<button type="button" class="modal-x" data-modal-x aria-label="Закрыть" title="Закрыть">×</button>';
function openModal(html) {
  pasteTarget = null; // новое окно — вставка из буфера только туда, где есть зона для файлов
  modalLessonId = null;
  // × в углу — один раз здесь, для всех окон; в конце разметки, чтобы не менять порядок кнопок
  $("modal").innerHTML = html + MODAL_X;
  $("modalBack").style.display = "flex";
  $("modalBack").scrollTop = 0;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  pasteTarget = null;
  modalLessonId = null;
  $("modalBack").style.display = "none";
  $("modal").innerHTML = "";
  document.body.style.overflow = "";
}
const modalOpen = () => $("modalBack").style.display !== "none";
$("modalBack").addEventListener("click", (e) => { if (e.target === $("modalBack")) closeModal(); });
$("modal").addEventListener("click", (e) => { if (e.target.closest("[data-modal-x]")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOpen()) closeModal(); });
const mq = (sel) => $("modal").querySelector(sel);
function modalMsg(text, kind) {
  const el = mq("#mMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}
