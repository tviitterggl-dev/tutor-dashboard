// Тема оформления — общая для кабинета учителя и кабинетов родителя/ученика.
// Подключается обычным <script> в <head>, поэтому тема ставится до первой
// отрисовки (без «вспышки» светлой темы).
// По умолчанию — как в системе (CSS @media prefers-color-scheme). Если
// человек переключил вручную — выбор хранится на этом устройстве
// (localStorage "theme" = "light" | "dark") и ставится как <html data-theme>.
// Так же, на устройстве и без базы, хранятся:
//   палитра — localStorage "palette" (pink | wine | green | orange; нет — обычная)
//             → <html data-palette>; цвета — в design.css;
//   подсказки — localStorage "hints" = "off" → <html data-hints="off">: прячет
//             справочные пояснения (.hint-help), статусы (.hint) остаются.
(function () {
  var KEY = "theme", PKEY = "palette", HKEY = "hints";
  var PALETTES = [
    { id: "", name: "Обычная", sw: ["#F7F5F0", "#A9822F"] },
    { id: "pink", name: "Розовая", sw: ["#F8F1F3", "#B97D8E"] },
    { id: "wine", name: "Бордовая", sw: ["#F8F1EF", "#8C3A35"] },
    { id: "green", name: "Зелёная", sw: ["#F5F7F0", "#5C7A5E"] },
    { id: "orange", name: "Оранжевая", sw: ["#F5E6D3", "#A66B45"] },
  ];
  // цвет полосы браузера/статус-бара = фон страницы палитры
  var BARS = {
    "": { light: "#F7F5F0", dark: "#1C1D21" },
    pink: { light: "#F8F1F3", dark: "#1D1518" }, wine: { light: "#F8F1EF", dark: "#1C1212" },
    green: { light: "#F5F7F0", dark: "#161A16" }, orange: { light: "#F5E6D3", dark: "#1C1511" },
  };
  var root = document.documentElement;
  function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* приватный режим */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function palette() { var p = read(PKEY); return BARS[p] && p ? p : ""; }
  function hintsOn() { return read(HKEY) !== "off"; }
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
      var BAR = BARS[palette()];
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
    var p = palette();
    if (p) root.setAttribute("data-palette", p); else root.removeAttribute("data-palette");
    if (hintsOn()) root.removeAttribute("data-hints"); else root.setAttribute("data-hints", "off");
    if (document.readyState !== "loading") syncMeta();
  }
  function change(k, v) {
    store(k, v);
    // короткий плавный переход цветов только в момент переключения
    root.classList.add("theme-anim");
    apply();
    listeners.forEach(function (fn) { fn(); });
    setTimeout(function () { root.classList.remove("theme-anim"); }, 320);
  }
  function set(t) { change(KEY, t); }
  function setPalette(p) { change(PKEY, BARS[p] ? p : ""); }
  function setHints(on) { change(HKEY, on ? "" : "off"); }

  var listeners = [];
  apply();
  document.addEventListener("DOMContentLoaded", syncMeta);
  if (media) {
    var onSys = function () { if (!saved()) listeners.forEach(function (fn) { fn(); }); };
    if (media.addEventListener) media.addEventListener("change", onSys); else if (media.addListener) media.addListener(onSys);
  }

  // Карточка «Оформление»: ползунок «Тёмная тема» + «как в системе», выбор
  // палитры и ползунок «Подсказки». mount(container) — вставляет разметку.
  function switchHtml(attr, title, stateAttr) {
    return '<label class="theme-switch">' +
        '<span class="theme-switch-text"><span class="theme-switch-title">' + title + '</span>' +
        '<span class="theme-switch-state" ' + stateAttr + '></span></span>' +
        '<input type="checkbox" role="switch" ' + attr + '>' +
        '<span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span>' +
      "</label>";
  }
  function mount(el) {
    if (!el) return;
    el.innerHTML =
      switchHtml("data-theme-toggle", "Тёмная тема", "data-theme-state") +
      '<button type="button" class="theme-system" data-theme-system>Как в системе</button>' +
      '<div class="palette-title">Цвета</div>' +
      '<div class="palette-pick" role="radiogroup" aria-label="Цвета">' +
        PALETTES.map(function (p) {
          return '<button type="button" class="palette-opt" role="radio" data-palette-opt="' + p.id + '">' +
            '<span class="palette-sw" aria-hidden="true" style="background:' + p.sw[0] + ';box-shadow:inset 0 0 0 7px ' + p.sw[1] + '"></span>' + p.name + "</button>";
        }).join("") +
      "</div>" +
      switchHtml("data-hints-toggle", "Подсказки", "data-hints-state");
    var box = el.querySelector("[data-theme-toggle]");
    var state = el.querySelector("[data-theme-state]");
    var sys = el.querySelector("[data-theme-system]");
    var hints = el.querySelector("[data-hints-toggle]");
    var hintsState = el.querySelector("[data-hints-state]");
    function render() {
      var t = saved();
      box.checked = effective() === "dark";
      state.textContent = t ? "выбрано на этом устройстве" : "как в системе устройства";
      sys.hidden = !t;
      var p = palette();
      el.querySelectorAll("[data-palette-opt]").forEach(function (b) { b.setAttribute("aria-checked", b.getAttribute("data-palette-opt") === p ? "true" : "false"); });
      hints.checked = hintsOn();
      hintsState.textContent = hints.checked ? "пояснения под кнопками и полями показываются" : "пояснения скрыты (сообщения и ошибки видны всегда)";
    }
    box.addEventListener("change", function () { set(box.checked ? "dark" : "light"); });
    sys.addEventListener("click", function () { set(null); });
    el.querySelectorAll("[data-palette-opt]").forEach(function (b) { b.addEventListener("click", function () { setPalette(b.getAttribute("data-palette-opt")); }); });
    hints.addEventListener("change", function () { setHints(hints.checked); });
    listeners.push(render);
    render();
  }

  window.appTheme = { mount: mount, get: effective, saved: saved, set: set, palette: palette, setPalette: setPalette, hintsOn: hintsOn, setHints: setHints, PALETTES: PALETTES };
})();
