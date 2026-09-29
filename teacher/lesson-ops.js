// Кабинет учителя — операции с занятиями (без интерфейса): перенос,
// «это и следующие», статус / правка / удаление по выбору, вернуть
// отменённое, серии (одна и несколько дней в неделю), проверка пересечений.

// ---- операции с занятиями ----

// Перенос ОДНОГО занятия. У копии группового занятия (заявка семьи на
// перенос) — ученик уходит на своё время: новое занятие уже личное, вне
// группы и вне её серии. Всю группу переносит rescheduleGroup.
async function rescheduleLesson(l, startMs, endMs) {
  const nid = newId("l");
  const moved = lessonData({
    title: l.title, startMs, endMs, status: "planned",
    packageId: l.packageId, recurrenceId: l.groupId ? null : l.recurrenceId, source: "app",
    extra: Object.assign({ rescheduledFrom: l.id, createdAt: Date.now(), report: l.report || "", homework: l.homework || [] }, l.familyNote ? { familyNote: l.familyNote } : {}),
  });
  await window.TutorFB.saveLessons([
    { id: nid, data: moved },
    { id: l.id, data: { status: "rescheduled", rescheduledTo: nid, updatedAt: Date.now() }, merge: true },
  ]);
  return nid;
}

// «Это и следующие»: только занятия этого же ученика (у копий группы серия
// общая на всех участников — чужие копии здесь не трогаем; всю группу
// меняют групповые функции ниже).
async function scopeTargets(l, scope, statuses) {
  if (scope !== "following" || !l.recurrenceId) return [l];
  const series = await window.TutorFB.listSeries(l.recurrenceId);
  return series.filter(x => x.startMs >= l.startMs && (x.studentId || null) === (l.studentId || null) && (!statuses || statuses.includes(x.status)));
}

// Старые отмены «с заменой в конец пакета» (до 2026-09-27): «Вернуть
// занятие» убирает ещё не проведённую замену. Номеров «k/M» больше нет.
async function restoreWithMakeup(l) {
  const mk = l.makeup;
  const now = Date.now();
  const items = [{ id: l.id, merge: true, data: { status: "planned", makeup: null, updatedAt: now } }];
  let note = "";
  const makeup = mk && mk.id ? await window.TutorFB.getLesson(mk.id) : null;
  if (makeup && makeup.status === "planned") {
    await window.TutorFB.deleteLessons([mk.id]);
    note = " Замена в конце пакета убрана.";
  } else if (makeup) {
    note = " Замена в конце пакета уже проведена — её оставили.";
  }
  await window.TutorFB.saveLessons(items);
  return note;
}

async function setStatusScoped(l, status, scope, fromStatuses) {
  const targets = await scopeTargets(l, scope, fromStatuses);
  await window.TutorFB.saveLessons(targets.map(x => ({ id: x.id, data: { status, updatedAt: Date.now() }, merge: true })));
  return targets.length;
}

async function deleteScoped(l, scope) {
  const targets = (await scopeTargets(l, scope)).filter(x => x.status !== "done" || x.id === l.id);
  await window.TutorFB.deleteLessons(targets.map(x => x.id));
  return targets.length;
}

// Исправление данных «на месте» (без истории переноса). Для серии можно
// применить сдвиг ко всем следующим занятиям: время/день сдвигаются на
// ту же величину, номер в пакете «k/M» у каждого сохраняется.
async function editScoped(l, { base, startMs, durMin, scope }) {
  const delta = startMs - l.startMs;
  const targets = scope === "following" ? await scopeTargets(l, scope, ["planned"]) : [l];
  if (!targets.some(x => x.id === l.id)) targets.unshift(l);
  const items = targets.map(x => {
    const s = x.startMs + delta;
    return {
      id: x.id,
      merge: true,
      data: lessonData({
        title: base + pkgSuffix(x.title), startMs: s, endMs: s + durMin * 60000, status: x.status,
        packageId: x.packageId, recurrenceId: x.recurrenceId, source: x.source,
      }),
    };
  });
  await window.TutorFB.saveLessons(items);
  return items.length;
}

function buildSeries({ base, startMs, durMin, count }) {
  const recurrenceId = count > 1 ? newId("ser") : null;
  const packageId = null;
  const items = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startMs);
    d.setDate(d.getDate() + 7 * i); // то же время на часах, даже через смену времени
    const s = d.getTime();
    const title = base;
    items.push({
      id: newId("l"),
      data: lessonData({ title, startMs: s, endMs: s + durMin * 60000, status: "planned", packageId, recurrenceId, source: "app", extra: { createdAt: Date.now() } }),
    });
  }
  return items;
}

// Несколько «день недели + время» за один раз (вт 16:00 и чт 17:30).
// Первый день — дата/время из формы, остальные — первый такой день недели
// начиная с этой даты. С «Повторять» — занятия по порядку, пока не наберётся
// count (8 занятий при двух днях — 4 недели); у каждого дня недели своя
// серия, чтобы «это и следующие» двигало только свой день. Без повтора — по
// одному занятию на каждый день.
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function slotStarts(startMs, slots) {
  const first = new Date(startMs);
  const seen = new Set();
  const out = [];
  [{ wd: first.getDay(), time: hhmm(first) }, ...slots].forEach(sl => {
    if (!/^\d{1,2}:\d{2}$/.test(sl.time || "")) return;
    const k = sl.wd + " " + sl.time;
    if (seen.has(k)) return;
    seen.add(k);
    const [h, m] = sl.time.split(":").map(Number);
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + ((sl.wd - first.getDay() + 7) % 7), h, m);
    out.push({ ms: d.getTime(), wd: sl.wd, time: sl.time });
  });
  return out;
}
function planSlots({ startMs, count, repeat, slots }) {
  const starts = slotStarts(startMs, slots);
  if (!repeat) return starts.map(st => ({ ms: st.ms, slot: st })).sort((a, b) => a.ms - b.ms);
  // все дни — в пределах недели от первой даты, так что неделя = starts.length занятий
  const out = [];
  for (let w = 0; w < Math.ceil(count / starts.length); w++) {
    starts.forEach(st => {
      const d = new Date(st.ms);
      d.setDate(d.getDate() + 7 * w); // то же время на часах, даже через смену времени
      out.push({ ms: d.getTime(), slot: st });
    });
  }
  return out.sort((a, b) => a.ms - b.ms).slice(0, count);
}
function buildMultiSeries({ base, startMs, durMin, count, repeat, slots }) {
  const planned = planSlots({ startMs, count, repeat, slots });
  const serOf = {};
  planned.forEach(p => { const k = p.slot.wd + " " + p.slot.time; serOf[k] = (serOf[k] || 0) + 1; });
  const ids = {};
  Object.keys(serOf).forEach(k => { ids[k] = repeat && serOf[k] > 1 ? newId("ser") : null; });
  return planned.map(p => ({
    id: newId("l"),
    data: lessonData({ title: base, startMs: p.ms, endMs: p.ms + durMin * 60000, status: "planned", packageId: null, recurrenceId: ids[p.slot.wd + " " + p.slot.time], source: "app", extra: { createdAt: Date.now() } }),
  }));
}

async function findConflicts(items, ignoreIds) {
  if (!items.length) return [];
  const from = Math.min(...items.map(i => i.data.startMs));
  const to = Math.max(...items.map(i => i.data.endMs));
  const existing = (await window.TutorFB.listLessons(from - 4 * 3600000, to))
    .filter(x => isActiveStatus(x.status) && !(ignoreIds || []).includes(x.id));
  const out = [];
  items.forEach(it => {
    existing.forEach(x => {
      if (x.startMs < it.data.endMs && x.endMs > it.data.startMs) out.push(x);
    });
  });
  return out;
}

// ---- общее для обычного и группового окна занятия ----
// lessons — копии одного занятия (у обычного — одна), main — по нему время.

// Разовая ссылка на созвон (пусто — вернуть обычную). false — ссылка неверная
// (сообщение уже показано).
async function saveCallLink(lessons, value) {
  if (value && !safeHref(value)) { modalMsg("Ссылка должна начинаться с https:// (или http://)", "err"); return false; }
  await window.TutorFB.saveLessons(lessons.map(c => ({ id: c.id, merge: true, data: { callUrl: value || null, updatedAt: Date.now() } })));
  publishViewsSoon();
  return true;
}

// «Отчёт» — не просто сохранить: отчёт публикуется в кабинетах и уходит
// уведомлением родителю и ученику (как «Отправить сейчас» — в кабинете сразу,
// пушем — с ближайшей фоновой рассылкой). В группе — каждому участнику, кроме
// тех, у кого эта копия отменена. Возвращает { text, kind } для modalMsg.
async function publishReport(lessons, main, report) {
  const changed = report !== (main.report || "").trim();
  const now = Date.now();
  await window.TutorFB.saveLessons(lessons.map(c => ({ id: c.id, merge: true, data: { report, reportUpdatedAt: now, updatedAt: now } })));
  lessons.forEach(c => { c.report = report; });
  if (!report) { publishViewsSoon(); return { text: "Отчёт убран", kind: "ok" }; }
  if (!changed) return { text: "Отчёт уже опубликован — изменений нет", kind: "ok" };
  const group = lessons.length > 1;
  const to = (group ? lessons.filter(c => c.status !== "cancelled") : lessons)
    .map(c => ({ c, keys: activeKeysOf(c.studentId) })).filter(x => x.keys.length);
  if (!to.length) {
    publishViewsSoon();
    return { text: `Отчёт сохранён. У ${group ? "участников" : "ученика"} нет доступа к кабинету — отправлять некому.`, kind: "ok" };
  }
  const head = `Отчёт по занятию ${fmtWhen(main.startMs, main.endMs)}:\n`;
  const text = (head + report).length > 1000 ? (head + report).slice(0, 999) + "…" : head + report;
  try {
    for (const { c } of to) {
      await window.TutorFB.saveNotification(newId("n"), {
        title: "Отчёт о занятии", text, mode: "now", times: 1, target: { scope: "student", role: "any", studentId: c.studentId },
        push: true, active: true, lessonIds: [c.id], source: "report", createdAt: now, updatedAt: now,
      });
    }
    notifCache = null;
    const keys = to.flatMap(x => x.keys);
    await publishViews(keys);
    return { text: `Отчёт опубликован и отправлен: ${keys.length} ${NotifyCore.plural(keys.length, ["кабинет", "кабинета", "кабинетов"])} (пуш — с ближайшей рассылкой).`, kind: "ok" };
  } catch (err) {
    console.error(err);
    notifCache = null;
    publishViewsSoon();
    return { text: "Отчёт сохранён, но уведомление не ушло (нет интернета?)", kind: "err" };
  }
}
