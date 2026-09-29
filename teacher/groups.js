// Кабинет учителя — групповые занятия: копия занятия на каждого участника
// (groupId + groupOcc), сохранение, перенос и правка всей группы, окно
// группового занятия, состав группы.

// ---------- ГРУППОВЫЕ ЗАНЯТИЯ ----------
// Групповое занятие = по копии на каждого участника (обычное занятие со
// своим studentId и названием «Имя N класс») + общие поля:
//   groupId  — группа (state.groups[groupId] = { name, members, callUrl });
//   groupOcc — это занятие группы (одинаков у всех копий одного времени).
// Поэтому «Провёл», пакет, цена (групповая), «Оплачено», кабинет семьи,
// заявки и пуши работают у каждого участника как у личного занятия, а
// календарь, «Итоги» и «Аналитика» (часы, отмены) склеивают копии в одно.
const groupsMap = () => remoteState.groups || {};
const isGroupCopy = (l) => !!(l && l.groupId && l.groupOcc);
const groupLabel = (gid) => { const g = groupsMap()[gid]; return g && g.name ? `Группа «${g.name}»` : "Группа"; };
const shortName = (sid) => { const sp = splitStudentId(sid); return sp ? `${sp.name}${sp.surname ? " " + sp.surname : ""}` : String(sid || ""); };
// название занятия для ученика («Маша 7 класс» / «Маша Иванова 7 класс»)
function titleOfStudent(sid) {
  const st = studentList().find(x => x.id === sid);
  if (st) return titleBaseOf(st);
  const sp = splitStudentId(sid);
  return sp ? `${sp.name}${sp.surname ? " " + sp.surname : ""} ${sp.cls} класс` : String(sid);
}
// копии одного занятия группы (все начинаются в одно время)
async function groupCopies(l) {
  if (!isGroupCopy(l)) return [l];
  const list = await window.TutorFB.listLessons(l.startMs, l.startMs + 1);
  const out = list.filter(x => x.groupOcc === l.groupOcc);
  return out.length ? out.sort((a, b) => shortName(a.studentId).localeCompare(shortName(b.studentId), "ru")) : [l];
}
// состояние занятия группы целиком: идёт, если идёт хоть у кого-то
function groupStatus(copies) {
  const st = copies.map(c => c.status);
  for (const s of ["planned", "done", "cancelled"]) if (st.includes(s)) return s;
  return "rescheduled";
}
function groupTitle(copies) {
  const live = copies.filter(c => c.status !== "rescheduled");
  const names = (live.length ? live : copies).slice().sort((a, b) => shortName(a.studentId).localeCompare(shortName(b.studentId), "ru")).map(c => shortName(c.studentId) + (c.status === "cancelled" && live.some(x => x.status !== "cancelled") ? " (отм.)" : ""));
  return `${groupLabel(copies[0].groupId)}: ${names.join(", ")}`;
}
// Новые копии для занятий группы: base — занятия «на одного» (время, серия),
// members — участники. Один groupOcc на каждое время.
function buildGroupItems(baseItems, gid, members) {
  const out = [];
  baseItems.forEach(b => {
    const occ = newId("go");
    members.forEach(sid => out.push({
      id: newId("l"),
      data: lessonData({ title: titleOfStudent(sid), startMs: b.data.startMs, endMs: b.data.endMs, status: "planned", recurrenceId: b.data.recurrenceId, source: "app", extra: { createdAt: Date.now(), groupId: gid, groupOcc: occ } }),
    }));
  });
  return out;
}
async function saveGroup(gid, value) {
  await window.TutorFB.setGroup(gid, value);
  remoteState.groups = Object.assign({}, groupsMap());
  if (value == null) delete remoteState.groups[gid]; else remoteState.groups[gid] = value;
}
// Перенос всей группы: у каждой ещё не проведённой копии — перенос с историей.
async function rescheduleGroup(copies, startMs, endMs) {
  copies = copies.slice().sort((a, b) => (a.status === "planned" ? 0 : 1) - (b.status === "planned" ? 0 : 1));
  const occ = newId("go");
  const now = Date.now();
  const items = [];
  // «не придёт» переезжает вместе с группой (остаётся отменённым — можно «вернуть»)
  if (!copies.some(c => c.status === "planned")) return null;
  copies.filter(c => c.status === "planned" || c.status === "cancelled").forEach(c => {
    const nid = newId("l");
    items.push({ id: nid, data: lessonData({
      title: c.title, startMs, endMs, status: c.status, packageId: c.packageId, recurrenceId: c.recurrenceId, source: "app",
      extra: Object.assign(carriedOnMove(c), { createdAt: now, groupId: c.groupId, groupOcc: occ }),
    }) });
    items.push({ id: c.id, merge: true, data: { status: "rescheduled", rescheduledTo: nid, updatedAt: now } });
  });
  if (!items.length) return null;
  await window.TutorFB.saveLessons(items);
  return items[0].id;
}
// «Это и следующие» для группы: копии всех участников этой группы в серии
async function groupScopeTargets(copies, scope, statuses) {
  const l = copies[0];
  const ok = (x) => !statuses || statuses.includes(x.status);
  if (scope !== "following" || !l.recurrenceId) return copies.filter(ok);
  const series = await window.TutorFB.listSeries(l.recurrenceId);
  return series.filter(x => x.groupId === l.groupId && x.startMs >= l.startMs && ok(x));
}
// Правка времени/длительности группы «на месте»: названия у каждой копии свои.
// Отменённые («не придёт») и уже отмеченные «Провёл» копии двигаются вместе
// с группой — иначе их не найти в окне занятия (копии ищутся по времени).
async function editGroupScoped(copies, { startMs, durMin, scope }) {
  const delta = startMs - copies[0].startMs;
  const targets = await groupScopeTargets(copies, scope, ["planned", "cancelled", "done"]);
  await window.TutorFB.saveLessons(targets.map(x => {
    const s = x.startMs + delta;
    return { id: x.id, merge: true, data: lessonData({ title: x.title, startMs: s, endMs: s + durMin * 60000, status: x.status, packageId: x.packageId, recurrenceId: x.recurrenceId, source: x.source }) };
  }));
  return targets.length;
}
// Будущие занятия группы: из живой подписки на занятия (листать всю историю
// группы незачем — прошлое не меняется); дальше окна
// подписки (250 дней) — дочитывается только этот кусок.
const GROUP_AHEAD_MS = 3 * 365 * DAY_MS;
async function futureGroupLessons(gid, now) {
  return (await window.TutorFB.listLessons(now, now + GROUP_AHEAD_MS)).filter(l => l.groupId === gid);
}
// Состав группы: новые участники получают копии всех будущих занятий группы,
// убранные — теряют свои будущие непроведённые копии (прошлое остаётся).
async function applyGroupMembers(gid, members) {
  const now = Date.now();
  const prev = (groupsMap()[gid] || {}).members || [];
  const all = await futureGroupLessons(gid, now);
  const byOcc = {};
  all.filter(l => l.groupOcc).forEach(l => { (byOcc[l.groupOcc] = byOcc[l.groupOcc] || []).push(l); });
  const add = [], del = [];
  Object.values(byOcc).forEach(copies => {
    const tpl = copies.find(c => c.status === "planned");
    if (!tpl) return; // занятие уже отменено у всех — не трогаем
    members.forEach(sid => {
      if (copies.some(c => c.studentId === sid)) return;
      const teacherHw = (tpl.homework || []).filter(h => !h.by || h.by === "teacher");
      add.push({ id: newId("l"), data: lessonData({ title: titleOfStudent(sid), startMs: tpl.startMs, endMs: tpl.endMs, status: "planned", recurrenceId: tpl.recurrenceId, source: "app",
        extra: Object.assign({ createdAt: now, groupId: gid, groupOcc: tpl.groupOcc, homework: teacherHw }, tpl.callUrl ? { callUrl: tpl.callUrl } : {}) }) });
    });
    copies.forEach(c => { if (!members.includes(c.studentId) && c.status !== "done") del.push(c.id); });
  });
  if (add.length) await window.TutorFB.saveLessons(add);
  if (del.length) await window.TutorFB.deleteLessons(del);
  return { added: members.filter(x => !prev.includes(x)), removed: prev.filter(x => !members.includes(x)), created: add.length, deleted: del.length };
}

// ---------- окно группового занятия ----------
// Сверху — участники: у каждого свои «Провёл», сумма (групповая цена),
// «Оплачено» и «не придёт» (отмена только для этого ученика). Ниже — общее для всей
// группы: время, перенос, отмена, отчёт, файлы ДЗ, ссылка на созвон.
async function openGroupModal(l, note) {
  let copies;
  try { copies = await groupCopies(l); } catch (e) { alert("Не удалось открыть занятие (нет интернета?)."); return; }
  renderGroupModal(copies, note);
}
function renderGroupModal(copies, note) {
  const live = copies.filter(c => c.status !== "rescheduled");
  const main = live.find(c => c.status === "planned") || live[0] || copies[0];
  const gid = main.groupId;
  const status = groupStatus(copies);
  const inSeries = !!main.recurrenceId;
  const memberRow = (c) => {
    const mark = marks[c.id] || { marked: false, overrideAmount: null, lockedRate: null };
    const ev = lessonToEv(c);
    const amount = effectiveAmountFor(ev, mark);
    const canMark = amount != null && !Number.isNaN(amount);
    const base = mark.marked && mark.lockedRate != null ? mark.lockedRate : rateFor(ev);
    const paid = !!(c.paid && c.paid.value);
    const active = c.status === "planned" || c.status === "done";
    return `<div class="g-member" data-gid="${escHtml(c.id)}">
        <div class="g-name"><b>${escHtml(shortName(c.studentId))}</b> <span class="status-pill ${escHtml(c.status)}">${STATUS_RU[c.status] || escHtml(c.status)}</span>
          ${c.familyNote && c.familyNote.text ? `<div class="family-note" style="margin-top:4px">${escHtml(c.familyNote.text)}</div>` : ""}</div>
        ${active ? `<div class="lesson-bottom">
          <div class="rate-field">₽ <input type="number" inputmode="decimal" data-g-amount placeholder="${base != null ? base : "сумма"}" value="${mark.overrideAmount != null ? mark.overrideAmount : ""}"></div>
          <button class="mark-btn ${mark.marked ? "done" : ""}" type="button" data-g-mark ${canMark ? "" : "disabled"}>${mark.marked ? "✓ Провёл (снять)" : "Провёл"}</button>
          <button class="mark-btn paid-btn ${paid ? "paid" : ""}" type="button" data-g-paid aria-pressed="${paid}">${paid ? "✓ Оплачено" : "Оплачено?"}</button>
        </div>` : ""}
        <div class="g-actions">${c.status === "planned" ? '<button class="link-btn" type="button" data-g-skip>не придёт — отменить для этого ученика</button>'
        : c.status === "cancelled" ? '<button class="link-btn" type="button" data-g-back>вернуть в занятие</button>' : ""}</div>
      </div>`;
  };
  const hwAll = [];
  live.forEach(c => (c.homework || []).forEach(h => { if (!hwAll.some(x => x.url === h.url)) hwAll.push(Object.assign({ who: h.by && h.by !== "teacher" ? shortName(c.studentId) : "" }, h)); }));
  const call = callLinkFor(main);
  const scopeHtml = inSeries ? `<div class="field"><span>Применить к</span>
        <select id="mScope"><option value="one">только этому занятию</option><option value="following">этому и всем следующим в серии</option></select></div>` : "";
  openModal(`
      <h2>${escHtml(groupLabel(gid))}</h2>
      <div class="meta">${escHtml(fmtWhen(main.startMs, main.endMs))} · <span class="status-pill ${escHtml(status)}">${STATUS_RU[status] || escHtml(status)}</span>${inSeries ? " · серия" : ""} · групповое</div>
      <div class="section">
        <div class="section-title">Участники</div>
        <div id="gMembers">${live.map(memberRow).join("")}</div>
        <div class="hint hint-help">«Провёл» и «Оплачено» — у каждого свои; «Провёл» идёт в пакет этого ученика. Сумма — по групповой цене из карточки ученика (не задана — обычная ставка).</div>
        <div class="btn-row" style="margin:6px 0 0"><button class="btn secondary" type="button" id="gMembersEdit">Состав группы…</button></div>
      </div>
      ${status === "planned" ? `<div class="section">
        <div class="section-title">Изменить (для всей группы)</div>
        ${whenFieldsHtml(main.startMs, Math.round((main.endMs - main.startMs) / 60000))}
        ${scopeHtml}
        <div class="btn-row">
          <button class="btn" type="button" id="gSave">Сохранить</button>
          <button class="btn secondary" type="button" id="gMove">Перенести</button>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn secondary" type="button" id="gCancel">Отменить занятие</button>
          <button class="btn danger" type="button" id="gDelete">Удалить</button>
        </div>
      </div>` : ""}
      <div class="section">
        <div class="section-title">Созвон</div>
        ${call ? `<div class="btn-row" style="margin:0 0 6px"><a class="btn" href="${escHtml(call.url)}" target="_blank" rel="noopener" style="text-decoration:none">Открыть созвон</a></div>
          <div class="hint" style="margin-top:0">${call.own ? "Разовая ссылка — только для этого занятия." : call.group ? "Ссылка группы (в «Составе группы»)." : "Ссылка из профиля ученика."}</div>` : '<div class="hint" style="margin-top:0">Ссылку для всей группы можно указать в «Составе группы».</div>'}
        <div class="field" style="margin-top:8px"><span>Другая ссылка только для этого занятия</span>
          <input type="url" id="gCallUrl" maxlength="500" placeholder="https://…" value="${escHtml(main.callUrl || "")}"></div>
        <div class="btn-row" style="margin:0"><button class="btn secondary" type="button" id="gCallSave">Сохранить для этого занятия</button></div>
      </div>
      <div class="section">
        <div class="section-title">Отчёт по занятию (всем участникам)</div>
        <textarea id="gReport" maxlength="5000" placeholder="Что прошли, как получилось, что повторить…">${escHtml(main.report || "")}</textarea>
        <div class="btn-row" style="margin:8px 0 0"><button class="btn" type="button" id="gSaveReport">Отчёт</button></div>
      </div>
      <div class="section">
        <div class="section-title">Домашнее задание (общее на группу)</div>
        ${hwAll.length ? `<ul class="file-list">${hwAll.map(h => `<li><span><a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(h.name || "файл")}</a>${h.who ? ` <span class="cls">(${escHtml(h.who)}, ${ROLE_RU[h.by] || escHtml(h.by)})</span>` : ""}</span><button class="link-btn" type="button" data-g-hw-remove="${escHtml(h.url)}">убрать</button></li>`).join("")}</ul>` : '<div class="hint" style="margin-top:0">Файлов нет.</div>'}
        ${dropZoneHtml("gHwFile", "Добавить файлы для всей группы")}
        <div class="hint hint-help">Файлы увидят все участники в своих кабинетах. Файлы, загруженные родителем или учеником, видны только тебе и ему.</div>
      </div>
      <div class="section">
        <div class="section-title">Мой календарь</div>
        <button class="btn secondary" type="button" id="gExport">Добавить в календарь (.ics)</button>
      </div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn secondary" type="button" id="mClose">Закрыть</button></div>`);
  if (note) modalMsg(note, "ok");
  wireGroupModal(copies, main);
}

function wireGroupModal(copies, main) {
  modalLessonId = main.id;
  const live = copies.filter(c => c.status !== "rescheduled");
  const byId = Object.fromEntries(copies.map(c => [c.id, c]));
  const scope = () => (mq("#mScope") ? mq("#mScope").value : "one");
  const busy = modalBusy;
  const reopen = async (note, from) => {
    const fresh = await window.TutorFB.getLesson((from || main).id);
    if (fresh) await openGroupModal(fresh, note); else closeModal();
  };
  mq("#mClose").addEventListener("click", closeModal);
  mq("#gMembersEdit").addEventListener("click", () => openGroupEditor(main.groupId, main));
  $("modal").querySelectorAll(".g-member").forEach(row => {
    const c = byId[row.dataset.gid];
    const amount = row.querySelector("[data-g-amount]");
    if (amount) amount.addEventListener("change", (e) => {
      if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
      setOverride(lessonToEv(c), e.target.value);
      renderGroupModal(copies, `Сумма сохранена: ${shortName(c.studentId)}`);
    });
    const mark = row.querySelector("[data-g-mark]");
    if (mark) mark.addEventListener("click", () => {
      const ev = lessonToEv(c);
      toggleMark(ev, marks[c.id]);
      c.status = ev._lesson.status;
      renderGroupModal(copies, `${shortName(c.studentId)}: ${marks[c.id] && marks[c.id].marked ? "проведено" : "отметка снята"}`);
    });
    const paid = row.querySelector("[data-g-paid]");
    if (paid) paid.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const value = !(c.paid && c.paid.value);
      await setPaidByTeacher(c, value);
      await reopen(`${shortName(c.studentId)}: ${value ? "оплачено" : "отметка «оплачено» снята"}`);
    }));
    const skip = row.querySelector("[data-g-skip]");
    if (skip) skip.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      if (!confirm(`Отменить занятие только для ${shortName(c.studentId)}? У остальных оно остаётся.`)) return;
      await setStatusScoped(c, "cancelled", "one", ["planned"]);
      afterLessonsChanged();
      await reopen(`${shortName(c.studentId)}: занятие отменено`);
    }));
    const back = row.querySelector("[data-g-back]");
    if (back) back.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      await setStatusScoped(c, "planned", "one", ["cancelled"]);
      afterLessonsChanged();
      await reopen(`${shortName(c.studentId)}: снова в занятии`, c);
    }));
  });
  if (mq("#gSave")) mq("#gSave").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const when = readWhen();
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    const n = await editGroupScoped(copies.filter(c => c.status !== "rescheduled"), { startMs: when.startMs, durMin: when.durMin, scope: scope() });
    afterLessonsChanged();
    await reopen(n > live.length ? `Сохранено: ${n} копий занятий группы` : "Сохранено");
  }));
  if (mq("#gMove")) mq("#gMove").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const when = readWhen();
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    if (when.startMs === main.startMs && when.durMin * 60000 === main.endMs - main.startMs) { modalMsg("Сначала выбери новые дату или время выше.", "err"); return; }
    const nid = await rescheduleGroup(live, when.startMs, when.startMs + when.durMin * 60000);
    afterLessonsChanged();
    const fresh = nid && await window.TutorFB.getLesson(nid);
    if (fresh) await openGroupModal(fresh, "Перенесено для всей группы"); else closeModal();
  }));
  if (mq("#gCancel")) mq("#gCancel").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const sc = scope();
    if (!confirm(sc === "following" ? "Отменить это и все следующие занятия группы?" : "Отменить занятие для всей группы?")) return;
    const targets = await groupScopeTargets(live, sc, ["planned"]);
    await window.TutorFB.saveLessons(targets.map(x => ({ id: x.id, merge: true, data: { status: "cancelled", updatedAt: Date.now() } })));
    afterLessonsChanged();
    await reopen("Занятие группы отменено");
  }));
  if (mq("#gDelete")) mq("#gDelete").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const sc = scope();
    if (!confirm(sc === "following" ? "Удалить это и все следующие занятия группы насовсем? (Проведённые не удаляются.)" : "Удалить занятие группы насовсем? Если оно просто не состоится — лучше «Отменить».")) return;
    const targets = (await groupScopeTargets(live, sc)).filter(x => x.status !== "done");
    await window.TutorFB.deleteLessons(targets.map(x => x.id));
    closeModal();
    afterLessonsChanged();
  }));
  mq("#gCallSave").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const value = mq("#gCallUrl").value.trim();
    if (!(await saveCallLink(live, value))) return;
    await reopen(value ? "Разовая ссылка сохранена для всей группы" : "Вернули обычную ссылку");
  }));
  // Отчёт — всем участникам: в каждую копию и уведомлением каждому ученику.
  mq("#gSaveReport").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const r = await publishReport(live, main, mq("#gReport").value.trim());
    modalMsg(r.text, r.kind);
  }));
  $("modal").querySelectorAll("[data-g-hw-remove]").forEach(b => b.addEventListener("click", () => busy(b, async () => {
    await removeHwFrom(live.map(c => c.id), b.dataset.gHwRemove);
    await reopen("Файл убран");
  })));
  const zone = $("modal").querySelector('[data-drop="gHwFile"]');
  const upload = (files) => busy(zone, async () => {
    const uploaded = await uploadFilesChecked(files);
    if (!uploaded) return;
    // одна загрузка — ссылка во всех копиях занятия
    const fresh = await groupCopies(main);
    await window.TutorFB.saveLessons(fresh.filter(c => c.status !== "rescheduled")
      .map(c => ({ id: c.id, merge: true, data: { homework: [...(c.homework || []), ...uploaded], updatedAt: Date.now() } })));
    publishViewsSoon();
    await reopen(uploaded.length > 1 ? `Загружено файлов: ${uploaded.length}` : "Файл загружен");
  }).catch(() => {});
  wireDropZone(zone, upload);
  pasteTarget = upload;
  mq("#gExport").addEventListener("click", () => exportIcs(Object.assign({}, main, { title: groupLabel(main.groupId) })));
}

// ---------- состав группы (из окна занятия и из карточки ученика) ----------
function openGroupEditor(gid, backTo) {
  const g = groupsMap()[gid] || { name: "", members: [] };
  const students = studentList();
  openModal(`
      <h2>Состав группы</h2>
      <div class="field"><span>Название группы (необязательно)</span><input type="text" id="geName" maxlength="60" value="${escHtml(g.name || "")}" placeholder="Например: ОГЭ, 9 класс"></div>
      <div class="field"><span>Участники</span></div>
      <div class="ge-list">${students.map(st => `<label class="check"><input type="checkbox" data-ge-member="${escHtml(st.id)}"${(g.members || []).includes(st.id) ? " checked" : ""}> ${escHtml(st.name + (st.surname ? " " + st.surname : "") + ", " + st.cls + " класс")}</label>`).join("")}</div>
      <div class="field" style="margin-top:8px"><span>Ссылка на созвон группы (видна участникам)</span><input type="url" id="geCall" maxlength="500" placeholder="https://…" value="${escHtml(g.callUrl || "")}"></div>
      <div class="hint hint-help">Новый участник получит все будущие занятия группы (с общими файлами ДЗ), убранный — потеряет свои будущие непроведённые. Прошедшие и проведённые занятия не меняются.</div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="geSave">Сохранить состав</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>
      ${groupsMap()[gid] ? '<div class="btn-row" style="margin-top:12px; justify-content:flex-end"><button class="btn danger" type="button" id="geDisband">Распустить группу…</button></div>' : ""}`);
  if (mq("#geDisband")) mq("#geDisband").addEventListener("click", async (e) => {
    const btn = e.currentTarget; // после await у события его уже нет
    if (!confirm(`Распустить ${groupLabel(gid).toLowerCase()}? Будущие непроведённые занятия группы удалятся у всех участников. Прошедшие и проведённые останутся в истории.`)) return;
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
    btn.disabled = true;
    try {
      const now = Date.now();
      const doomed = (await futureGroupLessons(gid, now)).filter(l => l.status !== "done").map(l => l.id);
      await window.TutorFB.deleteLessons(doomed);
      await saveGroup(gid, null);
      closeModal();
      afterLessonsChanged();
      if (activeTab === "students") renderStudentsRoster();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не получилось (нет интернета?). Повтор безопасен.", "err");
    }
  });
  mq("#mClose").addEventListener("click", () => { if (backTo) openLessonModal(backTo.id); else closeModal(); });
  mq("#geSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget; // после await у события его уже нет
    const members = [...$("modal").querySelectorAll("[data-ge-member]")].filter(x => x.checked).map(x => x.dataset.geMember);
    const name = mq("#geName").value.trim().slice(0, 60);
    const callUrl = mq("#geCall").value.trim();
    if (members.length < 1) { modalMsg("Оставь в группе хотя бы одного ученика.", "err"); return; }
    if (callUrl && !safeHref(callUrl)) { modalMsg("Ссылка должна начинаться с https:// (или http://)", "err"); return; }
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
    const removed = (g.members || []).filter(x => !members.includes(x));
    if (removed.length && !confirm(`Убрать из группы: ${removed.map(shortName).join(", ")}? Их будущие непроведённые занятия группы удалятся.`)) return;
    btn.disabled = true;
    try {
      const r = await applyGroupMembers(gid, members);
      await saveGroup(gid, Object.assign({}, g, { name, members, callUrl: callUrl || null, updatedAt: Date.now() }));
      afterLessonsChanged();
      if (activeTab === "students") renderStudentsRoster();
      const parts = [r.added.length ? `добавлены: ${r.added.map(shortName).join(", ")} (занятий: ${r.created})` : "", r.removed.length ? `убраны: ${r.removed.map(shortName).join(", ")} (удалено занятий: ${r.deleted})` : ""].filter(Boolean);
      if (backTo) { const fresh = await window.TutorFB.getLesson(backTo.id); if (fresh) { await openGroupModal(fresh, "Состав сохранён" + (parts.length ? ": " + parts.join("; ") : "")); return; } }
      modalMsg("Состав сохранён" + (parts.length ? ": " + parts.join("; ") : ""), "ok");
      btn.disabled = false;
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?). Повтор безопасен.", "err");
    }
  });
}
