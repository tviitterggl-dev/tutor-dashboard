// × в правом верхнем углу любого окна (модалки) — просто закрыть, как «Закрыть»,
// клик по фону и Escape. Добавляется один раз в общей обёртке openModal.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, NOW, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";

async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
  throw new Error("Не дождались: " + what);
}
// × — один, в правом верхнем углу окна, с подписью для экранных дикторов
async function checkX(page) {
  const x = page.locator("#modal .modal-x");
  assert.equal(await x.count(), 1, "ровно один ×");
  assert.equal(await x.getAttribute("aria-label"), "Закрыть");
  const m = await page.locator("#modal").boundingBox(), b = await x.boundingBox();
  assert.ok(b.y - m.y < 24 && m.x + m.width - (b.x + b.width) < 24, "в правом верхнем углу");
  // заголовок окна не залезает под ×
  const h = page.locator("#modal h2").first();
  if (await h.count()) {
    // сам текст (не блок h2 целиком) заканчивается левее ×
    const right = await h.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return Math.max(...[...r.getClientRects()].map((c) => c.right)); });
    assert.ok(right <= b.x + 1, "заголовок не под ×");
    assert.equal(await h.evaluate((el) => getComputedStyle(el).paddingRight), "36px", "у заголовка место под ×");
  }
}

test("учитель: × закрывает окно занятия и окно создания, ничего не меняя; есть в каждом окне", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  const before = JSON.stringify(await app.db());
  // окно занятия
  await page.locator("#lessonsList .lesson").first().click();
  await page.waitForSelector("#modalBack", { state: "visible" });
  await checkX(page);
  await page.click("#modal .modal-x");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  // окно «+ Занятие» (другой шаблон — × тот же)
  await page.click('.tab[data-tab="calendar"]');
  await page.click("#fcAddBtn");
  await page.waitForSelector("#modal #mStudent");
  await checkX(page);
  await page.click("#modal .modal-x");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  // повторное открытие — × снова один (не накапливается)
  await page.click("#fcAddBtn");
  await page.waitForSelector("#modal #mStudent");
  assert.equal(await page.locator("#modal .modal-x").count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#modalBack", { state: "hidden" });
  assert.equal(JSON.stringify(await app.db()), before, "× только закрывает — в базе ничего не меняется");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("кабинет семьи: × закрывает окно занятия (компьютер и телефон)", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  const app = await openApp({ seed });
  await waitFor(async () => (await app.db())[`parentAccess/${PK}`]?.channel, "витрина");
  const base = app.page.url().replace(/\/index\.html.*$/, "");
  await app.page.goto(base + "/cabinet.html"); // учитель «не в сети»
  for (const viewport of [null, { width: 390, height: 844 }]) {
    const cab = await app.context.newPage();
    if (viewport) await cab.setViewportSize(viewport);
    const errors = [];
    cab.on("pageerror", (e) => errors.push(String(e)));
    await cab.clock.setFixedTime(new Date(NOW));
    await cab.goto(base + "/cabinet.html#p=" + PK);
    await cab.waitForSelector("#pane-lessons .lesson");
    const before = JSON.stringify(await app.db());
    await cab.locator("#pane-lessons .lesson", { hasText: "7/8" }).first().click();
    await cab.waitForSelector("#modalBack", { state: "visible" });
    await checkX(cab);
    await cab.click("#modal .modal-x");
    await cab.waitForSelector("#modalBack", { state: "hidden" });
    assert.equal(JSON.stringify(await app.db()), before, "в базе ничего не меняется");
    assert.deepEqual(errors, []);
    await cab.close();
  }
  await app.close();
});
