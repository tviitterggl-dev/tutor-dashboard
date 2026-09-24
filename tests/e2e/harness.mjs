// Стенд для e2e-тестов: настоящий index.html/cabinet.html в Chromium,
// а все внешние сервисы (Firebase, Google, CDN, Cloudinary) подменены
// локальными заглушками. В фикстурах — вымышленные ученики (репозиторий
// публичный, настоящие имена сюда не попадают).
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const NM = path.resolve(HERE, "../node_modules");
const STUBS = path.resolve(HERE, "../stubs");

export const T = "teacher_key_for_tests_0123456789";
export const LESSONS_CAL = "676742127252c358d9ad3f9bd85e2965176875b1aeb2d7fa65cd4341361d4397@group.calendar.google.com";
export const NOW = "2026-09-24T12:00:00+03:00"; // четверг

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

let server = null;
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
export function defaultPersonalFixture() {
  return [ev("doc1", "Врач", "2026-09-25T13:00:00", 60)];
}
export const RATES = [
  ["Имя", "Фамилия", "Класс", "Ставка"],
  ["Тест", "Тестов", "7", "2000"],
  ["Анна", "", "6", "1500"],
  ["Борис", "", "8", "1800"],
];

export function defaultSeed() {
  return {
    [`teacherSpaces/${T}/state/main`]: {
      marks: {
        "serA_20260914T070000Z": { marked: true, overrideAmount: null, lockedRate: 2000, updatedAt: 1 },
        "serA_20260916T070000Z": { marked: true, overrideAmount: null, lockedRate: 2000, updatedAt: 1 },
        anna3: { marked: true, overrideAmount: 1400, lockedRate: 1500, updatedAt: 1 },
      },
      pkgOverrides: {},
    },
  };
}

// ---- открыть страницу ----
export async function openApp(opts = {}) {
  const url0 = await ensureServer();
  if (!browser) browser = await chromium.launch();
  const lessons = opts.lessons || defaultLessonsFixture();
  const personal = opts.personal || defaultPersonalFixture();
  const calls = { calendarWrites: [], cloudinary: [], unexpected: [], calendarReads: 0 };

  const context = await browser.newContext({
    timezoneId: "Europe/Moscow",
    locale: "ru-RU",
    viewport: opts.viewport || { width: 1100, height: 900 },
    userAgent: opts.userAgent,
    hasTouch: !!opts.hasTouch,
    isMobile: !!opts.isMobile,
  });
  const initState = {
    seed: opts.seed === undefined ? defaultSeed() : opts.seed,
    teacherKey: opts.teacherKey === undefined ? T : opts.teacherKey,
    token: opts.loggedIn === false ? null : true,
    deny: opts.deny || [],
    localMarks: opts.localStorage || {},
  };
  await context.addInitScript((s) => {
    window.__FAKE_DENY = s.deny;
    // Флаг в localStorage: общий для всех вкладок контекста (кабинет,
    // открытый во второй вкладке, не должен стирать «базу»).
    if (localStorage.getItem("__seeded")) return;
    localStorage.clear();
    localStorage.setItem("__seeded", "1");
    localStorage.setItem("__fakeDb", JSON.stringify(s.seed || {}));
    if (s.teacherKey) localStorage.setItem("teacherKey", s.teacherKey);
    if (s.token) localStorage.setItem("gtoken", JSON.stringify({ token: "read-token", expiresAt: Date.now() + 10 * 365 * 864e5 }));
    for (const [k, v] of Object.entries(s.localMarks)) localStorage.setItem(k, v);
  }, initState);

  await context.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const file = (p, type = "application/javascript") => route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(p) });
    const json = (obj, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });

    if (u.origin === url0) return route.continue();
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-app.js")) return file(path.join(STUBS, "firebase-app.js"));
    if (u.hostname === "www.gstatic.com" && u.pathname.endsWith("/firebase-firestore.js")) return file(path.join(STUBS, "firebase-firestore.js"));
    if (u.hostname === "accounts.google.com") return file(path.join(STUBS, "gsi.js"));
    if (u.hostname.startsWith("fonts.")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (u.hostname === "cdn.jsdelivr.net" && u.pathname.includes("/fullcalendar@")) return file(path.join(NM, "fullcalendar/index.global.min.js"));
    if (u.hostname === "cdn.jsdelivr.net" && u.pathname.includes("/locales/ru.global")) return file(path.join(NM, "@fullcalendar/core/locales/ru.global.min.js"));
    if (u.hostname === "cdnjs.cloudflare.com" && u.pathname.includes("html2canvas")) return file(path.join(NM, "html2canvas/dist/html2canvas.min.js"));
    if (u.hostname === "sheets.googleapis.com") return json({ values: RATES });
    if (u.hostname === "www.googleapis.com" && u.pathname.startsWith("/calendar/v3/calendars/")) {
      const calId = decodeURIComponent(u.pathname.split("/")[4]);
      if (req.method() === "GET") {
        calls.calendarReads++;
        const min = new Date(u.searchParams.get("timeMin")).getTime();
        const max = new Date(u.searchParams.get("timeMax")).getTime();
        const src = calId === "primary" ? personal : calId === LESSONS_CAL ? lessons : [];
        const items = src.filter((e) => { const s = new Date(e.start.dateTime).getTime(); return s >= min && s < max; })
          .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
        return json({ items });
      }
      const body = req.postDataJSON();
      const n = calls.calendarWrites.length + 1;
      calls.calendarWrites.push({ method: req.method(), calId, path: u.pathname, body, auth: req.headers()["authorization"] });
      return json({ id: u.pathname.split("/")[6] || `exp${n}`, ...body });
    }
    if (u.hostname === "api.cloudinary.com") {
      const n = calls.cloudinary.length + 1;
      calls.cloudinary.push({ url: req.url() });
      if (opts.cloudinaryFail) return json({ error: { message: "Upload preset not found" } }, 400);
      return json({ secure_url: `https://res.cloudinary.com/xf4hvf5p/raw/upload/v1/hw_${n}.pdf`, bytes: 1234, format: "pdf", resource_type: "raw" });
    }
    calls.unexpected.push(req.url());
    return route.abort();
  });

  const page = await context.newPage();
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
    close: () => context.close(),
  };
}

export async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector(".empty") || !/Загрузка/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}
