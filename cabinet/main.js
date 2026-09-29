"use strict";
// Кабинет родителя/ученика (cabinet.html): запуск и всё, что ещё не
// разложено по файлам. Код кабинета — в папке cabinet/: обычные скрипты
// с defer, выполняются по порядку ПОСЛЕ модуля Firebase в cabinet.html
// (он кладёт в window.CabFB базу и нужные функции SDK) и делят одно общее
// пространство имён — см. REVIEW.md, «Как устроен код кабинетов».
// "use strict" — как было в модуле (код модуля всегда строгий).

// ---------- запуск ----------
$("forgetBtn").addEventListener("click", () => {
  if (!confirm("Забыть кабинет на этом устройстве? Чтобы снова войти, понадобится ссылка от преподавателя.")) return;
  // уведомления на это устройство тоже больше не нужны
  Object.values(pushSaved()).forEach((p) => { if (p && p.channel && p.itemId) deleteDoc(doc(db, "channels", p.channel, "items", p.itemId)).catch(() => {}); });
  // подписку могли пересоздать (новый id) — удаляем и по токену устройства
  const tokens = new Set(Object.values(pushSaved()).map((p) => p && p.token).filter(Boolean));
  if (view && view.channel) shared.filter((i) => i.type === "push" && tokens.has(i.token)).forEach((i) => deleteDoc(doc(db, "channels", view.channel, "items", i.id)).catch(() => {}));
  stopWatching();
  try { localStorage.removeItem(STORE); localStorage.removeItem(PUSH_STORE); localStorage.removeItem(SEEN); localStorage.removeItem(VIEW_CACHE); localStorage.removeItem(TAB_ORDER_STORE); } catch (e) { /* ничего */ }
  showInAddress(null);
  current = null;
  view = null;
  closeModal();
  $("switcher").innerHTML = "";
  showMessage("Кабинет на этом устройстве забыт. Для входа откройте ссылку от преподавателя.");
});

function start() {
  const fromHash = takeFromHash();
  const entry = fromHash || loadSaved()[0];
  if (!entry) { showMessage("Для входа нужна личная ссылка от преподавателя."); renderSwitcher(); return; }
  openCabinet(entry);
}
if (window.appTheme) window.appTheme.mount($("themeToggle"));
window.addEventListener("hashchange", start);
start();
