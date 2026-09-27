// Кабинет учителя: «месяц» в календаре на телефоне; верхние вкладки —
// «облачко» как у семьи (прилипают сверху, фон карточки, тень), плашки
// над ними не наезжают на вкладки, полоса вкладок листается пальцем.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown } from "./harness.mjs";

after(shutdown);
const PHONE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true };

test("календарь учителя на телефоне: кнопка «месяц» открывает месяц", async () => {
  const app = await openApp(PHONE);
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-view");
  const btn = page.locator("#fcRoot .fc-dayGridMonth-button");
  assert.equal(await btn.textContent(), "месяц");
  await btn.click();
  await page.waitForSelector("#fcRoot .fc-dayGridMonth-view");
  assert.ok(await page.locator("#fcRoot .fc-daygrid-event").count() > 0, "занятия видны в месяце");
  // текст на тёмной плашке занятия — светлый (как в неделе), а не тёмный по умолчанию
  const col = await page.$eval("#fcRoot .fc-daygrid-event.st-planned .fc-event-time", (el) => getComputedStyle(el).color);
  const onEvent = await page.evaluate(() => { const d = document.createElement("div"); d.style.color = "var(--on-event)"; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; });
  assert.equal(col, onEvent, "время на плашке читается");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "без горизонтальной прокрутки");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("вкладки учителя — «облачко»: прилипают сверху, фон карточки, тень; плашки не наезжают", async () => {
  const app = await openApp(PHONE);
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const st = await page.$eval(".tabs", (el) => { const c = getComputedStyle(el); return { pos: c.position, top: c.top, shadow: c.boxShadow, bg: c.backgroundColor }; });
  const cardBg = await page.evaluate(() => { const d = document.createElement("div"); d.style.background = "var(--card-bg)"; document.body.appendChild(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; });
  assert.equal(st.pos, "sticky");
  assert.equal(st.top, "8px");
  assert.notEqual(st.shadow, "none");
  assert.equal(st.bg, cardBg, "фон — как у карточки");
  // плашка «пакет заканчивается» сверху: над вкладками, не наезжает
  await page.evaluate(() => { const a = document.querySelector("#pkgAlert"); a.style.display = "block"; a.textContent = "Пакет заканчивается: Тест, 7 класс (осталось 1)"; });
  const r = await page.evaluate(() => ({ a: document.querySelector("#pkgAlert").getBoundingClientRect().bottom, t: document.querySelector(".tabs").getBoundingClientRect().top }));
  assert.ok(r.a <= r.t + 0.5, `плашка выше вкладок (${r.a} ≤ ${r.t})`);
  // прокрутили вниз — вкладки остаются у верхнего края, плашка уехала вверх
  await page.click('.tab[data-tab="calendar"]');
  await page.waitForSelector("#fcRoot .fc-view");
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(100);
  const s = await page.evaluate(() => ({ t: document.querySelector(".tabs").getBoundingClientRect().top, a: document.querySelector("#pkgAlert").getBoundingClientRect().bottom }));
  assert.ok(Math.abs(s.t - 8) < 1, `вкладки прилипли сверху (top=${s.t})`);
  assert.ok(s.a <= s.t, "плашка не под вкладками");
  // окно поверх вкладок
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click("#fcAddBtn");
  await page.waitForSelector("#modal #mStudent");
  const hit = await page.evaluate(() => { const r = document.querySelector(".tabs").getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!el.closest("#modalBack"); });
  assert.equal(hit, true, "окно занятия перекрывает вкладки");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("полоса вкладок на телефоне по-прежнему листается пальцем", async () => {
  const app = await openApp(PHONE);
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const can = await page.$eval(".tabs", (el) => el.scrollWidth > el.clientWidth);
  assert.equal(can, true, "вкладок больше, чем помещается");
  await page.$eval(".tabs", (el) => { el.scrollLeft = 200; });
  assert.ok(await page.$eval(".tabs", (el) => el.scrollLeft) > 0);
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector("#view-settings", { state: "visible" });
  await app.close();
});

// Вид «месяц» на компьютере, светлая и тёмная тема: текст на заливке занятия
// (запланировано, проведено, группа) — цвет --on-event, отменённое — серое.
test("месяц на компьютере: текст занятий читается в светлой и тёмной теме (обычные, проведённые, группа, отмена)", async () => {
  const { defaultSeed, lessonDoc, T } = await import("./harness.mjs");
  for (const colorScheme of ["light", "dark"]) {
    const seed = defaultSeed();
    const L = (id) => `teacherSpaces/${T}/lessons/${id}`;
    const iso = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 19) + "+03:00";
    const s = Date.parse("2026-09-25T17:00:00+03:00");
    seed[`teacherSpaces/${T}/state/main`].groups = { g: { name: "Мини", members: ["Анна, 6 класс", "Борис, 8 класс"] } };
    for (const [id, t] of [["ga", "Анна 6 класс"], ["gb", "Борис 8 класс"]]) seed[L(id)] = Object.assign(lessonDoc({ id, summary: t, start: { dateTime: iso(s) }, end: { dateTime: iso(s + 3600000) } }), { groupId: "g", groupOcc: "o1", source: "app" });
    seed[L("anna2")].status = "cancelled";
    const app = await openApp({ seed, viewport: { width: 1280, height: 900 }, colorScheme });
    const { page } = app;
    await page.waitForSelector("#lessonsList .lesson");
    await page.click('.tab[data-tab="calendar"]');
    await page.waitForSelector("#fcRoot .fc-view");
    await page.click("#fcRoot .fc-dayGridMonth-button");
    await page.waitForSelector("#fcRoot .fc-dayGridMonth-view .st-group");
    const probe = () => page.evaluate(() => {
      const c = (v) => { const d = document.createElement("div"); d.style.color = v; document.body.appendChild(d); const r = getComputedStyle(d).color; d.remove(); return r; };
      const col = (sel) => { const e = document.querySelector(`#fcRoot .fc-daygrid-event${sel} .fc-event-title`); return e && getComputedStyle(e).color; };
      return { on: c("var(--on-event)"), muted: c("var(--muted)"), planned: col(".st-planned:not(.st-group)"), done: col(".st-done"), group: col(".st-group"), cancelled: col(".st-cancelled") };
    });
    const r = await probe();
    assert.deepEqual([r.planned, r.done, r.group], [r.on, r.on, r.on], `${colorScheme}: на заливке — светлый текст`);
    assert.equal(r.cancelled, r.muted, `${colorScheme}: отмена — серым`);
    assert.deepEqual(app.errors, []);
    await app.close();
  }
});
