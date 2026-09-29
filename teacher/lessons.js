// Кабинет учителя — вкладка «Занятия»: загрузка и список на день / неделю
// (карточки с «Провёл» и суммой), итог и прогноз под списком.

// ---------- ЗАНЯТИЯ ----------

function renderLessons() {
  const range = getLessonRange();
  $("weekLabel").textContent = range ? range.label : "—";

  const list = $("lessonsList");
  if (!events.length) {
    list.innerHTML = '<div class="empty">Занятий нет</div>';
    updateTotals();
    return;
  }

  const now = new Date();
  list.innerHTML = "";
  events.forEach(ev => {
    const start = new Date(ev.start.dateTime || ev.start.date);
    const end = ev.end ? new Date(ev.end.dateTime || ev.end.date) : null;
    const parsed = parseLesson(ev.summary || "");
    const mark = marks[ev.id] || { marked: false, overrideAmount: null, lockedRate: null };
    const baseRate = mark.marked && mark.lockedRate != null ? mark.lockedRate : rateFor(ev);
    const effectiveAmount = effectiveAmountFor(ev, mark);
    const canMark = effectiveAmount != null && !Number.isNaN(effectiveAmount);
    const isPastUnmarked = !mark.marked && start < now;

    const row = document.createElement("div");
    row.className = "lesson" + (mark.marked ? " done" : "") + (isPastUnmarked ? " past-unmarked" : "");

    const p = (n) => String(n).padStart(2, "0");
    const timeStr = `${p(start.getHours())}:${p(start.getMinutes())}` + (end ? `–${p(end.getHours())}:${p(end.getMinutes())}` : "");
    const dayStr = fmtDayLabel(start);

    const groupTag = ev._lesson && isGroupCopy(ev._lesson) ? `<span class="group-tag" title="${escHtml(groupLabel(ev._lesson.groupId))}">группа</span>` : "";
    const nameHtml = (parsed
      ? escHtml(studentLabel(makeStudentId(parsed.name, parsed.cls, parsed.surname))) + (baseRate == null && !mark.marked ? ' <span class="unmatched">(ставка не найдена)</span>' : "")
      : `${escHtml(ev.summary || "Без названия")} <span class="unmatched">(не распознано)</span>`) + groupTag;

    // доска и материалы — из профиля ученика (у личного времени и занятий без ученика нет)
    const prof = ev._lesson && ev._lesson.studentId ? profileOf(ev._lesson.studentId) : {};
    const boardHtml = prof.accessUrl && safeHref(prof.accessUrl) ? ` <a class="edit-link" href="${escHtml(prof.accessUrl)}" target="_blank" rel="noopener">доска</a>` : "";
    const mats = ev._lesson ? materialsOf(ev._lesson.studentId) : [];
    const matsHtml = mats.length ? " " + Materials.dropdownHtml(mats, "материалы") : "";
    row.innerHTML = `
        <div class="lesson-top">
          <div class="lesson-name">${nameHtml}</div>
          <div class="lesson-when">${dayStr}, ${timeStr}${ev._lesson && ev._lesson.paid && ev._lesson.paid.value ? '<span class="paid-tag">оплачено</span>' : ""}${ev._lesson && ev._lesson.familyNote && ev._lesson.familyNote.text ? '<span class="paid-tag note-tag" title="Есть пояснение от родителя/ученика">пояснение</span>' : ""}${ev._lesson && callLinkFor(ev._lesson) ? ` <a class="edit-link" href="${escHtml(callLinkFor(ev._lesson).url)}" target="_blank" rel="noopener">созвон</a>` : ""}${boardHtml}${matsHtml}</div>
        </div>
        <div class="lesson-bottom">
          <div class="rate-field">
            ₽ <input type="number" inputmode="decimal" placeholder="${baseRate != null ? baseRate : "сумма"}" value="${mark.overrideAmount != null ? mark.overrideAmount : ""}">
          </div>
          <button class="mark-btn ${mark.marked ? "done" : ""}" ${canMark ? "" : "disabled"}>
            ${mark.marked ? "✓ Провёл (снять)" : "Провёл занятие"}
          </button>
        </div>
      `;

    row.querySelector("input").addEventListener("change", (e) => setOverride(ev, e.target.value));
    // вся карточка открывает занятие (кроме полей, кнопок и ссылок в ней)
    if (ev._lesson) {
      row.classList.add("clickable");
      row.addEventListener("click", (e) => {
        if (e.target.closest("input, button, a, select, textarea, label, details")) return;
        openLessonModal(ev.id);
      });
    }
    row.querySelector(".mark-btn").addEventListener("click", () => {
      if (!canMark) return;
      toggleMark(ev, mark);
    });

    list.appendChild(row);
  });

  updateTotals();
}

// Прогноз: сколько выйдет, если пройдут ВСЕ занятия периода (отмеченные и ещё нет)
// по текущим ставкам — в отличие от "заработано", которое считает только отмеченные.
function computeForecast(evs) {
  let count = 0, sum = 0;
  evs.forEach(ev => {
    const mark = marks[ev.id];
    const amount = effectiveAmountFor(ev, mark);
    if (amount != null && !Number.isNaN(amount)) { count++; sum += amount; }
  });
  return { count, sum };
}

function updateTotals() {
  let count = 0, sum = 0;
  events.forEach(ev => {
    const mark = marks[ev.id];
    if (mark && mark.marked) {
      const amount = effectiveAmountFor(ev, mark);
      if (amount != null && !Number.isNaN(amount)) { count++; sum += amount; }
    }
  });
  $("doneCount").textContent = String(count);
  $("doneSum").textContent = sum.toLocaleString("ru-RU") + " ₽";

  const forecast = computeForecast(events);
  $("forecastCount").textContent = String(forecast.count);
  $("forecastSum").textContent = forecast.sum.toLocaleString("ru-RU") + " ₽";
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadLessonEvents() {
  stopPoll();
  const range = getLessonRange();
  setBadge($("calBadge"), "Календарь: загрузка…", "warn");
  $("lessonsList").innerHTML = '<div class="empty">Загрузка…</div>';

  async function doFetch() {
    try {
      events = await fetchLessons(range.start, range.end);
      loadMarksFor(events.map(e => e.id));
      renderLessons();
    } catch (e) {
      setBadge($("calBadge"), "Занятия: ошибка загрузки", "err");
    }
  }
  await doFetch();
  pollTimer = setInterval(doFetch, 5 * 60 * 1000);
}

document.querySelectorAll('.subtab[data-lessonmode]').forEach(tab => {
  tab.addEventListener("click", () => {
    lessonMode = tab.dataset.lessonmode;
    document.querySelectorAll('.subtab[data-lessonmode]').forEach(t => t.classList.toggle("active", t === tab));
    loadLessonEvents();
  });
});
document.querySelector('.subtab[data-lessonmode="day"]').classList.add("active");

$("prevBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset--; else weekOffset--;
  loadLessonEvents();
});
$("nextBtn").addEventListener("click", () => {
  if (lessonMode === "day") dayOffset++; else weekOffset++;
  loadLessonEvents();
});
$("markPastBtn").addEventListener("click", markAllPast);
