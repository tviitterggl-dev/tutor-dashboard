// Логика уведомлений — одна для всех: кабинет учителя (кому что уйдёт),
// кабинеты родителя/ученика (что показать при открытии) и фоновая рассылка
// пушей (notifier/, GitHub Actions). Без зависимостей; в браузере —
// window.NotifyCore, в Node — module.exports.
//
// Уведомление (teacherSpaces/{uid}/notifications/{id}):
//   text        — текст, который пишет учитель; можно вставить {ученик},
//                 {дата}, {время} — подставятся для конкретного занятия;
//   mode        — "now"    — «Отправить сейчас» (один раз, одному адресату);
//                 "once"   — разово: показать при следующих N открытиях
//                            кабинета (times = N) + один пуш;
//                 "before" — постоянно: за offsetValue offsetUnit
//                            (min | hour | day) до каждого занятия;
//   target      — { scope: "all" | "student" | "key", role: "any" | "parent"
//                 | "student", studentId, key } — кому;
//   lessonIds   — [] = все занятия; иначе только эти (для одного ученика);
//   push        — слать ли пуш на телефон (по умолчанию да);
//   active      — выключенное не показывается и не отправляется.
(function (root) {
  "use strict";

  const UNIT_MS = { min: 60000, hour: 3600000, day: 86400000 };
  const UNIT_RU = { min: ["минуту", "минуты", "минут"], hour: ["час", "часа", "часов"], day: ["день", "дня", "дней"] };
  const NOW_TTL_MS = 3 * 86400000;      // «Отправить сейчас» висит в кабинете 3 дня
  const PUSH_GRACE_MS = 3 * 3600000;    // напоминание, опоздавшее больше чем на 3 ч, не шлём

  function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }
  function offsetMs(rule) {
    const v = Number(rule && rule.offsetValue);
    const u = UNIT_MS[rule && rule.offsetUnit];
    return v > 0 && u ? Math.round(v * u) : 0;
  }
  function offsetText(rule) {
    const v = Number(rule.offsetValue);
    const forms = UNIT_RU[rule.offsetUnit];
    return forms ? `${String(v).replace(".", ",")} ${Number.isInteger(v) ? plural(v, forms) : forms[1]}` : "";
  }

  // Подходит ли адресат (ключ доступа: { id, role, studentId, active }).
  function keyMatches(target, key) {
    if (!target || !key || key.active === false) return false;
    const roleOk = !target.role || target.role === "any" || target.role === key.role;
    if (target.scope === "key") return target.key === key.id;
    if (target.scope === "student") return target.studentId === key.studentId && roleOk;
    if (target.scope === "all") return roleOk;
    return false;
  }
  // Ученик, к которому привязано уведомление (для all — никакого).
  function targetStudent(rule, keys) {
    const t = rule.target || {};
    if (t.scope === "student") return t.studentId || null;
    if (t.scope === "key") {
      const k = (keys || []).find((x) => x.id === t.key);
      return (k && k.studentId) || t.studentId || null;
    }
    return null;
  }
  // Занятия, к которым относится уведомление «перед занятием».
  function ruleLessons(rule, lessons, keys) {
    const sid = targetStudent(rule, keys);
    const only = Array.isArray(rule.lessonIds) && rule.lessonIds.length ? new Set(rule.lessonIds) : null;
    return (lessons || []).filter((l) => l && l.status === "planned" && l.kind !== "personal" && l.studentId
      && (!sid || l.studentId === sid) && (!only || only.has(l.id)));
  }
  function isLive(rule, now) {
    if (!rule || rule.active === false || !rule.text) return false;
    if (rule.mode === "now") return (now - (rule.createdAt || 0)) < NOW_TTL_MS;
    return rule.mode === "once" || rule.mode === "before";
  }

  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  // Москва (UTC+3, без перехода) — как и всё расписание.
  function msk(ms) {
    const d = new Date(ms + 3 * 3600000);
    const p = (n) => String(n).padStart(2, "0");
    return { date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
  }
  function fillText(text, lesson, studentLabel) {
    let out = String(text || "");
    const when = lesson ? msk(lesson.startMs) : null;
    out = out.replace(/\{ученик\}/giu, studentLabel || (lesson && lesson.studentId) || "");
    out = out.replace(/\{дата\}/giu, when ? when.date : "");
    out = out.replace(/\{время\}/giu, when ? when.time : "");
    return out.trim();
  }

  // Что опубликовать в витрину этого ключа (кабинет сам решает, когда показать).
  function noticesForKey(rules, key, keys, now) {
    return (rules || []).filter((r) => isLive(r, now) && keyMatches(r.target, key)).map((r) => {
      const n = { id: r.id, mode: r.mode, text: String(r.text).slice(0, 1000), createdAt: r.createdAt || 0 };
      if (r.mode === "once") n.times = Math.max(1, Math.min(50, parseInt(r.times, 10) || 1));
      if (r.mode === "now") n.times = 1;
      if (r.mode === "before") n.offsetMs = offsetMs(r);
      if (Array.isArray(r.lessonIds) && r.lessonIds.length) n.lessonIds = r.lessonIds.slice(0, 200);
      return n;
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Кабинет: напоминания «перед занятием», которые пора показать сейчас.
  // lessons — занятия из витрины (свои), notice.lessonIds — фильтр.
  function dueReminders(notices, lessons, now, label) {
    const out = [];
    (notices || []).filter((n) => n.mode === "before" && n.offsetMs > 0).forEach((n) => {
      const only = n.lessonIds && n.lessonIds.length ? new Set(n.lessonIds) : null;
      (lessons || []).filter((l) => l.status === "planned" && (!only || only.has(l.id))).forEach((l) => {
        if (now >= l.startMs - n.offsetMs && now < l.endMs) out.push({ id: `${n.id}__${l.id}`, noticeId: n.id, lessonId: l.id, startMs: l.startMs, text: fillText(n.text, l, label) });
      });
    });
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  // Фоновая рассылка: какие пуши отправить сейчас.
  //   rules   — уведомления учителя (с id);
  //   lessons — занятия учителя; keys — ключи доступа (с id);
  //   devices — подписки [{ token, key, path }] из каналов учеников;
  //   log     — { [logId]: true } — что уже отправлено;
  //   label   — (studentId) => «Имя Фамилия, N класс».
  // Возвращает [{ logId, ruleId, lessonId, title, body, to: [{ token, key, role, path }] }].
  function planPushes({ now, rules, lessons, keys, devices, log, label }) {
    const activeKeys = (keys || []).filter((k) => k.active !== false);
    const byKey = {};
    (devices || []).forEach((d) => {
      const k = activeKeys.find((x) => x.id === d.key);
      if (!k) return; // доступ отозван — этому устройству не шлём
      (byKey[k.id] = byKey[k.id] || []).push({ token: d.token, key: k.id, role: k.role, studentId: k.studentId, path: d.path });
    });
    const uniq = (list) => { const seen = new Set(); return list.filter((x) => !seen.has(x.token) && seen.add(x.token)); };
    const lbl = label || ((sid) => sid);
    const out = [];
    (rules || []).forEach((r) => {
      if (!isLive(r, now) || r.push === false) return;
      const matched = activeKeys.filter((k) => keyMatches(r.target, k));
      if (r.mode === "now" || r.mode === "once") {
        const logId = `${r.id}__once`;
        if (log && log[logId]) return;
        const to = uniq(matched.flatMap((k) => byKey[k.id] || []));
        const sid = targetStudent(r, keys);
        out.push({ logId, ruleId: r.id, lessonId: null, title: "Сообщение от преподавателя", body: fillText(r.text, null, sid ? lbl(sid) : ""), to });
        return;
      }
      const off = offsetMs(r);
      if (!off) return;
      ruleLessons(r, lessons, keys).forEach((l) => {
        const sendAt = l.startMs - off;
        if (!(now >= sendAt && now - sendAt <= PUSH_GRACE_MS && now < l.startMs)) return;
        const logId = `${r.id}__${l.id}`;
        if (log && log[logId]) return;
        const to = uniq(matched.filter((k) => k.studentId === l.studentId).flatMap((k) => byKey[k.id] || []));
        out.push({ logId, ruleId: r.id, lessonId: l.id, title: "Напоминание о занятии", body: fillText(r.text, l, lbl(l.studentId)), to });
      });
    });
    return out;
  }

  const api = { UNIT_MS, NOW_TTL_MS, PUSH_GRACE_MS, offsetMs, offsetText, keyMatches, targetStudent, ruleLessons, isLive, fillText, noticesForKey, dueReminders, planPushes, plural };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NotifyCore = api;
})(typeof window !== "undefined" ? window : globalThis);
