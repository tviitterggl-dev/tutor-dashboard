// Кабинет учителя — список учеников (вкладка «Ученики»): карточки-профили
// (ставка, ссылки, заметки, группы) с сохранением черновиков при
// перерисовке, добавление, переименование и удаление ученика.

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
