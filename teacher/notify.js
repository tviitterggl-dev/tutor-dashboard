// Кабинет учителя — вкладка «Уведомления»: конструктор сообщений и
// напоминаний, список правил и журнал, «Отправить сейчас», статус пушей,
// публикация в витрины.

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

// Сколько раз уведомление ушло пушем. Счётчики ведёт сама фоновая рассылка
// (pushRuns/pushDelivered/pushLastAt в уведомлении, с момента
// state.notifier.statsSince); старое — из журнала, один раз перенесённое в
// pushLegacy. Раньше вкладка читала весь журнал за 60 дней при КАЖДОМ
// открытии и после каждой правки — сотни чтений.
function pushStatsOf(r, log) {
  const lg = r.pushLegacy || {};
  const out = { runs: (r.pushRuns || 0) + (lg.runs || 0), delivered: (r.pushDelivered || 0) + (lg.delivered || 0), last: Math.max(r.pushLastAt || 0, lg.lastAt || 0) };
  // рассылка ещё не начала вести счётчики (до первого её запуска с новым кодом) — по журналу, как раньше
  (log || []).filter(x => x.ruleId === r.id).forEach(x => { out.runs++; out.delivered += x.delivered || 0; out.last = Math.max(out.last, x.sentAt || 0); });
  return out;
}
// Возвращает журнал, который надо учесть при показе (только в переходный
// период — пока у рассылки нет statsSince), иначе []. Один раз после
// появления statsSince переносит старые записи в pushLegacy уведомлений.
async function notifLegacyLog(rules) {
  const since = remoteState.notifier && remoteState.notifier.statsSince;
  if (!since) {
    try { return await window.TutorFB.listNotifLog(); } catch (e) { return []; }
  }
  if (remoteState.notifStatsFrom === since) return [];
  let old;
  try { old = await window.TutorFB.listNotifLog(since); } catch (e) { return []; }
  const agg = {};
  old.forEach(x => {
    const a = agg[x.ruleId] = agg[x.ruleId] || { runs: 0, delivered: 0, lastAt: 0 };
    a.runs++; a.delivered += x.delivered || 0; a.lastAt = Math.max(a.lastAt, x.sentAt || 0);
  });
  try {
    for (const r of rules) {
      if (!agg[r.id]) continue;
      await window.TutorFB.patchNotification(r.id, { pushLegacy: agg[r.id] }).catch(() => {}); // удалено — не страшно
      r.pushLegacy = agg[r.id];
    }
    await window.TutorFB.patchState({ notifStatsFrom: since });
    remoteState.notifStatsFrom = since;
  } catch (e) {
    return old; // не сохранилось (нет сети) — покажем по журналу, перенесём в следующий раз
  }
  return [];
}

async function renderNfList() {
  const el = $("nfList");
  let rules, log = [];
  try {
    rules = await getNotifications(true);
  } catch (e) {
    el.innerHTML = isPermissionDenied(e)
      ? '<div class="hint" style="margin-top:0">База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy, см. README.md).</div>'
      : '<div class="empty">Не удалось загрузить</div>';
    return;
  }
  log = await notifLegacyLog(rules);
  const now = Date.now();
  const fmtAt = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const list = rules.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const item = (r) => {
    const st = pushStatsOf(r, log);
    const pushLine = r.push === false ? "без пуша"
      : st.runs ? `пуш: ${st.runs} ${NotifyCore.plural(st.runs, ["рассылка", "рассылки", "рассылок"])}, доставлено на ${st.delivered} ${NotifyCore.plural(st.delivered, ["устройство", "устройства", "устройств"])}, последняя ${fmtAt(st.last)}`
      : "пуш: ещё не отправлялся";
    const when = r.mode === "before"
      ? `Перед занятием — за ${NotifyCore.offsetText(r)}${Array.isArray(r.lessonIds) && r.lessonIds.length ? ` · к ${r.lessonIds.length} ${NotifyCore.plural(r.lessonIds.length, ["занятию", "занятиям", "занятиям"])}` : " · ко всем занятиям"}`
      : r.mode === "once" ? `Разово — при открытии кабинета ${r.times || 1} ${NotifyCore.plural(r.times || 1, ["раз", "раза", "раз"])}`
      : `${r.source === "report" ? "Отчёт" : "Отправлено сейчас"} · ${fmtAt(r.createdAt || now)}${now - (r.createdAt || 0) > NotifyCore.NOW_TTL_MS ? " (в кабинете уже не показывается)" : ""}`;
    const off = r.active === false;
    // «Кому» — отдельной плашкой, а не мелким серым текстом рядом с датой и статистикой
    return `<div class="nf-item${off ? " off" : ""}" data-nf="${escHtml(r.id)}">
        <div class="nf-head${r.title ? "" : " dflt"}">${escHtml(r.title || NotifyCore.DEFAULT_TITLE[r.mode === "before" ? "rem" : "msg"])}</div>
        <div class="nf-text">${escHtml(r.text || "")}</div>
        <div class="nf-to"><span class="nf-to-label">Кому:</span> ${escHtml(targetText(r.target))}</div>
        <div class="nf-meta">${escHtml(when)}${off ? " · <b>выключено</b>" : ""}</div>
        <div class="nf-meta">${escHtml(pushLine)}</div>
        <div class="nf-actions">
          ${r.mode !== "now" ? '<button class="link-btn" type="button" data-nf-edit>Изменить</button>' : ""}
          ${r.mode !== "now" ? `<button class="link-btn" type="button" data-nf-toggle>${off ? "Включить" : "Выключить"}</button>` : ""}
          <button class="link-btn" type="button" data-nf-delete>Удалить</button>
        </div>
      </div>`;
  };
  // Две группы: настроенные (работают постоянно — можно изменить, выключить) и
  // журнал того, что уже ушло (отчёты и «Отправить сейчас» — только удалить).
  const configured = list.filter(r => r.mode !== "now");
  const sent = list.filter(r => r.mode === "now");
  el.innerHTML = `
      <div class="nf-group" data-nf-group="configured">
        <div class="nf-group-title">Настроенные <span class="nf-group-count">${configured.length}</span></div>
        <div class="nf-group-hint">Работают постоянно: напоминания перед занятиями и сообщения «разово». Можно изменить или выключить.</div>
        ${configured.length ? configured.map(item).join("") : '<div class="empty">Пока нет — создай выше («Новое уведомление»).</div>'}
      </div>
      <div class="nf-group" data-nf-group="sent">
        <div class="nf-group-title">Отчёты и отправленные <span class="nf-group-count">${sent.length}</span></div>
        <div class="nf-group-hint">То, что уже ушло, — за последние 30 дней: отчёты о занятиях и «Отправить сейчас». Только для истории.</div>
        ${sent.length ? sent.map(item).join("") : '<div class="empty">За 30 дней ничего не отправлялось.</div>'}
      </div>`;
}

async function renderPushStatus() {
  const el = $("nfPushStatus");
  const keys = (accessKeysCache || []).filter(k => k.active);
  const perStudent = {};
  for (const [sid, ch] of Object.entries(studentChannels())) {
    if (!ch || !ch.shared) continue;
    // каналы учеников и так живые (startChannelWatch) — берём оттуда, без чтений
    let items = channelItems[ch.shared];
    if (!items) { try { items = await window.TutorFB.listChannel(ch.shared); } catch (e) { items = []; } }
    const byHash = await NotifyCore.pushKeyMap(keys);
    const tokens = new Set(items.filter(i => i.type === "push" && NotifyCore.pushItemKey(i, byHash)).map(i => i.token));
    if (tokens.size) perStudent[sid] = tokens.size;
  }
  const run = remoteState.notifier && remoteState.notifier.lastRunAt;
  const runLine = run
    ? `Фоновая рассылка работает: последний запуск ${new Date(run).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.`
    : "Фоновая рассылка ещё ни разу не запускалась — пуши не уходят, пока её не настроить (README.md → «Уведомления»). Сообщения в кабинетах работают и без неё.";
  const rows = Object.entries(perStudent).sort((a, b) => studentLabel(a[0]).localeCompare(studentLabel(b[0]), "ru"))
    .map(([sid, n]) => `<div class="session-row"><span class="when">${escHtml(studentLabel(sid))}</span><span>${n} ${NotifyCore.plural(n, ["устройство", "устройства", "устройств"])}</span></div>`).join("");
  el.innerHTML = `<div class="hint" style="margin-top:0">${escHtml(runLine)}</div>
      ${rows ? `<div style="margin-top:8px">${rows}</div>` : '<div class="hint">Пока никто не включил уведомления на телефоне.</div>'}`;
}

$("nfTo").addEventListener("change", () => renderNfLessons([]));
// тронули число или единицу — выбираем и сам вариант «Когда»
document.querySelectorAll("#nfCard .nf-inline").forEach(row => row.addEventListener("focusin", () => {
  document.querySelector(`input[name="nfMode"][value="${row.dataset.mode}"]`).checked = true;
  syncHeadPlaceholder();
}));
$("nfCancel").addEventListener("click", () => { resetNfForm(); renderNfLessons([]); nfMsg("nfMsg", ""); });

$("nfSave").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const text = $("nfText").value.trim();
  const mode = document.querySelector('input[name="nfMode"]:checked').value;
  const target = readTarget($("nfTo"));
  if (!text) { nfMsg("nfMsg", "Напиши текст уведомления.", "err"); return; }
  if (!target) { nfMsg("nfMsg", "Выбери, кому.", "err"); return; }
  const now = Date.now();
  const data = { title: headOf("nfHead"), text: text.slice(0, 1000), mode, target, push: $("nfPush").checked, active: true, updatedAt: now };
  if (mode === "once") {
    const n = parseInt($("nfTimes").value, 10);
    if (!(n >= 1 && n <= 50)) { nfMsg("nfMsg", "Сколько раз показать — число от 1 до 50.", "err"); return; }
    data.times = n;
  } else {
    const v = parseFloat(String($("nfOffset").value).replace(",", "."));
    const unit = $("nfUnit").value;
    const ms = v * (NotifyCore.UNIT_MS[unit] || 0);
    if (!(v > 0) || !(ms >= 60000) || ms > 60 * DAY_MS) { nfMsg("nfMsg", "За сколько до занятия — число больше нуля (не больше 60 дней).", "err"); return; }
    data.offsetValue = v;
    data.offsetUnit = unit;
  }
  data.lessonIds = [];
  if (target.scope !== "all" && document.querySelector('input[name="nfLessonsMode"]:checked').value === "some") {
    data.lessonIds = [...$("nfLessons").querySelectorAll("input:checked")].map(i => i.value);
    if (!data.lessonIds.length) { nfMsg("nfMsg", "Отметь хотя бы одно занятие (или выбери «ко всем занятиям»).", "err"); return; }
  }
  // Разовое после правки — это новое сообщение: покажется и отправится заново.
  const keepId = nfEditing && nfEditing.mode === "before" && mode === "before";
  const id = keepId ? nfEditing.id : newId("n");
  data.createdAt = keepId ? (nfEditing.createdAt || now) : now;
  // то же уведомление — счётчики рассылок сохраняются (запись заменяет документ целиком)
  if (keepId) ["pushRuns", "pushDelivered", "pushLastAt", "pushLegacy"].forEach(k => { if (nfEditing[k] !== undefined) data[k] = nfEditing[k]; });
  btn.disabled = true;
  try {
    await window.TutorFB.saveNotification(id, data);
    if (nfEditing && !keepId) await window.TutorFB.deleteNotification(nfEditing.id);
    notifCache = null;
    const wasEdit = !!nfEditing;
    resetNfForm();
    renderNfLessons([]);
    nfMsg("nfMsg", wasEdit ? "Изменения сохранены" : "Уведомление сохранено", "ok");
    renderNfList();
    await publishViews();
  } catch (err) {
    console.error(err);
    nfMsg("nfMsg", isPermissionDenied(err) ? "База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy)." : "Не сохранилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});

$("nwSend").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const text = $("nwText").value.trim();
  const target = readTarget($("nwTo"));
  if (!text) { nfMsg("nwMsg", "Напиши текст.", "err"); return; }
  if (!target) { nfMsg("nwMsg", "Выбери, кому.", "err"); return; }
  const matched = (accessKeysCache || []).filter(k => k.active && NotifyCore.keyMatches(target, k));
  if (!matched.length) { nfMsg("nwMsg", "У этого адресата нет действующего доступа к кабинету.", "err"); return; }
  const now = Date.now();
  btn.disabled = true;
  nfMsg("nwMsg", "Отправляю…");
  try {
    await window.TutorFB.saveNotification(newId("n"), { title: headOf("nwHead"), text: text.slice(0, 1000), mode: "now", times: 1, target, push: $("nwPush").checked, active: true, lessonIds: [], createdAt: now, updatedAt: now });
    notifCache = null;
    await publishViews(matched);
    $("nwText").value = "";
    $("nwHead").value = "";
    nfMsg("nwMsg", `Отправлено: ${targetText(target)} (${matched.length} ${NotifyCore.plural(matched.length, ["кабинет", "кабинета", "кабинетов"])}).${$("nwPush").checked ? " Пуш уйдёт с ближайшей фоновой рассылкой." : ""}`, "ok");
    renderNfList();
  } catch (err) {
    console.error(err);
    nfMsg("nwMsg", isPermissionDenied(err) ? "База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy)." : "Не отправилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});

$("nfList").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-nf]");
  if (!item) return;
  const r = (notifCache || []).find(x => x.id === item.dataset.nf);
  if (!r) return;
  try {
    if (e.target.closest("[data-nf-edit]")) { editNotification(r); return; }
    if (e.target.closest("[data-nf-toggle]")) {
      await window.TutorFB.patchNotification(r.id, { active: r.active === false, updatedAt: Date.now() });
    } else if (e.target.closest("[data-nf-delete]")) {
      if (!confirm("Удалить уведомление? В кабинетах оно пропадёт, пуши по нему больше не пойдут.")) return;
      await window.TutorFB.deleteNotification(r.id);
      if (nfEditing && nfEditing.id === r.id) resetNfForm();
    } else return;
    notifCache = null;
    await renderNfList();
    await publishViews();
  } catch (err) {
    console.error(err);
    alert("Не получилось (нет интернета?)");
  }
});
