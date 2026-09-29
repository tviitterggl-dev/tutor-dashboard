"use strict";
// Кабинет семьи — занятие из пуш-уведомления: cabinet.html?lesson=<id>
// (кабинет был закрыт) или сообщение от sw.js «open-lesson» (уже открыт) —
// открыть карточку этого занятия, когда оно есть в витрине.

// ---------- занятие из пуш-уведомления ----------
// Пуш с привязкой к занятию ведёт на cabinet.html?lesson=<id>#p=<ключ>.
// Кабинет закрыт — открывается по ссылке; уже открыт — sw.js не открывает
// новую вкладку, а шлёт ей { type: "open-lesson", lessonId }. Окно
// показываем, когда занятие есть в витрине. Нет его (удалено, вне окна
// витрины) — просто кабинет: ждём свежую витрину и тихо забываем.
let linkLesson = (() => {
  const u = new URL(location.href);
  const id = u.searchParams.get("lesson");
  if (!id) return null;
  u.searchParams.delete("lesson"); // обновление страницы не должно открывать окно снова
  try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* не страшно */ }
  return id;
})();
// в открытом окне что-то набрано и не отправлено?
function modalDirty() {
  if ($("modalBack").style.display === "none") return false;
  return [...$("modal").querySelectorAll("input, textarea, select")].some((el) =>
    el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
      : el.tagName === "SELECT" ? [...el.options].some((o) => o.selected !== o.defaultSelected)
        : el.type !== "file" && el.value !== el.defaultValue);
}
function openLinkLessonIfReady() {
  if (!linkLesson || !view) return;
  const id = linkLesson;
  if (!lessonById(id)) { if (!viewStale) linkLesson = null; return; } // в сохранённой копии нет — ждём свежую
  linkLesson = null;
  if (openLessonId === id && $("modalBack").style.display !== "none") return;
  if (modalDirty() && !confirm("Открыть занятие из уведомления? Несохранённое в открытом окне пропадёт.")) return;
  openLessonModal(id);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "open-lesson" || typeof e.data.lessonId !== "string" || e.data.lessonId.length > 200) return;
    linkLesson = e.data.lessonId;
    openLinkLessonIfReady();
  });
  try { navigator.serviceWorker.startMessages(); } catch (e) { /* старый браузер — сообщения и так идут */ }
}
