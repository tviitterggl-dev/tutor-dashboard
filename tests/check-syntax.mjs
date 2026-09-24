// Минимальная проверка: вытащить все <script> из HTML и прогнать через node --check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const files = process.argv.slice(2);
let failed = false;
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    if (!m[2].trim()) continue;
    i++;
    const ext = /type="module"/.test(m[1]) ? ".mjs" : ".js";
    const tmp = path.join(os.tmpdir(), `chk_${path.basename(f)}_${i}${ext}`);
    fs.writeFileSync(tmp, m[2]);
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      console.log(`ok   ${f} script #${i} (${ext})`);
    } catch (e) {
      failed = true;
      console.log(`FAIL ${f} script #${i}\n${e.stderr}`);
    }
  }
}
process.exit(failed ? 1 : 0);
