"use strict";
// Кабинет семьи — заявки и сообщения в канал: запись в канал (addItem),
// проверка времени (slotProblem), понятные тексты ошибок, «Предложить
// время нового занятия» (book), заявки на перенос/отмену (sendRequest).

// ---------- действия ----------
async function addItem(channel, data) {
  requireOnline();
  const clean = {};
  // пустую строку оставляем: пустое «пояснение» = «убрать» (правилам нужен comment-строка)
  Object.entries(data).forEach(([k, v]) => { if (v !== undefined && v !== null) clean[k] = v; });
  const id = newId();
  await setDoc(doc(db, "channels", channel, "items", id), clean);
  return Object.assign({ id }, clean);
}

function slotProblem(l, s, e) {
  if (!(s > Date.now())) return "Выберите время в будущем.";
  if (view.busyTo && e > view.busyTo) return "Так далеко расписание пока не открыто — напишите преподавателю.";
  if ((view.busy || []).some((b) => b.s < e && b.e > s)) return "Это время уже занято — выберите свободное (в календаре оно не серое).";
  if (myLessons().some((x) => (!l || x.id !== l.id) && (x.status === "planned" || x.status === "done") && x.startMs < e && x.endMs > s)) return "В это время уже стоит ваше другое занятие.";
  return "";
}

// База отвечает «нет прав», пока преподаватель не обновил настройки
// доступа (правила Firestore) — объясняем по-человечески.
function errText(err, fallback) {
  if (err && err.offline) return OFFLINE_TEXT;
  if (err && (err.code === "permission-denied" || /insufficient permissions/i.test(err.message || ""))) {
    return "Эта функция ещё не включена у преподавателя. Пока напишите, пожалуйста, в Telegram.";
  }
  return (err && err.userText) || fallback;
}

// ---------- заявка на дополнительное занятие (book) ----------
// Ученика учитель знает по каналу; lessonId — просто новая метка (занятия
// ещё нет). Учитель создаёт занятие со своим id, эту метку не использует.
const BOOK_DURS = [30, 45, 60, 90, 120];
function lastLessonOf() {
  return myLessons().filter((x) => x.status === "planned" || x.status === "done").sort((a, b) => b.startMs - a.startMs)[0] || null;
}
function openBookModal(startMs, day, selMin) {
  const last = lastLessonOf();
  const lastMin = last ? Math.round((last.endMs - last.startMs) / 60000) : 60;
  // выделили одну клетку (30 мин) — обычная длина занятия ученика; больше — сколько выделили
  const dur = selMin && selMin > 30 && selMin <= 480 ? selMin : lastMin;
  const durs = BOOK_DURS.includes(dur) ? BOOK_DURS : BOOK_DURS.concat([dur]).sort((a, b) => a - b);
  let s = startMs;
  // Время по умолчанию (как у последнего занятия или 16:00) подставляем, только
  // если оно свободно; занято — поле времени пустое и подсказка выбрать своё.
  // Время, которое человек выбрал сам (нажал в календаре), оставляем как есть —
  // если оно занято, предупреждение появится сразу (check ниже).
  let hint = "";
  if (!s) {
    const d = day ? new Date(day) : new Date(Date.now() + 86400000);
    const t = last ? new Date(last.startMs) : null;
    d.setHours(t ? t.getHours() : 16, t ? t.getMinutes() : 0, 0, 0);
    s = d.getTime();
    if (slotProblem(null, s, s + dur * 60000)) {
      hint = `Обычное время — ${toTimeInput(s)} — в этот день занято. Выберите свободное (в календаре оно не серое).`;
    }
  }
  openLessonId = null;
  openModal(`
      <h2>Новое занятие</h2>
      <div class="meta">Выберите свободное время — преподавателю уйдёт заявка. Занятие появится в расписании после подтверждения.</div>
      <div class="field-row">
        <div class="field"><span>Дата</span><input type="date" id="bDate" value="${toDateInput(s)}"></div>
        <div class="field"><span>Время</span><input type="time" id="bTime" step="300" value="${hint ? "" : toTimeInput(s)}"></div>
        <div class="field"><span>Длительность</span><select id="bDur">${durs.map((m) => `<option value="${m}"${m === dur ? " selected" : ""}>${m} мин</option>`).join("")}</select></div>
      </div>
      <div class="field"><span>Комментарий (необязательно)</span><textarea id="bComment" maxlength="500" placeholder="Например: на этой неделе контрольная"></textarea></div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="bSend">Отправить заявку</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>`);
  mq("#mClose").addEventListener("click", closeModal);
  // Проверка сразу: при открытии и при каждом изменении даты, времени,
  // длительности — не дожидаясь «Отправить». Занято — «Отправить» выключена.
  const readSlot = () => {
    const d = mq("#bDate").value, t = mq("#bTime").value;
    const start = d && t ? new Date(`${d}T${t}:00`).getTime() : NaN;
    return Number.isNaN(start) ? null : { start, end: start + parseInt(mq("#bDur").value, 10) * 60000 };
  };
  let sent = false;
  const check = () => {
    if (sent) return "";
    const sl = readSlot();
    const problem = sl ? slotProblem(null, sl.start, sl.end) : "Выберите дату и время.";
    mq("#bSend").disabled = !!problem;
    if (!sl) msg(hint || "Выберите дату и время.", "");
    else msg(problem, problem ? "err" : "");
    return problem;
  };
  ["#bDate", "#bTime", "#bDur"].forEach((sel) => ["input", "change"].forEach((ev) => mq(sel).addEventListener(ev, () => { hint = ""; check(); })));
  check();
  mq("#bSend").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (check()) return;
    const { start, end } = readSlot();
    const comment = mq("#bComment").value.trim().slice(0, 500);
    btn.disabled = true;
    try {
      const item = await addItem(view.channel, { type: "book", lessonId: "new_" + newId(), by: current.role, createdAt: Date.now(), newStartMs: start, newEndMs: end, comment: comment || undefined });
      if (!shared.some((i) => i.id === item.id)) shared = shared.concat([item]); // сразу в «Заявки» и календарь
      render();
      sent = true;
      msg("Заявка отправлена. Ответ появится во вкладке «Заявки».", "ok");
      btn.style.display = "none";
    } catch (err) {
      btn.disabled = false;
      msg(errText(err, "Не удалось отправить. Проверьте интернет и попробуйте ещё раз."), "err");
    }
  });
}

async function sendRequest(l, type, extra) {
  await addItem(view.channel, Object.assign({ type, lessonId: l.id, by: current.role, createdAt: Date.now() }, extra));
}

// ---------- отменить свою заявку ----------
// Семья передумала: заявку, которую подал ЭТОТ кабинет (by совпадает с ролью
// открытого кабинета) и на которую ещё нет ответа, можно убрать из канала.
// На чужой заявке (родитель ↔ ученик одного ребёнка) кнопки нет. Это защита
// интерфейса, а не базы: без входа правила не отличают, кто удаляет
// (см. REVIEW.md, раздел 1). Учитель перед решением перечитывает заявку —
// отозванную не применит.
const isMine = (i) => !!(i && current && i.by === current.role);
function isPendingRequest(i) {
  const decided = new Set((view && view.requests || []).map((r) => r.id));
  return !!i && isRequest(i) && !decided.has(i.id);
}
async function withdrawRequest(id) {
  const item = shared.find((i) => i.id === id);
  if (!item || !isMine(item) || !isPendingRequest(item)) return false;
  const what = item.type === "reschedule" ? "перенос" : item.type === "book" ? "новое занятие" : "отмену";
  if (!confirm(`Отменить заявку на ${what}? Преподаватель её больше не увидит.`)) return false;
  requireOnline();
  await deleteDoc(doc(db, "channels", view.channel, "items", id));
  shared = shared.filter((i) => i.id !== id); // сразу, не дожидаясь подписки
  return true;
}
const withdrawButton = (i) => `<button class="btn secondary withdraw-btn" type="button" data-withdraw="${esc(i.id)}">Отменить заявку</button>`;
function wireWithdraw(container, after) {
  container.querySelectorAll("[data-withdraw]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try {
      if (await withdrawRequest(b.dataset.withdraw)) { render(); if (after) after(); }
    } catch (err) {
      alert(errText(err, "Не получилось отменить заявку (нет интернета?). Попробуйте ещё раз."));
    } finally {
      if (document.body.contains(b)) b.disabled = false;
    }
  }));
}
