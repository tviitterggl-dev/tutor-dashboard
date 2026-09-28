// Кабинет учителя (index.html): запуск — вход, первая загрузка, обработчики
// кнопок. Код кабинета разложен по файлам в папке teacher/; они подключаются
// обычными <script src> по порядку (без сборки) и делят одно общее
// пространство имён — см. REVIEW.md, «Как устроен код кабинета учителя».

let appStarted = false;
let appStarting = false;
async function startApp() {
  if (appStarting) return;
  appStarting = true;
  try { await startAppInner(); } finally { appStarting = false; }
}
async function startAppInner() {
  const user = window.TutorAuth.user;
  if (!user) { authPanel("authSignIn"); return; }
  let has;
  try {
    has = await window.TutorAuth.hasSpace(user.uid);
  } catch (err) {
    authPanel("authSignIn");
    authMsg(isPermissionDenied(err)
      ? "База пока не пускает по входу — нужно обновить правила (firebase deploy, см. DEVLOG.md)."
      : "Нет связи с базой — проверь интернет и обнови страницу.", "err");
    return;
  }
  if (!has) {
    if (window.TutorAuth.legacyKey) { setTimeout(() => runMigration(window.TutorAuth.legacyKey, true), 0); return; }
    authPanel("authMigrate");
    authMsg("");
    return;
  }
  if (appStarted) return;
  appStarted = true;
  $("userBadge").textContent = user.email || "";
  $("accountInfo").textContent = "Вход выполнен: " + (user.email || "");
  afterAuth();
}

async function afterAuth() {
  showApp();
  if (!(await bootstrapRemoteState())) return;
  showTab(applyTabOrder()[0]); // первая вкладка в своём порядке — «главная»
  await startChannelWatch();
  publishViewsSoon(); // раз в заход освежаем «занято» в кабинетах родителей
  refreshPackageAlertsSoon();
}

// ---------- УЧЕНИКИ ----------

// Ручные правки пакетов: { [studentKey]: { doneOverride, totalOverride, hidden, manual } }
// Хранятся в Firestore вместе с отметками (поле pkgOverrides документа state/main).
let packageOverrides = {};
async function loadPackageOverrides() {
  // Состояние уже загружено при входе (afterAuth → bootstrapRemoteState).
  // Здесь просто на всякий случай подтягиваем свежую версию — если открыт
  // дашборд на двух устройствах сразу, при заходе на вкладку "Ученики"
  // увидим последние изменения, а не устаревший кэш из памяти вкладки.
  try {
    const remote = await window.TutorFB.loadState();
    if (remote) {
      packageOverrides = remote.pkgOverrides || {};
      marks = Object.assign({}, marks, remote.marks || {});
    }
  } catch (e) {
    console.error("Не удалось обновить пакеты из Firestore, показываю то, что в памяти", e);
  }
}
function savePackageOverride(key) {
  const v = packageOverrides[key];
  window.TutorFB.setPkgOverride(key, v == null ? null : v).catch(reportSaveError);
  publishViewsSoon();
}

// СТАРАЯ схема (до 2026-09-27), нужна только для переноса: разбираем занятия с суффиксом "N/M" в названии, группируем по ученику,
// делим на циклы (новый цикл — когда номер не больше предыдущего в
// хронологии), текущий пакет — последний уже начавшийся цикл.
function legacyComputePackages(evs) {
  const withPkg = evs
    .map(ev => {
      const pkg = parsePackage(ev.summary || "");
      const parsed = parseLesson(ev.summary || "");
      if (!pkg || !parsed) return null;
      const start = new Date(ev.start.dateTime || ev.start.date);
      return { ev, pkg, parsed, start, key: studentKey(ev) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const byStudent = {};
  withPkg.forEach(item => {
    (byStudent[item.key] = byStudent[item.key] || []).push(item);
  });

  const packages = [];
  Object.keys(byStudent).forEach(key => {
    const items = byStudent[key];
    const cycles = [];
    let cur = [];
    let prevNum = 0;
    items.forEach(item => {
      if (item.pkg.current <= prevNum && cur.length) { cycles.push(cur); cur = []; }
      cur.push(item);
      prevNum = item.pkg.current;
    });
    if (cur.length) cycles.push(cur);
    if (!cycles.length) return;

    // Текущий пакет — последний уже начавшийся (следующий пакет, заранее
    // поставленный в расписание, не подменяет идущий); если ни один ещё не
    // начался — первый.
    const nowMs = Date.now();
    const started = cycles.filter(c => c[0].start.getTime() <= nowMs);
    const activeCycle = started.length ? started[started.length - 1] : cycles[0];
    const total = Math.max(...activeCycle.map(i => i.pkg.total));
    const rate = findRate(activeCycle[0].parsed.name, activeCycle[0].parsed.cls, activeCycle[0].parsed.surname);

    let doneCount = 0, doneSum = 0;
    const doneIds = [];
    activeCycle.forEach(item => {
      const mark = marks[item.ev.id];
      if (mark && mark.marked) {
        doneCount++;
        doneIds.push(item.ev.id);
        const amount = effectiveAmountFor(item.ev, mark);
        if (amount != null && !Number.isNaN(amount)) doneSum += amount;
      }
    });
    const remaining = Math.max(0, total - doneCount);
    const unearned = rate != null ? remaining * rate : null;

    packages.push({ key, total, doneCount, remaining, doneSum, unearned, rate, doneIds });
  });

  return packages.sort((a, b) => a.key.localeCompare(b.key, "ru"));
}

// Накладывает ручные правки на авто-найденные пакеты: скрытие, ручная
// подмена "всего"/"проведено", и полностью вручную добавленные пакеты.
function legacyBuildPackages(evs) {
  const auto = legacyComputePackages(evs);
  const autoByKey = {};
  auto.forEach(p => { autoByKey[p.key] = p; });

  const manualKeys = Object.keys(packageOverrides).filter(k => packageOverrides[k] && packageOverrides[k].manual);
  const allKeys = new Set([...Object.keys(autoByKey), ...manualKeys]);

  const result = [];
  allKeys.forEach(key => {
    const ov = packageOverrides[key] || {};
    if (ov.hidden) return;
    const base = autoByKey[key] || null;
    if (!base && !ov.manual) return;

    const total = ov.totalOverride != null ? ov.totalOverride : (base ? base.total : 8);
    // «Проведено» = автоподсчёт по отметкам «Провёл» + ручная поправка.
    // Поправка хранится разницей (doneAdjust), поэтому новые отметки
    // продолжают считаться. Пакет, добавленный вручную, считает отметки
    // «Провёл» у этого ученика с момента добавления (countFrom) поверх
    // введённого тогда числа (doneBase).
    let doneCount;
    if (base) doneCount = ov.doneAdjust != null ? base.doneCount + ov.doneAdjust
      : ov.doneOverride != null ? ov.doneOverride : base.doneCount; // старое «замороженное» — до переноса
    else doneCount = (ov.doneBase != null ? ov.doneBase : (ov.doneOverride || 0)) + manualDone(key, ov.countFrom, evs);
    doneCount = Math.max(0, doneCount);
    const remaining = Math.max(0, total - doneCount);

    let rate = base ? base.rate : null;
    if (rate == null) {
      const sp = splitStudentId(key);
      if (sp) rate = findRate(sp.name, sp.cls, sp.surname);
    }
    const doneSum = base && ov.doneAdjust == null && ov.doneOverride == null
      ? base.doneSum
      : (base ? base.doneSum + ((doneCount - base.doneCount) * (rate || 0)) : (rate != null ? doneCount * rate : 0));
    const unearned = rate != null ? remaining * rate : null;

    result.push({
      key, total, doneCount, remaining, doneSum, unearned, rate,
      isManual: !base,
      autoDone: base ? base.doneCount : doneCount,
      doneIds: base ? base.doneIds : [],
      isOverridden: !!ov.doneAdjust || ov.doneOverride != null || ov.totalOverride != null,
    });
  });

  return result.sort((a, b) => a.key.localeCompare(b.key, "ru"));
}

// Пакет = счётчик «проведено X из N» по ученику. Номеров «k/M» в названиях
// больше нет: каждое занятие ученика, отмеченное «Провёл» после начала
// пакета (countFrom — время начала/правки), прибавляет 1 к doneBase.
// Отмены и переносы на счётчик не влияют — считается только «Провёл».
// pkgOverrides[studentId] = { manual: true, totalOverride: N, doneBase, countFrom, hidden }.
function buildPackages(evs) {
  const result = [];
  Object.entries(packageOverrides).forEach(([key, ov]) => {
    if (!ov || !ov.manual || ov.hidden) return;
    const total = ov.totalOverride > 0 ? ov.totalOverride : 8;
    const doneCount = Math.max(0, (ov.doneBase != null ? ov.doneBase : (ov.doneOverride || 0)) + manualDone(key, ov.countFrom, evs));
    const remaining = Math.max(0, total - doneCount);
    const sp = splitStudentId(key);
    const baseRate = sp ? findRate(sp.name, sp.cls, sp.surname) : null;
    const pkgRate = pkgPriceOf(ov, baseRate);
    const rate = pkgRate != null ? pkgRate : baseRate; // цена занятия в этом пакете
    result.push({
      key, total, doneCount, remaining, rate, baseRate, price: pkgRate != null ? ov.price : null, since: ov.countFrom || null,
      doneSum: rate != null ? doneCount * rate : 0,
      unearned: rate != null ? remaining * rate : null,
    });
  });
  return result.sort((a, b) => a.key.localeCompare(b.key, "ru"));
}

// Сколько занятий ученика отмечено «Провёл» с момента countFrom (по времени
// нажатия «Провёл»; у старых отметок без markedAt — по updatedAt).
function manualDone(key, countFrom, evs) {
  if (countFrom == null) return 0;
  return (evs || []).filter(ev => {
    const m = marks[ev.id];
    if (!m || !m.marked) return false;
    const at = m.markedAt != null ? m.markedAt : (m.updatedAt || 0);
    const sid = (ev._lesson && ev._lesson.studentId) || studentKey(ev);
    return at >= countFrom && sid === key;
  }).length;
}

// Разовый переход на новую схему, два шага с отдельными флагами:
//  1) каждый пакет, найденный по номерам «k/M», становится счётчиком с тем
//     же «X из N» на сегодня → сохраняем счётчики и state.pkgByMarks = 1;
//  2) только ПОСЛЕ этого убираем «k/M» из названий всех занятий →
//     state.pkgTitlesClean = 1.
// Обрыв между шагами не теряет прогресс: счётчики уже сохранены, а
// названия дочистятся при следующем открытии (шаг 2 повторяемый).
let pkgMigration = null;
function ensurePkgMigrated(evs) {
  if (remoteState.pkgByMarks && remoteState.pkgTitlesClean) return Promise.resolve(false);
  if (!pkgMigration) pkgMigration = migrateToMarkPackages(evs).finally(() => { pkgMigration = null; });
  return pkgMigration;
}
async function migrateToMarkPackages(evs) {
  // свежее состояние: второе устройство могло уже сделать шаг 1
  const fresh = await window.TutorFB.loadState();
  if (fresh) {
    remoteState.pkgByMarks = fresh.pkgByMarks;
    remoteState.pkgTitlesClean = fresh.pkgTitlesClean;
    if (fresh.pkgByMarks) packageOverrides = fresh.pkgOverrides || {};
  }
  const now = Date.now();
  if (!remoteState.pkgByMarks) {
    migratePackageOverrides(evs);
    const next = {};
    legacyBuildPackages(evs).forEach(p => {
      // baseIds — какие отмеченные занятия уже вошли в doneBase (снятие «Провёл» с них — −1)
      next[p.key] = { manual: true, totalOverride: p.total, doneBase: p.doneCount, countFrom: now, hidden: false, baseIds: (p.doneIds || []).slice(0, 500) };
    });
    Object.entries(packageOverrides).forEach(([key, ov]) => {
      if (!ov || next[key]) return;
      if (ov.hidden) next[key] = { manual: true, totalOverride: ov.totalOverride || 8, doneBase: ov.doneBase || 0, countFrom: ov.countFrom || now, hidden: true };
    });
    const removed = Object.keys(packageOverrides).filter(k => !next[k]);
    // счётчики и флаг — одной записью (всё или ничего)
    await window.TutorFB.patchState({ pkgOverrides: next, pkgByMarks: 1 });
    for (const k of removed) await window.TutorFB.setPkgOverride(k, null); // ключи, которых нет в next
    packageOverrides = next;
    remoteState.pkgOverrides = next;
    remoteState.pkgByMarks = 1;
  }
  // шаг 2: номера из названий — у всех занятий (и прошлых, и будущих)
  const all = await window.TutorFB.listLessons(0, now + 10 * 365 * DAY_MS);
  const renames = all.filter(l => PKG_SUFFIX_RE.test(l.title || "") && !isPersonal(l))
    .map(l => ({ id: l.id, merge: true, data: { title: baseTitle(l.title), updatedAt: now } }));
  if (renames.length) await window.TutorFB.saveLessons(renames);
  await window.TutorFB.patchState({ pkgTitlesClean: 1 });
  remoteState.pkgTitlesClean = 1;
  return true;
}
// Разовый перенос старых правок на новую схему (без изменения видимых чисел).
function migratePackageOverrides(evs) {
  const autoByKey = Object.fromEntries(legacyComputePackages(evs).map(p => [p.key, p]));
  Object.entries(packageOverrides).forEach(([key, ov]) => {
    if (!ov) return;
    let changed = false;
    if (!ov.manual && ov.doneOverride != null && ov.doneAdjust == null && autoByKey[key]) {
      ov.doneAdjust = ov.doneOverride - autoByKey[key].doneCount;
      ov.doneOverride = null;
      changed = true;
    }
    if (ov.manual && ov.countFrom == null) {
      ov.doneBase = ov.doneOverride || 0;
      ov.doneOverride = null;
      ov.countFrom = Date.now();
      changed = true;
    }
    if (changed) savePackageOverride(key);
  });
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// «Пакет заканчивается»: осталось 1–2 занятия — пора предложить продление;
// 0 — пакет закончился.
function pkgEnding(p) {
  if (!p || !p.total) return null;
  if (p.remaining <= 0) return { cls: "pkg-over", text: "Пакет закончился — предложи продление", short: "пакет закончился" };
  if (p.remaining <= 2) return { cls: "pkg-warn", text: `Осталось ${p.remaining} ${p.remaining === 1 ? "занятие" : "занятия"} — пора предложить продление`, short: `пакет: осталось ${p.remaining}` };
  return null;
}
let lastPackagesByKey = {};

// Плашка наверху (видна с любой вкладки) — у кого пакет на исходе.
function renderPkgAlert(packages) {
  const ending = packages.filter(p => pkgEnding(p));
  const el = $("pkgAlert");
  el.style.display = ending.length ? "block" : "none";
  el.textContent = ending.length ? "Пакет заканчивается: " + ending.map(p => `${studentLabel(p.key)} (${pkgEnding(p).short})`).join(", ") : "";
}
let pkgAlertTimer = null;
// Пакет считается по занятиям за полгода назад (раньше — 3 недели: при
// занятиях раз в неделю первые проведённые выпадали из подсчёта).
const PKG_PAST_DAYS = 180;
const PKG_FUTURE_DAYS = 240;
async function fetchPackageEvents() {
  const now = Date.now();
  const load = () => fetchLessons(new Date(now - PKG_PAST_DAYS * DAY_MS), new Date(now + PKG_FUTURE_DAYS * DAY_MS));
  const evs = await load();
  // первый запуск после обновления — перенос на счётчики (названия меняются)
  if (await ensurePkgMigrated(evs)) { afterLessonsChanged(); return load(); }
  return evs;
}
// После отметки «Провёл» (и любых правок занятий) пакеты пересчитываются
// сами: плашка, вкладка «Ученики», кабинеты родителей.
function refreshPackageAlertsSoon() {
  clearTimeout(pkgAlertTimer);
  pkgAlertTimer = setTimeout(async () => {
    try {
      const evs = await fetchPackageEvents();
      loadMarksFor(evs.map(e => e.id));
      lastPackageEvents = evs;
      const pk = buildPackages(evs);
      lastPackagesByKey = Object.fromEntries(pk.map(p => [p.key, p]));
      renderPkgAlert(pk);
      // Открытую «Исправить»/«Новый пакет» не трогаем: перерисовка закрыла бы
      // её вместе с набранным. Свежие данные уже в lastPackageEvents — их
      // покажет перерисовка после «Сохранить» / при следующем открытии вкладки.
      if (activeTab === "students") { if (!pkgPanelOpen()) renderPackages(pk); renderStudentsRoster(); }
      publishViewsSoon();
    } catch (e) { /* не критично */ }
  }, 800);
}
$("pkgAlert").addEventListener("click", () => showTab("students"));

// Поля «Предоплата пакета» (добавить / исправить / новый пакет)
function priceFieldsHtml(price) {
  const m = (price && price.mode) || "";
  const opt = (v, t) => `<option value="${v}"${m === v ? " selected" : ""}>${t}</option>`;
  return `<div class="pkg-price">
        <label class="pkg-lbl">Предоплата пакета<select class="pkg-input pkg-price-mode">${opt("", "без скидки")}${opt("pct", "скидка %")}${opt("total", "цена пакета")}</select></label>
        <label class="pkg-lbl pkg-price-val-wrap" style="display:${m ? "flex" : "none"}"><span class="pkg-price-unit">${m === "pct" ? "скидка, %" : "₽ за весь пакет"}</span><input type="number" class="pkg-input pkg-price-val" min="0" inputmode="decimal" value="${price && price.value != null ? escAttr(price.value) : ""}"></label>
      </div><div class="hint pkg-price-hint" style="margin-top:0"></div>`;
}
function readPrice(box) {
  const mode = box.querySelector(".pkg-price-mode").value;
  if (!mode) return { ok: true, price: null };
  const value = parseFloat(box.querySelector(".pkg-price-val").value);
  if (!(value > 0) || (mode === "pct" && value >= 100)) return { ok: false };
  return { ok: true, price: { mode, value } };
}
const fmtPct = (x) => `${(Math.round(x * 10) / 10).toLocaleString("ru-RU")}%`;
// «1 350 ₽ за занятие вместо 1 500 ₽ · 5 400 ₽ за 4»
function priceSummary(price, total, rate) {
  const per = pkgPriceOf({ price, totalOverride: total }, rate);
  if (per == null) return price && price.mode === "pct" && rate == null ? "Ставка ученика не найдена — укажи цену за весь пакет." : "";
  const sum = price.mode === "total" ? price.value : per * total;
  const disc = rate ? (price.mode === "pct" ? price.value : (1 - sum / (rate * total)) * 100) : null;
  return { per, sum, disc, rate };
}
function updatePriceHint(box, total, rate) {
  if (!box || !box.querySelector(".pkg-price-mode")) return;
  const mode = box.querySelector(".pkg-price-mode").value;
  box.querySelector(".pkg-price-val-wrap").style.display = mode ? "flex" : "none";
  box.querySelector(".pkg-price-unit").textContent = mode === "pct" ? "скидка, %" : "₽ за весь пакет";
  const r = readPrice(box);
  const hint = box.querySelector(".pkg-price-hint");
  if (!mode) { hint.textContent = ""; return; }
  if (!r.ok) { hint.textContent = mode === "pct" ? "Скидка — от 0 до 100%." : "Впиши цену за весь пакет."; return; }
  const x = priceSummary(r.price, total > 0 ? total : 8, rate);
  hint.textContent = typeof x === "string" ? x
    : `= ${rub(x.per)} за занятие${x.rate != null ? ` вместо ${rub(x.rate)}` : ""} · ${rub(x.sum)} за ${total > 0 ? total : 8}`;
}
function rateOfKey(key) { const sp = splitStudentId(key); return sp ? findRate(sp.name, sp.cls, sp.surname) : null; }

function renderPackages(packages) {
  lastPackagesByKey = Object.fromEntries(packages.map(p => [p.key, p]));
  renderPkgAlert(packages);
  const list = $("packagesList");
  const hiddenKeys = Object.keys(packageOverrides).filter(k => packageOverrides[k] && packageOverrides[k].hidden);

  const cardsHtml = packages.map(p => {
    const pct = Math.max(0, Math.min(100, Math.round((p.doneCount / p.total) * 100)));
    const moneyLine = p.rate != null
      ? `<div class="pkg-money"><span class="earned">${p.doneSum.toLocaleString("ru-RU")} ₽ отработано</span><span class="left">не отработано ещё: ~${p.unearned.toLocaleString("ru-RU")} ₽</span></div>`
      : `<div class="pkg-money"><span class="left">ставка не найдена — сумма не посчитана</span></div>`;
    const ending = pkgEnding(p);
    return `
        <div class="pkg-card${ending ? " " + ending.cls : ""}" data-key="${escAttr(p.key)}">
          <div class="pkg-head">
            <div class="pkg-name">${escHtml(studentLabel(p.key))}</div>
            <div class="pkg-progress-text">${p.doneCount} из ${p.total}, осталось ${p.remaining}</div>
          </div>
          ${ending ? `<div class="pkg-ending">${escHtml(ending.text)}</div>` : ""}
          <div class="pkg-bar"><div class="pkg-bar-fill" style="width:${pct}%"></div></div>
          ${moneyLine}
          ${p.price ? (() => { const x = priceSummary(p.price, p.total, p.baseRate); return typeof x === "string" ? "" : `<div class="pkg-price-line">Предоплата: ${rub(x.sum)} за ${p.total} · ${rub(x.per)} за занятие${x.disc != null && x.disc > 0 ? ` (скидка ${fmtPct(x.disc)})` : ""}</div>`; })() : ""}
          <div class="btn-row" style="margin-top:8px; margin-bottom:0;">
            <button class="btn secondary pkg-edit-btn" type="button">Исправить</button>
            <button class="btn secondary pkg-new-btn" type="button">Новый пакет</button>
          </div>
          ${p.since ? `<div class="pkg-since">с ${escHtml(new Date(p.since).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }))} : каждое «Провёл» +1</div>` : ""}
          <div class="pkg-edit-panel" style="display:none; margin-top:8px;">
            <div style="display:flex; gap:6px; margin-bottom:6px;">
              <label class="pkg-lbl">Проведено<input type="number" class="pkg-input pkg-edit-done" min="0" inputmode="numeric" value="${p.doneCount}"></label>
              <label class="pkg-lbl">из (всего в пакете)<input type="number" class="pkg-input pkg-edit-total" min="1" inputmode="numeric" value="${p.total}"></label>
            </div>
            ${priceFieldsHtml(p.price)}
            <div class="btn-row">
              <button class="btn pkg-save-btn" type="button">Сохранить</button>
              <button class="btn secondary pkg-hide-btn" type="button">Убрать из списка</button>
            </div>
          </div>
          <div class="pkg-new-panel" style="display:none; margin-top:8px;">
            <div class="hint" style="margin-top:0">Новый пакет: счётчик начнётся с 0, дальше считаются отметки «Провёл».</div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
              <label class="pkg-lbl">Занятий в новом пакете<input type="number" class="pkg-input pkg-new-total" min="1" max="200" inputmode="numeric" value="${p.total}"></label>
            </div>
            ${priceFieldsHtml(p.price)}
            <div class="btn-row">
              <button class="btn pkg-new-save" type="button">Начать новый пакет</button>
              <button class="btn secondary pkg-new-cancel" type="button">Отмена</button>
            </div>
          </div>
        </div>
      `;
  }).join("");

  const emptyHtml = packages.length ? "" : '<div class="empty">Пакетов пока нет — добавь ниже</div>';

  const hiddenHtml = hiddenKeys.length ? `
      <div class="hint" style="margin-top:2px">Скрытые пакеты:
        ${hiddenKeys.map(k => `<button type="button" class="pkg-unhide-btn" data-key="${escAttr(k)}" style="background:none;border:none;color:var(--accent-2);text-decoration:underline;cursor:pointer;font-size:11.5px;padding:0 4px;">${escHtml(studentLabel(k))} ×</button>`).join("")}
      </div>` : "";

  list.innerHTML = cardsHtml + emptyHtml + hiddenHtml;
}

function getPackageOverride(key) {
  return packageOverrides[key] || { doneOverride: null, totalOverride: null, hidden: false, manual: false };
}

let lastPackageEvents = [];

async function loadPackages() {
  $("packagesList").innerHTML = '<div class="empty">Загрузка…</div>';
  await loadPackageOverrides();
  try {
    lastPackageEvents = await fetchPackageEvents();
    loadMarksFor(lastPackageEvents.map(e => e.id));
    renderPackages(buildPackages(lastPackageEvents));
  } catch (e) {
    $("packagesList").innerHTML = '<div class="empty">Не удалось загрузить пакеты</div>';
  }
}

const pkgPanelOpen = () => [...$("packagesList").querySelectorAll(".pkg-edit-panel, .pkg-new-panel")].some(p => p.style.display !== "none");

function rerenderPackages() {
  renderPackages(buildPackages(lastPackageEvents));
}

$("packagesList").addEventListener("click", (e) => {
  const unhideBtn = e.target.closest(".pkg-unhide-btn");
  if (unhideBtn) {
    const key = unhideBtn.dataset.key;
    const ov = getPackageOverride(key);
    ov.hidden = false;
    packageOverrides[key] = ov;
    savePackageOverride(key);
    rerenderPackages();
    return;
  }
  const card = e.target.closest(".pkg-card");
  if (!card) return;
  const key = card.dataset.key;

  if (e.target.closest(".pkg-edit-btn")) {
    const panel = card.querySelector(".pkg-edit-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block") updatePriceHint(panel, parseInt(panel.querySelector(".pkg-edit-total").value, 10), rateOfKey(key));
    return;
  }
  if (e.target.closest(".pkg-save-btn")) {
    const total = parseInt(card.querySelector(".pkg-edit-total").value, 10);
    const done = parseInt(card.querySelector(".pkg-edit-done").value, 10);
    if (!(total >= 1) || !(done >= 0)) { alert("Проведено — число от 0, всего — от 1"); return; }
    const pr = readPrice(card.querySelector(".pkg-edit-panel"));
    if (!pr.ok) { alert("Проверь предоплату: скидка — от 0 до 100%, цена за пакет — больше 0."); return; }
    const ov = getPackageOverride(key);
    // с этого момента новые «Провёл» прибавляются к введённому числу
    Object.assign(ov, { manual: true, totalOverride: total, doneBase: done, countFrom: Date.now(), doneOverride: null, doneAdjust: null, baseIds: null, price: pr.price });
    packageOverrides[key] = ov;
    savePackageOverride(key);
    rerenderPackages();
    return;
  }
  if (e.target.closest(".pkg-new-btn") || e.target.closest(".pkg-new-cancel")) {
    const panel = card.querySelector(".pkg-new-panel");
    panel.style.display = panel.style.display === "none" && e.target.closest(".pkg-new-btn") ? "block" : "none";
    if (panel.style.display === "block") updatePriceHint(panel, parseInt(panel.querySelector(".pkg-new-total").value, 10), rateOfKey(key));
    return;
  }
  if (e.target.closest(".pkg-new-save")) {
    const panel = card.querySelector(".pkg-new-panel");
    const total = parseInt(panel.querySelector(".pkg-new-total").value, 10);
    if (!(total >= 1 && total <= 200)) { alert("Число занятий — от 1 до 200"); return; }
    const pr = readPrice(panel);
    if (!pr.ok) { alert("Проверь предоплату: скидка — от 0 до 100%, цена за пакет — больше 0."); return; }
    packageOverrides[key] = { manual: true, totalOverride: total, doneBase: 0, countFrom: Date.now(), hidden: false, baseIds: [], price: pr.price };
    savePackageOverride(key);
    rerenderPackages();
    return;
  }
  if (e.target.closest(".pkg-hide-btn")) {
    const ov = getPackageOverride(key);
    ov.hidden = true;
    packageOverrides[key] = ov;
    savePackageOverride(key);
    rerenderPackages();
    return;
  }
});

const onPkgPriceInput = (e) => {
  const box = e.target.closest(".pkg-edit-panel, .pkg-new-panel");
  if (!box) return;
  const key = box.closest(".pkg-card").dataset.key;
  updatePriceHint(box, parseInt(box.querySelector(".pkg-edit-total, .pkg-new-total").value, 10), rateOfKey(key));
};
$("packagesList").addEventListener("input", onPkgPriceInput);
$("packagesList").addEventListener("change", onPkgPriceInput);
const pkgAddRate = () => {
  const name = $("pkgAddName").value.trim(), cls = parseInt($("pkgAddCls").value, 10);
  const sur = $("pkgAddSurname").value.trim();
  return name && !Number.isNaN(cls) ? findRate(name, cls, sur ? fixSurname(sur) : "") : null;
};
const onPkgAddInput = () => updatePriceHint($("pkgAddForm"), parseInt($("pkgAddTotal").value, 10), pkgAddRate());
$("pkgAddForm").addEventListener("input", onPkgAddInput);
$("pkgAddForm").addEventListener("change", onPkgAddInput);
$("pkgAddBtn").addEventListener("click", () => {
  const form = $("pkgAddForm");
  form.style.display = form.style.display === "none" ? "block" : "none";
  if (!$("pkgAddPrice").firstChild) $("pkgAddPrice").innerHTML = priceFieldsHtml(null);
});
$("pkgAddCancelBtn").addEventListener("click", () => { $("pkgAddForm").style.display = "none"; });
$("pkgAddSaveBtn").addEventListener("click", () => {
  const nameRaw = $("pkgAddName").value.trim();
  const name = nameRaw ? nameRaw[0].toUpperCase() + nameRaw.slice(1) : "";
  const surnameRaw = $("pkgAddSurname").value.trim();
  const cls = parseInt($("pkgAddCls").value, 10);
  const total = parseInt($("pkgAddTotal").value, 10) || 8;
  const done = parseInt($("pkgAddDone").value, 10) || 0;
  if (!name || Number.isNaN(cls)) { alert("Укажи имя и класс"); return; }
  if (surnameRaw && !SURNAME_RE.test(surnameRaw)) { alert("Фамилия — одним словом, русскими буквами"); return; }
  // С фамилией — отдельный пакет («Маша Иванова, 7 класс»), без — как раньше.
  const key = makeStudentId(name, cls, fixSurname(surnameRaw));
  if (packageOverrides[key] && packageOverrides[key].manual && !packageOverrides[key].hidden) { alert("Такой пакет уже есть. Если это другой ученик с тем же именем — укажи фамилию."); return; }
  const pr = readPrice($("pkgAddForm"));
  if (!pr.ok) { alert("Проверь предоплату: скидка — от 0 до 100%, цена за пакет — больше 0."); return; }
  packageOverrides[key] = { manual: true, totalOverride: total, doneBase: done, countFrom: Date.now(), hidden: false, price: pr.price };
  savePackageOverride(key);
  $("pkgAddName").value = ""; $("pkgAddSurname").value = ""; $("pkgAddCls").value = ""; $("pkgAddTotal").value = "8"; $("pkgAddDone").value = "0";
  $("pkgAddPrice").innerHTML = priceFieldsHtml(null);
  $("pkgAddForm").style.display = "none";
  rerenderPackages();
});

// ---------- ПРОФИЛИ УЧЕНИКОВ ----------
// state/main.studentProfiles["Имя, N класс"] = { callUrl, accessUrl, notes, updatedAt }.
// В витрины родителя/ученика попадают ОБЕ ссылки: callUrl — «Подключиться»
// у занятий, accessUrl — кнопка «Доска» у ближайших занятий. Заметки,
// ставка и остальное профиля — только у учителя.
const studentProfiles = () => remoteState.studentProfiles || {};
const profileOf = (studentId) => (studentId && studentProfiles()[studentId]) || {};
// Цена группового занятия из профиля (null — не задана)
function groupRateOf(sid) {
  const p = studentProfiles()[profileIdCI(sid) || sid];
  return p && !p.hidden && typeof p.groupRate === "number" ? p.groupRate : null;
}
const safeHref = (u) => /^https?:\/\//i.test(u || "");
let openProfile = null;

// Ссылка на созвон для занятия: своя у занятия (разовая) → у группы → из профиля ученика.
function callLinkFor(l) {
  if (l && l.callUrl && safeHref(l.callUrl)) return { url: l.callUrl, own: true };
  const g = l && l.groupId ? groupsMap()[l.groupId] : null;
  if (g && g.callUrl && safeHref(g.callUrl)) return { url: g.callUrl, own: false, group: true };
  const p = profileOf(l && l.studentId);
  return p.callUrl && safeHref(p.callUrl) ? { url: p.callUrl, own: false } : null;
}

// Все ученики = профили с именем и классом (удалённые не показываем).
// id — ключ профиля («Имя, N класс» или «Имя Фамилия, N класс»);
// idSurname — фамилия, входящая в id (и в названия занятий);
// surname — фамилия для показа (из id или просто заполненная в профиле).
function studentList() {
  return Object.entries(studentProfiles())
    .filter(([, p]) => p && p.name && p.cls && !p.hidden)
    .map(([id, p]) => {
      const idSurname = (splitStudentId(id) || {}).surname || "";
      return { id, name: p.name, idSurname, surname: idSurname || p.surname || "", cls: Number(p.cls), rate: typeof p.rate === "number" ? p.rate : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru") || a.cls - b.cls || a.surname.localeCompare(b.surname, "ru"));
}
// Начало названия занятия для ученика: «Маша 7 класс» / «Маша Иванова 7 класс».
const titleBaseOf = (st) => `${st.name}${st.idSurname ? " " + st.idSurname : ""} ${st.cls} класс`;

function rosterStudents() {
  return studentList().map(st => ({
    id: st.id,
    label: `${st.name}${st.surname ? " " + st.surname : ""}`,
    cls: st.cls,
    rate: st.rate,
  }));
}

// Черновики в карточках учеников. Список перерисуется и сам (фоновая
// загрузка пакетов, возврат на вкладку), а набранное, но не сохранённое
// при этом стиралось бы. Перед перерисовкой запоминаем изменённые поля
// (значение ≠ исходному), фокус и курсор, после — возвращаем. Если данные
// поля успели измениться (например, только что сохранили) — берём новые.
const PF_FIELDS = [".pf-surname", ".pf-cls", ".pf-rate", ".pf-grate", ".pf-call", ".pf-access", ".pf-notes"];
const ADD_FIELDS = ["#stAddName", "#stAddSurname", "#stAddCls", "#stAddRate"];
function captureRosterDrafts(list) {
  const cards = {};
  list.querySelectorAll(".student-card").forEach(card => {
    const fields = {};
    PF_FIELDS.forEach(sel => {
      const el = card.querySelector(sel);
      if (el && el.value !== el.defaultValue) fields[sel] = { value: el.value, base: el.defaultValue };
    });
    const m = card.querySelector(".pf-msg");
    const msg = m && m.textContent ? { text: m.textContent, cls: m.className } : null;
    if (Object.keys(fields).length || msg) cards[card.dataset.student] = { fields, msg };
  });
  const form = $("stAddForm");
  const add = form ? {
    open: form.style.display !== "none",
    values: Object.fromEntries(ADD_FIELDS.map(sel => [sel, (list.querySelector(sel) || {}).value || ""])),
    msg: $("stAddMsg") ? { text: $("stAddMsg").textContent, cls: $("stAddMsg").className } : null,
  } : null;
  const a = document.activeElement;
  let focus = null;
  if (a && list.contains(a)) {
    const card = a.closest(".student-card");
    const sel = a.id ? "#" + a.id : PF_FIELDS.find(f => a.matches(f));
    if (sel) focus = { sid: card ? card.dataset.student : null, sel, start: a.selectionStart, end: a.selectionEnd };
  }
  return { cards, add, focus };
}
function restoreRosterDrafts(list, d, opts) {
  const cardEl = (sid) => list.querySelector(`.student-card[data-student="${CSS.escape(sid)}"]`);
  for (const [sid, saved] of Object.entries(d.cards)) {
    const card = cardEl(sid);
    if (!card) continue;
    for (const [sel, f] of Object.entries(saved.fields)) {
      const el = card.querySelector(sel);
      if (el && el.defaultValue === f.base) el.value = f.value; // данные не менялись — черновик в силе
    }
    const m = card.querySelector(".pf-msg");
    if (m && saved.msg) { m.textContent = saved.msg.text; m.className = saved.msg.cls; }
  }
  if (d.add && !opts.resetAddForm) {
    const form = $("stAddForm");
    if (form && d.add.open) form.style.display = "block";
    ADD_FIELDS.forEach(sel => { const el = list.querySelector(sel); if (el && d.add.values[sel]) el.value = d.add.values[sel]; });
    if (d.add.msg && $("stAddMsg")) { $("stAddMsg").textContent = d.add.msg.text; $("stAddMsg").className = d.add.msg.cls; }
  }
  if (d.focus) {
    const scope = d.focus.sid ? cardEl(d.focus.sid) : list;
    const el = scope && scope.querySelector(d.focus.sel);
    if (el && el.offsetParent !== null) {
      el.focus({ preventScroll: true });
      try { if (d.focus.start != null) el.setSelectionRange(d.focus.start, d.focus.end); } catch (e) { /* number: курсора нет */ }
    }
  }
}

// Группы, в которых ученик (карточка ученика): состав и кнопка «изменить».
function studentGroupsHtml(sid) {
  const gs = Object.entries(groupsMap()).filter(([, g]) => g && (g.members || []).includes(sid));
  if (!gs.length) return "";
  return `<div class="field"><span>Групповые занятия</span>${gs.map(([gid, g]) => `<div class="st-group" data-group="${escHtml(gid)}">
        <b>${escHtml(groupLabel(gid))}</b>: ${escHtml((g.members || []).map(shortName).join(", "))}
        <button class="link-btn" type="button" data-g-edit="${escHtml(gid)}">изменить состав</button></div>`).join("")}</div>`;
}

function renderStudentsRoster(opts = {}) {
  const list = $("studentsRosterList");
  const drafts = captureRosterDrafts(list);
  const students = rosterStudents();
  const addForm = `
      <div class="btn-row" style="margin-bottom:8px"><button class="btn secondary block" type="button" id="stAddToggle">+ Добавить ученика</button></div>
      <div id="stAddForm" style="display:none; margin-bottom:10px">
        <div class="field-row">
          <div class="field"><span>Имя (одним словом)</span><input type="text" id="stAddName" maxlength="30" placeholder="Например: Маша"></div>
          <div class="field"><span>Фамилия (необяз.)</span><input type="text" id="stAddSurname" maxlength="40" placeholder="Нужна, если уже есть Маша этого класса"></div>
          <div class="field" style="max-width:110px"><span>Класс</span><input type="number" id="stAddCls" min="1" max="11"></div>
          <div class="field" style="max-width:140px"><span>Ставка, ₽ (необяз.)</span><input type="number" id="stAddRate" min="0" step="50"></div>
        </div>
        <div class="btn-row" style="margin-bottom:0"><button class="btn" type="button" id="stAddSave">Добавить</button></div>
        <div class="msg" id="stAddMsg"></div>
      </div>`;
  if (!students.length) {
    list.innerHTML = addForm + '<div class="empty">Учеников пока нет (или не загрузились ставки)</div>';
    restoreRosterDrafts(list, drafts, opts);
    return;
  }
  list.innerHTML = addForm + students.map(st => {
    const p = profileOf(st.id);
    const isOpen = openProfile === st.id;
    const tags = [p.callUrl ? "созвон" : "", p.accessUrl ? "материалы" : "", p.notes ? "заметки" : ""].filter(Boolean).join(" · ");
    return `
      <div class="student-card${isOpen ? " open" : ""}" data-student="${escHtml(st.id)}">
        <div class="student-head">
          <div>
            <div class="name">${escHtml(st.label)}</div>
            <div class="agg">${st.cls ? escHtml(st.cls) + " класс" : ""}${tags ? " · " + escHtml(tags) : ""}${pkgEnding(lastPackagesByKey[st.id]) ? ` <span class="pkg-tag${lastPackagesByKey[st.id].remaining <= 0 ? " over" : ""}">${escHtml(pkgEnding(lastPackagesByKey[st.id]).short)}</span>` : ""}</div>
          </div>
          <div style="display:flex; align-items:center; gap:10px">
            ${st.rate != null ? `<div class="rate" style="font-weight:700;color:var(--accent-2)">${st.rate.toLocaleString("ru-RU")} ₽</div>` : '<div class="cls">ставка не задана</div>'}
            <div class="chev">▸</div>
          </div>
        </div>
        <div class="student-body">
          <div class="field" style="margin-top:10px"><span>Фамилия (необязательно)</span>
            <input type="text" class="pf-surname" maxlength="40" placeholder="Например: Иванова" value="${escHtml(st.surname || "")}"></div>
          <div class="field-row">
            <div class="field" style="max-width:120px"><span>Класс</span>
              <input type="number" class="pf-cls" min="1" max="11" value="${escHtml(st.cls)}"></div>
            <div class="field" style="max-width:180px"><span>Ставка за занятие, ₽</span>
              <input type="number" class="pf-rate" min="0" step="50" value="${st.rate != null ? st.rate : ""}"></div>
            <div class="field" style="max-width:200px"><span>Групповое занятие, ₽</span>
              <input type="number" class="pf-grate" min="0" step="50" placeholder="как обычная" value="${typeof p.groupRate === "number" ? p.groupRate : ""}"></div>
          </div>
          ${studentGroupsHtml(st.id)}
          <div class="field"><span>Ссылка на созвон (постоянная, видна родителю и ученику)</span>
            <input type="url" class="pf-call" maxlength="500" placeholder="https://telemost.yandex.ru/…" value="${escHtml(p.callUrl || "")}"></div>
          <div class="field"><span>Ссылка на доску / материалы (видна родителю и ученику)</span>
            <input type="url" class="pf-access" maxlength="500" placeholder="доска, папка с материалами, платформа…" value="${escHtml(p.accessUrl || "")}"></div>
          <div class="field"><span>Заметки (видишь только ты)</span>
            <textarea class="pf-notes" maxlength="10000" placeholder="Что уже прошли, что планируем дальше…">${escHtml(p.notes || "")}</textarea></div>
          <div class="btn-row" style="margin-bottom:0">
            <button class="btn" type="button" data-pf-save>Сохранить</button>
            ${p.callUrl && safeHref(p.callUrl) ? `<a class="btn secondary" href="${escHtml(p.callUrl)}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">Открыть созвон</a>` : ""}
            ${p.accessUrl && safeHref(p.accessUrl) ? `<a class="btn secondary" href="${escHtml(p.accessUrl)}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center">Материалы</a>` : ""}
          </div>
          <div class="msg pf-msg"></div>
          <div class="btn-row" style="margin:12px 0 0; justify-content:flex-end">
            <button class="btn danger" type="button" data-st-delete>Удалить ученика…</button>
          </div>
        </div>
      </div>`;
  }).join("");
  restoreRosterDrafts(list, drafts, opts);
}

$("studentsRosterList").addEventListener("click", async (e) => {
  if (e.target.closest("#stAddToggle")) {
    const f = $("stAddForm");
    f.style.display = f.style.display === "none" ? "block" : "none";
    return;
  }
  if (e.target.closest("#stAddSave")) { addStudentFromForm(); return; }
  const card = e.target.closest(".student-card");
  if (!card) return;
  const sid = card.dataset.student;
  if (e.target.closest("[data-st-delete]")) { openDeleteStudentModal(sid); return; }
  const gEdit = e.target.closest("[data-g-edit]");
  if (gEdit) { openGroupEditor(gEdit.dataset.gEdit); return; }
  if (e.target.closest(".student-head")) {
    openProfile = openProfile === sid ? null : sid;
    card.classList.toggle("open", openProfile === sid);
    $("studentsRosterList").querySelectorAll(".student-card").forEach(c => { if (c !== card) c.classList.remove("open"); });
    return;
  }
  const saveBtn = e.target.closest("[data-pf-save]");
  if (!saveBtn) return;
  const msg = card.querySelector(".pf-msg");
  const callUrl = card.querySelector(".pf-call").value.trim();
  const accessUrl = card.querySelector(".pf-access").value.trim();
  const notes = card.querySelector(".pf-notes").value.trim();
  const clsNew = parseInt(card.querySelector(".pf-cls").value, 10);
  if (!(clsNew >= 1 && clsNew <= 11)) { msg.textContent = "Класс — число от 1 до 11"; msg.className = "msg pf-msg err"; return; }
  const surnameRaw = card.querySelector(".pf-surname").value.trim();
  if (surnameRaw && !SURNAME_RE.test(surnameRaw)) { msg.textContent = "Фамилия — одним словом, русскими буквами (можно через дефис)"; msg.className = "msg pf-msg err"; return; }
  const surnameNew = fixSurname(surnameRaw);
  const rateRaw = card.querySelector(".pf-rate").value.trim();
  const rate = rateRaw === "" ? null : parseFloat(rateRaw);
  if (rate != null && !(rate >= 0)) { msg.textContent = "Ставка — число (или оставь пустой)"; msg.className = "msg pf-msg err"; return; }
  const grateRaw = card.querySelector(".pf-grate").value.trim();
  const groupRate = grateRaw === "" ? null : parseFloat(grateRaw);
  if (groupRate != null && !(groupRate >= 0)) { msg.textContent = "Цена группового занятия — число (или оставь пустой)"; msg.className = "msg pf-msg err"; return; }
  for (const u of [callUrl, accessUrl]) {
    if (u && !safeHref(u)) { msg.textContent = "Ссылка должна начинаться с https:// (или http://)"; msg.className = "msg pf-msg err"; return; }
  }
  saveBtn.disabled = true;
  let target = sid;
  let note = "Сохранено";
  try {
    const prof = profileOf(sid);
    // Фамилия в идентификаторе (ученик заведён с фамилией) — её смена, как
    // и смена класса, переименовывает занятия; иначе фамилия только для показа.
    const idSurname = (splitStudentId(sid) || {}).surname || "";
    const surnameInId = idSurname ? surnameNew : "";
    const clsChanged = clsNew !== Number(prof.cls);
    if (clsChanged || surnameInId !== idSurname) {
      const n = (await window.TutorFB.listLessonsOfStudent(sid)).length;
      const what = clsChanged ? `Перевести «${prof.name}» в ${clsNew} класс?` : `Сменить фамилию «${studentLabel(sid)}» на «${surnameNew || "без фамилии"}»?`;
      if (!confirm(`${what}\n\nИзменится название у всех занятий ученика (${n}, включая прошедшие), а отметки «Провёл», оплата, пакет, отчёты, ДЗ, заявки и ссылки родителей/ученика сохранятся.`)) {
        saveBtn.disabled = false;
        return;
      }
      target = await renameStudent(sid, prof.name, clsNew, surnameInId);
      note = clsChanged ? `Сохранено: теперь ${clsNew} класс` : "Сохранено";
    }
    const value = Object.assign({}, profileOf(target), { surname: surnameNew, rate, groupRate, callUrl, accessUrl, notes, updatedAt: Date.now() });
    await window.TutorFB.setStudentProfile(target, value);
    const all = Object.assign({}, studentProfiles());
    all[target] = value;
    remoteState.studentProfiles = all;
    openProfile = target;
    publishViewsSoon(); // ссылка на созвон появится в кабинете ученика
    renderStudentsRoster();
    const m = $("studentsRosterList").querySelector(`.student-card[data-student="${CSS.escape(target)}"] .pf-msg`);
    if (m) { m.textContent = note; m.className = "msg pf-msg ok"; }
  } catch (err) {
    console.error(err);
    saveBtn.disabled = false;
    msg.textContent = err.userText || "Не сохранилось (нет интернета?)";
    msg.className = "msg pf-msg err";
  }
});

// Смена класса = новый идентификатор ученика «Имя, N класс». Он записан в
// занятиях (название + studentId), профиле, правках пакета, каналах,
// ключах доступа и журнале заявок — меняем всё сразу, чтобы связи не
// порвались. Отметки «Провёл» привязаны к id занятий и не меняются.
async function renameStudent(oldId, name, cls, surname) {
  const newSid = makeStudentId(name, cls, surname || "");
  if (newSid === oldId) return oldId;
  const clash = studentProfiles()[newSid];
  if (clash && !clash.hidden) {
    const err = new Error("exists");
    err.userText = `Ученик «${newSid}» уже есть — сначала переименуй или удали его.`;
    throw err;
  }
  const now = Date.now();
  // Начало названия у занятий этого ученика: «Имя N класс» / «Имя Фамилия N класс».
  const old = splitStudentId(oldId) || { name, surname: "", cls: 0 };
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escRe(old.name)}${old.surname ? "\\s+" + escRe(old.surname) : ""}\\s+${old.cls}\\s*класс`, "iu");
  const newBase = `${name}${surname ? " " + surname : ""} ${cls} класс`;
  const lessons = await window.TutorFB.listLessonsOfStudent(oldId);
  await window.TutorFB.saveLessons(lessons.map(l => ({
    id: l.id, merge: true,
    data: { title: re.test(l.title) ? l.title.replace(re, newBase) : l.title, studentId: newSid, updatedAt: now },
  })));
  const prof = Object.assign({}, profileOf(oldId), { name, cls, updatedAt: now }, surname ? { surname } : {});
  await window.TutorFB.setStudentProfile(newSid, prof);
  await window.TutorFB.setStudentProfile(oldId, null);
  const profs = Object.assign({}, studentProfiles(), { [newSid]: prof });
  delete profs[oldId];
  remoteState.studentProfiles = profs;
  if (packageOverrides[oldId]) {
    packageOverrides[newSid] = packageOverrides[oldId];
    delete packageOverrides[oldId];
    await window.TutorFB.setPkgOverride(newSid, packageOverrides[newSid]);
    await window.TutorFB.setPkgOverride(oldId, null);
  }
  const ch = studentChannels()[oldId];
  if (ch) {
    await window.TutorFB.setStudentChannels(newSid, ch);
    await window.TutorFB.setStudentChannels(oldId, null);
    const map = Object.assign({}, studentChannels(), { [newSid]: ch });
    delete map[oldId];
    remoteState.studentChannels = map;
  }
  // состав групп: тот же ученик под новым идентификатором
  for (const [gid, g] of Object.entries(groupsMap())) {
    if (g && (g.members || []).includes(oldId)) await saveGroup(gid, Object.assign({}, g, { members: g.members.map(x => (x === oldId ? newSid : x)), updatedAt: now }));
  }
  const keys = (await getAccessKeys(true)).filter(k => k.studentId === oldId);
  for (const k of keys) await window.TutorFB.saveAccessKey(k.id, { studentId: newSid });
  const decisions = (await window.TutorFB.listRequestDecisions(0)).filter(d => d.studentId === oldId);
  for (const d of decisions) {
    const data = Object.assign({}, d, { studentId: newSid });
    delete data.id;
    await window.TutorFB.saveRequestDecision(d.id, data);
  }
  if (lastStudentChoice.toLowerCase().startsWith(name.toLowerCase() + " ")) lastStudentChoice = "";
  await getAccessKeys(true);
  await startChannelWatch();
  await publishViews(activeKeysOf(newSid));
  afterLessonsChanged();
  return newSid;
}

const SURNAME_RE = /^[А-ЯЁа-яё]+(-[А-ЯЁа-яё]+)?$/;
const fixSurname = (s) => s ? s.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join("-") : "";

async function addStudentFromForm() {
  const msg = (t, k) => { $("stAddMsg").textContent = t; $("stAddMsg").className = "msg" + (k ? " " + k : ""); };
  const name = $("stAddName").value.trim();
  const surnameRaw = $("stAddSurname").value.trim();
  const cls = parseInt($("stAddCls").value, 10);
  const rateRaw = $("stAddRate").value.trim();
  const rate = rateRaw === "" ? null : parseFloat(rateRaw);
  // Имя одним русским словом — иначе занятия «Имя N класс» не распознаются.
  if (!/^[А-ЯЁа-яё]+$/.test(name)) { msg("Имя — одним словом, русскими буквами (так его узнают занятия: «Маша 7 класс»).", "err"); return; }
  if (surnameRaw && !SURNAME_RE.test(surnameRaw)) { msg("Фамилия — одним словом, русскими буквами (можно через дефис).", "err"); return; }
  if (!(cls >= 1 && cls <= 11)) { msg("Класс — число от 1 до 11.", "err"); return; }
  if (rate != null && !(rate >= 0)) { msg("Ставка — число (или оставь пустой).", "err"); return; }
  const nameFixed = name[0].toUpperCase() + name.slice(1);
  const surname = fixSurname(surnameRaw);
  // С фамилией она входит в идентификатор и в названия занятий:
  // «Маша Иванова, 7 класс» — отдельный ученик от «Маша, 7 класс».
  const id = makeStudentId(nameFixed, cls, surname);
  const exists = studentList().some(st => st.id.toLowerCase() === id.toLowerCase());
  if (exists) { msg(surname ? "Такой ученик уже есть в списке." : "Такой ученик уже есть в списке. Если это другой ученик с тем же именем — укажи фамилию.", "err"); return; }
  const prev = profileOf(profileIdCI(id) || id);
  const value = Object.assign({}, prev.hidden ? {} : prev, {
    hidden: false, name: nameFixed, surname: surname || (prev.hidden ? "" : prev.surname || ""), cls, rate, createdAt: Date.now(), updatedAt: Date.now(),
  });
  try {
    await window.TutorFB.setStudentProfile(id, value);
    remoteState.studentProfiles = Object.assign({}, studentProfiles(), { [id]: value });
    openProfile = id;
    renderStudentsRoster({ resetAddForm: true }); // добавили — форма снова пустая
    if (activeTab === "students") loadAccessCard();
  } catch (err) {
    msg("Не сохранилось (нет интернета?)", "err");
  }
}

async function openDeleteStudentModal(sid) {
  let lessons = [], keys = [];
  try {
    lessons = await window.TutorFB.listLessonsOfStudent(sid);
    keys = (await getAccessKeys(true)).filter(k => k.active && k.studentId === sid);
  } catch (e) { /* покажем что есть */ }
  const now = Date.now();
  const future = lessons.filter(l => l.startMs >= now && l.status !== "done");
  const past = lessons.filter(l => !(l.startMs >= now && l.status !== "done"));
  openModal(`
      <h2>Удалить ученика «${escHtml(studentLabel(sid))}»?</h2>
      <div class="banner" style="margin-top:8px">
        <div>Будет удалено:</div>
        <ul style="margin:6px 0 0; padding-left:18px">
          <li>профиль: ставка, ссылки и заметки;</li>
          <li>будущие занятия: <b>${future.length}</b>;</li>
          <li>доступы родителей/учеников: <b>${keys.length}</b> (ссылки сразу перестанут работать), заявки и загруженные ими файлы в очереди;</li>
          <li>ручные правки пакета.</li>
        </ul>
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="delPast"> Удалить и прошедшие занятия (${past.length}) — вместе с отметками «Провёл»; из «Итогов» и заработка они тоже пропадут</label>
      <div class="hint">${past.length ? "Если не отмечать — прошедшие занятия останутся в истории и в заработке." : ""} Отменить удаление нельзя.</div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn danger" type="button" id="delConfirm">Удалить ученика</button>
        <button class="btn secondary" type="button" id="mClose">Отмена</button>
      </div>`);
  mq("#mClose").addEventListener("click", closeModal);
  mq("#delConfirm").addEventListener("click", async (e) => {
    const btn = e.currentTarget; // после await у события его уже нет
    btn.disabled = true;
    modalMsg("Удаляю…");
    try {
      await deleteStudent(sid, mq("#delPast").checked);
      closeModal();
      openProfile = null;
      renderStudentsRoster();
      loadAccessCard();
      loadPackages();
      afterLessonsChanged();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg("Удалилось не всё (нет интернета?). Нажми ещё раз — повтор безопасен.", "err");
    }
  });
}

async function deleteStudent(sid, withPast) {
  const now = Date.now();
  const lessons = await window.TutorFB.listLessonsOfStudent(sid);
  const doomed = lessons.filter(l => withPast || (l.startMs >= now && l.status !== "done"));
  await window.TutorFB.deleteLessons(doomed.map(l => l.id));
  // из групп — убрать (его копии занятий группы удалены выше)
  for (const [gid, g] of Object.entries(groupsMap())) {
    if (g && (g.members || []).includes(sid)) await saveGroup(gid, Object.assign({}, g, { members: g.members.filter(x => x !== sid), updatedAt: now }));
  }
  if (withPast) {
    const markIds = doomed.map(l => l.id).filter(id => marks[id]);
    await window.TutorFB.deleteMarks(markIds);
    markIds.forEach(id => { delete marks[id]; });
  }
  // Доступы: витрины удаляем, ключи помечаем отозванными (история остаётся).
  const keys = (await getAccessKeys(true)).filter(k => k.active && k.studentId === sid);
  for (const k of keys) {
    await window.TutorFB.deleteView(k.role, k.id);
    await window.TutorFB.saveAccessKey(k.id, { active: false, revokedAt: now, revokedReason: "student-deleted" });
  }
  const ch = studentChannels()[sid];
  if (ch) {
    for (const ck of [ch.shared, ch.parent].filter(Boolean)) {
      const items = await window.TutorFB.listChannel(ck).catch(() => []);
      if (items.length) await window.TutorFB.deleteChannelItems(ck, items.map(i => i.id));
    }
    await window.TutorFB.setStudentChannels(sid, null);
    const map = Object.assign({}, studentChannels());
    delete map[sid];
    remoteState.studentChannels = map;
  }
  if (packageOverrides[sid]) {
    delete packageOverrides[sid];
    await window.TutorFB.setPkgOverride(sid, null);
  }
  await window.TutorFB.setStudentProfile(sid, null);
  const profs = Object.assign({}, studentProfiles());
  delete profs[sid];
  remoteState.studentProfiles = profs;
  await getAccessKeys(true);
  startChannelWatch();
}

// ---------- РАСПИСАНИЕ ----------

function getSchedWeek() {
  const base = new Date();
  base.setDate(base.getDate() + schedWeekOffset * 7);
  const mon = mondayOf(base);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    days.push(d);
  }
  const nextMon = new Date(mon);
  nextMon.setDate(mon.getDate() + 7);
  return { mon, nextMon, days };
}

const SCHED_START_HOUR = 8;
const SCHED_END_HOUR = 22;

async function loadSchedule() {
  const week = getSchedWeek();
  $("schedLabel").textContent = `${fmtShort(week.mon)} – ${fmtShort(week.days[6])}`;
  $("schedTable").innerHTML = '<tr><td class="empty">Загрузка…</td></tr>';

  try {
    const allEvs = (await fetchLessons(week.mon, week.nextMon, { includePersonal: true })).filter(e => e.start && e.start.dateTime && e.end && e.end.dateTime);
    renderSchedule(week, allEvs);
  } catch (e) {
    $("schedTable").innerHTML = '<tr><td class="empty">Не удалось загрузить</td></tr>';
  }
}

function renderSchedule(week, evs) {
  const busy = week.days.map(() => new Set());

  evs.forEach(ev => {
    const start = new Date(ev.start.dateTime);
    const end = new Date(ev.end.dateTime);
    week.days.forEach((day, idx) => {
      const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
      if (end <= dayStart || start >= dayEnd) return;
      for (let h = SCHED_START_HOUR; h < SCHED_END_HOUR; h++) {
        const hourStart = new Date(day); hourStart.setHours(h, 0, 0, 0);
        const hourEnd = new Date(day); hourEnd.setHours(h + 1, 0, 0, 0);
        if (start < hourEnd && end > hourStart) busy[idx].add(h);
      }
    });
  });

  const dayNames = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  const p = (n) => String(n).padStart(2, "0");

  let html = "<thead><tr><th class=\"time-col\">Время</th>";
  week.days.forEach((d, idx) => {
    html += `<th>${p(d.getDate())}.${p(d.getMonth() + 1)}<br>(${dayNames[idx]})</th>`;
  });
  html += "</tr></thead><tbody>";

  for (let h = SCHED_START_HOUR; h < SCHED_END_HOUR; h++) {
    html += `<tr><td class="time-col">${p(h)}:00</td>`;
    week.days.forEach((d, idx) => {
      const isBusy = busy[idx].has(h);
      html += `<td class="${isBusy ? "busy" : "free"}">${isBusy ? "занято" : "своб."}</td>`;
    });
    html += "</tr>";
  }
  html += "</tbody>";
  $("schedTable").innerHTML = html;
}

// Один промис на скрипт: повторный вызов во время загрузки ждёт ту же
// загрузку, а не считает скрипт уже готовым.
const scriptLoads = {};
function loadScriptOnce(src) {
  if (!scriptLoads[src]) {
    scriptLoads[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptLoads[src]; reject(new Error("script load failed")); };
      document.head.appendChild(s);
    });
  }
  return scriptLoads[src];
}

function showPngModal(dataUrl, canvas) {
  openModal(`
      <h2>Картинка расписания</h2>
      <div class="meta">Зажми картинку пальцем → «Сохранить в Фото». Или нажми «Поделиться», чтобы сразу отправить в мессенджер.</div>
      <img class="png-preview" id="pngPreview" alt="Свободные окна">
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="pngShare">Поделиться…</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>`);
  mq("#pngPreview").src = dataUrl;
  mq("#mClose").addEventListener("click", closeModal);
  let file = null;
  canvas.toBlob((b) => { if (b) file = new File([b], "raspisanie.png", { type: "image/png" }); }, "image/png");
  mq("#pngShare").addEventListener("click", async () => {
    if (!file) { modalMsg("Картинка ещё готовится, нажми через секунду."); return; }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Свободные окна" }); } catch (e) { /* закрыли меню */ }
    } else {
      modalMsg("Этот браузер не умеет делиться файлом — зажми картинку и сохрани её.", "err");
    }
  });
}

async function exportScheduleImage() {
  const btn = $("schedExportBtn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Готовлю картинку…";
  try {
    if (typeof html2canvas === "undefined") {
      await loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
    }
    const cardBg = getComputedStyle(document.documentElement).getPropertyValue("--card-bg").trim() || "#FFFFFF";
    const textColor = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1C1D21";

    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.left = "-9999px";
    wrap.style.top = "0";
    wrap.style.padding = "18px";
    wrap.style.background = cardBg;
    wrap.style.width = "fit-content";
    wrap.style.fontFamily = "Manrope, -apple-system, sans-serif";

    const title = document.createElement("div");
    title.style.fontFamily = "Spectral, Georgia, serif";
    title.style.fontWeight = "600";
    title.style.fontSize = "18px";
    title.style.color = textColor;
    title.style.marginBottom = "10px";
    title.textContent = "Свободные окна: " + $("schedLabel").textContent;
    wrap.appendChild(title);

    // Картинка — в тех же пропорциях, что таблица на странице: берём её
    // фактическую ширину. (Раньше min-width стирался, и в обёртке
    // fit-content таблица сжималась до минимума — «занято» в две строки.)
    const liveW = Math.round($("schedTable").getBoundingClientRect().width);
    const tableClone = $("schedTable").cloneNode(true);
    tableClone.style.width = liveW + "px";
    tableClone.style.minWidth = liveW + "px";
    wrap.appendChild(tableClone);

    document.body.appendChild(wrap);
    const canvas = await html2canvas(wrap, { backgroundColor: cardBg, scale: 2 });
    document.body.removeChild(wrap);

    const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    if (isIOS) {
      // Safari на iPhone блокирует window.open, вызванный не прямо в
      // нажатии (а мы до этого ждали html2canvas), и игнорирует download.
      // Поэтому показываем картинку прямо на странице: её можно зажать
      // пальцем → «Сохранить в Фото», или нажать «Поделиться» (это уже
      // новое нажатие, тут Safari разрешает системное меню).
      const dataUrl = canvas.toDataURL("image/png");
      showPngModal(dataUrl, canvas);
    } else {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = "raspisanie.png";
      link.href = blobUrl;
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }
  } catch (e) {
    alert("Не удалось сохранить картинку, попробуй ещё раз");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ---------- ДОСТУПЫ РОДИТЕЛЕЙ И УЧЕНИКОВ ----------
// У каждого родителя/ученика свой ключ. Кабинет (cabinet.html) читает
// только «витрину» parentAccess/{ключ} или studentAccess/{ключ}: там
// занятия одного ребёнка и чужие слоты как «занято» без имён. Витрины
// собирает и перезаписывает этот кабинет учителя после любых изменений.

const VIEW_PAST_DAYS = 120;
const VIEW_FUTURE_DAYS = 90;
const PARENT_WINDOW_DAYS = 28; // окно кабинета семьи: 4 недели назад и 4 вперёд
const DAY_MS = 86400000;
let accessKeysCache = null;

function newAccessKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cabinetUrl(role, key) {
  const dir = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${dir}cabinet.html#${role === "parent" ? "p" : "s"}=${key}`;
}
async function getAccessKeys(force) {
  if (!accessKeysCache || force) accessKeysCache = await window.TutorFB.listAccessKeys();
  return accessKeysCache;
}

async function buildViews(keys) {
  const now = Date.now();
  // Окно кабинета семьи (сетка занятости и validRange календаря): 4 недели
  // назад и 4 вперёд от сегодня, по понедельникам — ровная сетка недель.
  const prevMonday = mondayOf(new Date(now - PARENT_WINDOW_DAYS * DAY_MS));
  const busyFrom = prevMonday.getTime();
  const busyTo = mondayOf(new Date()).getTime() + PARENT_WINDOW_DAYS * DAY_MS;
  const all = await window.TutorFB.listLessons(now - VIEW_PAST_DAYS * DAY_MS, now + VIEW_FUTURE_DAYS * DAY_MS);
  let decisions = [];
  try {
    decisions = await window.TutorFB.listRequestDecisions(now - 365 * DAY_MS); // история заявок в кабинете — за год
  } catch (e) { /* журнал заявок недоступен (старые правила) — без него */ }
  const channels = studentChannels();
  // пакеты — тем же подсчётом, что во вкладке «Ученики» (за полгода)
  const pkgEvs = await fetchPackageEvents().catch(() => all.filter(l => isActiveStatus(l.status)).map(lessonToEv));
  const pkgs = buildPackages(pkgEvs);
  const rules = await getNotifications().catch(() => []); // до деплоя правил — без уведомлений

  return keys.map(k => {
    const own = all.filter(l => l.studentId === k.studentId);
    // своё групповое занятие — не «занято» (копии других участников в то же время)
    // (только идущие копии: «не придёт» или перенос — время группы для семьи снова занято)
    const ownOcc = new Set(own.filter(l => isActiveStatus(l.status)).map(l => l.groupOcc).filter(Boolean));
    const seen = new Set();
    const busy = all
      .filter(l => isActiveStatus(l.status) && l.studentId !== k.studentId && l.endMs > busyFrom && l.startMs < busyTo && !(l.groupOcc && ownOcc.has(l.groupOcc)))
      .map(l => ({ s: l.startMs, e: l.endMs }))
      .filter(b => { const key = b.s + ":" + b.e; if (seen.has(key)) return false; seen.add(key); return true; });
    const ch = channels[k.studentId] || {};
    // Всё ниже — только про ЭТОГО ученика (фильтр по studentId); чужие
    // занятия попадают в busy без имён и без id.
    const view = {
      v: 1,
      role: k.role,
      studentId: k.studentId,
      studentLabel: studentLabel(k.studentId), // «Имя Фамилия, N класс» для заголовка кабинета
      generatedAt: now,
      busyFrom,
      busyTo,
      channel: ch.shared || null,
      // Ссылка на доску/материалы из профиля ученика (поле «Ссылка на
      // занятие / доступ») — видна родителю и ученику у ближайших занятий.
      boardUrl: (() => { const u = profileOf(k.studentId).accessUrl; return u && safeHref(u) ? u : null; })(),
      lessons: own.map(l => {
        const out = {
          id: l.id,
          startMs: l.startMs,
          endMs: l.endMs,
          status: l.status,
          pkg: pkgSuffix(l.title).trim() || null,
          report: l.report || "",
          homework: (Array.isArray(l.homework) ? l.homework : []).map(h => ({ url: h.url, name: h.name || "файл", by: h.by || "teacher" })),
          // Ссылка на созвон (разовая у занятия или из профиля ученика).
          // Из профиля в кабинет уходят только две ссылки — эта и boardUrl
          // (доска/материалы, выше); заметки и ставка остаются у учителя.
          callUrl: isActiveStatus(l.status) && callLinkFor(l) ? callLinkFor(l).url : null,
        };
        if (isGroupCopy(l)) out.group = true; // только отметка — кто ещё в группе, семья не видит
        if (l.familyNote && l.familyNote.text) out.familyNote = { text: String(l.familyNote.text).slice(0, 1000), by: l.familyNote.by || null, at: l.familyNote.at || 0 };
        if (k.role === "parent") {
          out.paid = !!(l.paid && l.paid.value);
          out.paidAt = (l.paid && l.paid.at) || 0;
        }
        return out;
      }),
      requests: decisions.filter(d => d.studentId === k.studentId).slice(-200).map(d => ({
        id: d.id, type: d.type, lessonId: d.lessonId, status: d.status, reason: d.reason || "",
        comment: d.comment || "", createdAt: d.createdAt || null,
        newStartMs: d.newStartMs || null, newEndMs: d.newEndMs || null,
        oldStartMs: d.oldStartMs || null, oldEndMs: d.oldEndMs || null,
        decidedAt: d.decidedAt, by: d.by,
      })),
      busy,
      // Сообщения и напоминания для ЭТОГО адресата (кабинет сам решает, когда показать).
      notices: window.NotifyCore.noticesForKey(rules, k, accessKeysCache || keys, now),
    };
    if (k.role === "parent") {
      const p = pkgs.find(x => x.key === k.studentId);
      view.package = p ? { done: p.doneCount, total: p.total, remaining: p.remaining } : null;
      view.parentChannel = ch.parent || null;
    }
    return { key: k, view };
  });
}

async function publishViews(onlyKeys) {
  const keys = onlyKeys || (await getAccessKeys()).filter(k => k.active);
  if (!keys.length) return 0;
  const built = await buildViews(keys);
  for (const { key, view } of built) await window.TutorFB.publishView(key.role, key.id, view);
  return built.length;
}

let publishTimer = null;
function publishViewsSoon() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    if (!navigator.onLine) { pendingPublish = true; return; } // опубликуем, когда появится сеть
    publishViews().catch(e => console.error("Кабинеты родителей/учеников не обновились", e));
  }, 2500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }
}

async function loadAccessCard(fresh) {
  const el = $("accessBody");
  if (!fresh) el.innerHTML = '<div class="empty">Загрузка…</div>';
  let keys;
  try {
    keys = await getAccessKeys(true);
  } catch (e) {
    el.innerHTML = isPermissionDenied(e)
      ? '<div class="hint" style="margin-top:0">База пока не пускает к ключам доступа — нужно обновить правила (firebase deploy).</div>'
      : '<div class="empty">Не удалось загрузить</div>';
    return;
  }
  renderAccessCard(keys, fresh);
}

function renderAccessCard(keys, fresh) {
  const el = $("accessBody");
  const students = studentList();
  const fmtD = (ms) => new Date(ms).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  const freshHtml = fresh ? `
      <div class="banner" style="margin-bottom:10px">Ссылка для <b>${escHtml(studentLabel(fresh.studentId))}</b> (${fresh.role === "parent" ? "родитель" : "ученик"}). Отправь её — по ней откроется личный кабинет:
        <div class="key-link" id="freshLink">${escHtml(cabinetUrl(fresh.role, fresh.id))}</div>
        <div class="btn-row" style="margin:0">
          <button class="btn" type="button" data-key-copy="${escHtml(fresh.id)}">Скопировать ссылку</button>
          ${navigator.share ? `<button class="btn secondary" type="button" data-key-share="${escHtml(fresh.id)}">Поделиться…</button>` : ""}
        </div>
      </div>` : "";
  // Показываем только действующие доступы: у каждого ссылку можно открыть
  // и скопировать заново в любой момент. Отозванные в списке не нужны
  // (запись о них остаётся в базе, но ссылка уже не работает).
  const active = keys.filter(k => k.active)
    .sort((a, b) => String(a.studentId).localeCompare(String(b.studentId), "ru") || (a.createdAt || 0) - (b.createdAt || 0));
  const items = active.map(k => `
      <div class="ak-item" data-key-item="${escHtml(k.id)}">
        <div class="ak-head">
          <div>
            <div class="ak-who">${escHtml(studentLabel(k.studentId))}${k.label ? ` · <span class="ak-label">${escHtml(k.label)}</span>` : ""}</div>
            <div class="ak-meta"><span class="ak-role">${k.role === "parent" ? "родитель" : "ученик"}</span>${k.createdAt ? ` · выдан ${fmtD(k.createdAt)}` : ""}</div>
          </div>
          <button class="link-btn ak-revoke" type="button" data-key-revoke="${escHtml(k.id)}">Отозвать</button>
        </div>
        <div class="key-link" data-key-url hidden>${escHtml(cabinetUrl(k.role, k.id))}</div>
        <div class="ak-actions">
          <button class="btn" type="button" data-key-copy="${escHtml(k.id)}">Скопировать ссылку</button>
          <button class="btn secondary" type="button" data-key-show="${escHtml(k.id)}">Показать ссылку</button>
          ${navigator.share ? `<button class="btn secondary" type="button" data-key-share="${escHtml(k.id)}">Поделиться…</button>` : ""}
        </div>
      </div>`).join("");
  el.innerHTML = `
      ${freshHtml}
      <div class="field-row">
        <div class="field"><span>Ученик</span>
          <select id="akStudent">${students.map(r => { const id = r.id; return `<option value="${escHtml(id)}">${escHtml(`${r.name}${r.surname ? " " + r.surname : ""}, ${r.cls} класс`)}</option>`; }).join("")}</select>
        </div>
        <div class="field"><span>Кому</span>
          <select id="akRole"><option value="parent">родителю</option><option value="student">ученику</option></select>
        </div>
      </div>
      <div class="field"><span>Пометка (необязательно)</span><input type="text" id="akLabel" maxlength="60" placeholder="например: мама"></div>
      <div class="btn-row"><button class="btn" type="button" id="akIssue" ${students.length ? "" : "disabled"}>Выдать доступ</button></div>
      <div class="msg" id="akMsg"></div>
      <div class="ak-title">Выданные доступы${active.length ? ` (${active.length})` : ""}</div>
      ${active.length ? `<div class="ak-list">${items}</div>` : '<div class="hint" style="margin-top:0">Действующих доступов пока нет.</div>'}
      <div class="hint">Родитель видит занятия своего ребёнка, остаток пакета, отчёты и файлы домашки, а в сетке занятости — чужие слоты как «занято» без имён. Ученик видит то же, кроме пакета. У каждого свой ключ; ссылку любого действующего доступа можно в любой момент показать или скопировать заново (например, для второго родителя). «Отозвать» — ссылка сразу перестаёт работать и пропадает из списка. Кабинеты обновляются сами после изменений в дашборде.</div>`;
}

$("accessBody").addEventListener("click", async (e) => {
  const msg = (t, kind) => { const m = $("akMsg"); if (m) { m.textContent = t; m.className = "msg" + (kind ? " " + kind : ""); } };
  const keyById = (id) => (accessKeysCache || []).find(k => k.id === id);

  if (e.target.closest("#akIssue")) {
    const btn = e.target.closest("#akIssue");
    const studentId = $("akStudent").value;
    const role = $("akRole").value;
    const label = $("akLabel").value.trim();
    if (!studentId) return;
    btn.disabled = true;
    msg("Создаю ключ…");
    try {
      const id = newAccessKey();
      const data = { role, studentId, label, createdAt: Date.now(), active: true, revokedAt: null };
      await window.TutorFB.saveAccessKey(id, data);
      await getAccessKeys(true);
      await ensureChannels(accessKeysCache);
      await publishViews(activeKeysOf(studentId));
      startChannelWatch();
      await loadAccessCard(Object.assign({ id }, data));
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      msg("Не удалось выдать доступ (нет интернета?)", "err");
    }
    return;
  }
  const copyBtn = e.target.closest("[data-key-copy]");
  if (copyBtn) {
    const k = keyById(copyBtn.dataset.keyCopy);
    if (!k) return;
    const ok = await copyText(cabinetUrl(k.role, k.id));
    msg(ok ? "Ссылка скопирована" : "Не удалось скопировать — выдели ссылку вручную", ok ? "ok" : "err");
    const item = copyBtn.closest(".ak-item");
    if (item) {
      // отклик прямо на кнопке (сообщение наверху карточки на телефоне не видно)
      if (ok) {
        copyBtn.textContent = "Скопировано ✓";
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "Скопировать ссылку"; }, 2000);
      } else {
        const show = item.querySelector("[data-key-show]");
        if (show && item.querySelector("[data-key-url]").hidden) show.click(); // покажем — скопировать вручную
      }
    }
    return;
  }
  const showBtn = e.target.closest("[data-key-show]");
  if (showBtn) {
    const box = showBtn.closest(".ak-item").querySelector("[data-key-url]");
    box.hidden = !box.hidden;
    showBtn.textContent = box.hidden ? "Показать ссылку" : "Скрыть ссылку";
    if (!box.hidden) { const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    return;
  }
  const shareBtn = e.target.closest("[data-key-share]");
  if (shareBtn) {
    const k = keyById(shareBtn.dataset.keyShare);
    if (k && navigator.share) navigator.share({ title: "Тьютор Онлайн", text: `Тьютор Онлайн — кабинет: ${studentLabel(k.studentId)}`, url: cabinetUrl(k.role, k.id) }).catch(() => {});
    return;
  }
  const revokeBtn = e.target.closest("[data-key-revoke]");
  if (revokeBtn) {
    const k = keyById(revokeBtn.dataset.keyRevoke);
    if (!k || !confirm(`Отозвать доступ (${k.studentId}, ${k.role === "parent" ? "родитель" : "ученик"})? Ссылка перестанет работать сразу.`)) return;
    try {
      await window.TutorFB.deleteView(k.role, k.id);
      await window.TutorFB.saveAccessKey(k.id, { active: false, revokedAt: Date.now() });
      await getAccessKeys(true);
      await rotateChannels(k.studentId);
      await publishViews(activeKeysOf(k.studentId));
      startChannelWatch();
      await loadAccessCard();
      msg("Доступ отозван", "ok");
    } catch (err) {
      console.error(err);
      msg("Не удалось отозвать (нет интернета?)", "err");
    }
  }
});

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

async function startChannelWatch() {
  let keys;
  try {
    keys = await getAccessKeys(true);
    await ensureChannels(keys);
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
      const hws = its.filter(i => i.type === "homework");
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
      const notes = its.filter(i => i.type === "note").sort((a, b) => a.createdAt - b.createdAt);
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
        }
      }
      const paids = its.filter(i => i.type === "paid").sort((a, b) => a.createdAt - b.createdAt);
      if (paids.length) {
        if (meta.kind !== "parent") {
          toDelete.push(...paids.map(i => i.id)); // «оплачено» ставит только родитель
        } else {
          const latest = paids[paids.length - 1];
          if (!l.paid || (l.paid.at || 0) < latest.createdAt) patch.paid = { value: latest.paid, by: latest.by, at: latest.createdAt };
          toDelete.push(...paids.slice(0, -1).map(i => i.id)); // последняя остаётся — её видит родитель
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

const ROLE_RU = { parent: "родитель", student: "ученик", teacher: "учитель" };
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
      await rescheduleLesson(l, item.newStartMs, item.newEndMs);
    } else {
      if (!confirm(`Отменить «${displayTitle(l.title)}», ${fmtWhen(l.startMs, l.endMs)}?`)) return;
      await setStatusScoped(l, "cancelled", "one", ["planned"]);
    }
  } else {
    const r = prompt("Причина отказа (увидит родитель/ученик, можно оставить пустым):", "");
    if (r === null) return;
    reason = r.trim().slice(0, 300);
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

// ---------- КАЛЕНДАРЬ-РЕДАКТОР (FullCalendar) ----------

const FC_JS = "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.19/index.global.min.js";
const FC_RU = "https://cdn.jsdelivr.net/npm/@fullcalendar/core@6.1.19/locales/ru.global.min.js";
const STATUS_RU = { planned: "запланировано", done: "проведено", cancelled: "отменено", rescheduled: "перенесено" };
let fc = null;

const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function fmtWhen(ms, endMs) {
  const d = new Date(ms);
  return `${fmtDayLabel(d)}.${d.getFullYear()}, ${hhmm(d)}` + (endMs ? `–${hhmm(new Date(endMs))}` : "");
}
const PKG_SUFFIX_RE = /\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;
function baseTitle(title) { return (title || "").replace(PKG_SUFFIX_RE, "").trim(); }
function pkgSuffix(title) {
  const m = (title || "").match(PKG_SUFFIX_RE);
  return m ? ` ${m[1]}/${m[2]}` : "";
}

function lessonToFc(l) {
  if (isPersonal(l)) {
    return {
      id: l.id, title: "Личное время" + (l.note ? ": " + l.note : ""), start: l.startMs, end: l.endMs,
      classNames: ["st-personal"], editable: true, extendedProps: { lesson: l },
    };
  }
  const tag = l.status === "cancelled" ? " · отмена" : l.status === "rescheduled" ? " · перенос" : "";
  return {
    id: l.id,
    title: displayTitle(l.title) + tag,
    start: l.startMs,
    end: l.endMs,
    classNames: ["st-" + l.status],
    editable: l.status === "planned",
    extendedProps: { lesson: l },
  };
}

// Копии одного группового занятия — одним событием («Группа «…»: Анна, Борис»).
function groupToFc(copies) {
  const main = copies.find(c => c.status === "planned") || copies.find(c => c.status !== "rescheduled") || copies[0];
  const status = groupStatus(copies);
  const tag = status === "cancelled" ? " · отмена" : status === "rescheduled" ? " · перенос" : "";
  return {
    id: main.id, title: groupTitle(copies) + tag, start: main.startMs, end: main.endMs,
    classNames: ["st-" + status, "st-group"], editable: status === "planned",
    extendedProps: { lesson: main, group: copies },
  };
}
function lessonsToFc(list) {
  const occ = {};
  const out = [];
  list.forEach(l => {
    if (!isGroupCopy(l)) { out.push(lessonToFc(l)); return; }
    if (!occ[l.groupOcc]) { occ[l.groupOcc] = []; out.push(occ[l.groupOcc]); }
    occ[l.groupOcc].push(l);
  });
  return out.map(x => (Array.isArray(x) ? groupToFc(x) : x));
}

async function loadFcEvents(info, success, failure) {
  try {
    const list = await window.TutorFB.listLessons(info.start.getTime(), info.end.getTime());
    success(lessonsToFc(list));
  } catch (e) {
    failure(e);
  }
}

async function ensureCalendar() {
  if (fc) return fc;
  await loadScriptOnce(FC_JS);
  await loadScriptOnce(FC_RU);
  if (fc) return fc; // параллельный вызов уже создал календарь
  const narrow = window.innerWidth < 640;
  fc = new FullCalendar.Calendar($("fcRoot"), {
    locale: "ru",
    firstDay: 1,
    fixedWeekCount: false, // в месяце столько строк, сколько в нём недель (4–6), а не всегда 6
    initialView: narrow ? "timeGridDay" : "timeGridWeek",
    headerToolbar: narrow
      ? { left: "prev,next today", center: "", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" }
      : { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" },
    footerToolbar: narrow ? { center: "title" } : false,
    buttonText: { today: "сегодня", day: "день", week: "неделя", month: "месяц", list: "список" },
    slotMinTime: "08:00:00",
    slotMaxTime: "24:00:00", // до конца суток
    scrollTime: "09:00:00",
    slotDuration: "00:30:00",
    snapDuration: "00:15:00",
    allDaySlot: false,
    nowIndicator: true,
    height: "auto",
    eventTimeFormat: { hour: "2-digit", minute: "2-digit" },
    selectable: true,
    selectMirror: true,
    selectLongPressDelay: 350,
    eventLongPressDelay: 350,
    editable: true,
    events: loadFcEvents,
    select: (info) => {
      fc.unselect();
      openCreateModal(info.start, info.end);
    },
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      openLessonModal(info.event.id);
    },
    eventDrop: onFcDrop,
    eventResize: onFcResize,
    eventDidMount: (info) => {
      const l = info.event.extendedProps.lesson;
      const g = info.event.extendedProps.group;
      if (g) info.el.title = `${groupTitle(g)} — ${STATUS_RU[groupStatus(g)] || ""}`;
      else if (l) info.el.title = isPersonal(l) ? "Личное время" + (l.note ? ": " + l.note : "") : `${displayTitle(l.title)} — ${STATUS_RU[l.status] || l.status}`;
    },
  });
  fc.render();
  return fc;
}

async function refreshCalendar() {
  if (activeTab !== "calendar") { if (fc) fc.refetchEvents(); return; }
  try {
    await ensureCalendar();
    fc.updateSize();
    fc.refetchEvents();
  } catch (e) {
    $("fcRoot").innerHTML = '<div class="empty">Не удалось загрузить календарь (нет интернета?)</div>';
  }
}

function afterLessonsChanged() {
  refreshPackageAlertsSoon();
  if (fc) fc.refetchEvents();
  if (activeTab === "lessons") loadLessonEvents();
  publishViewsSoon();
}

async function onFcDrop(info) {
  const l = info.event.extendedProps.lesson;
  if (!l) { info.revert(); return; }
  if (!navigator.onLine) { info.revert(); offlineToast(); return; }
  const startMs = info.event.start.getTime();
  const endMs = info.event.end ? info.event.end.getTime() : startMs + (l.endMs - l.startMs);
  const group = info.event.extendedProps.group;
  if (group) {
    if (!confirm(`Перенести ${groupLabel(l.groupId).toLowerCase()} (${group.filter(c => c.status === "planned").length} уч.) на ${fmtWhen(startMs, endMs)}?\nВ истории останется отметка «перенесено».`)) { info.revert(); return; }
    try { await rescheduleGroup(group, startMs, endMs); } catch (e) { info.revert(); reportSaveError(e); return; }
    afterLessonsChanged();
    return;
  }
  if (isPersonal(l)) {
    // личное время просто сдвигаем, без истории «перенесено»
    try {
      await window.TutorFB.updateLesson(l.id, lessonData({ title: l.title, startMs, endMs, status: l.status, recurrenceId: l.recurrenceId, source: l.source }));
    } catch (e) {
      info.revert();
      reportSaveError(e);
      return;
    }
    afterLessonsChanged();
    return;
  }
  if (!confirm(`Перенести «${l.title}» на ${fmtWhen(startMs, endMs)}?\nВ истории останется отметка «перенесено».`)) { info.revert(); return; }
  try {
    await rescheduleLesson(l, startMs, endMs);
  } catch (e) {
    info.revert();
    reportSaveError(e);
    return;
  }
  afterLessonsChanged();
}

async function onFcResize(info) {
  const l = info.event.extendedProps.lesson;
  if (!l) { info.revert(); return; }
  if (!navigator.onLine) { info.revert(); offlineToast(); return; }
  const endMs = info.event.end.getTime();
  const fields = { endMs, end: mskIso(endMs), durationMin: Math.round((endMs - l.startMs) / 60000), updatedAt: Date.now() };
  const targets = info.event.extendedProps.group ? info.event.extendedProps.group.filter(c => c.status === "planned" || c.status === "cancelled") : [l];
  try {
    await window.TutorFB.saveLessons(targets.map(c => ({ id: c.id, merge: true, data: fields })));
  } catch (e) {
    info.revert();
    reportSaveError(e);
    return;
  }
  afterLessonsChanged();
}

// ---- операции с занятиями ----

// Перенос ОДНОГО занятия. У копии группового занятия (заявка семьи на
// перенос) — ученик уходит на своё время: новое занятие уже личное, вне
// группы и вне её серии. Всю группу переносит rescheduleGroup.
async function rescheduleLesson(l, startMs, endMs) {
  const nid = newId("l");
  const moved = lessonData({
    title: l.title, startMs, endMs, status: "planned",
    packageId: l.packageId, recurrenceId: l.groupId ? null : l.recurrenceId, source: "app",
    extra: Object.assign({ rescheduledFrom: l.id, createdAt: Date.now(), report: l.report || "", homework: l.homework || [] }, l.familyNote ? { familyNote: l.familyNote } : {}),
  });
  await window.TutorFB.saveLessons([
    { id: nid, data: moved },
    { id: l.id, data: { status: "rescheduled", rescheduledTo: nid, updatedAt: Date.now() }, merge: true },
  ]);
  return nid;
}

// «Это и следующие»: только занятия этого же ученика (у копий группы серия
// общая на всех участников — чужие копии здесь не трогаем; всю группу
// меняют групповые функции ниже).
async function scopeTargets(l, scope, statuses) {
  if (scope !== "following" || !l.recurrenceId) return [l];
  const series = await window.TutorFB.listSeries(l.recurrenceId);
  return series.filter(x => x.startMs >= l.startMs && (x.studentId || null) === (l.studentId || null) && (!statuses || statuses.includes(x.status)));
}

// ---------- ГРУППОВЫЕ ЗАНЯТИЯ ----------
// Групповое занятие = по копии на каждого участника (обычное занятие со
// своим studentId и названием «Имя N класс») + общие поля:
//   groupId  — группа (state.groups[groupId] = { name, members, callUrl });
//   groupOcc — это занятие группы (одинаков у всех копий одного времени).
// Поэтому «Провёл», пакет, цена (групповая), «Оплачено», кабинет семьи,
// заявки и пуши работают у каждого участника как у личного занятия, а
// календарь, «Итоги» и «Аналитика» (часы, отмены) склеивают копии в одно.
const groupsMap = () => remoteState.groups || {};
const isGroupCopy = (l) => !!(l && l.groupId && l.groupOcc);
const groupLabel = (gid) => { const g = groupsMap()[gid]; return g && g.name ? `Группа «${g.name}»` : "Группа"; };
const shortName = (sid) => { const sp = splitStudentId(sid); return sp ? `${sp.name}${sp.surname ? " " + sp.surname : ""}` : String(sid || ""); };
// название занятия для ученика («Маша 7 класс» / «Маша Иванова 7 класс»)
function titleOfStudent(sid) {
  const st = studentList().find(x => x.id === sid);
  if (st) return titleBaseOf(st);
  const sp = splitStudentId(sid);
  return sp ? `${sp.name}${sp.surname ? " " + sp.surname : ""} ${sp.cls} класс` : String(sid);
}
// копии одного занятия группы (все начинаются в одно время)
async function groupCopies(l) {
  if (!isGroupCopy(l)) return [l];
  const list = await window.TutorFB.listLessons(l.startMs, l.startMs + 1);
  const out = list.filter(x => x.groupOcc === l.groupOcc);
  return out.length ? out.sort((a, b) => shortName(a.studentId).localeCompare(shortName(b.studentId), "ru")) : [l];
}
// состояние занятия группы целиком: идёт, если идёт хоть у кого-то
function groupStatus(copies) {
  const st = copies.map(c => c.status);
  for (const s of ["planned", "done", "cancelled"]) if (st.includes(s)) return s;
  return "rescheduled";
}
function groupTitle(copies) {
  const live = copies.filter(c => c.status !== "rescheduled");
  const names = (live.length ? live : copies).slice().sort((a, b) => shortName(a.studentId).localeCompare(shortName(b.studentId), "ru")).map(c => shortName(c.studentId) + (c.status === "cancelled" && live.some(x => x.status !== "cancelled") ? " (отм.)" : ""));
  return `${groupLabel(copies[0].groupId)}: ${names.join(", ")}`;
}
// Новые копии для занятий группы: base — занятия «на одного» (время, серия),
// members — участники. Один groupOcc на каждое время.
function buildGroupItems(baseItems, gid, members) {
  const out = [];
  baseItems.forEach(b => {
    const occ = newId("go");
    members.forEach(sid => out.push({
      id: newId("l"),
      data: lessonData({ title: titleOfStudent(sid), startMs: b.data.startMs, endMs: b.data.endMs, status: "planned", recurrenceId: b.data.recurrenceId, source: "app", extra: { createdAt: Date.now(), groupId: gid, groupOcc: occ } }),
    }));
  });
  return out;
}
async function saveGroup(gid, value) {
  await window.TutorFB.setGroup(gid, value);
  remoteState.groups = Object.assign({}, groupsMap());
  if (value == null) delete remoteState.groups[gid]; else remoteState.groups[gid] = value;
}
// Перенос всей группы: у каждой ещё не проведённой копии — перенос с историей.
async function rescheduleGroup(copies, startMs, endMs) {
  copies = copies.slice().sort((a, b) => (a.status === "planned" ? 0 : 1) - (b.status === "planned" ? 0 : 1));
  const occ = newId("go");
  const now = Date.now();
  const items = [];
  // «не придёт» переезжает вместе с группой (остаётся отменённым — можно «вернуть»)
  if (!copies.some(c => c.status === "planned")) return null;
  copies.filter(c => c.status === "planned" || c.status === "cancelled").forEach(c => {
    const nid = newId("l");
    items.push({ id: nid, data: lessonData({
      title: c.title, startMs, endMs, status: c.status, packageId: c.packageId, recurrenceId: c.recurrenceId, source: "app",
      extra: Object.assign({ rescheduledFrom: c.id, createdAt: now, report: c.report || "", homework: c.homework || [], groupId: c.groupId, groupOcc: occ }, c.callUrl ? { callUrl: c.callUrl } : {}, c.familyNote ? { familyNote: c.familyNote } : {}),
    }) });
    items.push({ id: c.id, merge: true, data: { status: "rescheduled", rescheduledTo: nid, updatedAt: now } });
  });
  if (!items.length) return null;
  await window.TutorFB.saveLessons(items);
  return items[0].id;
}
// «Это и следующие» для группы: копии всех участников этой группы в серии
async function groupScopeTargets(copies, scope, statuses) {
  const l = copies[0];
  const ok = (x) => !statuses || statuses.includes(x.status);
  if (scope !== "following" || !l.recurrenceId) return copies.filter(ok);
  const series = await window.TutorFB.listSeries(l.recurrenceId);
  return series.filter(x => x.groupId === l.groupId && x.startMs >= l.startMs && ok(x));
}
// Правка времени/длительности группы «на месте»: названия у каждой копии свои.
// Отменённые («не придёт») и уже отмеченные «Провёл» копии двигаются вместе
// с группой — иначе их не найти в окне занятия (копии ищутся по времени).
async function editGroupScoped(copies, { startMs, durMin, scope }) {
  const delta = startMs - copies[0].startMs;
  const targets = await groupScopeTargets(copies, scope, ["planned", "cancelled", "done"]);
  await window.TutorFB.saveLessons(targets.map(x => {
    const s = x.startMs + delta;
    return { id: x.id, merge: true, data: lessonData({ title: x.title, startMs: s, endMs: s + durMin * 60000, status: x.status, packageId: x.packageId, recurrenceId: x.recurrenceId, source: x.source }) };
  }));
  return targets.length;
}
// Состав группы: новые участники получают копии всех будущих занятий группы,
// убранные — теряют свои будущие непроведённые копии (прошлое остаётся).
async function applyGroupMembers(gid, members) {
  const now = Date.now();
  const prev = (groupsMap()[gid] || {}).members || [];
  const all = await window.TutorFB.listGroupLessons(gid);
  const byOcc = {};
  all.filter(l => l.groupOcc && l.startMs >= now).forEach(l => { (byOcc[l.groupOcc] = byOcc[l.groupOcc] || []).push(l); });
  const add = [], del = [];
  Object.values(byOcc).forEach(copies => {
    const tpl = copies.find(c => c.status === "planned");
    if (!tpl) return; // занятие уже отменено у всех — не трогаем
    members.forEach(sid => {
      if (copies.some(c => c.studentId === sid)) return;
      const teacherHw = (tpl.homework || []).filter(h => !h.by || h.by === "teacher");
      add.push({ id: newId("l"), data: lessonData({ title: titleOfStudent(sid), startMs: tpl.startMs, endMs: tpl.endMs, status: "planned", recurrenceId: tpl.recurrenceId, source: "app",
        extra: Object.assign({ createdAt: now, groupId: gid, groupOcc: tpl.groupOcc, homework: teacherHw }, tpl.callUrl ? { callUrl: tpl.callUrl } : {}) }) });
    });
    copies.forEach(c => { if (!members.includes(c.studentId) && c.status !== "done") del.push(c.id); });
  });
  if (add.length) await window.TutorFB.saveLessons(add);
  if (del.length) await window.TutorFB.deleteLessons(del);
  return { added: members.filter(x => !prev.includes(x)), removed: prev.filter(x => !members.includes(x)), created: add.length, deleted: del.length };
}

// Старые отмены «с заменой в конец пакета» (до 2026-09-27): «Вернуть
// занятие» убирает ещё не проведённую замену. Номеров «k/M» больше нет.
async function restoreWithMakeup(l) {
  const mk = l.makeup;
  const now = Date.now();
  const items = [{ id: l.id, merge: true, data: { status: "planned", makeup: null, updatedAt: now } }];
  let note = "";
  const makeup = mk && mk.id ? await window.TutorFB.getLesson(mk.id) : null;
  if (makeup && makeup.status === "planned") {
    await window.TutorFB.deleteLessons([mk.id]);
    note = " Замена в конце пакета убрана.";
  } else if (makeup) {
    note = " Замена в конце пакета уже проведена — её оставили.";
  }
  await window.TutorFB.saveLessons(items);
  return note;
}

async function setStatusScoped(l, status, scope, fromStatuses) {
  const targets = await scopeTargets(l, scope, fromStatuses);
  await window.TutorFB.saveLessons(targets.map(x => ({ id: x.id, data: { status, updatedAt: Date.now() }, merge: true })));
  return targets.length;
}

async function deleteScoped(l, scope) {
  const targets = (await scopeTargets(l, scope)).filter(x => x.status !== "done" || x.id === l.id);
  await window.TutorFB.deleteLessons(targets.map(x => x.id));
  return targets.length;
}

// Исправление данных «на месте» (без истории переноса). Для серии можно
// применить сдвиг ко всем следующим занятиям: время/день сдвигаются на
// ту же величину, номер в пакете «k/M» у каждого сохраняется.
async function editScoped(l, { base, startMs, durMin, scope }) {
  const delta = startMs - l.startMs;
  const targets = scope === "following" ? await scopeTargets(l, scope, ["planned"]) : [l];
  if (!targets.some(x => x.id === l.id)) targets.unshift(l);
  const items = targets.map(x => {
    const s = x.startMs + delta;
    return {
      id: x.id,
      merge: true,
      data: lessonData({
        title: base + pkgSuffix(x.title), startMs: s, endMs: s + durMin * 60000, status: x.status,
        packageId: x.packageId, recurrenceId: x.recurrenceId, source: x.source,
      }),
    };
  });
  await window.TutorFB.saveLessons(items);
  return items.length;
}

function buildSeries({ base, startMs, durMin, count }) {
  const recurrenceId = count > 1 ? newId("ser") : null;
  const packageId = null;
  const items = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startMs);
    d.setDate(d.getDate() + 7 * i); // то же время на часах, даже через смену времени
    const s = d.getTime();
    const title = base;
    items.push({
      id: newId("l"),
      data: lessonData({ title, startMs: s, endMs: s + durMin * 60000, status: "planned", packageId, recurrenceId, source: "app", extra: { createdAt: Date.now() } }),
    });
  }
  return items;
}

// Несколько «день недели + время» за один раз (вт 16:00 и чт 17:30).
// Первый день — дата/время из формы, остальные — первый такой день недели
// начиная с этой даты. С «Повторять» — занятия по порядку, пока не наберётся
// count (8 занятий при двух днях — 4 недели); у каждого дня недели своя
// серия, чтобы «это и следующие» двигало только свой день. Без повтора — по
// одному занятию на каждый день.
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function slotStarts(startMs, slots) {
  const first = new Date(startMs);
  const seen = new Set();
  const out = [];
  [{ wd: first.getDay(), time: hhmm(first) }, ...slots].forEach(sl => {
    if (!/^\d{1,2}:\d{2}$/.test(sl.time || "")) return;
    const k = sl.wd + " " + sl.time;
    if (seen.has(k)) return;
    seen.add(k);
    const [h, m] = sl.time.split(":").map(Number);
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + ((sl.wd - first.getDay() + 7) % 7), h, m);
    out.push({ ms: d.getTime(), wd: sl.wd, time: sl.time });
  });
  return out;
}
function planSlots({ startMs, count, repeat, slots }) {
  const starts = slotStarts(startMs, slots);
  if (!repeat) return starts.map(st => ({ ms: st.ms, slot: st })).sort((a, b) => a.ms - b.ms);
  // все дни — в пределах недели от первой даты, так что неделя = starts.length занятий
  const out = [];
  for (let w = 0; w < Math.ceil(count / starts.length); w++) {
    starts.forEach(st => {
      const d = new Date(st.ms);
      d.setDate(d.getDate() + 7 * w); // то же время на часах, даже через смену времени
      out.push({ ms: d.getTime(), slot: st });
    });
  }
  return out.sort((a, b) => a.ms - b.ms).slice(0, count);
}
function buildMultiSeries({ base, startMs, durMin, count, repeat, slots }) {
  const planned = planSlots({ startMs, count, repeat, slots });
  const serOf = {};
  planned.forEach(p => { const k = p.slot.wd + " " + p.slot.time; serOf[k] = (serOf[k] || 0) + 1; });
  const ids = {};
  Object.keys(serOf).forEach(k => { ids[k] = repeat && serOf[k] > 1 ? newId("ser") : null; });
  return planned.map(p => ({
    id: newId("l"),
    data: lessonData({ title: base, startMs: p.ms, endMs: p.ms + durMin * 60000, status: "planned", packageId: null, recurrenceId: ids[p.slot.wd + " " + p.slot.time], source: "app", extra: { createdAt: Date.now() } }),
  }));
}

async function findConflicts(items, ignoreIds) {
  if (!items.length) return [];
  const from = Math.min(...items.map(i => i.data.startMs));
  const to = Math.max(...items.map(i => i.data.endMs));
  const existing = (await window.TutorFB.listLessons(from - 4 * 3600000, to))
    .filter(x => isActiveStatus(x.status) && !(ignoreIds || []).includes(x.id));
  const out = [];
  items.forEach(it => {
    existing.forEach(x => {
      if (x.startMs < it.data.endMs && x.endMs > it.data.startMs) out.push(x);
    });
  });
  return out;
}

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
  if (isPersonal(l)) { openPersonalModal(null, null, l); return; }
  if (isGroupCopy(l)) { openGroupModal(l); return; }
  renderLessonModal(l);
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
  const callHtml = `
      <div class="section">
        <div class="section-title">Созвон</div>
        ${call ? `<div class="btn-row" style="margin:0 0 6px"><a class="btn" id="mCallOpen" href="${escHtml(call.url)}" target="_blank" rel="noopener" style="text-decoration:none">Открыть созвон</a>${prof.accessUrl && safeHref(prof.accessUrl) ? `<a class="btn secondary" href="${escHtml(prof.accessUrl)}" target="_blank" rel="noopener" style="text-decoration:none">Материалы</a>` : ""}</div>
          <div class="hint" id="mCallSrc" style="margin-top:0">${call.own ? "Разовая ссылка — только для этого занятия." : "Обычная ссылка из профиля ученика (вкладка «Ученики»)."}</div>`
      : `<div class="hint" style="margin-top:0">${l.studentId ? "У ученика не указана ссылка на созвон — её можно добавить во вкладке «Ученики»." : "Занятие не привязано к ученику — ссылку можно указать только для него ниже."}</div>`}
        <div class="field" style="margin-top:8px"><span>Другая ссылка только для этого занятия</span>
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
  const busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
    try { await fn(); } catch (e) { console.error(e); if (!e.shown) modalMsg(isOfflineError(e) ? OFFLINE_TEXT : "Не удалось сохранить (нет интернета?). Попробуй ещё раз.", "err"); }
    finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
  };
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
    if (value && !safeHref(value)) { modalMsg("Ссылка должна начинаться с https:// (или http://)", "err"); return; }
    await window.TutorFB.updateLesson(l.id, { callUrl: value || null, updatedAt: Date.now() });
    publishViewsSoon();
    await reopen(value ? "Разовая ссылка сохранена" : "Вернули обычную ссылку ученика");
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
  // «Отчёт» — не просто сохранить: отчёт публикуется в кабинетах и уходит
  // уведомлением родителю и ученику (как «Отправить сейчас» — в кабинете
  // сразу, пушем — с ближайшей фоновой рассылкой).
  mq("#mSaveReport").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const report = mq("#mReport").value.trim();
    const changed = report !== (l.report || "").trim();
    await window.TutorFB.updateLesson(l.id, { report, reportUpdatedAt: Date.now(), updatedAt: Date.now() });
    l.report = report;
    if (!report) { publishViewsSoon(); modalMsg("Отчёт убран", "ok"); return; }
    if (!changed) { modalMsg("Отчёт уже опубликован — изменений нет", "ok"); return; }
    const keys = activeKeysOf(l.studentId);
    if (!keys.length) { publishViewsSoon(); modalMsg("Отчёт сохранён. У ученика нет доступа к кабинету — отправлять некому.", "ok"); return; }
    const head = `Отчёт по занятию ${fmtWhen(l.startMs, l.endMs)}:\n`;
    const text = (head + report).length > 1000 ? (head + report).slice(0, 999) + "…" : head + report;
    const now = Date.now();
    try {
      await window.TutorFB.saveNotification(newId("n"), {
        title: "Отчёт о занятии", text, mode: "now", times: 1, target: { scope: "student", role: "any", studentId: l.studentId },
        push: true, active: true, lessonIds: [l.id], source: "report", createdAt: now, updatedAt: now,
      });
      notifCache = null;
      await publishViews(keys);
      modalMsg(`Отчёт опубликован и отправлен: ${keys.length} ${NotifyCore.plural(keys.length, ["кабинет", "кабинета", "кабинетов"])} (пуш — с ближайшей рассылкой).`, "ok");
    } catch (err) {
      console.error(err);
      publishViewsSoon();
      modalMsg("Отчёт сохранён, но уведомление не ушло (нет интернета?)", "err");
    }
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
  mq("#mExport").addEventListener("click", () => {
    downloadIcs(l);
    modalMsg("Файл события скачан — открой его, чтобы добавить в календарь.", "ok");
  });
}

// ---------- окно группового занятия ----------
// Сверху — участники: у каждого свои «Провёл», сумма (групповая цена),
// «Оплачено» и «не придёт» (отмена только для этого ученика). Ниже — общее для всей
// группы: время, перенос, отмена, отчёт, файлы ДЗ, ссылка на созвон.
async function openGroupModal(l, note) {
  let copies;
  try { copies = await groupCopies(l); } catch (e) { alert("Не удалось открыть занятие (нет интернета?)."); return; }
  renderGroupModal(copies, note);
}
function renderGroupModal(copies, note) {
  const live = copies.filter(c => c.status !== "rescheduled");
  const main = live.find(c => c.status === "planned") || live[0] || copies[0];
  const gid = main.groupId;
  const status = groupStatus(copies);
  const inSeries = !!main.recurrenceId;
  const memberRow = (c) => {
    const mark = marks[c.id] || { marked: false, overrideAmount: null, lockedRate: null };
    const ev = lessonToEv(c);
    const amount = effectiveAmountFor(ev, mark);
    const canMark = amount != null && !Number.isNaN(amount);
    const base = mark.marked && mark.lockedRate != null ? mark.lockedRate : rateFor(ev);
    const paid = !!(c.paid && c.paid.value);
    const active = c.status === "planned" || c.status === "done";
    return `<div class="g-member" data-gid="${escHtml(c.id)}">
        <div class="g-name"><b>${escHtml(shortName(c.studentId))}</b> <span class="status-pill ${escHtml(c.status)}">${STATUS_RU[c.status] || escHtml(c.status)}</span>
          ${c.familyNote && c.familyNote.text ? `<div class="family-note" style="margin-top:4px">${escHtml(c.familyNote.text)}</div>` : ""}</div>
        ${active ? `<div class="lesson-bottom">
          <div class="rate-field">₽ <input type="number" inputmode="decimal" data-g-amount placeholder="${base != null ? base : "сумма"}" value="${mark.overrideAmount != null ? mark.overrideAmount : ""}"></div>
          <button class="mark-btn ${mark.marked ? "done" : ""}" type="button" data-g-mark ${canMark ? "" : "disabled"}>${mark.marked ? "✓ Провёл (снять)" : "Провёл"}</button>
          <button class="mark-btn paid-btn ${paid ? "paid" : ""}" type="button" data-g-paid aria-pressed="${paid}">${paid ? "✓ Оплачено" : "Оплачено?"}</button>
        </div>` : ""}
        <div class="g-actions">${c.status === "planned" ? '<button class="link-btn" type="button" data-g-skip>не придёт — отменить для этого ученика</button>'
        : c.status === "cancelled" ? '<button class="link-btn" type="button" data-g-back>вернуть в занятие</button>' : ""}</div>
      </div>`;
  };
  const hwAll = [];
  live.forEach(c => (c.homework || []).forEach(h => { if (!hwAll.some(x => x.url === h.url)) hwAll.push(Object.assign({ who: h.by && h.by !== "teacher" ? shortName(c.studentId) : "" }, h)); }));
  const call = callLinkFor(main);
  const scopeHtml = inSeries ? `<div class="field"><span>Применить к</span>
        <select id="mScope"><option value="one">только этому занятию</option><option value="following">этому и всем следующим в серии</option></select></div>` : "";
  openModal(`
      <h2>${escHtml(groupLabel(gid))}</h2>
      <div class="meta">${escHtml(fmtWhen(main.startMs, main.endMs))} · <span class="status-pill ${escHtml(status)}">${STATUS_RU[status] || escHtml(status)}</span>${inSeries ? " · серия" : ""} · групповое</div>
      <div class="section">
        <div class="section-title">Участники</div>
        <div id="gMembers">${live.map(memberRow).join("")}</div>
        <div class="hint">«Провёл» и «Оплачено» — у каждого свои; «Провёл» идёт в пакет этого ученика. Сумма — по групповой цене из карточки ученика (не задана — обычная ставка).</div>
        <div class="btn-row" style="margin:6px 0 0"><button class="btn secondary" type="button" id="gMembersEdit">Состав группы…</button></div>
      </div>
      ${status === "planned" ? `<div class="section">
        <div class="section-title">Изменить (для всей группы)</div>
        ${whenFieldsHtml(main.startMs, Math.round((main.endMs - main.startMs) / 60000))}
        ${scopeHtml}
        <div class="btn-row">
          <button class="btn" type="button" id="gSave">Сохранить</button>
          <button class="btn secondary" type="button" id="gMove">Перенести</button>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn secondary" type="button" id="gCancel">Отменить занятие</button>
          <button class="btn danger" type="button" id="gDelete">Удалить</button>
        </div>
      </div>` : ""}
      <div class="section">
        <div class="section-title">Созвон</div>
        ${call ? `<div class="btn-row" style="margin:0 0 6px"><a class="btn" href="${escHtml(call.url)}" target="_blank" rel="noopener" style="text-decoration:none">Открыть созвон</a></div>
          <div class="hint" style="margin-top:0">${call.own ? "Разовая ссылка — только для этого занятия." : call.group ? "Ссылка группы (в «Составе группы»)." : "Ссылка из профиля ученика."}</div>` : '<div class="hint" style="margin-top:0">Ссылку для всей группы можно указать в «Составе группы».</div>'}
        <div class="field" style="margin-top:8px"><span>Другая ссылка только для этого занятия</span>
          <input type="url" id="gCallUrl" maxlength="500" placeholder="https://…" value="${escHtml(main.callUrl || "")}"></div>
        <div class="btn-row" style="margin:0"><button class="btn secondary" type="button" id="gCallSave">Сохранить для этого занятия</button></div>
      </div>
      <div class="section">
        <div class="section-title">Отчёт по занятию (всем участникам)</div>
        <textarea id="gReport" maxlength="5000" placeholder="Что прошли, как получилось, что повторить…">${escHtml(main.report || "")}</textarea>
        <div class="btn-row" style="margin:8px 0 0"><button class="btn" type="button" id="gSaveReport">Отчёт</button></div>
      </div>
      <div class="section">
        <div class="section-title">Домашнее задание (общее на группу)</div>
        ${hwAll.length ? `<ul class="file-list">${hwAll.map(h => `<li><span><a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(h.name || "файл")}</a>${h.who ? ` <span class="cls">(${escHtml(h.who)}, ${ROLE_RU[h.by] || escHtml(h.by)})</span>` : ""}</span><button class="link-btn" type="button" data-g-hw-remove="${escHtml(h.url)}">убрать</button></li>`).join("")}</ul>` : '<div class="hint" style="margin-top:0">Файлов нет.</div>'}
        ${dropZoneHtml("gHwFile", "Добавить файлы для всей группы")}
        <div class="hint">Файлы увидят все участники в своих кабинетах. Файлы, загруженные родителем или учеником, видны только тебе и ему.</div>
      </div>
      <div class="section">
        <div class="section-title">Мой календарь</div>
        <button class="btn secondary" type="button" id="gExport">Добавить в календарь (.ics)</button>
      </div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn secondary" type="button" id="mClose">Закрыть</button></div>`);
  if (note) modalMsg(note, "ok");
  wireGroupModal(copies, main);
}

function wireGroupModal(copies, main) {
  modalLessonId = main.id;
  const live = copies.filter(c => c.status !== "rescheduled");
  const byId = Object.fromEntries(copies.map(c => [c.id, c]));
  const scope = () => (mq("#mScope") ? mq("#mScope").value : "one");
  const busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); if (btn) btn.disabled = false; return; }
    try { await fn(); } catch (e) { console.error(e); modalMsg(isOfflineError(e) ? OFFLINE_TEXT : "Не удалось сохранить (нет интернета?). Попробуй ещё раз.", "err"); }
    finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
  };
  const reopen = async (note, from) => {
    const fresh = await window.TutorFB.getLesson((from || main).id);
    if (fresh) await openGroupModal(fresh, note); else closeModal();
  };
  mq("#mClose").addEventListener("click", closeModal);
  mq("#gMembersEdit").addEventListener("click", () => openGroupEditor(main.groupId, main));
  $("modal").querySelectorAll(".g-member").forEach(row => {
    const c = byId[row.dataset.gid];
    const amount = row.querySelector("[data-g-amount]");
    if (amount) amount.addEventListener("change", (e) => {
      if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
      setOverride(lessonToEv(c), e.target.value);
      renderGroupModal(copies, `Сумма сохранена: ${shortName(c.studentId)}`);
    });
    const mark = row.querySelector("[data-g-mark]");
    if (mark) mark.addEventListener("click", () => {
      const ev = lessonToEv(c);
      toggleMark(ev, marks[c.id]);
      c.status = ev._lesson.status;
      renderGroupModal(copies, `${shortName(c.studentId)}: ${marks[c.id] && marks[c.id].marked ? "проведено" : "отметка снята"}`);
    });
    const paid = row.querySelector("[data-g-paid]");
    if (paid) paid.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const value = !(c.paid && c.paid.value);
      await setPaidByTeacher(c, value);
      await reopen(`${shortName(c.studentId)}: ${value ? "оплачено" : "отметка «оплачено» снята"}`);
    }));
    const skip = row.querySelector("[data-g-skip]");
    if (skip) skip.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      if (!confirm(`Отменить занятие только для ${shortName(c.studentId)}? У остальных оно остаётся.`)) return;
      await setStatusScoped(c, "cancelled", "one", ["planned"]);
      afterLessonsChanged();
      await reopen(`${shortName(c.studentId)}: занятие отменено`);
    }));
    const back = row.querySelector("[data-g-back]");
    if (back) back.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      await setStatusScoped(c, "planned", "one", ["cancelled"]);
      afterLessonsChanged();
      await reopen(`${shortName(c.studentId)}: снова в занятии`, c);
    }));
  });
  if (mq("#gSave")) mq("#gSave").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const when = readWhen();
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    const n = await editGroupScoped(copies.filter(c => c.status !== "rescheduled"), { startMs: when.startMs, durMin: when.durMin, scope: scope() });
    afterLessonsChanged();
    await reopen(n > live.length ? `Сохранено: ${n} копий занятий группы` : "Сохранено");
  }));
  if (mq("#gMove")) mq("#gMove").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const when = readWhen();
    if (!when.ok) { modalMsg("Проверь дату и время.", "err"); return; }
    if (when.startMs === main.startMs && when.durMin * 60000 === main.endMs - main.startMs) { modalMsg("Сначала выбери новые дату или время выше.", "err"); return; }
    const nid = await rescheduleGroup(live, when.startMs, when.startMs + when.durMin * 60000);
    afterLessonsChanged();
    const fresh = nid && await window.TutorFB.getLesson(nid);
    if (fresh) await openGroupModal(fresh, "Перенесено для всей группы"); else closeModal();
  }));
  if (mq("#gCancel")) mq("#gCancel").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const sc = scope();
    if (!confirm(sc === "following" ? "Отменить это и все следующие занятия группы?" : "Отменить занятие для всей группы?")) return;
    const targets = await groupScopeTargets(live, sc, ["planned"]);
    await window.TutorFB.saveLessons(targets.map(x => ({ id: x.id, merge: true, data: { status: "cancelled", updatedAt: Date.now() } })));
    afterLessonsChanged();
    await reopen("Занятие группы отменено");
  }));
  if (mq("#gDelete")) mq("#gDelete").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const sc = scope();
    if (!confirm(sc === "following" ? "Удалить это и все следующие занятия группы насовсем? (Проведённые не удаляются.)" : "Удалить занятие группы насовсем? Если оно просто не состоится — лучше «Отменить».")) return;
    const targets = (await groupScopeTargets(live, sc)).filter(x => x.status !== "done");
    await window.TutorFB.deleteLessons(targets.map(x => x.id));
    closeModal();
    afterLessonsChanged();
  }));
  mq("#gCallSave").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const value = mq("#gCallUrl").value.trim();
    if (value && !safeHref(value)) { modalMsg("Ссылка должна начинаться с https:// (или http://)", "err"); return; }
    await window.TutorFB.saveLessons(live.map(c => ({ id: c.id, merge: true, data: { callUrl: value || null, updatedAt: Date.now() } })));
    publishViewsSoon();
    await reopen(value ? "Разовая ссылка сохранена для всей группы" : "Вернули обычную ссылку");
  }));
  // Отчёт — всем участникам: в каждую копию и уведомлением каждому ученику.
  mq("#gSaveReport").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const report = mq("#gReport").value.trim();
    const changed = report !== (main.report || "").trim();
    const now = Date.now();
    await window.TutorFB.saveLessons(live.map(c => ({ id: c.id, merge: true, data: { report, reportUpdatedAt: now, updatedAt: now } })));
    live.forEach(c => { c.report = report; });
    if (!report) { publishViewsSoon(); modalMsg("Отчёт убран", "ok"); return; }
    if (!changed) { modalMsg("Отчёт уже опубликован — изменений нет", "ok"); return; }
    const head = `Отчёт по занятию ${fmtWhen(main.startMs, main.endMs)}:\n`;
    const text = (head + report).length > 1000 ? (head + report).slice(0, 999) + "…" : head + report;
    let sent = 0;
    const keys = [];
    for (const c of live.filter(x => x.status !== "cancelled")) {
      const k = activeKeysOf(c.studentId);
      if (!k.length) continue;
      await window.TutorFB.saveNotification(newId("n"), {
        title: "Отчёт о занятии", text, mode: "now", times: 1, target: { scope: "student", role: "any", studentId: c.studentId },
        push: true, active: true, lessonIds: [c.id], source: "report", createdAt: now, updatedAt: now,
      });
      keys.push(...k);
      sent++;
    }
    notifCache = null;
    if (keys.length) await publishViews(keys); else publishViewsSoon();
    modalMsg(sent ? `Отчёт опубликован и отправлен: учеников — ${sent} (пуш — с ближайшей рассылкой).` : "Отчёт сохранён. У участников нет доступа к кабинету — отправлять некому.", "ok");
  }));
  $("modal").querySelectorAll("[data-g-hw-remove]").forEach(b => b.addEventListener("click", () => busy(b, async () => {
    const url = b.dataset.gHwRemove;
    await window.TutorFB.saveLessons(live.filter(c => (c.homework || []).some(h => h.url === url))
      .map(c => ({ id: c.id, merge: true, data: { homework: (c.homework || []).filter(h => h.url !== url), updatedAt: Date.now() } })));
    publishViewsSoon();
    await reopen("Файл убран");
  })));
  const zone = $("modal").querySelector('[data-drop="gHwFile"]');
  const upload = (files) => busy(zone, async () => {
    const tooBig = files.filter(f => f.size > CLOUDINARY_MAX_BYTES);
    if (tooBig.length) { modalMsg(`Слишком большой файл: ${tooBig.map(f => f.name).join(", ")} (максимум 10 МБ).`, "err"); return; }
    const uploaded = [];
    for (let i = 0; i < files.length; i++) {
      modalMsg(`Загружаю ${i + 1} из ${files.length}: ${files[i].name}…`);
      uploaded.push(await uploadToCloudinary(files[i]));
    }
    // одна загрузка — ссылка во всех копиях занятия
    const fresh = await groupCopies(main);
    await window.TutorFB.saveLessons(fresh.filter(c => c.status !== "rescheduled")
      .map(c => ({ id: c.id, merge: true, data: { homework: [...(c.homework || []), ...uploaded], updatedAt: Date.now() } })));
    publishViewsSoon();
    await reopen(uploaded.length > 1 ? `Загружено файлов: ${uploaded.length}` : "Файл загружен");
  }).catch(() => {});
  wireDropZone(zone, upload);
  pasteTarget = upload;
  mq("#gExport").addEventListener("click", () => {
    downloadIcs(Object.assign({}, main, { title: groupLabel(main.groupId) }));
    modalMsg("Файл события скачан — открой его, чтобы добавить в календарь.", "ok");
  });
}

// ---------- состав группы (из окна занятия и из карточки ученика) ----------
function openGroupEditor(gid, backTo) {
  const g = groupsMap()[gid] || { name: "", members: [] };
  const students = studentList();
  openModal(`
      <h2>Состав группы</h2>
      <div class="field"><span>Название группы (необязательно)</span><input type="text" id="geName" maxlength="60" value="${escHtml(g.name || "")}" placeholder="Например: ОГЭ, 9 класс"></div>
      <div class="field"><span>Участники</span></div>
      <div class="ge-list">${students.map(st => `<label class="check"><input type="checkbox" data-ge-member="${escHtml(st.id)}"${(g.members || []).includes(st.id) ? " checked" : ""}> ${escHtml(st.name + (st.surname ? " " + st.surname : "") + ", " + st.cls + " класс")}</label>`).join("")}</div>
      <div class="field" style="margin-top:8px"><span>Ссылка на созвон группы (видна участникам)</span><input type="url" id="geCall" maxlength="500" placeholder="https://…" value="${escHtml(g.callUrl || "")}"></div>
      <div class="hint">Новый участник получит все будущие занятия группы (с общими файлами ДЗ), убранный — потеряет свои будущие непроведённые. Прошедшие и проведённые занятия не меняются.</div>
      <div class="msg" id="mMsg"></div>
      <div class="btn-row">
        <button class="btn" type="button" id="geSave">Сохранить состав</button>
        <button class="btn secondary" type="button" id="mClose">Закрыть</button>
      </div>
      ${groupsMap()[gid] ? '<div class="btn-row" style="margin-top:12px; justify-content:flex-end"><button class="btn danger" type="button" id="geDisband">Распустить группу…</button></div>' : ""}`);
  if (mq("#geDisband")) mq("#geDisband").addEventListener("click", async (e) => {
    const btn = e.currentTarget; // после await у события его уже нет
    if (!confirm(`Распустить ${groupLabel(gid).toLowerCase()}? Будущие непроведённые занятия группы удалятся у всех участников. Прошедшие и проведённые останутся в истории.`)) return;
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
    btn.disabled = true;
    try {
      const now = Date.now();
      const doomed = (await window.TutorFB.listGroupLessons(gid)).filter(l => l.startMs >= now && l.status !== "done").map(l => l.id);
      await window.TutorFB.deleteLessons(doomed);
      await saveGroup(gid, null);
      closeModal();
      afterLessonsChanged();
      if (activeTab === "students") renderStudentsRoster();
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не получилось (нет интернета?). Повтор безопасен.", "err");
    }
  });
  mq("#mClose").addEventListener("click", () => { if (backTo) openLessonModal(backTo.id); else closeModal(); });
  mq("#geSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget; // после await у события его уже нет
    const members = [...$("modal").querySelectorAll("[data-ge-member]")].filter(x => x.checked).map(x => x.dataset.geMember);
    const name = mq("#geName").value.trim().slice(0, 60);
    const callUrl = mq("#geCall").value.trim();
    if (members.length < 1) { modalMsg("Оставь в группе хотя бы одного ученика.", "err"); return; }
    if (callUrl && !safeHref(callUrl)) { modalMsg("Ссылка должна начинаться с https:// (или http://)", "err"); return; }
    if (!navigator.onLine) { modalMsg(OFFLINE_TEXT, "err"); return; }
    const removed = (g.members || []).filter(x => !members.includes(x));
    if (removed.length && !confirm(`Убрать из группы: ${removed.map(shortName).join(", ")}? Их будущие непроведённые занятия группы удалятся.`)) return;
    btn.disabled = true;
    try {
      const r = await applyGroupMembers(gid, members);
      await saveGroup(gid, Object.assign({}, g, { name, members, callUrl: callUrl || null, updatedAt: Date.now() }));
      afterLessonsChanged();
      if (activeTab === "students") renderStudentsRoster();
      const parts = [r.added.length ? `добавлены: ${r.added.map(shortName).join(", ")} (занятий: ${r.created})` : "", r.removed.length ? `убраны: ${r.removed.map(shortName).join(", ")} (удалено занятий: ${r.deleted})` : ""].filter(Boolean);
      if (backTo) { const fresh = await window.TutorFB.getLesson(backTo.id); if (fresh) { await openGroupModal(fresh, "Состав сохранён" + (parts.length ? ": " + parts.join("; ") : "")); return; } }
      modalMsg("Состав сохранён" + (parts.length ? ": " + parts.join("; ") : ""), "ok");
      btn.disabled = false;
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      modalMsg(isOfflineError(err) ? OFFLINE_TEXT : "Не сохранилось (нет интернета?). Повтор безопасен.", "err");
    }
  });
}

// ---------- файлы ДЗ: перетаскивание, выбор, вставка из буфера ----------
function dropZoneHtml(id, label) {
  return `<label class="drop-zone" data-drop="${id}" tabindex="0">
      <input type="file" id="${id}" multiple>
      <span class="dz-main">${escHtml(label)}</span>
      <span class="dz-sub">перетащи фото или файл сюда, нажми, чтобы выбрать, или вставь скриншот (Ctrl+V)</span>
    </label>`;
}
function wireDropZone(zone, onFiles) {
  if (!zone) return;
  const input = zone.querySelector('input[type="file"]');
  input.addEventListener("change", () => { const f = Array.from(input.files || []); input.value = ""; if (f.length) onFiles(f); });
  ["dragenter", "dragover"].forEach(t => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) onFiles(f); });
}
// Файлы из буфера обмена (скриншот): у картинки из буфера имя «image.png» — даём понятное.
function filesFromClipboard(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const stamp = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[.,: ]+/g, "-");
  return items.filter(i => i.kind === "file").map((i, n) => {
    const f = i.getAsFile();
    if (!f) return null;
    if (!f.name || /^image\.\w+$/i.test(f.name)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `скриншот-${stamp}${n ? "-" + (n + 1) : ""}.${ext}`, { type: f.type });
    }
    return f;
  }).filter(Boolean);
}
var pasteTarget = null; // (var — без «мёртвой зоны»: нужна в openModal/closeModal) куда вставлять файлы из буфера, пока открыто окно занятия
document.addEventListener("paste", (e) => {
  if (!pasteTarget || $("modalBack").style.display === "none") return;
  const files = filesFromClipboard(e);
  if (!files.length) return; // обычный текст — вставляется как обычно
  e.preventDefault();
  pasteTarget(files);
});
async function uploadHwTo(lessonId, files) {
  const tooBig = files.filter(f => f.size > CLOUDINARY_MAX_BYTES);
  if (tooBig.length) { modalMsg(`Слишком большой файл: ${tooBig.map(f => f.name).join(", ")} (максимум 10 МБ).`, "err"); return 0; }
  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    modalMsg(`Загружаю ${i + 1} из ${files.length}: ${files[i].name}…`);
    uploaded.push(await uploadToCloudinary(files[i]));
  }
  const fresh = await window.TutorFB.getLesson(lessonId);
  const hw = [...((fresh && fresh.homework) || []), ...uploaded];
  await window.TutorFB.updateLesson(lessonId, { homework: hw, updatedAt: Date.now() });
  publishViewsSoon();
  return uploaded.length;
}
// Следующее запланированное занятие этого же ученика (по studentId — с фамилией).
async function nextLessonOf(l) {
  const own = await window.TutorFB.listLessonsOfStudent(l.studentId);
  return own.filter(x => x.id !== l.id && x.status === "planned" && !isPersonal(x) && x.startMs > l.startMs)
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
}
var modalLessonId = null; // (var — см. pasteTarget) какое занятие сейчас открыто в окне
async function renderNextHw(l, busy) {
  const box = mq("#mNextHw");
  let next = null;
  try { next = await nextLessonOf(l); } catch (e) { /* без сети */ }
  if (!box || !box.isConnected || modalLessonId !== l.id) return;
  if (!next) {
    box.innerHTML = '<div class="section-title">ДЗ к следующему занятию</div><div class="hint" style="margin-top:0">У ученика пока нет следующего занятия в расписании.</div>';
    return;
  }
  const hw = Array.isArray(next.homework) ? next.homework : [];
  box.innerHTML = `<div class="section-title">ДЗ к следующему занятию</div>
      <div style="margin-bottom:8px">${escHtml(fmtWhen(next.startMs, next.endMs))}${pkgSuffix(next.title).trim() ? " · " + escHtml(pkgSuffix(next.title).trim()) : ""}
        <button class="link-btn" type="button" data-open="${escHtml(next.id)}">открыть</button></div>
      ${hw.length ? `<ul class="file-list">${hw.map(h => `<li><span><a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(h.name || "файл")}</a></span></li>`).join("")}</ul>` : ""}
      ${dropZoneHtml("mNextHwFile", "Прикрепить ДЗ к следующему занятию")}
      <div class="hint">Файлы попадут в следующее занятие ученика — родитель и ученик увидят их у него.</div>`;
  const zone = box.querySelector('[data-drop="mNextHwFile"]');
  const upload = (files) => busy(zone, async () => {
    const n = await uploadHwTo(next.id, files);
    if (n) { modalMsg(`ДЗ к занятию ${fmtWhen(next.startMs)}: ${n === 1 ? "файл прикреплён" : "прикреплено файлов: " + n}`, "ok"); renderNextHw(l, busy); }
  }).catch(() => {});
  wireDropZone(zone, upload);
  zone.addEventListener("focusin", () => { pasteTarget = upload; });
  const openBtn = box.querySelector("[data-open]");
  if (openBtn) openBtn.addEventListener("click", () => openLessonModal(next.id));
}

// ---------- «ДОБАВИТЬ В КАЛЕНДАРЬ»: файл .ics (без входа в Google) ----------
// Стандарт iCalendar (RFC 5545): время в UTC, строки через CRLF, длинные
// строки переносятся, спецсимволы экранируются. UID каждый раз новый —
// повторное нажатие просто добавит ещё одно событие.

function icsEscape(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
}
function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 73) { out.push(cur); cur = " " + ch; bytes = 1 + n; } else { cur += ch; bytes += n; }
  }
  out.push(cur);
  return out.join("\r\n");
}
function buildIcs(l) {
  const call = callLinkFor(l);
  const desc = [call ? "Созвон: " + call.url : "", l.report ? "Отчёт: " + l.report : ""].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tutor-dashboard//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${l.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tutor-dashboard`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(l.startMs)}`,
    `DTEND:${icsDate(l.endMs)}`,
    `SUMMARY:${icsEscape(displayTitle(l.title))}`,
    desc ? `DESCRIPTION:${icsEscape(desc)}` : null,
    call ? `URL:${call.url}` : null,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Занятие", "TRIGGER:-PT30M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
function downloadIcs(l) {
  const blob = new Blob([buildIcs(l)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zanyatie-${l.date || "lesson"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- ФАЙЛЫ ДОМАШКИ (Cloudinary, unsigned upload) ----------

const CLOUDINARY_CLOUD = "xf4hvf5p";
const CLOUDINARY_PRESET = "tutor-dashboard";
const CLOUDINARY_MAX_BYTES = 10 * 1024 * 1024; // лимит бесплатного тарифа для фото/документов

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) {
    const why = (data.error && data.error.message) || ("код " + res.status);
    modalMsg(`Cloudinary не принял файл «${file.name}»: ${why}`, "err");
    const err = new Error("cloudinary " + why);
    err.shown = true;
    throw err;
  }
  return { url: data.secure_url, name: file.name, bytes: data.bytes || file.size, format: data.format || "", uploadedAt: Date.now() };
}

$("fcAddBtn").addEventListener("click", () => openCreateModal());
$("fcPersonalBtn").addEventListener("click", () => openPersonalModal());

// ---------- НАВИГАЦИЯ ПО ВКЛАДКАМ ----------

// «Статистика»: подвкладки «Итоги» (по умолчанию) и «Аналитика»; выбранная
// запоминается до перезагрузки страницы.
let statsMode = "summary";
function showStats(mode) {
  statsMode = mode === "analytics" ? "analytics" : "summary";
  document.querySelectorAll("#view-stats [data-statsmode]").forEach(t => t.classList.toggle("active", t.dataset.statsmode === statsMode));
  $("view-summary").style.display = statsMode === "summary" ? "block" : "none";
  $("view-analytics").style.display = statsMode === "analytics" ? "block" : "none";
  if (statsMode === "summary") refreshSummary(); else loadAnalytics();
}
document.querySelectorAll("#view-stats [data-statsmode]").forEach(t => t.addEventListener("click", () => showStats(t.dataset.statsmode)));

function showTab(tab) {
  if (tab === "summary" || tab === "analytics") { statsMode = tab; tab = "stats"; } // старые названия
  activeTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  TEACHER_TABS.forEach(t => {
    $("view-" + t).style.display = t === tab ? "block" : "none";
  });
  if (tab === "lessons") { stopPoll(); loadLessonEvents(); }
  else if (tab === "calendar") { stopPoll(); refreshCalendar(); }
  else if (tab === "requests") { stopPoll(); renderRequests(); }
  else if (tab === "notify") { stopPoll(); renderNotifyTab(); }
  else if (tab === "stats") { stopPoll(); showStats(statsMode); }
  else if (tab === "students") { stopPoll(); renderStudentsRoster(); loadPackages(); loadAccessCard(); }
  else if (tab === "schedule") { stopPoll(); loadSchedule(); }
  else if (tab === "settings") { stopPoll(); prepareBackup(); renderSettingsTab(); }
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});
if (window.appTheme) window.appTheme.mount($("themeToggle"));

// ---------- УВЕДОМЛЕНИЯ (конструктор) ----------
// Логика «кому и когда» — в notify-core.js (общая с кабинетами и фоновой
// рассылкой). Здесь — форма, список и публикация в витрины: кабинет сам
// показывает сообщения при открытии и напоминания перед занятиями, а пуши
// на телефон шлёт GitHub Actions (notifier/), раз в ~15 минут.
let notifCache = null;
async function getNotifications(force) {
  if (!notifCache || force) notifCache = await window.TutorFB.listNotifications();
  return notifCache;
}
const NF_ROLE = { any: "все", parent: "родители", student: "ученик" };
const roleWord = (r) => (r === "parent" ? "родитель" : "ученик");
function recipientGroups() {
  const keys = (accessKeysCache || []).filter(k => k.active);
  const common = [
    { t: { scope: "all", role: "any" }, label: "Все родители и ученики" },
    { t: { scope: "all", role: "parent" }, label: "Все родители" },
    { t: { scope: "all", role: "student" }, label: "Все ученики" },
  ];
  const sids = [...new Set(keys.map(k => k.studentId))].sort((a, b) => studentLabel(a).localeCompare(studentLabel(b), "ru"));
  const groups = sids.map(sid => {
    const ks = keys.filter(k => k.studentId === sid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lbl = studentLabel(sid);
    const items = [{ t: { scope: "student", role: "any", studentId: sid }, label: `${lbl} — все` }];
    if (ks.some(k => k.role === "parent")) items.push({ t: { scope: "student", role: "parent", studentId: sid }, label: `${lbl} — родители` });
    if (ks.some(k => k.role === "student")) items.push({ t: { scope: "student", role: "student", studentId: sid }, label: `${lbl} — ученик` });
    if (ks.length > 1) ks.forEach(k => items.push({ t: { scope: "key", role: k.role, studentId: sid, key: k.id }, label: `${lbl} — ${k.label ? `${k.label} (${roleWord(k.role)})` : `только ${roleWord(k.role)}`}` }));
    return { label: lbl, items };
  });
  return { common, groups };
}
const targetValue = (t) => JSON.stringify([t.scope, t.role || "any", t.studentId || null, t.key || null]);
function fillRecipientSelect(sel) {
  const prev = sel.value;
  const { common, groups } = recipientGroups();
  const one = (o) => `<option value="${escHtml(targetValue(o.t))}" data-t="${escHtml(JSON.stringify(o.t))}">${escHtml(o.label)}</option>`;
  sel.innerHTML = common.map(one).join("") + groups.map(g => `<optgroup label="${escHtml(g.label)}">${g.items.map(one).join("")}</optgroup>`).join("");
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function setRecipient(sel, t) {
  const v = targetValue(t);
  if (![...sel.options].some(o => o.value === v)) {
    // адресата уже нет в списке (доступ отозван) — всё равно показываем
    sel.insertAdjacentHTML("beforeend", `<option value="${escHtml(v)}" data-t="${escHtml(JSON.stringify(t))}">${escHtml(targetText(t))}</option>`);
  }
  sel.value = v;
}
const readTarget = (sel) => { const o = sel.selectedOptions[0]; return o ? JSON.parse(o.dataset.t) : null; };
function targetText(t) {
  if (!t) return "—";
  if (t.scope === "all") return t.role === "parent" ? "все родители" : t.role === "student" ? "все ученики" : "все родители и ученики";
  const base = studentLabel(t.studentId);
  if (t.scope === "key") {
    const k = (accessKeysCache || []).find(x => x.id === t.key);
    return `${base} — ${k && k.active ? (k.label || roleWord(k.role)) : "доступ отозван"}`;
  }
  return `${base} — ${NF_ROLE[t.role || "any"]}`;
}

// Выбор занятий — только когда адресат один ученик (или его родитель).
async function renderNfLessons(selected) {
  const t = readTarget($("nfTo"));
  const sid = t && t.scope !== "all" ? t.studentId : null;
  $("nfLessonsWrap").style.display = sid ? "block" : "none";
  if (!sid) { $("nfLessons").innerHTML = ""; return; }
  const keep = new Set(selected || [...$("nfLessons").querySelectorAll("input:checked")].map(i => i.value));
  const now = Date.now();
  let ls = [];
  try { ls = await window.TutorFB.listLessons(now, now + 120 * DAY_MS); } catch (e) { /* без списка */ }
  ls = ls.filter(l => l.studentId === sid && l.status === "planned" && !isPersonal(l)).sort((a, b) => a.startMs - b.startMs);
  $("nfLessons").innerHTML = ls.length
    ? ls.map(l => `<label class="check"><input type="checkbox" value="${escHtml(l.id)}"${keep.has(l.id) ? " checked" : ""}> ${escHtml(fmtWhen(l.startMs, l.endMs))}${pkgSuffix(l.title).trim() ? " · " + escHtml(pkgSuffix(l.title).trim()) : ""}</label>`).join("")
    : '<div class="hint" style="margin:0">Запланированных занятий нет.</div>';
  $("nfLessons").querySelectorAll("input").forEach(i => i.addEventListener("change", () => {
    document.querySelector('input[name="nfLessonsMode"][value="some"]').checked = true;
  }));
}

// свой заголовок (пусто — в кабинете и пуше будет стандартный)
const headOf = (id) => $(id).value.replace(/\s+/g, " ").trim().slice(0, NotifyCore.TITLE_MAX);
// Подсказка в пустом поле — какой заголовок будет по умолчанию.
function syncHeadPlaceholder() {
  const mode = document.querySelector('input[name="nfMode"]:checked');
  $("nfHead").placeholder = NotifyCore.DEFAULT_TITLE[mode && mode.value === "before" ? "rem" : "msg"];
}
document.querySelectorAll('input[name="nfMode"]').forEach(i => i.addEventListener("change", syncHeadPlaceholder));
function nfMsg(id, t, kind) { const m = $(id); m.textContent = t; m.className = "msg" + (kind ? " " + kind : ""); }
let nfEditing = null; // уведомление, которое сейчас правим

function resetNfForm() {
  nfEditing = null;
  $("nfTitle").textContent = "Новое уведомление";
  $("nfSave").textContent = "Сохранить уведомление";
  $("nfCancel").style.display = "none";
  $("nfText").value = "";
  $("nfHead").value = "";
  document.querySelector('input[name="nfMode"][value="before"]').checked = true;
  $("nfOffset").value = "90"; $("nfUnit").value = "min"; $("nfTimes").value = "1";
  document.querySelector('input[name="nfLessonsMode"][value="all"]').checked = true;
  $("nfPush").checked = true;
  $("nfLessons").querySelectorAll("input").forEach(i => { i.checked = false; });
  syncHeadPlaceholder();
}
function editNotification(r) {
  nfEditing = r;
  $("nfTitle").textContent = "Изменить уведомление";
  $("nfSave").textContent = "Сохранить изменения";
  $("nfCancel").style.display = "";
  $("nfText").value = r.text || "";
  $("nfHead").value = r.title || "";
  document.querySelector(`input[name="nfMode"][value="${r.mode === "once" ? "once" : "before"}"]`).checked = true;
  if (r.mode === "before") { $("nfOffset").value = String(r.offsetValue); $("nfUnit").value = r.offsetUnit; }
  if (r.mode === "once") $("nfTimes").value = String(r.times || 1);
  syncHeadPlaceholder();
  setRecipient($("nfTo"), r.target || { scope: "all", role: "any" });
  const some = Array.isArray(r.lessonIds) && r.lessonIds.length;
  document.querySelector(`input[name="nfLessonsMode"][value="${some ? "some" : "all"}"]`).checked = true;
  $("nfPush").checked = r.push !== false;
  renderNfLessons(r.lessonIds || []);
  nfMsg("nfMsg", "");
  $("nfCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderNotifyTab() {
  try { await getAccessKeys(); } catch (e) { /* без списка доступов */ }
  fillRecipientSelect($("nwTo"));
  renderTemplates();
  const nfTarget = nfEditing ? null : $("nfTo").value;
  fillRecipientSelect($("nfTo"));
  if (nfEditing) setRecipient($("nfTo"), nfEditing.target);
  else if (nfTarget) $("nfTo").value = nfTarget;
  renderNfLessons();
  renderNfList();
  await ensureStarterTemplates();
  renderTemplates();
}

// ---- «Настройки»: порядок вкладок, уведомления мне, шаблоны, статус пушей ----
const TAB_LABELS = () => Object.fromEntries([...document.querySelectorAll(".tabs .tab")].map(t => [t.dataset.tab, t.childNodes[0].textContent.trim()]));
let tabOrderEditor = null;
function renderSettingsTab() {
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

async function renderNfList() {
  const el = $("nfList");
  let rules, log = [];
  try {
    rules = await getNotifications(true);
  } catch (e) {
    el.innerHTML = isPermissionDenied(e)
      ? '<div class="hint" style="margin-top:0">База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy, см. README.md).</div>'
      : '<div class="empty">Не удалось загрузить</div>';
    return;
  }
  try { log = await window.TutorFB.listNotifLog(); } catch (e) { /* журнала нет */ }
  const now = Date.now();
  const fmtAt = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const list = rules.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) { el.innerHTML = '<div class="empty">Уведомлений пока нет — создай выше.</div>'; return; }
  el.innerHTML = list.map(r => {
    const mine = log.filter(x => x.ruleId === r.id);
    const devices = mine.reduce((t, x) => t + (x.delivered || 0), 0);
    const last = mine.reduce((t, x) => Math.max(t, x.sentAt || 0), 0);
    const pushLine = r.push === false ? "без пуша"
      : mine.length ? `пуш: ${mine.length} ${NotifyCore.plural(mine.length, ["рассылка", "рассылки", "рассылок"])}, доставлено на ${devices} ${NotifyCore.plural(devices, ["устройство", "устройства", "устройств"])}, последняя ${fmtAt(last)}`
      : "пуш: ещё не отправлялся";
    const when = r.mode === "before"
      ? `Перед занятием — за ${NotifyCore.offsetText(r)}${Array.isArray(r.lessonIds) && r.lessonIds.length ? ` · к ${r.lessonIds.length} ${NotifyCore.plural(r.lessonIds.length, ["занятию", "занятиям", "занятиям"])}` : " · ко всем занятиям"}`
      : r.mode === "once" ? `Разово — при открытии кабинета ${r.times || 1} ${NotifyCore.plural(r.times || 1, ["раз", "раза", "раз"])}`
      : `Отправлено сейчас · ${fmtAt(r.createdAt || now)}${now - (r.createdAt || 0) > NotifyCore.NOW_TTL_MS ? " (в кабинете уже не показывается)" : ""}`;
    const off = r.active === false;
    return `<div class="nf-item${off ? " off" : ""}" data-nf="${escHtml(r.id)}">
        <div class="nf-head${r.title ? "" : " dflt"}">${escHtml(r.title || NotifyCore.DEFAULT_TITLE[r.mode === "before" ? "rem" : "msg"])}</div>
        <div class="nf-text">${escHtml(r.text || "")}</div>
        <div class="nf-meta">${escHtml(when)} · ${escHtml(targetText(r.target))}${off ? " · <b>выключено</b>" : ""}</div>
        <div class="nf-meta">${escHtml(pushLine)}</div>
        <div class="nf-actions">
          ${r.mode !== "now" ? '<button class="link-btn" type="button" data-nf-edit>Изменить</button>' : ""}
          ${r.mode !== "now" ? `<button class="link-btn" type="button" data-nf-toggle>${off ? "Включить" : "Выключить"}</button>` : ""}
          <button class="link-btn" type="button" data-nf-delete>Удалить</button>
        </div>
      </div>`;
  }).join("");
}

async function renderPushStatus() {
  const el = $("nfPushStatus");
  const keys = (accessKeysCache || []).filter(k => k.active);
  const perStudent = {};
  for (const [sid, ch] of Object.entries(studentChannels())) {
    if (!ch || !ch.shared) continue;
    let items = [];
    try { items = await window.TutorFB.listChannel(ch.shared); } catch (e) { /* пусто */ }
    const byHash = await NotifyCore.pushKeyMap(keys);
    const tokens = new Set(items.filter(i => i.type === "push" && NotifyCore.pushItemKey(i, byHash)).map(i => i.token));
    if (tokens.size) perStudent[sid] = tokens.size;
  }
  const run = remoteState.notifier && remoteState.notifier.lastRunAt;
  const runLine = run
    ? `Фоновая рассылка работает: последний запуск ${new Date(run).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.`
    : "Фоновая рассылка ещё ни разу не запускалась — пуши не уходят, пока её не настроить (README.md → «Уведомления»). Сообщения в кабинетах работают и без неё.";
  const rows = Object.entries(perStudent).sort((a, b) => studentLabel(a[0]).localeCompare(studentLabel(b[0]), "ru"))
    .map(([sid, n]) => `<div class="session-row"><span class="when">${escHtml(studentLabel(sid))}</span><span>${n} ${NotifyCore.plural(n, ["устройство", "устройства", "устройств"])}</span></div>`).join("");
  el.innerHTML = `<div class="hint" style="margin-top:0">${escHtml(runLine)}</div>
      ${rows ? `<div style="margin-top:8px">${rows}</div>` : '<div class="hint">Пока никто не включил уведомления на телефоне.</div>'}`;
}

$("nfTo").addEventListener("change", () => renderNfLessons([]));
// тронули число или единицу — выбираем и сам вариант «Когда»
document.querySelectorAll("#nfCard .nf-inline").forEach(row => row.addEventListener("focusin", () => {
  document.querySelector(`input[name="nfMode"][value="${row.dataset.mode}"]`).checked = true;
  syncHeadPlaceholder();
}));
$("nfCancel").addEventListener("click", () => { resetNfForm(); renderNfLessons([]); nfMsg("nfMsg", ""); });

$("nfSave").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const text = $("nfText").value.trim();
  const mode = document.querySelector('input[name="nfMode"]:checked').value;
  const target = readTarget($("nfTo"));
  if (!text) { nfMsg("nfMsg", "Напиши текст уведомления.", "err"); return; }
  if (!target) { nfMsg("nfMsg", "Выбери, кому.", "err"); return; }
  const now = Date.now();
  const data = { title: headOf("nfHead"), text: text.slice(0, 1000), mode, target, push: $("nfPush").checked, active: true, updatedAt: now };
  if (mode === "once") {
    const n = parseInt($("nfTimes").value, 10);
    if (!(n >= 1 && n <= 50)) { nfMsg("nfMsg", "Сколько раз показать — число от 1 до 50.", "err"); return; }
    data.times = n;
  } else {
    const v = parseFloat(String($("nfOffset").value).replace(",", "."));
    const unit = $("nfUnit").value;
    const ms = v * (NotifyCore.UNIT_MS[unit] || 0);
    if (!(v > 0) || !(ms >= 60000) || ms > 60 * DAY_MS) { nfMsg("nfMsg", "За сколько до занятия — число больше нуля (не больше 60 дней).", "err"); return; }
    data.offsetValue = v;
    data.offsetUnit = unit;
  }
  data.lessonIds = [];
  if (target.scope !== "all" && document.querySelector('input[name="nfLessonsMode"]:checked').value === "some") {
    data.lessonIds = [...$("nfLessons").querySelectorAll("input:checked")].map(i => i.value);
    if (!data.lessonIds.length) { nfMsg("nfMsg", "Отметь хотя бы одно занятие (или выбери «ко всем занятиям»).", "err"); return; }
  }
  // Разовое после правки — это новое сообщение: покажется и отправится заново.
  const keepId = nfEditing && nfEditing.mode === "before" && mode === "before";
  const id = keepId ? nfEditing.id : newId("n");
  data.createdAt = keepId ? (nfEditing.createdAt || now) : now;
  btn.disabled = true;
  try {
    await window.TutorFB.saveNotification(id, data);
    if (nfEditing && !keepId) await window.TutorFB.deleteNotification(nfEditing.id);
    notifCache = null;
    const wasEdit = !!nfEditing;
    resetNfForm();
    renderNfLessons([]);
    nfMsg("nfMsg", wasEdit ? "Изменения сохранены" : "Уведомление сохранено", "ok");
    renderNfList();
    await publishViews();
  } catch (err) {
    console.error(err);
    nfMsg("nfMsg", isPermissionDenied(err) ? "База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy)." : "Не сохранилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});

$("nwSend").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const text = $("nwText").value.trim();
  const target = readTarget($("nwTo"));
  if (!text) { nfMsg("nwMsg", "Напиши текст.", "err"); return; }
  if (!target) { nfMsg("nwMsg", "Выбери, кому.", "err"); return; }
  const matched = (accessKeysCache || []).filter(k => k.active && NotifyCore.keyMatches(target, k));
  if (!matched.length) { nfMsg("nwMsg", "У этого адресата нет действующего доступа к кабинету.", "err"); return; }
  const now = Date.now();
  btn.disabled = true;
  nfMsg("nwMsg", "Отправляю…");
  try {
    await window.TutorFB.saveNotification(newId("n"), { title: headOf("nwHead"), text: text.slice(0, 1000), mode: "now", times: 1, target, push: $("nwPush").checked, active: true, lessonIds: [], createdAt: now, updatedAt: now });
    notifCache = null;
    await publishViews(matched);
    $("nwText").value = "";
    $("nwHead").value = "";
    nfMsg("nwMsg", `Отправлено: ${targetText(target)} (${matched.length} ${NotifyCore.plural(matched.length, ["кабинет", "кабинета", "кабинетов"])}).${$("nwPush").checked ? " Пуш уйдёт с ближайшей фоновой рассылкой." : ""}`, "ok");
    renderNfList();
  } catch (err) {
    console.error(err);
    nfMsg("nwMsg", isPermissionDenied(err) ? "База пока не пускает к уведомлениям — нужно обновить правила (firebase deploy)." : "Не отправилось (нет интернета?)", "err");
  }
  btn.disabled = false;
});

$("nfList").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-nf]");
  if (!item) return;
  const r = (notifCache || []).find(x => x.id === item.dataset.nf);
  if (!r) return;
  try {
    if (e.target.closest("[data-nf-edit]")) { editNotification(r); return; }
    if (e.target.closest("[data-nf-toggle]")) {
      await window.TutorFB.patchNotification(r.id, { active: r.active === false, updatedAt: Date.now() });
    } else if (e.target.closest("[data-nf-delete]")) {
      if (!confirm("Удалить уведомление? В кабинетах оно пропадёт, пуши по нему больше не пойдут.")) return;
      await window.TutorFB.deleteNotification(r.id);
      if (nfEditing && nfEditing.id === r.id) resetNfForm();
    } else return;
    notifCache = null;
    await renderNfList();
    await publishViews();
  } catch (err) {
    console.error(err);
    alert("Не получилось (нет интернета?)");
  }
});

// ---------- РЕЗЕРВНАЯ КОПИЯ ----------
// Файлы готовятся ЗАРАНЕЕ (при открытии «Ещё»), а по нажатию отдаются сразу,
// без await: Safari на iPhone разрешает скачивание/«Поделиться» только прямо
// в нажатии. На iPhone — через «Поделиться» (→ «Сохранить в Файлы»): там
// видно, сохранили или отменили, и «Сохранено» пишем только при успехе.
// На компьютере/Android — обычное скачивание; браузер не сообщает, дошёл
// ли файл, поэтому пишем «скачивание запущено», а не «сохранено».
const backupStamp = () => { const d = mskParts(Date.now()); return `${d.date}_${d.time.replace(":", "-")}`; };
const isIOSDevice = () => /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let backupReady = null;   // { json: File, csv: File, lessons, students, at }
let backupLoading = null;
const BACKUP_FRESH_MS = 5 * 60000;
function backupMsg(t, kind) { const m = $("backupMsg"); m.textContent = t; m.className = "msg" + (kind ? " " + kind : ""); }
function setBackupButtons(on) { $("backupJsonBtn").disabled = !on; $("backupCsvBtn").disabled = !on; }
function buildBackupCsv(data) {
  const marksAll = (data.state && data.state.marks) || {};
  const cell = (v) => { const t = v == null ? "" : String(v); return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [["Дата", "Время", "Минут", "Ученик", "Название", "Статус", "Провёл", "Сумма, ₽", "Оплачено", "Отчёт", "Пояснение", "Файлы ДЗ", "Группа"]];
  data.lessons.forEach(l => {
    const when = mskParts(l.startMs || 0);
    const m = marksAll[l.id] || {};
    const amount = m.overrideAmount != null ? m.overrideAmount : (m.marked && m.lockedRate != null ? m.lockedRate : "");
    rows.push([
      when.date, when.time, l.durationMin || Math.round(((l.endMs || 0) - (l.startMs || 0)) / 60000),
      l.kind === "personal" ? "(личное время)" : studentLabel(l.studentId) || "",
      l.kind === "personal" ? (l.note || "Личное время") : displayTitle(l.title),
      STATUS_RU[l.status] || l.status || "", m.marked ? "да" : "", amount,
      l.paid && l.paid.value ? "да" : "", l.report || "", (l.familyNote && l.familyNote.text) || "",
      (Array.isArray(l.homework) ? l.homework : []).map(h => h.url).join(" "),
      l.groupId ? groupLabel(l.groupId) : "",
    ]);
  });
  // «;» и BOM — чтобы русский Excel сразу открыл по столбцам и с кириллицей
  return "\ufeff" + rows.map(r => r.map(cell).join(";")).join("\r\n");
}
function prepareBackup(force) {
  if (backupLoading) return backupLoading;
  if (!force && backupReady && Date.now() - backupReady.at < BACKUP_FRESH_MS) return Promise.resolve(backupReady);
  setBackupButtons(false);
  backupMsg("Готовлю резервную копию…");
  backupLoading = (async () => {
    try {
      const data = await window.TutorFB.exportAll();
      data.lessons.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
      const out = Object.assign({
        app: "tutor-dashboard", format: 1, exportedAt: new Date().toISOString(),
        account: ($("userBadge") && $("userBadge").textContent.trim()) || null,
      }, data);
      const stamp = backupStamp();
      backupReady = {
        json: new File([JSON.stringify(out, null, 2)], `zanyatiya-backup_${stamp}.json`, { type: "application/json" }),
        csv: new File([buildBackupCsv(data)], `zanyatiya_${stamp}.csv`, { type: "text/csv;charset=utf-8" }),
        lessons: data.lessons.length,
        students: Object.keys((data.state && data.state.studentProfiles) || {}).length,
        at: Date.now(),
      };
      backupMsg(`Копия готова: занятий ${backupReady.lessons}, учеников ${backupReady.students}. Нажми кнопку, чтобы сохранить.`);
    } catch (err) {
      console.error(err);
      backupReady = null;
      backupMsg("Не получилось собрать копию (нет интернета?). Открой вкладку «Ещё» ещё раз.", "err");
    } finally {
      backupLoading = null;
      setBackupButtons(true);
    }
    return backupReady;
  })();
  return backupLoading;
}
// Отдать готовый файл — синхронно, прямо в обработчике нажатия.
function deliverBackup(file, what) {
  if (isIOSDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: file.name })
      .then(() => backupMsg(`Сохранено: ${what}. Проверь в «Файлах» или там, куда сохранено.`, "ok"))
      .catch((e) => backupMsg(e && e.name === "AbortError" ? "Отменено — файл не сохранён." : "Не получилось сохранить файл — попробуй ещё раз.", "err"));
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  backupMsg(`Скачивание запущено: ${what}, файл «${file.name}». Проверь папку «Загрузки»; если файла там нет — нажми ещё раз.`, "ok");
}
function onBackupClick(kind) {
  const fresh = backupReady && Date.now() - backupReady.at < BACKUP_FRESH_MS;
  if (!fresh) {
    // данных ещё нет или они устарели: готовим и просим нажать ещё раз
    // (скачивание после ожидания Safari на iPhone не пропустит)
    prepareBackup(true);
    return;
  }
  deliverBackup(backupReady[kind], kind === "json" ? `занятий ${backupReady.lessons}, учеников ${backupReady.students}` : `${backupReady.lessons} занятий в таблице`);
}
$("backupJsonBtn").addEventListener("click", () => onBackupClick("json"));
$("backupCsvBtn").addEventListener("click", () => onBackupClick("csv"));

document.querySelectorAll('.subtab[data-lessonmode]').forEach(tab => {
  tab.addEventListener("click", () => {
    lessonMode = tab.dataset.lessonmode;
    document.querySelectorAll('.subtab[data-lessonmode]').forEach(t => t.classList.toggle("active", t === tab));
    loadLessonEvents();
  });
});
document.querySelector('.subtab[data-lessonmode="day"]').classList.add("active");

document.querySelectorAll('.subtab[data-summode]').forEach(tab => {
  tab.addEventListener("click", () => {
    summaryMode = tab.dataset.summode;
    document.querySelectorAll('.subtab[data-summode]').forEach(t => t.classList.toggle("active", t === tab));
    refreshSummary();
  });
});
document.querySelector('.subtab[data-summode="week"]').classList.add("active");

$("prevBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset--; else weekOffset--;
  loadLessonEvents();
});
$("nextBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset++; else weekOffset++;
  loadLessonEvents();
});
$("markPastBtn").addEventListener("click", markAllPast);

$("summaryPrevBtn").addEventListener("click", () => {
  if (summaryMode === "month") summaryMonthOffset--; else summaryWeekOffset--;
  refreshSummary();
});
$("summaryNextBtn").addEventListener("click", () => {
  if (summaryMode === "month") summaryMonthOffset++; else summaryWeekOffset++;
  refreshSummary();
});
$("summaryRangeGoBtn").addEventListener("click", refreshSummary);
$("copySummaryBtn").addEventListener("click", copySummary);

$("schedPrevBtn").addEventListener("click", () => { schedWeekOffset--; loadSchedule(); });
$("schedNextBtn").addEventListener("click", () => { schedWeekOffset++; loadSchedule(); });
$("schedExportBtn").addEventListener("click", exportScheduleImage);

(function initRangeInputs() {
  const today = new Date();
  const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 7);
  $("summaryRangeStart").value = toDateInputValue(weekAgo);
  $("summaryRangeEnd").value = toDateInputValue(today);
})();

// Модуль Firebase (type="module") выполняется после этого скрипта —
// ждём первого сигнала о входе; дальнейшие входы/выходы тоже слушаем.
(async function start() {
  const ok = await authReady();
  if (!ok || !window.TutorAuth) {
    authPanel("authSignIn");
    authMsg("Не удалось загрузить вход — проверь интернет и обнови страницу.", "err");
    return;
  }
  window.addEventListener("tutor-auth", () => { if (!appStarted) startApp(); });
  startApp();
})();
