// Кабинет учителя — «Статистика» → «Аналитика» (только учителю): доход по
// месяцам и неделям, доля отмен, загрузка по дням; графики рисуются сами
// (SVG без библиотек), выбранные периоды запоминаются на устройстве.

// ---------- АНАЛИТИКА (только учителю) ----------
// Всё считается из того, что уже есть в базе: занятия (статус, оплата),
// отметки «Провёл» и ставки. Период один на всю вкладку — выбирается в
// карточке «Доход»: по месяцам (1/3/6/12) или по неделям (1/5/10/15). Одна
// выборка занятий за период; повторно в течение 10 минут — из памяти.
const WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const anPref = (k, d) => { try { const v = localStorage.getItem("an." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const anSave = (k, v) => { try { localStorage.setItem("an." + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } };
const anState = {
  step: anPref("step", "month"), months: anPref("months", 3), weeks: anPref("weeks", 10),
  potential: anPref("potential", false), cache: {},
};
const compactRub = (n) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString("ru-RU")}k` : String(Math.round(n)));
const p2 = (n) => String(n).padStart(2, "0");

// Корзины периода: месяцы (с 1-го числа) или недели (с понедельника).
function anBuckets(step, n, now) {
  const out = [];
  if (step === "week") {
    const first = mondayOf(now);
    first.setDate(first.getDate() - 7 * (n - 1));
    for (let i = 0; i < n; i++) {
      const d = new Date(first); d.setDate(d.getDate() + 7 * i);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      out.push({ key: d.getTime(), label: `${p2(d.getDate())}.${p2(d.getMonth() + 1)}`, full: `${p2(d.getDate())}.${p2(d.getMonth() + 1)} – ${p2(end.getDate())}.${p2(end.getMonth() + 1)}` });
    }
    const to = new Date(first); to.setDate(to.getDate() + 7 * n);
    return { buckets: out, from: first, to, keyOf: (t) => mondayOf(new Date(t)).getTime() };
  }
  const first = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
    out.push({ key: d.getFullYear() + "-" + d.getMonth(), label: MONTHS_SHORT_RU[d.getMonth()], full: d.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) });
  }
  return { buckets: out, from: first, to: new Date(now.getFullYear(), now.getMonth() + 1, 1), keyOf: (t) => { const d = new Date(t); return d.getFullYear() + "-" + d.getMonth(); } };
}

// paid — оплаченные; earned — с отметкой «Провёл»; potential — всё по
// расписанию: проведённые и запланированные (и оплаченные), без отмен;
// у переноса считается только новая дата (старая — status "rescheduled").
function computeAnalytics(evs, range, now) {
  range.buckets.forEach(b => Object.assign(b, { paid: 0, earned: 0, potential: 0, n: 0, np: 0 }));
  const byKey = Object.fromEntries(range.buckets.map(b => [b.key, b]));
  const wd = WEEKDAYS_RU.map((label) => ({ label, count: 0, minutes: 0 }));
  let cancelledAll = 0, scheduledAll = 0;
  const past = {};
  evs.forEach(ev => {
    const l = ev._lesson;
    if (!l || isPersonal(l)) return;
    const bk = byKey[range.keyOf(l.startMs)];
    if (!bk) return;
    const mark = marks[ev.id];
    const amount = effectiveAmountFor(ev, mark);
    const amt = amount != null && !Number.isNaN(amount) ? amount : 0;
    const isPaid = !!(l.paid && l.paid.value);
    const active = l.status === "planned" || l.status === "done";
    if (isPaid) bk.paid += amt;
    if (mark && mark.marked) { bk.earned += amt; bk.n++; }
    if (active || isPaid) { bk.potential += amt; bk.np++; }
    // отмены и загрузка — по уже прошедшим занятиям периода; копии одного
    // группового занятия — одно занятие (отменено — если у всех)
    if (l.startMs > now.getTime() || !l.studentId) return;
    if (l.status === "rescheduled") return; // перенос: копия стоит отдельно
    const k = l.groupOcc || ev.id;
    (past[k] = past[k] || { l, st: [] }).st.push(l.status);
  });
  Object.values(past).forEach(({ l, st }) => {
    scheduledAll++;
    if (st.every(x => x === "cancelled")) { cancelledAll++; return; }
    const w = (new Date(l.startMs).getDay() + 6) % 7;
    wd[w].count++;
    wd[w].minutes += Math.max(0, (l.endMs - l.startMs) / 60000);
  });
  // недель в периоде (до сегодня) — делитель для «в среднем»
  const weeks = Math.max(1, Math.round((now - range.from) / (7 * DAY_MS)));
  wd.forEach(d => { d.avg = d.count / weeks; d.hours = d.minutes / 60 / weeks; });
  const sum = (k) => range.buckets.reduce((t, b) => t + b[k], 0);
  return { buckets: range.buckets, step: range.step, wd, weeks, paid: sum("paid"), earned: sum("earned"), potential: sum("potential"), cancelledAll, scheduledAll };
}

function anSyncControls() {
  const step = anState.step;
  document.querySelectorAll("[data-anstep]").forEach(b => b.classList.toggle("active", b.dataset.anstep === step));
  document.querySelectorAll("[data-anmonths]").forEach(b => b.classList.toggle("active", Number(b.dataset.anmonths) === anState.months));
  document.querySelectorAll("[data-anweeks]").forEach(b => b.classList.toggle("active", Number(b.dataset.anweeks) === anState.weeks));
  $("anIncomeCard").classList.toggle("by-week", step === "week");
  $("anPotential").checked = !!anState.potential;
  $("anIncomeLegend").hidden = !anState.potential;
}
let anReq = 0;
async function loadAnalytics(force) {
  anSyncControls();
  const step = anState.step, n = step === "week" ? anState.weeks : anState.months;
  const ck = step + n;
  const cached = anState.cache[ck];
  if (!force && cached && Date.now() - cached.at < 10 * 60000) { renderAnalytics(cached.data); return; }
  const my = ++anReq;
  ["anIncome", "anWeek"].forEach(id => { $(id).innerHTML = '<div class="empty">Загрузка…</div>'; });
  const now = new Date();
  const range = Object.assign(anBuckets(step, n, now), { step });
  try {
    const evs = await fetchLessons(range.from, range.to, { includeInactive: true });
    loadMarksFor(evs.map(e => e.id));
    const data = computeAnalytics(evs, range, now);
    anState.cache[ck] = { at: Date.now(), data };
    if (my === anReq) renderAnalytics(data); // пока грузили, не переключили
  } catch (e) {
    console.error(e);
    if (my === anReq) ["anIncome", "anWeek"].forEach(id => { $(id).innerHTML = '<div class="empty">Не удалось загрузить (нет интернета?)</div>'; });
  }
}
document.querySelectorAll("[data-anstep]").forEach(b => b.addEventListener("click", () => { anState.step = b.dataset.anstep; anSave("step", anState.step); loadAnalytics(); }));
document.querySelectorAll("[data-anmonths]").forEach(b => b.addEventListener("click", () => { anState.months = Number(b.dataset.anmonths); anSave("months", anState.months); loadAnalytics(); }));
document.querySelectorAll("[data-anweeks]").forEach(b => b.addEventListener("click", () => { anState.weeks = Number(b.dataset.anweeks); anSave("weeks", anState.weeks); loadAnalytics(); }));
$("anPotential").addEventListener("change", (e) => { anState.potential = e.target.checked; anSave("potential", anState.potential); anSyncControls(); if (anLast) renderIncome(anLast); });
let anLast = null;
let anResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(anResizeTimer);
  anResizeTimer = setTimeout(() => { if (activeTab === "stats" && statsMode === "analytics" && anLast) renderAnalytics(anLast); }, 150);
});

function renderAnalytics(d) {
  anLast = d;
  anSyncControls();
  const pct = d.scheduledAll ? Math.round((d.cancelledAll / d.scheduledAll) * 100) : 0;
  $("anTiles").innerHTML = `
      <div class="stat-tile"><span class="num">${rub(d.paid)}</span><span class="lbl">оплачено</span></div>
      <div class="stat-tile"><span class="num">${rub(d.potential)}</span><span class="lbl">по расписанию (потенциально)</span></div>
      <div class="stat-tile"><span class="num">${pct}%</span><span class="lbl">отмен (${d.cancelledAll} из ${d.scheduledAll})</span></div>`;
  renderIncome(d);
  // загрузка по дням недели — одна серия
  const fmtAvg = (v) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");
  // деления оси — столько знаков после запятой, сколько нужно шагу (0,05 → два)
  const fmtStep = (v, step) => { const dec = step ? Math.max(0, Math.min(2, -Math.floor(Math.log10(step) + 1e-9))) : 1; return v.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: dec }); };
  // столбик — часы в неделю: длительность из карточки занятия (90 мин весят больше 45)
  renderColumns($("anWeek"), {
    groups: d.wd.map(w => ({ label: w.label, values: [w.hours], tip: `<b>${w.label}</b><br>в среднем ${fmtAvg(w.hours)} ч в неделю (${fmtAvg(w.avg)} зан.)<br>всего за период: ${w.count} зан., ${fmtAvg(w.minutes / 60)} ч` })),
    colors: ["var(--viz-1)"],
    fmtTick: (v, step) => (step ? fmtStep(v, step) : fmtAvg(v)),
    labelMax: true,
    empty: "За этот период прошедших занятий нет.",
  });
  $("anWeekTable").innerHTML = anTable(["День", "Часов в неделю", "Занятий в неделю", "Всего занятий", "Всего часов"], d.wd.map(w => [w.label, fmtAvg(w.hours), fmtAvg(w.avg), w.count, fmtAvg(w.minutes / 60)]));
}
// «Доход»: по умолчанию — оплаченное; с галочкой сверху — остальное по расписанию
function renderIncome(d) {
  const pot = !!anState.potential;
  const rest = (r) => Math.max(0, r.potential - r.paid);
  const tip = (r) => `<b>${escHtml(r.full)}</b><br><i class="an-key" style="background:var(--viz-1)"></i>оплачено: ${rub(r.paid)}` + (pot
    ? `<br><i class="an-key" style="background:var(--viz-2)"></i>ещё не оплачено: ${rub(rest(r))}<br>всего по расписанию: ${rub(r.potential)} (${r.np} зан.)` : "")
    + `<br>проведено («Провёл»): ${rub(r.earned)} (${r.n} зан.)`;
  const week = d.step === "week";
  renderColumns($("anIncome"), {
    groups: d.buckets.map(r => ({ label: r.label, values: pot ? [r.paid, rest(r)] : [r.paid], tip: tip(r) })),
    colors: pot ? ["var(--viz-1)", "var(--viz-2)"] : ["var(--viz-1)"],
    stacked: true,
    fmtTick: compactRub,
    labelMax: true,
    empty: pot ? "За этот период занятий в расписании нет." : "За этот период нет оплаченных занятий. Включи «показать потенциальный заработок», чтобы увидеть всё по расписанию.",
  });
  $("anIncomeTable").innerHTML = anTable([week ? "Неделя" : "Месяц", "Оплачено", "Провёл", "По расписанию", "Ещё не оплачено"],
    d.buckets.map(r => [r.full, rub(r.paid), rub(r.earned), rub(r.potential), rub(rest(r))]));
}

function anTable(head, rows) {
  return `<table class="an-tbl"><thead><tr>${head.map(h => `<th>${escHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${escHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
// «Красивые» деления оси: 0, шаг 1/2/5 × 10^n
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(x => x >= raw) || raw;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
// столбик: скругление 4px только на конце с данными, у основания — прямой угол
function colPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function wireTips(el) {
  const tip = document.createElement("div");
  tip.className = "an-tip";
  tip.hidden = true;
  el.appendChild(tip);
  const show = (t, evt) => {
    tip.innerHTML = t.dataset.tip;
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const half = tip.offsetWidth / 2 + 2; // не вылезать за край карточки
    const x = Math.min(Math.max(r.left + r.width / 2 - box.left, half), box.width - half);
    tip.style.left = x + "px";
    tip.style.top = Math.max(0, r.top - box.top) + 2 + "px"; // внутри графика, у верхнего края полосы
    el.querySelectorAll(".an-hit.on").forEach(h => h.classList.remove("on"));
    t.classList.add("on");
  };
  el.querySelectorAll(".an-hit").forEach(t => {
    t.addEventListener("pointerenter", (e) => show(t, e));
    t.addEventListener("click", (e) => show(t, e)); // касание на телефоне
    t.addEventListener("focus", (e) => show(t, e));
  });
  el.addEventListener("pointerleave", () => { tip.hidden = true; el.querySelectorAll(".an-hit.on").forEach(h => h.classList.remove("on")); });
}
function renderColumns(el, cfg) {
  const all = cfg.stacked ? cfg.groups.map(g => g.values.reduce((t, v) => t + v, 0)) : cfg.groups.flatMap(g => g.values);
  if (!all.some(v => v > 0)) { el.innerHTML = `<div class="empty">${escHtml(cfg.empty)}</div>`; return; }
  const W = Math.max(280, el.clientWidth || 320), H = 190;
  const padL = 40, padR = 6, padT = 16, padB = 24;
  const ticks = niceTicks(Math.max(...all));
  const top = ticks[ticks.length - 1];
  const plotH = H - padT - padB, plotW = W - padL - padR;
  const band = plotW / cfg.groups.length;
  const ns = cfg.stacked ? 1 : cfg.colors.length;
  const gap = 2; // промежуток цвета фона между соседними столбиками / частями стопки
  // потолок 34 px: при 5–7 группах столбик не тонет в пустоте; при многих группах держит 0,72 полосы
  const barW = Math.min(34, (band * 0.72 - gap * (ns - 1)) / ns);
  const yOf = (v) => padT + plotH - (v / top) * plotH;
  let svg = "";
  ticks.forEach(t => {
    const y = yOf(t).toFixed(1);
    svg += `<line class="an-grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
    svg += `<text class="an-axis" x="${padL - 6}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end">${escHtml(cfg.fmtTick(t, ticks[1] - ticks[0]))}</text>`;
  });
  const maxV = Math.max(...all);
  // подписи снизу не наезжают друг на друга: если не помещаются — через одну (две…)
  const labW = Math.max(...cfg.groups.map(g => String(g.label).length)) * 6.6 + 8;
  const every = cfg.labelEvery || Math.max(1, Math.ceil(labW / band));
  cfg.groups.forEach((g, i) => {
    const cx = padL + band * i + band / 2;
    const groupW = barW * ns + gap * (ns - 1);
    if (cfg.stacked) {
      // стопка снизу вверх; скругление — только у верхней части, между частями 2px фона
      const x = cx - barW / 2;
      let base = yOf(0);
      const parts = g.values.map((v, k) => ({ v, k })).filter(p => p.v > 0);
      parts.forEach((p, idx) => {
        const h = Math.max(0, yOf(0) - yOf(p.v)) - (idx > 0 ? gap : 0);
        if (h <= 0) return;
        const top = base - (idx > 0 ? gap : 0) - h;
        const d = idx === parts.length - 1 ? colPath(x, top, barW, h) : `M${x},${top}H${x + barW}V${top + h}H${x}Z`;
        svg += `<path d="${d}" fill="${cfg.colors[p.k]}"/>`;
        base = top;
      });
      const tot = g.values.reduce((t, v) => t + v, 0);
      if (cfg.labelMax && tot === maxV && tot > 0) svg += `<text class="an-val" x="${cx.toFixed(1)}" y="${(yOf(tot) - 5).toFixed(1)}" text-anchor="middle">${escHtml(cfg.fmtTick(tot))}</text>`;
    } else g.values.forEach((v, k) => {
      const x = cx - groupW / 2 + k * (barW + gap);
      const h = Math.max(0, yOf(0) - yOf(v));
      svg += `<path d="${colPath(x.toFixed(1) * 1, yOf(v), barW, h)}" fill="${cfg.colors[k]}"/>`;
      if (cfg.labelMax && v === maxV && v > 0) svg += `<text class="an-val" x="${cx.toFixed(1)}" y="${(yOf(v) - 5).toFixed(1)}" text-anchor="middle">${escHtml(cfg.fmtTick(v))}</text>`;
    });
    if ((cfg.groups.length - 1 - i) % every === 0) svg += `<text class="an-axis" x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${escHtml(g.label)}</text>`;
    // зона наведения — вся полоса месяца/дня, больше самих столбиков
    svg += `<rect class="an-hit" tabindex="0" x="${(padL + band * i).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${plotH}" data-tip="${escHtml(g.tip)}"/>`;
  });
  el.innerHTML = `<svg class="an-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${svg}</svg>`;
  wireTips(el);
}
