// Кабинет учителя — вкладка «Календарь» (FullCalendar с CDN): загрузка
// занятий и групп в сетку, перетаскивание и растягивание занятий,
// обновление после изменений (afterLessonsChanged).

// ---------- КАЛЕНДАРЬ-РЕДАКТОР (FullCalendar) ----------

const FC_JS = "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.19/index.global.min.js";
const FC_RU = "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.19/locales/ru.global.min.js";
const STATUS_RU = { planned: "запланировано", done: "проведено", cancelled: "отменено", rescheduled: "перенесено" };
let fc = null;

const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function fmtWhen(ms, endMs) {
  const d = new Date(ms);
  return `${fmtDayLabel(d)}.${d.getFullYear()}, ${hhmm(d)}` + (endMs ? `–${hhmm(new Date(endMs))}` : "");
}
const PKG_SUFFIX_RE = /\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;
function baseTitle(title) { return (title || "").replace(PKG_SUFFIX_RE, "").trim(); }
function pkgSuffix(title) {
  const m = (title || "").match(PKG_SUFFIX_RE);
  return m ? ` ${m[1]}/${m[2]}` : "";
}

function lessonToFc(l) {
  if (isPersonal(l)) {
    return {
      id: l.id, title: "Личное время" + (l.note ? ": " + l.note : ""), start: l.startMs, end: l.endMs,
      classNames: ["st-personal"], editable: true, extendedProps: { lesson: l },
    };
  }
  const tag = l.status === "cancelled" ? " · отмена" : l.status === "rescheduled" ? " · перенос" : "";
  return {
    id: l.id,
    title: displayTitle(l.title) + tag,
    start: l.startMs,
    end: l.endMs,
    classNames: ["st-" + l.status],
    editable: l.status === "planned",
    extendedProps: { lesson: l },
  };
}

// Копии одного группового занятия — одним событием («Группа «…»: Анна, Борис»).
function groupToFc(copies) {
  const main = copies.find(c => c.status === "planned") || copies.find(c => c.status !== "rescheduled") || copies[0];
  const status = groupStatus(copies);
  const tag = status === "cancelled" ? " · отмена" : status === "rescheduled" ? " · перенос" : "";
  return {
    id: main.id, title: groupTitle(copies) + tag, start: main.startMs, end: main.endMs,
    classNames: ["st-" + status, "st-group"], editable: status === "planned",
    extendedProps: { lesson: main, group: copies },
  };
}
function lessonsToFc(list) {
  const occ = {};
  const out = [];
  list.forEach(l => {
    if (!isGroupCopy(l)) { out.push(lessonToFc(l)); return; }
    if (!occ[l.groupOcc]) { occ[l.groupOcc] = []; out.push(occ[l.groupOcc]); }
    occ[l.groupOcc].push(l);
  });
  return out.map(x => (Array.isArray(x) ? groupToFc(x) : x));
}

async function loadFcEvents(info, success, failure) {
  try {
    const list = await window.TutorFB.listLessons(info.start.getTime(), info.end.getTime());
    success(lessonsToFc(list));
  } catch (e) {
    failure(e);
  }
}

async function ensureCalendar() {
  if (fc) return fc;
  await loadScriptOnce(FC_JS);
  await loadScriptOnce(FC_RU);
  if (fc) return fc; // параллельный вызов уже создал календарь
  const narrow = window.innerWidth < 640;
  fc = new FullCalendar.Calendar($("fcRoot"), {
    locale: "ru",
    firstDay: 1,
    fixedWeekCount: false, // в месяце столько строк, сколько в нём недель (4–6), а не всегда 6
    initialView: narrow ? "timeGridDay" : "timeGridWeek",
    headerToolbar: narrow
      ? { left: "prev,next today", center: "", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" }
      : { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" },
    footerToolbar: narrow ? { center: "title" } : false,
    buttonText: { today: "сегодня", day: "день", week: "неделя", month: "месяц", list: "список" },
    slotMinTime: "08:00:00",
    slotMaxTime: "24:00:00", // до конца суток
    scrollTime: "09:00:00",
    slotDuration: "00:30:00",
    snapDuration: "00:15:00",
    allDaySlot: false,
    nowIndicator: true,
    height: "auto",
    eventTimeFormat: { hour: "2-digit", minute: "2-digit" },
    selectable: true,
    selectMirror: true,
    selectLongPressDelay: 350,
    eventLongPressDelay: 350,
    editable: true,
    events: loadFcEvents,
    select: (info) => {
      fc.unselect();
      openCreateModal(info.start, info.end);
    },
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openLessonModal(info.event.id);
    },
    eventDrop: onFcDrop,
    eventResize: onFcResize,
    eventDidMount: (info) => {
      const l = info.event.extendedProps.lesson;
      const g = info.event.extendedProps.group;
      if (g) info.el.title = `${groupTitle(g)} — ${STATUS_RU[groupStatus(g)] || ""}`;
      else if (l) info.el.title = isPersonal(l) ? "Личное время" + (l.note ? ": " + l.note : "") : `${displayTitle(l.title)} — ${STATUS_RU[l.status] || l.status}`;
    },
  });
  fc.render();
  return fc;
}

async function refreshCalendar() {
  if (activeTab !== "calendar") { if (fc) fc.refetchEvents(); return; }
  try {
    await ensureCalendar();
    fc.updateSize();
    fc.refetchEvents();
  } catch (e) {
    $("fcRoot").innerHTML = '<div class="empty">Не удалось загрузить календарь (нет интернета?)</div>';
  }
}

function afterLessonsChanged() {
  refreshPackageAlertsSoon();
  if (fc) fc.refetchEvents();
  if (activeTab === "lessons") loadLessonEvents();
  publishViewsSoon();
}

async function onFcDrop(info) {
  const l = info.event.extendedProps.lesson;
  if (!l) { info.revert(); return; }
  if (!navigator.onLine) { info.revert(); offlineToast(); return; }
  const startMs = info.event.start.getTime();
  const endMs = info.event.end ? info.event.end.getTime() : startMs + (l.endMs - l.startMs);
  const group = info.event.extendedProps.group;
  if (group) {
    if (!confirm(`Перенести ${groupLabel(l.groupId).toLowerCase()} (${group.filter(c => c.status === "planned").length} уч.) на ${fmtWhen(startMs, endMs)}?\nВ истории останется отметка «перенесено».`)) { info.revert(); return; }
    try { await rescheduleGroup(group, startMs, endMs); } catch (e) { info.revert(); reportSaveError(e); return; }
    afterLessonsChanged();
    return;
  }
  if (isPersonal(l)) {
    // личное время просто сдвигаем, без истории «перенесено»
    try {
      await window.TutorFB.updateLesson(l.id, lessonData({ title: l.title, startMs, endMs, status: l.status, recurrenceId: l.recurrenceId, source: l.source }));
    } catch (e) {
      info.revert();
      reportSaveError(e);
      return;
    }
    afterLessonsChanged();
    return;
  }
  if (!confirm(`Перенести «${l.title}» на ${fmtWhen(startMs, endMs)}?\nВ истории останется отметка «перенесено».`)) { info.revert(); return; }
  try {
    await rescheduleLesson(l, startMs, endMs);
  } catch (e) {
    info.revert();
    reportSaveError(e);
    return;
  }
  afterLessonsChanged();
}

async function onFcResize(info) {
  const l = info.event.extendedProps.lesson;
  if (!l) { info.revert(); return; }
  if (!navigator.onLine) { info.revert(); offlineToast(); return; }
  const endMs = info.event.end.getTime();
  const fields = { endMs, end: mskIso(endMs), durationMin: Math.round((endMs - l.startMs) / 60000), updatedAt: Date.now() };
  const targets = info.event.extendedProps.group ? info.event.extendedProps.group.filter(c => c.status === "planned" || c.status === "cancelled") : [l];
  try {
    await window.TutorFB.saveLessons(targets.map(c => ({ id: c.id, merge: true, data: fields })));
  } catch (e) {
    info.revert();
    reportSaveError(e);
    return;
  }
  afterLessonsChanged();
}
