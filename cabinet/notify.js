"use strict";
// Кабинет семьи — уведомления: сообщения и напоминания от преподавателя
// (показ N раз, счётчик на устройстве) и пуш на телефон (подписка через
// Firebase Cloud Messaging; разрешение — синхронно в нажатии, для iPhone).

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
