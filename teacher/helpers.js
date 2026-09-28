// Кабинет учителя — вспомогательные функции без своего состояния: даты и
// периоды (неделя, месяц, «Итоги»), имя ученика ↔ studentId, название
// занятия и пакета, ставки, запись занятия для Firestore (lessonData),
// московское время, escHtml, значки статуса.

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДАТ ----------

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtISO(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00+03:00`;
}
function fmtDayLabel(d) {
  const days = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)}`;
}
function fmtShort(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function toDateInputValue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtHours(h) {
  const rounded = Math.round(h * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1).replace(".", ",");
}

const MONTHS_RU = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_SHORT_RU = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

function getLessonRange() {
  if (lessonMode === "day") {
    const base = new Date();
    base.setDate(base.getDate() + dayOffset);
    base.setHours(0, 0, 0, 0);
    const end = new Date(base);
    end.setDate(base.getDate() + 1);
    return { start: base, end, label: fmtDayLabel(base) };
  }
  const base = new Date();
  base.setDate(base.getDate() + weekOffset * 7);
  const mon = mondayOf(base);
  const nextMon = new Date(mon);
  nextMon.setDate(mon.getDate() + 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: mon, end: nextMon, label: `${fmtDayLabel(mon)} – ${fmtDayLabel(sun)}` };
}

function getSummaryRange(offsetWeeks, offsetMonths) {
  if (summaryMode === "week") {
    const base = new Date();
    base.setDate(base.getDate() + offsetWeeks * 7);
    const mon = mondayOf(base);
    const nextMon = new Date(mon);
    nextMon.setDate(mon.getDate() + 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { start: mon, end: nextMon, label: `${fmtDayLabel(mon)} – ${fmtDayLabel(sun)}` };
  }
  if (summaryMode === "month") {
    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + offsetMonths);
    const start = new Date(base.getFullYear(), base.getMonth(), 1);
    const end = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    return { start, end, label: `${MONTHS_RU[start.getMonth()]} ${start.getFullYear()}` };
  }
  const sVal = $("summaryRangeStart").value;
  const eVal = $("summaryRangeEnd").value;
  if (!sVal || !eVal) return null;
  const start = new Date(sVal + "T00:00:00");
  const end = new Date(eVal + "T00:00:00");
  end.setDate(end.getDate() + 1);
  return { start, end, label: `${fmtShort(start)} – ${fmtShort(new Date(end.getTime() - 86400000))}` };
}

function getPrevSummaryRange(current) {
  if (summaryMode === "week") return getSummaryRange(summaryWeekOffset - 1, 0);
  if (summaryMode === "month") return getSummaryRange(0, summaryMonthOffset - 1);
  const lenMs = current.end - current.start;
  const prevEnd = new Date(current.start.getTime());
  const prevStart = new Date(current.start.getTime() - lenMs);
  return { start: prevStart, end: prevEnd, label: "" };
}

// Ученик = «Имя, N класс» или, если при добавлении указали фамилию,
// «Имя Фамилия, N класс» — так можно завести двух «Маш, 7 класс».
// Занятия называются «Имя N класс …» / «Имя Фамилия N класс …».
// У старых учеников фамилия (если есть) — только для показа, в названия
// занятий и в идентификатор она не входит.
function makeStudentId(name, cls, surname) { return `${name}${surname ? " " + surname : ""}, ${cls} класс`; }
function splitStudentId(id) {
  const m = String(id || "").match(/^([А-ЯЁа-яё]+)(?:\s+([А-ЯЁа-яё][А-ЯЁа-яё-]*))?,\s*(\d{1,2})\s*класс$/u);
  return m ? { name: m[1], surname: m[2] || "", cls: parseInt(m[3], 10) } : null;
}
// Профиль по идентификатору без учёта регистра («сева 7 класс» → «Сева, 7 класс»).
function profileIdCI(id) {
  const profs = remoteState.studentProfiles || {};
  if (profs[id]) return id;
  const want = String(id).toLowerCase();
  return Object.keys(profs).find(k => k.toLowerCase() === want) || null;
}
function parseLesson(summary) {
  const s = summary || "";
  // «Имя Фамилия N класс» — только если такой ученик с фамилией заведён
  // (иначе «Мама Маши 7 класс» и т.п. не превратятся в «ученика»).
  const two = s.match(/^([А-ЯЁа-яё]+)\s+([А-ЯЁа-яё][А-ЯЁа-яё-]*)\s+(\d{1,2})\s*класс/iu);
  if (two) {
    const pid = profileIdCI(makeStudentId(two[1], parseInt(two[3], 10), two[2]));
    const sp = pid && splitStudentId(pid);
    if (sp && sp.surname) return Object.assign(sp, { prefixLen: two[0].length });
  }
  const m = s.match(/^([А-ЯЁа-яё]+)\s+(\d{1,2})\s*класс/iu);
  if (!m) return null;
  return { name: m[1], surname: "", cls: parseInt(m[2], 10), prefixLen: m[0].length };
}
// Как показывать ученика: «Имя Фамилия, N класс» (фамилия — если заполнена).
function studentLabel(id) {
  if (!id) return "";
  const pid = profileIdCI(id);
  const p = pid ? (remoteState.studentProfiles || {})[pid] : null;
  const sp = splitStudentId(pid || id);
  if (!sp) return String(id);
  const surname = sp.surname || (p && p.surname) || "";
  return `${(p && p.name) || sp.name}${surname ? " " + surname : ""}, ${sp.cls} класс`;
}
// Название занятия для показа: «Маша 7 класс 3/8» → «Маша Иванова 7 класс 3/8»,
// если у ученика заполнена фамилия (само название в базе не меняется).
function displayTitle(title) {
  const parsed = parseLesson(title);
  if (!parsed || parsed.surname) return title || "";
  const pid = profileIdCI(makeStudentId(parsed.name, parsed.cls, ""));
  const surname = pid && (remoteState.studentProfiles || {})[pid] ? (remoteState.studentProfiles || {})[pid].surname : "";
  if (!surname) return title;
  return `${parsed.name} ${surname} ${parsed.cls} класс` + String(title).slice(parsed.prefixLen);
}
// Ставка — из профиля ученика (вкладка «Ученики»). Имя сравниваем без
// учёта регистра: в названиях занятий бывает «сева 7 класс».
function findRate(name, cls, surname) {
  const profs = remoteState.studentProfiles || {};
  let p;
  if (surname) {
    const pid = profileIdCI(makeStudentId(name, cls, surname));
    p = pid ? profs[pid] : null;
    if (p && p.hidden) p = null;
  } else {
    // ученик без фамилии в идентификаторе (у «Маши Ивановой» — своя ставка)
    const nlow = name.toLowerCase();
    const hit = Object.entries(profs).find(([k, x]) => x && x.name && !x.hidden && x.name.toLowerCase() === nlow && Number(x.cls) === cls && !(splitStudentId(k) || {}).surname);
    p = hit ? hit[1] : null;
  }
  return p && typeof p.rate === "number" ? p.rate : null;
}
function studentKey(ev) {
  const parsed = parseLesson(ev.summary || "");
  return parsed ? makeStudentId(parsed.name, parsed.cls, parsed.surname) : (ev.summary || "Без названия");
}
// Номер занятия в пакете: заголовок вида "Имя 7 класс 3/8" -> {current:3, total:8}
function parsePackage(summary) {
  const m = (summary || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const current = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (!total || !current || current > total) return null;
  return { current, total };
}

// overrideAmount всегда побеждает; иначе, если занятие уже отмечено —
// используется ставка, зафиксированная в момент отметки (lockedRate),
// чтобы будущее изменение цены не переписывало прошлое.
function effectiveAmountFor(ev, mark) {
  const m = mark || {};
  if (m.overrideAmount != null) return m.overrideAmount;
  if (m.marked && m.lockedRate != null) return m.lockedRate;
  return rateFor(ev);
}
// Ставка занятия: цена предоплаченного пакета (пока он идёт), иначе — из
// профиля. Как и счётчик пакета, цена привязана к отметке «Провёл», а не к
// дате: любое ещё не отмеченное занятие, отмеченное сейчас, войдёт в пакет.
function rateFor(ev) {
  const parsed = parseLesson(ev.summary || "");
  const sid = (ev._lesson && ev._lesson.studentId) || (parsed ? makeStudentId(parsed.name, parsed.cls, parsed.surname) : null);
  // групповое занятие — по групповой цене ученика (не задана — как личное)
  if (sid && ev._lesson && ev._lesson.groupId) {
    const g = groupRateOf(sid);
    if (g != null) return g;
  }
  const pkg = sid ? pkgRateFor(sid) : null;
  if (pkg != null) return pkg;
  return parsed ? findRate(parsed.name, parsed.cls, parsed.surname) : null;
}
// Скидка за предоплату пакета: ov.price = { mode: "pct", value: 10 } (−10% от
// ставки) или { mode: "total", value: 14000 } (за весь пакет, делится на
// число занятий). Только у учителя — в витрины семей не попадает.
function pkgPriceOf(ov, rate) {
  const pr = ov && ov.price;
  if (!pr || !(pr.value > 0)) return null;
  if (pr.mode === "total") return Math.round(pr.value / (ov.totalOverride > 0 ? ov.totalOverride : 8));
  if (pr.mode === "pct" && pr.value < 100 && rate != null) return Math.round(rate * (1 - pr.value / 100));
  return null;
}
function pkgRateFor(sid) {
  const ov = packageOverrides[sid];
  if (!ov || !ov.manual || ov.hidden || !ov.price) return null;
  const p = lastPackagesByKey[sid];
  if (p && p.remaining <= 0) return null; // пакет закончился — дальше обычная ставка
  const sp = splitStudentId(sid);
  return pkgPriceOf(ov, sp ? findRate(sp.name, sp.cls, sp.surname) : null);
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = "badge" + (cls ? " " + cls : "");
  // статус базы живёт во «Ещё», но ошибку показываем наверху — её нельзя пропустить
  if (el.id === "calBadge") {
    const a = $("syncAlert");
    a.style.display = cls === "err" ? "block" : "none";
    a.textContent = cls === "err" ? `${text} — нажми, чтобы обновить страницу` : "";
  }
}

// ---------- ЗАНЯТИЯ (Firestore) ----------
// Источник правды — коллекция lessons. Занятия отдаются в «календарном»
// формате ({id, summary, start.dateTime, end.dateTime, _lesson}) — на нём
// исторически построены итоги, пакеты и ставки.

const isActiveStatus = (s) => s === "planned" || s === "done";

function lessonToEv(l) {
  return { id: l.id, summary: l.title, start: { dateTime: l.start }, end: { dateTime: l.end }, _lesson: l };
}

function isPermissionDenied(e) {
  return e && (e.code === "permission-denied" || /insufficient permissions/i.test(e.message || ""));
}

// «Личное время» (kind: "personal") хранится рядом с занятиями, но в
// деньги, итоги, пакеты и список занятий не попадает — только в сетку
// занятости (opts.includePersonal) и в «занято» кабинетов.
const isPersonal = (l) => l && l.kind === "personal";

async function fetchLessons(start, end, opts = {}) {
  const list = await window.TutorFB.listLessons(start.getTime(), end.getTime());
  setBadge($("calBadge"), "Занятия: в дашборде", "ok");
  return list
    .filter(l => opts.includeInactive || isActiveStatus(l.status))
    .filter(l => opts.includePersonal || !isPersonal(l))
    .map(lessonToEv);
}

// ---- время в Москве (все занятия ведутся по Москве, UTC+3 без перехода) ----
const MSK_OFFSET_MS = 3 * 3600000;
function mskIso(ms) { return new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 19) + "+03:00"; }
function mskParts(ms) {
  const s = new Date(ms + MSK_OFFSET_MS).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
function studentIdFromTitle(title) {
  const parsed = parseLesson(title || "");
  return parsed ? makeStudentId(parsed.name, parsed.cls, parsed.surname) : null;
}
// Полная запись занятия для Firestore (поля из плана платформы: date,
// time, studentId, status, packageId, recurrenceId + служебные).
function lessonData(fields) {
  const { date, time } = mskParts(fields.startMs);
  return Object.assign({
    title: fields.title,
    studentId: studentIdFromTitle(fields.title),
    startMs: fields.startMs,
    endMs: fields.endMs,
    start: mskIso(fields.startMs),
    end: mskIso(fields.endMs),
    date,
    time,
    durationMin: Math.round((fields.endMs - fields.startMs) / 60000),
    status: fields.status || "planned",
    packageId: fields.packageId || null,
    recurrenceId: fields.recurrenceId || null,
    source: fields.source || "app",
    updatedAt: Date.now(),
  }, fields.extra || {});
}
function newId(prefix) {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return prefix + "_" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
