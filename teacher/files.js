// Кабинет учителя — файлы: домашка к занятию (перетаскивание, выбор,
// вставка из буфера; загрузка в Cloudinary, только unsigned) и
// «Добавить в календарь» — файл .ics.

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
// Ищем в ближайшие полгода после этого занятия: список берётся из живой
// подписки на занятия (listLessons) — без чтений. Раньше здесь читались ВСЕ
// занятия ученика за всё время — на каждое открытие окна (сотни чтений).
const NEXT_HW_DAYS = 180;
async function nextLessonOf(l) {
  const list = await window.TutorFB.listLessons(l.startMs + 1, l.startMs + NEXT_HW_DAYS * DAY_MS);
  return list.filter(x => x.id !== l.id && x.studentId === l.studentId && x.status === "planned" && !isPersonal(x))
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
}
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
