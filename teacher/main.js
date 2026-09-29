// Кабинет учителя (index.html): запуск — вход, первая загрузка, переключение
// вкладок. Подключается последним: остальной код кабинета — в файлах
// teacher/*.js перед ним (обычные <script src> по порядку, без сборки,
// одно общее пространство имён — см. REVIEW.md, «Как устроен код кабинета
// учителя»).

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
  await ensureContactsMigrated();
  publishViewsSoon(); // раз в заход освежаем «занято» в кабинетах родителей
  refreshPackageAlertsSoon();
  lessonLinkReady(); // занятие из пуш-уведомления (?lesson=) — теперь можно открыть
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
  else if (tab === "settings") { stopPoll(); showBackupState(); renderSettingsTab(); }
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});
if (window.appTheme) window.appTheme.mount($("themeToggle"));

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
