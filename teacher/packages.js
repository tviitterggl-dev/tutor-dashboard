// Кабинет учителя — пакеты занятий (вкладка «Ученики»): счётчик «X из N» по
// отметкам «Провёл», ручные правки и «Новый пакет», цена предоплаты,
// плашка «пакет заканчивается», перенос со старого подсчёта (pkgByMarks).

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
