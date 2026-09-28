// Код кабинета учителя разложен по файлам teacher/*.js (без сборки): они
// подключаются обычными <script src> по порядку и делят одно общее
// пространство имён. Эти проверки ловят то, что легко забыть при переносе
// кода: файл не подключён, не попал в офлайн-кэш sw.js, имя объявлено дважды.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const localScripts = (html) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
const teacherFiles = () => fs.readdirSync(path.join(ROOT, "teacher")).filter((f) => f.endsWith(".js")).map((f) => "teacher/" + f);

test("каждый файл teacher/*.js подключён в index.html, а main.js — последним", () => {
  const src = localScripts(read("index.html"));
  for (const f of teacherFiles()) assert.ok(src.includes(f), `${f} не подключён в index.html`);
  const t = src.filter((s) => s.startsWith("teacher/"));
  assert.equal(t[t.length - 1], "teacher/main.js", "teacher/main.js (запуск) — последним");
  for (const s of src) assert.ok(fs.existsSync(path.join(ROOT, s)), `${s} подключён, но файла нет`);
});

test("все свои скрипты страниц — в офлайн-кэше sw.js, в том же порядке", () => {
  const sw = read("sw.js");
  const shell = [...sw.slice(sw.indexOf("const SHELL"), sw.indexOf("const CDN")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
  for (const page of ["index.html", "cabinet.html"]) {
    for (const s of localScripts(read(page))) assert.ok(shell.includes(s), `${s} (из ${page}) нет в SHELL sw.js — без сети кабинет не откроется`);
  }
  const t = localScripts(read("index.html")).filter((s) => s.startsWith("teacher/"));
  assert.deepEqual(shell.filter((s) => s.startsWith("teacher/")), t);
});

test("teacher/*.js: одно общее пространство имён — каждое имя объявлено один раз", () => {
  // Повтор let/const сломал бы страницу при загрузке, а повтор function
  // молча подменил бы одну функцию другой — ловим оба.
  const seen = new Map();
  for (const f of teacherFiles()) {
    for (const m of read(f).matchAll(/^(?:async\s+)?(?:function\*?|let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      assert.ok(!seen.has(m[1]), `«${m[1]}» объявлено и в ${seen.get(m[1])}, и в ${f}`);
      seen.set(m[1], f);
    }
  }
  assert.ok(seen.size > 100);
});
