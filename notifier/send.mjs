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
import { getFirestore } from "firebase-admin/firestore";
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
const cabinetUrl = (siteUrl, key) => `${siteUrl.replace(/\/?$/, "/")}cabinet.html#${key.role === "parent" ? "p" : "s"}=${key.id}`;

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
    const rules = (await tRef.collection("notifications").get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const live = rules.filter((r) => core.isLive(r, now) && r.push !== false);
    let sentHere = 0;
    if (live.length) {
      const keys = (await tRef.collection("accessKeys").get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
      const maxOffset = Math.max(0, ...live.map((r) => core.offsetMs(r)));
      const lessonsSnap = await tRef.collection("lessons")
        .where("startMs", ">=", now - DAY).where("startMs", "<=", now + maxOffset + DAY).get();
      const lessons = lessonsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      // Подписки устройств — сообщения type "push" в общих каналах учеников.
      const devices = [];
      for (const ch of Object.values(state.studentChannels || {})) {
        if (!ch || !ch.shared) continue;
        const items = await db.collection("channels").doc(ch.shared).collection("items").where("type", "==", "push").get();
        items.docs.forEach((d) => { const x = d.data(); devices.push({ token: x.token, key: x.key, path: d.ref.path }); });
      }
      const logSnap = await tRef.collection("notifLog").get();
      const log = Object.fromEntries(logSnap.docs.map((d) => [d.id, true]));
      const label = studentLabelFn(state.studentProfiles);
      const plan = core.planPushes({ now, rules: live, lessons, keys, devices, log, label });
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
          data: { title: p.title, body: p.body, url: cabinetUrl(siteUrl, byToken.get(t.key)), tag: p.logId },
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
        summary.sent += delivered;
        summary.failed += failed;
        sentHere += delivered;
        logger.log(`[${tRef.id.slice(0, 6)}…] ${p.logId}: ${delivered}/${messages.length}`);
      }
      // Журнал не растёт бесконечно: старше 60 дней — удаляем.
      const old = logSnap.docs.filter((d) => (d.data().sentAt || 0) < now - 60 * DAY);
      for (const d of old) await d.ref.delete();
    }
    await stateRef.set({ notifier: { lastRunAt: now, lastSent: sentHere } }, { merge: true });
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
