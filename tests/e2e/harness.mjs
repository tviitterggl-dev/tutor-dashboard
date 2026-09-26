// Стенд для e2e-тестов: настоящий index.html/cabinet.html в Chromium,
// а все внешние сервисы (Firebase, Google, CDN, Cloudinary) подменены
// локальными заглушками. В фикстурах — вымышленные ученики (репозиторий
// публичный, настоящие имена сюда не попадают).
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const NM = path.resolve(HERE, "../node_modules");
const STUBS = path.resolve(HERE, "../stubs");

export const T = "teacherUid0123456789abcdef";   // uid учителя (Firebase Auth)
export const TEACHER_EMAIL = "teacher@example.org";
export const TEACHER_PASSWORD = "correct-horse-1";
export const NOW = "2026-09-24T12:00:00+03:00"; // четверг

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

let server = null;
let testVapidKey = null; // см. opts.vapidKey
let baseUrl = null;
let browser = null;

async function ensureServer() {
  if (server) return baseUrl;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let p = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!fs.existsSync(p)) { res.writeHead(404); res.end("not found"); return; }
    // Тестовый публичный ключ пушей (в самом cabinet.html он пуст, пока его
    // не создали в консоли Firebase). Подставляет сервер, а не перехват
    // запросов: страницу под service worker перехват не видит.
    if (testVapidKey && p.endsWith("cabinet.html")) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(fs.readFileSync(p, "utf8").replace('const FCM_VAPID_KEY = "";', `const FCM_VAPID_KEY = ${JSON.stringify(testVapidKey)};`));
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function shutdown() {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  browser = null; server = null;
}

// ---- фикстуры ----
function ev(id, title, startMsk, durMin, extra = {}) {
  const start = new Date(startMsk + "+03:00");
  const end = new Date(start.getTime() + durMin * 60000);
  const iso = (d) => new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
  return { id, summary: title, status: "confirmed", start: { dateTime: iso(start), timeZone: "Europe/Moscow" }, end: { dateTime: iso(end), timeZone: "Europe/Moscow" }, ...extra };
}

export function defaultLessonsFixture() {
  const out = [];
  const pkgDates = ["2026-09-14", "2026-09-16", "2026-09-18", "2026-09-21", "2026-09-23", "2026-09-25", "2026-09-28", "2026-09-30"];
  pkgDates.forEach((d, i) => {
    const id = `serA_${d.replace(/-/g, "")}T070000Z`;
    out.push(ev(id, `Тест 7 класс ${i + 1}/8`, `${d}T10:00:00`, 60, { recurringEventId: "serA" }));
  });
  ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"].forEach((d, i) => {
    out.push(ev(`anna${i + 1}`, "Анна 6 класс", `${d}T15:00:00`, 60));
  });
  out.push(ev("boris1", "Борис 8 класс", "2026-09-17T18:00:00", 60));
  out.push(ev("boris2", "Борис 8 класс", "2026-09-24T18:00:00", 90));
  out.push(ev("trial1", "Пробное занятие Авито", "2026-09-22T09:00:00", 30));
  return out;
}
// Занятие в формате Firestore (как его хранит дашборд).
export function lessonDoc(e, marks = {}) {
  const startMs = Date.parse(e.start.dateTime);
  const endMs = Date.parse(e.end.dateTime);
  const iso = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
  const m = (e.summary || "").match(/^([А-ЯЁа-яё]+)\s+(\d{1,2})\s*класс/u);
  const studentId = m ? `${m[1]}, ${m[2]} класс` : null;
  const pkg = /\d+\/\d+$/.test(e.summary || "");
  return {
    title: e.summary, studentId, startMs, endMs, start: iso(startMs), end: iso(endMs),
    date: iso(startMs).slice(0, 10), time: iso(startMs).slice(11, 16), durationMin: Math.round((endMs - startMs) / 60000),
    status: marks[e.id] && marks[e.id].marked ? "done" : "planned",
    packageId: pkg && studentId ? "pkg_" + studentId : null, recurrenceId: e.recurringEventId || null,
    source: "gcal", createdAt: 1, updatedAt: 1,
  };
}

export const PROFILES = {
  "Тест, 7 класс": { name: "Тест", cls: 7, rate: 2000, manual: true },
  "Анна, 6 класс": { name: "Анна", surname: "", cls: 6, rate: 1500, manual: true },
  "Борис, 8 класс": { name: "Борис", surname: "", cls: 8, rate: 1800, manual: true },
};

export function defaultSeed(opts = {}) {
  const uid = opts.uid || T;
  const marks = {
    "serA_20260914T070000Z": { marked: true, overrideAmount: null, lockedRate: 2000, updatedAt: 1 },
    "serA_20260916T070000Z": { marked: true, overrideAmount: null, lockedRate: 2000, updatedAt: 1 },
    anna3: { marked: true, overrideAmount: 1400, lockedRate: 1500, updatedAt: 1 },
  };
  const seed = {
    [`teacherSpaces/${uid}/state/main`]: { marks, pkgOverrides: {}, studentProfiles: JSON.parse(JSON.stringify(PROFILES)) },
  };
  for (const e of opts.lessons || defaultLessonsFixture()) seed[`teacherSpaces/${uid}/lessons/${e.id}`] = lessonDoc(e, marks);
  return seed;
}

// ---- открыть страницу ----
export async function openApp(opts = {}) {
  const url0 = await ensureServer();
  testVapidKey = opts.vapidKey || null;
  if (!browser) browser = await chromium.launch();
  const calls = { cloudinary: [], unexpected: [] };
  const ctxOpts = {
    timezoneId: "Europe/Moscow",
    locale: "ru-RU",
    viewport: opts.viewport || { width: 1100, height: 900 },
    userAgent: opts.userAgent,
    hasTouch: !!opts.hasTouch,
    isMobile: !!opts.isMobile,
    deviceScaleFactor: opts.deviceScaleFactor,
    // service worker (sw.js) выключен во всех тестах, кроме проверки установки
    serviceWorkers: opts.serviceWorkers || "block",
    colorScheme: opts.colorScheme || "light",
  };
  // opts.persistent: обычный (не «инкогнито») профиль Chrome в отдельном
  // браузере — только так Chrome соглашается «установить приложение».
  let profileDir = null;
  let context;
  if (opts.persistent) {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));
    context = await chromium.launchPersistentContext(profileDir, { ...ctxOpts, ...opts.persistent });
  } else {
    context = await browser.newContext(ctxOpts);
  }
  const initState = {
    seed: opts.seed === undefined ? defaultSeed({ lessons: opts.lessons }) : opts.seed,
    // учётная запись учителя существует всегда; вошёл ли он — opts.signedIn
    users: opts.users || { [TEACHER_EMAIL]: { password: TEACHER_PASSWORD, uid: T } },
    signedIn: opts.signedIn === false ? null : { uid: T, email: TEACHER_EMAIL },
    deny: opts.deny || [],
    rules: opts.rules || "new",
    authDisabled: !!opts.authDisabled,
    nextUid: opts.nextUid || null,
    extraStorage: opts.localStorage || {},
  };
  await context.addInitScript((s) => {
    window.__FAKE_DENY = s.deny;
    window.__FAKE_RULES = s.rules;
    window.__FAKE_AUTH_DISABLED = s.authDisabled;
    if (s.nextUid) window.__FAKE_NEXT_UID = s.nextUid;
    // Флаг в localStorage: общий для всех вкладок контекста (кабинет,
    // открытый во второй вкладке, не должен стирать «базу»).
    if (localStorage.getItem("__seeded")) return;
    localStorage.clear();
    localStorage.setItem("__seeded", "1");
    localStorage.setItem("__fakeDb", JSON.stringify(s.seed || {}));
    localStorage.setItem("__fakeAuthUsers", JSON.stringify(s.users));
    if (s.signedIn) localStorage.setItem("__fakeAuthUser", JSON.stringify(s.signedIn));
    for (const [k, v] of Object.entries(s.extraStorage)) localStorage.setItem(k, v);
  }, initState);

  await context.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const file = (p, type = "application/javascript") => route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(p) });
    const json = (obj, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });

    if (u.origin === url0) return route.continue();
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-app.js")) return file(path.join(STUBS, "firebase-app.js"));
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-firestore.js")) return file(path.join(STUBS, "firebase-firestore.js"));
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-auth.js")) return file(path.join(STUBS, "firebase-auth.js"));
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-messaging.js")) return file(path.join(STUBS, "firebase-messaging.js"));
    if (u.hostname.startsWith("fonts.") && opts.fontDir) {
      // Скачанные заранее шрифты Google (для скриншотов; см. tests/screens.mjs)
      if (u.hostname === "fonts.googleapis.com") {
        const h = crypto.createHash("sha1").update(req.url()).digest("hex").slice(0, 16);
        const f = path.join(opts.fontDir, `css_${h}.css`);
        if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: "text/css", body: fs.readFileSync(f, "utf8") });
      } else {
        const f = path.join(opts.fontDir, "gstatic", u.pathname);
        if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: "font/woff2", body: fs.readFileSync(f) });
      }
    }
    if (u.hostname.startsWith("fonts.")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (u.hostname === "cdn.jsdelivr.net" && u.pathname.includes("/fullcalendar@")) return file(path.join(NM, "fullcalendar/index.global.min.js"));
    if (u.hostname === "cdn.jsdelivr.net" && u.pathname.includes("/locales/ru.global")) return file(path.join(NM, "@fullcalendar/core/locales/ru.global.min.js"));
    if (u.hostname === "cdnjs.cloudflare.com" && u.pathname.includes("html2canvas")) return file(path.join(NM, "html2canvas/dist/html2canvas.min.js"));
    if (u.hostname === "api.cloudinary.com") {
      const n = calls.cloudinary.length + 1;
      calls.cloudinary.push({ url: req.url() });
      if (opts.cloudinaryFail) return json({ error: { message: "Upload preset not found" } }, 400);
      return json({ secure_url: `https://res.cloudinary.com/xf4hvf5p/raw/upload/v1/hw_${n}.pdf`, bytes: 1234, format: "pdf", resource_type: "raw" });
    }
    calls.unexpected.push(req.url());
    return route.abort();
  });

  const page = opts.persistent ? (context.pages()[0] || await context.newPage()) : await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", async (d) => {
    const handler = opts.onDialog || (() => true);
    const answer = await handler(d);
    if (answer === false) await d.dismiss(); else await d.accept(typeof answer === "string" ? answer : undefined);
  });
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(url0 + (opts.path || "/index.html") + (opts.hash || ""));

  return {
    page, calls, errors, context,
    db: () => page.evaluate(() => JSON.parse(localStorage.getItem("__fakeDb") || "{}")),
    close: async () => { await context.close(); if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); },
  };
}

export async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector(".empty") || !/Загрузка/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}
