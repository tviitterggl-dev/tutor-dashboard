// Кабинет учителя (index.html): запуск — вход, первая загрузка, обработчики
// кнопок. Код кабинета разложен по файлам в папке teacher/; они подключаются
// обычными <script src> по порядку (без сборки) и делят одно общее
// пространство имён — см. REVIEW.md, «Как устроен код кабинета учителя».

let appStarted = false;
let appStarting = false;
async function startApp() {
  if (appStarting) return;
  appStarting = true;
  try { await startAppInner(); } finally { appStarting = false; }
}
async function startAppInner() {
  const user = window.TutorAuth.user;
  if (!user) { authPanel("authSignIn"); return; }
  let has;
  try {
    has = await window.TutorAuth.hasSpace(user.uid);
  } catch (err) {
    authPanel("authSignIn");
    authMsg(isPermissionDenied(err)
      ? "База пока не пускает по входу — нужно обновить правила (firebase deploy, см. DEVLOG.md)."
      : "Нет связи с базой — проверь интернет и обнови страницу.", "err");
    return;
  }
  if (!has) {
    if (window.TutorAuth.legacyKey) { setTimeout(() => runMigration(window.TutorAuth.legacyKey, true), 0); return; }
    authPanel("authMigrate");
    authMsg("");
    return;
  }
  if (appStarted) return;
  appStarted = true;
  $("userBadge").textContent = user.email || "";
  $("accountInfo").textContent = "Вход выполнен: " + (user.email || "");
  afterAuth();
}

async function afterAuth() {
  showApp();
  if (!(await bootstrapRemoteState())) return;
  showTab(applyTabOrder()[0]); // первая вкладка в своём порядке — «главная»
  await startChannelWatch();
  publishViewsSoon(); // раз в заход освежаем «занято» в кабинетах родителей
  refreshPackageAlertsSoon();
}

// ---------- файлы ДЗ: перетаскивание, выбор, вставка из буфера ----------
function dropZoneHtml(id, label) {
  return `<label class="drop-zone" data-drop="${id}" tabindex="0">
      <input type="file" id="${id}" multiple>
      <span class="dz-main">${escHtml(label)}</span>
      <span class="dz-sub">перетащи фото или файл сюда, нажми, чтобы выбрать, или вставь скриншот (Ctrl+V)</span>
    </label>`;
}
function wireDropZone(zone, onFiles) {
  if (!zone) return;
  const input = zone.querySelector('input[type="file"]');
  input.addEventListener("change", () => { const f = Array.from(input.files || []); input.value = ""; if (f.length) onFiles(f); });
  ["dragenter", "dragover"].forEach(t => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) onFiles(f); });
}
// Файлы из буфера обмена (скриншот): у картинки из буфера имя «image.png» — даём понятное.
function filesFromClipboard(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const stamp = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[.,: ]+/g, "-");
  return items.filter(i => i.kind === "file").map((i, n) => {
    const f = i.getAsFile();
    if (!f) return null;
    if (!f.name || /^image\.\w+$/i.test(f.name)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `скриншот-${stamp}${n ? "-" + (n + 1) : ""}.${ext}`, { type: f.type });
    }
    return f;
  }).filter(Boolean);
}
var pasteTarget = null; // (var — без «мёртвой зоны»: нужна в openModal/closeModal) куда вставлять файлы из буфера, пока открыто окно занятия
document.addEventListener("paste", (e) => {
  if (!pasteTarget || $("modalBack").style.display === "none") return;
  const files = filesFromClipboard(e);
  if (!files.length) return; // обычный текст — вставляется как обычно
  e.preventDefault();
  pasteTarget(files);
});
async function uploadHwTo(lessonId, files) {
  const tooBig = files.filter(f => f.size > CLOUDINARY_MAX_BYTES);
  if (tooBig.length) { modalMsg(`Слишком большой файл: ${tooBig.map(f => f.name).join(", ")} (максимум 10 МБ).`, "err"); return 0; }
  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    modalMsg(`Загружаю ${i + 1} из ${files.length}: ${files[i].name}…`);
    uploaded.push(await uploadToCloudinary(files[i]));
  }
  const fresh = await window.TutorFB.getLesson(lessonId);
  const hw = [...((fresh && fresh.homework) || []), ...uploaded];
  await window.TutorFB.updateLesson(lessonId, { homework: hw, updatedAt: Date.now() });
  publishViewsSoon();
  return uploaded.length;
}
// Следующее запланированное занятие этого же ученика (по studentId — с фамилией).
async function nextLessonOf(l) {
  const own = await window.TutorFB.listLessonsOfStudent(l.studentId);
  return own.filter(x => x.id !== l.id && x.status === "planned" && !isPersonal(x) && x.startMs > l.startMs)
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
}
var modalLessonId = null; // (var — см. pasteTarget) какое занятие сейчас открыто в окне
async function renderNextHw(l, busy) {
  const box = mq("#mNextHw");
  let next = null;
  try { next = await nextLessonOf(l); } catch (e) { /* без сети */ }
  if (!box || !box.isConnected || modalLessonId !== l.id) return;
  if (!next) {
    box.innerHTML = '<div class="section-title">ДЗ к следующему занятию</div><div class="hint" style="margin-top:0">У ученика пока нет следующего занятия в расписании.</div>';
    return;
  }
  const hw = Array.isArray(next.homework) ? next.homework : [];
  box.innerHTML = `<div class="section-title">ДЗ к следующему занятию</div>
      <div style="margin-bottom:8px">${escHtml(fmtWhen(next.startMs, next.endMs))}${pkgSuffix(next.title).trim() ? " · " + escHtml(pkgSuffix(next.title).trim()) : ""}
        <button class="link-btn" type="button" data-open="${escHtml(next.id)}">открыть</button></div>
      ${hw.length ? `<ul class="file-list">${hw.map(h => `<li><span><a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(h.name || "файл")}</a></span></li>`).join("")}</ul>` : ""}
      ${dropZoneHtml("mNextHwFile", "Прикрепить ДЗ к следующему занятию")}
      <div class="hint">Файлы попадут в следующее занятие ученика — родитель и ученик увидят их у него.</div>`;
  const zone = box.querySelector('[data-drop="mNextHwFile"]');
  const upload = (files) => busy(zone, async () => {
    const n = await uploadHwTo(next.id, files);
    if (n) { modalMsg(`ДЗ к занятию ${fmtWhen(next.startMs)}: ${n === 1 ? "файл прикреплён" : "прикреплено файлов: " + n}`, "ok"); renderNextHw(l, busy); }
  }).catch(() => {});
  wireDropZone(zone, upload);
  zone.addEventListener("focusin", () => { pasteTarget = upload; });
  const openBtn = box.querySelector("[data-open]");
  if (openBtn) openBtn.addEventListener("click", () => openLessonModal(next.id));
}

// ---------- «ДОБАВИТЬ В КАЛЕНДАРЬ»: файл .ics (без входа в Google) ----------
// Стандарт iCalendar (RFC 5545): время в UTC, строки через CRLF, длинные
// строки переносятся, спецсимволы экранируются. UID каждый раз новый —
// повторное нажатие просто добавит ещё одно событие.

function icsEscape(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
}
function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 73) { out.push(cur); cur = " " + ch; bytes = 1 + n; } else { cur += ch; bytes += n; }
  }
  out.push(cur);
  return out.join("\r\n");
}
function buildIcs(l) {
  const call = callLinkFor(l);
  const desc = [call ? "Созвон: " + call.url : "", l.report ? "Отчёт: " + l.report : ""].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tutor-dashboard//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${l.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tutor-dashboard`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(l.startMs)}`,
    `DTEND:${icsDate(l.endMs)}`,
    `SUMMARY:${icsEscape(displayTitle(l.title))}`,
    desc ? `DESCRIPTION:${icsEscape(desc)}` : null,
    call ? `URL:${call.url}` : null,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Занятие", "TRIGGER:-PT30M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
function downloadIcs(l) {
  const blob = new Blob([buildIcs(l)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zanyatie-${l.date || "lesson"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- ФАЙЛЫ ДОМАШКИ (Cloudinary, unsigned upload) ----------

const CLOUDINARY_CLOUD = "xf4hvf5p";
const CLOUDINARY_PRESET = "tutor-dashboard";
const CLOUDINARY_MAX_BYTES = 10 * 1024 * 1024; // лимит бесплатного тарифа для фото/документов

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) {
    const why = (data.error && data.error.message) || ("код " + res.status);
    modalMsg(`Cloudinary не принял файл «${file.name}»: ${why}`, "err");
    const err = new Error("cloudinary " + why);
    err.shown = true;
    throw err;
  }
  return { url: data.secure_url, name: file.name, bytes: data.bytes || file.size, format: data.format || "", uploadedAt: Date.now() };
}

$("fcAddBtn").addEventListener("click", () => openCreateModal());
$("fcPersonalBtn").addEventListener("click", () => openPersonalModal());

// ---------- НАВИГАЦИЯ ПО ВКЛАДКАМ ----------

// «Статистика»: подвкладки «Итоги» (по умолчанию) и «Аналитика»; выбранная
// запоминается до перезагрузки страницы.
let statsMode = "summary";
function showStats(mode) {
  statsMode = mode === "analytics" ? "analytics" : "summary";
  document.querySelectorAll("#view-stats [data-statsmode]").forEach(t => t.classList.toggle("active", t.dataset.statsmode === statsMode));
  $("view-summary").style.display = statsMode === "summary" ? "block" : "none";
  $("view-analytics").style.display = statsMode === "analytics" ? "block" : "none";
  if (statsMode === "summary") refreshSummary(); else loadAnalytics();
}
document.querySelectorAll("#view-stats [data-statsmode]").forEach(t => t.addEventListener("click", () => showStats(t.dataset.statsmode)));

function showTab(tab) {
  if (tab === "summary" || tab === "analytics") { statsMode = tab; tab = "stats"; } // старые названия
  activeTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  TEACHER_TABS.forEach(t => {
    $("view-" + t).style.display = t === tab ? "block" : "none";
  });
  if (tab === "lessons") { stopPoll(); loadLessonEvents(); }
  else if (tab === "calendar") { stopPoll(); refreshCalendar(); }
  else if (tab === "requests") { stopPoll(); renderRequests(); }
  else if (tab === "notify") { stopPoll(); renderNotifyTab(); }
  else if (tab === "stats") { stopPoll(); showStats(statsMode); }
  else if (tab === "students") { stopPoll(); renderStudentsRoster(); loadPackages(); loadAccessCard(); }
  else if (tab === "schedule") { stopPoll(); loadSchedule(); }
  else if (tab === "settings") { stopPoll(); prepareBackup(); renderSettingsTab(); }
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});
if (window.appTheme) window.appTheme.mount($("themeToggle"));

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

// ---- «Настройки»: порядок вкладок, уведомления мне, шаблоны, статус пушей ----
const TAB_LABELS = () => Object.fromEntries([...document.querySelectorAll(".tabs .tab")].map(t => [t.dataset.tab, t.childNodes[0].textContent.trim()]));
let tabOrderEditor = null;
function renderSettingsTab() {
  const labels = TAB_LABELS();
  const items = TEACHER_TABS.map(id => ({ id, label: labels[id] || id }));
  if (!tabOrderEditor) {
    tabOrderEditor = TabOrder.mountEditor($("tabOrderEditor"), {
      items, order: currentTabOrder(),
      onChange: saveTabOrder,
    });
  } else tabOrderEditor.set(currentTabOrder());
  renderTeacherPush();
  (async () => {
    try { await getAccessKeys(); } catch (e) { /* без списка доступов */ }
    renderPushStatus();
    await ensureStarterTemplates();
    renderTemplates();
  })();
}
async function saveTabOrder(order) {
  const m = $("tabOrderMsg");
  if (!navigator.onLine) { tabOrderEditor.set(currentTabOrder()); m.textContent = OFFLINE_TEXT; m.className = "msg err"; return; }
  const prev = remoteState.tabOrder;
  remoteState.tabOrder = order;
  applyTabOrder();
  try {
    await window.TutorFB.patchState({ tabOrder: order });
    m.textContent = "Сохранено — порядок одинаковый на всех твоих устройствах."; m.className = "msg ok";
  } catch (err) {
    remoteState.tabOrder = prev;
    applyTabOrder();
    tabOrderEditor.set(currentTabOrder());
    m.textContent = isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)"; m.className = "msg err";
  }
}

// ---- шаблоны сообщений ----
// state.msgTemplates.{id} = { name, title, text, updatedAt } — в пространстве
// учителя, общие для всех её устройств. В первый раз — три примера.
const TPL_STARTERS = [
  { name: "Напоминание о занятии", title: "Напоминание", text: "Напоминаю: скоро занятие. Подготовь, пожалуйста, тетрадь и домашнее задание." },
  { name: "Поздравление", title: "Поздравляю!", text: "{ученик}, поздравляю с праздником! Желаю успехов и отличного настроения." },
  { name: "Нет занятия на этой неделе", title: "Занятия не будет", text: "На этой неделе занятия не будет. Следующее — по обычному расписанию." },
];
const templates = () => remoteState.msgTemplates || {};
const tplSorted = () => Object.entries(templates()).map(([id, t]) => Object.assign({ id }, t)).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
let tplEditing = null;
function tplMsg(t, kind) { const m = $("tplMsg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
async function ensureStarterTemplates() {
  if (remoteState.msgTemplates !== undefined || !navigator.onLine) return;
  const now = Date.now();
  const seed = {};
  TPL_STARTERS.forEach((t, i) => { seed[newId("tpl")] = Object.assign({ updatedAt: now + i }, t); });
  try {
    await window.TutorFB.patchState({ msgTemplates: seed });
    remoteState.msgTemplates = seed;
  } catch (e) { /* не страшно — попробуем в следующий раз */ }
}
function renderTemplates() {
  const list = tplSorted();
  $("tplList").innerHTML = list.length ? list.map(t => `<div class="nf-item" data-tpl="${escHtml(t.id)}">
        <div class="nf-head">${escHtml(t.name || t.title || "Без названия")}</div>
        ${t.title ? `<div class="nf-meta" style="margin-top:0">Заголовок: ${escHtml(t.title)}</div>` : ""}
        <div class="nf-text">${escHtml(t.text || "")}</div>
        <div class="nf-actions">
          <button class="link-btn" type="button" data-tpl-edit>Изменить</button>
          <button class="link-btn" type="button" data-tpl-delete>Удалить</button>
        </div>
      </div>`).join("") : '<div class="empty">Шаблонов пока нет — добавь ниже.</div>';
  for (const sel of [$("nwTpl"), $("nfTpl")]) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— без шаблона —</option>' + list.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name || t.title)}</option>`).join("");
    if (prev && templates()[prev]) sel.value = prev;
  }
}
function openTplForm(t) {
  tplEditing = t ? t.id : null;
  $("tplForm").style.display = "block";
  $("tplName").value = t ? (t.name || "") : "";
  $("tplTitle").value = t ? (t.title || "") : "";
  $("tplText").value = t ? (t.text || "") : "";
  $("tplSave").textContent = t ? "Сохранить изменения" : "Сохранить шаблон";
  tplMsg("");
  $("tplName").focus();
}
function closeTplForm() { tplEditing = null; $("tplForm").style.display = "none"; }
async function saveTemplate(id, value) {
  await window.TutorFB.setTemplate(id, value);
  remoteState.msgTemplates = Object.assign({}, templates(), { [id]: value });
  if (value == null) delete remoteState.msgTemplates[id];
  renderTemplates();
}
// выбрали шаблон → подставили заголовок и текст (поправить можно)
[["nwTpl", "nwHead", "nwText"], ["nfTpl", "nfHead", "nfText"]].forEach(([sel, head, text]) => $(sel).addEventListener("change", () => {
  const t = templates()[$(sel).value];
  if (!t) return;
  if ($(text).value.trim() && $(text).value.trim() !== (t.text || "") && !confirm("Заменить уже написанный текст шаблоном?")) { $(sel).value = ""; return; }
  $(head).value = t.title || "";
  $(text).value = t.text || "";
}));
$("tplAdd").addEventListener("click", () => openTplForm(null));
$("tplCancel").addEventListener("click", closeTplForm);
$("tplSave").addEventListener("click", async (e) => {
  const name = $("tplName").value.trim().slice(0, 60);
  const title = $("tplTitle").value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
  const text = $("tplText").value.trim().slice(0, 1000);
  if (!text) { tplMsg("Напиши текст шаблона.", "err"); return; }
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await saveTemplate(tplEditing || newId("tpl"), { name: name || title || text.slice(0, 40), title, text, updatedAt: Date.now() });
    const was = !!tplEditing;
    closeTplForm();
    tplMsg(was ? "Шаблон изменён." : "Шаблон сохранён.", "ok");
  } catch (err) {
    tplMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});
$("tplList").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-tpl]");
  if (!item) return;
  const t = templates()[item.dataset.tpl];
  if (!t) return;
  if (e.target.closest("[data-tpl-edit]")) { openTplForm(Object.assign({ id: item.dataset.tpl }, t)); $("tplForm").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (e.target.closest("[data-tpl-delete]")) {
    if (!confirm(`Удалить шаблон «${t.name || t.title}»?`)) return;
    try { await saveTemplate(item.dataset.tpl, null); tplMsg("Шаблон удалён.", "ok"); }
    catch (err) { tplMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не удалилось (нет интернета?)", "err"); }
  }
});
// «Сохранить как шаблон» из формы отправки
document.querySelectorAll("[data-tpl-save]").forEach(b => b.addEventListener("click", async () => {
  const pre = b.dataset.tplSave; // nw | nf
  const title = $(pre + "Head").value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
  const text = $(pre + "Text").value.trim().slice(0, 1000);
  const msgId = pre + "Msg";
  if (!text) { nfMsg(msgId, "Сначала напиши текст — его и сохраним как шаблон.", "err"); return; }
  const name = prompt("Название шаблона (как он будет в списке):", title || text.slice(0, 40));
  if (name === null) return;
  try {
    const id = newId("tpl");
    await saveTemplate(id, { name: name.trim().slice(0, 60) || title || text.slice(0, 40), title, text, updatedAt: Date.now() });
    $(pre + "Tpl").value = id;
    nfMsg(msgId, "Шаблон сохранён — теперь его можно выбрать из списка.", "ok");
  } catch (err) {
    nfMsg(msgId, isOfflineError(err) ? OFFLINE_TEXT : "Шаблон не сохранился (нет интернета?)", "err");
  }
}));

// ---- пуши самому учителю: подписка этого устройства ----
// state.teacherDevices.{id} = { token, createdAt, device } — только в своём
// пространстве учителя; state.teacherPush = { paid, note, homework }.
// Отправляет фоновая рассылка (notifier/send.mjs → teacherPushes).
const TP_STORE = "teacherPushDevice"; // { id, token } этого устройства
const tpSaved = () => { try { return JSON.parse(localStorage.getItem(TP_STORE) || "null"); } catch (e) { return null; } };
const tpSave = (v) => { try { if (v) localStorage.setItem(TP_STORE, JSON.stringify(v)); else localStorage.removeItem(TP_STORE); } catch (e) { /* приватный режим */ } };
const tpIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const tpStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
function tpSupport() {
  if (!window.TutorPush || !window.TutorPush.hasKey()) return "Пуши пока не настроены (нет публичного ключа).";
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    return tpIOS && !tpStandalone()
      ? "На iPhone уведомления приходят, только если кабинет открыт со значка на экране «Домой» (Safari → «Поделиться» → «На экран «Домой»»)."
      : "Этот браузер не умеет получать уведомления.";
  }
  if (Notification.permission === "denied") return "Уведомления для этого сайта запрещены в настройках браузера или телефона — разрешите их там и обновите страницу.";
  return "";
}
const tpDevices = () => remoteState.teacherDevices || {};
const tpOn = () => { const m = tpSaved(); return !!(m && tpDevices()[m.id] && "Notification" in window && Notification.permission === "granted"); };
function tpMsg(t, kind) { const m = $("tpMsg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
function renderTeacherPush() {
  const el = $("tpBody");
  const prefs = remoteState.teacherPush || {};
  document.querySelectorAll("[data-tp]").forEach(c => { c.checked = prefs[c.dataset.tp] !== false; });
  const n = Object.keys(tpDevices()).length;
  const devLine = n ? `<div class="hint" style="margin-top:6px">Подписано устройств: ${n}.</div>` : "";
  const why = tpSupport();
  if (why) { el.innerHTML = `<div class="hint" style="margin-top:0">${escHtml(why)}</div>${devLine}`; return; }
  el.innerHTML = tpOn()
    ? `<div>Приходят на это устройство ✓</div><div class="btn-row"><button class="btn secondary" type="button" id="tpTest">Проверить</button><button class="btn secondary" type="button" id="tpOff">Выключить на этом устройстве</button></div>${devLine}`
    : `<div class="btn-row" style="margin-top:0"><button class="btn" type="button" id="tpOnBtn">Включить на этом устройстве</button></div>${devLine}`;
  if ($("tpOnBtn")) $("tpOnBtn").addEventListener("click", enableTeacherPush);
  if ($("tpOff")) $("tpOff").addEventListener("click", disableTeacherPush);
  if ($("tpTest")) $("tpTest").addEventListener("click", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      await reg.showNotification("Оплата", { body: "Так будут выглядеть уведомления: «Маша, 7 класс: родитель отметил «Оплачено»…»", icon: "icons/icon-192.png" });
      tpMsg("Уведомление показано.", "ok");
    } catch (e) { tpMsg("Не получилось показать уведомление.", "err"); }
  });
}
// Разрешение — первым делом и синхронно в нажатии (Safari на iPhone).
function tpAskPermission() {
  return new Promise((resolve) => {
    const r = Notification.requestPermission(resolve);
    if (r && typeof r.then === "function") r.then(resolve, () => resolve("denied"));
  });
}
async function enableTeacherPush() {
  if (!navigator.onLine) { tpMsg(OFFLINE_TEXT, "err"); return; }
  const permission = tpAskPermission();
  const btn = $("tpOnBtn");
  if (btn) btn.disabled = true;
  tpMsg("Включаю…");
  try {
    if ((await permission) !== "granted") throw Object.assign(new Error("perm"), { userText: "Без разрешения уведомления не придут. Если передумаете — разрешите их и нажмите ещё раз." });
    const reg = await navigator.serviceWorker.register("sw.js");
    const token = await window.TutorPush.token(reg);
    if (!token) throw Object.assign(new Error("token"), { userText: "Устройство не выдало адрес для уведомлений — попробуйте ещё раз." });
    const old = tpSaved();
    const id = old && tpDevices()[old.id] ? old.id : newId("d");
    const value = { token, createdAt: Date.now(), device: tpIOS ? "iPhone/iPad" : /Android/.test(navigator.userAgent) ? "Android" : "компьютер" };
    await window.TutorFB.setTeacherDevice(id, value);
    remoteState.teacherDevices = Object.assign({}, tpDevices(), { [id]: value });
    tpSave({ id, token });
    renderTeacherPush();
    tpMsg("Готово! Уведомления об оплате, пояснениях и ДЗ будут приходить на это устройство.", "ok");
  } catch (err) {
    console.error(err);
    renderTeacherPush();
    tpMsg(err.userText || (isOfflineError(err) ? OFFLINE_TEXT : "Не получилось включить уведомления. Проверьте интернет и попробуйте ещё раз."), "err");
  }
}
async function disableTeacherPush() {
  const m = tpSaved();
  if (!m) return;
  try {
    await window.TutorFB.setTeacherDevice(m.id, null);
    const rest = Object.assign({}, tpDevices());
    delete rest[m.id];
    remoteState.teacherDevices = rest;
    tpSave(null);
    renderTeacherPush();
    tpMsg("Уведомления на этом устройстве выключены.", "ok");
  } catch (err) {
    tpMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не получилось выключить (нет интернета?)", "err");
  }
}
document.querySelectorAll("[data-tp]").forEach(c => c.addEventListener("change", async () => {
  const prefs = Object.assign({ paid: true, note: true, homework: true }, remoteState.teacherPush || {}, { [c.dataset.tp]: c.checked });
  try {
    await window.TutorFB.patchState({ teacherPush: prefs });
    remoteState.teacherPush = prefs;
    tpMsg("Сохранено.", "ok");
  } catch (err) {
    c.checked = !c.checked;
    tpMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)", "err");
  }
}));

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
  try { log = await window.TutorFB.listNotifLog(); } catch (e) { /* журнала нет */ }
  const now = Date.now();
  const fmtAt = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const list = rules.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) { el.innerHTML = '<div class="empty">Уведомлений пока нет — создай выше.</div>'; return; }
  el.innerHTML = list.map(r => {
    const mine = log.filter(x => x.ruleId === r.id);
    const devices = mine.reduce((t, x) => t + (x.delivered || 0), 0);
    const last = mine.reduce((t, x) => Math.max(t, x.sentAt || 0), 0);
    const pushLine = r.push === false ? "без пуша"
      : mine.length ? `пуш: ${mine.length} ${NotifyCore.plural(mine.length, ["рассылка", "рассылки", "рассылок"])}, доставлено на ${devices} ${NotifyCore.plural(devices, ["устройство", "устройства", "устройств"])}, последняя ${fmtAt(last)}`
      : "пуш: ещё не отправлялся";
    const when = r.mode === "before"
      ? `Перед занятием — за ${NotifyCore.offsetText(r)}${Array.isArray(r.lessonIds) && r.lessonIds.length ? ` · к ${r.lessonIds.length} ${NotifyCore.plural(r.lessonIds.length, ["занятию", "занятиям", "занятиям"])}` : " · ко всем занятиям"}`
      : r.mode === "once" ? `Разово — при открытии кабинета ${r.times || 1} ${NotifyCore.plural(r.times || 1, ["раз", "раза", "раз"])}`
      : `Отправлено сейчас · ${fmtAt(r.createdAt || now)}${now - (r.createdAt || 0) > NotifyCore.NOW_TTL_MS ? " (в кабинете уже не показывается)" : ""}`;
    const off = r.active === false;
    return `<div class="nf-item${off ? " off" : ""}" data-nf="${escHtml(r.id)}">
        <div class="nf-head${r.title ? "" : " dflt"}">${escHtml(r.title || NotifyCore.DEFAULT_TITLE[r.mode === "before" ? "rem" : "msg"])}</div>
        <div class="nf-text">${escHtml(r.text || "")}</div>
        <div class="nf-meta">${escHtml(when)} · ${escHtml(targetText(r.target))}${off ? " · <b>выключено</b>" : ""}</div>
        <div class="nf-meta">${escHtml(pushLine)}</div>
        <div class="nf-actions">
          ${r.mode !== "now" ? '<button class="link-btn" type="button" data-nf-edit>Изменить</button>' : ""}
          ${r.mode !== "now" ? `<button class="link-btn" type="button" data-nf-toggle>${off ? "Включить" : "Выключить"}</button>` : ""}
          <button class="link-btn" type="button" data-nf-delete>Удалить</button>
        </div>
      </div>`;
  }).join("");
}

async function renderPushStatus() {
  const el = $("nfPushStatus");
  const keys = (accessKeysCache || []).filter(k => k.active);
  const perStudent = {};
  for (const [sid, ch] of Object.entries(studentChannels())) {
    if (!ch || !ch.shared) continue;
    let items = [];
    try { items = await window.TutorFB.listChannel(ch.shared); } catch (e) { /* пусто */ }
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

// ---------- РЕЗЕРВНАЯ КОПИЯ ----------
// Файлы готовятся ЗАРАНЕЕ (при открытии «Ещё»), а по нажатию отдаются сразу,
// без await: Safari на iPhone разрешает скачивание/«Поделиться» только прямо
// в нажатии. На iPhone — через «Поделиться» (→ «Сохранить в Файлы»): там
// видно, сохранили или отменили, и «Сохранено» пишем только при успехе.
// На компьютере/Android — обычное скачивание; браузер не сообщает, дошёл
// ли файл, поэтому пишем «скачивание запущено», а не «сохранено».
const backupStamp = () => { const d = mskParts(Date.now()); return `${d.date}_${d.time.replace(":", "-")}`; };
const isIOSDevice = () => /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let backupReady = null;   // { json: File, csv: File, lessons, students, at }
let backupLoading = null;
const BACKUP_FRESH_MS = 5 * 60000;
function backupMsg(t, kind) { const m = $("backupMsg"); m.textContent = t; m.className = "msg" + (kind ? " " + kind : ""); }
function setBackupButtons(on) { $("backupJsonBtn").disabled = !on; $("backupCsvBtn").disabled = !on; }
function buildBackupCsv(data) {
  const marksAll = (data.state && data.state.marks) || {};
  const cell = (v) => { const t = v == null ? "" : String(v); return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [["Дата", "Время", "Минут", "Ученик", "Название", "Статус", "Провёл", "Сумма, ₽", "Оплачено", "Отчёт", "Пояснение", "Файлы ДЗ", "Группа"]];
  data.lessons.forEach(l => {
    const when = mskParts(l.startMs || 0);
    const m = marksAll[l.id] || {};
    const amount = m.overrideAmount != null ? m.overrideAmount : (m.marked && m.lockedRate != null ? m.lockedRate : "");
    rows.push([
      when.date, when.time, l.durationMin || Math.round(((l.endMs || 0) - (l.startMs || 0)) / 60000),
      l.kind === "personal" ? "(личное время)" : studentLabel(l.studentId) || "",
      l.kind === "personal" ? (l.note || "Личное время") : displayTitle(l.title),
      STATUS_RU[l.status] || l.status || "", m.marked ? "да" : "", amount,
      l.paid && l.paid.value ? "да" : "", l.report || "", (l.familyNote && l.familyNote.text) || "",
      (Array.isArray(l.homework) ? l.homework : []).map(h => h.url).join(" "),
      l.groupId ? groupLabel(l.groupId) : "",
    ]);
  });
  // «;» и BOM — чтобы русский Excel сразу открыл по столбцам и с кириллицей
  return "\ufeff" + rows.map(r => r.map(cell).join(";")).join("\r\n");
}
function prepareBackup(force) {
  if (backupLoading) return backupLoading;
  if (!force && backupReady && Date.now() - backupReady.at < BACKUP_FRESH_MS) return Promise.resolve(backupReady);
  setBackupButtons(false);
  backupMsg("Готовлю резервную копию…");
  backupLoading = (async () => {
    try {
      const data = await window.TutorFB.exportAll();
      data.lessons.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
      const out = Object.assign({
        app: "tutor-dashboard", format: 1, exportedAt: new Date().toISOString(),
        account: ($("userBadge") && $("userBadge").textContent.trim()) || null,
      }, data);
      const stamp = backupStamp();
      backupReady = {
        json: new File([JSON.stringify(out, null, 2)], `zanyatiya-backup_${stamp}.json`, { type: "application/json" }),
        csv: new File([buildBackupCsv(data)], `zanyatiya_${stamp}.csv`, { type: "text/csv;charset=utf-8" }),
        lessons: data.lessons.length,
        students: Object.keys((data.state && data.state.studentProfiles) || {}).length,
        at: Date.now(),
      };
      backupMsg(`Копия готова: занятий ${backupReady.lessons}, учеников ${backupReady.students}. Нажми кнопку, чтобы сохранить.`);
    } catch (err) {
      console.error(err);
      backupReady = null;
      backupMsg("Не получилось собрать копию (нет интернета?). Открой вкладку «Ещё» ещё раз.", "err");
    } finally {
      backupLoading = null;
      setBackupButtons(true);
    }
    return backupReady;
  })();
  return backupLoading;
}
// Отдать готовый файл — синхронно, прямо в обработчике нажатия.
function deliverBackup(file, what) {
  if (isIOSDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: file.name })
      .then(() => backupMsg(`Сохранено: ${what}. Проверь в «Файлах» или там, куда сохранено.`, "ok"))
      .catch((e) => backupMsg(e && e.name === "AbortError" ? "Отменено — файл не сохранён." : "Не получилось сохранить файл — попробуй ещё раз.", "err"));
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  backupMsg(`Скачивание запущено: ${what}, файл «${file.name}». Проверь папку «Загрузки»; если файла там нет — нажми ещё раз.`, "ok");
}
function onBackupClick(kind) {
  const fresh = backupReady && Date.now() - backupReady.at < BACKUP_FRESH_MS;
  if (!fresh) {
    // данных ещё нет или они устарели: готовим и просим нажать ещё раз
    // (скачивание после ожидания Safari на iPhone не пропустит)
    prepareBackup(true);
    return;
  }
  deliverBackup(backupReady[kind], kind === "json" ? `занятий ${backupReady.lessons}, учеников ${backupReady.students}` : `${backupReady.lessons} занятий в таблице`);
}
$("backupJsonBtn").addEventListener("click", () => onBackupClick("json"));
$("backupCsvBtn").addEventListener("click", () => onBackupClick("csv"));

document.querySelectorAll('.subtab[data-lessonmode]').forEach(tab => {
  tab.addEventListener("click", () => {
    lessonMode = tab.dataset.lessonmode;
    document.querySelectorAll('.subtab[data-lessonmode]').forEach(t => t.classList.toggle("active", t === tab));
    loadLessonEvents();
  });
});
document.querySelector('.subtab[data-lessonmode="day"]').classList.add("active");

document.querySelectorAll('.subtab[data-summode]').forEach(tab => {
  tab.addEventListener("click", () => {
    summaryMode = tab.dataset.summode;
    document.querySelectorAll('.subtab[data-summode]').forEach(t => t.classList.toggle("active", t === tab));
    refreshSummary();
  });
});
document.querySelector('.subtab[data-summode="week"]').classList.add("active");

$("prevBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset--; else weekOffset--;
  loadLessonEvents();
});
$("nextBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset++; else weekOffset++;
  loadLessonEvents();
});
$("markPastBtn").addEventListener("click", markAllPast);

$("summaryPrevBtn").addEventListener("click", () => {
  if (summaryMode === "month") summaryMonthOffset--; else summaryWeekOffset--;
  refreshSummary();
});
$("summaryNextBtn").addEventListener("click", () => {
  if (summaryMode === "month") summaryMonthOffset++; else summaryWeekOffset++;
  refreshSummary();
});
$("summaryRangeGoBtn").addEventListener("click", refreshSummary);
$("copySummaryBtn").addEventListener("click", copySummary);

$("schedPrevBtn").addEventListener("click", () => { schedWeekOffset--; loadSchedule(); });
$("schedNextBtn").addEventListener("click", () => { schedWeekOffset++; loadSchedule(); });
$("schedExportBtn").addEventListener("click", exportScheduleImage);

(function initRangeInputs() {
  const today = new Date();
  const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 7);
  $("summaryRangeStart").value = toDateInputValue(weekAgo);
  $("summaryRangeEnd").value = toDateInputValue(today);
})();

// Модуль Firebase (type="module") выполняется после этого скрипта —
// ждём первого сигнала о входе; дальнейшие входы/выходы тоже слушаем.
(async function start() {
  const ok = await authReady();
  if (!ok || !window.TutorAuth) {
    authPanel("authSignIn");
    authMsg("Не удалось загрузить вход — проверь интернет и обнови страницу.", "err");
    return;
  }
  window.addEventListener("tutor-auth", () => { if (!appStarted) startApp(); });
  startApp();
})();
