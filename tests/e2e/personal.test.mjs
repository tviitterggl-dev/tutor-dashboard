// «Личное время», смена класса ученика, установка как веб-приложение.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const statePath = `teacherSpaces/${T}/state/main`;
const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
const PK = "parent_key_test_student_0000000001";
const docsOf = (db) => Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/lessons/`)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("Не дождались: " + what);
}
function seedWithParent() {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", createdAt: 1, active: true };
  return seed;
}

test("личное время: создать серию, в деньгах и списке занятий его нет, в сетке и у родителя — «занято»", async () => {
  const app = await openApp({ seed: seedWithParent() });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  await page.waitForSelector("#lessonsList .lesson");
  const forecastBefore = await page.textContent("#forecastSum");

  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click("#fcPersonalBtn");
  await page.fill("#mDate", "2026-09-24");
  await page.fill("#mTime", "13:00");
  await page.selectOption("#mDur", "120");
  await page.fill("#mNote", "врач");
  await page.check("#mRepeat");
  await page.fill("#mCount", "2");
  await page.click("#mPersonalSave");
  await page.waitForSelector("#modalBack", { state: "hidden" });

  const blocks = docsOf(await app.db()).filter((d) => d.kind === "personal").sort((a, b) => a.startMs - b.startMs);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.date, b.time, b.durationMin]), [["2026-09-24", "13:00", 120], ["2026-10-01", "13:00", 120]]);
  assert.ok(blocks.every((b) => b.note === "врач" && b.studentId === null && b.status === "planned"));
  assert.equal(blocks[0].recurrenceId, blocks[1].recurrenceId);
  await page.waitForSelector("#fcRoot .fc-event.st-personal");
  assert.match(await page.textContent("#fcRoot .fc-event.st-personal"), /Личное время: врач/);

  // Нет в списке занятий и в прогнозе заработка
  await page.click('.tab[data-tab="lessons"]');
  await page.waitForSelector("#lessonsList .lesson");
  assert.equal(/Личное время/.test(await page.textContent("#lessonsList")), false);
  assert.equal(await page.textContent("#forecastSum"), forecastBefore);
  // В сетке «Расписание» — занято (чт 24.09, 13:00 и 14:00)
  await page.click('.tab[data-tab="schedule"]');
  await page.waitForSelector("#schedTable td.free");
  const cell = (row, col) => page.$eval("#schedTable", (t, [r, c]) => t.rows[r].cells[c].className, [row, col]);
  assert.equal(await cell(13 - 8 + 1, 4), "busy");
  assert.equal(await cell(14 - 8 + 1, 4), "busy");
  // У родителя — просто «занято», без имени, без комментария, без пометки «личное»
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`].busy.some((b) => b.s === blocks[0].startMs), "занято в витрине");
  const v = JSON.stringify((await app.db())[`parentAccess/${PK}`]);
  for (const bad of ["врач", "Личное", "personal", blocks[0].id]) assert.equal(v.includes(bad), false, bad);
  const cab = await app.context.newPage();
  await cab.clock.setFixedTime(new Date(NOW));
  await cab.goto(page.url().replace(/\/index\.html.*$/, "") + `/cabinet.html#p=${PK}`);
  await cab.waitForSelector("#pane-lessons .lesson");
  await cab.click('.ctab[data-ctab="calendar"]');
  await cab.waitForSelector("#cal .fc-event.busy");
  const busyTexts = await cab.$$eval("#cal .fc-event.busy", (els) => els.map((e) => e.textContent));
  assert.ok(busyTexts.some((t) => /13:00.*занято/.test(t)));
  assert.equal(busyTexts.some((t) => /врач|Личное/.test(t)), false);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("личное время: из окна нового занятия, изменить, перетащить, удалить серию", async () => {
  const app = await openApp({ onDialog: () => true });
  const { page } = app;
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-event");
  await page.click("#fcAddBtn");
  await page.fill("#mDate", "2026-09-26");
  await page.fill("#mTime", "16:00");
  await page.click("#mToPersonal");
  await page.waitForSelector("#mPersonalSave");
  assert.equal(await page.inputValue("#mDate"), "2026-09-26", "дата перенесена из формы занятия");
  assert.equal(await page.inputValue("#mTime"), "16:00");
  await page.check("#mRepeat");
  await page.fill("#mCount", "3");
  await page.click("#mPersonalSave");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  let blocks = docsOf(await app.db()).filter((d) => d.kind === "personal").sort((a, b) => a.startMs - b.startMs);
  assert.equal(blocks.length, 3);

  // изменить первый: 17:00, комментарий
  await page.locator("#fcRoot .fc-event.st-personal").first().click();
  await page.waitForSelector("#mPersonalDelete");
  await page.fill("#mTime", "17:00");
  await page.fill("#mNote", "спорт");
  await page.click("#mPersonalSave");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  let db = await app.db();
  assert.equal(db[L(blocks[0].id)].time, "17:00");
  assert.equal(db[L(blocks[0].id)].note, "спорт");
  assert.equal(db[L(blocks[1].id)].time, "16:00", "только этот");

  // перетащить: сдвиг на месте, без «перенесено»
  const ev = page.locator("#fcRoot .fc-event.st-personal").first();
  await ev.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await ev.boundingBox();
  const slotH = (await page.locator(".fc-timegrid-slot-lane").first().boundingBox()).height;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + box.width / 2, box.y + 6 + (i * slotH * 2) / 10); await page.waitForTimeout(20); }
  await page.mouse.up();
  await waitFor(async () => (await app.db())[L(blocks[0].id)].time !== "17:00", "сдвиг");
  db = await app.db();
  assert.equal(db[L(blocks[0].id)].status, "planned");
  assert.equal(db[L(blocks[0].id)].kind, "personal");
  assert.equal(docsOf(db).filter((d) => d.kind === "personal").length, 3, "копия не создана");

  // удалить второй и следующие
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event.st-personal").first().click();
  await page.waitForSelector("#mScope");
  await page.selectOption("#mScope", "following");
  await page.click("#mPersonalDelete");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  blocks = docsOf(await app.db()).filter((d) => d.kind === "personal");
  assert.equal(blocks.length, 1);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("смена класса: занятия, профиль, пакет, доступы, каналы и заявки переезжают, связи не рвутся", async () => {
  const seed = seedWithParent();
  seed[statePath].pkgOverrides = { "Тест, 7 класс": { doneOverride: 3, totalOverride: 8 } };
  seed[statePath].studentProfiles["Тест, 7 класс"].callUrl = "https://t.me/call";
  seed[`teacherSpaces/${T}/requests/r1`] = { type: "cancel", lessonId: "serA_20260930T070000Z", studentId: "Тест, 7 класс", status: "rejected", reason: "", decidedAt: Date.parse(NOW) - 1000, createdAt: 1, by: "parent" };
  const app = await openApp({ seed, onDialog: () => true });
  const { page } = app;
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const channelBefore = (await app.db())[statePath].studentChannels["Тест, 7 класс"];

  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Тест, 7 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-cls").fill("8");
  await card.locator("[data-pf-save]").click();
  await page.waitForSelector('.student-card[data-student="Тест, 8 класс"] .pf-msg.ok');
  assert.match(await page.textContent('.student-card[data-student="Тест, 8 класс"] .pf-msg'), /теперь 8 класс/);

  const db = await app.db();
  const d = (id) => db[L(id)];
  assert.equal(d("serA_20260914T070000Z").title, "Тест 8 класс 1/8");
  assert.equal(d("serA_20260930T070000Z").title, "Тест 8 класс 8/8");
  assert.equal(d("serA_20260914T070000Z").studentId, "Тест, 8 класс");
  assert.equal(d("serA_20260914T070000Z").status, "done", "статус не тронут");
  assert.equal(d("anna1").title, "Анна 6 класс", "чужие занятия не тронуты");
  assert.equal(db[statePath].marks["serA_20260914T070000Z"].lockedRate, 2000, "отметки на месте");
  const st = db[statePath];
  assert.equal(st.studentProfiles["Тест, 7 класс"], undefined);
  assert.equal(st.studentProfiles["Тест, 8 класс"].callUrl, "https://t.me/call");
  assert.equal(st.studentProfiles["Тест, 8 класс"].cls, 8);
  assert.equal(st.studentProfiles["Тест, 8 класс"].rate, 2000);
  assert.deepEqual(st.pkgOverrides["Тест, 8 класс"], { doneOverride: 3, totalOverride: 8 });
  assert.equal(st.pkgOverrides["Тест, 7 класс"], undefined);
  assert.deepEqual(st.studentChannels["Тест, 8 класс"], channelBefore, "каналы те же — ссылки родителей не ломаются");
  assert.equal(db[`teacherSpaces/${T}/accessKeys/${PK}`].studentId, "Тест, 8 класс");
  assert.equal(db[`teacherSpaces/${T}/requests/r1`].studentId, "Тест, 8 класс");
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`].studentId === "Тест, 8 класс", "витрина обновлена");
  const v = (await app.db())[`parentAccess/${PK}`];
  assert.equal(v.lessons.length, 8, "все занятия ученика в кабинете");
  assert.equal(v.requests.length, 1, "история заявок сохранилась");
  assert.equal(v.package.done, 3, "правка пакета сохранилась");
  // ставка находится для нового класса
  await page.click('.tab[data-tab="lessons"]');
  await page.waitForSelector("#lessonsList .lesson");
  const row = page.locator(".lesson", { hasText: "Тест, 8 класс" }).first();
  assert.equal(await row.locator("input").getAttribute("placeholder"), "2000");
  assert.equal(/Тест, 7 класс/.test(await page.textContent("#lessonsList")), false);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("смена класса: если такой ученик уже есть — отказ без изменений; отмена в подтверждении", async () => {
  let dialogs = 0;
  const seed = defaultSeed();
  seed[statePath].studentProfiles["Анна, 7 класс"] = { name: "Анна", cls: 7, rate: 1000 };
  const app = await openApp({ seed, onDialog: () => { dialogs++; return dialogs > 1; } });
  const { page } = app;
  await page.click('.tab[data-tab="students"]');
  const card = page.locator('.student-card[data-student="Анна, 6 класс"]');
  await card.locator(".student-head").click();
  await card.locator(".pf-cls").fill("7");
  await card.locator("[data-pf-save]").click(); // первый диалог — «Отмена»
  await page.waitForTimeout(300);
  assert.equal((await app.db())[L("anna1")].title, "Анна 6 класс");
  await card.locator("[data-pf-save]").click(); // подтверждаем — но такой уже есть
  await page.waitForFunction(() => /уже есть/.test(document.querySelector('.student-card[data-student="Анна, 6 класс"] .pf-msg').textContent));
  const db = await app.db();
  assert.equal(db[L("anna1")].title, "Анна 6 класс");
  assert.equal(db[statePath].studentProfiles["Анна, 6 класс"].rate, 1500);
  await app.close();
});

test("веб-приложение: manifest, значки, мета-теги для iPhone", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const tag of [
    '<link rel="manifest" href="manifest.json">',
    '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="theme-color"',
    'viewport-fit=cover',
  ]) assert.ok(html.includes(tag), tag);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "./index.html");
  assert.ok(m.theme_color && m.background_color && m.short_name);
  const pngSize = (f) => { const b = fs.readFileSync(path.join(ROOT, f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const icon of m.icons) {
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(icon.src), [w, h], icon.src);
  }
  assert.deepEqual(pngSize("icons/apple-touch-icon.png"), [180, 180]);
  // сайт действительно отдаёт manifest и значок
  const app = await openApp();
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  for (const f of ["manifest.json", "icons/apple-touch-icon.png", "icons/icon-512.png"]) {
    const r = await app.page.request.get(`${base}/${f}`);
    assert.equal(r.status(), 200, f);
  }
  await app.close();
});
