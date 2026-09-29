"use strict";
// Кабинет родителя/ученика (cabinet.html): запуск и всё, что ещё не
// разложено по файлам. Код кабинета — в папке cabinet/: обычные скрипты
// с defer, выполняются по порядку ПОСЛЕ модуля Firebase в cabinet.html
// (он кладёт в window.CabFB базу и нужные функции SDK) и делят одно общее
// пространство имён — см. REVIEW.md, «Как устроен код кабинетов».
// "use strict" — как было в модуле (код модуля всегда строгий).

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
  if (!s) {
    const d = day ? new Date(day) : new Date(Date.now() + 86400000);
    const t = last ? new Date(last.startMs) : null;
    d.setHours(t ? t.getHours() : 16, t ? t.getMinutes() : 0, 0, 0);
    s = d.getTime();
  }
  openLessonId = null;
  openModal(`
      <h2>Новое занятие</h2>
      <div class="meta">Выберите свободное время — преподавателю уйдёт заявка. Занятие появится в расписании после подтверждения.</div>
      <div class="field-row">
        <div class="field"><span>Дата</span><input type="date" id="bDate" value="${toDateInput(s)}"></div>
        <div class="field"><span>Время</span><input type="time" id="bTime" step="300" value="${toTimeInput(s)}"></div>
        <div class="field"><span>Длительность</span><select id="bDur">${durs.map((m) => `<option value="${m}"${m === dur ? " selected" : ""}>${m} мин</option>`).join("")}</select></div>
      </div>
      <div class="field"><span>Комментарий (необязательно)</span><textarea id="bComment" maxlength="500" placeholder="Например: на этой неделе контрольная"></textarea></div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="bSend">Отправить заявку</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>`);
  mq("#mClose").addEventListener("click", closeModal);
  mq("#bSend").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const start = new Date(`${mq("#bDate").value}T${mq("#bTime").value}:00`).getTime();
    if (Number.isNaN(start)) { msg("Выберите дату и время.", "err"); return; }
    const end = start + parseInt(mq("#bDur").value, 10) * 60000;
    const problem = slotProblem(null, start, end);
    if (problem) { msg(problem, "err"); return; }
    const comment = mq("#bComment").value.trim().slice(0, 500);
    btn.disabled = true;
    try {
      const item = await addItem(view.channel, { type: "book", lessonId: "new_" + newId(), by: current.role, createdAt: Date.now(), newStartMs: start, newEndMs: end, comment: comment || undefined });
      if (!shared.some((i) => i.id === item.id)) shared = shared.concat([item]); // сразу в «Заявки» и календарь
      render();
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

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пусто */ }
  if (!res.ok || !data.secure_url) {
    const err = new Error((data.error && data.error.message) || ("код " + res.status));
    err.userText = `Файл «${file.name}» не загрузился: ${err.message}`;
    throw err;
  }
  return { url: data.secure_url, name: file.name.slice(0, 200) };
}

// Загрузка ДЗ: файл в Cloudinary → сообщение в общий канал ученика.
async function uploadFiles(l, files, say) {
  requireOnline();
  const big = files.filter((f) => f.size > CLOUDINARY_MAX_BYTES);
  if (big.length) {
    const err = new Error("big");
    err.userText = `Слишком большой файл: ${big.map((f) => f.name).join(", ")} (максимум 10 МБ).`;
    throw err;
  }
  for (let i = 0; i < files.length; i++) {
    say(`Загружаю ${i + 1} из ${files.length}: ${files[i].name}…`);
    const file = await uploadToCloudinary(files[i]);
    await addItem(view.channel, { type: "homework", lessonId: l.id, by: current.role, createdAt: Date.now(), file });
  }
}

// ---------- файлы ДЗ: перетаскивание, выбор, вставка из буфера ----------
function dropZoneHtml(id, label) {
  return `<label class="drop-zone" data-drop="${id}" tabindex="0">
      <input type="file" id="${id}" multiple>
      <span class="dz-main">${esc(label)}</span>
      <span class="dz-sub">перетащите фото или файл сюда, нажмите, чтобы выбрать, или вставьте скриншот (Ctrl+V)</span>
    </label>`;
}
function wireDropZone(zone, onFiles) {
  if (!zone) return;
  const input = zone.querySelector('input[type="file"]');
  input.addEventListener("change", () => { const f = Array.from(input.files || []); input.value = ""; if (f.length) onFiles(f); });
  ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) onFiles(f); });
}
function filesFromClipboard(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const stamp = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[.,: ]+/g, "-");
  return items.filter((i) => i.kind === "file").map((i, n) => {
    const f = i.getAsFile();
    if (!f) return null;
    if (!f.name || /^image\.\w+$/i.test(f.name)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `скриншот-${stamp}${n ? "-" + (n + 1) : ""}.${ext}`, { type: f.type });
    }
    return f;
  }).filter(Boolean);
}
document.addEventListener("paste", (e) => {
  const files = filesFromClipboard(e);
  if (!files.length) return; // обычный текст вставляется как обычно
  if (modalPaste && $("modalBack").style.display !== "none") { e.preventDefault(); modalPaste(files); return; }
  if (activeTab === "hw" && $("hwFile") && $("hwLesson")) {
    const l = lessonById($("hwLesson").value);
    if (l) { e.preventDefault(); uploadFromPane(l, files); }
  }
});

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

// ---------- сообщения и напоминания от преподавателя ----------
// Учитель публикует в витрину notices (только для этого адресата):
//  • «now»/«once» — показать при следующих N открытиях кабинета (счётчик —
//    на этом устройстве, в localStorage); «Понятно, скрыть» — сразу убрать;
//  • «before» — напоминание: появляется за заданное время до занятия и
//    висит до его конца. Логика — в notify-core.js (общая с рассылкой).
const SEEN = "cabinetNoticesSeen";
const seenMap = () => { try { return JSON.parse(localStorage.getItem(SEEN) || "{}") || {}; } catch (e) { return {}; } };
const saveSeen = (m) => { try { localStorage.setItem(SEEN, JSON.stringify(m)); } catch (e) { /* приватный режим */ } };
const countedNow = new Set(); // засчитанные в это открытие кабинета
function renderNotices(now) {
  const el = $("notices");
  if (!view) { el.innerHTML = ""; return; }
  const notices = Array.isArray(view.notices) ? view.notices : [];
  const seen = seenMap();
  const cards = [];
  // счётчик — на этом устройстве и для этой ссылки (на общем планшете мама и
  // ребёнок видят сообщение каждый свои N раз)
  const sk = (id) => `${current.key.slice(0, 12)}:${id}`;
  const label = view.studentLabel || view.studentId;
  notices.filter((n) => n.mode === "once" || n.mode === "now").forEach((n) => {
    const times = n.times || 1;
    const counted = countedNow.has(sk(n.id));
    if (!counted && (seen[sk(n.id)] || 0) >= times) return;
    if (!counted) { seen[sk(n.id)] = (seen[sk(n.id)] || 0) + 1; countedNow.add(sk(n.id)); }
    const bound = (n.lessonIds || []).map((id) => lessonById(id)).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    cards.push({ id: sk(n.id), kind: "msg", title: window.NotifyCore.titleFor(n, null, label), text: n.text, sub: bound.length ? "К занятию: " + bound.map((l) => fmtWhen(l.startMs, l.endMs)).join("; ") : "" });
  });
  window.NotifyCore.dueReminders(notices, myLessons(), now, label).forEach((r) => {
    if (!seen[sk(r.id)]) cards.push({ id: sk(r.id), kind: "rem", title: r.title, text: r.text, sub: fmtWhen(r.startMs) });
  });
  saveSeen(seen);
  el.innerHTML = cards.map((c) => `
      <div class="notice ${c.kind}" data-notice="${esc(c.id)}">
        <div class="notice-head">${esc(c.title)}</div>
        <div class="notice-text">${esc(c.text)}</div>
        ${c.sub ? `<div class="who">${esc(c.sub)}</div>` : ""}
        <button class="link-btn notice-close" type="button" data-notice-close="${esc(c.id)}">Понятно, скрыть</button>
      </div>`).join("");
}
$("notices").addEventListener("click", (e) => {
  const b = e.target.closest("[data-notice-close]");
  if (!b) return;
  const seen = seenMap();
  seen[b.dataset.noticeClose] = 1000;
  saveSeen(seen);
  countedNow.delete(b.dataset.noticeClose);
  renderNotices(Date.now());
});
setInterval(() => { if (view) renderNotices(Date.now()); }, 60000); // напоминания «за X до занятия»

// ---------- уведомления на телефон (пуш, Firebase Cloud Messaging) ----------
// Подписка = сообщение type "push" в общем канале ученика: токен этого
// устройства + ключ этого кабинета. Пуши шлёт фоновая рассылка (notifier/,
// GitHub Actions) — она проверяет, что ключ не отозван.
const PUSH_STORE = "cabinetPush"; // { [ключ доступа]: { token, itemId, channel } }
const pushSaved = () => { try { return JSON.parse(localStorage.getItem(PUSH_STORE) || "{}") || {}; } catch (e) { return {}; } };
const savePush = (m) => { try { localStorage.setItem(PUSH_STORE, JSON.stringify(m)); } catch (e) { /* приватный режим */ } };
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
function pushSupport() {
  if (!FCM_VAPID_KEY) return { ok: false, text: "Уведомления на телефон пока не включены у преподавателя. Сообщения и напоминания всё равно видны здесь, в кабинете." };
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    if (isIOS && !isStandalone()) return { ok: false, text: "На iPhone уведомления приходят, только если кабинет добавлен на экран «Домой»: Safari → «Поделиться» → «На экран «Домой»». Потом откройте кабинет со значка и включите уведомления здесь." };
    return { ok: false, text: "Этот браузер не умеет получать уведомления. Сообщения преподавателя видны здесь, в кабинете." };
  }
  if (Notification.permission === "denied") return { ok: false, text: "Уведомления для этого сайта запрещены в настройках браузера или телефона — разрешите их там и обновите страницу." };
  return { ok: true };
}
// Своя подписка в канале: по id, а если учитель пересоздал её (перевод
// старой подписки на отпечаток ключа, смена канала) — по токену устройства.
function myPushItem() {
  const mine = current && pushSaved()[current.key];
  if (!mine) return null;
  return shared.find((i) => i.id === mine.itemId) || shared.find((i) => i.type === "push" && i.token === mine.token && window.NotifyCore.isPushKeyId(i.key)) || null;
}
const pushOn = () => !!(myPushItem() && "Notification" in window && Notification.permission === "granted");
function pushMsg(t, kind) { const m = $("pushMsg"); if (m) { m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); } }
function renderPushCard() {
  const el = $("pushBody");
  if (!el || !current || !view) return;
  const keepMsg = $("pushMsg") ? [$("pushMsg").textContent, $("pushMsg").className] : null;
  const sup = pushSupport();
  let html;
  if (!sup.ok) html = `<div class="hint" style="margin-top:0">${esc(sup.text)}</div>`;
  else if (pushOn()) html = `<div>Уведомления включены на этом устройстве ✓</div>
        <div class="btn-row"><button class="btn secondary" type="button" id="pushTest">Проверить</button><button class="forget" type="button" id="pushOff">Выключить</button></div>`;
  else html = `<div class="btn-row" style="margin-top:0"><button class="btn" type="button" id="pushOnBtn">Включить уведомления</button></div>
        <div class="hint">Напоминания о занятиях и сообщения преподавателя будут приходить на этот телефон или компьютер, даже когда кабинет закрыт.${isIOS ? " На iPhone — только из кабинета, открытого со значка на экране «Домой»." : ""}</div>`;
  el.innerHTML = html + '<div class="msg" id="pushMsg"></div>';
  if (keepMsg) { $("pushMsg").textContent = keepMsg[0]; $("pushMsg").className = keepMsg[1]; }
  if ($("pushOnBtn")) $("pushOnBtn").addEventListener("click", enablePush);
  if ($("pushOff")) $("pushOff").addEventListener("click", () => disablePush(true));
  if ($("pushTest")) $("pushTest").addEventListener("click", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      await reg.showNotification("Кабинет: проверка", { body: "Так будут выглядеть напоминания и сообщения преподавателя.", icon: "icons/icon-192.png" });
      pushMsg("Уведомление показано.", "ok");
    } catch (e) { pushMsg("Не получилось показать уведомление.", "err"); }
  });
}
const userError = (text) => { const e = new Error(text); e.userText = text; return e; };
// Запрос разрешения — ПЕРВЫМ делом и синхронно в нажатии: Safari на iPhone
// показывает системный вопрос только так (после любого await — может молча
// отказать). Старый Safari отвечает через колбэк, новый — промисом.
function askPermission() {
  return new Promise((resolve) => {
    const r = Notification.requestPermission(resolve);
    if (r && typeof r.then === "function") r.then(resolve, () => resolve("denied"));
  });
}
async function enablePush() {
  if (!navigator.onLine) { pushMsg(OFFLINE_TEXT, "err"); return; }
  if (!view.channel) { pushMsg("Уведомления заработают после ближайшего входа преподавателя в свой кабинет — попробуйте чуть позже.", "err"); return; }
  const permission = askPermission();
  const btn = $("pushOnBtn");
  if (btn) btn.disabled = true;
  pushMsg("Включаю…");
  try {
    const perm = await permission;
    if (perm !== "granted") throw userError("Без разрешения уведомления не придут. Если передумаете — разрешите их и нажмите ещё раз.");
    const reg = await navigator.serviceWorker.register("sw.js");
    const m = await import(FCM_URL);
    if (m.isSupported && !(await m.isSupported())) throw userError("Этот браузер не умеет получать уведомления.");
    const token = await m.getToken(m.getMessaging(firebaseApp), { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw userError("Телефон не выдал адрес для уведомлений — попробуйте ещё раз.");
    const saved = pushSaved();
    const old = saved[current.key];
    const have = old && old.token === token ? myPushItem() : null;
    if (!have) {
      // в общем канале — только отпечаток ключа: вторая сторона (родитель
      // или ученик) видит канал, но не должна узнать чужой ключ
      const kid = await window.NotifyCore.pushKeyId(current.key);
      const itemId = newId();
      await setDoc(doc(db, "channels", view.channel, "items", itemId), { type: "push", lessonId: "-", by: current.role, createdAt: Date.now(), token, key: kid });
      if (old && old.itemId && old.channel) deleteDoc(doc(db, "channels", old.channel, "items", old.itemId)).catch(() => {});
      saved[current.key] = { token, itemId, channel: view.channel };
      savePush(saved);
      shared = shared.concat([{ id: itemId, type: "push", token, key: kid }]);
    }
    renderPushCard();
    pushMsg("Готово! Уведомления будут приходить на это устройство.", "ok");
  } catch (err) {
    console.error(err);
    renderPushCard();
    pushMsg(errText(err, "Не получилось включить уведомления. Проверьте интернет и попробуйте ещё раз."), "err");
  }
}
async function disablePush(say) {
  if (say && !navigator.onLine) { pushMsg(OFFLINE_TEXT, "err"); return; }
  const saved = pushSaved();
  const mine = current && saved[current.key];
  if (!mine) return;
  const item = myPushItem(); // до удаления из сохранённых
  delete saved[current.key];
  savePush(saved);
  const ids = new Set([mine.itemId, item && item.id].filter(Boolean));
  for (const id of ids) {
    try { await deleteDoc(doc(db, "channels", view && view.channel ? view.channel : mine.channel, "items", id)); } catch (e) { /* уже удалено */ }
  }
  shared = shared.filter((i) => !ids.has(i.id));
  if (say) { renderPushCard(); pushMsg("Уведомления на этом устройстве выключены.", "ok"); }
}

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
