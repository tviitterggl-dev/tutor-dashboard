// Кабинет учителя — вкладка «Уведомления»: конструктор сообщений и
// напоминаний, список, «Отправить сейчас», публикация в витрины.

// ---------- УВЕДОМЛЕНИЯ (конструктор) ----------
// Логика «кому и когда» — в notify-core.js (общая с кабинетами и фоновой
// рассылкой). Здесь — форма, список и публикация в витрины: кабинет сам
// показывает сообщения при открытии и напоминания перед занятиями, а пуши
// на телефон шлёт GitHub Actions (notifier/), раз в ~15 минут.
let notifCache = null;
async function getNotifications(force) {
  if (!notifCache || force) notifCache = await window.TutorFB.listNotifications();
  return notifCache;
}
const NF_ROLE = { any: "все", parent: "родители", student: "ученик" };
const roleWord = (r) => (r === "parent" ? "родитель" : "ученик");
function recipientGroups() {
  const keys = (accessKeysCache || []).filter(k => k.active);
  const common = [
    { t: { scope: "all", role: "any" }, label: "Все родители и ученики" },
    { t: { scope: "all", role: "parent" }, label: "Все родители" },
    { t: { scope: "all", role: "student" }, label: "Все ученики" },
  ];
  const sids = [...new Set(keys.map(k => k.studentId))].sort((a, b) => studentLabel(a).localeCompare(studentLabel(b), "ru"));
  const groups = sids.map(sid => {
    const ks = keys.filter(k => k.studentId === sid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lbl = studentLabel(sid);
    const items = [{ t: { scope: "student", role: "any", studentId: sid }, label: `${lbl} — все` }];
    if (ks.some(k => k.role === "parent")) items.push({ t: { scope: "student", role: "parent", studentId: sid }, label: `${lbl} — родители` });
    if (ks.some(k => k.role === "student")) items.push({ t: { scope: "student", role: "student", studentId: sid }, label: `${lbl} — ученик` });
    if (ks.length > 1) ks.forEach(k => items.push({ t: { scope: "key", role: k.role, studentId: sid, key: k.id }, label: `${lbl} — ${k.label ? `${k.label} (${roleWord(k.role)})` : `только ${roleWord(k.role)}`}` }));
    return { label: lbl, items };
  });
  return { common, groups };
}
const targetValue = (t) => JSON.stringify([t.scope, t.role || "any", t.studentId || null, t.key || null]);
function fillRecipientSelect(sel) {
  const prev = sel.value;
  const { common, groups } = recipientGroups();
  const one = (o) => `<option value="${escHtml(targetValue(o.t))}" data-t="${escHtml(JSON.stringify(o.t))}">${escHtml(o.label)}</option>`;
  sel.innerHTML = common.map(one).join("") + groups.map(g => `<optgroup label="${escHtml(g.label)}">${g.items.map(one).join("")}</optgroup>`).join("");
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function setRecipient(sel, t) {
  const v = targetValue(t);
  if (![...sel.options].some(o => o.value === v)) {
    // адресата уже нет в списке (доступ отозван) — всё равно показываем
    sel.insertAdjacentHTML("beforeend", `<option value="${escHtml(v)}" data-t="${escHtml(JSON.stringify(t))}">${escHtml(targetText(t))}</option>`);
  }
  sel.value = v;
}
const readTarget = (sel) => { const o = sel.selectedOptions[0]; return o ? JSON.parse(o.dataset.t) : null; };
function targetText(t) {
  if (!t) return "—";
  if (t.scope === "all") return t.role === "parent" ? "все родители" : t.role === "student" ? "все ученики" : "все родители и ученики";
  const base = studentLabel(t.studentId);
  if (t.scope === "key") {
    const k = (accessKeysCache || []).find(x => x.id === t.key);
    return `${base} — ${k && k.active ? (k.label || roleWord(k.role)) : "доступ отозван"}`;
  }
  return `${base} — ${NF_ROLE[t.role || "any"]}`;
}

// Выбор занятий — только когда адресат один ученик (или его родитель).
async function renderNfLessons(selected) {
  const t = readTarget($("nfTo"));
  const sid = t && t.scope !== "all" ? t.studentId : null;
  $("nfLessonsWrap").style.display = sid ? "block" : "none";
  if (!sid) { $("nfLessons").innerHTML = ""; return; }
  const keep = new Set(selected || [...$("nfLessons").querySelectorAll("input:checked")].map(i => i.value));
  const now = Date.now();
  let ls = [];
  try { ls = await window.TutorFB.listLessons(now, now + 120 * DAY_MS); } catch (e) { /* без списка */ }
  ls = ls.filter(l => l.studentId === sid && l.status === "planned" && !isPersonal(l)).sort((a, b) => a.startMs - b.startMs);
  $("nfLessons").innerHTML = ls.length
    ? ls.map(l => `<label class="check"><input type="checkbox" value="${escHtml(l.id)}"${keep.has(l.id) ? " checked" : ""}> ${escHtml(fmtWhen(l.startMs, l.endMs))}${pkgSuffix(l.title).trim() ? " · " + escHtml(pkgSuffix(l.title).trim()) : ""}</label>`).join("")
    : '<div class="hint" style="margin:0">Запланированных занятий нет.</div>';
  $("nfLessons").querySelectorAll("input").forEach(i => i.addEventListener("change", () => {
    document.querySelector('input[name="nfLessonsMode"][value="some"]').checked = true;
  }));
}

// свой заголовок (пусто — в кабинете и пуше будет стандартный)
const headOf = (id) => $(id).value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
// Подсказка в пустом поле — какой заголовок будет по умолчанию.
function syncHeadPlaceholder() {
  const mode = document.querySelector('input[name="nfMode"]:checked');
  $("nfHead").placeholder = NotifyCore.DEFAULT_TITLE[mode && mode.value === "before" ? "rem" : "msg"];
}
document.querySelectorAll('input[name="nfMode"]').forEach(i => i.addEventListener("change", syncHeadPlaceholder));
function nfMsg(id, t, kind) { const m = $(id); m.textContent = t; m.className = "msg" + (kind ? " " + kind : ""); }
let nfEditing = null; // уведомление, которое сейчас правим

function resetNfForm() {
  nfEditing = null;
  $("nfTitle").textContent = "Новое уведомление";
  $("nfSave").textContent = "Сохранить уведомление";
  $("nfCancel").style.display = "none";
  $("nfText").value = "";
  $("nfHead").value = "";
  document.querySelector('input[name="nfMode"][value="before"]').checked = true;
  $("nfOffset").value = "90"; $("nfUnit").value = "min"; $("nfTimes").value = "1";
  document.querySelector('input[name="nfLessonsMode"][value="all"]').checked = true;
  $("nfPush").checked = true;
  $("nfLessons").querySelectorAll("input").forEach(i => { i.checked = false; });
  syncHeadPlaceholder();
}
function editNotification(r) {
  nfEditing = r;
  $("nfTitle").textContent = "Изменить уведомление";
  $("nfSave").textContent = "Сохранить изменения";
  $("nfCancel").style.display = "";
  $("nfText").value = r.text || "";
  $("nfHead").value = r.title || "";
  document.querySelector(`input[name="nfMode"][value="${r.mode === "once" ? "once" : "before"}"]`).checked = true;
  if (r.mode === "before") { $("nfOffset").value = String(r.offsetValue); $("nfUnit").value = r.offsetUnit; }
  if (r.mode === "once") $("nfTimes").value = String(r.times || 1);
  syncHeadPlaceholder();
  setRecipient($("nfTo"), r.target || { scope: "all", role: "any" });
  const some = Array.isArray(r.lessonIds) && r.lessonIds.length;
  document.querySelector(`input[name="nfLessonsMode"][value="${some ? "some" : "all"}"]`).checked = true;
  $("nfPush").checked = r.push !== false;
  renderNfLessons(r.lessonIds || []);
  nfMsg("nfMsg", "");
  $("nfCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderNotifyTab() {
  try { await getAccessKeys(); } catch (e) { /* без списка доступов */ }
  fillRecipientSelect($("nwTo"));
  renderTemplates();
  const nfTarget = nfEditing ? null : $("nfTo").value;
  fillRecipientSelect($("nfTo"));
  if (nfEditing) setRecipient($("nfTo"), nfEditing.target);
  else if (nfTarget) $("nfTo").value = nfTarget;
  renderNfLessons();
  renderNfList();
  await ensureStarterTemplates();
  renderTemplates();
}
