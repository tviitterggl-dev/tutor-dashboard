import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, defaultLessonsFixture } from "./harness.mjs";

after(shutdown);

const lessonsPath = (id) => `teacherSpaces/${T}/lessons/${id}`;
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

test("без ключа учителя — экран ввода ключа; неверный ключ не принимается", async () => {
  const app = await openApp({ teacherKey: null });
  const { page } = app;
  await page.waitForSelector("#keyCard", { state: "visible" });
  assert.equal(await page.isVisible("#appRoot"), false);
  await page.fill("#teacherKeyInput", "short");
  await page.click("#teacherKeySaveBtn");
  await page.waitForFunction(() => /не похоже на ключ/.test(document.querySelector("#teacherKeyMsg").textContent));
  await page.fill("#teacherKeyInput", "unknown_key_xxxxxxxxxxxxxxxxxxxxxx");
  await page.click("#teacherKeySaveBtn");
  await page.waitForFunction(() => /ничего не найдено/.test(document.querySelector("#teacherKeyMsg").textContent));
  // вставка целой ссылки тоже работает
  await page.fill("#teacherKeyInput", `https://example.org/tutor-dashboard/#t=${T}`);
  await page.click("#teacherKeySaveBtn");
  await page.waitForSelector("#appRoot", { state: "visible" });
  assert.equal(await page.evaluate(() => localStorage.getItem("teacherKey")), T);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("секретная ссылка #t=… сохраняет ключ и убирает его из адресной строки", async () => {
  const app = await openApp({ teacherKey: null, hash: `#t=${T}` });
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  assert.equal(await page.evaluate(() => localStorage.getItem("teacherKey")), T);
  assert.equal(new URL(page.url()).hash, "");
  await app.close();
});

test("старый ключ, по которому нет данных, не создаёт пустое пространство", async () => {
  const app = await openApp({ teacherKey: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" });
  const { page } = app;
  await page.waitForSelector("#keyCard", { state: "visible" });
  assert.match(await page.textContent("#keyCardText"), /данных нет/);
  const db = await app.db();
  assert.equal(Object.keys(db).some((p) => p.includes("zzzz")), false);
  await app.close();
});

test("до обновления правил: занятия из Google Календаря, отметки пишутся точечно, импорта нет", async () => {
  const app = await openApp({ deny: ["/lessons"] });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const names = await page.$$eval("#lessonsList .lesson-name", (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.some((n) => n.startsWith("Тест, 7 класс")), names.join("|"));
  assert.ok(names.some((n) => n.startsWith("Борис, 8 класс")));
  assert.equal(await page.$$eval(".edit-link", (e) => e.length), 0, "в режиме календаря редактировать нельзя");

  // Другое устройство тем временем поставило свою отметку
  await page.evaluate((sp) => {
    const db = JSON.parse(localStorage.__fakeDb);
    db[sp].marks.other_device = { marked: true, overrideAmount: 777, lockedRate: null, updatedAt: 5 };
    localStorage.__fakeDb = JSON.stringify(db);
  }, statePath);

  const row = page.locator(".lesson", { hasText: "Борис, 8 класс" }).first();
  await row.locator(".mark-btn").click();
  await waitFor(async () => (await app.db())[statePath].marks.boris2?.marked === true, "отметка boris2");
  const st = (await app.db())[statePath];
  assert.equal(st.marks.boris2.lockedRate, 1800);
  assert.equal(st.marks.other_device.overrideAmount, 777, "отметка другого устройства не затёрта");
  assert.equal(st.lessonsSource, undefined);

  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#sourceCard .banner");
  assert.match(await page.textContent("#sourceCard"), /обновятся правила/);
  await page.waitForSelector("#fcRoot .fc-event");
  assert.deepEqual(app.errors.filter((e) => !/permissions/i.test(e)), []);
  await app.close();
});

test("после обновления правил: автоимпорт из календаря, отметки и пакеты сохраняются", async () => {
  const app = await openApp();
  const { page } = app;
  await waitFor(async () => (await app.db())[statePath].lessonsSource === "firestore", "импорт");
  const db = await app.db();
  const docs = lessonDocs(db);
  assert.equal(docs.length, defaultLessonsFixture().length);
  const pkg1 = docs.find((d) => d.id === "serA_20260914T070000Z");
  assert.equal(pkg1.status, "done", "отмеченное занятие импортировано как проведённое");
  assert.equal(pkg1.recurrenceId, "serA");
  assert.equal(pkg1.studentId, "Тест, 7 класс");
  assert.equal(pkg1.date, "2026-09-14");
  assert.equal(pkg1.time, "10:00");
  assert.ok(pkg1.packageId);
  const pkg8 = docs.find((d) => d.id === "serA_20260930T070000Z");
  assert.equal(pkg8.packageId, pkg1.packageId, "один пакет — один packageId");
  const trial = docs.find((d) => d.id === "trial1");
  assert.equal(trial.studentId, null);
  assert.equal(trial.durationMin, 30);
  assert.equal(db[statePath].lessonsImportAdded, docs.length);

  // Повторный импорт ничего не дублирует и не трогает изменённые занятия
  await page.evaluate((p) => {
    const d = JSON.parse(localStorage.__fakeDb);
    d[p].report = "мой отчёт";
    localStorage.__fakeDb = JSON.stringify(d);
  }, lessonsPath("anna1"));
  await page.click('.tab[data-tab="calendar"]');
  await page.click('[data-src-action="reimport"]');
  await page.waitForFunction(() => /добавлено новых — 0/.test(document.querySelector("#sourceCard").textContent));
  const db2 = await app.db();
  assert.equal(lessonDocs(db2).length, docs.length);
  assert.equal(db2[lessonsPath("anna1")].report, "мой отчёт");

  // Вкладка «Занятия» теперь читает из базы и умеет открывать редактор
  await page.click('.tab[data-tab="lessons"]');
  await page.waitForSelector("#lessonsList .edit-link");
  assert.match(await page.textContent("#calBadge"), /в дашборде/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("итоги и заработок совпадают в обоих режимах", async () => {
  async function totals(opts) {
    const app = await openApp(opts);
    const { page } = app;
    if (!opts.deny) await waitFor(async () => (await app.db())[statePath].lessonsSource === "firestore", "импорт");
    await page.click('.tab[data-tab="summary"]');
    await page.click('.subtab[data-summode="month"]');
    await page.waitForFunction(() => !/Загрузка/.test(document.querySelector("#studentsSummaryList").textContent));
    const r = {
      sum: await page.textContent("#statSum"),
      count: await page.textContent("#statCount"),
      forecast: await page.textContent("#sumForecastSum"),
    };
    await app.close();
    return r;
  }
  const a = await totals({ deny: ["/lessons"] });
  const b = await totals({});
  assert.deepEqual(a, b);
  assert.equal(a.count, "3");
});
