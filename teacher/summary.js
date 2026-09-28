// Кабинет учителя — «Статистика» → «Итоги»: неделя / месяц / период,
// суммы по ученикам, копирование текста; «Итоги → Оплата» — кто оплатил.

let summaryMode = "week"; // week | month | range
let summaryWeekOffset = 0;
let summaryMonthOffset = 0;
let summaryEvents = [];
let lastStats = null;

// ---------- ИТОГИ ----------

async function fetchRangeEvents(range) {
  const evs = await fetchLessons(range.start, range.end);
  loadMarksFor(evs.map(e => e.id));
  return evs;
}

// Групповое занятие (копии с одним groupOcc) в общих «Занятий/Часов» — один
// раз; у каждого ученика и в деньгах — его копия.
function computeStats(evs) {
  const doneEvents = evs.filter(ev => marks[ev.id] && marks[ev.id].marked);
  let totalMinutes = 0, totalSum = 0, count = 0;
  const seenOcc = new Set();
  const byStudent = {};
  doneEvents.forEach(ev => {
    const start = new Date(ev.start.dateTime || ev.start.date);
    const end = ev.end ? new Date(ev.end.dateTime || ev.end.date) : start;
    const minutes = Math.max(0, (end - start) / 60000);
    const mark = marks[ev.id];
    const amount = effectiveAmountFor(ev, mark);
    const key = studentKey(ev);

    const occ = ev._lesson && ev._lesson.groupOcc;
    if (!occ || !seenOcc.has(occ)) { totalMinutes += minutes; count++; }
    if (occ) seenOcc.add(occ);
    if (amount != null && !Number.isNaN(amount)) totalSum += amount;

    if (!byStudent[key]) byStudent[key] = { count: 0, minutes: 0, sum: 0, sessions: [] };
    byStudent[key].count++;
    byStudent[key].minutes += minutes;
    if (amount != null && !Number.isNaN(amount)) byStudent[key].sum += amount;
    byStudent[key].sessions.push({ start, end, minutes, amount });
  });
  return { count, minutes: totalMinutes, sum: totalSum, byStudent };
}

async function loadSummary() {
  const range = getSummaryRange(summaryWeekOffset, summaryMonthOffset);
  $("summaryLabel").textContent = range ? range.label : "—";
  if (!range) {
    $("studentsSummaryList").innerHTML = '<div class="empty">Выбери даты периода</div>';
    return;
  }
  $("studentsSummaryList").innerHTML = '<div class="empty">Загрузка…</div>';
  $("compareRow").textContent = "";
  try {
    summaryEvents = await fetchRangeEvents(range);
    const stats = computeStats(summaryEvents);
    lastStats = { range, stats };
    renderSummary(stats);
    renderPayments(summaryEvents);

    const forecast = computeForecast(summaryEvents);
    $("sumForecastCount").textContent = String(forecast.count);
    $("sumForecastSum").textContent = forecast.sum.toLocaleString("ru-RU") + " ₽";

    const prevRange = getPrevSummaryRange(range);
    const prevEvents = await fetchRangeEvents(prevRange);
    const prevStats = computeStats(prevEvents);
    renderCompare(stats, prevStats);
    loadMarksFor(summaryEvents.map(e => e.id));
  } catch (e) {
    $("studentsSummaryList").innerHTML = '<div class="empty">Не удалось загрузить</div>';
  }
}

function renderCompare(stats, prevStats) {
  const el = $("compareRow");
  if (!prevStats.sum && !stats.sum) { el.textContent = ""; return; }
  if (!prevStats.sum) { el.textContent = "нет данных за прошлый период для сравнения"; return; }
  const diff = stats.sum - prevStats.sum;
  const pct = Math.round((diff / prevStats.sum) * 100);
  const sign = diff >= 0 ? "+" : "";
  const cls = diff >= 0 ? "up" : "down";
  el.innerHTML = `<span class="delta ${cls}">${sign}${pct}%</span> к прошлому периоду (было ${prevStats.sum.toLocaleString("ru-RU")} ₽)`;
}

function renderSummary(stats) {
  $("statCount").textContent = String(stats.count);
  $("statHours").textContent = fmtHours(stats.minutes / 60);
  $("statSum").textContent = stats.sum.toLocaleString("ru-RU") + " ₽";

  const list = $("studentsSummaryList");
  const keys = Object.keys(stats.byStudent).sort((a, b) => stats.byStudent[b].sum - stats.byStudent[a].sum);
  if (!keys.length) {
    list.innerHTML = '<div class="empty">Нет отмеченных занятий за этот период</div>';
    return;
  }

  list.innerHTML = "";
  keys.forEach(key => {
    const s = stats.byStudent[key];
    s.sessions.sort((a, b) => a.start - b.start);

    const card = document.createElement("div");
    card.className = "student-card";

    const head = document.createElement("div");
    head.className = "student-head";
    head.innerHTML = `
        <div>
          <div class="name">${escHtml(studentLabel(key))}</div>
          <div class="agg">${s.count} зан. · ${fmtHours(s.minutes / 60)} ч · ${s.sum.toLocaleString("ru-RU")} ₽</div>
        </div>
        <div class="chev">▸</div>
      `;
    head.addEventListener("click", () => card.classList.toggle("open"));

    const body = document.createElement("div");
    body.className = "student-body";
    const p = (n) => String(n).padStart(2, "0");
    body.innerHTML = s.sessions.map(sess => {
      const d = fmtDayLabel(sess.start);
      const t = `${p(sess.start.getHours())}:${p(sess.start.getMinutes())}–${p(sess.end.getHours())}:${p(sess.end.getMinutes())}`;
      const h = fmtHours(sess.minutes / 60);
      const amt = sess.amount != null ? sess.amount.toLocaleString("ru-RU") + " ₽" : "—";
      return `<div class="session-row"><span class="when">${d}, ${t} (${h} ч)</span><span class="amt">${amt}</span></div>`;
    }).join("");

    card.appendChild(head);
    card.appendChild(body);
    list.appendChild(card);
  });
}

// ---------- ИТОГИ → ОПЛАТА ----------
function renderPayments(evs) {
  const el = $("payList");
  const by = {};
  evs.forEach(ev => {
    const l = ev._lesson;
    if (!l) return;
    const mark = marks[ev.id];
    const conducted = (mark && mark.marked) || l.status === "done";
    const paid = !!(l.paid && l.paid.value);
    if (!conducted && !paid) return;
    const key = studentKey(ev);
    const amount = effectiveAmountFor(ev, mark);
    const row = by[key] = by[key] || { key, unpaid: [], paid: [] };
    (paid ? row.paid : row.unpaid).push({ start: new Date(ev.start.dateTime), amount: amount != null && !Number.isNaN(amount) ? amount : 0 });
  });
  const rows = Object.values(by).sort((a, b) => a.key.localeCompare(b.key, "ru"));
  const p = (n) => String(n).padStart(2, "0");
  const dates = (list) => list.sort((a, b) => a.start - b.start).map(x => `${p(x.start.getDate())}.${p(x.start.getMonth() + 1)}`).join(", ");
  const sum = (list) => list.reduce((t, x) => t + x.amount, 0);
  const line = (r, list) => `<div class="session-row"><span class="when">${escHtml(studentLabel(r.key))}</span><span>${list.length} зан. · <b>${sum(list).toLocaleString("ru-RU")} ₽</b><br><span class="cls">${escHtml(dates(list))}</span></span></div>`;
  const unpaid = rows.filter(r => r.unpaid.length);
  const paid = rows.filter(r => r.paid.length);
  el.innerHTML = `
      <div style="font-weight:600;font-size:13px;margin:4px 0 6px;color:var(--danger)">Не оплатили${unpaid.length ? ` — ${unpaid.reduce((t, r) => t + sum(r.unpaid), 0).toLocaleString("ru-RU")} ₽` : ""}</div>
      <div id="payUnpaid">${unpaid.length ? unpaid.map(r => line(r, r.unpaid)).join("") : '<div class="hint" style="margin:0 0 8px">Все проведённые занятия отмечены как оплаченные.</div>'}</div>
      <div style="font-weight:600;font-size:13px;margin:14px 0 6px;color:var(--done-text)">Оплатили${paid.length ? ` — ${paid.reduce((t, r) => t + sum(r.paid), 0).toLocaleString("ru-RU")} ₽` : ""}</div>
      <div id="payPaid">${paid.length ? paid.map(r => line(r, r.paid)).join("") : '<div class="hint" style="margin:0">Пока нет отметок «Оплачено» за этот период.</div>'}</div>`;
}

function buildSummaryText() {
  if (!lastStats) return "";
  const { range, stats } = lastStats;
  const lines = [];
  lines.push(`Итоги за период: ${range.label}`);
  lines.push(`Занятий: ${stats.count} · Часов: ${fmtHours(stats.minutes / 60)} · Заработано: ${stats.sum.toLocaleString("ru-RU")} ₽`);
  lines.push("");
  const keys = Object.keys(stats.byStudent).sort((a, b) => stats.byStudent[b].sum - stats.byStudent[a].sum);
  keys.forEach(key => {
    const s = stats.byStudent[key];
    lines.push(`${studentLabel(key)}: ${s.count} зан., ${fmtHours(s.minutes / 60)} ч, ${s.sum.toLocaleString("ru-RU")} ₽`);
  });
  return lines.join("\n");
}

async function copySummary() {
  const text = buildSummaryText();
  const btn = $("copySummaryBtn");
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e2) { ok = false; }
  }
  const orig = btn.textContent;
  btn.textContent = ok ? "Скопировано ✓" : "Не удалось скопировать";
  setTimeout(() => { btn.textContent = orig; }, 1600);
}

function refreshSummary() {
  $("summaryRangeNav").style.display = summaryMode === "range" ? "flex" : "none";
  $("summaryNav").style.display = summaryMode === "range" ? "none" : "flex";
  loadSummary();
}

document.querySelectorAll('.subtab[data-summode]').forEach(tab => {
  tab.addEventListener("click", () => {
    summaryMode = tab.dataset.summode;
    document.querySelectorAll('.subtab[data-summode]').forEach(t => t.classList.toggle("active", t === tab));
    refreshSummary();
  });
});
document.querySelector('.subtab[data-summode="week"]').classList.add("active");

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

(function initRangeInputs() {
  const today = new Date();
  const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 7);
  $("summaryRangeStart").value = toDateInputValue(weekAgo);
  $("summaryRangeEnd").value = toDateInputValue(today);
})();
