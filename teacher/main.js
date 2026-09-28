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
