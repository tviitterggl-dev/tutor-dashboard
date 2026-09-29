"use strict";
// Кабинет семьи — файлы ДЗ: загрузка в Cloudinary (только unsigned),
// зона «перетащите / выберите», вставка скриншота из буфера.

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пусто */ }
  if (!res.ok || !data.secure_url) {
    const err = new Error((data.error && data.error.message) || ("код " + res.status));
    err.userText = `Файл «${file.name}» не загрузился: ${err.message}`;
    throw err;
  }
  return { url: data.secure_url, name: file.name.slice(0, 200) };
}

// Загрузка ДЗ: файл в Cloudinary → сообщение в общий канал ученика.
async function uploadFiles(l, files, say) {
  requireOnline();
  const big = files.filter((f) => f.size > CLOUDINARY_MAX_BYTES);
  if (big.length) {
    const err = new Error("big");
    err.userText = `Слишком большой файл: ${big.map((f) => f.name).join(", ")} (максимум 10 МБ).`;
    throw err;
  }
  for (let i = 0; i < files.length; i++) {
    say(`Загружаю ${i + 1} из ${files.length}: ${files[i].name}…`);
    const file = await uploadToCloudinary(files[i]);
    await addItem(view.channel, { type: "homework", lessonId: l.id, by: current.role, createdAt: Date.now(), file });
  }
}

// ---------- файлы ДЗ: перетаскивание, выбор, вставка из буфера ----------
function dropZoneHtml(id, label) {
  return `<label class="drop-zone" data-drop="${id}" tabindex="0">
      <input type="file" id="${id}" multiple>
      <span class="dz-main">${esc(label)}</span>
      <span class="dz-sub">перетащите фото или файл сюда, нажмите, чтобы выбрать, или вставьте скриншот (Ctrl+V)</span>
    </label>`;
}
function wireDropZone(zone, onFiles) {
  if (!zone) return;
  const input = zone.querySelector('input[type="file"]');
  input.addEventListener("change", () => { const f = Array.from(input.files || []); input.value = ""; if (f.length) onFiles(f); });
  ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => { const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) onFiles(f); });
}
function filesFromClipboard(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const stamp = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[.,: ]+/g, "-");
  return items.filter((i) => i.kind === "file").map((i, n) => {
    const f = i.getAsFile();
    if (!f) return null;
    if (!f.name || /^image\.\w+$/i.test(f.name)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `скриншот-${stamp}${n ? "-" + (n + 1) : ""}.${ext}`, { type: f.type });
    }
    return f;
  }).filter(Boolean);
}
document.addEventListener("paste", (e) => {
  const files = filesFromClipboard(e);
  if (!files.length) return; // обычный текст вставляется как обычно
  if (modalPaste && $("modalBack").style.display !== "none") { e.preventDefault(); modalPaste(files); return; }
  if (activeTab === "hw" && $("hwFile") && $("hwLesson")) {
    const l = lessonById($("hwLesson").value);
    if (l) { e.preventDefault(); uploadFromPane(l, files); }
  }
});
