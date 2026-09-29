"use strict";
// Кабинет семьи — окно занятия: кнопка «Оплачено» (родитель), карточка
// занятия (ссылки, ДЗ, отчёт, пояснение), перенос и отмена — заявкой.

// ---------- «Оплачено» (родитель): кнопка-переключатель ----------
let thanksFor = null; // занятие, у которого только что отметили оплату
async function togglePaid(l) {
  const value = !paidOf(l);
  await addItem(view.parentChannel, { type: "paid", lessonId: l.id, by: "parent", createdAt: Date.now(), paid: value });
  // сразу показываем новое состояние, не дожидаясь ответа базы
  parentItems = parentItems.concat([{ id: "local-" + Date.now(), type: "paid", lessonId: l.id, by: "parent", createdAt: Date.now(), paid: value }]);
  thanksFor = value ? l.id : null;
  if (value) setTimeout(() => { if (thanksFor === l.id) { thanksFor = null; if (view) renderLessonsPane(Date.now()); } }, 8000);
  return value;
}
const canPay = (l) => current && current.role === "parent" && view && view.parentChannel && (l.status === "planned" || l.status === "done");
function paidButton(l, id) {
  const paid = paidOf(l);
  return `<button class="mark-btn paid-btn ${paid ? "paid" : ""}" type="button" ${id ? `id="${id}"` : `data-paid="${esc(l.id)}"`} aria-pressed="${paid ? "true" : "false"}">${paid ? "✓ Оплачено (снять)" : "Оплачено"}</button>`;
}

let modalNote = null;
function openLessonModal(id) {
  openLessonId = id;
  modalNote = null;
  refreshModal(true);
}

// Перерисовка окна при живых обновлениях — не трогаем, если человек
// сейчас что-то вводит (формы переноса/отмены).
function refreshModal(force) {
  if (!force && mq("#reqForm") && mq("#reqForm").style.display !== "none") return;
  if (!force && mq("#mNote") && (document.activeElement === mq("#mNote") || mq("#mNote").value !== mq("#mNote").defaultValue)) return;
  const l = lessonById(openLessonId);
  if (!l) { closeModal(); return; }
  const now = Date.now();
  const req = pendingFor(l.id);
  const files = homeworkOf(l);
  const paid = paidOf(l);

  let reqHtml = "";
  if (req) {
    reqHtml = `<div class="section"><div class="section-title">Заявка</div>
        <div>${req.type === "reschedule" ? `Вы попросили перенести на <b>${esc(fmtWhen(req.newStartMs, req.newEndMs))}</b>.` : "Вы попросили отменить это занятие."} Ждём ответа преподавателя.</div></div>`;
  } else if (canRequest(l)) {
    reqHtml = `<div class="section"><div class="section-title">Перенести или отменить</div>
        <div class="btn-row" id="reqButtons" style="margin-top:0">
          <button class="btn" type="button" id="mMove">Перенести…</button>
          <button class="btn danger" type="button" id="mCancel">Отменить…</button>
        </div>
        <div id="reqForm" style="display:none">
          <div id="moveFields" class="field-row">
            <div class="field"><span>Новая дата</span><input type="date" id="mDate" value="${toDateInput(l.startMs)}"></div>
            <div class="field"><span>Время</span><input type="time" id="mTime" step="300" value="${toTimeInput(l.startMs)}"></div>
          </div>
          <div class="field"><span>Комментарий (необязательно)</span><textarea id="mComment" maxlength="500" placeholder="Например: заболели, можно на четверг?"></textarea></div>
          <div class="btn-row">
            <button class="btn" type="button" id="mSend">Отправить заявку</button>
            <button class="btn secondary" type="button" id="mBack">Назад</button>
          </div>
        </div>
        <div class="hint">Расписание изменится только после подтверждения преподавателем.</div>
      </div>`;
  }

  const paidHtml = current.role === "parent" && l.status !== "cancelled" && l.status !== "rescheduled" && view.parentChannel ? `
      <div class="section">${paidButton(l, "mPaid")}
        <div class="hint">Просто отметка — её сразу видит преподаватель. Деньги через сайт не передаются.</div></div>` : "";

  const call = (l.status === "planned" || l.status === "done") ? httpUrl(l.callUrl) : null;
  const board = l.status !== "cancelled" && l.status !== "rescheduled" ? httpUrl(view.boardUrl) : null;
  const callHtml = call || board ? `<div class="section"><div class="section-title">Созвон и доска</div>
        <div class="btn-row" style="margin-top:0">
          ${call ? `<a class="btn" id="mCall" href="${esc(call)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none; display:inline-block">Подключиться к занятию</a>` : ""}
          ${board ? `<a class="btn secondary" id="mBoard" href="${esc(board)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none; display:inline-block">Открыть доску</a>` : ""}
        </div></div>` : "";
  const note = noteOf(l);
  const noteHtml = canNote(l) ? `<div class="section"><div class="section-title">Пояснение к занятию</div>
        <div class="field" style="margin-bottom:0"><textarea id="mNote" maxlength="1000" placeholder="Пожелания, вопросы, что разобрать, ссылки на материалы…">${esc(note ? note.text : "")}</textarea></div>
        <div class="btn-row"><button class="btn secondary" type="button" id="mNoteSave">Сохранить пояснение</button></div>
        <div class="hint">${note && note.text ? `Последняя правка: ${esc(ROLE[note.by] || "—")}${note.at ? ", " + esc(fmtStamp(note.at)) : ""}. ` : ""}Увидят преподаватель и ${current.role === "parent" ? "ученик" : "родитель"}.</div></div>`
    : note && note.text ? `<div class="section"><div class="section-title">Пояснение к занятию</div><div class="report" style="margin-top:0">${esc(note.text)}</div></div>` : "";
  openModal(`
      <h2>${esc(fmtWhen(l.startMs, l.endMs))}</h2>
      <div class="meta">${l.pkg ? `Занятие ${esc(l.pkg)} · ` : ""}${lessonPills(l, now)}</div>
      ${callHtml}
      ${noteHtml}
      ${l.report ? `<div class="section"><div class="section-title">Отчёт преподавателя</div><div class="report" style="margin-top:0">${esc(l.report)}</div></div>` : ""}
      <div class="section"><div class="section-title">Домашнее задание</div>
        ${files.length ? `<ul class="files">${files.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.name || "файл")}</a> <span class="who">(${esc(ROLE[h.by] || ROLE.teacher)})</span></li>`).join("")}</ul>` : '<div class="hint" style="margin-top:0">Файлов пока нет.</div>'}
        ${view.channel ? `<div style="margin-top:10px">${dropZoneHtml("mFile", "Добавить файлы")}</div>
        <div class="hint">Сфотографируйте или приложите выполненное задание (до 10 МБ). Его сразу увидят преподаватель и ${current.role === "parent" ? "ученик" : "родитель"}.</div>` : '<div class="hint">Загрузка файлов и заявки появятся после ближайшего входа преподавателя в свой кабинет.</div>'}
      </div>
      ${paidHtml}
      ${reqHtml}
      <div class="msg" id="mMsg"></div>
      <div class="btn-row"><button class="btn secondary" type="button" id="mClose">Закрыть</button></div>`);
  if (modalNote) msg(modalNote[0], modalNote[1]);
  wireModal(l);
}

function wireModal(l) {
  mq("#mClose").addEventListener("click", closeModal);
  let mode = null;
  if (mq("#mMove")) {
    const showForm = (m) => {
      mode = m;
      mq("#reqButtons").style.display = "none";
      mq("#reqForm").style.display = "block";
      mq("#moveFields").style.display = m === "reschedule" ? "flex" : "none";
      mq("#mSend").textContent = m === "reschedule" ? "Отправить заявку на перенос" : "Отправить заявку на отмену";
    };
    mq("#mMove").addEventListener("click", () => showForm("reschedule"));
    mq("#mCancel").addEventListener("click", () => showForm("cancel"));
    mq("#mBack").addEventListener("click", () => { mode = null; mq("#reqForm").style.display = "none"; mq("#reqButtons").style.display = "flex"; msg(""); });
    mq("#mSend").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const comment = mq("#mComment").value.trim().slice(0, 500);
      const extra = { comment };
      if (mode === "reschedule") {
        const s = new Date(`${mq("#mDate").value}T${mq("#mTime").value}:00`).getTime();
        if (Number.isNaN(s)) { msg("Выберите дату и время.", "err"); return; }
        const e2 = s + (l.endMs - l.startMs);
        if (s === l.startMs) { msg("Выберите другое время.", "err"); return; }
        const problem = slotProblem(l, s, e2);
        if (problem) { msg(problem, "err"); return; }
        extra.newStartMs = s;
        extra.newEndMs = e2;
      }
      btn.disabled = true;
      try {
        await sendRequest(l, mode, extra);
        modalNote = ["Заявка отправлена. Ответ появится здесь и во вкладке «Заявки».", "ok"];
        refreshModal(true);
      } catch (err) {
        btn.disabled = false;
        msg(errText(err, "Не удалось отправить. Проверьте интернет и попробуйте ещё раз."), "err");
      }
    });
  }
  if (mq("#mNoteSave")) {
    mq("#mNoteSave").addEventListener("click", async (e) => {
      const text = mq("#mNote").value.trim().slice(0, 1000);
      const cur = noteOf(l);
      if (text === ((cur && cur.text) || "")) { msg("Изменений нет."); return; }
      e.currentTarget.disabled = true;
      try {
        const item = await addItem(view.channel, { type: "note", lessonId: l.id, by: current.role, createdAt: Date.now(), comment: text });
        // сразу в свой список — не ждём обновления из базы (иначе на
        // мгновение показывалось прежнее пояснение)
        if (!shared.some((i) => i.id === item.id)) shared = shared.concat([item]);
        modalNote = [text ? "Пояснение сохранено — преподаватель его увидит." : "Пояснение убрано.", "ok"];
      } catch (err) {
        modalNote = [errText(err, "Не сохранилось — проверьте интернет."), "err"];
      }
      refreshModal(true);
      renderLessonsPane(Date.now());
    });
  }
  if (mq("#mPaid")) {
    mq("#mPaid").addEventListener("click", async (e) => {
      const value = !paidOf(l);
      e.currentTarget.disabled = true;
      try {
        await togglePaid(l);
        modalNote = [value ? "Благодарю за оплату!" : "Отметка «оплачено» снята", "ok"];
      } catch (err) {
        modalNote = [errText(err, "Не сохранилось — проверьте интернет."), "err"];
      }
      refreshModal(true);
    });
  }
  if (mq("#mFile")) {
    const uploadHere = async (files) => {
      if (!files.length || uploading) return;
      uploading = true;
      try {
        await uploadFiles(l, files, msg);
        uploading = false;
        modalNote = [files.length > 1 ? `Загружено файлов: ${files.length}` : "Файл загружен", "ok"];
        refreshModal(true);
        renderHwPane(Date.now());
      } catch (err) {
        uploading = false;
        msg(errText(err, "Не удалось загрузить. Проверьте интернет."), "err");
      }
    };
    wireDropZone($("modal").querySelector('[data-drop="mFile"]'), uploadHere);
    modalPaste = uploadHere; // Ctrl+V со скриншотом — в это занятие
  }
}
