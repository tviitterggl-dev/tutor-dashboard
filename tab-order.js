// Порядок вкладок — общий для кабинета учителя и кабинетов родителя/ученика.
//   TabOrder.normalize(order, ids) — только известные вкладки, без повторов;
//     новые (появились после сохранения порядка) встают на своё место по умолчанию;
//   TabOrder.apply(bar, attr, order) — переставить кнопки в полосе вкладок;
//   TabOrder.mountEditor(el, { items, order, onChange, onReset }) — список в
//     «Настройках»: перетаскивание за ручку ⠿ (мышь, палец) и кнопки ↑ ↓.
// Где хранить порядок, решает страница (у учителя — state/main.tabOrder,
// у родителя/ученика — accessPrefs/{ключ}); здесь только интерфейс.
(function (root) {
  "use strict";

  function normalize(order, ids) {
    const known = new Set(ids);
    const out = [];
    (Array.isArray(order) ? order : []).forEach((id) => { if (known.has(id) && !out.includes(id)) out.push(id); });
    ids.forEach((id, i) => {
      if (out.includes(id)) return;
      // новая вкладка: после соседки слева по умолчанию (или в начало)
      const prev = ids.slice(0, i).reverse().find((x) => out.includes(x));
      out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
    });
    return out;
  }

  function apply(bar, attr, order) {
    if (!bar || !order) return;
    const byId = {};
    [...bar.children].forEach((el) => { const id = el.getAttribute(attr); if (id) byId[id] = el; });
    order.forEach((id) => { if (byId[id]) bar.appendChild(byId[id]); });
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function mountEditor(el, opts) {
    const labels = Object.fromEntries(opts.items.map((x) => [x.id, x.label]));
    const ids = opts.items.map((x) => x.id);
    let order = normalize(opts.order, ids);
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    function commit(next) {
      if (same(next, order)) return;
      order = next;
      render();
      opts.onChange(order.slice());
    }
    function render() {
      el.innerHTML = `<ol class="to-list">${order.map((id, i) => `
        <li class="to-item" data-to="${esc(id)}">
          <span class="to-handle" aria-hidden="true" title="Перетащите">⠿</span>
          <span class="to-label">${esc(labels[id])}</span>
          <button type="button" class="to-btn" data-to-up="${esc(id)}" aria-label="${esc(labels[id])} — выше"${i === 0 ? " disabled" : ""}>↑</button>
          <button type="button" class="to-btn" data-to-down="${esc(id)}" aria-label="${esc(labels[id])} — ниже"${i === order.length - 1 ? " disabled" : ""}>↓</button>
        </li>`).join("")}</ol>
        <div class="to-row"><button type="button" class="link-btn" data-to-reset>Порядок по умолчанию</button></div>`;
    }
    el.addEventListener("click", (e) => {
      const up = e.target.closest("[data-to-up]");
      const down = e.target.closest("[data-to-down]");
      if (up || down) {
        const id = (up || down).getAttribute(up ? "data-to-up" : "data-to-down");
        const i = order.indexOf(id);
        const j = up ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return;
        const next = order.slice();
        next.splice(i, 1);
        next.splice(j, 0, id);
        commit(next);
        const btn = el.querySelector(`[${up ? "data-to-up" : "data-to-down"}="${CSS.escape(id)}"]`);
        if (btn && !btn.disabled) btn.focus();
        return;
      }
      if (e.target.closest("[data-to-reset]")) commit(ids.slice());
    });
    // Перетаскивание за ручку: строка встаёт на новое место, как только палец
    // (мышь) проходит середину соседней; отпустили — новый порядок сохраняется.
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".to-handle");
      if (!handle) return;
      const li = handle.closest(".to-item");
      e.preventDefault();
      li.setPointerCapture(e.pointerId);
      drag = { li, id: li.dataset.to, pointerId: e.pointerId };
      li.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const list = el.querySelector(".to-list");
      const others = [...list.children].filter((x) => x !== drag.li);
      // встаём перед первой строкой, чья середина ниже пальца
      const before = others.find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
      if (drag.li.nextElementSibling !== before) list.insertBefore(drag.li, before);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const list = el.querySelector(".to-list");
      drag.li.classList.remove("dragging");
      const next = [...list.children].map((x) => x.dataset.to);
      drag = null;
      if (same(next, order)) render(); else commit(next);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    render();
    return { set(o) { order = normalize(o, ids); render(); }, get: () => order.slice() };
  }

  root.TabOrder = { normalize, apply, mountEditor };
})(typeof window !== "undefined" ? window : globalThis);
