// Минимальная проверка синтаксиса: у HTML — все встроенные <script> и
// подключённые свои файлы (<script src="...">, не CDN), у .js — сам файл;
// всё через node --check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let failed = false;
function check(file, label) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`ok   ${label}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${label}\n${e.stderr}`);
  }
}
const seen = new Set();
function checkFile(f) {
  if (seen.has(path.resolve(f))) return;
  seen.add(path.resolve(f));
  if (!f.endsWith(".html")) { check(f, f); return; }
  const html = fs.readFileSync(f, "utf8");
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (src) {
      if (!/^https?:/.test(src[1])) checkFile(path.join(path.dirname(f), src[1]));
      continue;
    }
    if (!m[2].trim()) continue;
    i++;
    const ext = /type="module"/.test(m[1]) ? ".mjs" : ".js";
    const tmp = path.join(os.tmpdir(), `chk_${path.basename(f)}_${i}${ext}`);
    fs.writeFileSync(tmp, m[2]);
    check(tmp, `${f} script #${i} (${ext})`);
  }
}
for (const f of process.argv.slice(2)) checkFile(f);
process.exit(failed ? 1 : 0);
