// Название «Тьютор Онлайн» у кабинета учителя; вкладки не наезжают друг на друга.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown } from "./harness.mjs";

after(shutdown);

test("название «Тьютор Онлайн» у кабинета учителя; вкладки не наезжают друг на друга на любой ширине", async () => {
  for (const width of [360, 430, 640, 700, 820, 1100]) {
    const app = await openApp({ viewport: { width, height: 800 } });
    const { page } = app;
    await page.waitForSelector("#lessonsList .lesson");
    if (width === 360) {
      assert.equal(await page.title(), "Тьютор Онлайн");
      assert.equal(await page.textContent("h1"), "Тьютор Онлайн");
      assert.equal(await page.getAttribute('meta[name="application-name"]', "content"), "Тьютор Онлайн");
    }
    const over = await page.$$eval(".tabs .tab", (ts) => ts.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent));
    assert.deepEqual(over, [], `ширина ${width}`);
    // соседние вкладки не перекрываются
    const boxes = await page.$$eval(".tabs .tab", (ts) => ts.map((t) => { const r = t.getBoundingClientRect(); return [r.left, r.right]; }));
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1] - 0.5, `ширина ${width}: вкладка ${i}`);
    await app.close();
  }
});
