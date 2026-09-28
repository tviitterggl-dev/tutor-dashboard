// Кабинет учителя — данные: состояние учителя в Firestore (state/main:
// отметки «Провёл», пакеты, профили), первая загрузка (bootstrapRemoteState),
// офлайн-плашка и отказ изменений без сети, отметки и счётчик пакета.

// ---------- ОТМЕТКИ И ПАКЕТЫ (Firestore, teacherSpaces/{uid}/state/main) ----------
// Раньше жили в localStorage этого браузера — теперь общие для всех
// устройств тьютора. При первом заходе на новом Firebase-проекте всё,
// что уже накопилось в localStorage, переносится в Firestore один раз.

let remoteStateReady = false;
let remoteState = {};
applyTabOrder(); // порядок вкладок сразу — из копии на устройстве; после входа — из базы

// ---------- ОФЛАЙН ----------
// Без интернета: данные — из локального кэша Firestore (последние
// загруженные), сверху плашка; любые изменения честно отказывают.
const OFFLINE_TEXT = "Нет подключения к интернету — изменение не сохранено. Подключись к интернету и повтори.";
const isOfflineError = (e) => !!(e && (e.offline || e.code === "unavailable")) || !navigator.onLine;
let pendingPublish = false;
let toastTimer = null;
function offlineToast(text) {
  const t = $("offlineToast");
  t.textContent = text || OFFLINE_TEXT;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function updateOfflineBar() {
  $("offlineBar").hidden = navigator.onLine;
}
window.addEventListener("offline", updateOfflineBar);
window.addEventListener("online", () => {
  updateOfflineBar();
  $("offlineToast").hidden = true;
  if (window.TutorFB && remoteStateReady) {
    if (pendingPublish) { pendingPublish = false; publishViewsSoon(); }
    if (typeof showTab === "function" && activeTab) showTab(activeTab); // перечитать свежее
  }
});
// Кнопки, которые что-то меняют, без сети сразу говорят, что нужен интернет.
document.addEventListener("click", (e) => {
  if (navigator.onLine) return;
  const b = e.target.closest(".mark-btn, [data-pf-save], .pkg-save-btn, .pkg-new-btn, #pkgAddSaveBtn, #stAddSave, #nwSend, #nfSave, [data-nf-toggle], [data-nf-delete], #tplSave, [data-tpl-delete], [data-tpl-save], #akIssue, [data-key-revoke], #mCreate, #mSaveReport, [data-req], #markPastBtn");
  if (!b) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  offlineToast();
}, true);
updateOfflineBar();

function reportSaveError(e) {
  if (isOfflineError(e)) { offlineToast(); return; }
  console.error("Не удалось сохранить в Firestore", e);
  setBadge($("calBadge"), "База: не сохранилось!", "err");
  alert("Не получилось сохранить изменение в облако (нет интернета?). Обнови страницу и повтори.");
}

// Состояние учителя (отметки, пакеты, профили, каналы). startApp уже
// проверил, что документ есть.
async function bootstrapRemoteState() {
  if (remoteStateReady) return true;
  let remote;
  try {
    remote = await window.TutorFB.loadState();
  } catch (e) {
    console.error("Firestore недоступен", e);
    setBadge($("calBadge"), "База: нет связи — обнови страницу", "err");
    return false;
  }
  remoteState = remote || {};
  packageOverrides = remoteState.pkgOverrides || {};
  marks = remoteState.marks || {};
  remoteStateReady = true;
  return true;
}

function loadMarksFor(ids) {
  ids.forEach(id => {
    if (!marks[id]) marks[id] = { marked: false, overrideAmount: null, lockedRate: null };
  });
}

function saveMark(id, state) {
  marks[id] = state;
  refreshPackageAlertsSoon();
  return window.TutorFB.setMark(id, state).catch(reportSaveError);
}

// «Провёл» и счётчик пакета. Отметки, поставленные ДО начала пакета
// (countFrom), уже сидят в doneBase и сами не считаются. Раньше снятие и
// повторная отметка такого занятия давали +1 лишний (новая отметка — уже
// «после начала»). Теперь:
//  • занятие точно входит в doneBase (ov.baseIds — известно при переносе
//    со старых номеров): снятие → doneBase −1, повторная отметка → +1 как новая;
//  • неизвестно, входит ли: снятие ничего не меняет, а повторная отметка
//    получает прежнее время (baseMarkedAt) — снова «до начала», не считается.
function pkgMarkChange(ev, mark, wasMarked) {
  const sid = (ev._lesson && ev._lesson.studentId) || studentKey(ev);
  const ov = packageOverrides[sid];
  const res = { keepAt: null, holdAt: null };
  if (!ov || !ov.manual || ov.countFrom == null) return res;
  if (wasMarked) {
    const at = mark.markedAt != null ? mark.markedAt : (mark.updatedAt || 0);
    if (at >= ov.countFrom) return res; // отметка пакета — просто перестанет считаться
    const ids = Array.isArray(ov.baseIds) ? ov.baseIds : null;
    if (ids && ids.includes(ev.id)) {
      ov.baseIds = ids.filter(x => x !== ev.id);
      ov.doneBase = Math.max(0, (ov.doneBase || 0) - 1);
      savePackageOverride(sid);
    } else {
      res.holdAt = at;
    }
  } else if (mark && mark.baseMarkedAt != null && mark.baseMarkedAt < ov.countFrom) {
    res.keepAt = mark.baseMarkedAt;
  }
  return res;
}

async function toggleMark(ev, currentMark) {
  if (!navigator.onLine) { offlineToast(); return; } // иначе отметка поменялась бы только на экране
  const wasMarked = !!(currentMark && currentMark.marked);
  const overrideAmount = currentMark ? currentMark.overrideAmount : null;
  let lockedRate = currentMark ? currentMark.lockedRate : null;

  if (!wasMarked) {
    if (overrideAmount == null) lockedRate = rateFor(ev);
  }

  // markedAt — когда нажали «Провёл»: по нему пакет считает проведённые
  // (правка суммы потом его не меняет).
  const now = Date.now();
  const pk = pkgMarkChange(ev, currentMark, wasMarked);
  const newState = { marked: !wasMarked, overrideAmount, lockedRate, markedAt: wasMarked ? null : (pk.keepAt != null ? pk.keepAt : now), updatedAt: now };
  if (wasMarked && pk.holdAt != null) newState.baseMarkedAt = pk.holdAt;
  saveMark(ev.id, newState);
  if (ev._lesson && (ev._lesson.status === "planned" || ev._lesson.status === "done")) {
    const status = newState.marked ? "done" : "planned";
    ev._lesson.status = status;
    window.TutorFB.updateLesson(ev.id, { status, updatedAt: Date.now() })
      .then(() => { if (fc) fc.refetchEvents(); publishViewsSoon(); })
      .catch(reportSaveError);
  }
  renderLessons();
}

function setOverride(ev, value) {
  if (!navigator.onLine) { offlineToast(); renderLessons(); return; }
  const amount = value === "" ? null : parseFloat(value);
  const prev = marks[ev.id] || { marked: false, overrideAmount: null, lockedRate: null };
  const newState = {
    marked: prev.marked,
    overrideAmount: Number.isNaN(amount) ? null : amount,
    lockedRate: prev.lockedRate,
    markedAt: prev.markedAt != null ? prev.markedAt : (prev.marked ? (prev.updatedAt || 0) : null),
    baseMarkedAt: prev.baseMarkedAt != null ? prev.baseMarkedAt : null,
    updatedAt: Date.now(),
  };
  saveMark(ev.id, newState);
  renderLessons();
}

async function markAllPast() {
  const now = new Date();
  const btn = $("markPastBtn");
  const toMark = events.filter(ev => {
    const mark = marks[ev.id];
    if (mark && mark.marked) return false;
    const start = new Date(ev.start.dateTime || ev.start.date);
    if (start > now) return false;
    const amount = effectiveAmountFor(ev, mark);
    return amount != null && !Number.isNaN(amount);
  });
  if (!toMark.length) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = `Отмечаю ${toMark.length}…`;
  toMark.forEach(ev => toggleMark(ev, marks[ev.id]));
  btn.textContent = origText;
  btn.disabled = false;
}
