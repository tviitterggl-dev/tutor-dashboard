// Скриншоты интерфейса на телефоне (iPhone 13, 390×844) в светлой и тёмной
// теме — для сравнения «до/после» при правках дизайна.
// Запуск: cd tests && node screens.mjs <папка для png> [папка со шрифтами]
// Папка со шрифтами — заранее скачанные css/woff2 Google Fonts (без неё
// браузер покажет системные шрифты; сеть в тестах закрыта).
import fs from "node:fs";
import path from "node:path";
import { devices } from "playwright";
import { openApp, shutdown, T, defaultSeed } from "./e2e/harness.mjs";

const [outDir, fontDir] = process.argv.slice(2);
if (!outDir) { console.error("usage: node screens.mjs <outDir> [fontDir]"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const PK = "parent_key_test_student_0000000001";
const SK = "student_key_test_student_000000002";
const phone = devices["iPhone 13"];

function seed() {
  const s = defaultSeed();
  const k = (role, createdAt) => ({ role, studentId: "Тест, 7 класс", label: "", createdAt, active: true, revokedAt: null });
  s[`teacherSpaces/${T}/accessKeys/${PK}`] = k("parent", 1);
  s[`teacherSpaces/${T}/accessKeys/${SK}`] = k("student", 2);
  return s;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(page, name) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await pause(450); // анимации переходов успевают закончиться
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  console.log("  " + name);
}

for (const scheme of ["light", "dark"]) {
  console.log(scheme);
  const app = await openApp({
    seed: seed(), colorScheme: scheme, fontDir,
    viewport: phone.viewport, userAgent: phone.userAgent, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const { page } = app;
  const base = page.url().replace(/\/index\.html.*$/, "");
  await page.waitForSelector("#lessonsList .lesson");
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const db = await app.db();
    if (db[`parentAccess/${PK}`]?.channel && db[`studentAccess/${SK}`]) break;
    await pause(150);
  }

  await shoot(page, `${scheme}-teacher-1-lessons`);
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await shoot(page, `${scheme}-teacher-2-calendar`);
  await page.click("#fcRoot .fc-event");
  await page.waitForSelector("#modalBack", { state: "visible" });
  await shoot(page, `${scheme}-teacher-3-lesson-modal`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const b = document.getElementById("modalBack"); if (b && getComputedStyle(b).display !== "none") document.querySelector("#modalBack .modal-close, #mCancel, #mClose")?.click(); });
  await page.goto(base + "/index.html");
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="summary"]');
  await shoot(page, `${scheme}-teacher-4-summary`);
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Тест, 7 класс"]');
  await card.locator(".student-head").click();
  await shoot(page, `${scheme}-teacher-5-students`);
  if (await page.$('.tab[data-tab="more"]')) {
    await page.click('.tab[data-tab="more"]');
    await shoot(page, `${scheme}-teacher-6-more`);
  }

  for (const [role, hash] of [["parent", `#p=${PK}`], ["student", `#s=${SK}`]]) {
    const cab = await app.context.newPage();
    await cab.clock.setFixedTime(new Date("2026-09-24T12:00:00+03:00"));
    await cab.goto(base + "/cabinet.html" + hash);
    await cab.waitForSelector("#pane-lessons .lesson");
    await shoot(cab, `${scheme}-${role}-1-lessons`);
    await cab.click('.ctab[data-ctab="calendar"]');
    await cab.waitForSelector("#cal .fc-event");
    await shoot(cab, `${scheme}-${role}-2-calendar`);
    await cab.click('.ctab[data-ctab="hw"]');
    await shoot(cab, `${scheme}-${role}-3-hw`);
    await cab.click('.ctab[data-ctab="more"]');
    await shoot(cab, `${scheme}-${role}-4-more`);
    await cab.close();
  }
  await app.close();
}
await shutdown();
