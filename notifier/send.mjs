// Фоновая рассылка пуш-уведомлений. Запускается GitHub Actions по расписанию
// (.github/workflows/notify.yml, раз в ~15 минут) — своего сервера у проекта
// нет. Читает базу с правами сервисного аккаунта Firebase (секрет
// FIREBASE_SERVICE_ACCOUNT в настройках репозитория) и шлёт пуши через
// Firebase Cloud Messaging.
//
// Что и кому слать — решает notify-core.js (та же логика, что в кабинетах):
//   • «Отправить сейчас» и «разово» — один пуш, как только появились;
//   • «перед занятием» — когда до занятия осталось заданное время
//     (опоздавшее больше чем на 3 часа — пропускаем).
// Что уже отправлено — teacherSpaces/{uid}/notifLog/{id}: запись создаётся
// ДО отправки (create — атомарно), поэтому два одновременных запуска не
// пришлют одно и то же дважды.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const require = createRequire(import.meta.url);
const core = require("../notify-core.js");

const DAY = 86400000;
const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

function studentLabelFn(profiles) {
  return (sid) => {
    const p = (profiles || {})[sid];
    const m = String(sid || "").match(/^(.+?),\s*(\d{1,2})\s*класс$/u);
    if (!m) return String(sid || "");
    const nameHasSurname = /\s/.test(m[1]);
    const surname = !nameHasSurname && p && p.surname ? " " + p.surname : "";
    return `${m[1]}${surname}, ${m[2]} класс`;
  };
}
// Ссылки пушей. С привязкой к занятию — ?lesson=<id>: по нажатию страница
// сразу открывает карточку этого занятия (ключ кабинета — во фрагменте, как
// раньше). Как sw.js находит уже открытую вкладку — см. notificationclick.
const lessonQuery = (lessonId) => (lessonId ? `?lesson=${encodeURIComponent(lessonId)}` : "");
const cabinetUrl = (siteUrl, key, lessonId) => `${siteUrl.replace(/\/?$/, "/")}cabinet.html${lessonQuery(lessonId)}#${key.role === "parent" ? "p" : "s"}=${key.id}`;
const teacherUrl = (siteUrl, lessonId) => `${siteUrl.replace(/\/?$/, "/")}index.html${lessonQuery(lessonId)}`;

// Живые уведомления без чтения всей истории: «разово»/«перед занятием» и
// «сейчас»/отчёты за последние NOW_TTL (старше — уже не показываются и не шлются).
async function liveRules(tRef, now) {
  const col = tRef.collection("notifications");
  const [a, b] = await Promise.all([
    col.where("mode", "in", ["once", "before"]).get(),
    col.where("createdAt", ">=", now - core.NOW_TTL_MS).get(),
  ]);
  const byId = new Map();
  [...a.docs, ...b.docs].forEach((d) => byId.set(d.id, Object.assign({ id: d.id }, d.data())));
  return [...byId.values()];
}
// Какие из этих записей журнала уже есть — точечное чтение (getAll), не весь журнал.
async function logHas(tRef, ids) {
  const uniq = [...new Set(ids)];
  const out = {};
  if (!uniq.length) return out;
  const snaps = await tRef.firestore.getAll(...uniq.map((id) => tRef.collection("notifLog").doc(id)));
  snaps.forEach((s) => { if (s.exists) out[s.id] = true; });
  return out;
}
// Пометки и счётчики — в самом уведомлении, через update: если учитель как
// раз удалил уведомление, запись просто не пройдёт (set с merge воскресил бы
// его пустым документом без текста).
async function markPushed(tRef, ruleId, now) {
  await tRef.collection("notifications").doc(ruleId).update({ pushedAt: now }).catch(() => {});
}
// Счётчики рассылок для вкладки «Уведомления»: сколько раз, на сколько
// устройств, когда последний раз. Раньше вкладка ради этих цифр читала весь
// журнал за 60 дней при каждом открытии — сотни чтений.
async function countPush(tRef, ruleId, delivered, now, once) {
  const f = { pushRuns: FieldValue.increment(1), pushDelivered: FieldValue.increment(delivered), pushLastAt: now };
  if (once) f.pushedAt = now; // «разово»/«сейчас» — отправлено навсегда
  await tRef.collection("notifications").doc(ruleId).update(f).catch(() => {});
}

// Пуши учителю: устройства — state.teacherDevices { id: { token, createdAt } }
// (подписывается сам учитель во вкладке «Уведомления»), что присылать —
// state.teacherPush { paid, note, homework }. Смотрим занятия, изменённые за
// последние TEACHER_WINDOW, и ещё не разобранные сообщения каналов; событие
// старше подписки устройства не шлём.
// 9 ч — больше ночной паузы рассылки (08:00–23:59 МСК): событие ночью придёт
// утром. Повторов нет — отправленное помечено в notifLog.
const TEACHER_WINDOW = 9 * 3600000;
async function teacherPushes({ db, tRef, stateRef, state, readChannel, send, now, siteUrl, logger }) {
  const res = { planned: 0, sent: 0, failed: 0, removed: 0 };
  const devices = Object.entries(state.teacherDevices || {}).filter(([, d]) => d && typeof d.token === "string" && d.token.length > 20);
  if (!devices.length) return res;
  const since = Math.max(now - TEACHER_WINDOW, Math.min(...devices.map(([, d]) => d.createdAt || 0)));
  const lessonsSnap = await tRef.collection("lessons").where("updatedAt", ">=", since).get();
  const lessons = lessonsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const prefs = Object.assign({ paid: true, note: true, homework: true }, state.teacherPush || {});
  if (!prefs.paid && !prefs.note && !prefs.homework) return res;
  const items = [];
  for (const [sid, ch] of Object.entries(state.studentChannels || {})) {
    // родительский канал нужен только для «Оплачено»
    for (const ck of [ch && ch.shared, prefs.paid && ch && ch.parent].filter(Boolean)) {
      (await readChannel(ck)).forEach((x) => {
        if (x.data.type !== "push" && (x.data.createdAt || 0) >= since) items.push({ item: Object.assign({ id: x.id }, x.data), studentId: sid });
      });
    }
  }
  // даты занятий для сообщений из каналов, которых нет среди изменённых
  const known = new Set(lessons.map((l) => l.id));
  const missing = [...new Set(items.map((x) => x.item.lessonId).filter((id) => id && id !== "-" && !known.has(id)))].slice(0, 200);
  for (const id of missing) {
    const s = await tRef.collection("lessons").doc(id).get().catch(() => null);
    if (s && s.exists) lessons.push(Object.assign({ id: s.id }, s.data(), { __onlyForDate: true }));
  }
  const candidates = core.planTeacherPushes({
    lessons: lessons.map((l) => (l.__onlyForDate ? { id: l.id, studentId: l.studentId, startMs: l.startMs } : l)),
    items, since, log: {}, label: studentLabelFn(state.studentProfiles), prefs,
  });
  const log = await logHas(tRef, candidates.flatMap((p) => p.logIds));
  const plan = candidates.map((p) => Object.assign({}, p, { logIds: p.logIds.filter((id) => !log[id]) })).filter((p) => p.logIds.length);
  res.planned = plan.length;
  for (const p of plan) {
    try {
      await tRef.collection("notifLog").doc(p.logIds[0]).create({ ruleId: "teacher:" + p.kind, lessonId: p.lessonId, sentAt: now, recipients: devices.length, delivered: 0, failed: 0, status: "sending" });
    } catch (e) {
      continue; // уже отправляется/отправлено
    }
    for (const id of p.logIds.slice(1)) await tRef.collection("notifLog").doc(id).set({ ruleId: "teacher:" + p.kind, lessonId: p.lessonId, sentAt: now, status: "done", groupedWith: p.logIds[0] });
    const messages = devices.map(([, d]) => ({
      token: d.token,
      data: { title: p.title, body: p.body, url: teacherUrl(siteUrl, p.lessonId), tag: p.tag },
      webpush: { headers: { Urgency: "normal", TTL: String(DAY / 1000) } },
    }));
    let results;
    try { results = await send(messages); } catch (e) {
      logger.error("FCM:", e.message);
      results = messages.map(() => ({ success: false, error: { code: "send-failed" } }));
    }
    let delivered = 0, failed = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].success) { delivered++; continue; }
      failed++;
      if (results[i].error && DEAD_TOKEN.has(results[i].error.code)) {
        await stateRef.set({ teacherDevices: { [devices[i][0]]: FieldValue.delete() } }, { merge: true }).catch(() => {});
        res.removed++;
      }
    }
    await tRef.collection("notifLog").doc(p.logIds[0]).set({ delivered, failed, status: "done" }, { merge: true });
    res.sent += delivered; res.failed += failed;
    logger.log(`[${tRef.id.slice(0, 6)}…] учителю ${p.kind}: ${delivered}/${messages.length}`);
  }
  return res;
}

// Один проход по всем учителям. send(messages) → [{ success, error? }] —
// в бою это FCM, в тестах — подделка. Возвращает сводку.
export async function runOnce({ db, send, now = Date.now(), siteUrl, logger = console }) {
  const summary = { teachers: 0, planned: 0, sent: 0, failed: 0, removedTokens: 0 };
  const teachers = await db.collection("teacherSpaces").listDocuments();
  for (const tRef of teachers) {
    const stateRef = tRef.collection("state").doc("main");
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) continue;
    summary.teachers++;
    const state = stateSnap.data() || {};
    // Бесплатный план Firestore — 50 000 чтений в сутки на весь проект, а
    // запуск идёт каждые 15 минут. Поэтому читаем только то, что может
    // понадобиться: живые уведомления (не всю историю «Отправить сейчас» и
    // отчётов), действующие ключи, по одному разу каждый канал, а в журнал
    // смотрим точечно — только на то, что собираемся отправить.
    const rules = await liveRules(tRef, now);
    const live = rules.filter((r) => core.isLive(r, now) && r.push !== false && !r.pushedAt);
    let sentHere = 0;
    const channelCache = new Map(); // ключ канала → сообщения (читаем один раз за запуск)
    const readChannel = async (ck) => {
      if (!channelCache.has(ck)) {
        const snap = await db.collection("channels").doc(ck).collection("items").get();
        channelCache.set(ck, snap.docs.map((d) => ({ id: d.id, path: d.ref.path, data: d.data() })));
      }
      return channelCache.get(ck);
    };
    if (live.length) {
      const keys = (await tRef.collection("accessKeys").where("active", "==", true).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
      const maxOffset = Math.max(0, ...live.map((r) => core.offsetMs(r)));
      const lessonsSnap = await tRef.collection("lessons")
        .where("startMs", ">=", now - DAY).where("startMs", "<=", now + maxOffset + DAY).get();
      const lessons = lessonsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      // Подписки устройств — сообщения type "push" в общих каналах учеников.
      // В подписке — отпечаток ключа доступа (не сам ключ), сопоставляем с ключами.
      const keyByHash = await core.pushKeyMap(keys);
      const devices = [];
      const withKeys = new Set(keys.map((k) => k.studentId));
      for (const [sid, ch] of Object.entries(state.studentChannels || {})) {
        if (!ch || !ch.shared || !withKeys.has(sid)) continue; // без действующих доступов — некому слать
        (await readChannel(ch.shared)).filter((x) => x.data.type === "push")
          .forEach((x) => devices.push({ token: x.data.token, key: core.pushItemKey(x.data, keyByHash), path: x.path }));
      }
      const label = studentLabelFn(state.studentProfiles);
      const candidates = core.planPushes({ now, rules: live, lessons, keys, devices, log: {}, label });
      const log = await logHas(tRef, candidates.map((p) => p.logId));
      const plan = candidates.filter((p) => !log[p.logId]);
      // разовые/«сейчас», которые уже в журнале (отправлены раньше) — пометить, чтобы больше не смотреть
      for (const p of candidates) if (log[p.logId] && !p.lessonId) await markPushed(tRef, p.ruleId, now);
      summary.planned += plan.length;
      for (const p of plan) {
        const logRef = tRef.collection("notifLog").doc(p.logId);
        try {
          await logRef.create({ ruleId: p.ruleId, lessonId: p.lessonId, sentAt: now, recipients: p.to.length, delivered: 0, failed: 0, status: "sending" });
        } catch (e) {
          continue; // уже отправляется/отправлено другим запуском
        }
        const byToken = new Map(keys.map((k) => [k.id, k]));
        const messages = p.to.map((t) => ({
          token: t.token,
          data: { title: p.title, body: p.body, url: cabinetUrl(siteUrl, byToken.get(t.key), p.lessonId), tag: p.logId },
          webpush: { headers: { Urgency: "high", TTL: String(p.lessonId ? 6 * 3600 : 3 * DAY / 1000) } },
        }));
        let results = [];
        if (messages.length) {
          try {
            results = await send(messages);
          } catch (e) {
            logger.error("FCM:", e.message);
            results = messages.map(() => ({ success: false, error: { code: "send-failed", message: e.message } }));
          }
        }
        let delivered = 0, failed = 0;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.success) { delivered++; continue; }
          failed++;
          if (r.error && DEAD_TOKEN.has(r.error.code)) {
            // устройство отписалось/переустановило браузер — подписка больше не нужна
            await db.doc(p.to[i].path).delete().catch(() => {});
            summary.removedTokens++;
          }
        }
        await logRef.set({ delivered, failed, status: "done" }, { merge: true });
        await countPush(tRef, p.ruleId, delivered, now, !p.lessonId);
        summary.sent += delivered;
        summary.failed += failed;
        sentHere += delivered;
        logger.log(`[${tRef.id.slice(0, 6)}…] ${p.logId}: ${delivered}/${messages.length}`);
      }
    }
    // Обратные пуши — учителю (оплата, пояснение, ДЗ от родителя/ученика).
    const t = await teacherPushes({ db, tRef, stateRef, state, readChannel, send, now, siteUrl, logger });
    summary.planned += t.planned; summary.sent += t.sent; summary.failed += t.failed; summary.removedTokens += t.removed;
    sentHere += t.sent;
    // Журнал не растёт бесконечно: раз в сутки удаляем записи старше 60 дней.
    // Кроме «разово»/«сейчас» (…__once): вместе с пометкой pushedAt у самого
    // уведомления они не дают отправить его повторно.
    const lastPurge = (state.notifier && state.notifier.lastPurgeAt) || 0;
    let purgedAt = lastPurge;
    if (now - lastPurge >= DAY) {
      const old = await tRef.collection("notifLog").where("sentAt", "<", now - 60 * DAY).limit(300).get();
      for (const d of old.docs) if (!d.id.endsWith("__once")) await d.ref.delete();
      purgedAt = now;
    }
    // statsSince — с какого момента рассылка ведёт счётчики в уведомлениях:
    // записи журнала до него кабинет учителя один раз переносит в pushLegacy.
    const statsSince = (state.notifier && state.notifier.statsSince) || now;
    await stateRef.set({ notifier: { lastRunAt: now, lastSent: sentHere, lastPurgeAt: purgedAt, statsSince } }, { merge: true });
  }
  return summary;
}

// Запуск из GitHub Actions: node send.mjs
async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw && !emulator) {
    console.log("::notice::Секрет FIREBASE_SERVICE_ACCOUNT не задан — пуш-уведомления выключены (см. README.md → «Уведомления»).");
    return;
  }
  const app = raw
    ? initializeApp({ credential: cert(JSON.parse(raw)) })
    : initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-tutor" });
  const db = getFirestore(app);
  const messaging = getMessaging(app);
  const send = async (messages) => {
    const out = [];
    for (let i = 0; i < messages.length; i += 500) {
      const res = await messaging.sendEach(messages.slice(i, i + 500));
      res.responses.forEach((r) => out.push({ success: r.success, error: r.error ? { code: r.error.code, message: r.error.message } : null }));
    }
    return out;
  };
  const siteUrl = process.env.SITE_URL || "https://tviitterggl-dev.github.io/tutor-dashboard/";
  const s = await runOnce({ db, send, siteUrl });
  console.log(`Готово: учителей ${s.teachers}, рассылок ${s.planned}, доставлено ${s.sent}, ошибок ${s.failed}, удалено подписок ${s.removedTokens}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
