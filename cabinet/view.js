"use strict";
// Кабинет семьи — витрина: открыть кабинет по ключу (openCabinet — живая
// подписка на витрину и каналы), сохранённая на устройстве копия для
// работы без сети и плашка «офлайн», переключатель детей.

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
