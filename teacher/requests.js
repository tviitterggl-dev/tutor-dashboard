// Кабинет учителя — вкладка «Заявки»: каналы учеников (ДЗ, «Оплачено»,
// пояснения, переносы, заявки «book» на дополнительное занятие), решения
// по заявкам, история, бейдж на вкладке.

// ---------- КАНАЛЫ УЧЕНИКОВ: ДЗ, ОПЛАТА, ЗАЯВКИ ----------
// У каждого ученика с выданным доступом два канала (случайные ключи):
//   shared — родитель + ученик: загруженное ДЗ, заявки на перенос/отмену;
//   parent — только родители: отметка «оплачено».
// Родитель/ученик только ДОБАВЛЯЮТ сообщения; расписание меняет лишь
// учитель. Каждое сообщение проверяется: занятие должно принадлежать
// ученику этого канала, иначе оно выбрасывается (и ничего о чужом
// занятии никуда не пишется).

const studentChannels = () => remoteState.studentChannels || {};
const channelMeta = {};    // ключ канала → { studentId, kind: "shared" | "parent" }
const channelItems = {};   // ключ канала → сообщения
const channelWatchers = {}; // ключ канала → функция отписки
const channelBusy = {};
// book — семья просит ДОПОЛНИТЕЛЬНОЕ занятие: занятия ещё нет, lessonId в
// заявке — только метка кабинета (как id документа НЕ используется: иначе
// подменой id можно было бы задеть чужое занятие).
const REQUEST_TYPES = ["reschedule", "cancel", "book"];
// Последнее «оплачено»/«пояснение» по занятию остаётся в канале, пока витрина
// семьи его не догнала (кабинет показывает, что новее). Дольше держать
// незачем: иначе канал копит по сообщению на КАЖДОЕ занятие навсегда, и
// кабинеты и фоновая рассылка (каждые 15 минут) перечитывают их все.
const CHANNEL_KEEP_MS = DAY_MS;

const activeKeysOf = (studentId) => (accessKeysCache || []).filter(k => k.active && k.studentId === studentId);

async function ensureChannels(keys) {
  const need = [...new Set(keys.filter(k => k.active).map(k => k.studentId))];
  const map = Object.assign({}, studentChannels());
  for (const sid of need) {
    if (map[sid] && map[sid].shared && map[sid].parent) continue;
    map[sid] = { shared: newAccessKey(), parent: newAccessKey(), createdAt: Date.now() };
    await window.TutorFB.setStudentChannels(sid, map[sid]);
  }
  remoteState.studentChannels = map;
}

// Каналы должны соответствовать доступам (сверка при каждом запуске):
//  • у ученика не осталось действующих доступов — каналы удаляются целиком:
//    писать туда больше некому, а рассылка и кабинет не читают их зря;
//  • доступ отозван позже, чем заведены каналы, — значит, при отзыве смена
//    каналов не дошла (сбой сети посреди отзыва: ключ уже неактивен, кнопки
//    «Отозвать» больше нет), и отозванный всё ещё знает ключ канала —
//    меняем каналы сейчас.
async function reconcileChannels(keys) {
  for (const [sid, ch] of Object.entries(studentChannels())) {
    if (!ch) continue;
    const mine = keys.filter(k => k.studentId === sid);
    if (!mine.some(k => k.active)) { await dropChannels(sid); continue; }
    const lastRevoked = Math.max(0, ...mine.filter(k => !k.active).map(k => k.revokedAt || 0));
    if (lastRevoked > (ch.createdAt || 0)) {
      await rotateChannels(sid);
      await publishViews(activeKeysOf(sid));
    }
  }
}
// Удалить каналы ученика вместе с сообщениями (нет доступов / ученик удалён).
async function dropChannels(sid) {
  const ch = studentChannels()[sid];
  if (!ch) return;
  for (const ck of [ch.shared, ch.parent].filter(Boolean)) {
    const items = await window.TutorFB.listChannel(ck).catch(() => []);
    if (items.length) await window.TutorFB.deleteChannelItems(ck, items.map(i => i.id));
  }
  await window.TutorFB.setStudentChannels(sid, null);
  const map = Object.assign({}, studentChannels());
  delete map[sid];
  remoteState.studentChannels = map;
}

async function startChannelWatch() {
  let keys;
  try {
    keys = await getAccessKeys(true);
    await ensureChannels(keys);
    await reconcileChannels(keys);
  } catch (e) {
    console.error("Каналы учеников недоступны", e);
    return;
  }
  const want = {};
  const withKeys = new Set(keys.filter(k => k.active).map(k => k.studentId));
  Object.entries(studentChannels()).forEach(([sid, ch]) => {
    if (!withKeys.has(sid)) return;
    if (ch.shared) want[ch.shared] = { studentId: sid, kind: "shared" };
    if (ch.parent) want[ch.parent] = { studentId: sid, kind: "parent" };
  });
  Object.keys(channelWatchers).forEach(ck => {
    if (!want[ck]) { channelWatchers[ck](); delete channelWatchers[ck]; delete channelItems[ck]; delete channelMeta[ck]; }
  });
  Object.entries(want).forEach(([ck, meta]) => {
    channelMeta[ck] = meta;
    if (channelWatchers[ck]) return;
    channelWatchers[ck] = window.TutorFB.watchChannel(ck,
      (items) => { channelItems[ck] = items; onChannelChanged(ck); },
      (err) => console.error("Канал не читается", err));
  });
  renderRequestsBadge();
}

function onChannelChanged(ck) {
  renderRequestsBadge();
  if (activeTab === "requests") renderRequests();
  processChannel(ck);
}

function pendingRequests() {
  const out = [];
  Object.entries(channelItems).forEach(([ck, items]) => {
    (items || []).filter(i => REQUEST_TYPES.includes(i.type)).forEach(i => out.push({ ck, item: i, meta: channelMeta[ck] }));
  });
  return out.sort((a, b) => a.item.createdAt - b.item.createdAt);
}

function renderRequestsBadge() {
  const n = pendingRequests().length;
  const badge = $("reqBadge");
  badge.textContent = String(n);
  badge.style.display = n ? "inline-block" : "none";
  const alertEl = $("reqAlert");
  alertEl.style.display = n ? "block" : "none";
  alertEl.textContent = n ? `Новые заявки от родителей/учеников: ${n} — открыть` : "";
  document.title = (n ? `(${n}) ` : "") + "Тьютор Онлайн";
}
$("reqAlert").addEventListener("click", () => showTab("requests"));

// Старые подписки на пуш (до 2026-09-27) хранили в общем канале сам ключ
// доступа — его видела и вторая сторона (родитель ↔ ученик). Переводим на
// отпечаток ключа (тот же токен устройства, пуши продолжают приходить), а
// подписки отозванных ключей просто удаляем.
async function fixLegacyPushItems(ck, meta, all) {
  const legacy = all.filter(i => i.type === "push" && !NotifyCore.isPushKeyId(i.key));
  if (!legacy.length) return;
  const active = new Set(activeKeysOf(meta.studentId).map(k => k.id));
  for (const i of legacy) {
    if (active.has(i.key)) {
      const data = { type: "push", lessonId: i.lessonId || "-", by: i.by, createdAt: i.createdAt || Date.now(), token: i.token, key: await NotifyCore.pushKeyId(i.key) };
      await window.TutorFB.addChannelItem(ck, newId("p"), data);
    }
  }
  await window.TutorFB.deleteChannelItems(ck, legacy.map(i => i.id));
}

// Автоматически: ДЗ → в занятие, «оплачено» → в занятие. Заявки ждут решения.
async function processChannel(ck) {
  if (channelBusy[ck]) { channelBusy[ck] = "again"; return; }
  channelBusy[ck] = true;
  try {
    const meta = channelMeta[ck];
    // подписки на пуш (type push) не относятся к занятиям — их читает фоновая рассылка
    if (meta) await fixLegacyPushItems(ck, meta, channelItems[ck] || []);
    // заявки на новое занятие ждут решения; принимаем только из общего канала
    const books = (channelItems[ck] || []).filter(i => i.type === "book");
    if (meta && meta.kind !== "shared" && books.length) await window.TutorFB.deleteChannelItems(ck, books.map(i => i.id));
    const items = (channelItems[ck] || []).filter(i => i.type !== "push" && i.type !== "book");
    if (!meta || !items.length) return;
    const byLesson = {};
    items.forEach(i => { (byLesson[i.lessonId] = byLesson[i.lessonId] || []).push(i); });
    const toDelete = [];
    let changed = false;
    for (const [lessonId, its] of Object.entries(byLesson)) {
      const l = await window.TutorFB.getLesson(lessonId);
      if (!l || l.studentId !== meta.studentId) {
        // Не существует или занятие ДРУГОГО ученика — ничего не применяем.
        for (const i of its.filter(x => REQUEST_TYPES.includes(x.type))) {
          await window.TutorFB.saveRequestDecision(i.id, decisionData(i, meta, null, "rejected", "Занятие не найдено"));
        }
        toDelete.push(...its.map(i => i.id));
        changed = true;
        continue;
      }
      const patch = {};
      // уже в занятии (или перекрыто более новым) и старше суток — витрина
      // семьи давно это показывает, сообщение в канале больше не нужно
      const settled = (i, saved) => !!saved && (saved.at || 0) >= i.createdAt && Date.now() - i.createdAt >= CHANNEL_KEEP_MS;
      // by в сообщении пишет сам отправитель, а правила не отличают учителя от
      // семьи (входа у семьи нет) — «от учителя» может подставить кто угодно
      // с ключом канала. ДЗ и пояснения из каналов принимаем только от
      // родителя/ученика; «оплачено» — только от родителя (свои отметки
      // учитель ставит в занятие сам, в канал пишет лишь их копию для семьи).
      const fromFamily = (i) => i.by === "parent" || i.by === "student";
      toDelete.push(...its.filter(i => (i.type === "homework" || i.type === "note") && !fromFamily(i)).map(i => i.id));
      const hws = its.filter(i => i.type === "homework" && fromFamily(i));
      if (hws.length) {
        const hw = Array.isArray(l.homework) ? l.homework.slice() : [];
        hws.forEach(i => {
          if (!hw.some(h => h.url === i.file.url)) hw.push({ url: i.file.url, name: i.file.name, by: i.by, uploadedAt: i.createdAt });
        });
        patch.homework = hw;
        toDelete.push(...hws.map(i => i.id));
      }
      // «Пояснение» от родителя/ученика: последнее → в занятие (familyNote);
      // последнее сообщение остаётся в канале, старые удаляются.
      const notes = its.filter(i => i.type === "note" && fromFamily(i)).sort((a, b) => a.createdAt - b.createdAt);
      if (notes.length) {
        if (meta.kind !== "shared") {
          toDelete.push(...notes.map(i => i.id));
        } else {
          const latest = notes[notes.length - 1];
          const cur = l.familyNote;
          if (!cur || (cur.at || 0) < latest.createdAt || ((cur.at || 0) === latest.createdAt && cur.text !== (latest.comment || ""))) {
            patch.familyNote = { text: String(latest.comment || "").slice(0, 1000), by: latest.by, at: latest.createdAt };
          }
          toDelete.push(...notes.slice(0, -1).map(i => i.id));
          if (settled(latest, patch.familyNote || l.familyNote)) toDelete.push(latest.id);
        }
      }
      const paids = its.filter(i => i.type === "paid").sort((a, b) => a.createdAt - b.createdAt);
      if (paids.length) {
        if (meta.kind !== "parent") {
          toDelete.push(...paids.map(i => i.id)); // «оплачено» ставит только родитель
        } else {
          const fromParent = paids.filter(i => i.by === "parent");
          const latest = fromParent[fromParent.length - 1];
          if (latest && (!l.paid || (l.paid.at || 0) < latest.createdAt)) patch.paid = { value: latest.paid, by: "parent", at: latest.createdAt };
          toDelete.push(...paids.slice(0, -1).map(i => i.id)); // последняя остаётся — её видит родитель
          const last = paids[paids.length - 1];
          if (settled(last, patch.paid || l.paid)) toDelete.push(last.id);
        }
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = Date.now();
        await window.TutorFB.updateLesson(l.id, patch);
        changed = true;
      }
    }
    // Сначала обновляем витрины, потом удаляем сообщения — чтобы файл не
    // «мигнул» и не пропал из кабинета.
    if (changed) {
      await publishViews(activeKeysOf(meta.studentId));
      if (fc) fc.refetchEvents();
    }
    if (toDelete.length) await window.TutorFB.deleteChannelItems(ck, toDelete);
  } catch (e) {
    console.error("Не удалось обработать канал", e);
  } finally {
    const again = channelBusy[ck] === "again";
    channelBusy[ck] = false;
    if (again) processChannel(ck);
  }
}

function decisionData(item, meta, lesson, status, reason, newLessonId) {
  return {
    newLessonId: newLessonId || null,
    type: item.type,
    lessonId: item.lessonId,
    studentId: meta.studentId,
    by: item.by,
    comment: item.comment || "",
    newStartMs: item.newStartMs || null,
    newEndMs: item.newEndMs || null,
    oldStartMs: lesson ? lesson.startMs : null,
    oldEndMs: lesson ? lesson.endMs : null,
    createdAt: item.createdAt,
    status,
    reason: reason || "",
    decidedAt: Date.now(),
  };
}

const lessonCache = {};

async function renderRequests() {
  const list = $("requestsList");
  const pend = pendingRequests();
  const bookWarn = {};
  for (const p of pend) {
    if (p.item.type === "book") { bookWarn[p.item.id] = await bookProblem(p.item); continue; }
    if (!(p.item.lessonId in lessonCache)) {
      try { lessonCache[p.item.lessonId] = await window.TutorFB.getLesson(p.item.lessonId); } catch (e) { lessonCache[p.item.lessonId] = null; }
    }
  }
  const current = pendingRequests(); // могли измениться, пока грузили
  list.innerHTML = current.length ? current.map(({ ck, item, meta }) => {
    if (item.type === "book") return bookRequestHtml(ck, item, meta, bookWarn[item.id]);
    const l = lessonCache[item.lessonId];
    const valid = l && meta && l.studentId === meta.studentId;
    const warn = !valid ? "Занятие не найдено — будет отклонено автоматически."
      : l.status !== "planned" ? `Занятие уже «${STATUS_RU[l.status]}» — подтвердить нельзя.`
      : l.startMs < Date.now() ? "Занятие уже прошло." : "";
    const what = item.type === "reschedule"
      ? `Перенос: ${valid ? escHtml(fmtWhen(l.startMs, l.endMs)) : "—"} → <b>${escHtml(fmtWhen(item.newStartMs, item.newEndMs))}</b>`
      : `Отмена: ${valid ? `<b>${escHtml(fmtWhen(l.startMs, l.endMs))}</b>` : "—"}`;
    return `<div class="req" data-ck="${escHtml(ck)}" data-id="${escHtml(item.id)}">
          <div class="who">${escHtml(meta ? studentLabel(meta.studentId) : "?")} <span class="cls">· ${ROLE_RU[item.by] || escHtml(item.by)} · ${escHtml(new Date(item.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</span></div>
          <div class="what">${what}</div>
          ${item.comment ? `<div class="comment">«${escHtml(item.comment)}»</div>` : ""}
          ${warn ? `<div class="warn">${escHtml(warn)}</div>` : ""}
          <div class="btn-row">
            <button class="btn" type="button" data-req="approve" ${valid && l.status === "planned" ? "" : "disabled"}>Подтвердить</button>
            <button class="btn secondary" type="button" data-req="reject">Отклонить</button>
          </div>
        </div>`;
  }).join("") : '<div class="empty">Новых заявок нет</div>';

  try {
    const hist = (await window.TutorFB.listRequestDecisions(Date.now() - 60 * DAY_MS)).reverse();
    $("requestsHistory").innerHTML = hist.length ? hist.map(d => `
        <div class="session-row">
          <span class="when">${escHtml(studentLabel(d.studentId))} · ${d.type === "reschedule" ? "перенос" : d.type === "book" ? "новое занятие" : "отмена"}${d.oldStartMs ? " " + escHtml(fmtWhen(d.oldStartMs)) : ""}${(d.type === "reschedule" || d.type === "book") && d.newStartMs ? " → " + escHtml(fmtWhen(d.newStartMs)) : ""}${d.reason ? ` <span class="cls">(${escHtml(d.reason)})</span>` : ""}</span>
          <span class="amt">${d.status === "approved" ? "подтверждено" : "отклонено"}</span>
        </div>`).join("") : '<div class="empty">Пока пусто</div>';
  } catch (e) {
    $("requestsHistory").innerHTML = '<div class="empty">Не удалось загрузить</div>';
  }
}

// Семья может отозвать свою заявку, пока учитель думает над «Подтвердить /
// Отклонить» (окно подтверждения открыто). Перед изменениями перечитываем
// заявку (одно чтение): отозвана — ничего не меняем.
async function stillPending(ck, item) {
  if (await window.TutorFB.hasChannelItem(ck, item.id)) return true;
  alert("Эту заявку уже отозвали — ничего не меняю.");
  afterLessonsChanged();
  return false;
}
async function decideRequest(ck, itemId, approve) {
  const meta = channelMeta[ck];
  const item = (channelItems[ck] || []).find(i => i.id === itemId);
  if (!meta || !item) return;
  if (item.type === "book") { await decideBook(ck, item, meta, approve); return; }
  const l = await window.TutorFB.getLesson(item.lessonId);
  const valid = l && l.studentId === meta.studentId;
  let reason = "";
  if (approve) {
    if (!valid || l.status !== "planned") { alert("Это занятие уже нельзя изменить."); return; }
    if (item.type === "reschedule") {
      const probe = [{ data: { startMs: item.newStartMs, endMs: item.newEndMs } }];
      const conflicts = await findConflicts(probe, [l.id]);
      const q = conflicts.length
        ? `Новое время пересекается с: ${conflicts.map(x => x.title).join(", ")}.\nВсё равно перенести?`
        : `Перенести «${l.title}» на ${fmtWhen(item.newStartMs, item.newEndMs)}?`;
      if (!confirm(q)) return;
      if (!(await stillPending(ck, item))) return;
      await rescheduleLesson(l, item.newStartMs, item.newEndMs);
    } else {
      if (!confirm(`Отменить «${displayTitle(l.title)}», ${fmtWhen(l.startMs, l.endMs)}?`)) return;
      if (!(await stillPending(ck, item))) return;
      await setStatusScoped(l, "cancelled", "one", ["planned"]);
    }
  } else {
    const r = prompt("Причина отказа (увидит родитель/ученик, можно оставить пустым):", "");
    if (r === null) return;
    reason = r.trim().slice(0, 300);
    if (!(await stillPending(ck, item))) return;
  }
  await window.TutorFB.saveRequestDecision(item.id, decisionData(item, meta, valid ? l : null, approve ? "approved" : "rejected", reason));
  await publishViews(activeKeysOf(meta.studentId));
  await window.TutorFB.deleteChannelItems(ck, [item.id]);
  delete lessonCache[item.lessonId];
  afterLessonsChanged();
}

// ---- заявка на дополнительное занятие ----
// Что мешает подтвердить: время прошло или уже занято (занятия, личное время).
async function bookProblem(item) {
  if (!(item.newStartMs > Date.now())) return "Это время уже прошло — подтвердить нельзя.";
  const probe = [{ data: { startMs: item.newStartMs, endMs: item.newEndMs } }];
  // своё уже созданное по этой заявке занятие (сбой после создания, второе устройство) — не помеха
  const conflicts = await findConflicts(probe, [bookLessonId(item)]);
  return conflicts.length ? `Это время уже занято: ${conflicts.map(x => isPersonal(x) ? "личное время" : displayTitle(x.title)).join(", ")}.` : "";
}
// id занятия выводится из id заявки: повторное подтверждение пишет тот же документ, копий не бывает
function bookLessonId(item) { return "bk_" + item.id; }
function bookRequestHtml(ck, item, meta, warn) {
  const min = Math.round((item.newEndMs - item.newStartMs) / 60000);
  return `<div class="req" data-ck="${escHtml(ck)}" data-id="${escHtml(item.id)}">
        <div class="who">${escHtml(meta ? studentLabel(meta.studentId) : "?")} <span class="cls">· ${ROLE_RU[item.by] || escHtml(item.by)} · ${escHtml(new Date(item.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</span></div>
        <div class="what">Новое занятие: <b>${escHtml(fmtWhen(item.newStartMs, item.newEndMs))}</b> (${min} мин)</div>
        ${item.comment ? `<div class="comment">«${escHtml(item.comment)}»</div>` : ""}
        ${warn ? `<div class="warn">${escHtml(warn)}</div>` : ""}
        <div class="btn-row">
          <button class="btn" type="button" data-req="approve" ${warn ? "disabled" : ""}>Подтвердить</button>
          <button class="btn secondary" type="button" data-req="reject">Отклонить</button>
        </div>
      </div>`;
}
async function decideBook(ck, item, meta, approve) {
  let reason = "", newLessonId = null;
  if (approve) {
    // перепроверка прямо перед созданием: время могли занять, пока заявка висела
    const problem = await bookProblem(item);
    if (problem) { alert(problem + "\nЗаявку можно отклонить — семья увидит причину."); return; }
    const durMin = Math.round((item.newEndMs - item.newStartMs) / 60000);
    if (!confirm(`Добавить занятие: ${studentLabel(meta.studentId)}, ${fmtWhen(item.newStartMs, item.newEndMs)}?`)) return;
    if (!(await stillPending(ck, item))) return;
    newLessonId = bookLessonId(item);
    const prev = await window.TutorFB.getLesson(newLessonId);
    if (prev && (prev.requestId !== item.id || prev.studentId !== meta.studentId)) { alert("Не удалось создать занятие по заявке — попробуйте ещё раз или отклоните заявку."); return; }
    if (!prev) {
      // то же, что «+ Занятие»: название и studentId ученика этого канала; id — из id заявки
      const [it] = buildSeries({ base: titleOfStudent(meta.studentId), startMs: item.newStartMs, durMin, count: 1 });
      it.id = newLessonId;
      it.data.requestId = item.id;
      await window.TutorFB.saveLessons([it]);
    }
  } else {
    const r = prompt("Причина отказа (увидит родитель/ученик, можно оставить пустым):", "");
    if (r === null) return;
    reason = r.trim().slice(0, 300);
    if (!(await stillPending(ck, item))) return;
  }
  await window.TutorFB.saveRequestDecision(item.id, decisionData(item, meta, null, approve ? "approved" : "rejected", reason, newLessonId));
  await publishViews(activeKeysOf(meta.studentId));
  await window.TutorFB.deleteChannelItems(ck, [item.id]);
  afterLessonsChanged();
}

$("requestsList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-req]");
  if (!btn) return;
  const box = btn.closest(".req");
  box.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try {
    await decideRequest(box.dataset.ck, box.dataset.id, btn.dataset.req === "approve");
  } catch (err) {
    reportSaveError(err);
  }
  renderRequests();
});

// Учитель ставит/снимает «оплачено»: в занятие + в родительский канал,
// чтобы родитель увидел сразу, даже без перепубликации витрины.
async function setPaidByTeacher(l, value) {
  const at = Date.now();
  await window.TutorFB.updateLesson(l.id, { paid: { value, by: "teacher", at }, updatedAt: at });
  const ch = studentChannels()[l.studentId];
  if (ch && ch.parent && activeKeysOf(l.studentId).some(k => k.role === "parent")) {
    await window.TutorFB.addChannelItem(ch.parent, newId("t"), { type: "paid", lessonId: l.id, by: "teacher", createdAt: at, paid: value });
  }
  publishViewsSoon();
}

// При отзыве доступа: новые ключи каналов (отозванный больше не читает
// и не пишет), нерешённые заявки и последние «оплачено» переносятся.
async function rotateChannels(studentId) {
  const old = studentChannels()[studentId];
  if (!old) return;
  const fresh = { shared: newAccessKey(), parent: newAccessKey(), createdAt: Date.now() };
  for (const [oldKey, newKey] of [[old.shared, fresh.shared], [old.parent, fresh.parent]]) {
    if (!oldKey) continue;
    let items = [];
    try { items = await window.TutorFB.listChannel(oldKey); } catch (e) { /* пусто */ }
    // подписки на пуш переезжают только у тех, чей доступ ещё действует
    // (отозванный ключ — нет; старый канал целиком очищается ниже), и
    // только с отпечатком ключа, не с самим ключом
    const active = activeKeysOf(studentId);
    const byHash = await NotifyCore.pushKeyMap(active);
    const stillActive = new Set(active.map(k => k.id));
    const keep = items.filter(i => REQUEST_TYPES.includes(i.type) || i.type === "paid" || i.type === "homework" || i.type === "note"
      || (i.type === "push" && stillActive.has(NotifyCore.pushItemKey(i, byHash))));
    for (const i of keep) {
      const data = Object.assign({}, i);
      delete data.id;
      if (i.type === "push") data.key = await NotifyCore.pushKeyId(NotifyCore.pushItemKey(i, byHash));
      await window.TutorFB.addChannelItem(newKey, i.id, data);
    }
    if (items.length) await window.TutorFB.deleteChannelItems(oldKey, items.map(i => i.id));
  }
  await window.TutorFB.setStudentChannels(studentId, fresh);
  remoteState.studentChannels = Object.assign({}, studentChannels(), { [studentId]: fresh });
}
