// Код кабинетов разложен по файлам без сборки: teacher/*.js (index.html) и
// cabinet/*.js (cabinet.html). Это обычные скрипты по порядку с одним общим
// пространством имён. Проверки ловят то, что легко забыть при переносе
// кода: файл не подключён, не попал в офлайн-кэш sw.js, имя объявлено
// дважды или совпадает со встроенным именем окна (function open — подменила
// бы window.open).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const scriptTags = (html) => [...html.matchAll(/<script([^>]*)\bsrc="([^"]+)"[^>]*>/g)].map((m) => ({ src: m[2], attrs: m[0] })).filter((t) => !/^https?:/.test(t.src));
const localScripts = (html) => scriptTags(html).map((t) => t.src);
const dirFiles = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`);
const KINDS = [{ page: "index.html", dir: "teacher" }, { page: "cabinet.html", dir: "cabinet" }];
// встроенные имена окна, которые объявление верхнего уровня подменило бы (или сломало)
const WINDOW_NAMES = ["open", "close", "print", "stop", "focus", "blur", "find", "alert", "confirm", "prompt", "scroll", "scrollTo", "scrollBy",
  "fetch", "name", "status", "top", "parent", "self", "frames", "length", "origin", "event", "location", "history", "navigator", "document",
  "screen", "opener", "closed", "window", "external", "crypto", "caches", "performance", "localStorage", "sessionStorage", "postMessage",
  "setTimeout", "setInterval", "clearTimeout", "requestAnimationFrame", "getComputedStyle", "matchMedia", "atob", "btoa", "queueMicrotask", "structuredClone"];

for (const { page, dir } of KINDS) {
  test(`каждый файл ${dir}/*.js подключён в ${page}, а main.js — последним`, () => {
    const src = localScripts(read(page));
    for (const f of dirFiles(dir)) assert.ok(src.includes(f), `${f} не подключён в ${page}`);
    const t = src.filter((s) => s.startsWith(dir + "/"));
    assert.equal(t[t.length - 1], `${dir}/main.js`, `${dir}/main.js (запуск) — последним`);
    for (const s of src) assert.ok(fs.existsSync(path.join(ROOT, s)), `${s} подключён, но файла нет`);
  });

  test(`${dir}/*.js: одно общее пространство имён — каждое имя объявлено один раз и не совпадает со встроенным`, () => {
    // Повтор let/const сломал бы страницу при загрузке, а повтор function
    // молча подменил бы одну функцию другой — ловим оба.
    const seen = new Map();
    for (const f of dirFiles(dir)) {
      for (const m of read(f).matchAll(/^(?:async\s+)?(?:function\*?|let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        assert.ok(!seen.has(m[1]), `«${m[1]}» объявлено и в ${seen.get(m[1])}, и в ${f}`);
        assert.ok(!WINDOW_NAMES.includes(m[1]), `«${m[1]}» в ${f} совпадает со встроенным window.${m[1]}`);
        seen.set(m[1], f);
      }
    }
    assert.ok(seen.size > 100);
  });
}

test("cabinet/*.js: с defer (после модуля Firebase) и в строгом режиме, как был модуль", () => {
  const html = read("cabinet.html");
  const tags = scriptTags(html).filter((t) => t.src.startsWith("cabinet/"));
  const modulePos = html.indexOf('<script type="module">');
  for (const t of tags) {
    assert.match(t.attrs, /\bdefer\b/, `${t.src} без defer — выполнится раньше модуля Firebase`);
    assert.ok(html.indexOf(t.attrs) > modulePos, `${t.src} подключён раньше модуля Firebase`);
    assert.match(read(t.src), /^"use strict";/, `${t.src}: первая строка — "use strict";`);
  }
});

test("все свои скрипты страниц — в офлайн-кэше sw.js, в том же порядке", () => {
  const sw = read("sw.js");
  const shell = [...sw.slice(sw.indexOf("const SHELL"), sw.indexOf("const CDN")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
  for (const { page, dir } of KINDS) {
    for (const s of localScripts(read(page))) assert.ok(shell.includes(s), `${s} (из ${page}) нет в SHELL sw.js — без сети кабинет не откроется`);
    const t = localScripts(read(page)).filter((s) => s.startsWith(dir + "/"));
    assert.deepEqual(shell.filter((s) => s.startsWith(dir + "/")), t);
  }
});

test("вкладки кабинета семьи: список в firestore.rules (accessPrefs) = CAB_TABS в cabinet/core.js", () => {
  // Новая вкладка без правки правил — порядок вкладок перестанет сохраняться.
  const rules = read("firestore.rules");
  const inRules = JSON.parse(/tabOrder\.hasOnly\((\[[^\]]*\])\)/.exec(rules)[1]);
  const inCab = JSON.parse(/const CAB_TABS = (\[[^\]]*\]);/.exec(read("cabinet/core.js"))[1]);
  assert.deepEqual(inRules.slice().sort(), inCab.slice().sort());
});

test("все библиотеки с CDN, которые грузят кабинеты, — в офлайн-списке CDN sw.js (та же версия)", () => {
  // Иначе без сети не работает то, что ни разу не открывали с сетью (так
  // было с html2canvas — картинка «Свободные окна»), а смена версии в одном
  // месте молча ломала офлайн.
  const sw = read("sw.js");
  const cdn = [...sw.slice(sw.indexOf("const CDN"), sw.indexOf("];", sw.indexOf("const CDN"))).matchAll(/"(https:[^"]+)"/g)].map((m) => m[1]);
  const files = ["index.html", "cabinet.html", ...dirFiles("teacher"), ...dirFiles("cabinet")];
  const used = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/https:\/\/(?:www\.gstatic\.com\/firebasejs|cdn\.jsdelivr\.net\/npm|cdnjs\.cloudflare\.com\/ajax\/libs)\/[^"'`\s]+\.js/g)) used.add(m[0]);
  }
  assert.ok(used.size >= 7, "нашлись адреса библиотек");
  for (const u of used) assert.ok(cdn.includes(u), `${u} нет в CDN sw.js`);
});
