import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openApp, shutdown, T } from "./harness.mjs";

after(shutdown);

const statePath = `teacherSpaces/${T}/state/main`;
const lessonDocs = (db) => Object.entries(db).filter(([p]) => p.startsWith(`teacherSpaces/${T}/lessons/`)).map(([p, d]) => ({ id: p.split("/").pop(), ...d }));

async function waitFor(fn, what, timeout = 6000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Не дождались: " + what);
}

async function openImported(opts = {}) {
  const app = await openApp(opts);
  await app.page.waitForSelector("#appRoot", { state: "visible" });
  await app.page.click('.tab[data-tab="calendar"]');
  await app.page.waitForSelector("#fcRoot .fc-event");
  return app;
}

test("создание серии-пакета, проверка пересечений", async () => {
  const dialogs = [];
  const app = await openImported({ onDialog: (d) => { dialogs.push(d.message()); return true; } });
  const { page } = app;
  const before = lessonDocs(await app.db()).length;

  await page.click("#fcAddBtn");
  await page.waitForSelector("#modal #mStudent");
  await page.selectOption("#mStudent", "Анна 6 класс");
  await page.fill("#mDate", "2026-09-29"); // вторник, в 15:00 уже стоит Анна → пересечение
  await page.fill("#mTime", "15:00");
  await page.check("#mRepeat");
  await page.check("#mPkg");
  await page.fill("#mPkgFrom", "1");
  await page.fill("#mPkgTotal", "4");
  assert.equal(await page.inputValue("#mCount"), "4");
  await page.click("#mCreate");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  assert.ok(dialogs.some((m) => /Пересекается/.test(m)), "предупреждение о пересечении");

  const docs = lessonDocs(await app.db());
  const created = docs.filter((d) => d.source === "app").sort((a, b) => a.startMs - b.startMs);
  assert.equal(docs.length, before + 4);
  assert.deepEqual(created.map((d) => d.title), ["Анна 6 класс 1/4", "Анна 6 класс 2/4", "Анна 6 класс 3/4", "Анна 6 класс 4/4"]);
  assert.deepEqual(created.map((d) => d.date), ["2026-09-29", "2026-10-06", "2026-10-13", "2026-10-20"]);
  assert.ok(created.every((d) => d.time === "15:00" && d.durationMin === 60 && d.status === "planned"));
  assert.equal(new Set(created.map((d) => d.recurrenceId)).size, 1);
  assert.equal(new Set(created.map((d) => d.packageId)).size, 1);
  assert.equal(created[0].studentId, "Анна, 6 класс");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("перенос с историей, отмена «это и следующие», возврат, удаление", async () => {
  const app = await openImported();
  const { page } = app;
  // Перенос: Тест 6/8 (пт 25.09 10:00) → сб 26.09 12:00
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 6/8" }).click();
  await page.waitForSelector("#modal #mMove");
  await page.fill("#mDate", "2026-09-26");
  await page.fill("#mTime", "12:00");
  await page.click("#mMove");
  await page.waitForFunction(() => /Перенесено/.test(document.querySelector("#mMsg").textContent));
  let db = await app.db();
  const old = db[`teacherSpaces/${T}/lessons/serA_20260925T070000Z`];
  assert.equal(old.status, "rescheduled");
  const moved = db[`teacherSpaces/${T}/lessons/${old.rescheduledTo}`];
  assert.equal(moved.status, "planned");
  assert.equal(moved.date, "2026-09-26");
  assert.equal(moved.time, "12:00");
  assert.equal(moved.title, "Тест 7 класс 6/8");
  assert.equal(moved.rescheduledFrom, "serA_20260925T070000Z");
  assert.equal(moved.recurrenceId, "serA");
  await page.click("#mClose");

  // Отмена «это и все следующие» с 7/8 (пн 28.09)
  await page.click(".fc-next-button");
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 7/8" }).click();
  await page.waitForSelector("#modal #mScope");
  await page.selectOption("#mScope", "following");
  await page.click("#mCancelLesson");
  await page.waitForFunction(() => /Отменено занятий: 2/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260928T070000Z`].status, "cancelled");
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260930T070000Z`].status, "cancelled");
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260914T070000Z`].status, "done", "прошлые не тронуты");

  // Вернуть только это
  await page.selectOption("#mScope", "one");
  await page.click("#mRestore");
  await page.waitForFunction(() => /снова в расписании/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260928T070000Z`].status, "planned");
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260930T070000Z`].status, "cancelled");

  // Удалить (одно)
  await page.click("#mDelete");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  db = await app.db();
  assert.equal(db[`teacherSpaces/${T}/lessons/serA_20260928T070000Z`], undefined);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("исправление серии: сдвиг «это и следующие» сохраняет номера пакета", async () => {
  const app = await openImported();
  const { page } = app;
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 5/8" }).click();
  await page.waitForSelector("#modal #mSave");
  await page.fill("#mTime", "11:30");
  await page.selectOption("#mScope", "following");
  await page.click("#mSave");
  await page.waitForFunction(() => /Сохранено для 4 занятий/.test(document.querySelector("#mMsg").textContent));
  const db = await app.db();
  const get = (id) => db[`teacherSpaces/${T}/lessons/${id}`];
  for (const [id, n] of [["serA_20260923T070000Z", 5], ["serA_20260925T070000Z", 6], ["serA_20260928T070000Z", 7], ["serA_20260930T070000Z", 8]]) {
    assert.equal(get(id).time, "11:30", id);
    assert.equal(get(id).title, `Тест 7 класс ${n}/8`);
  }
  assert.equal(get("serA_20260921T070000Z").time, "10:00", "предыдущие не сдвинуты");
  await app.close();
});

test("перетаскивание в календаре = перенос (после подтверждения)", async () => {
  const app = await openImported({ onDialog: (d) => /Перенести/.test(d.message()) });
  const { page } = app;
  const ev = page.locator("#fcRoot .fc-event", { hasText: "Борис 8 класс" }).last();
  await ev.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await ev.boundingBox();
  const slotH = (await page.locator(".fc-timegrid-slot-lane").first().boundingBox()).height;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + 8 + (i * slotH * 2) / 10); // +1 час = 2 слота по 30 мин
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await waitFor(async () => (await app.db())[`teacherSpaces/${T}/lessons/boris2`].status === "rescheduled", "перенос boris2");
  const db = await app.db();
  const moved = db[`teacherSpaces/${T}/lessons/${db[`teacherSpaces/${T}/lessons/boris2`].rescheduledTo}`];
  assert.equal(moved.date, "2026-09-24");
  assert.match(moved.time, /^19:/, "сдвинуто примерно на час вниз");
  assert.equal(moved.durationMin, 90);
  await app.close();
});

test("отметка «Провёл» из карточки занятия, отчёт, домашка через Cloudinary, .ics для календаря", async () => {
  const app = await openImported();
  const { page, calls } = app;
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 5/8" }).click();
  await page.waitForSelector("#modal #mMark");
  await page.click("#mMark");
  await page.waitForFunction(() => /проведено/.test(document.querySelector("#mMsg").textContent));
  await waitFor(async () => (await app.db())[`teacherSpaces/${T}/lessons/serA_20260923T070000Z`].status === "done", "status done");
  let db = await app.db();
  assert.equal(db[statePath].marks["serA_20260923T070000Z"].lockedRate, 2000);

  await page.fill("#mReport", "Прошли дроби. <b>не html</b>");
  await page.click("#mSaveReport");
  await page.waitForFunction(() => /Отчёт сохранён/.test(document.querySelector("#mMsg").textContent));

  await page.setInputFiles("#mHwFile", [
    { name: "дз1.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") },
    { name: "фото.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") },
  ]);
  await page.waitForFunction(() => /Загружено файлов: 2/.test(document.querySelector("#mMsg").textContent));
  assert.equal(calls.cloudinary.length, 2);
  assert.match(calls.cloudinary[0].url, /api\.cloudinary\.com\/v1_1\/xf4hvf5p\/auto\/upload/);
  db = await app.db();
  const l = db[`teacherSpaces/${T}/lessons/serA_20260923T070000Z`];
  assert.equal(l.report, "Прошли дроби. <b>не html</b>");
  assert.deepEqual(l.homework.map((h) => h.name), ["дз1.pdf", "фото.jpg"]);
  assert.equal(await page.$$eval("#modal .file-list a", (a) => a.length), 2);
  assert.equal(await page.$$eval("#modal b", (b) => b.filter((x) => x.textContent === "не html").length), 0, "отчёт не исполняется как HTML");

  // «Добавить в календарь» — скачивается .ics (без входа в Google)
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#mExport")]);
  assert.match(dl.suggestedFilename(), /^zanyatie-2026-09-23\.ics$/);
  const ics = fs.readFileSync(await dl.path(), "utf8");
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nDTSTART:20260923T070000Z\r\n/, "10:00 МСК = 07:00 UTC");
  assert.match(ics, /\r\nDTEND:20260923T080000Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Тест 7 класс 5\/8\r\n/);
  assert.match(ics, /DESCRIPTION:Отчёт: Прошли дроби\. <b>не html<\/b>/);
  assert.match(ics, /TRIGGER:-PT30M/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.ok(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75), "строки не длиннее 75 байт");
  await page.waitForFunction(() => /Файл события скачан/.test(document.querySelector("#mMsg").textContent));
  const uid1 = ics.match(/UID:(.*)/)[1];
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#mExport")]);
  const uid2 = fs.readFileSync(await dl2.path(), "utf8").match(/UID:(.*)/)[1];
  assert.notEqual(uid1, uid2, "повторное нажатие — новое событие");
  const db2 = await app.db();
  assert.equal(db2[`teacherSpaces/${T}/lessons/serA_20260923T070000Z`].exportedEventId, undefined);

  // Убрать файл
  await page.waitForSelector("[data-hw-remove]");
  await page.click('[data-hw-remove="0"]');
  await page.waitForFunction(() => /убран/.test(document.querySelector("#mMsg").textContent));
  db = await app.db();
  assert.deepEqual(db[`teacherSpaces/${T}/lessons/serA_20260923T070000Z`].homework.map((h) => h.name), ["фото.jpg"]);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("ошибка Cloudinary показывается понятным текстом", async () => {
  const app = await openImported({ cloudinaryFail: true });
  const { page } = app;
  await page.locator("#fcRoot .fc-event", { hasText: "Тест 7 класс 5/8" }).click();
  await page.waitForSelector('#modal [data-drop="mHwFile"]');
  await page.setInputFiles("#mHwFile", [{ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") }]);
  await page.waitForFunction(() => /Upload preset not found/.test(document.querySelector("#mMsg").textContent));
  await app.close();
});
