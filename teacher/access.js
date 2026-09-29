// Кабинет учителя — доступы родителей и учеников: выдача и отзыв ключей
// (ссылки на кабинет), публикация витрин parentAccess/studentAccess —
// только то, что семье можно видеть (см. REVIEW.md, раздел 1).

// ---------- ДОСТУПЫ РОДИТЕЛЕЙ И УЧЕНИКОВ ----------
// У каждого родителя/ученика свой ключ. Кабинет (cabinet.html) читает
// только «витрину» parentAccess/{ключ} или studentAccess/{ключ}: там
// занятия одного ребёнка и чужие слоты как «занято» без имён. Витрины
// собирает и перезаписывает этот кабинет учителя после любых изменений.

const VIEW_PAST_DAYS = 120;
const VIEW_FUTURE_DAYS = 90;
const PARENT_WINDOW_DAYS = 28; // окно кабинета семьи: 4 недели назад и 4 вперёд
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
      // «Доска» (одна постоянная ссылка) и «Материалы» (список ссылок с
      // названиями) из профиля ученика — видны родителю и ученику у ближайших
      // занятий и в окне занятия. Материалы — через Materials.clean: то же
      // проверяют правила (validView), лишнее туда не попадёт.
      boardUrl: (() => { const u = profileOf(k.studentId).accessUrl; return u && safeHref(u) ? u : null; })(),
      materials: materialsOf(k.studentId),
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
          // Из профиля в кабинет уходят только ссылки — эта, boardUrl и
          // materials (выше); заметки и ставка остаются у учителя.
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
      // остались доступы — новые каналы (отозванный старые знает); не осталось — каналы не нужны
      if (activeKeysOf(k.studentId).length) await rotateChannels(k.studentId);
      else await dropChannels(k.studentId);
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
