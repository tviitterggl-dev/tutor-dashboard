// Вход учителя (Firebase Authentication), перенос данных со старого ключа,
// и то, что от Google-входа ничего не осталось.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp, shutdown, T, TEACHER_EMAIL, TEACHER_PASSWORD, defaultSeed } from "./harness.mjs";

after(shutdown);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const statePath = `teacherSpaces/${T}/state/main`;
const OLD_KEY = "79ZneRF_TEST_OLD_KEY_1234567890";
const NEW_UID = "newUid0123456789abcdefghij";

// Старые данные лежат по пути со старым ключом (как было до перехода на вход).
function legacySeed() {
  const cur = defaultSeed();
  const out = {};
  for (const [p, d] of Object.entries(cur)) out[p.replace(`teacherSpaces/${T}/`, `teacherSpaces/${OLD_KEY}/`)] = d;
  out[`teacherSpaces/${OLD_KEY}/accessKeys/parent_key_old_000000000000001`] = { role: "parent", studentId: "Тест, 7 класс", createdAt: 1, active: true };
  out[`teacherSpaces/${OLD_KEY}/requests/req1`] = { status: "approved", studentId: "Тест, 7 класс", decidedAt: 1 };
  return out;
}

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("Не дождались: " + what);
}
const msgIs = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#authMsg").textContent), re.source);

async function signUp(page, email = "me@example.org", pw = "long-password-1") {
  await page.waitForSelector("#authShowSignUp");
  await page.click("#authShowSignUp");
  await page.fill("#suEmail", email);
  await page.fill("#suPass", pw);
  await page.fill("#suPass2", pw);
  await page.click("#authSignUpBtn");
}

test("вход по email и паролю; неверный пароль не пускает", async () => {
  const app = await openApp({ signedIn: false });
  const { page } = app;
  await page.waitForSelector("#authSignIn", { state: "visible" });
  assert.equal(await page.isVisible("#appRoot"), false);
  await page.fill("#authEmail", TEACHER_EMAIL);
  await page.fill("#authPass", "wrong-password");
  await page.click("#authSignInBtn");
  await msgIs(page, /Неверный email или пароль/);
  await page.fill("#authPass", TEACHER_PASSWORD);
  await page.click("#authSignInBtn");
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.waitForSelector("#lessonsList .lesson");
  assert.match(await page.textContent("#userBadge"), /teacher@example\.org/);
  await page.reload();
  await page.waitForSelector("#lessonsList .lesson"); // вход сохраняется
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.calls.unexpected, [], "никаких запросов к Google и прочим внешним сервисам");
  await app.close();
});

test("«Забыли пароль?» отправляет письмо; без email — подсказка", async () => {
  const app = await openApp({ signedIn: false });
  const { page } = app;
  await page.waitForSelector("#authSignIn", { state: "visible" });
  await page.click("#authForgot");
  await msgIs(page, /Впиши email/);
  await page.fill("#authEmail", TEACHER_EMAIL);
  await page.click("#authForgot");
  await msgIs(page, /Письмо со ссылкой для нового пароля отправлено на teacher@example\.org/);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.__fakeResetEmails)), [TEACHER_EMAIL]);
  await app.close();
});

test("выход: снова экран входа, и после перезагрузки тоже", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.click("#logoutBtn");
  await page.waitForSelector("#authSignIn", { state: "visible" });
  await page.reload();
  await page.waitForSelector("#authSignIn", { state: "visible" });
  assert.equal(await page.isVisible("#appRoot"), false);
  await app.close();
});

test("первый вход: проверка пароля, создание учётной записи и автоматический перенос со старого ключа", async () => {
  const app = await openApp({
    signedIn: false, users: {}, seed: legacySeed(), rules: "old", nextUid: NEW_UID,
    localStorage: { teacherKey: OLD_KEY },
  });
  const { page } = app;
  await page.waitForSelector("#authSignIn", { state: "visible" });
  await page.click("#authShowSignUp");
  await page.fill("#suEmail", "me@example.org");
  await page.fill("#suPass", "short");
  await page.fill("#suPass2", "short");
  await page.click("#authSignUpBtn");
  await msgIs(page, /не короче 8/);
  await page.fill("#suPass", "long-password-1");
  await page.fill("#suPass2", "другой-пароль");
  await page.click("#authSignUpBtn");
  await msgIs(page, /не совпадают/);
  await page.fill("#suPass2", "long-password-1");
  await page.click("#authSignUpBtn");
  await page.waitForSelector("#appRoot", { state: "visible", timeout: 10000 });
  await page.waitForSelector("#lessonsList .lesson");

  const db = await app.db();
  const moved = (p) => db[`teacherSpaces/${NEW_UID}/${p}`];
  assert.equal(Object.keys(db).filter((p) => p.startsWith(`teacherSpaces/${NEW_UID}/lessons/`)).length, 17);
  assert.equal(moved("state/main").marks.anna3.overrideAmount, 1400, "отметки перенесены");
  assert.equal(moved("state/main").studentProfiles["Тест, 7 класс"].rate, 2000, "профили и ставки перенесены");
  assert.ok(moved("state/main").migratedAt);
  assert.ok(moved("accessKeys/parent_key_old_000000000000001"), "ключи доступа родителей перенесены");
  assert.ok(moved("requests/req1"), "журнал заявок перенесён");
  assert.ok(db[`teacherSpaces/${OLD_KEY}/state/main`], "старые данные не удалены (резервная копия)");
  assert.equal(await page.evaluate(() => localStorage.getItem("teacherKey")), null, "старый ключ забыт");
  assert.deepEqual(app.errors, []);
  await app.close();
});

test("первый вход без старого ключа на устройстве: вставить старую ссылку → перенос", async () => {
  const app = await openApp({ signedIn: false, users: {}, seed: legacySeed(), rules: "old", nextUid: NEW_UID });
  const { page } = app;
  await signUp(page);
  await page.waitForSelector("#authMigrate", { state: "visible" });
  await page.fill("#migrateKey", "не ключ");
  await page.click("#authMigrateForm button[type=submit]");
  await msgIs(page, /не похоже/);
  await page.fill("#migrateKey", "https://tviitterggl-dev.github.io/tutor-dashboard/#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await page.click("#authMigrateForm button[type=submit]");
  await msgIs(page, /данных нет/);
  await page.fill("#migrateKey", `https://tviitterggl-dev.github.io/tutor-dashboard/#t=${OLD_KEY}`);
  await page.click("#authMigrateForm button[type=submit]");
  await page.waitForSelector("#appRoot", { state: "visible", timeout: 10000 });
  await page.waitForSelector("#lessonsList .lesson");
  await app.close();
});

test("если новые правила задеплоены раньше переноса — понятное сообщение", async () => {
  const app = await openApp({
    signedIn: false, users: {}, seed: legacySeed(), rules: "new", nextUid: NEW_UID,
    localStorage: { teacherKey: OLD_KEY },
  });
  await signUp(app.page);
  await msgIs(app.page, /закрыты новыми правилами/);
  await app.close();
});

test("«Начать с пустого дашборда» создаёт пустое пространство", async () => {
  const app = await openApp({ signedIn: false, users: {}, seed: {}, nextUid: NEW_UID });
  const { page } = app;
  await signUp(page);
  await page.waitForSelector("#authStartEmpty", { state: "visible" });
  await page.click("#authStartEmpty");
  await page.waitForSelector("#appRoot", { state: "visible" });
  await page.waitForFunction(() => /Занятий нет/.test(document.querySelector("#lessonsList").textContent));
  assert.ok((await app.db())[`teacherSpaces/${NEW_UID}/state/main`]);
  await app.close();
});

test("email уже занят; вход по email не включён в Firebase — понятные сообщения", async () => {
  let app = await openApp({ signedIn: false });
  await signUp(app.page, TEACHER_EMAIL);
  await msgIs(app.page, /уже есть/);
  await app.close();

  app = await openApp({ signedIn: false, authDisabled: true });
  const { page } = app;
  await page.fill("#authEmail", TEACHER_EMAIL);
  await page.fill("#authPass", TEACHER_PASSWORD);
  await page.click("#authSignInBtn");
  await msgIs(page, /ещё не включён в Firebase/);
  await app.close();
});

test("отметки пишутся точечно: второе устройство не затирается; ставка из профиля", async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector("#lessonsList .lesson");
  await page.evaluate((sp) => {
    const db = JSON.parse(localStorage.__fakeDb);
    db[sp].marks.other_device = { marked: true, overrideAmount: 777, lockedRate: null, updatedAt: 5 };
    localStorage.__fakeDb = JSON.stringify(db);
  }, statePath);
  const row = page.locator(".lesson", { hasText: "Борис, 8 класс" }).first();
  await row.locator(".mark-btn").click();
  await waitFor(async () => (await app.db())[statePath].marks.boris2?.marked === true, "отметка boris2");
  const st = (await app.db())[statePath];
  assert.equal(st.marks.boris2.lockedRate, 1800, "ставка — из профиля ученика");
  assert.equal(st.marks.other_device.overrideAmount, 777);
  await app.close();
});

test("в коде нет Google-входа, чтения календаря и таблицы", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const bad of ["accounts.google.com", "gsi/client", "oauth2", "googleapis.com/calendar", "sheets.googleapis", "CLIENT_ID", "calendar.readonly", "LESSONS_CALENDAR_ID"]) {
    assert.equal(src.includes(bad), false, bad);
  }
});
