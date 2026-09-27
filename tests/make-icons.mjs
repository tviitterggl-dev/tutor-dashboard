// Значки из icons/icon.svg → PNG нужных размеров (Playwright, без других программ).
// Запуск: cd tests && node make-icons.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = fs.readFileSync(path.join(ROOT, "icons/icon.svg"), "utf8");
const out = { "apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512, "favicon-32.png": 32 };
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size] of Object.entries(out)) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(ROOT, "icons", name), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
  console.log("icons/" + name, size);
}
await browser.close();
