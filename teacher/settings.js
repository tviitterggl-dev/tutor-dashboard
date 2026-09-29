// Кабинет учителя — вкладка «Настройки»: порядок вкладок, шаблоны
// сообщений, пуши самому учителю (подписка этого устройства и какие
// события присылать).

// ---- «Настройки»: порядок вкладок, уведомления мне, шаблоны, статус пушей ----
const TAB_LABELS = () => Object.fromEntries([...document.querySelectorAll(".tabs .tab")].map(t => [t.dataset.tab, t.childNodes[0].textContent.trim()]));
let tabOrderEditor = null;
// ---------- контакты «Если что — пишите» ----------
// Список { title, url } (Materials.clean, до Materials.CONTACTS_MAX) в
// state.contacts; публикуется в витрину каждого ученика (buildViews).
const contactsOf = () => Materials.clean(remoteState.contacts, Materials.CONTACTS_MAX);
const CONTACT_PH = "Например: Telegram";
function renderContacts() {
  const box = $("contactRows");
  if (box.dataset.dirty) return; // не затирать то, что набирается
  const list = contactsOf();
  box.innerHTML = (list.length ? list : [{}]).map(m => matRowHtml(m, CONTACT_PH)).join("");
}
function contactMsg(t, k) { const m = $("contactMsg"); m.textContent = t; m.className = "msg" + (k ? " " + k : ""); }
$("contactRows").addEventListener("input", () => { $("contactRows").dataset.dirty = "1"; });
$("contactRows").addEventListener("click", (e) => {
  const del = e.target.closest("[data-mat-del]");
  if (del) { del.closest(".pf-mat-row").remove(); $("contactRows").dataset.dirty = "1"; }
});
$("contactAdd").addEventListener("click", () => {
  const box = $("contactRows");
  if (box.querySelectorAll(".pf-mat-row").length >= Materials.CONTACTS_MAX) { contactMsg(`Контактов — не больше ${Materials.CONTACTS_MAX}.`, "err"); return; }
  box.insertAdjacentHTML("beforeend", matRowHtml({}, CONTACT_PH));
  box.dataset.dirty = "1";
  box.lastElementChild.querySelector(".pf-mat-title").focus();
});
$("contactSave").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const check = checkLinkRows(matRowsOf($("contactRows")), "Контакт");
  if (check.error) { contactMsg(check.error, "err"); return; }
  if (check.rows.length > Materials.CONTACTS_MAX) { contactMsg(`Контактов — не больше ${Materials.CONTACTS_MAX}.`, "err"); return; }
  if (!navigator.onLine) { contactMsg(OFFLINE_TEXT, "err"); return; }
  const contacts = Materials.clean(check.rows, Materials.CONTACTS_MAX);
  btn.disabled = true;
  try {
    await window.TutorFB.patchState({ contacts });
    remoteState.contacts = contacts;
    delete $("contactRows").dataset.dirty;
    renderContacts();
    await publishViews();
    contactMsg(contacts.length ? "Сохранено — кабинеты родителей и учеников обновлены." : "Контакты убраны — в кабинетах карточки «Если что — пишите» больше нет.", "ok");
  } catch (err) {
    contactMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});
function renderSettingsTab() {
  renderContacts();
  const labels = TAB_LABELS();
  const items = TEACHER_TABS.map(id => ({ id, label: labels[id] || id }));
  if (!tabOrderEditor) {
    tabOrderEditor = TabOrder.mountEditor($("tabOrderEditor"), {
      items, order: currentTabOrder(),
      onChange: saveTabOrder,
    });
  } else tabOrderEditor.set(currentTabOrder());
  renderTeacherPush();
  (async () => {
    try { await getAccessKeys(); } catch (e) { /* без списка доступов */ }
    renderPushStatus();
    await ensureStarterTemplates();
    renderTemplates();
  })();
}
async function saveTabOrder(order) {
  const m = $("tabOrderMsg");
  if (!navigator.onLine) { tabOrderEditor.set(currentTabOrder()); m.textContent = OFFLINE_TEXT; m.className = "msg err"; return; }
  const prev = remoteState.tabOrder;
  remoteState.tabOrder = order;
  applyTabOrder();
  try {
    await window.TutorFB.patchState({ tabOrder: order });
    m.textContent = "Сохранено — порядок одинаковый на всех твоих устройствах."; m.className = "msg ok";
  } catch (err) {
    remoteState.tabOrder = prev;
    applyTabOrder();
    tabOrderEditor.set(currentTabOrder());
    m.textContent = isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)"; m.className = "msg err";
  }
}

// ---- шаблоны сообщений ----
// state.msgTemplates.{id} = { name, title, text, updatedAt } — в пространстве
// учителя, общие для всех её устройств. В первый раз — три примера.
const TPL_STARTERS = [
  { name: "Напоминание о занятии", title: "Напоминание", text: "Напоминаю: скоро занятие. Подготовь, пожалуйста, тетрадь и домашнее задание." },
  { name: "Поздравление", title: "Поздравляю!", text: "{ученик}, поздравляю с праздником! Желаю успехов и отличного настроения." },
  { name: "Нет занятия на этой неделе", title: "Занятия не будет", text: "На этой неделе занятия не будет. Следующее — по обычному расписанию." },
];
const templates = () => remoteState.msgTemplates || {};
const tplSorted = () => Object.entries(templates()).map(([id, t]) => Object.assign({ id }, t)).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
let tplEditing = null;
function tplMsg(t, kind) { const m = $("tplMsg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
async function ensureStarterTemplates() {
  if (remoteState.msgTemplates !== undefined || !navigator.onLine) return;
  const now = Date.now();
  const seed = {};
  TPL_STARTERS.forEach((t, i) => { seed[newId("tpl")] = Object.assign({ updatedAt: now + i }, t); });
  try {
    await window.TutorFB.patchState({ msgTemplates: seed });
    remoteState.msgTemplates = seed;
  } catch (e) { /* не страшно — попробуем в следующий раз */ }
}
function renderTemplates() {
  const list = tplSorted();
  $("tplList").innerHTML = list.length ? list.map(t => `<div class="nf-item" data-tpl="${escHtml(t.id)}">
        <div class="nf-head">${escHtml(t.name || t.title || "Без названия")}</div>
        ${t.title ? `<div class="nf-meta" style="margin-top:0">Заголовок: ${escHtml(t.title)}</div>` : ""}
        <div class="nf-text">${escHtml(t.text || "")}</div>
        <div class="nf-actions">
          <button class="link-btn" type="button" data-tpl-edit>Изменить</button>
          <button class="link-btn" type="button" data-tpl-delete>Удалить</button>
        </div>
      </div>`).join("") : '<div class="empty">Шаблонов пока нет — добавь ниже.</div>';
  for (const sel of [$("nwTpl"), $("nfTpl")]) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— без шаблона —</option>' + list.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name || t.title)}</option>`).join("");
    if (prev && templates()[prev]) sel.value = prev;
  }
}
function openTplForm(t) {
  tplEditing = t ? t.id : null;
  $("tplForm").style.display = "block";
  $("tplName").value = t ? (t.name || "") : "";
  $("tplTitle").value = t ? (t.title || "") : "";
  $("tplText").value = t ? (t.text || "") : "";
  $("tplSave").textContent = t ? "Сохранить изменения" : "Сохранить шаблон";
  tplMsg("");
  $("tplName").focus();
}
function closeTplForm() { tplEditing = null; $("tplForm").style.display = "none"; }
async function saveTemplate(id, value) {
  await window.TutorFB.setTemplate(id, value);
  remoteState.msgTemplates = Object.assign({}, templates(), { [id]: value });
  if (value == null) delete remoteState.msgTemplates[id];
  renderTemplates();
}
// выбрали шаблон → подставили заголовок и текст (поправить можно)
[["nwTpl", "nwHead", "nwText"], ["nfTpl", "nfHead", "nfText"]].forEach(([sel, head, text]) => $(sel).addEventListener("change", () => {
  const t = templates()[$(sel).value];
  if (!t) return;
  if ($(text).value.trim() && $(text).value.trim() !== (t.text || "") && !confirm("Заменить уже написанный текст шаблоном?")) { $(sel).value = ""; return; }
  $(head).value = t.title || "";
  $(text).value = t.text || "";
}));
$("tplAdd").addEventListener("click", () => openTplForm(null));
$("tplCancel").addEventListener("click", closeTplForm);
$("tplSave").addEventListener("click", async (e) => {
  const name = $("tplName").value.trim().slice(0, 60);
  const title = $("tplTitle").value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
  const text = $("tplText").value.trim().slice(0, 1000);
  if (!text) { tplMsg("Напиши текст шаблона.", "err"); return; }
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await saveTemplate(tplEditing || newId("tpl"), { name: name || title || text.slice(0, 40), title, text, updatedAt: Date.now() });
    const was = !!tplEditing;
    closeTplForm();
    tplMsg(was ? "Шаблон изменён." : "Шаблон сохранён.", "ok");
  } catch (err) {
    tplMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});
$("tplList").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-tpl]");
  if (!item) return;
  const t = templates()[item.dataset.tpl];
  if (!t) return;
  if (e.target.closest("[data-tpl-edit]")) { openTplForm(Object.assign({ id: item.dataset.tpl }, t)); $("tplForm").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (e.target.closest("[data-tpl-delete]")) {
    if (!confirm(`Удалить шаблон «${t.name || t.title}»?`)) return;
    try { await saveTemplate(item.dataset.tpl, null); tplMsg("Шаблон удалён.", "ok"); }
    catch (err) { tplMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не удалилось (нет интернета?)", "err"); }
  }
});
// «Сохранить как шаблон» из формы отправки
document.querySelectorAll("[data-tpl-save]").forEach(b => b.addEventListener("click", async () => {
  const pre = b.dataset.tplSave; // nw | nf
  const title = $(pre + "Head").value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
  const text = $(pre + "Text").value.trim().slice(0, 1000);
  const msgId = pre + "Msg";
  if (!text) { nfMsg(msgId, "Сначала напиши текст — его и сохраним как шаблон.", "err"); return; }
  const name = prompt("Название шаблона (как он будет в списке):", title || text.slice(0, 40));
  if (name === null) return;
  try {
    const id = newId("tpl");
    await saveTemplate(id, { name: name.trim().slice(0, 60) || title || text.slice(0, 40), title, text, updatedAt: Date.now() });
    $(pre + "Tpl").value = id;
    nfMsg(msgId, "Шаблон сохранён — теперь его можно выбрать из списка.", "ok");
  } catch (err) {
    nfMsg(msgId, isOfflineError(err) ? OFFLINE_TEXT : "Шаблон не сохранился (нет интернета?)", "err");
  }
}));

// ---- пуши самому учителю: подписка этого устройства ----
// state.teacherDevices.{id} = { token, createdAt, device } — только в своём
// пространстве учителя; state.teacherPush = { paid, note, homework }.
// Отправляет фоновая рассылка (notifier/send.mjs → teacherPushes).
const TP_STORE = "teacherPushDevice"; // { id, token } этого устройства
const tpSaved = () => { try { return JSON.parse(localStorage.getItem(TP_STORE) || "null"); } catch (e) { return null; } };
const tpSave = (v) => { try { if (v) localStorage.setItem(TP_STORE, JSON.stringify(v)); else localStorage.removeItem(TP_STORE); } catch (e) { /* приватный режим */ } };
const tpIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const tpStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
function tpSupport() {
  if (!window.TutorPush || !window.TutorPush.hasKey()) return "Пуши пока не настроены (нет публичного ключа).";
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    return tpIOS && !tpStandalone()
      ? "На iPhone уведомления приходят, только если кабинет открыт со значка на экране «Домой» (Safari → «Поделиться» → «На экран «Домой»»)."
      : "Этот браузер не умеет получать уведомления.";
  }
  if (Notification.permission === "denied") return "Уведомления для этого сайта запрещены в настройках браузера или телефона — разрешите их там и обновите страницу.";
  return "";
}
const tpDevices = () => remoteState.teacherDevices || {};
const tpOn = () => { const m = tpSaved(); return !!(m && tpDevices()[m.id] && "Notification" in window && Notification.permission === "granted"); };
function tpMsg(t, kind) { const m = $("tpMsg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : ""); }
function renderTeacherPush() {
  const el = $("tpBody");
  const prefs = remoteState.teacherPush || {};
  document.querySelectorAll("[data-tp]").forEach(c => { c.checked = prefs[c.dataset.tp] !== false; });
  const n = Object.keys(tpDevices()).length;
  const devLine = n ? `<div class="hint" style="margin-top:6px">Подписано устройств: ${n}.</div>` : "";
  const why = tpSupport();
  if (why) { el.innerHTML = `<div class="hint" style="margin-top:0">${escHtml(why)}</div>${devLine}`; return; }
  el.innerHTML = tpOn()
    ? `<div>Приходят на это устройство ✓</div><div class="btn-row"><button class="btn secondary" type="button" id="tpTest">Проверить</button><button class="btn secondary" type="button" id="tpOff">Выключить на этом устройстве</button></div>${devLine}`
    : `<div class="btn-row" style="margin-top:0"><button class="btn" type="button" id="tpOnBtn">Включить на этом устройстве</button></div>${devLine}`;
  if ($("tpOnBtn")) $("tpOnBtn").addEventListener("click", enableTeacherPush);
  if ($("tpOff")) $("tpOff").addEventListener("click", disableTeacherPush);
  if ($("tpTest")) $("tpTest").addEventListener("click", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      await reg.showNotification("Оплата", { body: "Так будут выглядеть уведомления: «Маша, 7 класс: родитель отметил «Оплачено»…»", icon: "icons/icon-192.png" });
      tpMsg("Уведомление показано.", "ok");
    } catch (e) { tpMsg("Не получилось показать уведомление.", "err"); }
  });
}
// Разрешение — первым делом и синхронно в нажатии (Safari на iPhone).
function tpAskPermission() {
  return new Promise((resolve) => {
    const r = Notification.requestPermission(resolve);
    if (r && typeof r.then === "function") r.then(resolve, () => resolve("denied"));
  });
}
async function enableTeacherPush() {
  if (!navigator.onLine) { tpMsg(OFFLINE_TEXT, "err"); return; }
  const permission = tpAskPermission();
  const btn = $("tpOnBtn");
  if (btn) btn.disabled = true;
  tpMsg("Включаю…");
  try {
    if ((await permission) !== "granted") throw Object.assign(new Error("perm"), { userText: "Без разрешения уведомления не придут. Если передумаете — разрешите их и нажмите ещё раз." });
    const reg = await navigator.serviceWorker.register("sw.js");
    const token = await window.TutorPush.token(reg);
    if (!token) throw Object.assign(new Error("token"), { userText: "Устройство не выдало адрес для уведомлений — попробуйте ещё раз." });
    const old = tpSaved();
    const id = old && tpDevices()[old.id] ? old.id : newId("d");
    const value = { token, createdAt: Date.now(), device: tpIOS ? "iPhone/iPad" : /Android/.test(navigator.userAgent) ? "Android" : "компьютер" };
    await window.TutorFB.setTeacherDevice(id, value);
    remoteState.teacherDevices = Object.assign({}, tpDevices(), { [id]: value });
    tpSave({ id, token });
    renderTeacherPush();
    tpMsg("Готово! Уведомления об оплате, пояснениях и ДЗ будут приходить на это устройство.", "ok");
  } catch (err) {
    console.error(err);
    renderTeacherPush();
    tpMsg(err.userText || (isOfflineError(err) ? OFFLINE_TEXT : "Не получилось включить уведомления. Проверьте интернет и попробуйте ещё раз."), "err");
  }
}
async function disableTeacherPush() {
  const m = tpSaved();
  if (!m) return;
  try {
    await window.TutorFB.setTeacherDevice(m.id, null);
    const rest = Object.assign({}, tpDevices());
    delete rest[m.id];
    remoteState.teacherDevices = rest;
    tpSave(null);
    renderTeacherPush();
    tpMsg("Уведомления на этом устройстве выключены.", "ok");
  } catch (err) {
    tpMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не получилось выключить (нет интернета?)", "err");
  }
}
document.querySelectorAll("[data-tp]").forEach(c => c.addEventListener("change", async () => {
  const prefs = Object.assign({ paid: true, note: true, homework: true }, remoteState.teacherPush || {}, { [c.dataset.tp]: c.checked });
  try {
    await window.TutorFB.patchState({ teacherPush: prefs });
    remoteState.teacherPush = prefs;
    tpMsg("Сохранено.", "ok");
  } catch (err) {
    c.checked = !c.checked;
    tpMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?)", "err");
  }
}));
