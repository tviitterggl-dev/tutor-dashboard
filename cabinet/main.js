"use strict";
// Кабинет родителя/ученика (cabinet.html): запуск и всё, что ещё не
// разложено по файлам. Код кабинета — в папке cabinet/: обычные скрипты
// с defer, выполняются по порядку ПОСЛЕ модуля Firebase в cabinet.html
// (он кладёт в window.CabFB базу и нужные функции SDK) и делят одно общее
// пространство имён — см. REVIEW.md, «Как устроен код кабинетов».
// "use strict" — как было в модуле (код модуля всегда строгий).

// ---------- офлайн ----------
// Последняя загруженная витрина — на этом устройстве (как и сам ключ), по
// ключу; только для кабинетов, сохранённых на устройстве. Без сети кабинет
// показывает её с плашкой, а всё, что пишет в базу, честно отказывает.
const VIEW_CACHE = "cabinetViewCache";
const OFFLINE_TEXT = "Нет подключения к интернету — сейчас это не сохранится. Подключитесь к интернету и повторите.";
let viewStale = false; // показана сохранённая, а не свежая версия
const viewCacheAll = () => { try { return JSON.parse(localStorage.getItem(VIEW_CACHE) || "{}") || {}; } catch (e) { return {}; } };
function viewCacheGet(key) { const c = viewCacheAll()[key]; return c && c.view ? c : null; }
function viewCachePut(key, v) {
  const all = viewCacheAll();
  const known = new Set(loadSaved().map((x) => x.key).concat([key]));
  Object.keys(all).forEach((k) => { if (!known.has(k)) delete all[k]; });
  all[key] = { view: v, at: Date.now() };
  try { localStorage.setItem(VIEW_CACHE, JSON.stringify(all)); } catch (e) { /* место кончилось — не страшно */ }
}
function viewCacheDrop(key) { const all = viewCacheAll(); delete all[key]; try { localStorage.setItem(VIEW_CACHE, JSON.stringify(all)); } catch (e) { /* ничего */ } }
function requireOnline() {
  if (!navigator.onLine) { const e = new Error("offline"); e.offline = true; e.userText = OFFLINE_TEXT; throw e; }
}
function updateOffline() {
  const bar = $("offlineBar");
  const off = !navigator.onLine;
  if (!view || !(off || viewStale)) { bar.hidden = true; return; }
  const when = view.generatedAt ? new Date(view.generatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  bar.textContent = (off ? "Офлайн — показаны последние загруженные данные" : "Загружаю свежие данные… Пока показаны последние сохранённые")
    + (when ? ` (расписание от ${when})` : "") + ". Они могут быть неактуальными." + (off ? " Отметки, пояснения и файлы сейчас не сохранятся — нужен интернет." : "");
  bar.hidden = false;
}
window.addEventListener("online", updateOffline);
window.addEventListener("offline", updateOffline);

function openCabinet(entry) {
  stopWatching();
  current = entry;
  if (location.hash !== hashOf(entry)) showInAddress(entry); // replaceState не вызывает hashchange
  view = null;
  if (cal) { cal.destroy(); cal = null; } // другой ребёнок — другой диапазон и события
  const order = tabOrderFor(entry.key);
  applyCabTabOrder(order);
  activeTab = order[0]; // первая в своём порядке
  loadTabOrder(entry);
  lessonsFilter = "upcoming";
  hwSelected = null;
  pastLimit = 10;
  closeModal();
  $("root").innerHTML = '<div class="card"><div class="empty">Загрузка…</div></div>';
  setPanesVisible(false);
  // сразу — последняя сохранённая на устройстве версия (без интернета
  // только она и есть); свежая из базы заменит её, как только придёт
  const cached = viewCacheGet(entry.key);
  viewStale = true;
  if (cached) { view = cached.view; renderSwitcher(); render(); }
  else if (!navigator.onLine) showMessage("Нет подключения к интернету, а на этом устройстве кабинет ещё не открывался. Подключитесь к интернету и откройте кабинет снова.");
  updateOffline();
  let watchedChannel = null, watchedParent = null;
  let unsubChannel = null, unsubParent = null;
  const u = onSnapshot(viewRef(entry), { includeMetadataChanges: true }, (snap) => {
    const fromCache = !!(snap.metadata && snap.metadata.fromCache);
    if (!snap.exists() && fromCache) {
      // нет сети и нет кэша базы — это не «доступ отозван»; держим сохранённое
      if (!view) showMessage("Нет подключения к интернету, а на этом устройстве кабинет ещё не открывался. Подключитесь к интернету и откройте кабинет снова.");
      updateOffline();
      return;
    }
    if (!snap.exists()) {
      viewCacheDrop(entry.key);
      const list = loadSaved().filter((x) => x.key !== entry.key);
      saveSaved(list);
      stopWatching();
      showMessage("Ссылка недействительна или доступ отозван. Попросите у преподавателя новую.");
      renderSwitcher();
      return;
    }
    view = snap.data();
    viewStale = fromCache;
    if (!fromCache) viewCachePut(entry.key, view);
    updateOffline();
    const list = loadSaved();
    const me = list.find((x) => x.key === entry.key);
    // для переключателя детей: «Имя Фамилия, N класс», если фамилия есть
    const lbl = view.studentLabel || view.studentId;
    if (me && me.studentId !== lbl) { me.studentId = lbl; saveSaved(list); }
    // Каналы могут смениться (после отзыва чужого доступа) — переподписываемся.
    // Старую подписку обязательно отключаем: иначе опустевший старый канал
    // затрёт данные нового.
    if (view.channel !== watchedChannel) {
      watchedChannel = view.channel;
      if (unsubChannel) unsubChannel();
      unsubChannel = null;
      shared = [];
      if (view.channel) {
        const ch = view.channel;
        unsubChannel = onSnapshot(collection(db, "channels", ch, "items"),
          (s) => { if (ch !== watchedChannel) return; shared = s.docs.map((d) => Object.assign({ id: d.id }, d.data())); render(); },
          (e) => console.error(e));
        unsubs.push(() => unsubChannel && unsubChannel());
      }
    }
    if (entry.role === "parent" && view.parentChannel !== watchedParent) {
      watchedParent = view.parentChannel;
      if (unsubParent) unsubParent();
      unsubParent = null;
      parentItems = [];
      if (view.parentChannel) {
        const ch = view.parentChannel;
        unsubParent = onSnapshot(collection(db, "channels", ch, "items"),
          (s) => { if (ch !== watchedParent) return; parentItems = s.docs.map((d) => Object.assign({ id: d.id }, d.data())); render(); },
          (e) => console.error(e));
        unsubs.push(() => unsubParent && unsubParent());
      }
    }
    renderSwitcher();
    render();
  }, (e) => {
    console.error(e);
    if (view) { viewStale = true; updateOffline(); return; } // показываем сохранённое
    showMessage(navigator.onLine ? "Не удалось загрузить кабинет. Проверьте интернет и обновите страницу." : "Нет подключения к интернету, а на этом устройстве кабинет ещё не открывался. Подключитесь к интернету и откройте кабинет снова.");
  });
  unsubs.push(u);
}

function renderSwitcher() {
  const list = loadSaved();
  const el = $("switcher");
  if (list.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = `<select class="switch" id="switchSel">${list.map((x) => `<option value="${esc(x.key)}"${current && x.key === current.key ? " selected" : ""}>${esc(x.studentId || "кабинет")} · ${ROLE[x.role]}</option>`).join("")}</select>`;
  $("switchSel").addEventListener("change", (e) => {
    const entry = loadSaved().find((x) => x.key === e.target.value);
    if (entry) openCabinet(entry);
  });
}

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

// ---------- занятие из пуш-уведомления ----------
// Пуш с привязкой к занятию ведёт на cabinet.html?lesson=<id>#p=<ключ>.
// Кабинет закрыт — открывается по ссылке; уже открыт — sw.js не открывает
// новую вкладку, а шлёт ей { type: "open-lesson", lessonId }. Окно
// показываем, когда занятие есть в витрине. Нет его (удалено, вне окна
// витрины) — просто кабинет: ждём свежую витрину и тихо забываем.
let linkLesson = (() => {
  const u = new URL(location.href);
  const id = u.searchParams.get("lesson");
  if (!id) return null;
  u.searchParams.delete("lesson"); // обновление страницы не должно открывать окно снова
  try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* не страшно */ }
  return id;
})();
// в открытом окне что-то набрано и не отправлено?
function modalDirty() {
  if ($("modalBack").style.display === "none") return false;
  return [...$("modal").querySelectorAll("input, textarea, select")].some((el) =>
    el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
      : el.tagName === "SELECT" ? [...el.options].some((o) => o.selected !== o.defaultSelected)
        : el.type !== "file" && el.value !== el.defaultValue);
}
function openLinkLessonIfReady() {
  if (!linkLesson || !view) return;
  const id = linkLesson;
  if (!lessonById(id)) { if (!viewStale) linkLesson = null; return; } // в сохранённой копии нет — ждём свежую
  linkLesson = null;
  if (openLessonId === id && $("modalBack").style.display !== "none") return;
  if (modalDirty() && !confirm("Открыть занятие из уведомления? Несохранённое в открытом окне пропадёт.")) return;
  openLessonModal(id);
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "open-lesson" || typeof e.data.lessonId !== "string" || e.data.lessonId.length > 200) return;
    linkLesson = e.data.lessonId;
    openLinkLessonIfReady();
  });
  try { navigator.serviceWorker.startMessages(); } catch (e) { /* старый браузер — сообщения и так идут */ }
}

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
