// Шаблоны сообщений (добавить/изменить/удалить/выбрать при отправке) и
// подписка самого учителя на пуши об оплате, пояснениях и ДЗ.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, shutdown, T, defaultSeed } from "./harness.mjs";

after(shutdown);
const PK = "parent_key_test_student_0000000001";
const statePath = `teacherSpaces/${T}/state/main`;
const tpls = async (app) => (await app.db())[statePath].msgTemplates || {};
async function waitFor(fn, what, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("Не дождались: " + what);
}

test("шаблоны: три примера при первом открытии; добавить, изменить, удалить; выбрать при «Отправить сейчас» и в конструкторе; «Сохранить как шаблон»", async () => {
  const seed = defaultSeed();
  seed[`teacherSpaces/${T}/accessKeys/${PK}`] = { role: "parent", studentId: "Тест, 7 класс", label: "", createdAt: 1, active: true, revokedAt: null };
  const prompts = [];
  const app = await openApp({ seed, onDialog: (d) => { prompts.push(d.message()); return d.type() === "prompt" ? "Спасибо за оплату" : true; } });
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="settings"]'); // управление шаблонами — в «Настройках»
  await waitFor(async () => Object.keys(await tpls(app)).length === 3, "примеры шаблонов");
  const names = Object.values(await tpls(app)).map((t) => t.name).sort();
  assert.deepEqual(names, ["Напоминание о занятии", "Нет занятия на этой неделе", "Поздравление"]);
  await page.waitForFunction(() => document.querySelectorAll("#tplList [data-tpl]").length === 3);

  // добавить
  await page.click("#tplAdd");
  await page.fill("#tplName", "Перенос");
  await page.fill("#tplTitle", "Важно");
  await page.fill("#tplText", "Занятие переносится, напишу новое время.");
  await page.click("#tplSave");
  await page.waitForFunction(() => /Шаблон сохранён/.test(document.querySelector("#tplMsg").textContent));
  let all = await tpls(app);
  const [pid] = Object.entries(all).find(([, t]) => t.name === "Перенос");
  assert.deepEqual([all[pid].title, all[pid].text], ["Важно", "Занятие переносится, напишу новое время."]);
  // изменить
  await page.locator(`#tplList [data-tpl="${pid}"] [data-tpl-edit]`).click();
  assert.equal(await page.inputValue("#tplText"), "Занятие переносится, напишу новое время.");
  await page.fill("#tplText", "Занятие переносится на завтра.");
  await page.click("#tplSave");
  await page.waitForFunction(() => /Шаблон изменён/.test(document.querySelector("#tplMsg").textContent));
  assert.equal((await tpls(app))[pid].text, "Занятие переносится на завтра.");
  assert.equal(Object.keys(await tpls(app)).length, 4, "изменение не плодит копий");

  // выбрать в «Отправить сейчас» → заголовок и текст подставились → отправить
  await page.click('.tab[data-tab="notify"]');
  await page.selectOption("#nwTo", { label: "Тест, 7 класс — родители" });
  await page.selectOption("#nwTpl", pid);
  assert.equal(await page.inputValue("#nwHead"), "Важно");
  assert.equal(await page.inputValue("#nwText"), "Занятие переносится на завтра.");
  await page.click("#nwSend");
  await page.waitForFunction(() => /Отправлено/.test(document.querySelector("#nwMsg").textContent));
  const sent = Object.entries(await app.db()).filter(([p]) => p.startsWith(`teacherSpaces/${T}/notifications/`)).map(([, d]) => d);
  assert.deepEqual(sent.map((n) => [n.title, n.text]), [["Важно", "Занятие переносится на завтра."]]);
  // в конструкторе — тот же список
  const opts = await page.$$eval("#nfTpl option", (o) => o.map((x) => x.textContent));
  assert.ok(opts.includes("Перенос") && opts.includes("Поздравление"), JSON.stringify(opts));
  await page.selectOption("#nfTpl", { label: "Поздравление" });
  assert.match(await page.inputValue("#nfText"), /поздравляю/i);

  // «Сохранить как шаблон» из формы
  await page.fill("#nwHead", "Спасибо!");
  await page.fill("#nwText", "Оплату получили, спасибо!");
  await page.click('[data-tpl-save="nw"]');
  await page.waitForFunction(() => /Шаблон сохранён/.test(document.querySelector("#nwMsg").textContent));
  all = await tpls(app);
  assert.ok(Object.values(all).some((t) => t.name === "Спасибо за оплату" && t.title === "Спасибо!" && t.text === "Оплату получили, спасибо!"));

  // удалить
  await page.click('.tab[data-tab="settings"]');
  await page.locator(`#tplList [data-tpl="${pid}"] [data-tpl-delete]`).click();
  await page.waitForFunction(() => /Шаблон удалён/.test(document.querySelector("#tplMsg").textContent));
  assert.equal((await tpls(app))[pid], undefined);
  assert.equal(await page.locator(`#nwTpl option[value="${pid}"]`).count(), 0);

  // на другом устройстве (перезагрузка) — те же шаблоны, примеры не добавляются повторно
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="settings"]');
  await page.waitForFunction(() => document.querySelectorAll("#tplList [data-tpl]").length === 4);
  assert.equal(Object.keys(await tpls(app)).length, 4);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("пуши учителю: «Включить на этом устройстве» — токен в своём пространстве; галочки сохраняются; «Выключить» убирает", async () => {
  const app = await openApp({ vapidKey: "BTestPublicVapidKey_for_tests_only_0123456789", serviceWorkers: "allow", persistent: { channel: "chromium" } });
  const { page } = app;
  const base = page.url().replace(/\/index\.html.*$/, "");
  await app.context.grantPermissions(["notifications"], { origin: base });
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="settings"]'); // «Уведомления мне» — в «Настройках»
  await page.waitForSelector("#tpOnBtn");
  await page.click("#tpOnBtn");
  await page.waitForFunction(() => /Уведомления об оплате/.test(document.querySelector("#tpMsg").textContent), null, { timeout: 10000 });
  const devs = (await app.db())[statePath].teacherDevices;
  assert.equal(Object.keys(devs).length, 1);
  const dev = Object.values(devs)[0];
  assert.match(dev.token, /^fake-fcm-token-/);
  assert.ok(dev.createdAt > 0);
  assert.match(await page.innerText("#tpBody"), /Приходят на это устройство/);
  // токен учителя — не в каналах учеников
  assert.ok(!Object.entries(await app.db()).some(([p, d]) => p.startsWith("channels/") && d.token === dev.token));
  // галочка «ДЗ» выключена
  await page.uncheck('[data-tp="homework"]');
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector("#tpMsg").textContent));
  assert.deepEqual((await app.db())[statePath].teacherPush, { paid: true, note: true, homework: false });
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson");
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector("#tpOff");
  assert.equal(await page.isChecked('[data-tp="homework"]'), false);
  assert.equal(await page.isChecked('[data-tp="paid"]'), true);
  await page.click("#tpOff");
  await page.waitForFunction(() => /выключены/.test(document.querySelector("#tpMsg").textContent));
  assert.deepEqual((await app.db())[statePath].teacherDevices, {});
  await app.close();
});
