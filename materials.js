// Материалы ученика — общее для кабинета учителя и кабинетов родителя/ученика.
//   Materials.clean(list)   — только годные ссылки http(s), не больше MAX, названия
//                             обрезаны; то же проверяют правила (validView);
//   Materials.label(m)      — название или, если его нет, адрес сайта;
//   Materials.dropdownHtml(list, text) — «материалы N» раскрывающимся списком
//                             (<details>: в тесных карточках, без скриптов);
//   Materials.linksHtml(list) — ссылки-«пилюли» с переносом строк (в окнах).
// Разметка экранируется здесь же. Ссылки открываются в новой вкладке.
(function (root) {
  "use strict";
  var MAX = 10, URL_MAX = 500, TITLE_MAX = 80;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // «HTTPS://…» → «https://…»: правила проверяют схему строчными буквами
  function normUrl(u) {
    u = typeof u === "string" ? u.trim() : "";
    var m = /^(https?):\/\/\S+$/i.exec(u);
    if (!m || u.length > URL_MAX) return null;
    return m[1].toLowerCase() + u.slice(m[1].length);
  }
  function clean(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (m) {
      if (out.length >= MAX || !m) return;
      var url = normUrl(m.url);
      if (!url) return;
      var title = typeof m.title === "string" ? m.title.trim().slice(0, TITLE_MAX) : "";
      out.push(title ? { url: url, title: title } : { url: url });
    });
    return out;
  }
  function label(m) {
    if (m.title) return m.title;
    try { return new URL(m.url).hostname.replace(/^www\./, ""); } catch (e) { return m.url; }
  }
  function link(m, cls) {
    return '<a class="' + cls + '" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(label(m)) + "</a>";
  }
  function dropdownHtml(list, text) {
    list = clean(list);
    if (!list.length) return "";
    return '<details class="mats"><summary>' + esc(text || "материалы") + " " + list.length + "</summary>"
      + '<div class="mats-list">' + list.map(function (m) { return link(m, "mat-link"); }).join("") + "</div></details>";
  }
  function linksHtml(list) {
    list = clean(list);
    if (!list.length) return "";
    return '<div class="mats-pills">' + list.map(function (m) { return link(m, "mat-pill"); }).join("") + "</div>";
  }

  var api = { MAX: MAX, URL_MAX: URL_MAX, TITLE_MAX: TITLE_MAX, clean: clean, label: label, dropdownHtml: dropdownHtml, linksHtml: linksHtml, normUrl: normUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Materials = api;
})(typeof window !== "undefined" ? window : this);
