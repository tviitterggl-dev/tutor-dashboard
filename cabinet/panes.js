"use strict";
// Кабинет семьи — вкладки «Занятия», «Заявки», «ДЗ» и «Настройки»:
// производные данные из витрины (мои занятия, ждущие заявки, ДЗ, оплата),
// отрисовка вкладок, порядок вкладок, render() — перерисовать всё.

// ---------- производные данные ----------
const myLessons = () => (view && view.lessons ? view.lessons : []);
const lessonById = (id) => myLessons().find((l) => l.id === id);
const pendingFor = (id) => shared.find((i) => (i.type === "reschedule" || i.type === "cancel") && i.lessonId === id);
// заявки: перенос, отмена и новое занятие (book — занятия ещё нет)
const isRequest = (i) => i.type === "reschedule" || i.type === "cancel" || i.type === "book";
const canRequest = (l) => l.status === "planned" && l.startMs > Date.now() && !!view.channel;

function homeworkOf(l) {
  const list = (l.homework || []).map((h) => Object.assign({}, h));
  shared.filter((i) => i.type === "homework" && i.lessonId === l.id && i.file).forEach((i) => {
    if (!list.some((h) => h.url === i.file.url)) list.push({ url: i.file.url, name: i.file.name, by: i.by, fresh: true });
  });
  return list.filter((h) => safeUrl(h.url));
}
// «Пояснение» к занятию от родителя/ученика: последнее из канала (видно
// сразу) или уже перенесённое учителем в занятие — что новее.
function noteOf(l) {
  const items = shared.filter((i) => i.type === "note" && i.lessonId === l.id).sort((a, b) => a.createdAt - b.createdAt);
  const latest = items[items.length - 1];
  const saved = l.familyNote || null;
  if (latest && (!saved || latest.createdAt >= (saved.at || 0))) return { text: latest.comment || "", by: latest.by, at: latest.createdAt };
  return saved && saved.text ? saved : null;
}
const canNote = (l) => l.status === "planned" && l.endMs >= Date.now() && !!view.channel;
const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

function paidOf(l) {
  if (current.role !== "parent") return null;
  const items = parentItems.filter((i) => i.type === "paid" && i.lessonId === l.id).sort((a, b) => a.createdAt - b.createdAt);
  const latest = items[items.length - 1];
  if (latest && latest.createdAt >= (l.paidAt || 0)) return latest.paid;
  return !!l.paid;
}

// ---------- отрисовка ----------
function lessonPills(l, now) {
  let cls = l.status, text = STATUS[l.status] || l.status;
  if (l.status === "planned" && l.endMs < now) { cls = "past"; text = "прошло"; }
  const pills = [`<span class="pill ${esc(cls)}">${esc(text)}</span>`];
  if (pendingFor(l.id)) pills.push('<span class="pill pending">заявка отправлена</span>');
  if (paidOf(l) && !canPay(l)) pills.push('<span class="pill paid">оплачено</span>');
  return `<div class="pills">${pills.join("")}</div>`;
}

// rank: 0 — ближайшее занятие (выделено), 1 — следующее за ним; только у
// них ссылки «Подключиться» и «Доска», у остальных в списке — нет.
function lessonCard(l, now, rank) {
  const files = homeworkOf(l);
  const note = noteOf(l);
  const live = l.startMs <= now && l.endMs >= now;
  const links = rank === 0 || rank === 1;
  const call = links && l.status === "planned" && l.endMs >= now ? httpUrl(l.callUrl) : null;
  const board = links && l.status === "planned" && l.endMs >= now ? httpUrl(view.boardUrl) : null;
  return `
      <div class="lesson${rank === 0 ? " next" : ""}" data-lesson="${esc(l.id || "")}">
        ${rank === 0 ? `<div class="next-label">${live ? "Идёт сейчас" : "Ближайшее занятие"}</div>` : ""}
        <div class="lesson-top">
          <div class="lesson-when">${esc(fmtWhen(l.startMs, l.endMs))}${l.pkg ? ` · ${esc(l.pkg)}` : ""}${l.group ? " · групповое" : ""}</div>
          ${lessonPills(l, now)}
        </div>
        ${call || board ? `<div class="lesson-links">
          ${call ? `<a class="call-link" href="${esc(call)}" target="_blank" rel="noopener noreferrer">Подключиться к занятию →</a>` : ""}
          ${board ? `<a class="call-link board-link" href="${esc(board)}" target="_blank" rel="noopener noreferrer">Доска →</a>` : ""}
        </div>` : ""}
        ${canPay(l) ? `<div class="pay-row">${paidButton(l)}${thanksFor === l.id ? '<span class="thanks">Благодарю за оплату!</span>' : ""}</div>` : ""}
        ${note && note.text ? `<div class="note-line"><span class="who">Пояснение:</span> ${esc(note.text.length > 140 ? note.text.slice(0, 140) + "…" : note.text)}</div>` : ""}
        ${l.report ? `<div class="report">${esc(l.report)}</div>` : ""}
        ${files.length ? `<ul class="files">${files.map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.name || "файл")}</a> <span class="who">(${esc(ROLE[h.by] || ROLE.teacher)})</span></li>`).join("")}</ul>` : ""}
      </div>`;
}

// Вкладка «Заявки»: вся история — ждущие ответа (из канала, сразу) и
// решённые (из витрины: кто, когда, что просил, чем кончилось).
const fmtStamp = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function requestItem(r, pending) {
  const l = lessonById(r.lessonId);
  const oldS = r.oldStartMs || (l && l.startMs), oldE = r.oldEndMs || (l && l.endMs);
  const title = r.type === "reschedule" ? "Перенос занятия" : r.type === "book" ? "Новое занятие" : "Отмена занятия";
  const status = pending
    ? '<span class="pill pending">ждёт ответа</span>'
    : `<span class="pill ${r.status === "approved" ? "approved" : "rejected"}">${r.status === "approved" ? "подтверждено" : "отклонено"}</span>`;
  const lines = [];
  if (r.type === "book") {
    if (r.newStartMs) lines.push(`Просили: <b>${esc(fmtWhen(r.newStartMs, r.newEndMs))}</b>`);
  } else if (r.type === "reschedule") {
    lines.push(`Было: ${oldS ? esc(fmtWhen(oldS, oldE)) : "—"}`);
    if (r.newStartMs) lines.push(`Просили: <b>${esc(fmtWhen(r.newStartMs, r.newEndMs))}</b>`);
  } else if (oldS) {
    lines.push(`Занятие: <b>${esc(fmtWhen(oldS, oldE))}</b>`);
  }
  lines.push(`<span class="who">Подал(а): ${esc(ROLE[r.by] || "—")}${r.createdAt ? ", " + esc(fmtStamp(r.createdAt)) : ""}</span>`);
  if (!pending && r.decidedAt) lines.push(`<span class="who">Ответ: ${esc(fmtStamp(r.decidedAt))}${r.reason ? " — " + esc(r.reason) : ""}</span>`);
  return `<div class="req-item">
      <div class="top"><span class="what">${title}</span>${status}</div>
      ${lines.map((x) => `<div class="line">${x}</div>`).join("")}
      ${r.comment ? `<div class="comment">«${esc(r.comment)}»</div>` : ""}
      ${pending && isMine(r) ? `<div class="btn-row" style="margin:6px 0 0">${withdrawButton(r)}</div>` : ""}
    </div>`;
}

function renderRequestsPane() {
  const decided = (view.requests || []).slice().sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  // решение уже пришло, а сама заявка ещё не удалена из канала — она не «ждёт ответа»
  const decidedIds = new Set(decided.map((r) => r.id));
  const pend = shared.filter((i) => isRequest(i) && !decidedIds.has(i.id)).sort((a, b) => b.createdAt - a.createdAt);
  let html = "";
  if (pend.length) html += `<div class="card"><div class="card-title">Ждут ответа</div>${pend.map((r) => requestItem(r, true)).join("")}</div>`;
  html += `<div class="card"><div class="card-title">История заявок</div>
      ${decided.length ? decided.map((r) => requestItem(r, false)).join("") : '<div class="empty">Решённых заявок пока нет</div>'}
      <div class="hint">Перенести или отменить занятие можно в его карточке (вкладки «Занятия» и «Календарь»), а попросить дополнительное — кнопкой «Предложить время нового занятия» или нажав на свободное время в календаре. Преподаватель подтвердит или откажет, ответ появится здесь.</div>
    </div>`;
  $("pane-requests").innerHTML = html;
  wireWithdraw($("pane-requests"));
}

// Вкладка «Занятия»: пакет (родителю) и лента
// с переключателем «Ближайшие / История».
function renderLessonsPane(now) {
  const v = view;
  const lessons = myLessons().slice().sort((a, b) => a.startMs - b.startMs);
  const upcoming = lessons.filter((l) => l.endMs >= now && l.status === "planned");
  const past = lessons.filter((l) => !(l.endMs >= now && l.status === "planned")).reverse();
  let html = "";
  if (v.role === "parent" && v.package) {
    const pk = v.package;
    const pct = pk.total ? Math.max(0, Math.min(100, Math.round((pk.done / pk.total) * 100))) : 0;
    html += `<div class="card">
        <div class="card-title">Пакет занятий</div>
        <div>Проведено <b>${esc(pk.done)}</b> из <b>${esc(pk.total)}</b> · осталось <span class="big">${esc(pk.remaining)}</span></div>
        <div class="pkg-bar"><div class="pkg-bar-fill" style="width:${pct}%"></div></div>
        ${pk.total && pk.remaining <= 0 ? '<div class="pkg-note over">Пакет закончился — напишите преподавателю о продлении.</div>'
        : pk.total && pk.remaining <= 2 ? `<div class="pkg-note">Осталось ${esc(pk.remaining)} ${pk.remaining === 1 ? "занятие" : "занятия"} — скоро нужно будет продлить пакет.</div>` : ""}
      </div>`;
  }
  const list = lessonsFilter === "upcoming" ? upcoming.slice(0, 30) : past.slice(0, pastLimit);
  html += `<div class="card">
      <div class="seg" id="lessonsSeg">
        <button type="button" data-filter="upcoming" class="${lessonsFilter === "upcoming" ? "active" : ""}">Ближайшие (${upcoming.length})</button>
        <button type="button" data-filter="past" class="${lessonsFilter === "past" ? "active" : ""}">История (${past.length})</button>
      </div>
      ${view.channel && lessonsFilter === "upcoming" ? '<div class="btn-row book-row"><button class="btn secondary" type="button" id="bookBtn">+ Предложить время нового занятия</button></div>' : ""}
      ${list.length ? list.map((l, i) => lessonCard(l, now, lessonsFilter === "upcoming" ? i : -1)).join("") : `<div class="empty">${lessonsFilter === "upcoming" ? "Запланированных занятий нет" : "Пока пусто"}</div>`}
      ${lessonsFilter === "past" && past.length > pastLimit ? '<button class="more" type="button" id="more">Показать ещё</button>' : ""}
    </div>`;
  const pane = $("pane-lessons");
  pane.innerHTML = html;
  pane.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { lessonsFilter = b.dataset.filter; renderLessonsPane(Date.now()); }));
  if ($("more")) $("more").addEventListener("click", () => { pastLimit += 20; renderLessonsPane(Date.now()); });
  wireLessonCards(pane);
  if ($("bookBtn")) $("bookBtn").addEventListener("click", () => openBookModal());
  pane.querySelectorAll("[data-paid]").forEach((b) => b.addEventListener("click", async () => {
    const l = lessonById(b.dataset.paid);
    if (!l) return;
    b.disabled = true;
    try { await togglePaid(l); } catch (err) { alert(errText(err, "Не сохранилось — проверьте интернет.")); }
    renderLessonsPane(Date.now());
  }));
}

function wireLessonCards(container) {
  container.querySelectorAll("[data-lesson]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("a, label, input, select, button")) return;
    if (el.dataset.lesson) openLessonModal(el.dataset.lesson);
  }));
}

// Вкладка «ДЗ»: загрузка без поиска по календарю + лента занятий с файлами.
const hwCandidates = (now) => myLessons()
  .filter((l) => l.status === "planned" || l.status === "done")
  .filter((l) => l.startMs > now - 21 * 86400000 && l.startMs < now + 14 * 86400000)
  .sort((a, b) => a.startMs - b.startMs);

function renderHwPane(now) {
  if (uploading) return;
  const cands = hwCandidates(now);
  if (!hwSelected || !cands.some((l) => l.id === hwSelected)) {
    // по умолчанию — последнее прошедшее занятие (к нему обычно и сдают ДЗ)
    const lastPast = cands.filter((l) => l.startMs <= now).pop();
    hwSelected = (lastPast || cands[0] || {}).id || null;
  }
  const withFiles = myLessons().filter((l) => homeworkOf(l).length).sort((a, b) => b.startMs - a.startMs);
  let html = "";
  if (view.channel && cands.length) {
    html += `<div class="card hw-upload">
        <div class="card-title">Загрузить ДЗ</div>
        <select id="hwLesson">${cands.map((l) => `<option value="${esc(l.id)}"${l.id === hwSelected ? " selected" : ""}>${esc(fmtWhen(l.startMs, l.endMs))}${l.pkg ? " · " + esc(l.pkg) : ""}</option>`).join("")}</select>
        ${dropZoneHtml("hwFile", "Загрузить выполненное ДЗ")}
        <div class="msg" id="hwMsg"></div>
        <div class="hint">Фото или файл выполненного задания, до 10 МБ. Его сразу увидят преподаватель и ${current.role === "parent" ? "ученик" : "родитель"}.</div>
      </div>`;
  } else if (!view.channel) {
    html += '<div class="card"><div class="hint" style="margin-top:0">Загрузка файлов появится после ближайшего входа преподавателя в свой кабинет.</div></div>';
  }
  html += `<div class="card"><div class="card-title">Домашние задания</div>
      ${withFiles.length ? withFiles.map((l) => `
        <div class="lesson" data-lesson="${esc(l.id)}">
          <div class="lesson-top">
            <div class="lesson-when">${esc(fmtWhen(l.startMs, l.endMs))}${l.pkg ? ` · ${esc(l.pkg)}` : ""}${l.group ? " · групповое" : ""}</div>
            ${lessonPills(l, now)}
          </div>
          <ul class="files">${homeworkOf(l).map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.name || "файл")}</a> <span class="who">(${esc(ROLE[h.by] || ROLE.teacher)})</span></li>`).join("")}</ul>
          ${view.channel && (l.status === "planned" || l.status === "done") ? `<label class="file-btn">+ добавить файл<input type="file" multiple data-hw-add="${esc(l.id)}"></label>` : ""}
        </div>`).join("") : '<div class="empty">Пока нет ни заданий, ни загруженных файлов</div>'}
    </div>`;
  const pane = $("pane-hw");
  pane.innerHTML = html;
  if ($("hwLesson")) $("hwLesson").addEventListener("change", (e) => { hwSelected = e.target.value; });
  if ($("hwFile")) wireDropZone(pane.querySelector('[data-drop="hwFile"]'), (files) => {
    const l = lessonById($("hwLesson").value);
    if (l) uploadFromPane(l, files);
  });
  pane.querySelectorAll("[data-hw-add]").forEach((inp) => inp.addEventListener("change", () => {
    const l = lessonById(inp.dataset.hwAdd);
    const files = Array.from(inp.files || []);
    inp.value = "";
    if (l && files.length) uploadFromPane(l, files);
  }));
  wireLessonCards(pane);
}

async function uploadFromPane(l, files) {
  if (!files.length) return;
  const say = (t, kind) => { const el = $("hwMsg"); if (el) { el.textContent = t; el.className = "msg" + (kind ? " " + kind : ""); } };
  uploading = true;
  try {
    await uploadFiles(l, files, say);
    uploading = false;
    renderHwPane(Date.now());
    say(files.length > 1 ? `Загружено файлов: ${files.length} (${fmtWhen(l.startMs)})` : `Файл загружен (${fmtWhen(l.startMs)})`, "ok");
  } catch (err) {
    uploading = false;
    renderHwPane(Date.now());
    say(errText(err, "Не удалось загрузить. Проверьте интернет."), "err");
  }
}

// Порядок из базы (другое устройство могло поменять): применяем к полосе
// вкладок; открытую сейчас вкладку не переключаем.
function loadTabOrder(entry) {
  getDoc(doc(db, "accessPrefs", entry.key)).then((snap) => {
    if (!current || current.key !== entry.key || !snap.exists()) return;
    const order = TabOrder.normalize(snap.data().tabOrder, CAB_TABS);
    rememberTabOrder(entry.key, order);
    applyCabTabOrder(order);
    if (tabOrderEditor) tabOrderEditor.set(order);
  }).catch(() => { /* нет сети или правила ещё не обновлены — остаётся порядок с устройства */ });
}
let tabOrderEditor = null;
function tabOrderMsg(t, kind) { const m = $("tabOrderMsg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
function renderTabOrderEditor() {
  const labels = Object.fromEntries([...document.querySelectorAll(".ctab")].map((b) => [b.dataset.ctab, b.childNodes[0].textContent.trim()]));
  const order = tabOrderFor(current.key);
  if (tabOrderEditor) { tabOrderEditor.set(order); return; }
  tabOrderEditor = TabOrder.mountEditor($("tabOrderEditor"), {
    items: CAB_TABS.map((id) => ({ id, label: labels[id] || id })),
    order,
    onChange: async (next) => {
      const key = current.key;
      if (!navigator.onLine) { tabOrderEditor.set(tabOrderFor(key)); tabOrderMsg(OFFLINE_TEXT, "err"); return; }
      rememberTabOrder(key, next);
      applyCabTabOrder(next);
      try {
        await setDoc(doc(db, "accessPrefs", key), { tabOrder: next, updatedAt: Date.now() });
        tabOrderMsg("Сохранено — порядок одинаковый на всех ваших устройствах.", "ok");
      } catch (err) {
        // правила базы ещё не обновлены — хотя бы на этом устройстве
        tabOrderMsg("Сохранено на этом устройстве.", "ok");
      }
    },
  });
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".ctab").forEach((b) => b.classList.toggle("active", b.dataset.ctab === tab));
  document.querySelectorAll(".pane").forEach((p) => { p.style.display = p.id === "pane-" + tab ? "block" : "none"; });
  if (tab === "calendar") renderCalendar();
  if (tab === "settings" && current) renderTabOrderEditor();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".ctab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.ctab)));

function render() {
  if (!view) return;
  const now = Date.now();
  const v = view;
  $("title").textContent = v.role === "parent" ? "Кабинет родителя" : "Кабинет ученика";
  $("subtitle").textContent = v.studentLabel || v.studentId || "";
  const upd = v.generatedAt ? new Date(v.generatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  $("updatedAt").textContent = `Расписание обновлено: ${upd}`;
  setPanesVisible(true);
  document.querySelectorAll(".ctab").forEach((b) => b.classList.toggle("active", b.dataset.ctab === activeTab));
  // Точка на «Заявках», пока есть заявка без ответа.
  const decidedIds = new Set((v.requests || []).map((r) => r.id));
  const hasPending = shared.some((i) => isRequest(i) && !decidedIds.has(i.id));
  const reqTab = document.querySelector('.ctab[data-ctab="requests"]');
  reqTab.innerHTML = "Заявки" + (hasPending ? '<span class="dot" title="есть заявка без ответа"></span>' : "");

  renderNotices(now);
  renderPushCard();
  if (activeTab === "settings" && !tabOrderEditor) renderTabOrderEditor(); // «Настройки» — первая вкладка
  renderLessonsPane(now);
  renderRequestsPane();
  renderHwPane(now);
  if (cal) updateCalendar();
  else if (activeTab === "calendar") renderCalendar();
  if (openLessonId && $("modalBack").style.display !== "none") refreshModal();
  openLinkLessonIfReady();
}
