// Поддельный firebase-messaging для тестов: «токен» устройства без сети.
// window.__FAKE_FCM_UNSUPPORTED = true — как браузер без пушей.
export async function isSupported() { return !window.__FAKE_FCM_UNSUPPORTED; }
export function getMessaging(app) { return { app }; }
export async function getToken(messaging, opts) {
  if (!opts || !opts.vapidKey) throw new Error("no vapidKey");
  if (!opts.serviceWorkerRegistration) throw new Error("no serviceWorkerRegistration");
  window.__fakeFcmCalls = (window.__fakeFcmCalls || 0) + 1;
  return "fake-fcm-token-" + "x".repeat(40) + "-" + (localStorage.getItem("__fakeFcmSeed") || "1");
}
export async function deleteToken() { return true; }
