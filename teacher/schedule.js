// Кабинет учителя — вкладка «Расписание»: свободные окна недели и экспорт
// в картинку PNG (html2canvas с CDN; на iPhone — «Поделиться» прямо в
// нажатии, см. REVIEW.md, «Мобильная совместимость»).

let schedWeekOffset = 0;

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
