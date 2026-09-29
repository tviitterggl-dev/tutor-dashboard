"use strict";
// Кабинет семьи — вкладка «Календарь» (FullCalendar с CDN): свои занятия,
// «занято» у преподавателя, заявки; перетаскивание = заявка на перенос,
// нажатие на свободное время — «Предложить время нового занятия».

// ---------- календарь ----------
// Один промис на скрипт: повторный вызов, пока скрипт ещё грузится,
// ждёт ту же загрузку (иначе «FullCalendar is not defined»).
const scriptLoads = {};
function loadScript(src) {
  if (!scriptLoads[src]) {
    scriptLoads[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptLoads[src]; reject(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }
  return scriptLoads[src];
}

function calEvents() {
  const out = [];
  myLessons().forEach((l) => {
    const req = pendingFor(l.id);
    out.push({
      id: "own_" + l.id,
      title: (l.pkg ? `Урок ${l.pkg}` : "Урок") + (l.status === "cancelled" ? " · отмена" : l.status === "rescheduled" ? " · перенос" : "") + (req ? " · заявка" : ""),
      start: l.startMs,
      end: l.endMs,
      classNames: ["own", l.status],
      editable: canRequest(l) && !req,
      extendedProps: { lessonId: l.id },
    });
    if (req && req.type === "reschedule") {
      out.push({ id: "ghost_" + req.id, title: "заявка: перенос сюда", start: req.newStartMs, end: req.newEndMs, classNames: ["ghost"], editable: false, extendedProps: { lessonId: l.id } });
    }
  });
  // своя заявка на новое занятие — «призрак» на выбранном времени
  const decidedIds = new Set((view.requests || []).map((r) => r.id));
  shared.filter((i) => i.type === "book" && !decidedIds.has(i.id)).forEach((r) => {
    out.push({ id: "ghost_" + r.id, title: "заявка: новое занятие", start: r.newStartMs, end: r.newEndMs, classNames: ["ghost"], editable: false, extendedProps: {} });
  });
  (view.busy || []).forEach((b, i) => {
    out.push({ id: "busy_" + i, title: "занято", start: b.s, end: b.e, classNames: ["busy"], editable: false, overlap: false, extendedProps: { busy: true } });
  });
  return out;
}

const calRange = () => ({
  start: new Date(view.busyFrom || mondayOf(Date.now() - 28 * 86400000).getTime()),
  end: new Date(view.busyTo || mondayOf(Date.now()).getTime() + 28 * 86400000),
});

// Живые обновления не пересоздают календарь — только меняют события.
function updateCalendar() {
  if (!cal || !view) return;
  cal.setOption("validRange", calRange());
  cal.removeAllEventSources();
  cal.addEventSource(calEvents());
}

// Календарь создаётся при первом открытии вкладки (скрытый контейнер
// FullCalendar меряет неправильно).
let calLoading = null;
async function renderCalendar() {
  if (cal) { cal.updateSize(); updateCalendar(); return; }
  if (calLoading) return calLoading;
  calLoading = (async () => {
    const el = $("cal");
    try {
      await loadScript(FC_JS);
      await loadScript(FC_RU);
    } catch (e) {
      el.innerHTML = '<div class="empty">Календарь не загрузился — проверьте интернет.</div>';
      return;
    }
    if (cal || !view || activeTab !== "calendar") return;
    createCalendar(el);
  })();
  try { await calLoading; } finally { calLoading = null; }
}

function createCalendar(el) {
  el.innerHTML = "";
  const narrow = window.innerWidth < 640;
  cal = new FullCalendar.Calendar(el, {
    locale: "ru",
    firstDay: 1,
    fixedWeekCount: false, // в месяце столько строк, сколько в нём недель (4–6), а не всегда 6
    initialView: narrow ? "timeGridDay" : "timeGridWeek",
    initialDate: new Date(),
    validRange: calRange(),
    headerToolbar: narrow
      ? { left: "prev,next today", center: "", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" }
      : { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" },
    footerToolbar: narrow ? { center: "title" } : false,
    buttonText: { today: "сегодня", day: "день", week: "неделя", month: "месяц", list: "список" },
    slotMinTime: "08:00:00",
    slotMaxTime: "24:00:00", // до конца суток
    scrollTime: "09:00:00",
    allDaySlot: false,
    nowIndicator: true,
    height: "auto",
    slotDuration: "00:30:00",
    snapDuration: "00:15:00",
    eventTimeFormat: { hour: "2-digit", minute: "2-digit" },
    eventLongPressDelay: 400,
    editable: true,
    eventDurationEditable: false,
    eventOverlap: (still) => !still.extendedProps.busy,
    // выделить пустое время → заявка на новое занятие (в месяце — просто день)
    selectable: !!view.channel,
    selectMirror: true,
    selectLongPressDelay: 400,
    selectOverlap: false,
    select: (info) => {
      cal.unselect();
      if (info.allDay) { openBookModal(null, info.start); return; }
      openBookModal(info.start.getTime(), null, Math.round((info.end - info.start) / 60000));
    },
    events: calEvents(),
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      const id = info.event.extendedProps.lessonId;
      if (id) openLessonModal(id);
    },
    eventDrop: async (info) => {
      const l = lessonById(info.event.extendedProps.lessonId);
      const s = info.event.start.getTime();
      const e = info.event.end ? info.event.end.getTime() : s + (l.endMs - l.startMs);
      info.revert(); // расписание меняет только преподаватель
      if (!l || !canRequest(l)) return;
      if (s < Date.now()) { alert("Нельзя перенести на прошедшее время."); return; }
      if (!confirm(`Отправить преподавателю заявку на перенос занятия ${fmtWhen(l.startMs, l.endMs)} → ${fmtWhen(s, e)}?`)) return;
      try {
        await sendRequest(l, "reschedule", { newStartMs: s, newEndMs: e });
      } catch (err) {
        alert(errText(err, "Не удалось отправить заявку. Проверьте интернет."));
      }
    },
  });
  cal.render();
}
