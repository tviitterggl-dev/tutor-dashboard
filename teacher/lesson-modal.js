// Кабинет учителя — окна занятия: общие поля формы (ученик, дата и время,
// длительность), «+ Занятие» (одно / серия), «Личное время», окно занятия
// (статус, сумма и «Оплачено», перенос, отчёт и ДЗ, созвон, .ics).

// ---- формы ----

let lastStudentChoice = "";

function studentSelectHtml(currentBase) {
  const sorted = studentList();
  const values = sorted.map(titleBaseOf);
  const known = values.includes(currentBase);
  const opts = sorted.map((r, i) => {
    const v = values[i];
    const label = `${r.name}${r.surname ? " " + r.surname : ""}, ${r.cls} класс`;
    return `<option value="${escHtml(v)}"${v === currentBase ? " selected" : ""}>${escHtml(label)}</option>`;
  }).join("");
  const otherSel = currentBase && !known ? " selected" : (!currentBase && !sorted.length ? " selected" : "");
  return `
      <div class="field"><span>Ученик</span>
        <select id="mStudent">${currentBase ? "" : '<option value="" selected>— выбери —</option>'}${opts}<option value="__other"${otherSel}>Другое (своё название)…</option></select>
      </div>
      <div class="field" id="mCustomWrap" style="display:${currentBase && !known || !sorted.length ? "flex" : "none"}"><span>Название</span>
        <input type="text" id="mCustom" maxlength="120" placeholder="Например: Пробное занятие Авито" value="${currentBase && !known ? escHtml(currentBase) : ""}">
      </div>`;
}
function wireStudentSelect() {
  const sel = mq("#mStudent");
  sel.addEventListener("change", () => { mq("#mCustomWrap").style.display = sel.value === "__other" ? "flex" : "none"; });
}
function readStudentBase() {
  const v = mq("#mStudent").value;
  if (v === "__other") return mq("#mCustom").value.trim();
  return v;
}
function durationSelectHtml(minutes, longer) {
  const opts = longer ? [30, 45, 60, 90, 120, 180, 240, 360, 480] : [30, 45, 60, 90, 120];
  if (!opts.includes(minutes)) opts.push(minutes);
  return `<select id="mDur">${opts.sort((a, b) => a - b).map(m => `<option value="${m}"${m === minutes ? " selected" : ""}>${m} мин</option>`).join("")}</select>`;
}
function whenFieldsHtml(startMs, durMin, longer) {
  const d = new Date(startMs);
  return `<div class="field-row">
        <div class="field"><span>Дата</span><input type="date" id="mDate" value="${toDateInputValue(d)}"></div>
        <div class="field"><span>Начало</span><input type="time" id="mTime" step="300" value="${hhmm(d)}"></div>
        <div class="field"><span>Длительность</span>${durationSelectHtml(durMin, longer)}</div>
      </div>`;
}
function readWhen() {
  const date = mq("#mDate").value, time = mq("#mTime").value;
  const startMs = new Date(`${date}T${time}:00`).getTime();
  const durMin = parseInt(mq("#mDur").value, 10);
  return { startMs, durMin, ok: !!date && !!time && !Number.isNaN(startMs) && durMin > 0 };
}

function openCreateModal(start, end) {
  let startMs = start ? start.getTime() : null;
  if (startMs == null) {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    startMs = d.getTime();
  }
  let durMin = end ? Math.round((end.getTime() - startMs) / 60000) : 60;
  if (durMin <= 30) durMin = 60;
  openModal(`
      <h2>Новое занятие</h2>
      <div class="btn-row" style="margin:0 0 10px"><button class="btn secondary" type="button" id="mToPersonal">Это не занятие — отметить «Личное время»</button></div>
      <label class="check"><input type="checkbox" id="mGroup"> Группа — несколько учеников на одно занятие</label>
      <div id="mOneStudent">${studentSelectHtml(lastStudentChoice)}</div>
      <div id="mGroupBox" style="display:none">
        <div class="field"><span>Название группы (необязательно)</span><input type="text" id="mGroupName" maxlength="60" placeholder="Например: ОГЭ, 9 класс"></div>
        <div class="field"><span>Ученики</span></div>
        <div class="ge-list" id="mMembers">${studentList().map(st => `<label class="check"><input type="checkbox" data-member="${escHtml(st.id)}"> ${escHtml(st.name + (st.surname ? " " + st.surname : "") + ", " + st.cls + " класс")}</label>`).join("") || '<div class="hint">Сначала добавь учеников во вкладке «Ученики».</div>'}</div>
        <div class="hint">У каждого ученика будет своё «Провёл» (идёт в его пакет), своя групповая цена и своё «Оплачено»; файлы ДЗ — общие.</div>
      </div>
      ${whenFieldsHtml(startMs, durMin)}
      <div id="mSlots"></div>
      <div class="btn-row" style="margin:0 0 8px"><button class="link-btn" type="button" id="mAddSlot">+ ещё день и время</button></div>
      <label class="check"><input type="checkbox" id="mRepeat"> Повторять каждую неделю</label>
      <div class="field-row" id="mRepeatRow" style="display:none">
        <div class="field"><span>Сколько занятий в серии</span><input type="number" id="mCount" min="2" max="104" value="8"></div>
      </div>
      <div class="hint" id="mSlotsHint" style="display:none"></div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="mCreate">Создать</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>`);
  wireStudentSelect();
  mq("#mGroup").addEventListener("change", () => {
    const on = mq("#mGroup").checked;
    mq("#mOneStudent").style.display = on ? "none" : "block";
    mq("#mGroupBox").style.display = on ? "block" : "none";
  });
  mq("#mToPersonal").addEventListener("click", () => {
    const w = readWhen();
    openPersonalModal(w.ok ? new Date(w.startMs) : start, w.ok ? new Date(w.startMs + w.durMin * 60000) : end);
  });
  // дополнительные «день недели + время»
  const readSlots = () => [...mq("#mSlots").querySelectorAll(".slot-row")].map(r => ({ wd: Number(r.querySelector("[data-slot-wd]").value), time: r.querySelector("[data-slot-time]").value }));
  const readCount = () => (mq("#mRepeat").checked ? Math.min(104, Math.max(2, parseInt(mq("#mCount").value, 10) || 2)) : 1);
  const updateSlotsHint = () => {
    const hint = mq("#mSlotsHint");
    const when = readWhen();
    const slots = readSlots();
    if (!slots.length || !when.ok) { hint.style.display = "none"; return; }
    const repeat = mq("#mRepeat").checked;
    const plan = planSlots({ startMs: when.startMs, count: readCount(), repeat, slots });
    const days = slotStarts(when.startMs, slots).sort((a, b) => ((a.wd + 6) % 7) - ((b.wd + 6) % 7) || a.time.localeCompare(b.time)).map(x => `${WD_SHORT[x.wd]} ${x.time}`).join(", ");
    const n = plan.length;
    const word = n % 10 === 1 && n % 100 !== 11 ? "занятие" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "занятия" : "занятий");
    const d = (ms) => `${p2(new Date(ms).getDate())}.${p2(new Date(ms).getMonth() + 1)}`;
    hint.textContent = `Будет ${n} ${word}: ${days}${repeat ? " каждую неделю" : ""} — с ${d(plan[0].ms)} по ${d(plan[n - 1].ms)}.`;
    hint.style.display = "block";
  };
  const addSlot = () => {
    const w = readWhen();
    const base = w.ok ? new Date(w.startMs) : new Date(startMs);
    const wd = (base.getDay() + 2) % 7;
    const row = document.createElement("div");
    row.className = "field-row slot-row";
    row.innerHTML = `<div class="field"><span>Ещё день</span><select data-slot-wd>${[1, 2, 3, 4, 5, 6, 0].map(i => `<option value="${i}"${i === wd ? " selected" : ""}>${WEEKDAYS_RU[(i + 6) % 7]}</option>`).join("")}</select></div>
        <div class="field"><span>Начало</span><input type="time" step="300" data-slot-time value="${hhmm(base)}"></div>
        <button class="link-btn" type="button" data-slot-remove aria-label="Убрать этот день">убрать</button>`;
    mq("#mSlots").appendChild(row);
    updateSlotsHint();
  };
  mq("#mAddSlot").addEventListener("click", addSlot);
  mq("#mSlots").addEventListener("click", (e) => { const b = e.target.closest("[data-slot-remove]"); if (b) { b.closest(".slot-row").remove(); updateSlotsHint(); } });
  ["#mSlots", "#mDate", "#mTime", "#mCount", "#mRepeat"].forEach(sel => { mq(sel).addEventListener("input", updateSlotsHint); mq(sel).addEventListener("change", updateSlotsHint); });
  mq("#mRepeat").addEventListener("change", () => { mq("#mRepeatRow").style.display = mq("#mRepeat").checked ? "flex" : "none"; });
  mq("#mClose").addEventListener("click", closeModal);
  mq("#mCreate").addEventListener("click", async () => {
    const group = mq("#mGroup").checked;
    const members = group ? [...mq("#mMembers").querySelectorAll("[data-member]")].filter(x => x.checked).map(x => x.dataset.member) : [];
    const base = group ? titleOfStudent(members[0] || "") : readStudentBase();
    const when = readWhen();
    if (group && members.length < 2) { modalMsg("Для группы отметь хотя бы двух учеников.", "err"); return; }
    if (!base) { modalMsg("Выбери ученика или впиши название.", "err"); return; }
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    const slots = readSlots();
    if (slots.some(sl => !sl.time)) { modalMsg("Укажи время у каждого дня.", "err"); return; }
    const count = readCount();
    const items = slots.length
      ? buildMultiSeries({ base, startMs: when.startMs, durMin: when.durMin, count, repeat: mq("#mRepeat").checked, slots })
      : buildSeries({ base, startMs: when.startMs, durMin: when.durMin, count });
    const btn = mq("#mCreate");
    btn.disabled = true;
    try {
      const conflicts = await findConflicts(items);
      if (conflicts.length) {
        const list = conflicts.slice(0, 4).map(x => `• ${x.title}, ${fmtWhen(x.startMs, x.endMs)}`).join("\n");
        const more = conflicts.length > 4 ? `\n…и ещё ${conflicts.length - 4}` : "";
        if (!confirm(`Пересекается с другими занятиями:\n${list}${more}\n\nВсё равно создать?`)) { btn.disabled = false; return; }
      }
      if (group) {
        // группа: сначала сама группа (состав), потом копии занятий на каждого
        const gid = newId("grp");
        await saveGroup(gid, { name: mq("#mGroupName").value.trim().slice(0, 60), members, callUrl: null, createdAt: Date.now(), updatedAt: Date.now() });
        await window.TutorFB.saveLessons(buildGroupItems(items, gid, members));
        closeModal();
        afterLessonsChanged();
        return;
      }
      await window.TutorFB.saveLessons(items);
      lastStudentChoice = mq("#mStudent").value === "__other" ? "" : base;
      closeModal();
      afterLessonsChanged();
    } catch (e) {
      btn.disabled = false;
      modalMsg("Не удалось сохранить (нет интернета?). Попробуй ещё раз.", "err");
      console.error(e);
    }
  });
}

// ---- «Личное время»: занято без ученика, комментарий видит только учитель ----
function openPersonalModal(start, end, block) {
  const editing = !!block;
  let startMs = editing ? block.startMs : (start ? start.getTime() : null);
  if (startMs == null) { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); startMs = d.getTime(); }
  let durMin = editing ? Math.round((block.endMs - block.startMs) / 60000) : (end ? Math.round((end.getTime() - startMs) / 60000) : 60);
  if (!editing && durMin <= 30) durMin = 60;
  const inSeries = editing && !!block.recurrenceId;
  openModal(`
      <h2>${editing ? "Личное время" : "Отметить «Личное время»"}</h2>
      <div class="meta">Время станет занятым. Родители и ученики увидят просто «занято» — без пометки, что это личное, и без комментария.</div>
      ${whenFieldsHtml(startMs, durMin, true)}
      <div class="field"><span>Комментарий (только для тебя)</span><input type="text" id="mNote" maxlength="200" placeholder="Например: врач, дорога" value="${editing ? escHtml(block.note || "") : ""}"></div>
      ${editing ? (inSeries ? `<div class="field"><span>Применить к</span><select id="mScope"><option value="one">только этому блоку</option><option value="following">этому и всем следующим</option></select></div>` : "") : `
      <label class="check"><input type="checkbox" id="mRepeat"> Повторять каждую неделю</label>
      <div class="field-row" id="mRepeatRow" style="display:none">
        <div class="field"><span>Сколько недель</span><input type="number" id="mCount" min="2" max="104" value="8"></div>
      </div>`}
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="mPersonalSave">${editing ? "Сохранить" : "Отметить занятым"}</button>
        ${editing ? '<button class="btn danger" type="button" id="mPersonalDelete">Удалить</button>' : ""}
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>`);
  mq("#mClose").addEventListener("click", closeModal);
  if (mq("#mRepeat")) mq("#mRepeat").addEventListener("change", () => { mq("#mRepeatRow").style.display = mq("#mRepeat").checked ? "flex" : "none"; });
  const scope = () => (mq("#mScope") ? mq("#mScope").value : "one");
  mq("#mPersonalSave").addEventListener("click", async (e) => {
    const when = readWhen();
    const note = mq("#mNote").value.trim();
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    const btn = e.currentTarget; // после await у события его уже нет
    btn.disabled = true;
    try {
      if (editing) {
        const delta = when.startMs - block.startMs;
        const targets = scope() === "following" ? await scopeTargets(block, "following") : [block];
        await window.TutorFB.saveLessons(targets.map(x => {
          const s = x.startMs + delta;
          return { id: x.id, merge: true, data: lessonData({ title: "Личное время", startMs: s, endMs: s + when.durMin * 60000, status: "planned", recurrenceId: x.recurrenceId, source: "app", extra: { kind: "personal", note } }) };
        }));
      } else {
        const count = mq("#mRepeat").checked ? Math.min(104, Math.max(2, parseInt(mq("#mCount").value, 10) || 2)) : 1;
        const items = buildSeries({ base: "Личное время", startMs: when.startMs, durMin: when.durMin, count, pkg: null });
        items.forEach(it => Object.assign(it.data, { kind: "personal", note, studentId: null }));
        const conflicts = (await findConflicts(items)).filter(x => !isPersonal(x));
        if (conflicts.length && !confirm(`В это время уже есть занятия:\n${conflicts.slice(0, 4).map(x => `• ${x.title}, ${fmtWhen(x.startMs, x.endMs)}`).join("\n")}\n\nВсё равно отметить личное время?`)) {
          btn.disabled = false;
          return;
        }
        await window.TutorFB.saveLessons(items);
      }
      closeModal();
      afterLessonsChanged();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg("Не удалось сохранить (нет интернета?). Попробуй ещё раз.", "err");
    }
  });
  if (mq("#mPersonalDelete")) {
    mq("#mPersonalDelete").addEventListener("click", async (e) => {
      const sc = scope();
      if (!confirm(sc === "following" ? "Удалить этот и все следующие блоки личного времени?" : "Удалить этот блок личного времени?")) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await deleteScoped(block, sc);
        closeModal();
        afterLessonsChanged();
      } catch (err) {
        btn.disabled = false;
        modalMsg("Не удалось удалить (нет интернета?).", "err");
      }
    });
  }
}

async function openLessonModal(id) {
  let l;
  try {
    l = await window.TutorFB.getLesson(id);
  } catch (e) {
    alert("Не удалось открыть занятие (нет интернета?).");
    return;
  }
  if (!l) { alert("Занятие не найдено — возможно, его удалили на другом устройстве."); afterLessonsChanged(); return; }
  showLessonModal(l);
}
function showLessonModal(l) {
  if (isPersonal(l)) { openPersonalModal(null, null, l); return; }
  if (isGroupCopy(l)) { openGroupModal(l); return; }
  renderLessonModal(l);
}

// ---- занятие из пуш-уведомления ----
// Пуш учителю (оплата, пояснение, ДЗ) ведёт на index.html?lesson=<id>.
// Кабинет закрыт — открывается по этой ссылке; уже открыт — sw.js не
// открывает новую вкладку, а шлёт ей { type: "open-lesson", lessonId }.
// Окно показываем, только когда кабинет загружен (lessonLinkReady из
// afterAuth). Занятия нет (удалено) — просто кабинет, без сообщений;
// перенесено — открываем новое время.
let linkLessonReady = false;
let linkLessonPending = (() => {
  const u = new URL(location.href);
  const id = u.searchParams.get("lesson");
  if (!id) return null;
  u.searchParams.delete("lesson"); // обновление страницы не должно открывать окно снова
  try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* не страшно */ }
  return id;
})();
function lessonLinkReady() {
  linkLessonReady = true;
  const id = linkLessonPending;
  linkLessonPending = null;
  if (id) openLessonFromLink(id);
}
// в открытом окне что-то набрано и не сохранено?
function modalDirty() {
  if (!modalOpen()) return false;
  return [...$("modal").querySelectorAll("input, textarea, select")].some(el =>
    el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
      : el.tagName === "SELECT" ? [...el.options].some(o => o.selected !== o.defaultSelected)
        : el.type !== "file" && el.value !== el.defaultValue);
}
async function openLessonFromLink(id) {
  if (typeof id !== "string" || !id || id.length > 200) return;
  if (!linkLessonReady) { linkLessonPending = id; return; }
  let l = null;
  try {
    l = await window.TutorFB.getLesson(id);
    // перенесённое — к новому времени (цепочка переносов короткая)
    for (let i = 0; i < 5 && l && l.status === "rescheduled" && l.rescheduledTo; i++) {
      const next = await window.TutorFB.getLesson(l.rescheduledTo);
      if (!next) break;
      l = next;
    }
  } catch (e) {
    return; // нет сети — остаётся открытый кабинет
  }
  if (!l) return;
  if (modalDirty() && !confirm("Открыть занятие из уведомления? Несохранённое в открытом окне пропадёт.")) return;
  showLessonModal(l);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-lesson") openLessonFromLink(e.data.lessonId);
  });
  try { navigator.serviceWorker.startMessages(); } catch (e) { /* старый браузер — сообщения и так идут */ }
}

function renderLessonModal(l, note) {
  const inSeries = !!l.recurrenceId;
  const mark = marks[l.id] || { marked: false, overrideAmount: null, lockedRate: null };
  const ev = lessonToEv(l);
  const amount = effectiveAmountFor(ev, mark);
  const baseRate = mark.marked && mark.lockedRate != null ? mark.lockedRate : rateFor(ev);
  const canMark = amount != null && !Number.isNaN(amount);
  const isPlanned = l.status === "planned";
  const scopeHtml = inSeries ? `
      <div class="field"><span>Применить к</span>
        <select id="mScope"><option value="one">только этому занятию</option><option value="following">этому и всем следующим в серии</option></select>
      </div>` : "";
  const history = [
    l.rescheduledFrom ? `<div class="hint">Перенесено с другой даты. <button class="link-btn" type="button" data-open="${escHtml(l.rescheduledFrom)}">открыть исходное</button></div>` : "",
    l.rescheduledTo ? `<div class="hint">Перенесено. <button class="link-btn" type="button" data-open="${escHtml(l.rescheduledTo)}">открыть новое занятие</button></div>` : "",
  ].join("");

  const payHtml = (l.status === "planned" || l.status === "done") ? `
      <div class="section">
        <div class="section-title">Оплата</div>
        <div class="lesson-bottom">
          <div class="rate-field">₽ <input type="number" inputmode="decimal" id="mAmount" placeholder="${baseRate != null ? baseRate : "сумма"}" value="${mark.overrideAmount != null ? mark.overrideAmount : ""}"></div>
          <button class="mark-btn ${mark.marked ? "done" : ""}" type="button" id="mMark" ${canMark ? "" : "disabled"}>${mark.marked ? "✓ Провёл (снять)" : "Провёл занятие"}</button>
        </div>
        ${canMark ? "" : '<div class="hint">Ставка не найдена — впиши сумму, тогда можно отметить.</div>'}
        <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap">
          <button class="mark-btn paid-btn ${l.paid && l.paid.value ? "paid" : ""}" type="button" id="mPaid" aria-pressed="${l.paid && l.paid.value ? "true" : "false"}">${l.paid && l.paid.value ? "✓ Оплачено (снять)" : "Отметить оплату"}</button>
          ${l.paid && l.paid.value && l.paid.by === "parent" ? `<span class="cls">отметил родитель ${escHtml(new Date(l.paid.at).toLocaleDateString("ru-RU"))}</span>` : ""}
        </div>
        <div class="hint" style="margin-top:0">Просто отметка для себя и родителя — родитель видит и может ставить её в своём кабинете.</div>
      </div>` : "";

  const editHtml = isPlanned ? `
      <div class="section">
        <div class="section-title">Изменить</div>
        ${studentSelectHtml(baseTitle(l.title))}
        ${whenFieldsHtml(l.startMs, Math.round((l.endMs - l.startMs) / 60000))}
        ${scopeHtml}
        <div class="btn-row">
          <button class="btn" type="button" id="mSave">Сохранить</button>
          <button class="btn secondary" type="button" id="mMove">Перенести</button>
        </div>
        <div class="hint">«Сохранить» — просто исправить. «Перенести» — сдвинуть на новые дату/время и оставить в истории отметку «перенесено» (её видят родители).</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn secondary" type="button" id="mCancelLesson">Отменить занятие</button>
          <button class="btn danger" type="button" id="mDelete">Удалить</button>
        </div>
      </div>` : `
      <div class="section">
        ${scopeHtml}
        <div class="btn-row">
          ${l.status === "cancelled" ? '<button class="btn secondary" type="button" id="mRestore">Вернуть занятие</button>' : ""}
          ${l.status !== "done" ? '<button class="btn danger" type="button" id="mDelete">Удалить</button>' : '<div class="hint">Проведённое занятие нельзя удалить — сначала сними отметку «Провёл».</div>'}
        </div>
      </div>`;

  const hw = Array.isArray(l.homework) ? l.homework : [];
  const hwHtml = `
      <div class="section">
        <div class="section-title">Домашнее задание (файлы)</div>
        ${hw.length ? `<ul class="file-list">${hw.map((h, i) => `<li><span><a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(h.name || "файл")}</a>${h.by && h.by !== "teacher" ? ` <span class="cls">(${ROLE_RU[h.by] || escHtml(h.by)})</span>` : ""}</span><button class="link-btn" type="button" data-hw-remove="${i}">убрать</button></li>`).join("")}</ul>` : '<div class="hint" style="margin-top:0">Файлов нет.</div>'}
        ${dropZoneHtml("mHwFile", "Добавить файлы к этому занятию")}
        <div class="hint">Фото, PDF, документы — до 10 МБ каждый. Хранятся в Cloudinary. Родитель и ученик видят эти файлы в своих кабинетах и могут добавлять свои (они появятся здесь с пометкой).</div>
      </div>`;

  // ДЗ к следующему занятию этого же ученика (studentId учитывает фамилию —
  // у тёзок «Маша, 7 класс» и «Маша Иванова, 7 класс» разные занятия).
  const nextHwHtml = l.studentId && !isPersonal(l) ? `
      <div class="section" id="mNextHw">
        <div class="section-title">ДЗ к следующему занятию</div>
        <div class="hint" style="margin-top:0">Ищу следующее занятие ученика…</div>
      </div>` : "";

  const call = callLinkFor(l);
  const prof = profileOf(l.studentId);
  // доска и материалы — из профиля ученика, независимо от того, есть ли ссылка на созвон
  const board = l.studentId && prof.accessUrl && safeHref(prof.accessUrl) ? prof.accessUrl : null;
  const mats = materialsOf(l.studentId);
  const boardMatsHtml = (board ? `<div class="btn-row" style="margin:6px 0 0"><a class="btn secondary" id="mBoardOpen" href="${escHtml(board)}" target="_blank" rel="noopener" style="text-decoration:none">Доска</a></div>` : "")
    + (mats.length ? `<div class="hint" style="margin:10px 0 0">Материалы (${mats.length}):</div>${Materials.linksHtml(mats)}` : "");
  const callHtml = `
      <div class="section">
        <div class="section-title">${board || mats.length ? "Созвон, доска и материалы" : "Созвон"}</div>
        ${call ? `<div class="btn-row" style="margin:0 0 6px"><a class="btn" id="mCallOpen" href="${escHtml(call.url)}" target="_blank" rel="noopener" style="text-decoration:none">Открыть созвон</a></div>
          <div class="hint" id="mCallSrc" style="margin-top:0">${call.own ? "Разовая ссылка — только для этого занятия." : "Обычная ссылка из профиля ученика (вкладка «Ученики»)."}</div>`
      : `<div class="hint" style="margin-top:0">${l.studentId ? "У ученика не указана ссылка на созвон — её можно добавить во вкладке «Ученики»." : "Занятие не привязано к ученику — ссылку можно указать только для него ниже."}</div>`}
        ${boardMatsHtml}
        <div class="field" style="margin-top:12px"><span>Другая ссылка на созвон только для этого занятия</span>
          <input type="url" id="mCallUrl" maxlength="500" placeholder="https://…" value="${escHtml(l.callUrl || "")}"></div>
        <div class="btn-row" style="margin:0">
          <button class="btn secondary" type="button" id="mCallSave">Сохранить для этого занятия</button>
          ${l.callUrl ? '<button class="btn secondary" type="button" id="mCallReset">Вернуть обычную</button>' : ""}
        </div>
      </div>`;

  const exportHtml = `
      <div class="section">
        <div class="section-title">Мой календарь</div>
        <button class="btn secondary" type="button" id="mExport">Добавить в календарь (.ics)</button>
        <div class="hint">Скачается файл события — телефон или компьютер предложит добавить его в твой календарь (Google, Apple, Outlook), с напоминанием за 30 минут. Без входа в аккаунты. Каждое нажатие — новое событие; изменения занятия туда сами не попадут.</div>
      </div>`;

  openModal(`
      <h2>${escHtml(displayTitle(l.title))}</h2>
      <div class="meta">${escHtml(fmtWhen(l.startMs, l.endMs))} · <span class="status-pill ${escHtml(l.status)}">${STATUS_RU[l.status] || escHtml(l.status)}</span>${inSeries ? " · серия" : ""}</div>
      ${history}
      ${l.familyNote && l.familyNote.text ? `<div class="section"><div class="section-title">Пояснение от ${({ parent: "родителя", student: "ученика" })[l.familyNote.by] || "родителя/ученика"}</div>
        <div class="family-note">${escHtml(l.familyNote.text)}</div>
        ${l.familyNote.at ? `<div class="hint" style="margin-top:6px">${escHtml(new Date(l.familyNote.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</div>` : ""}</div>` : ""}
      ${callHtml}
      ${payHtml}
      ${editHtml}
      <div class="section">
        <div class="section-title">Отчёт по занятию</div>
        <textarea id="mReport" maxlength="5000" placeholder="Что прошли, как получилось, что повторить…">${escHtml(l.report || "")}</textarea>
        <div class="btn-row" style="margin:8px 0 0"><button class="btn" type="button" id="mSaveReport">Отчёт</button></div>
      </div>
      ${hwHtml}
      ${nextHwHtml}
      ${exportHtml}
      <div class="msg" id="mMsg"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn secondary" type="button" id="mClose">Закрыть</button></div>`);
  if (note) modalMsg(note, "ok");
  wireLessonModal(l);
}

function wireLessonModal(l) {
  modalLessonId = l.id;
  const scope = () => (mq("#mScope") ? mq("#mScope").value : "one");
  const busy = modalBusy;
  const reopen = async (note) => {
    const fresh = await window.TutorFB.getLesson(l.id);
    if (fresh) renderLessonModal(fresh, note); else closeModal();
  };

  mq("#mClose").addEventListener("click", closeModal);
  $("modal").querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => openLessonModal(b.dataset.open)));
  if (mq("#mStudent")) wireStudentSelect();

  if (mq("#mAmount")) {
    mq("#mAmount").addEventListener("change", (e) => {
      if (!navigator.onLine) { renderLessonModal(l); modalMsg(OFFLINE_TEXT, "err"); return; }
      setOverride(lessonToEv(l), e.target.value);
      renderLessonModal(l, "Сумма сохранена");
    });
  }
  if (mq("#mMark")) {
    mq("#mMark").addEventListener("click", () => {
      const ev = lessonToEv(l);
      toggleMark(ev, marks[l.id]);
      l.status = ev._lesson.status;
      renderLessonModal(l, marks[l.id] && marks[l.id].marked ? "Отмечено: проведено" : "Отметка снята");
    });
  }
  const saveCall = (value) => busy(null, async () => {
    if (await saveCallLink([l], value)) await reopen(value ? "Разовая ссылка сохранена" : "Вернули обычную ссылку ученика");
  });
  mq("#mCallSave").addEventListener("click", () => saveCall(mq("#mCallUrl").value.trim()));
  if (mq("#mCallReset")) mq("#mCallReset").addEventListener("click", () => saveCall(""));
  if (mq("#mPaid")) {
    mq("#mPaid").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const value = !(l.paid && l.paid.value);
      await setPaidByTeacher(l, value);
      await reopen(value ? "Отмечено: оплачено" : "Отметка «оплачено» снята");
    }));
  }
  if (mq("#mSave")) {
    mq("#mSave").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const base = readStudentBase();
      const when = readWhen();
      if (!base) { modalMsg("Выбери ученика или впиши название.", "err"); return; }
      if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
      const n = await editScoped(l, { base, startMs: when.startMs, durMin: when.durMin, scope: scope() });
      afterLessonsChanged();
      await reopen(n > 1 ? `Сохранено для ${n} занятий` : "Сохранено");
    }));
  }
  if (mq("#mMove")) {
    mq("#mMove").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const when = readWhen();
      if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
      if (when.startMs === l.startMs && when.durMin * 60000 === l.endMs - l.startMs) { modalMsg("Сначала выбери новые дату или время выше.", "err"); return; }
      const nid = await rescheduleLesson(l, when.startMs, when.startMs + when.durMin * 60000);
      afterLessonsChanged();
      const fresh = await window.TutorFB.getLesson(nid);
      renderLessonModal(fresh, "Перенесено");
    }));
  }
  if (mq("#mCancelLesson")) {
    mq("#mCancelLesson").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const sc = scope();
      if (!confirm(sc === "following" ? "Отменить это и все следующие занятия серии?" : "Отменить это занятие?")) return;
      const n = await setStatusScoped(l, "cancelled", sc, ["planned"]);
      afterLessonsChanged();
      await reopen(n > 1 ? `Отменено занятий: ${n}` : "Занятие отменено");
    }));
  }
  if (mq("#mRestore")) {
    mq("#mRestore").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      if (l.makeup && scope() === "one") {
        const note = await restoreWithMakeup(l);
        afterLessonsChanged();
        await reopen("Занятие снова в расписании." + note);
        return;
      }
      const n = await setStatusScoped(l, "planned", scope(), ["cancelled"]);
      afterLessonsChanged();
      await reopen(n > 1 ? `Возвращено занятий: ${n}` : "Занятие снова в расписании");
    }));
  }
  if (mq("#mDelete")) {
    mq("#mDelete").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const sc = scope();
      if (!confirm(sc === "following" ? "Удалить это и все следующие занятия серии насовсем? (Проведённые не удаляются.)" : "Удалить занятие насовсем? Если оно просто не состоится — лучше «Отменить», тогда оно останется в истории.")) return;
      await deleteScoped(l, sc);
      closeModal();
      afterLessonsChanged();
    }));
  }
  mq("#mSaveReport").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const r = await publishReport([l], l, mq("#mReport").value.trim());
    modalMsg(r.text, r.kind);
  }));
  $("modal").querySelectorAll("[data-hw-remove]").forEach(b => b.addEventListener("click", () => busy(b, async () => {
    const i = parseInt(b.dataset.hwRemove, 10);
    const hw = (l.homework || []).filter((_, j) => j !== i);
    await window.TutorFB.updateLesson(l.id, { homework: hw, updatedAt: Date.now() });
    publishViewsSoon();
    await reopen("Файл убран из занятия");
  })));
  const hwZone = $("modal").querySelector('[data-drop="mHwFile"]');
  const uploadHere = (files) => busy(hwZone, async () => {
    const n = await uploadHwTo(l.id, files);
    if (n) await reopen(n > 1 ? `Загружено файлов: ${n}` : "Файл загружен");
  }).catch(() => {});
  wireDropZone(hwZone, uploadHere);
  pasteTarget = uploadHere; // Ctrl+V со скриншотом — в это занятие (или в выбранную зону)
  hwZone.addEventListener("focusin", () => { pasteTarget = uploadHere; });
  if (mq("#mNextHw")) renderNextHw(l, busy);
  mq("#mExport").addEventListener("click", () => exportIcs(l));
}
