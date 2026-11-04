// Zajedničke komponente sučelja (web): tablice, obrasci, dijalozi, stranica.
// Obrasci koriste ISTI opis polja kao desktop program (key, label, type, options, required, default...).
import * as py from "./py.js";

// ---------------------------------------------------------------- DOM pomoćnik
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

// ---------------------------------------------------------------- formatiranje (kao u ui.py)
export const EPS = 1e-9;
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function d2ui(iso) {
  if (!iso) return "";
  const s = String(iso).slice(0, 10).split("-");
  return s.length === 3 ? `${s[2]}.${s[1]}.${s[0]}.` : String(iso);
}
export function ui2d(s) {
  s = String(s || "").trim().replace(/\.$/, "");
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!m) throw new Error(`Neispravan datum: '${s}' (koristite DD.MM.GGGG.)`);
  let y = +m[3]; if (y < 100) y += 2000;
  return `${y}-${String(+m[2]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}
export function num(s) {
  s = String(s ?? "").trim().replace(/\s/g, "");
  if (!s) return 0;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const v = Number(s);
  if (Number.isNaN(v)) throw new Error("Neispravan broj: " + s);
  return v;
}
export function fq(x, dec = 3) {
  if (x === null || x === undefined || x === "") return "";
  const v = Number(x);
  if (Number.isNaN(v)) return String(x);
  let s = v.toLocaleString("hr-HR", { minimumFractionDigits: 0, maximumFractionDigits: dec });
  return s;
}
export function money(x) {
  return Number(x || 0).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
export function fin(x) { // broj za upis u polje (zarez, bez razmaka tisućica)
  if (x === null || x === undefined || x === "") return "";
  const v = Number(x);
  if (Number.isNaN(v)) return String(x);
  return String(Math.round(v * 1e6) / 1e6).replace(".", ",");
}
export function daysLeft(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
}
export function sg(x) { return x ? Number(x).toFixed(3).replace(".", ",") : ""; }
export const TIMES = Array.from({ length: 34 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
export const TIME_KEYS = new Set(["time", "start_time", "end_time"]);
export function checkTime(...vals) {
  for (const v of vals) if (v && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`Vrijeme '${v}' upišite kao SS:MM (npr. 09:30).`);
}

// ---------------------------------------------------------------- tipke, poruke
export function btn(text, onClick, kind = "primary", attrs = {}) {
  return h("button", { class: `btn btn-${kind}`, type: "button", onclick: onClick, ...attrs }, text);
}

let toastTimer = null;
export function toast(text, ms = 3500) {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", { id: "toast" }); document.body.append(t); }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

let zTop = 100;
export class Dialog {
  constructor(title, { width = 560, cls = "" } = {}) {
    this.result = null;
    this.back = h("div", { class: "modal-back", style: { zIndex: ++zTop } });
    this.box = h("div", { class: "modal " + cls, style: { width: `min(${width}px, calc(100vw - 24px))` }, role: "dialog" });
    this.head = h("div", { class: "modal-head" }, h("span", {}, title),
      h("button", { class: "modal-x", type: "button", title: "Zatvori", onclick: () => this.close(null) }, "✕"));
    this.body = h("div", { class: "modal-body" });
    this.errEl = h("div", { class: "modal-err" });
    this.bar = h("div", { class: "modal-bar" });
    this.box.append(this.head, this.body, this.errEl, this.bar);
    this.back.append(this.box);
    this.back.addEventListener("mousedown", (e) => { this._downOut = e.target === this.back; });
    this.keyh = (e) => {
      if (e.key === "Escape" && this.back.style.zIndex == zTop) { e.preventDefault(); this.close(null); }
      if (e.key === "Enter" && this.onEnter && this.back.style.zIndex == zTop && e.target.tagName !== "TEXTAREA"
          && !(e.target.tagName === "BUTTON")) { e.preventDefault(); this.onEnter(); }
    };
    this.promise = new Promise((res) => { this._resolve = res; });
  }
  err(msg) { this.errEl.textContent = msg || ""; this.errEl.style.display = msg ? "block" : "none"; }
  buttons(okText = "Spremi", onOk = null, cancelText = "Odustani") {
    this.bar.innerHTML = "";
    if (cancelText) this.bar.append(btn(cancelText, () => this.close(null), "ghost"));
    if (onOk) { this.okBtn = btn(okText, onOk, "primary"); this.bar.append(this.okBtn); this.onEnter = onOk; }
    return this;
  }
  show() {
    document.body.append(this.back);
    document.addEventListener("keydown", this.keyh);
    setTimeout(() => {
      const f = this.body.querySelector("input:not([type=checkbox]):not([readonly]), select, textarea");
      if (f) f.focus();
    }, 30);
    return this.promise;
  }
  close(result = this.result) {
    document.removeEventListener("keydown", this.keyh);
    this.back.remove();
    zTop--;
    this._resolve(result);
  }
}

export function info(msg, title = "Obavijest") {
  const d = new Dialog(title, { width: 480 });
  d.body.append(h("div", { class: "msg" }, msg));
  d.buttons("U redu", () => d.close(true), null);
  return d.show();
}
export function error(msg, title = "Greška") { return info(msg instanceof Error ? msg.message : msg, title); }
export function confirm(msg, title = "Potvrda", { ok = "Da", cancel = "Ne", danger = false } = {}) {
  const d = new Dialog(title, { width: 480 });
  d.body.append(h("div", { class: "msg" }, msg));
  d.buttons(ok, () => d.close(true), cancel);
  if (danger) d.okBtn.className = "btn btn-danger";
  return d.show().then((r) => !!r);
}

// Zaslon "radim…" za duže radnje (npr. izrada dokumenata)
export async function busy(text, fn) {
  const o = h("div", { class: "busy" }, h("div", { class: "busy-box" }, h("div", { class: "spinner" }), h("div", { class: "busy-text" }, text)));
  document.body.append(o);
  await new Promise((r) => setTimeout(r, 30));
  try { return await fn((t) => { o.querySelector(".busy-text").textContent = t; }); } finally { o.remove(); }
}

// Datoteka iz Pythona (PDF/Word/CSV) -> otvori ili preuzmi
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", db: "application/octet-stream", png: "image/png", zip: "application/zip", html: "text/html" };
export function openFile(path) {
  if (!path) return;
  const name = path.split("/").pop();
  const ext = name.split(".").pop().toLowerCase();
  const blob = new Blob([py.readFile(path)], { type: MIME[ext] || "application/octet-stream" });
  saveBlob(blob, name, ext === "pdf");
}
export function saveBlob(blob, name, offerOpen = false) {
  const url = URL.createObjectURL(blob);
  const d = new Dialog("Dokument je spreman", { width: 480 });
  d.body.append(h("div", { class: "msg" }, name));
  d.bar.append(btn("Zatvori", () => d.close(), "ghost"));
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      d.bar.append(btn("📤 Podijeli", async () => {
        try { await navigator.share({ files: [file], title: name }); } catch { /* korisnik odustao */ }
      }, "ghost"));
    }
  } catch { /* stariji preglednik */ }
  if (offerOpen) d.bar.append(h("a", { class: "btn btn-ghost", href: url, target: "_blank", rel: "noopener" }, "👁 Otvori"));
  d.bar.append(h("a", { class: "btn btn-primary", href: url, download: name, onclick: () => setTimeout(() => d.close(), 300) }, "⬇ Preuzmi"));
  d.show().then(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}
export function downloadText(text, name, type = "text/csv") {
  saveBlob(new Blob(["﻿" + text], { type }), name);
}

// ---------------------------------------------------------------- tablica
function sortKey(v) {
  if (v === null || v === undefined) return [1, ""];
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})\.?$/);
  if (m) return [0, `${m[3]}${m[2]}${m[1]}`];
  const n = s.replace(/\s|€|%/g, "").replace(/\./g, "").replace(",", ".");
  if (n !== "" && !Number.isNaN(Number(n))) return [0, Number(n)];
  return [0, s.toLowerCase()];
}

export class Table {
  // columns: [[key, naslov, širina, poravnanje 'w'|'e'|'center'], ...]
  constructor(columns, { onDouble = null, multi = false, height = null, onSelect = null } = {}) {
    this.columns = columns.map((c) => Array.isArray(c) ? c : [c.key, c.title, c.width, c.align]);
    this.rows = []; this.view = []; this.filter = ""; this.sort = [null, false];
    this.multi = multi; this.onDouble = onDouble; this.onSelect = onSelect;
    this.sel = new Set();
    this.el = h("div", { class: "table-wrap" + (height ? " fixed" : ""), style: height ? { maxHeight: `${height * 34 + 40}px` } : {} });
    this.table = h("table", { class: "grid" });
    const tot = this.columns.reduce((a, c) => a + (c[2] || 100), 0);
    this.colgroup = h("colgroup", {}, this.columns.map((c) => h("col", { style: { width: `${((c[2] || 100) / tot) * 100}%` } })));
    this.thead = h("thead", {}, h("tr", {}, this.columns.map((c) =>
      h("th", { class: "al-" + (c[3] || "w"), onclick: () => this.sortBy(c[0]) }, c[1]))));
    this.tbody = h("tbody");
    this.table.append(this.colgroup, this.thead, this.tbody);
    this.el.append(this.table);
    this.tbody.addEventListener("click", (e) => this._click(e));
    this.tbody.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr");
      if (!tr || tr.dataset.id === undefined) return;
      this.sel = new Set([tr.dataset.id]); this._paintSel();
      if (this.onDouble) this.onDouble(this.selectedId());
    });
  }
  _click(e) {
    const tr = e.target.closest("tr");
    if (!tr || tr.dataset.id === undefined) return;
    const id = tr.dataset.id;
    // mobitel: drugi dodir istog retka = otvori (kao dvoklik na računalu)
    if (this.onDouble && window.matchMedia("(pointer: coarse)").matches) {
      const now = Date.now();
      if (this._tap && this._tap.id === id && now - this._tap.t < 600) {
        this._tap = null; this.sel = new Set([id]); this._paintSel(); this.onDouble(this.selectedId()); return;
      }
      this._tap = { id, t: now };
    }
    if (this.multi && window.matchMedia("(pointer: coarse)").matches && !e.shiftKey) {
      // mobitel: dodir označava / odznačava (višestruki odabir bez tipke Ctrl)
      this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); this._last = id;
    } else if (this.multi && (e.ctrlKey || e.metaKey)) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); this._last = id; }
    else if (this.multi && e.shiftKey && this._last !== undefined) {
      const ids = this.view.map((r) => String(r.id));
      const a = ids.indexOf(this._last), b = ids.indexOf(id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(ids[i]);
    } else { this.sel = new Set([id]); this._last = id; }
    this._paintSel();
    if (this.onSelect) this.onSelect(this.selectedId());
  }
  _paintSel() { for (const tr of this.tbody.children) tr.classList.toggle("sel", this.sel.has(tr.dataset.id)); }
  setRows(rows) { this.rows = rows || []; this.render(); }
  setFilter(t) { this.filter = (t || "").toLowerCase().trim(); this.render(); }
  sortBy(key) {
    const [k, rev] = this.sort;
    this.sort = [key, k === key ? !rev : false];
    [...this.thead.querySelectorAll("th")].forEach((th, i) => {
      const c = this.columns[i];
      th.textContent = c[1] + (c[0] === key ? (this.sort[1] ? " ▼" : " ▲") : "");
    });
    this.render();
  }
  render() {
    let rows = this.rows;
    if (this.filter) rows = rows.filter((r) => this.columns.some((c) => String(r[c[0]] ?? "").toLowerCase().includes(this.filter)));
    const [key, rev] = this.sort;
    if (key) {
      rows = [...rows].sort((a, b) => {
        const x = sortKey(a[key]), y = sortKey(b[key]);
        const r = x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
        return rev ? -r : r;
      });
    }
    this.view = rows;
    const ids = new Set(rows.map((r) => String(r.id)));
    this.sel = new Set([...this.sel].filter((s) => ids.has(s)));
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = h("tr", { "data-id": String(r.id), class: (r._tag || "") + (this.sel.has(String(r.id)) ? " sel" : "") });
      for (const c of this.columns) {
        const v = r[c[0]];
        const empty = v === undefined || v === null || v === "";
        const ttl = !empty && !tr.querySelector("td.ttl");
        tr.append(h("td", { class: "al-" + (c[3] || "w") + (empty ? " empty" : "") + (ttl ? " ttl" : ""), title: empty ? "" : String(v),
          "data-label": c[1] || "" }, v ?? ""));
      }
      frag.append(tr);
    }
    this.tbody.innerHTML = "";
    this.tbody.append(frag);
    if (!rows.length) this.tbody.append(h("tr", { class: "empty" }, h("td", { colspan: this.columns.length }, "Nema podataka.")));
  }
  _conv(s) { const n = Number(s); return String(n) === s ? n : s; }
  selectedIds() { return [...this.sel].map((s) => this._conv(s)); }
  selectedId() { const s = this.selectedIds(); return s.length ? s[0] : null; }
  select(ids) { this.sel = new Set([].concat(ids).map(String)); this._paintSel(); }
  selectedRow() { const id = this.selectedId(); return this.view.find((r) => String(r.id) === String(id)) || null; }
  exportCsv(name = "izvoz") {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [this.columns.map((c) => esc(c[1])).join(";")];
    for (const r of this.view) lines.push(this.columns.map((c) => esc(r[c[0]])).join(";"));
    downloadText(lines.join("\r\n"), name + ".csv");
  }
}

// ---------------------------------------------------------------- obrazac (isti opis polja kao FormFrame)
// type: text | num | date | time | combo | check | multi | info | section | multicheck
let uid = 0;
export class Form {
  constructor(fields, initial = {}, columns = 1) {
    this.fields = fields; this.w = {};
    initial = initial || {};
    this.el = h("div", { class: "form", style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } });
    for (const f of fields) {
      const t = f.type || "text";
      const full = f.full || t === "section" || t === "multicheck" || (t === "check" && (f.label || "").length > 40);
      const cell = h("div", { class: "fcell" + (full ? " full" : "") + (t === "section" ? " section" : "") });
      this.el.append(cell);
      if (t === "section") { cell.append(h("div", { class: "sec" }, f.label)); continue; }
      const key = f.key;
      let v = key in initial ? initial[key] : f.default;
      const id = "f" + (++uid);
      const label = f.label + (f.required ? " *" : "");
      if (t !== "check" && t !== "info") cell.append(h("label", { class: "flab", for: id }, label));
      let w;
      if (t === "multicheck") {
        const box = h("div", { class: "mcheck", style: { gridTemplateColumns: `repeat(${f.per_row || 3}, auto)` } });
        const chosen = new Set(v || []);
        const boxes = {};
        for (const o of f.options || []) {
          const cb = h("input", { type: "checkbox" }); cb.checked = chosen.has(o);
          boxes[o] = cb;
          box.append(h("label", { class: "chk" }, cb, " ", o));
        }
        cell.append(box);
        w = { get: () => Object.entries(boxes).filter(([, cb]) => cb.checked).map(([o]) => o),
          set: (vals) => { const s = new Set(vals || []); for (const [o, cb] of Object.entries(boxes)) cb.checked = s.has(o); }, el: box };
      } else if (t === "combo") {
        const opts = (f.options || []).map((o) => Array.isArray(o) ? o : [String(o ?? ""), o]);
        if (f.editable) {
          const dl = h("datalist", { id: id + "l" }, opts.map((o) => h("option", { value: o[0] })));
          const inp = h("input", { id, list: id + "l", autocomplete: "off" });
          let cur = ""; for (const o of opts) if (v !== null && v !== undefined && o[1] === v) cur = o[0];
          inp.value = cur || (v ?? "");
          cell.append(inp, dl);
          w = { el: inp, get: () => { const t2 = inp.value.trim(); const o = opts.find((x) => x[0] === t2); return o ? o[1] : (t2 || null); },
            set: (val) => { const o = opts.find((x) => x[1] === val); inp.value = o ? o[0] : (val ?? ""); } };
        } else {
          const sel = h("select", { id }, (opts.some((o) => o[0] === "") ? [] : [h("option", { value: "" }, "")]),
            opts.map((o, i) => h("option", { value: String(i) }, o[0])));
          const idx = opts.findIndex((o) => v !== null && v !== undefined && (o[1] === v || String(o[1]) === String(v)));
          sel.value = idx >= 0 ? String(idx) : "";
          if (idx < 0) { const e0 = opts.findIndex((o) => o[0] === ""); if (e0 >= 0) sel.value = String(e0); }
          cell.append(sel);
          w = { el: sel, get: () => sel.value === "" ? null : opts[+sel.value][1],
            getLabel: () => sel.value === "" ? "" : opts[+sel.value][0],
            set: (val) => { const i = opts.findIndex((o) => o[1] === val); sel.value = i >= 0 ? String(i) : ""; } };
        }
      } else if (t === "check") {
        const cb = h("input", { type: "checkbox", id }); cb.checked = !!v && v !== "0";
        cell.append(h("label", { class: "chk big", for: id }, cb, " ", f.label));
        w = { el: cb, get: () => cb.checked ? 1 : 0, set: (val) => { cb.checked = !!val && val !== "0"; } };
      } else if (t === "multi") {
        const ta = h("textarea", { id, rows: Math.max(2, Math.round((f.height || 70) / 24)) });
        ta.value = v ?? "";
        cell.append(ta);
        w = { el: ta, get: () => ta.value.trim() || null, set: (val) => { ta.value = val ?? ""; } };
      } else if (t === "info") {
        if (f.label) cell.append(h("label", { class: "flab" }, f.label));
        const d = h("div", { class: "finfo" }, v ?? "");
        cell.append(d);
        w = { el: d, get: () => undefined, set: (val) => { d.textContent = val ?? ""; } };
      } else if (t === "date") {
        const inp = h("input", { id, type: "date" });
        inp.value = v ? String(v).slice(0, 10) : "";
        cell.append(inp);
        w = { el: inp, get: () => inp.value || null, set: (val) => { inp.value = val ? String(val).slice(0, 10) : ""; } };
      } else if (t === "time" || (t === "text" && TIME_KEYS.has(key))) {
        const dl = h("datalist", { id: id + "l" }, TIMES.map((x) => h("option", { value: x })));
        const inp = h("input", { id, list: id + "l", placeholder: "SS:MM", autocomplete: "off", inputmode: "numeric" });
        inp.value = v ?? "";
        cell.append(inp, dl);
        w = { el: inp, get: () => inp.value.trim() || null, set: (val) => { inp.value = val ?? ""; } };
      } else {
        const inp = h("input", { id, placeholder: f.hint || "", inputmode: t === "num" ? "decimal" : null, autocomplete: "off" });
        inp.value = t === "num" ? fin(v) : (v ?? "");
        cell.append(inp);
        w = { el: inp, get: () => inp.value, set: (val) => { inp.value = t === "num" ? fin(val) : (val ?? ""); } };
      }
      if (f.command && w.el) w.el.addEventListener("change", () => f.command(w.get(), this));
      this.w[key] = w;
    }
  }
  get() {
    const out = {};
    for (const f of this.fields) {
      const t = f.type || "text";
      if (t === "info" || t === "section") continue;
      const w = this.w[f.key];
      let v;
      if (t === "num") {
        try { v = num(w.get()); } catch { throw new Error(`Polje '${f.label}' mora biti broj.`); }
        if (f.min !== undefined && f.min !== null && v < f.min) throw new Error(`Polje '${f.label}' mora biti ≥ ${f.min}.`);
        if (f.max !== undefined && f.max !== null && v > f.max) throw new Error(`Polje '${f.label}' može biti najviše ${fq(f.max)}.`);
      } else if (t === "text" || t === "time") {
        v = (w.get() || "").trim() || null;
      } else v = w.get();
      if (v === "") v = null;
      if (f.required && (v === null || v === undefined || v === "" || (t === "num" && v <= 0 && f.positive)))
        throw new Error(`Polje '${f.label}' je obavezno.`);
      out[f.key] = v;
    }
    return out;
  }
}

export class FormDialog extends Dialog {
  constructor(title, fields, initial = {}, { columns = 1, width = null, okText = "Spremi", validate = null } = {}) {
    if (columns === 1 && fields.length > 8) columns = 2;
    super(title, { width: width || (columns === 1 ? 520 : columns === 2 ? 780 : 980) });
    this.validate = validate;
    this.form = new Form(fields, initial, columns);
    this.body.append(this.form.el);
    this.buttons(okText, () => this.ok());
  }
  ok() {
    try {
      const d = this.form.get();
      if (this.validate) this.validate(d);
      this.close(d);
    } catch (e) { this.err(e.message); }
  }
}

export function askForm(title, fields, initial = {}, opts = {}) {
  return new FormDialog(title, fields, initial, opts).show();
}

export function tableDialog(title, columns, rows, { info: infoText = null, width = 900 } = {}) {
  const d = new Dialog(title, { width });
  if (infoText) d.body.append(h("div", { class: "msg pre" }, infoText));
  const t = new Table(columns, { height: 14 });
  t.setRows(rows);
  d.body.append(t.el);
  d.buttons(null, null, "Zatvori");
  d.bar.prepend(btn("Izvoz CSV", () => t.exportCsv(title), "ghost"));
  return d.show();
}

// ---------------------------------------------------------------- stranica
export class Page {
  static title = "";
  static subtitle = "";
  constructor(app) {
    this.app = app;
    this.el = h("div", { class: "page" });
    this.tb = h("div", { class: "toolbar" });
    this.tbRight = h("div", { class: "tb-right" });
    this.content = h("div", { class: "content" });
    const C = this.constructor;
    this.el.append(h("div", { class: "page-head" }, h("h1", {}, C.title), C.subtitle ? h("div", { class: "sub" }, C.subtitle) : null),
      this.tb, this.content);
    this.tb.append(this.tbRight);
    this.built = false;
  }
  get db() { return this.app.db; }
  build() {}
  refresh() {}
  tbtn(text, fn, kind = "primary", right = false) {
    const b = btn(text, async () => { try { await fn(); } catch (e) { this.err(e); } }, kind);
    if (right) this.tbRight.append(b); else this.tb.insertBefore(b, this.tbRight);
    return b;
  }
  search(table) {
    const s = h("input", { class: "search", placeholder: "🔍 Traži…", oninput: () => table.setFilter(s.value) });
    this.tbRight.append(s);
    return s;
  }
  need(table, what = "stavku") {
    const id = table.selectedId();
    if (id === null) { info(`Najprije odaberite ${what} u tablici.`); return null; }
    return id;
  }
  err(e) { console.error(e); error(e instanceof Error ? e.message : String(e)); }
}

// Kraći pristup Pythonu za stranice: this.app.db.items() itd. (vidi main.js)
export function dbProxy() {
  return new Proxy({}, { get: (_, name) => (...args) => py.call("db." + String(name), ...args) });
}
