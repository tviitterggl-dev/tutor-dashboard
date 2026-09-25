// Тема оформления — общая для кабинета учителя и кабинетов родителя/ученика.
// Подключается обычным <script> в <head>, поэтому тема ставится до первой
// отрисовки (без «вспышки» светлой темы).
// По умолчанию — как в системе (CSS @media prefers-color-scheme). Если
// человек переключил вручную — выбор хранится на этом устройстве
// (localStorage "theme" = "light" | "dark") и ставится как <html data-theme>.
(function () {
  var KEY = "theme";
  var BAR = { light: "#F7F5F0", dark: "#1C1D21" }; // цвет полосы браузера/статус-бара
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { var t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch (e) { return null; }
  }
  function system() { return media && media.matches ? "dark" : "light"; }
  function effective() { return saved() || system(); }

  function syncMeta() {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    var t = saved();
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      if (!m.dataset.media) m.dataset.media = m.getAttribute("media") || "";
      if (t) { m.setAttribute("content", BAR[t]); m.removeAttribute("media"); }
      else {
        var isDark = /dark/.test(m.dataset.media);
        m.setAttribute("content", isDark ? BAR.dark : BAR.light);
        if (m.dataset.media) m.setAttribute("media", m.dataset.media);
      }
    }
  }
  function apply() {
    var t = saved();
    if (t) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
    if (document.readyState !== "loading") syncMeta();
  }
  function set(t) {
    try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) { /* приватный режим */ }
    // короткий плавный переход цветов только в момент переключения
    root.classList.add("theme-anim");
    apply();
    listeners.forEach(function (fn) { fn(); });
    setTimeout(function () { root.classList.remove("theme-anim"); }, 320);
  }

  var listeners = [];
  apply();
  document.addEventListener("DOMContentLoaded", syncMeta);
  if (media) {
    var onSys = function () { if (!saved()) listeners.forEach(function (fn) { fn(); }); };
    if (media.addEventListener) media.addEventListener("change", onSys); else if (media.addListener) media.addListener(onSys);
  }

  // Переключатель-ползунок «Тёмная тема» + «как в системе».
  // mount(container) — вставляет разметку в контейнер (карточка во вкладке «Ещё»).
  function mount(el) {
    if (!el) return;
    el.innerHTML =
      '<label class="theme-switch">' +
        '<span class="theme-switch-text"><span class="theme-switch-title">Тёмная тема</span>' +
        '<span class="theme-switch-state" data-theme-state></span></span>' +
        '<input type="checkbox" role="switch" data-theme-toggle>' +
        '<span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>' +
      "</label>" +
      '<button type="button" class="theme-system" data-theme-system>Как в системе</button>';
    var box = el.querySelector("[data-theme-toggle]");
    var state = el.querySelector("[data-theme-state]");
    var sys = el.querySelector("[data-theme-system]");
    function render() {
      var t = saved();
      box.checked = effective() === "dark";
      state.textContent = t ? "выбрано на этом устройстве" : "как в системе устройства";
      sys.hidden = !t;
    }
    box.addEventListener("change", function () { set(box.checked ? "dark" : "light"); });
    sys.addEventListener("click", function () { set(null); });
    listeners.push(render);
    render();
  }

  window.appTheme = { mount: mount, get: effective, saved: saved, set: set };
})();
