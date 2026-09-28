// Кабинет учителя — вход (Firebase Authentication): панели входа,
// регистрации и восстановления пароля, перенос данных со старого ключа
// (#t=…) на учётную запись, выход и сброс пароля из «Настроек».
// Сама обвязка Firebase — window.TutorAuth в модуле index.html.

// ---------- ВХОД (Firebase Authentication) ----------

function authPanel(which) {
  $("authCard").style.display = "block";
  $("appRoot").style.display = "none";
  ["authSignIn", "authSignUp", "authMigrate"].forEach(id => { $(id).style.display = id === which ? "block" : "none"; });
}
function authMsg(text, kind) {
  $("authMsg").textContent = text || "";
  $("authMsg").className = "msg" + (kind ? " " + kind : "");
}
function showApp() {
  $("authCard").style.display = "none";
  $("appRoot").style.display = "block";
}

const AUTH_ERRORS = {
  "auth/invalid-email": "Похоже, в email опечатка.",
  "auth/invalid-credential": "Неверный email или пароль.",
  "auth/wrong-password": "Неверный email или пароль.",
  "auth/user-not-found": "Неверный email или пароль.",
  "auth/email-already-in-use": "Учётная запись с этим email уже есть — просто войди.",
  "auth/weak-password": "Слишком простой пароль (нужно хотя бы 8 символов).",
  "auth/too-many-requests": "Слишком много попыток. Подожди немного или восстанови пароль.",
  "auth/network-request-failed": "Нет связи с сервером — проверь интернет.",
  "auth/operation-not-allowed": "Вход по email ещё не включён в Firebase (Authentication → Sign-in method → Email/Password).",
  "auth/configuration-not-found": "Вход по email ещё не включён в Firebase (Authentication → Get started → Email/Password).",
};
const authErrorText = (e) => AUTH_ERRORS[e && e.code] || "Не получилось: " + ((e && (e.code || e.message)) || "ошибка");

function authReady() {
  if (window.TutorAuth && window.TutorAuth.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    window.addEventListener("tutor-auth", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 15000);
  });
}

$("authSignInForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg("Вхожу…");
  try {
    await window.TutorAuth.signIn($("authEmail").value.trim(), $("authPass").value);
    authMsg("");
  } catch (err) {
    authMsg(authErrorText(err), "err");
  }
});
$("authSignUpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("suEmail").value.trim();
  const pw = $("suPass").value;
  if (pw.length < 8) { authMsg("Пароль — не короче 8 символов.", "err"); return; }
  if (pw !== $("suPass2").value) { authMsg("Пароли не совпадают.", "err"); return; }
  authMsg("Создаю учётную запись…");
  try {
    await window.TutorAuth.signUp(email, pw);
    authMsg("");
  } catch (err) {
    authMsg(authErrorText(err), "err");
  }
});
$("authForgot").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  if (!email) { authMsg("Впиши email в поле выше — пришлём на него ссылку для нового пароля.", "err"); return; }
  try {
    await window.TutorAuth.resetPassword(email);
    authMsg("Письмо со ссылкой для нового пароля отправлено на " + email + " (проверь и «Спам»).", "ok");
  } catch (err) {
    authMsg(authErrorText(err), "err");
  }
});
$("authShowSignUp").addEventListener("click", () => { authMsg(""); authPanel("authSignUp"); });
$("authShowSignIn").addEventListener("click", () => { authMsg(""); authPanel("authSignIn"); });

// Вошли, а данных в учётной записи ещё нет → перенос со старого ключа.
async function runMigration(oldKey, fromDevice) {
  const uid = window.TutorAuth.user.uid;
  authPanel("authMigrate");
  authMsg("Переношу данные… не закрывай страницу.");
  try {
    const c = await window.TutorAuth.migrate(oldKey, uid);
    authMsg(`Готово: перенесено занятий — ${c.lessons}, доступов — ${c.accessKeys}, заявок — ${c.requests}.`, "ok");
    setTimeout(() => startApp(), 800);
  } catch (err) {
    console.error("Перенос не удался", err);
    if (err.code === "legacy-empty" && fromDevice) {
      // Ключ, сохранённый на устройстве, устарел (данные переехали) —
      // забываем его и просим вставить актуальную ссылку.
      try { localStorage.removeItem("teacherKey"); } catch (e) { /* ничего */ }
      window.TutorAuth.legacyKey = null;
      authMsg("Сохранённая на этом устройстве старая ссылка устарела. Вставь актуальную ссылку для переноса.", "err");
      return;
    }
    authMsg(err.code === "legacy-empty"
      ? "По этой ссылке данных нет — проверь, что она скопирована целиком."
      : isPermissionDenied(err)
        ? "Старые данные уже закрыты новыми правилами базы, из браузера их не перенести. Напиши Claude Code — перенесёт вручную."
        : "Перенос не удался (нет интернета?). Попробуй ещё раз.", "err");
  }
}
$("authMigrateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const k = $("migrateKey").value.trim().replace(/^.*[#&]t=/, "");
  if (!window.TutorAuth.isLegacyKey(k)) { authMsg("Это не похоже на старую ссылку/ключ.", "err"); return; }
  runMigration(k);
});
$("authStartEmpty").addEventListener("click", async () => {
  if (!confirm("Начать с пустого дашборда? Старые данные останутся нетронутыми, но в этой учётной записи их не будет.")) return;
  try {
    await window.TutorAuth.createEmptySpace(window.TutorAuth.user.uid);
    startApp();
  } catch (err) {
    authMsg("Не получилось (нет интернета?)", "err");
  }
});
async function doSignOut() {
  stopPoll();
  await window.TutorAuth.signOut();
  location.reload();
}
$("authMigrateSignOut").addEventListener("click", doSignOut);
$("syncAlert").addEventListener("click", () => location.reload());
$("accountSignOutBtn").addEventListener("click", () => { if (confirm("Выйти из дашборда на этом устройстве?")) doSignOut(); });
$("accountResetBtn").addEventListener("click", async () => {
  const email = window.TutorAuth.user && window.TutorAuth.user.email;
  try {
    await window.TutorAuth.resetPassword(email);
    alert("Письмо со ссылкой для нового пароля отправлено на " + email + ".");
  } catch (err) {
    alert(authErrorText(err));
  }
});
