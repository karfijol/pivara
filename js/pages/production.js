// Proizvodnja i prodaja: recepture, planer fermentora, šarže, kegovi, kupci i otpremnice, trošarine, sljedivost.
// Preneseno iz app.py (RecipesPage, BrewPreview, BatchesPage, KegsPage) i extras_ui.py (PlannerPage, SalesPage,
// DeliveryDialog, ExcisePage, RecallPage, ReadingsDialog, naljepnice).
import {
  h, btn, Page, Table, Form, Dialog, askForm, confirm, info, error, toast, tableDialog,
  fq, money, fin, num, d2ui, today, addDays, daysLeft, sg, EPS, setLabel,
} from "../ui.js";

// ---------------------------------------------------------------- zajedničko
// operateri na HACCP evidencijama (Postavke HACCP); kuhanje i pakiranje imaju svog operatera
const opDoc = (db) => db.get_setting("haccp_doc_operator") || db.get_setting("default_operator");
const opBrew = (db) => db.get_setting("haccp_brew_operator") || db.get_setting("default_operator");
let CONSTS = null;
function K(app) {
  if (!CONSTS) CONSTS = app.py.call("web_extras.consts");
  return CONSTS;
}

// HACCP dijalozi (haccp.js, piše drugi razvojni programer) – poziv u trenutku izvođenja
function haccpFn(app, name) {
  const m = (app.modules && app.modules.haccp) || null;
  const f = m && m[name];
  if (typeof f !== "function") {
    toast(`HACCP obrazac (${name}) trenutno nije dostupan – unesite zapis na ekranu HACCP evidencije.`);
    return null;
  }
  return f;
}
async function callHaccp(app, name, ...args) {
  const f = haccpFn(app, name);
  if (!f) return null;
  try { return await f(app, ...args); } catch (e) { console.error(e); error(e); return null; }
}

// Tablica s puno stupaca na mobitelu se pomiče vodoravno umjesto da se stupci stisnu
function T(columns, opts = {}) {
  const t = new Table(columns, opts);
  const sum = columns.reduce((a, c) => a + (c[2] || 100), 0);
  t.table.style.minWidth = `${Math.round(sum * 0.6)}px`;
  return t;
}
// osnovna veličina kega (18 L) i količina piva u punom kegu (17 L) – Postavke
function kegSize(p) { return parseFloat(String(p.db.get_setting("keg_size_l") || 18).replace(",", ".")) || 18; }
function kegFill(p) { return parseFloat(String(p.db.get_setting("keg_fill_l") || 17).replace(",", ".")) || 17; }
// polja za količinu piva po kegu kod punjenja: svaki 17 L, zadnji (i svaki drugi) može se upisati ručno
function fillFields(p, ids, fields) {
  const full = kegFill(p);
  const kegs = ids.map((i) => p.db.one("SELECT id, code, size_l FROM kegs WHERE id=?", [i])).sort((a, b) => a.code.localeCompare(b.code, "hr", { numeric: true }));
  ids.splice(0, ids.length, ...kegs.map((k) => k.id));
  fields.push({ label: `Količina piva u kegovima (L) – svaki keg ${fq(full)} L; zadnji keg ili bilo koji drugi upišite ručno ako nije pun`, type: "section" });
  kegs.forEach((k, n) => fields.push({ key: "l_" + k.id, label: `${k.code}${n === kegs.length - 1 && kegs.length > 1 ? " – zadnji keg" : ""}`,
    type: "num", required: true, positive: true, max: k.size_l || undefined, default: k.size_l ? Math.min(full, k.size_l) : full }));
}
// dva stupca (omjer kao u desktopu), na uskom ekranu jedan ispod drugog
function split(a, b, wa = 2, wb = 3) {
  return h("div", { class: "row", style: { gap: "12px", alignItems: "flex-start" } },
    h("div", { style: { flex: `${wa} 1 320px`, minWidth: 0 } }, a),
    h("div", { style: { flex: `${wb} 1 420px`, minWidth: 0 } }, b));
}

function itemOpts(db, chemicals = null) {
  return db.items(chemicals).map((i) => [`${i.name} (${i.unit})`, i.id, i.unit, i.price]);
}

const SVGNS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  if (text !== null) e.textContent = text;
  return e;
}
const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 864e5);
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// ---------------------------------------------------------------- LinesDialog (ui.py) – zaglavlje + stavke
const dec = (x) => String(+(+x).toFixed(6)).replace(".", ",");
export class LinesDialog extends Dialog {
  // stavke se uređuju izravno u retku: artikl, količina (i cijena), ✕ za uklanjanje
  constructor(title, headerFields, headerInitial, opts, lines, { withPrice = false, qtyLabel = "Količina", width = 860, stages = false, headerCols = null } = {}) {
    super(title, { width });
    this.itemOpts = opts; // [[label, item_id, unit, price]]
    this.withPrice = withPrice;
    this.qtyLabel = qtyLabel;
    this.stages = stages; // receptura: faza (po kuhanju / za fermentor), vrijeme i jedinica (kg, g, kom, pakiranje)
    this.unitMap = stages ? (window.APP ? window.APP.py.call("web_units.all_units") : {}) : null;
    this.hopIds = new Set(stages && window.APP ? window.APP.py.call("web_brew.hop_ids") : []);
    this.form = new Form(headerFields, headerInitial || {}, headerCols || (headerFields.length > 6 ? 3 : 2));
    this.body.append(this.form.el, h("div", { class: "sec", style: { marginTop: "10px" } }, stages ? "Sastojci" : "Stavke"),
      h("div", { class: "muted", style: { fontSize: "12.5px", margin: "-2px 0 6px" } }, stages
        ? "Kao u BeerSmithu: svaki dodatak hmelja je zaseban redak (isti hmelj može biti više puta). „Po kuhanju” = količina za JEDNO kuhanje; "
          + "„Za fermentor” = za cijeli fermentor (kvasac, dry hop, voće…). VRIJEME: za kuhanje = koliko minuta se dodatak kuha "
          + "(kuhanje 90 min: hmelj 90 = na početku, 10 = 10 min prije kraja, 0 = na kraju; Whirlfloc npr. 15); za fermentor = dan nakon kuhanja (dry hop)."
        : "Svaku stavku možete promijeniti izravno u retku (artikl i količinu); ✕ uklanja stavku."));
    this.list = h("div", { class: "ln-ed" });
    this.sum = h("div", { class: "muted", style: { fontSize: "12.5px", margin: "4px 0" } });
    this.body.append(this.list, h("div", { class: "row gap", style: { marginTop: "6px", alignItems: "center" } },
      btn("＋ Dodaj stavku", () => this.addRow()), this.sum));
    this.lines = (lines || []).map((ln) => ({ item_id: ln.item_id, qty: ln.qty, unit_price: ln.unit_price || 0, name: ln.name, unit: ln.unit,
      stage: ln.stage === "ferm" ? "ferm" : "brew", add_min: ln.add_min ?? null, qty_unit: ln.qty_unit || null, alpha_adj: ln.alpha_adj ?? null,
      _q: ln.qty != null ? dec(ln.qty) : "", _p: ln.unit_price != null ? dec(ln.unit_price) : "", _m: ln.add_min != null ? String(ln.add_min) : "" }));
    this.render();
    this.buttons("Spremi", () => this.ok());
  }
  optOf(itemId) { return this.itemOpts.find((o) => o[1] === itemId); }
  render() {
    this.list.innerHTML = "";
    const head = [h("span", {}, "Artikl"), h("span", {}, this.qtyLabel), h("span", {}, "Jed.")];
    if (this.withPrice) head.push(h("span", {}, "Cijena €/jed."));
    if (this.stages) head.push(h("span", {}, "Faza"), h("span", { title: "Kuhanje: koliko minuta se kuha (90 = od početka kuhanja od 90 min, 0 = na kraju) · fermentor: dan nakon kuhanja" }, "Vrijeme"),
      h("span", { title: "Korekcija količine hmelja prema alfa kiselinama LOT-a – uključite za svaki dodatak po volji" }, "α kor."));
    head.push(h("span", {}));
    const cls = "ln-r" + (this.withPrice ? " wp" : "") + (this.stages ? " st" : "");
    this.list.append(h("div", { class: cls + " ln-h" }, ...head));
    this.lines.forEach((ln, i) => {
      const known = this.optOf(ln.item_id);
      const sel = h("select", {}, h("option", { value: "" }, "– odaberite artikl –"),
        !known && ln.item_id != null ? h("option", { value: "x" }, ln.name || "?") : null,
        this.itemOpts.map((o, k) => h("option", { value: String(k) }, o[0])));
      sel.value = known ? String(this.itemOpts.indexOf(known)) : (ln.item_id != null ? "x" : "");
      const unitLbl = (u) => (u === "pak" ? "pakiranje" : u);
      let unit;
      if (this.stages) {
        unit = h("select", { class: "ln-unit", title: "Jedinica količine (zaliha se vodi u osnovnoj jedinici artikla)" });
        const fillUnits = () => {
          const base = known ? known[2] : ln.unit;
          const opts = (this.unitMap && ln.item_id != null && this.unitMap[String(ln.item_id)]) || [base || "kg"];
          unit.innerHTML = "";
          for (const u of opts) unit.append(h("option", { value: u }, unitLbl(u)));
          if (!ln.qty_unit || !opts.includes(ln.qty_unit)) ln.qty_unit = opts[0];
          unit.value = ln.qty_unit;
        };
        fillUnits();
        unit.addEventListener("change", () => { ln.qty_unit = unit.value; });
        this._fillUnits = this._fillUnits || new Map();
        this._fillUnits.set(ln, fillUnits);
      } else unit = h("span", { class: "muted" }, known ? known[2] || "" : ln.unit || "");
      sel.addEventListener("change", () => {
        if (sel.value === "x") return;
        const o = sel.value === "" ? null : this.itemOpts[+sel.value];
        ln.item_id = o ? o[1] : null; ln.unit = o ? o[2] : "";
        if (this.stages) { ln.qty_unit = null; this._fillUnits.get(ln)(); ln.alpha_adj = null; this.render(); return; } else unit.textContent = ln.unit || "";
        if (o && this.withPrice && !ln._p) { ln._p = dec(o[3] || 0); if (pr) pr.value = ln._p; }
        this.upd();
        q.focus();
      });
      const q = h("input", { value: ln._q, inputmode: "decimal", style: { textAlign: "right" } });
      q.addEventListener("input", () => { ln._q = q.value; this.upd(); });
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (i === this.lines.length - 1) this.addRow(); } });
      const pr = this.withPrice ? h("input", { value: ln._p, inputmode: "decimal", style: { textAlign: "right" } }) : null;
      if (pr) pr.addEventListener("input", () => { ln._p = pr.value; this.upd(); });
      const del = btn("✕", () => { this.lines.splice(i, 1); this.render(); }, "ghost");
      del.title = "Ukloni stavku";
      let stSel = null, mi = null, adjCb = null, adjUpd = () => {};
      if (this.stages) {
        stSel = h("select", {}, h("option", { value: "brew" }, "Po kuhanju"), h("option", { value: "ferm" }, "Za fermentor"));
        stSel.value = ln.stage || "brew";
        const ph = () => (ln.stage === "ferm" ? "dan" : "min");
        mi = h("input", { value: ln._m || "", inputmode: "numeric", placeholder: ph(), style: { textAlign: "right" },
          title: "Kuhanje: koliko minuta se kuha (= trajanje kuhanja → dodaje se na početku; 0 = na kraju). Fermentor: dan nakon kuhanja (dry hop)." });
        stSel.addEventListener("change", () => { ln.stage = stSel.value; mi.placeholder = ph(); this.upd(); adjUpd(); });
        mi.addEventListener("input", () => { ln._m = mi.value; if (ln._autoAdj || ln.alpha_adj == null) { ln._autoAdj = true; adjUpd(true); } });
        // α korekcija (samo hmelj u kuhanju): po volji uključeno/isključeno; zadano kad se tek upisuje = kuha se ≥ 30 min
        adjCb = h("input", { type: "checkbox", title: "Korekcija količine prema alfa kiselinama LOT-a" });
        const isHop = () => ln.item_id != null && this.hopIds.has(ln.item_id) && ln.stage !== "ferm";
        adjUpd = (auto = false) => {
          adjCb.disabled = !isHop();
          if (!isHop()) { adjCb.checked = false; return; }
          if (ln.alpha_adj == null || auto) { const t = String(ln._m ?? "").trim(); adjCb.checked = t === "" || num(t) >= 30; if (auto) ln.alpha_adj = adjCb.checked ? 1 : 0; }
          else adjCb.checked = !!ln.alpha_adj;
        };
        adjCb.addEventListener("change", () => { ln.alpha_adj = adjCb.checked ? 1 : 0; ln._autoAdj = false; });
        adjUpd();
      }
      this.list.append(h("div", { class: cls }, sel, q, unit, pr, stSel, mi,
        adjCb ? h("label", { class: "chk ln-adj", title: "α korekcija" }, adjCb, h("span", { class: "ln-adj-t" }, " α")) : null, del));
    });
    if (!this.lines.length) this.list.append(h("div", { class: "muted", style: { padding: "6px 2px" } }, "Još nema stavki – kliknite „Dodaj stavku”."));
    this.upd();
  }
  addRow() {
    this.lines.push({ item_id: null, qty: 0, unit_price: 0, _q: "", _p: "", stage: "brew", _m: "" });
    this.render();
    const sels = this.list.querySelectorAll(".ln-r:not(.ln-h) select");
    sels[sels.length - 1]?.focus();
  }
  upd() {
    const n = this.lines.filter((l) => l.item_id != null).length;
    let tot = 0;
    if (this.withPrice) for (const l of this.lines) { try { tot += num(l._q || 0) * num(l._p || 0); } catch { /* */ } }
    this.sum.textContent = this.stages
      ? `${this.lines.filter((l) => l.item_id != null && l.stage !== "ferm").length} po kuhanju · ${this.lines.filter((l) => l.item_id != null && l.stage === "ferm").length} za fermentor`
      : `${n} stavki` + (this.withPrice ? ` · ukupno ${money(tot)}` : "");
  }
  ok() {
    let head;
    try { head = this.form.get(); } catch (e) { return this.err(e.message); }
    const out = [], seen = new Set();
    for (const [i, l] of this.lines.entries()) {
      if (l.item_id == null && !String(l._q || "").trim()) continue; // prazan redak
      if (l.item_id == null) return this.err(`Redak ${i + 1}: odaberite artikl.`);
      let q, p = 0;
      try { q = num(l._q); if (this.withPrice) p = num(l._p || 0); } catch { return this.err(`Redak ${i + 1}: količina i cijena moraju biti brojevi.`); }
      if (!(q > 0)) return this.err(`Redak ${i + 1}: upišite količinu veću od 0.`);
      const key = this.stages ? `${l.item_id}|${l.stage || "brew"}|${String(l._m ?? "").trim()}` : l.item_id;
      if (seen.has(key)) return this.err(`Artikl „${this.optOf(l.item_id)?.[0] || l.name}” upisan je dvaput${this.stages ? " s istim vremenom" : ""} – spojite ga u jedan redak.`);
      seen.add(key);
      const row = { item_id: l.item_id, qty: q, unit_price: p };
      if (this.stages) {
        row.stage = l.stage === "ferm" ? "ferm" : "brew";
        row.qty_unit = l.qty_unit || null;
        if (row.stage === "brew" && this.hopIds.has(l.item_id)) {
          const t = String(l._m ?? "").trim();
          row.alpha_adj = l.alpha_adj != null ? (l.alpha_adj ? 1 : 0) : ((t === "" || num(t) >= 30) ? 1 : 0);
        } else row.alpha_adj = null;
        const m = String(l._m ?? "").trim();
        if (m !== "") {
          const mv = Math.round(num(m));
          if (!(mv >= 0)) return this.err(`Redak ${i + 1}: vrijeme mora biti broj (minute kuhanja ili dan za fermentor).`);
          row.add_min = mv;
        } else row.add_min = null;
      }
      out.push(row);
    }
    if (!out.length) return this.err("Dodajte barem jednu stavku.");
    if (this.validate) { const e = this.validate(head, out); if (e) return this.err(e); }
    this.close([head, out]);
  }
}

// ---------------------------------------------------------------- naljepnice (app.KegsPage.labels, extras_ui.print_beer_labels)
async function labelsMissingOk(app, missing, title) {
  if (!missing || !missing.length) return true;
  return confirm("Nedostaju obvezni podaci:\n\n" + missing.slice(0, 12).join("\n") + (missing.length > 12 ? "\n…" : "")
    + "\n\nIspisati ipak (prazna polja ostaju za ručni upis)?", title);
}

export async function printKegLabels(app, ids) {
  const db = app.db;
  if (!ids || !ids.length) { await info("Označite kegove (Ctrl/Shift za više; na mobitelu dodirom).", "Naljepnice"); return null; }
  const fmts = K(app).FLAG_FORMATS;
  const g = (k) => db.get_setting(k);
  const cur = g("label_format") || fmts[0];
  const d = await askForm("Ispis naljepnica", [
    { key: "fmt", label: "Vrsta naljepnice", type: "combo", options: fmts, default: fmts.includes(cur) ? cur : fmts[0] },
    { key: "blank_lot", label: "LOT ostavi prazan (upisati ručno)", type: "check", default: g("label_blank_lot") === "1" ? 1 : 0 },
    { key: "blank_keg", label: "Broj kega ostavi prazan (upisati ručno)", type: "check", default: g("label_blank_keg") === "1" ? 1 : 0 },
    { key: "blank_dates", label: "Datum punjenja i rok ostavi prazne", type: "check", default: g("label_blank_dates") === "1" ? 1 : 0 }],
  {}, { okText: "Ispiši", width: 600 });
  if (!d) return null;
  const fmt = d.fmt || fmts[0];
  db.set_setting("label_format", fmt);
  for (const k of ["blank_lot", "blank_keg", "blank_dates"]) db.set_setting("label_" + k, d[k] ? "1" : "0");
  const opts = { blank_lot: d.blank_lot, blank_keg: d.blank_keg, blank_dates: d.blank_dates };
  try {
    const miss = app.py.call("web_extras.keg_labels_missing", ids, opts);
    if (!(await labelsMissingOk(app, miss, fmt === fmts[2] ? "Naljepnice – nedostaju podaci" : "Zastavice – nedostaju podaci"))) return null;
  } catch (e) { error(e); return null; }
  const p = await app.doc("web_extras.keg_labels", ids, fmt, opts);
  if (p) app.toast(`Naljepnice za ${ids.length} keg(ov)a spremljene.`);
  return p;
}

export async function printBeerLabels(app) {
  const db = app.db;
  const recs = db.recipes();
  if (!recs.length) { await info("Nema receptura.", "Naljepnice"); return null; }
  const names = recs.map((r) => r.name);
  const fmts = K(app).FLAG_FORMATS;
  const cur = db.get_setting("label_format") || fmts[0];
  const nets = ["17 L", "18 L", "20 L", "30 L", "prazno (upisati ručno)"];
  const d = await askForm("Naljepnice po vrsti piva (za ručni upis)", [
    { key: "info", label: "", type: "info", default: "Datum punjenja, rok, LOT i broj kega ostaju prazni – upisuju se olovkom." },
    { key: "beers", label: "Piva", type: "multicheck", options: names, per_row: 3, default: names },
    { key: "copies", label: "Komada po pivu", type: "num", default: 8, min: 1 },
    { key: "net", label: "Neto količina", type: "combo", options: nets, default: nets[0] },
    { key: "fmt", label: "Vrsta naljepnice", type: "combo", options: fmts, default: fmts.includes(cur) ? cur : fmts[0] }],
  {}, { okText: "Ispiši", width: 640 });
  if (!d || !d.beers || !d.beers.length) return null;
  const fmt = d.fmt || fmts[0];
  const net = d.net || nets[0];
  db.set_setting("label_format", fmt);
  const size = net.startsWith("prazno") ? null : parseFloat(net.split(" ")[0]);
  const copies = Math.max(1, Math.trunc(d.copies || 1));
  try {
    const miss = app.py.call("web_extras.beer_labels_missing", d.beers, copies, size);
    if (!(await labelsMissingOk(app, miss, fmt === fmts[2] ? "Naljepnice – nedostaju podaci" : "Zastavice – nedostaju podaci"))) return null;
  } catch (e) { error(e); return null; }
  const n = recs.filter((r) => d.beers.includes(r.name)).length * copies;
  const p = await app.doc("web_extras.beer_labels", d.beers, copies, size, fmt);
  if (p) app.toast(`Spremljeno ${n} naljepnica: ${String(p).split("/").pop()}`);
  return p;
}

// ================================================================== Recepture
class RecipesPage extends Page {
  static title = "Recepture";
  static subtitle = "Sastav po šarži – koristi se za automatsko skidanje sirovina pri kuhanju";

  build() {
    this.tbtn("＋ Nova receptura", () => this.new());
    this.tbtn("Uredi", () => this.edit(), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.table = T([["name", "Naziv", 200, "w"], ["code", "Oznaka", 65, "center"], ["style", "Stil", 120, "w"],
      ["brew", "Kuhanje", 100, "e"], ["size", "Fermentor (L)", 95, "e"], ["boil", "Kuhanje min", 85, "e"], ["n", "Sastojaka", 80, "center"], ["b", "Šarži", 70, "center"]],
    { onDouble: () => this.edit(), onSelect: () => this.showLines() });
    this.lines = T([["name", "Sastojak", 220, "w"], ["stage", "Faza", 110, "w"], ["qty", "Količina", 90, "e"], ["unit", "Jed.", 50, "center"],
      ["stock", "Na zalihi", 90, "e"], ["brews", "Dovoljno za", 120, "e"]]);
    this.search(this.table);
    this.content.append(split(this.table.el, this.lines.el));
  }

  refresh() {
    this.table.setRows(this.db.recipes().map((r) => ({ id: r.id, name: r.name, code: this.db.recipe_code(r.id), style: r.style || "",
      brew: `${fq(r.brew_size_l || r.batch_size_l)} L × ${r.brews || 1}`, size: fq(r.batch_size_l), boil: r.boil_min || 60, n: r.n_items, b: r.n_batches })));
    this.showLines();
  }

  showLines() {
    const id = this.table.selectedId();
    const rows = [];
    if (id) {
      const r = this.db.recipe(id);
      const tot = Object.fromEntries(this.db.scaled_needs(id, r.batch_size_l).map((x) => [x.item_id, x.need]));
      for (const ln of this.db.recipe_lines(id)) {
        const st = this.db.stock(ln.item_id);
        const n = tot[ln.item_id] ? Math.trunc(st / tot[ln.item_id] + 1e-9) : 0;
        rows.push({ id: ln.id, name: ln.name, stage: ln.stage === "ferm" ? "za fermentor" + (ln.add_min ? ` · dan ${ln.add_min}` : "") : "po kuhanju" + (ln.add_min != null ? ` · ${ln.add_min} min` : (ln.category === "Hmelj" ? ` · ${r.boil_min || 60} min` : ""))
            + (ln.category === "Hmelj" && ln.stage !== "ferm" && (ln.alpha_adj != null ? ln.alpha_adj : ((ln.add_min ?? (r.boil_min || 60)) >= 30)) ? " · α" : ""),
          qty: fq(ln.qty_in), unit: ln.qty_unit === "pak" ? "pakiranje" : ln.qty_unit, stock: `${fq(st)} ${ln.unit}`, brews: `${n} fermentor${n === 1 ? "" : "a"}`,
          _tag: n < 1 ? "bad" : (n < 2 ? "warn" : "") });
      }
    }
    this.lines.setRows(rows);
  }

  dialog(title, r = null, lines = [], recipeId = null) {
    const r0 = r || {};
    const d = new LinesDialog(title, [
      { label: "Osnovno", type: "section" },
      { key: "name", label: "Naziv piva", required: true }, { key: "style", label: "Stil" },
      { key: "code", label: "Oznaka za LOT (2 slova, npr. PA, IP, ST)" },
      { key: "brew_size_l", label: "Volumen jednog kuhanja (L)", type: "num", required: true, positive: true, default: 125 },
      { key: "brews", label: "Broj kuhanja po fermentoru", type: "num", required: true, positive: true, default: 2 },
      { key: "ferm_info", label: "Fermentor (šarža = jedan LOT piva)", type: "info", default: "" },
      { label: "Postupak kuhanja (alarmi na danu kuhanja)", type: "section" },
      { key: "boil_min", label: "Trajanje kuhanja (min)", type: "num", min: 1, default: 60 },
      { key: "lauter_min", label: "Cijeđenje i ispiranje (min)", type: "num", min: 0, default: 45 },
      { key: "whirl_min", label: "Whirlpool / odmor (min)", type: "num", min: 0, default: 15 },
      { key: "cool_temp", label: "Hlađenje na (°C)", type: "num", min: 0 },
      { label: "Ciljne vrijednosti", type: "section" },
      { key: "target_og", label: "Ciljni OG (npr. 1,050)", type: "num", min: 0 },
      { key: "target_fg", label: "Ciljni FG (npr. 1,010)", type: "num", min: 0 },
      { key: "target_ferm_temp", label: "Temperatura fermentacije (°C)", type: "num", min: 0 },
      { key: "ferm_days", label: "Dana u fermentoru (za planer)", type: "num", min: 1, default: 14 },
      { label: "Etiketa", type: "section" },
      { key: "official_abv", label: "Alkohol – službena analiza (% vol)", type: "num", min: 0 },
      { key: "allergens", label: "Alergeni (prazno = automatski)" },
      { key: "label_ingredients", label: "Sastojci (prazno = automatski)" },
      { key: "label_color", label: "Boja zastavice (prazno = prema vrsti piva)", type: "combo", editable: true,
        options: [""].concat(K(this.app).LABEL_COLORS) },
      { key: "note", label: "Napomena (vidi se na danu kuhanja)", type: "multi", full: true }],
    { ...r0, brew_size_l: r0.brew_size_l || r0.batch_size_l || 125, brews: r0.brews || (recipeId ? 1 : 2), boil_min: r0.boil_min || 60,
      lauter_min: r0.lauter_min ?? 45, whirl_min: r0.whirl_min ?? 15 },
    itemOpts(this.db), lines, { qtyLabel: "Količina", stages: true, width: 980, headerCols: 3 });
    d.validate = (head, out) => {
      const boil = Math.round(head.boil_min || 60);
      const bad = out.filter((l) => l.stage !== "ferm" && l.add_min != null && l.add_min > boil);
      if (bad.length) return `Vrijeme kuhanja ne može biti dulje od trajanja kuhanja (${boil} min): ${bad.map((l) => (this.db.item(l.item_id) || {}).name || "").join(", ")}.`;
      return null;
    };
    const fw = d.form.w;
    const fermInfo = () => { try { fw.ferm_info.set(`${fq((num(fw.brew_size_l.get()) || 0) * (Math.round(num(fw.brews.get())) || 1), 1)} L = ${fw.brews.get() || 1} × ${fw.brew_size_l.get() || 0} L`); } catch { /* */ } };
    for (const k of ["brew_size_l", "brews"]) fw[k].el.addEventListener("input", fermInfo);
    fermInfo();
    // koraci ukomljavanja (svaki s alarmom na danu kuhanja)
    let mash = recipeId ? (this.app.py.call("web_brew.recipe_extra", recipeId).mash_steps || []) : [{ name: "Ukomljavanje", temp: 67, min: 60 }];
    if (!mash.length) mash = [{ name: "Ukomljavanje", temp: null, min: 60 }];
    mash = mash.map((x) => ({ ...x }));
    const mashBox = h("div", { class: "mash-ed" });
    const renderMash = () => {
      mashBox.innerHTML = "";
      mash.forEach((m, i) => {
        const nm = h("input", { value: m.name || "", placeholder: "npr. Ukomljavanje" });
        const tp = h("input", { value: m.temp != null ? String(m.temp).replace(".", ",") : "", inputmode: "decimal", placeholder: "°C", style: { textAlign: "right" } });
        const mn = h("input", { value: m.min != null ? String(m.min) : "", inputmode: "numeric", placeholder: "min", style: { textAlign: "right" } });
        nm.oninput = () => { m.name = nm.value; }; tp.oninput = () => { m.temp = tp.value; }; mn.oninput = () => { m.min = mn.value; };
        mashBox.append(h("div", { class: "mash-r" }, nm, tp, h("span", { class: "muted" }, "°C"), mn, h("span", { class: "muted" }, "min"),
          btn("✕", () => { mash.splice(i, 1); renderMash(); }, "ghost")));
      });
    };
    renderMash();
    d.body.append(h("div", { class: "sec", style: { marginTop: "10px" } }, "Koraci ukomljavanja"), mashBox,
      h("div", { class: "row gap", style: { margin: "6px 0" } }, btn("＋ Dodaj korak", () => { mash.push({ name: "", temp: null, min: 10 }); renderMash(); }, "ghost")));
    d._mash = mash;
    // raspored hmelja (minute kuhanja, dry hop) dio je recepture
    const hopInfo = h("span", { class: "muted", style: { fontSize: "12.5px" } });
    const hopSum = () => {
      if (!recipeId) { hopInfo.textContent = "Raspored hmelja upisuje se nakon prvog spremanja recepture."; return; }
      try {
        const pl = this.app.py.callKw("web_more.hop_plan", [], { recipe_id: recipeId });
        const n = pl.rows.filter((x) => x.stage === "boil").length, dn = pl.rows.filter((x) => x.stage === "dry").length;
        hopInfo.textContent = !pl.hops.length ? "Receptura nema hmelja." : `Kuhanje ${pl.boil_min} min: ${n} dodavanja · dry hop: ${dn}`
          + (dn ? (pl.dry.on ? ` (podsjetnik ${pl.dry.days}. dan u ${pl.dry.time})` : " (podsjetnik isključen)") : "");
      } catch { hopInfo.textContent = ""; }
    };
    const hopBtn = btn("🌿 Alfa kiseline i dry hop podsjetnik", async () => {
      if (await hopEditor(this.app, { recipeId })) {
        // α korekcija promijenjena u rasporedu: osvježi kvačice u retcima ovog prozora (da ih „Spremi” ne vrati)
        const fresh = this.db.recipe_lines(recipeId);
        for (const l of d.lines) {
          const f = fresh.find((x) => x.item_id === l.item_id && (x.stage === "ferm" ? "ferm" : "brew") === (l.stage || "brew")
            && String(x.add_min ?? "") === String(l._m ?? "").trim());
          if (f && f.alpha_adj != null) l.alpha_adj = f.alpha_adj;
        }
        d.render();
        toast("Spremljeno."); hopSum();
      }
    }, "ghost");
    if (!recipeId) hopBtn.disabled = true;
    d.body.append(h("div", { class: "sec", style: { marginTop: "10px" } }, "Hmeljenje"),
      h("div", { class: "row gap", style: { flexWrap: "wrap", alignItems: "center" } }, hopBtn, hopInfo),
      recipeId ? h("div", { class: "muted", style: { fontSize: "12px" } }, "Raspored koristi spremljene sastojke – novi hmelj dodan gore pojavit će se nakon spremanja recepture.") : null);
    hopSum();
    return d.show().then((res) => (res ? [res[0], res[1], d._mash] : null));
  }

  // spremanje recepture: volumen kuhanja / broj kuhanja promijenjen -> ponudi preračun količina
  async saveRecipe(res, id = null) {
    const [head, lines, mash] = res;
    delete head.ferm_info;
    head.brews = Math.max(1, Math.round(head.brews || 1));
    for (const k of ["cool_temp", "target_og", "target_fg", "target_ferm_temp", "official_abv"]) if (!head[k]) head[k] = null;
    if (id) {
      const old = this.db.recipe(id);
      const obs = old.brew_size_l || old.batch_size_l, ofs = old.batch_size_l;
      const nbs = head.brew_size_l, nfs = head.brew_size_l * head.brews;
      if (lines.length && (Math.abs(obs - nbs) > 1e-6 || Math.abs(ofs - nfs) > 1e-6)
        && await confirm(`Promijenjen je volumen kuhanja ili broj kuhanja (kuhanje ${fq(obs)} → ${fq(nbs)} L, fermentor ${fq(ofs)} → ${fq(nfs)} L).\n\n`
          + "Preračunati količine sastojaka na nove volumene (po kuhanju × " + fq(nbs / obs, 3) + ", za fermentor × " + fq(nfs / ofs, 3) + ")?\n\n"
          + "„Ne” = količine ostaju kako ste ih upisali.", "Preračun recepture", { ok: "Preračunaj", cancel: "Ne" })) {
        // preračunavaju se samo sastojci koji su već bili u recepturi s istom količinom (novo upisani ostaju kako su upisani)
        const orig = new Set(this.db.recipe_lines(id).map((l) => `${l.item_id}|${l.stage === "ferm" ? "ferm" : "brew"}|${Math.round(l.qty_in * 10000)}`));
        for (const l of lines) {
          if (!orig.has(`${l.item_id}|${l.stage === "ferm" ? "ferm" : "brew"}|${Math.round(l.qty * 10000)}`)) continue;
          l.qty = Math.round(l.qty * (l.stage === "ferm" ? nfs / ofs : nbs / obs) * 10000) / 10000;
        }
      }
    }
    const rid = this.db.save_recipe(head, lines, id);
    this.app.py.call("web_brew.save_recipe_extra", rid || id, (mash || []).map((m) => ({ name: m.name, temp: m.temp, min: m.min })));
    return rid || id;
  }

  async new() {
    const res = await this.dialog("Nova receptura");
    if (res) {
      const id = await this.saveRecipe(res); this.app.refreshAll();
      if (id && await confirm("Receptura je spremljena. Upisati raspored hmelja (minute kuhanja, dry hop)?", "Hmeljenje", { ok: "Upiši raspored", cancel: "Kasnije" })
        && await hopEditor(this.app, { recipeId: id })) toast("Raspored hmelja spremljen.");
    }
  }

  async edit() {
    const id = this.need(this.table, "recepturu");
    if (!id) return;
    const res = await this.dialog("Uredi recepturu", this.db.recipe(id), this.db.recipe_lines(id).map((l) => ({ ...l, qty: l.qty_in, unit: l.qty_unit })), id);
    if (res) { await this.saveRecipe(res, id); this.app.refreshAll(); }
  }

  async delete() {
    const id = this.need(this.table, "recepturu");
    if (id && await confirm("Obrisati recepturu?", "Brisanje")) { this.db.delete_recipe(id); this.app.refreshAll(); }
  }
}

// ================================================================== Šarže
class BrewPreview extends Dialog {
  constructor(db, recipeId, volume, planned) {
    super("Pregled potrošnje sirovina (FIFO)", { width: 900 });
    const prev = db.preview_brew(recipeId, volume);
    this.short = prev.some((p) => p.missing > EPS);
    const r = db.recipe(recipeId);
    let msg = `${r.name} · ${fq(volume)} L  ·  Sirovine će se automatski skinuti sa skladišta iz najstarijih LOT-ova.`;
    if (this.short) msg += "\n⚠ Nedostaje sirovina – šaržu možete spremiti samo kao PLANIRANU (ulazi u izvještaj 'Što naručiti').";
    this.body.append(h("div", { class: "msg" }, msg));
    const t = T([["name", "Sastojak", 220, "w"], ["need", "Potrebno", 90, "e"], ["unit", "Jed.", 50, "center"],
      ["avail", "Na zalihi", 90, "e"], ["alloc", "Skida se iz LOT-ova (FIFO)", 330, "w"], ["st", "Status", 110, "w"]], { height: 12 });
    t.setRows(prev.map((p, n) => ({ id: n, name: p.name, need: fq(p.need), unit: p.unit, avail: fq(p.available),
      alloc: p.alloc.map((a) => `${a[1]}: ${fq(a[2])}`).join(", "),
      st: p.missing > EPS ? `Nedostaje ${fq(p.missing)}` : "OK", _tag: p.missing > EPS ? "bad" : "ok" })));
    this.body.append(t.el);
    if (planned) this.buttons("Spremi kao planirano", () => this.close(true));
    else if (this.short) this.buttons("Spremi kao planirano", () => this.close("planned"));
    else this.buttons("✔ Potvrdi kuhanje", () => this.close(true));
  }
  disableOk(text) {
    if (!this.okBtn) return;
    this.okBtn.disabled = true; this.okBtn.textContent = text; this.onEnter = null;
  }
}

// ================================================================== Raspored hmelja (kuhanje + dry hop)
// opts: { batchId } ili { recipeId }; vraća spremljeni plan ili null
export async function hopEditor(app, opts) {
  const py = app.py;
  const plan = py.call("web_more.hop_plan", opts.batchId || null, opts.recipeId || null);
  if (!plan.hops.length) { await info("Receptura nema hmelja (kategorija „Hmelj”)."); return null; }
  const d = new Dialog(`Hmeljenje – ${plan.recipe}`, { width: 760 });
  const rows = plan.rows.map((r) => ({ ...r }));
  const ro = !opts.batchId; // receptura: hmelj, količine i vremena upisuju se u sastojcima recepture
  const boil = h("input", { value: String(plan.boil_min), inputmode: "numeric", style: { width: "70px", textAlign: "right" } });
  const list = h("div", { class: "hop-ed" });
  const sum = h("div", { class: "muted", style: { fontSize: "12.5px", margin: "4px 0" } });
  const hopOpts = plan.hops.map((x) => [x.name, x.item_id]);
  const render = () => {
    list.innerHTML = "";
    list.append(h("div", { class: "hop-r hop-h" }, h("span", {}, "Hmelj"), h("span", {}, "Upotreba"), h("span", { title: "Kuhanje: koliko minuta se hmelj kuha (= trajanje kuhanja → na početku; 0 = na kraju) · dry hop: dan nakon kuhanja" }, "Vrijeme"), h("span", { title: "Kuhanje: g po jednom kuhanju · dry hop: g za cijeli fermentor" }, "Količina (g)"),
      h("span", { title: "Korigiraj količinu prema alfa kiselinama LOT-a (dodaci za gorčinu)" }, "α korekcija"), h("span", {})));
    rows.forEach((r, i) => {
      const hs = h("select", {}, hopOpts.map(([l, v]) => h("option", { value: String(v) }, l)));
      hs.value = String(r.item_id);
      const st = h("select", {}, h("option", { value: "boil" }, "Kuhanje"), h("option", { value: "dry" }, "Dry hop (fermentor)"));
      st.value = r.stage;
      const mn = h("input", { value: r.stage === "dry" ? (r.min ? String(r.min) : "") : String(r.min), inputmode: "numeric",
        placeholder: r.stage === "dry" ? "dan" : "min", title: r.stage === "dry" ? "Dan nakon kuhanja" : "Minuta kuhanja (koliko dugo se hmelj kuha)", style: { textAlign: "right" } });
      const g = h("input", { value: fq(r.g, 1), inputmode: "decimal", style: { textAlign: "right" } });
      const adj = h("input", { type: "checkbox", title: "Korigiraj prema alfa kiselinama (gorčina)" });
      adj.checked = r.stage === "boil" && !!r.adj; adj.disabled = r.stage !== "boil";
      hs.onchange = () => { r.item_id = Number(hs.value); renderSum(); };
      st.onchange = () => { r.stage = st.value; if (r.stage !== "boil") r.adj = false; render(); };
      mn.oninput = () => { r.min = Math.round(num(mn.value) || 0); if (!r._adjSet) { r.adj = r.stage === "boil" && r.min >= 30; adj.checked = r.adj; } };
      g.oninput = () => { r.g = num(g.value) || 0; renderSum(); };
      adj.onchange = () => { r.adj = adj.checked; r._adjSet = true; };
      if (ro) for (const el of [hs, st, mn, g]) el.disabled = true;
      list.append(h("div", { class: "hop-r" }, hs, st, mn, g, h("label", { class: "chk", style: { justifyContent: "center" } }, adj),
        ro ? h("span", {}) : btn("✕", () => { rows.splice(i, 1); render(); }, "ghost")));
    });
    renderSum();
  };
  const renderSum = () => {
    const by = {};
    for (const r of rows) { const k = `${r.item_id}|${r.stage}`; by[k] = (by[k] || 0) + Number(r.g || 0); }
    const parts = [];
    for (const x of plan.hops) {
      for (const [st, tot, lab] of [["boil", x.g_boil, "kuhanje"], ["dry", x.g_dry, "dry hop"]]) {
        const u = by[`${x.item_id}|${st}`] || 0;
        if (!tot && !u) continue;
        const ok = Math.abs(u - tot) < 0.6;
        parts.push(`${x.name} (${lab}) ${fq(u, 1)} / ${fq(tot, 1)} g${ok ? "" : " ⚠"}`);
      }
    }
    sum.textContent = "Prema recepturi – kuhanje: po jednom kuhanju; dry hop: za cijeli fermentor. " + parts.join(" · ");
  };
  // alfa kiseline: vrijednost u recepturi i LOT koji će se trošiti (FIFO)
  const alphaIn = {};
  const alphaBox = h("div", { class: "alpha-box" });
  const renderAlpha = () => {
    alphaBox.innerHTML = "";
    for (const x of plan.hops) {
      const a = x.alpha || {};
      const inp = alphaIn[x.item_id] || (alphaIn[x.item_id] = h("input", { value: a.recipe ? String(a.recipe).replace(".", ",") : "", inputmode: "decimal", placeholder: "npr. 3,9", style: { width: "80px", textAlign: "right" } }));
      const lotTxt = (a.lots || []).length ? (a.lots || []).map((l) => `LOT ${l.lot}: ${l.alpha ? String(l.alpha).replace(".", ",") + " %" : "alfa nije upisana"}`).join(" · ") : "nema na zalihi";
      const ra = num(inp.value) || 0;
      const f = ra && a.lot ? ra / a.lot : null;
      const res = f ? ` → gorčina ×${fq(f, 3)} (${f < 1 ? "manje" : "više"} hmelja za ${fq(Math.abs(1 - f) * 100, 1)} %)` : (ra && !a.lot ? " → upišite alfu LOT-a (Skladište → LOT-ovi)" : "");
      inp.oninput = () => renderAlphaLine();
      const line = h("span", { class: "muted", style: { fontSize: "12.5px" } }, lotTxt + res);
      const renderAlphaLine = () => {
        const r2 = num(inp.value) || 0; const f2 = r2 && a.lot ? r2 / a.lot : null;
        line.textContent = lotTxt + (f2 ? ` → gorčina ×${fq(f2, 3)} (${f2 < 1 ? "manje" : "više"} hmelja za ${fq(Math.abs(1 - f2) * 100, 1)} %)` : (r2 && !a.lot ? " → upišite alfu LOT-a (Skladište → LOT-ovi)" : ""));
      };
      alphaBox.append(h("div", { class: "row gap", style: { flexWrap: "wrap", margin: "3px 0" } }, h("b", { style: { minWidth: "130px" } }, x.name),
        h("span", {}, "α u receptu"), inp, h("span", {}, "%"), line));
    }
  };
  renderAlpha();
  const dry = plan.dry;
  const dOn = h("input", { type: "checkbox" }); dOn.checked = !!dry.on;
  const dDays = h("input", { value: String(dry.days || 3), inputmode: "numeric", style: { width: "60px", textAlign: "right" } });
  const dTime = h("input", { type: "time", value: dry.time || "09:00", style: { width: "110px" } });
  const dDate = h("input", { type: "date", value: dry.date || "", style: { width: "150px" } });
  const def = h("input", { type: "checkbox" }); def.checked = false;
  if (ro) boil.disabled = true;
  d.body.append(
    h("div", { class: "row gap", style: { flexWrap: "wrap" } }, h("b", {}, "Trajanje kuhanja"), boil,
      h("span", { class: "muted" }, "min · vrijeme hmelja = koliko dugo se kuha: jednako trajanju → na početku, 10 → 10 min prije kraja, 0 → na kraju")),
    ro ? h("div", { class: "banner ok" }, "Hmelj, količine i vrijeme kuhanja upisujete u sastojcima recepture (svaki dodatak zaseban redak). Ovdje uključujete α korekciju za pojedini dodatak, alfa kiseline i podsjetnik za dry hop.") : null,
    list, sum,
    ro ? null : h("div", { class: "row gap", style: { margin: "6px 0 12px" } }, btn("＋ Dodaj hmelj", () => {
      const hb = plan.hops.find((x) => x.g_boil > 0) || plan.hops[0];
      const b0 = Math.round(num(boil.value) || 60);
      rows.push({ item_id: hb.item_id, stage: hb.g_boil > 0 ? "boil" : "dry", min: hb.g_boil > 0 ? b0 : 0, g: 0, adj: hb.g_boil > 0 }); render();
    }, "ghost")),
    h("div", { class: "sec" }, "Alfa kiseline (korekcija gorčine)"),
    h("p", { class: "muted", style: { fontSize: "12.5px", margin: "4px 0" } }, "Upišite alfu kakva je u receptu. Alfu isporučenog hmelja upisujete kod primke ili u LOT-ovima. " +
      "Na danu kuhanja dodaci s kvačicom „α korekcija” (uključujete po volji za svaki dodatak; receptura pamti zadnji odabir) preračunaju se: količina × alfa recepta ÷ alfa LOT-a. Aroma i dry hop ostaju kako piše."),
    alphaBox,
    h("div", { class: "sec" }, "Podsjetnik za dry hop"),
    h("label", { class: "chk big" }, dOn, " Ovo pivo se dry hopa – podsjeti me (uključite samo za piva s dry hopom)"),
    h("div", { class: "row gap", style: { flexWrap: "wrap", margin: "6px 0" } },
      h("span", {}, "Dana nakon kuhanja"), dDays, h("span", {}, "u"), dTime,
      ...(opts.batchId ? [h("span", { class: "muted" }, "ili točan datum"), dDate] : [])),
    ...(opts.batchId ? [h("label", { class: "chk" }, def, " Spremi i u recepturu (sljedeća kuhanja tog piva)")] : []));
  dDays.oninput = () => { dDate.value = ""; };
  render();
  d.buttons("Spremi", () => {
    try {
      const b = Math.max(1, Math.round(num(boil.value) || 60));
      const alpha = Object.fromEntries(Object.entries(alphaIn).map(([k, inp]) => [k, num(inp.value) || null]));
      py.callKw("web_more.save_hop_plan", [rows.map((r) => ({ item_id: r.item_id, stage: r.stage, min: r.min || 0, g: r.g, line_id: r.line_id || null, adj: r.stage === "boil" ? !!r.adj : false })), b,
        { on: dOn.checked, days: Math.round(num(dDays.value) || 3), time: dTime.value || "09:00", date: opts.batchId ? (dDate.value || null) : null }],
      { batch_id: opts.batchId || null, recipe_id: opts.recipeId || null, as_default: def.checked, alpha });
      d.close(true);
    } catch (e) { d.err(e.message); }
  });
  if (!(await d.show())) return null;
  return py.call("web_more.hop_plan", opts.batchId || null, opts.recipeId || null);
}

// ================================================================== Dan kuhanja (mobitel)
// Alarm se pušta kao medijski zvuk (HTML <audio>), a ne kao ton obavijesti: svira i kad su tonovi / zvono isključeni
// (ovisi o glasnoći medija). Zvuk se ponavlja dok se ne klikne „U redu”.
let ALARM = null, ALARM_KIND = null;
// zvukovi alarma (izrađuju se u pregledniku, bez datoteka): izbor se pamti na ovom uređaju
export const ALARM_SOUNDS = [["zvono", "Zvono (mekano, ugodno)"], ["akord", "Tri tona (kuhinjski timer)"], ["gong", "Gong (dubok, dugo zvoni)"],
  ["pisak", "Pištanje (glasno, kao do sad)"]];
function alarmKind() { try { return localStorage.getItem("alarm_sound") || "zvono"; } catch { return "zvono"; } }
function alarmFlashOn() { try { return localStorage.getItem("alarm_flash") !== "0"; } catch { return true; } }
function alarmWav(kind) {
  const sr = 22050;
  const secs = { zvono: 2.4, akord: 1.8, gong: 3.2, pisak: 1.2 }[kind] || 2;
  const n = Math.round(sr * secs);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s2) => { for (let i = 0; i < s2.length; i++) v.setUint8(o + i, s2.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  const TAU = 2 * Math.PI;
  // udarac zvona: osnovni ton + neharmonični prizvuci, eksponencijalno gašenje
  const bell = (t, f, dec) => (t < 0 ? 0 : Math.exp(-t * dec) * (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t * 2)
    + 0.25 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 4)) * Math.min(1, t * 400));
  const sample = (t) => {
    switch (kind) {
      case "zvono": return 0.55 * (bell(t, 880, 2.2) + bell(t - 0.6, 1108.7, 2.2));          // ding-dong (A5, C#6), dvaput
      case "akord": return 0.45 * [523.25, 659.25, 783.99].reduce((a, f, i) => a + bell(t - i * 0.22, f, 3.2), 0)   // C-E-G, pa ponovno
        + 0.45 * [523.25, 659.25, 783.99].reduce((a, f, i) => a + bell(t - 0.9 - i * 0.22, f, 3.2), 0);
      case "gong": return 0.8 * Math.exp(-t * 0.9) * (Math.sin(TAU * 110 * t) + 0.6 * Math.sin(TAU * 220.7 * t) + 0.4 * Math.sin(TAU * 331.9 * t)
        + 0.3 * Math.sin(TAU * 437 * t) * Math.exp(-t * 1.5)) * Math.min(1, t * 60) / 1.6;
      default: { const on = (t % 0.4) < 0.25; return on ? Math.sin(TAU * (t % 0.8 < 0.4 ? 988 : 784) * t) * 0.9 : 0; }
    }
  };
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample(i / sr))) * 32767, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function alarmEl() {
  const k = alarmKind();
  if (!ALARM || ALARM_KIND !== k) {
    try { if (ALARM) ALARM.pause(); } catch { /* */ }
    ALARM = new Audio(alarmWav(k)); ALARM.loop = true; ALARM.preload = "auto"; ALARM_KIND = k;
  }
  return ALARM;
}
// poziva se na klik (Start): preglednik dopušta zvuk tek nakon dodira korisnika
export function unlockAlarm() {
  try { const a = alarmEl(); a.muted = true; a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; }); } catch { /* */ }
}
// proba zvuka (2 sekunde)
function testAlarm() {
  try { const a = alarmEl(); a.currentTime = 0; a.volume = 1; a.play().catch(() => {}); setTimeout(() => { try { if (!alarmDlg) { a.pause(); a.currentTime = 0; } } catch { /* */ } }, 2500); } catch { /* */ }
  if (alarmFlashOn()) { flashOn(); setTimeout(() => { if (!alarmDlg) flashOff(); }, 2500); }
}
// bljeskanje cijelog zaslona dok se alarm ne potvrdi (vidi se i iz daljine)
let flashEl = null;
function flashOn() {
  if (flashEl) return;
  flashEl = h("div", { class: "alarm-flash" });
  document.body.append(flashEl);
}
function flashOff() { if (flashEl) { flashEl.remove(); flashEl = null; } }
let alarmDlg = null;
function beepLong(text = "Vrijeme je isteklo") {
  try { if (navigator.vibrate) navigator.vibrate([600, 250, 600, 250, 600, 250, 600]); } catch { /* */ }
  try { const a = alarmEl(); a.currentTime = 0; a.volume = 1; a.play().catch(() => {}); } catch { /* */ }
  if (alarmFlashOn()) flashOn();
  // program nije na zaslonu (druga aplikacija / zaključan mobitel): obavijest, ako je dopuštena
  try {
    if (document.hidden && window.Notification && Notification.permission === "granted") {
      navigator.serviceWorker?.getRegistration().then((reg) => {
        const o = { body: text, icon: "icons/icon-192.png", tag: "brewday-alarm", renotify: true, requireInteraction: true, vibrate: [600, 250, 600] };
        if (reg) reg.showNotification("⏰ Dan kuhanja", o); else new Notification("⏰ Dan kuhanja", o);
      }).catch(() => {});
    }
  } catch { /* */ }
  if (alarmDlg) { alarmDlg.body.querySelector(".msg").textContent += "\n" + text; return; }
  alarmDlg = new Dialog("⏰ Dan kuhanja", { width: 420, cls: "alarm-dlg" });
  alarmDlg.body.append(h("div", { class: "msg", style: { fontSize: "22px", fontWeight: 700 } }, text));
  alarmDlg.buttons("U redu", () => alarmDlg.close(true), null);
  alarmDlg.show().then(() => { try { ALARM.pause(); ALARM.currentTime = 0; if (navigator.vibrate) navigator.vibrate(0); } catch { /* */ } flashOff(); alarmDlg = null; });
  setTimeout(() => { try { if (alarmDlg) ALARM.pause(); } catch { /* */ } }, 60000); // zvuk najviše minutu (bljeskanje ostaje do „U redu”)
}
// izbor zvuka i bljeskanja (na danu kuhanja)
function alarmSettings() {
  const sel = h("select", { style: { maxWidth: "100%" } }, ALARM_SOUNDS.map(([k, l]) => h("option", { value: k }, l)));
  sel.value = alarmKind();
  sel.addEventListener("change", () => { try { localStorage.setItem("alarm_sound", sel.value); } catch { /* */ } testAlarm(); });
  const fl = h("input", { type: "checkbox" }); fl.checked = alarmFlashOn();
  fl.addEventListener("change", () => { try { localStorage.setItem("alarm_flash", fl.checked ? "1" : "0"); } catch { /* */ } });
  const notif = window.Notification && Notification.permission === "default"
    ? btn("🔔 Dopusti obavijesti", async () => { try { await Notification.requestPermission(); } catch { /* */ } notif.remove(); }, "ghost") : null;
  return h("div", { class: "alarm-set" }, h("span", { class: "muted" }, "Zvuk alarma"), sel, btn("▶ Probaj", () => testAlarm(), "ghost"),
    h("label", { class: "chk" }, fl, " Bljeskanje zaslona"), notif);
}

class BrewDayDialog extends Dialog {
  constructor(app, batchId) {
    const d = app.py.call("web_more.brew_day", batchId);
    const b = d.batch;
    super(`Dan kuhanja · ${b.batch_no} · ${b.recipe || ""}` + (d.n > 1 ? ` · kuhanje ${d.k}/${d.n}` : ""), { width: 900, cls: "brewday" });
    this.app = app; this.batchId = batchId; this.d = d;
    this.key = `brewday_${batchId}_${d.k}`;
    let st = {}; try { st = JSON.parse(localStorage.getItem(this.key) || (d.k === 1 ? localStorage.getItem("brewday_" + batchId) : null) || "{}"); } catch { /* */ }
    this.st = Object.assign({ checks: {}, vals: {} }, st);
    const save = () => { try { localStorage.setItem(this.key, JSON.stringify(this.st)); } catch { /* */ } };
    this.save = save;
    const chk = (id, label, extra = null) => {
      const cb = h("input", { type: "checkbox" }); cb.checked = !!this.st.checks[id];
      cb.addEventListener("change", () => { this.st.checks[id] = cb.checked; save(); });
      return h("label", { class: "bd-row" }, cb, h("span", { class: "bd-lab" }, label), extra);
    };
    const t = d.targets || {};
    const tg = [t.og ? `OG ${sg(t.og)}` : "", t.fg ? `FG ${sg(t.fg)}` : "", t.ferm_temp ? `fermentacija ${fq(t.ferm_temp, 1)} °C` : ""].filter(Boolean).join(" · ");
    this.body.append(h("div", { class: "muted" }, (d.n > 1 ? `Kuhanje ${d.k} od ${d.n} · ${fq(d.brew_vol, 0)} L po kuhanju · fermentor ${fq(b.volume_l, 0)} L · `
      : `${fq(b.volume_l, 0)} L · `) + (d.planned ? "sirovine za ovo kuhanje skidaju se sa skladišta kad kliknete „Završi kuhanje”" : "sva kuhanja su gotova – upisujete mjerenja")
      + (tg ? ` · cilj: ${tg}` : "")));
    if (d.n > 1 && d.k > 1 && d.first_date) this.body.append(h("div", { class: "banner ok" }, `Kuhanje 1 obavljeno ${d2ui(d.first_date)} – ovo kuhanje ide u isti fermentor (LOT ${b.batch_no}).`));
    if (d.recipe_note) this.body.append(h("div", { class: "banner ok", style: { whiteSpace: "pre-line" } }, d.recipe_note));
    // 1. sirovine za ovo kuhanje
    this.body.append(h("h3", { class: "sec" }, d.n > 1 ? `1. Sirovine – kuhanje ${d.k} (odvagati)` : "1. Sirovine – odvagati"));
    const listItems = (arr, pre) => {
      const groups = {};
      for (const it of arr) (groups[it.cat || "Ostalo"] = groups[it.cat || "Ostalo"] || []).push(it);
      const out = [];
      for (const [g, its] of Object.entries(groups)) {
        out.push(h("div", { class: "bd-grp" }, g));
        its.forEach((it, i) => out.push(chk(`${pre}_${g}_${i}`, `${it.name}`,
          h("span", { class: "bd-qty" + (it.missing > EPS ? " bad" : "") }, h("b", { class: "bd-n" }, `${fq(it.need)} ${it.unit}`),
            (it.lots ? ` · LOT ${it.lots}` : "") + (it.missing > EPS ? ` · nedostaje ${fq(it.missing)}` : "")))));
      }
      return out;
    };
    this.body.append(...listItems(d.items, "it"));
    // sastojci za fermentor (kvasac, dry hop…): jednom, nakon zadnjeg kuhanja
    this.fermBox = h("div", {});
    if (d.ferm_items.length) {
      this.fermBox.append(h("div", { class: "bd-sub" }, h("b", {}, d.n > 1 ? "U fermentor – nakon zadnjeg kuhanja (za cijeli fermentor)" : "U fermentor (za cijeli fermentor)")),
        ...listItems(d.ferm_items, "fe"));
    }
    if (d.planned && !d.last) {
      this.lastCb = h("input", { type: "checkbox" });
      this.lastCb.checked = !!this.st.vals._last;
      this.lastCb.addEventListener("change", () => { this.st.vals._last = this.lastCb.checked; save(); this.fermBox.classList.toggle("hidden", !this.lastCb.checked); });
      this.fermBox.classList.toggle("hidden", !this.lastCb.checked);
      this.body.append(h("label", { class: "chk", style: { margin: "8px 0" } }, this.lastCb,
        ` Ovo je zadnje kuhanje za ovaj fermentor (inače slijedi kuhanje ${d.k + 1}) – kvasac i sastojci za fermentor skidaju se sada`));
    }
    this.body.append(this.fermBox);
    // 2. koraci s mjeračem vremena (iz recepture)
    this.body.append(h("h3", { class: "sec" }, "2. Koraci"), alarmSettings());
    if (d.mill && d.k === 1) this.body.append(chk("mill", "Mlin pregledan prije mljevenja – uređaj je u redu (upisuje se kontrola mlina)"));
    this.body.append(chk("mill_done", "Mljevenje slada"));
    this._doneTxt = {};
    const mash = d.mash.length ? d.mash : [{ name: "Ukomljavanje", temp: null, min: 60 }];
    mash.forEach((m, i) => {
      const lab = `${m.name || "Ukomljavanje"}${m.temp ? ` · ${fq(m.temp, 1)} °C` : ""}`;
      this._doneTxt["mash" + i] = `${lab} – gotovo`;
      this.body.append(chk("mash" + i, lab, this.timer("mash" + i, m.min || 10)));
    });
    this._doneTxt.lauter = "Cijeđenje i ispiranje – vrijeme isteklo";
    this.body.append(chk("lauter", "Cijeđenje i ispiranje", this.timer("lauter", d.lauter_min || 45)));
    this._doneTxt.boil = "Kuhanje sladovine je gotovo";
    this.plan = app.py.call("web_more.hop_plan", batchId);
    this.body.append(chk("boil", "Kuhanje sladovine", this.timer("boil", this.plan.boil_min || d.boil_min || 60)));
    // hmelj i dodaci tijekom kuhanja (Whirlfloc…): odbrojavanje do svakog dodatka (pokreće se tipkom Start kod kuhanja)
    this.hopBox = h("div", { class: "hop-live" });
    this.body.append(h("div", { class: "bd-sub" }, h("b", {}, "Dodaci tijekom kuhanja (hmelj, Whirlfloc…)"),
      btn("✎ Raspored hmelja", async () => { const p = await hopEditor(app, { batchId }); if (p) { this.plan = p; this.renderHops(); this.renderDry(); } }, "ghost")),
    this.hopBox);
    this._doneTxt.whirl = "Whirlpool / odmor je gotov";
    this.body.append(chk("whirl", "Whirlpool / odmor", this.timer("whirl", d.whirl_min || 15)));
    this.body.append(chk("cool", `Hlađenje${t.cool_temp ? ` na ${fq(t.cool_temp, 1)} °C` : ""} i prebacivanje u fermentor`));
    if (d.last || this.lastCb) this.body.append(this.yeastRow = chk("yeast", "Dodan kvasac (sastojci za fermentor)"));
    if (this.lastCb && this.yeastRow) { this.yeastRow.classList.toggle("hidden", !this.lastCb.checked); this.lastCb.addEventListener("change", () => this.yeastRow.classList.toggle("hidden", !this.lastCb.checked)); }
    this.renderHops();
    this._timers.push(setInterval(() => this.hopTick(), 1000));
    // dry hop podsjetnik
    this.dryBox = h("div", { class: "card", style: { marginTop: "8px" } });
    this.body.append(h("h3", { class: "sec" }, "Dry hop"), this.dryBox);
    this.renderDry();
    // 3. mjerenja (za ovo kuhanje)
    this.body.append(h("h3", { class: "sec" }, d.n > 1 ? `3. Mjerenja i CCP – kuhanje ${d.k}` : "3. Mjerenja i CCP kuhanja"));
    const v = this.st.vals;
    const bw = d.brew || {};
    this.form = new Form([
      { key: "date", label: d.k === 1 ? "Datum kuhanja = početak fermentacije" : `Datum kuhanja ${d.k}`, type: "date" },
      { key: "tank", label: "Fermentor (u koji se prebacuje)", type: "combo", options: app.db.fermentors().map((f) => f.name),
        command: () => this.checkTank() },
      { key: "ferm_temp", label: "Temperatura fermentacije (°C)", type: "num" },
      { key: "operator", label: "Kuhao", type: "combo", editable: true, options: app.db.employee_names() },
      { key: "wort_l", label: d.n > 1 ? `Volumen sladovine – kuhanje ${d.k} (L)` : "Volumen sladovine (L)", type: "num", min: 0 },
      { key: "og_sg", label: "OG (npr. 1,052)", type: "num", min: 0 },
      { key: "ph", label: "pH", type: "num", min: 0 },
      { key: "boil_temp", label: "Temperatura kuhanja (°C) – CCP ≥ 100 °C", type: "num", min: 0 },
      { key: "boil_start", label: "Početak kuhanja", type: "time" },
      { key: "boil_end", label: "Kraj kuhanja", type: "time" },
      { key: "boil_min", label: "Trajanje kuhanja (min)", type: "num", min: 0 },
      { key: "corrective", label: "Korektivna radnja (ako < 100 °C)", full: true }],
    { date: bw.brew_date || today(), tank: b.tank, ferm_temp: b.ferm_temp || t.ferm_temp, operator: bw.brewer || b.brewer || opBrew(app.db),
      wort_l: bw.wort_l || d.brew_vol, og_sg: bw.og_sg, ph: bw.ph, boil_temp: bw.boil_temp, boil_start: bw.boil_start, boil_end: bw.boil_end,
      boil_min: bw.boil_min, ...v }, 3);
    this.form.el.addEventListener("change", () => { try { Object.assign(this.st.vals, this.form.get()); } catch { /* */ } save(); });
    this.tankInfo = h("div", { class: "tank-info" });
    this.body.append(this.form.el, this.tankInfo);
    this.checkTank();
    const finTxt = !d.planned ? "✔ Spremi mjerenja" : (d.n > 1 && !d.last ? `✔ Završi kuhanje ${d.k} i spremi` : "✔ Završi kuhanje i spremi");
    this.bar.append(btn("Zatvori (zapamti)", () => this.close(null), "ghost"), btn(finTxt, () => this.finish()));
  }

  // fermentor: zauzetost prema planeru i CIP prije nove šarže (HACCP)
  checkTank() {
    if (!this.tankInfo || !this.form) return;
    const tank = this.form.w.tank.get(), date = this.form.w.date.get() || today();
    this.tankInfo.innerHTML = "";
    if (!tank) { this.tankInfo.append(h("div", { class: "banner warn" }, "Odaberite fermentor u koji se prebacuje sladovina.")); return; }
    try {
      const free = this.app.db.free_from(tank);
      if (free && free > date) this.tankInfo.append(h("div", { class: "banner warn" }, `${tank} je prema planeru zauzet do ${d2ui(free)}`));
      const ok = this.app.db.cip_ok_before_brew(tank, date, this.batchId);
      if (ok) this.tankInfo.append(h("div", { class: "banner ok" }, `✓ CIP ${tank} prije ove šarže je evidentiran.`));
      else {
        this.tankInfo.append(h("div", { class: "banner warn row gap", style: { justifyContent: "space-between", flexWrap: "wrap" } },
          h("span", {}, `Nema zapisa o CIP-u ${tank} prije ove šarže.`),
          btn("🧼 Upiši CIP", async () => {
            const hx = await import("./haccp.js");
            const f = this.app.db.one("SELECT id FROM equipment WHERE name=?", [tank]);
            await hx.editCip(this.app, hx.cipDefaults(this.app, { cip_type: "CIP prije početka nove šarže", batch_no: this.d.batch.batch_no,
              date, ver_date: date, review_date: date, fermentor_id: f ? f.id : null, equipment: f ? ["Fermentor"] : [] }), null);
            this.checkTank();
          }, "ghost")));
      }
    } catch (e) { console.warn(e); }
  }

  // zaslon ostaje upaljen dok je otvoren dan kuhanja (inače preglednik zaustavi odbrojavanje kad se mobitel zaključa)
  async wakeLock() {
    try { if (!this._wl && navigator.wakeLock) { this._wl = await navigator.wakeLock.request("screen"); } } catch { /* */ }
  }

  renderHops() {
    this.hopBox.innerHTML = "";
    const rows = this.plan.rows.filter((r) => r.stage === "boil").map((r) => ({ ...r }))
      .concat((this.plan.adds || []).map((a) => ({ item_id: a.item_id, name: a.name, min: a.min, g: a.qty, unit: a.unit, add: true })));
    rows.sort((x, y) => y.min - x.min);
    if (!rows.length) { this.hopBox.append(h("div", { class: "muted" }, "Nema dodataka za kuhanje u rasporedu.")); return; }
    this.hopEls = rows.map((r, i) => {
      const id = `${r.add ? "add" : "hop"}_${r.item_id}_${r.min}_${i}`;
      const cb = h("input", { type: "checkbox" }); cb.checked = !!this.st.checks[id];
      const st = h("span", { class: "hop-st" }, "");
      cb.addEventListener("change", () => { this.st.checks[id] = cb.checked; this.save(); this.hopTick(); });
      const len = this.boilLen();
      const when = r.min >= len ? `${r.min} min · na početku` : (r.min <= 0 ? "0 min · na kraju" : `${r.min} min · u ${len - r.min}. min kuhanja`);
      const al = (this.plan.alpha || {})[String(r.item_id)] || {};
      const qn = r.add ? `${fq(r.g)} ${r.unit}` : (r.g_adj != null ? `${fq(r.g_adj, 1)} ${r.unit}` : `${fq(r.g, 1)} ${r.unit}`);
      const sub = !r.add && r.g_adj != null ? h("span", { class: "hop-alpha" }, `recept ${fq(r.g, 1)} ${r.unit} · α ${fq(al.recipe, 1)} → ${fq(al.lot, 1)} %`) : null;
      const row = h("label", { class: "bd-row hop-row" }, cb, h("span", { class: "bd-lab" }, `${r.name} · `, h("b", { class: "bd-n" }, qn), sub),
        h("span", { class: "hop-when" }, when), st);
      this.hopBox.append(row);
      return { r, id, row, st };
    });
    this.hopTick();
  }
  boilLen() { const i = this.timerMin && this.timerMin.boil; return Math.max(1, Number(i && i.value) || this.plan.boil_min || 60); }
  hopTick() {
    if (!this.hopEls) return;
    const t = this.st.vals.t_boil;
    const len = this.boilLen();
    const elapsed = t && t.end ? Math.min(len * 60, len * 60 - Math.round((t.end - Date.now()) / 1000)) : null;
    let rang = this.st.vals.hopRang || (this.st.vals.hopRang = {});
    for (const e of this.hopEls) {
      const at = Math.max(0, len - Math.min(e.r.min, len)) * 60; // vrijeme kuhanja dodatka -> trenutak dodavanja od početka
      const done = !!this.st.checks[e.id];
      e.row.classList.toggle("due", !done && elapsed !== null && elapsed >= at);
      if (done) e.st.textContent = "✓ dodano";
      else if (elapsed === null) e.st.textContent = "";
      else if (elapsed >= at) {
        e.st.textContent = "DODAJ SADA!";
        if (!rang[e.id]) { rang[e.id] = true; this.save(); beepLong(`Dodaj ${e.r.add ? "" : "hmelj: "}${e.r.name} ${e.r.add ? fq(e.r.g) : fq(e.r.g_adj ?? e.r.g, 1)} ${e.r.unit}`); }
      } else {
        const left = at - elapsed;
        e.st.textContent = `za ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
      }
    }
  }
  renderDry() {
    const d = this.plan.dry;
    const dry = this.plan.rows.filter((r) => r.stage === "dry");
    this.dry = this.dry || { on: !!d.on, days: d.days || 3, time: d.time || "09:00" };
    const on = h("input", { type: "checkbox" }); on.checked = this.dry.on;
    const days = h("input", { value: String(this.dry.days), inputmode: "numeric", style: { width: "56px", textAlign: "right" } });
    const tm = h("input", { type: "time", value: this.dry.time, style: { width: "110px" } });
    const info2 = h("div", { class: "muted", style: { fontSize: "12.5px", marginTop: "4px" } });
    const upd = () => {
      this.dry = { on: on.checked, days: Math.round(num(days.value) || 3), time: tm.value || "09:00" };
      const dt0 = new Date(); dt0.setDate(dt0.getDate() + this.dry.days);
      info2.textContent = this.dry.on ? `Podsjetnik: ${d2ui(dt0.toISOString().slice(0, 10))} u ${this.dry.time}`
        + (dry.length ? ` · ${dry.map((r) => `${r.name} ${fq(r.g, 1)} ${r.unit}`).join(", ")}` : " · u rasporedu hmelja nema dry hop stavki (✎ Raspored hmelja)") : "Bez dry hopa za ovu šaržu.";
    };
    [on, days, tm].forEach((x) => x.addEventListener("input", upd));
    on.addEventListener("change", upd);
    this.dryBox.innerHTML = "";
    this.dryBox.append(h("label", { class: "chk big" }, on, " Podsjeti me za dry hop"),
      h("div", { class: "row gap", style: { flexWrap: "wrap", marginTop: "6px" } }, h("span", {}, "nakon"), days, h("span", {}, "dana, u"), tm), info2);
    upd();
  }

  timer(id, defMin) {
    const t = this.st.vals["t_" + id] || {};
    const min = h("input", { value: String(t.min || defMin), inputmode: "numeric", style: { width: "52px", textAlign: "right" } });
    (this.timerMin = this.timerMin || {})[id] = min;
    if (id === "boil") min.addEventListener("input", () => this.renderHops && this.hopEls && this.renderHops());
    const lbl = h("span", { class: "bd-time" }, "");
    const b = btn("▶", () => toggle(), "ghost");
    const tick = () => {
      const end = this.st.vals["t_" + id] && this.st.vals["t_" + id].end;
      if (!end) { lbl.textContent = ""; b.textContent = "▶ Start"; return; }
      const left = Math.round((end - Date.now()) / 1000);
      if (left <= 0) {
        lbl.textContent = "gotovo!"; lbl.classList.add("done"); b.textContent = "↺";
        if (!this.st.vals["t_" + id].rang) { this.st.vals["t_" + id].rang = true; this.save();
          beepLong((this._doneTxt && this._doneTxt[id]) || "Vrijeme je isteklo");
          if (id === "boil") { this.form.w.boil_end.set(nowHM()); this.form.w.boil_min.set(Number(min.value) || defMin); } }
        return;
      }
      lbl.classList.remove("done");
      lbl.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
      b.textContent = "⏹ Stop";
    };
    const toggle = () => {
      const cur = this.st.vals["t_" + id];
      if (cur && cur.end && !cur.rang) { delete this.st.vals["t_" + id]; }
      else {
        unlockAlarm();
        this.wakeLock();
        const m = Math.max(1, Number(min.value) || defMin);
        this.st.vals["t_" + id] = { min: m, end: Date.now() + m * 60000 };
        if (id === "boil") { this.form.w.boil_start.set(nowHM()); this.st.vals.hopRang = {}; }
      }
      this.save(); tick();
    };
    this._timers = this._timers || [];
    this._timers.push(setInterval(tick, 1000));
    setTimeout(tick, 0);
    return h("span", { class: "bd-timer" }, min, h("span", { class: "muted" }, "min"), b, lbl);
  }

  close(r) {
    (this._timers || []).forEach(clearInterval);
    try { if (this._wl) this._wl.release(); } catch { /* */ }
    super.close(r);
  }

  async finish() {
    let v;
    try { v = this.form.get(); } catch (e) { return this.err(e.message); }
    if (v.boil_temp && v.boil_temp < 100 && !v.corrective) return this.err("Temperatura kuhanja je ispod 100 °C – upišite korektivnu radnju.");
    if (!v.tank) return this.err("Odaberite fermentor u koji se prebacuje pivo.");
    const d = this.d;
    const last = d.last || (this.lastCb && this.lastCb.checked);
    if (d.planned) {
      const fermTxt = last && d.ferm_items.length ? `\n\nSkidaju se i sastojci za fermentor: ${d.ferm_items.map((x) => `${x.name} ${fq(x.need)} ${x.unit}`).join(", ")}.` : "";
      const msg = d.n > 1
        ? `Kuhanje ${d.k} od ${d.n}: sirovine za ovo kuhanje skidaju se sa skladišta (FIFO), sladovina ide u ${v.tank} (LOT ${d.batch.batch_no}).${fermTxt}`
          + (last ? "" : `\n\nFermentor ostaje otvoren za kuhanje ${d.k + 1}.`)
        : `Sirovine će se skinuti sa skladišta (FIFO), a šarža počinje fermentaciju u ${v.tank} (${d2ui(v.date || today())}).${fermTxt}`;
      if (!(await confirm(msg + "\n\nNastaviti?", "Završi kuhanje"))) return;
    }
    try {
      for (const k of ["wort_l", "og_sg", "ph", "boil_temp", "boil_min", "ferm_temp"]) if (!v[k]) delete v[k];
      const r = this.app.py.call("web_more.brew_day_finish", this.batchId, { ...v, last: last && !d.last ? 1 : 0,
        mill_ok: d.mill && this.st.checks.mill ? 1 : 0, dry: this.dry });
      try { localStorage.removeItem(this.key); localStorage.removeItem("brewday_" + this.batchId); } catch { /* */ }
      this.close(r);
    } catch (e) { this.err(e.message); }
  }
}

class BatchesPage extends Page {
  static title = "Šarže piva";
  static subtitle = "Evidencija kuhanja · kod potvrde kuhanja sirovine se automatski skidaju (FIFO)";

  build() {
    this.tbtn("🔥 Dan kuhanja – nova šarža", () => this.brewDay());
    this.tbtn("📅 Planiraj šaržu", () => this.new(), "ghost");
    this.tbtn("✎ Uredi šaržu", () => this.edit(), "ghost");
    this.tbtn("🕘 Povijest", async () => {
      const id = this.need(this.table, "šaržu"); if (!id) return;
      const m = await import("./settings.js"); await m.auditDialog(this.app, this.db.batch(id).batch_no);
    }, "ghost");
    this.tbtn("Sljedivost (LOT-ovi)", () => this.detail(), "ghost");
    this.tbtn("📈 Mjerenja", () => this.readings(), "ghost");
    this.tbtn("Storno kuhanja", () => this.undo(), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.table = T([
      ["no", "LOT piva", 120, "w"], ["recipe", "Pivo", 180, "w"], ["style", "Stil", 110, "w"],
      ["date", "Datum kuhanja", 105, "center"], ["vol", "Sladovina (L)", 90, "e"], ["pack", "Proizvedeno (L)", 90, "e"], ["tank", "Tank", 100, "w"],
      ["og", "OG", 65, "e"], ["fg", "FG", 65, "e"], ["abv", "Alkohol %", 75, "e"],
      ["status", "Status", 110, "w"], ["kegs", "Kegova vani", 90, "center"], ["cost", "Trošak €/L", 85, "e"],
      ["note", "Napomena", 160, "w"]], { onDouble: () => this.detail() });
    this.search(this.table);
    this.content.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.batches().map((b) => ({
      id: b.id, no: b.batch_no, recipe: b.recipe || "", style: b.style || "", date: d2ui(b.brew_date), vol: fq(b.wort_l || b.volume_l), pack: (b.packaged_l || b.packed_sum) ? fq(b.packaged_l || b.packed_sum, 1) + (b.packaged_l ? "" : " ⓟ") : "",
      tank: b.tank || "", og: sg(b.og_sg), fg: sg(b.fg_sg), abv: b.abv ? fq(b.abv, 1) : "",
      status: b.status + ((b.brews || 1) > 1 && b.brews_rows && b.brews_done_n < b.brews ? ` · kuhanje ${b.brews_done_n}/${b.brews}` : ""),
      kegs: b.kegs_out || "", note: b.note || "",
      cost: b.status !== "Planirano" ? fq(this.db.batch_cost(b.id)[2], 2) : "",
      _tag: b.status === "Planirano" ? "muted" : (b.status === "Fermentacija" ? "ok" : "") })));
  }

  async new() {
    const recipes = this.db.recipes();
    if (!recipes.length) return info("Najprije unesite recepturu.", "Šarža");
    const d = await askForm("Planiraj šaržu (kuhanje kasnije – u Danu kuhanja)", [
      { key: "recipe_id", label: "Receptura", type: "combo", options: recipes.map((r) => [r.name, r.id]), required: true },
      { key: "volume", label: "Volumen (L)", type: "num", required: true, positive: true, default: recipes[0].batch_size_l },
      { key: "date", label: "Datum kuhanja", type: "date", required: true, default: today() },
      { key: "batch_no", label: "LOT piva (prazno = automatski: DDMMGGGG + oznaka + broj)" },
      { key: "tank", label: "Fermentor / tank", type: "combo", editable: true, options: this.db.fermentors().map((f) => f.name) },
      { key: "brewer", label: "Kuhao", type: "combo", editable: true, options: this.db.employee_names(),
        default: opBrew(this.db) },
      { key: "note", label: "Napomena" }]);
    if (!d) return;
    if (d.tank) {
      const free = this.db.free_from(d.tank);
      if (free && free > d.date && !(await confirm(`${d.tank} je prema planeru zauzet do ${d2ui(free)}.\n\nNastaviti ipak?`, "Fermentor zauzet"))) return;
    }
    const res = await new BrewPreview(this.db, d.recipe_id, d.volume, true).show();
    if (!res) return;
    let bid, b;
    try {
      bid = this.app.py.callKw("db.create_batch", [d.recipe_id, d.volume, d.date],
        { planned: true, batch_no: d.batch_no, tank: d.tank, note: d.note });
      this.db.update_batch(bid, { brewer: d.brewer, wort_l: d.volume });
      b = this.db.batch(bid);
      this.app.refreshAll();
      this.app.toast(`Šarža ${b.batch_no} spremljena (${b.status}).`);
    } catch (e) { return this.err(e); }
    if (b.status !== "Planirano") await this.haccpAfterBrew(bid);
  }

  // Dan kuhanja je glavni način: odabir piva i volumena (ili planirane šarže) -> sve ostalo se upisuje tijekom kuhanja
  async brewDay(batchId = null) {
    const recipes = this.db.recipes();
    if (!recipes.length) return info("Najprije unesite recepturu.", "Dan kuhanja");
    const all = this.db.batches();
    const inProg = all.filter((b) => b.status !== "Planirano" && (b.brews || 1) > 1 && b.brews_rows && b.brews_done_n < b.brews);
    const planned = all.filter((b) => b.status === "Planirano");
    const sel = this.table.selectedId();
    // fermentor u kojem čeka sljedeće kuhanje: odmah nastavi
    let id = batchId || (inProg.find((b) => b.id === sel) ? sel : null);
    if (!id && inProg.length && !planned.find((b) => b.id === sel)) {
      const b0 = inProg[0];
      if (await confirm(`Fermentor ${b0.tank || ""} (LOT ${b0.batch_no} · ${b0.recipe}) čeka kuhanje ${b0.brews_done_n + 1} od ${b0.brews}.\n\nNastaviti s tim kuhanjem?`,
        "Dan kuhanja", { ok: `Kuhanje ${b0.brews_done_n + 1}/${b0.brews}`, cancel: "Nova šarža" })) id = b0.id;
    }
    const pre = id || (planned.find((b) => b.id === sel) ? sel : null);
    if (!id) id = pre;
    // šarža koja je već skuhana: samo otvori dan kuhanja (mjerenja, hmelj, dry hop)
    if (!id && sel && this.db.batch(sel) && this.db.batch(sel).status === "Fermentacija" && this.db.batch(sel).brew_date === today()) id = sel;
    if (!id) {
      const pb = planned.find((b) => b.id === pre);
      const d = await askForm("Dan kuhanja", [
        ...(planned.length ? [{ key: "planned_id", label: "Planirana šarža (ili nova)", type: "combo", full: true,
          options: [["— nova šarža —", null], ...planned.map((b) => [`${b.batch_no} · ${b.recipe} · ${d2ui(b.brew_date)}`, b.id])],
          command: (v, f) => { const b = planned.find((x) => x.id === v); if (b) { f.w.recipe_id.set(b.recipe_id); f.w.volume.set(b.volume_l); f.w.brews.set(b.brews || 1); if (b.tank) f.w.tank.set(b.tank); } } }] : []),
        { key: "recipe_id", label: "Pivo (receptura)", type: "combo", options: recipes.map((r) => [r.name, r.id]), required: true,
          command: (v, f) => { const r = recipes.find((x) => x.id === v); if (r) { f.w.volume.set(r.batch_size_l); f.w.brews.set(r.brews || 1); } } },
        { key: "volume", label: "Volumen u fermentoru (L)", type: "num", required: true, positive: true },
        { key: "brews", label: "Broj kuhanja za ovaj fermentor", type: "num", required: true, positive: true },
        { key: "date", label: "Datum kuhanja", type: "date", required: true },
        { key: "tank", label: "Fermentor", type: "combo", options: this.db.fermentors().map((f) => f.name) },
        { key: "brewer", label: "Kuhao", type: "combo", editable: true, options: this.db.employee_names() }],
      { planned_id: pb ? pb.id : null, recipe_id: pb ? pb.recipe_id : recipes[0].id, volume: pb ? pb.volume_l : recipes[0].batch_size_l,
        brews: pb ? (pb.brews || 1) : (recipes[0].brews || 1),
        date: today(), tank: pb ? pb.tank : null, brewer: opBrew(this.db) }, { okText: "Započni dan kuhanja" });
      if (!d) return;
      try {
        if (d.planned_id) {
          id = d.planned_id;
          this.db.update_batch(id, { recipe_id: d.recipe_id, volume_l: d.volume, brew_date: d.date, tank: d.tank || null, brewer: d.brewer,
            brews: Math.max(1, Math.round(d.brews || 1)) });
        } else {
          id = this.app.py.callKw("db.create_batch", [d.recipe_id, d.volume, d.date], { planned: true, tank: d.tank || null, brews: Math.max(1, Math.round(d.brews || 1)) });
          this.db.update_batch(id, { brewer: d.brewer, wort_l: d.volume });
        }
      } catch (e) { return this.err(e); }
      this.refresh();
    }
    for (;;) {
      const r = await new BrewDayDialog(this.app, id).show();
      if (!r && this.db.batch(id) && this.db.batch(id).status === "Planirano") toast("Šarža je spremljena kao planirana – nastavite kad god: 🔥 Dan kuhanja.");
      if (!r) break;
      this.app.refreshAll();
      if (r.done_all) { toast(`Dan kuhanja spremljen – ${r.batch_no}` + (r.n > 1 ? ` (${r.n} kuhanja, fermentor pun).` : ".") + (r.dry_hop_date ? ` Dry hop podsjetnik: ${d2ui(r.dry_hop_date)}.` : "")); break; }
      if (!(await confirm(`Kuhanje ${r.k} od ${r.n} spremljeno (LOT ${r.batch_no}).\n\nZapočeti kuhanje ${r.k + 1} sada?`, "Sljedeće kuhanje",
        { ok: `Započni kuhanje ${r.k + 1}`, cancel: "Kasnije" }))) { toast(`Kuhanje ${r.k + 1} nastavite kad god: 🔥 Dan kuhanja.`); break; }
    }
  }

  // Nakon kuhanja: kontrola mlina, CIP fermentora prije šarže i CCP kontrola kuhanja.
  async haccpAfterBrew(bid) {
    const app = this.app;
    const b = this.db.batch(bid);
    const tank = b.tank;
    const cipMissing = !!tank && !this.db.cip_ok_before_brew(tank, b.brew_date, bid);
    const mill = this.db.mill();
    const fields = [{ key: "info", label: "Šarža", type: "info", default: `${b.batch_no} · ${b.recipe} · ${d2ui(b.brew_date)}` }];
    if (mill) {
      fields.push({ key: "mill_ok", label: `Mlin (${mill.name}) pregledan prije kuhanja – uređaj je u redu`, type: "check" },
        { key: "mill_op", label: "Pregledao", type: "combo", editable: true, options: this.db.employee_names(),
          default: opDoc(this.db) });
    }
    if (tank) {
      fields.push({ key: "cip", type: "check", label: cipMissing ? `Otvori zapisnik: CIP ${tank} prije ove šarže (nema zapisa!)`
        : `CIP ${tank} prije šarže već je evidentiran` });
    }
    fields.push({ key: "ccp", label: "Unesi CCP kontrolu kuhanja sladovine (temperatura ≥ 100 °C)", type: "check" });
    const d = await askForm("HACCP zapisi uz kuhanje", fields, { mill_ok: 0, cip: cipMissing ? 1 : 0, ccp: 1 },
      { okText: "Nastavi", width: 620 });
    if (!d) {
      if (mill) app.toast("HACCP zapisi uz kuhanje nisu uneseni – vidi HACCP → Pregled i zadaci.");
      return;
    }
    if (mill && d.mill_ok) this.db.add_mill_check(b.brew_date, "Uređaj je u redu", d.mill_op, bid);
    else if (mill && await confirm("Kontrola mlina nije potvrđena.\nŽelite li upisati zapis kontrole (npr. s napomenom o nedostatku)?", "Kontrola mlina")) {
      await callHaccp(app, "editMillCheck", { date: b.brew_date, batch_id: bid, operator: d.mill_op }, null);
    }
    if (d.cip) {
      const f = this.db.one("SELECT * FROM equipment WHERE name=?", [tank]);
      const prev = b.brew_date;
      const cd = haccpFn(app, "cipDefaults");
      if (cd) {
        let init = null;
        try {
          init = cd(app, { cip_type: "CIP prije početka nove šarže", batch_no: b.batch_no, date: prev, ver_date: prev,
            review_date: prev, fermentor_id: f ? f.id : null, equipment: f ? ["Fermentor"] : [] });
        } catch (e) { console.error(e); }
        await callHaccp(app, "editCip", init, null);
      }
    }
    if (d.ccp) {
      await callHaccp(app, "editCcp", { batch_id: bid, date: b.brew_date, operator: opDoc(this.db) }, null);
    }
    app.refreshAll();
  }

  async brew() {
    const id = this.need(this.table, "šaržu");
    if (!id) return;
    const b = this.db.batch(id);
    if (b.status !== "Planirano") return info("Ova šarža je već skuhana.", "Kuhanje");
    const pv = new BrewPreview(this.db, b.recipe_id, b.volume_l, false);
    if (pv.short) pv.disableOk("Nedovoljno sirovina");
    if ((await pv.show()) !== true) return;
    const d = await askForm("Datum kuhanja", [{ key: "date", label: "Datum kuhanja", type: "date", required: true, default: today() }],
      {}, { okText: "Skuhaj" });
    if (!d) return;
    try {
      this.db.brew_batch(id, d.date);
      this.app.refreshAll();
      this.app.toast(`Šarža ${b.batch_no} skuhana – sirovine skinute.`);
    } catch (e) { return this.err(e); }
    await this.haccpAfterBrew(id);
  }

  async edit() {
    const id = this.need(this.table, "šaržu");
    if (!id) return;
    const b = this.db.batch(id);
    const st = b.status !== "Planirano" ? K(this.app).BATCH_STATUS : ["Planirano"];
    const emps = this.db.employee_names();
    const brewed = b.status !== "Planirano";
    const d = await askForm(`Šarža ${b.batch_no} – svi podaci`, [
      { label: "Osnovno", type: "section" },
      { key: "batch_no", label: "LOT piva", required: true },
      { key: "recipe_id", label: "Pivo (receptura)", type: "combo", required: true, options: this.db.recipes().map((r) => [r.name, r.id]) },
      { key: "status", label: "Status", type: "combo", options: st },
      { key: "brew_date", label: "Datum kuhanja", type: "date", required: true },
      { key: "volume_l", label: "Volumen sladovine (L) – stvarno skuhano", type: "num", required: true, positive: true },
      { key: "packaged_l", label: `Proizvedeno piva (L) – stvarno${b.packed_sum ? ` (prazno = iz pakiranja: ${fq(b.packed_sum, 1)} L)` : " (prazno = iz evidencije pakiranja)"}`, type: "num", min: 0 },
      { key: "tank", label: "Fermentor / tank", type: "combo", editable: true, options: this.db.fermentors().map((f) => f.name) },
      { key: "brewer", label: "Kuhao", type: "combo", editable: true, options: emps },
      { label: "Mjerenja kuhanja", type: "section" },
      { key: "og_sg", label: "OG – početna gustoća (npr. 1,052)", type: "num", min: 0 },
      { key: "fg_sg", label: "FG – završna gustoća (npr. 1,010)", type: "num", min: 0 },
      { key: "abv", label: "Alkohol % vol (prazno = izračun iz OG i FG)", type: "num", min: 0 },
      { key: "ph", label: "pH", type: "num", min: 0 },
      { label: "Fermentacija", type: "section" },
      { key: "ferm_start", label: "Početak fermentacije", type: "date" },
      { key: "ferm_end", label: "Završetak fermentacije", type: "date" },
      { key: "ferm_temp", label: "Temperatura fermentacije (°C)", type: "num" },
      { key: "ferm_by", label: "Odgovorna osoba (fermentacija)", type: "combo", editable: true, options: emps },
      { label: "Senzorika", type: "section" },
      { key: "sensory_score", label: "Ocjena (1–5)", type: "num", min: 0 },
      { key: "sensory_date", label: "Datum ocjene", type: "date" },
      { key: "sensory_by", label: "Ocijenio", type: "combo", editable: true, options: emps },
      { key: "sensory_note", label: "Senzorika – napomena" },
      { label: "Dry hop", type: "section" },
      { key: "dry_hop_on", label: "Podsjetnik za dry hop uključen", type: "check" },
      { key: "dry_hop_date", label: "Datum dry hopa", type: "date" },
      { key: "dry_hop_time", label: "Vrijeme podsjetnika", type: "time" },
      { key: "dry_hop_done", label: "Dry hop obavljen (datum)", type: "date" },
      { key: "note", label: "Napomena", type: "multi", full: true }], { ...b, volume_l: b.wort_l || b.volume_l }, { columns: 3, width: 980 });
    if (d) {
      for (const k of ["og_sg", "fg_sg", "abv", "ph", "ferm_temp", "sensory_score", "packaged_l"]) if (!d[k]) d[k] = null;
      if (!d.abv && d.og_sg && d.fg_sg && d.og_sg > d.fg_sg) d.abv = Math.round((d.og_sg - d.fg_sg) * 131.25 * 100) / 100;
      // skuhana šarža: mijenja se stvarna količina (troškovi po litri, izvještaji); utrošak sirovina ostaje isti
      if (brewed) d.wort_l = d.volume_l;
      try { this.db.update_batch(id, d); } catch (e) { return this.err(e); }
      this.app.refreshAll();
    }
  }

  detail() {
    const id = this.need(this.table, "šaržu");
    if (!id) return;
    const b = this.db.batch(id);
    const rows = this.db.batch_consumption(id).map((c) => ({ id: c.id, brew: c.brew_no === 0 ? "fermentor" : (c.brew_no ? `kuhanje ${c.brew_no}` : ""),
      name: c.name, lot: c.lot_no, qty: fq(c.qty), unit: c.unit, sup: c.supplier_name || "", exp: d2ui(c.expiry_date) }));
    const kegs = this.db.kegs().filter((k) => k.batch_id === id).map((k) => k.code);
    const [raw, total, perL] = this.db.batch_cost(id);
    tableDialog(`Sljedivost šarže ${b.batch_no}`, [
      ["brew", "Kuhanje", 90, "w"], ["name", "Sirovina", 210, "w"], ["lot", "LOT", 140, "w"], ["qty", "Količina", 90, "e"],
      ["unit", "Jed.", 50, "center"], ["sup", "Dobavljač", 170, "w"], ["exp", "Rok LOT-a", 100, "center"]], rows,
    { info: `${b.recipe} · ${fq(b.volume_l)} L · kuhano ${d2ui(b.brew_date) || "—"} · status ${b.status}\n`
      + `Kegovi s ovom šaržom: ${kegs.join(", ") || "—"}\n`
      + `Trošak: sirovine ${money(raw)} · ukupno ${money(total)} · ${money(perL)} po litri (ostali troškovi po litri: Postavke)` });
  }

  async readings() {
    const id = this.need(this.table, "šaržu");
    if (id) { await openReadings(this.app, id); this.refresh(); }
  }

  async undo() {
    const id = this.need(this.table, "šaržu");
    if (!id) return;
    const b = this.db.batch(id);
    if (b.status === "Planirano") return;
    if (await confirm(`Stornirati kuhanje ${b.batch_no}?\nSirovine se vraćaju u iste LOT-ove, a šarža postaje planirana.`, "Storno")) {
      try { this.db.undo_brew(id); this.app.refreshAll(); } catch (e) { this.err(e); }
    }
  }

  async delete() {
    const id = this.need(this.table, "šaržu");
    if (id && await confirm("Obrisati šaržu?", "Brisanje")) {
      try { this.db.delete_batch(id); this.app.refreshAll(); } catch (e) { this.err(e); }
    }
  }
}

// ================================================================== Kegovi
class KegsPage extends Page {
  static title = "Skladište kegova";
  static subtitle = "Pregled i uređivanje kegova · svakodnevni rad (punjenje, pranje, otprema, povrat) radi se u „Rad s kegovima (QR)”";

  build() {
    this.tbtn("📱 Rad s kegovima (QR)", () => this.app.show("kegwork"));
    this.tbtn("＋ Novi kegovi", () => this.new(), "ghost");
    // ručna promjena statusa (ispravci) – za svakodnevni rad koristi se Rad s kegovima
    this.manual = h("select", { class: "more", style: { width: "auto" }, title: "Ručna promjena statusa odabranih kegova" },
      ["Ručna promjena…", "Napuni", "Isporuči", "Vrati", "Istočeno (pivnica)", "Očisti"].map((o) => h("option", { value: o }, o)));
    this.manual.addEventListener("change", () => { const v = this.manual.value; this.manual.value = "Ručna promjena…"; if (v !== "Ručna promjena…") this.action(v); });
    this.tb.insertBefore(this.manual, this.tbRight);
    this.tbtn("✎ Uredi", () => this.edit(), "ghost");
    this.tbtn("🗑 Obriši", () => this.delete(), "ghost");
    this.tbtn("Povijest kega", () => this._more("Povijest kega"), "ghost|rec");
    this.tbtn("🏷 Naljepnice (PDF)", () => this._more("🏷 Naljepnice (PDF)"), "ghost|rec");
    this.tbtn("Na servis", () => this._more("Na servis"), "ghost|more");
    this.tbtn("Otpiši", () => this._more("Otpiši"), "ghost|more");
    this.tbtn("🔳 QR oznake kegova", () => this._more("🔳 QR oznake kegova"), "ghost|more");
    this.tbtn("🏷 Naljepnice po vrsti piva", () => this._more("🏷 Naljepnice po vrsti piva"), "ghost|more");
    this.tbtn("Izvoz CSV", () => this._more("Izvoz CSV"), "ghost|more");
    this.sumL = {};
    const cards = h("div", { class: "cards", style: { gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" } });
    for (const s of K(this.app).KEG_STATUS) {
      this.sumL[s] = h("div", { class: "val" }, "0");
      cards.append(h("div", { class: "kpi", style: { cursor: "default", textAlign: "center" } }, h("div", { class: "lab" }, s), this.sumL[s]));
    }
    this.table = T([
      ["code", "Oznaka", 100, "w"], ["size", "Vol. (L)", 70, "e"], ["fill", "Piva (L)", 70, "e"], ["type", "Tip", 120, "w"],
      ["status", "Status", 100, "w"], ["batch", "Šarža", 90, "w"], ["beer", "Pivo", 170, "w"],
      ["filled", "Punjeno", 95, "center"], ["customer", "Kupac / lokacija", 170, "w"],
      ["since", "Od datuma", 95, "center"], ["days", "Dana", 60, "e"], ["note", "Napomena", 150, "w"]],
    { multi: true, onDouble: () => this.history() });
    this.search(this.table);
    this.content.append(cards, this.table.el);
  }

  async _more(v) {
    try {
      if (v === "Na servis" || v === "Otpiši") await this.action(v);
      else if (v === "Povijest kega") this.history();
      else if (v === "Izvoz CSV") this.table.exportCsv("kegovi");
      else if (v === "🏷 Naljepnice po vrsti piva") await printBeerLabels(this.app);
      else if (v === "🔳 QR oznake kegova") { const m = await import("./kegwork.js"); await m.qrManager(this.app); this.refresh(); }
      else if (v.startsWith("🏷")) await this.labels();
    } catch (e) { this.err(e); }
  }

  async labels(ids = null) {
    ids = ids || this.table.selectedIds();
    return printKegLabels(this.app, ids);
  }

  refresh() {
    const sum = this.db.keg_summary();
    for (const [s, n] of Object.entries(sum)) if (this.sumL[s]) this.sumL[s].textContent = String(n);
    this.table.setRows(this.db.kegs().map((k) => {
      const dd = k.status_date ? -daysLeft(k.status_date) : "";
      const tag = { "Pun": "ok", "Kod kupca": typeof dd === "number" && dd > 45 ? "warn" : "", "Prljav": "warn",
        "Servis": "bad", "Otpisan": "muted" }[k.status] || "";
      return { id: k.id, code: k.code, size: fq(k.size_l), fill: k.fill_l ? fq(k.fill_l, 2) : "", type: k.keg_type || "", status: k.status, batch: k.batch_no || "",
        beer: k.beer || "", filled: d2ui(k.filled_date), customer: k.customer || "", since: d2ui(k.status_date),
        days: dd, note: k.note || "", _tag: tag };
    }));
  }

  async new() {
    const d = await askForm("Novi kegovi", [
      { key: "prefix", label: "Prefiks oznake", default: "Keg-" },
      { key: "start", label: "Od broja", type: "num", default: 1, min: 0 },
      { key: "count", label: "Broj kegova", type: "num", default: 1, min: 1 },
      { key: "size_l", label: "Volumen (L)", type: "num", default: kegSize(this), required: true, positive: true },
      { key: "keg_type", label: "Tip (npr. Euro, KeyKeg, Slim)", default: "Euro" },
      { key: "note", label: "Napomena" }]);
    if (!d) return;
    let made = 0; const skipped = [];
    const existing = new Set(this.db.kegs().map((k) => k.code));
    for (let n = Math.trunc(d.start); n < Math.trunc(d.start) + Math.trunc(d.count); n++) {
      const code = `${d.prefix || ""}${String(n).padStart(3, "0")}`;
      if (existing.has(code)) { skipped.push(code); continue; }
      this.db.save_keg({ code, size_l: d.size_l, keg_type: d.keg_type, note: d.note });
      made++;
    }
    this.app.refreshAll();
    this.app.toast(`Dodano ${made} kegova.` + (skipped.length ? ` Preskočeno (već postoje): ${skipped.join(", ")}` : ""));
  }

  async edit() {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Označite jedan ili više kegova (Ctrl/Shift za više; na mobitelu dodirom).", "Uredi");
    const statuses = ["— bez promjene —"].concat(K(this.app).KEG_STATUS);
    if (ids.length === 1) {
      const k = this.db.one("SELECT * FROM kegs WHERE id=?", [ids[0]]);
      const init = { ...k }; delete init.status;
      const d = await askForm(`Keg ${k.code}`, [
        { key: "code", label: "Oznaka", required: true }, { key: "size_l", label: "Volumen (L)", type: "num" },
        { key: "keg_type", label: "Tip" },
        { key: "status", label: "Status (ručna ispravka)", type: "combo", options: statuses, default: statuses[0] },
        { key: "customer", label: "Kupac / lokacija", type: "combo", editable: true, options: this.db.customer_names() },
        { key: "note", label: "Napomena" }], init);
      if (!d) return;
      if (d.code !== k.code && this.db.val("SELECT 1 FROM kegs WHERE code=? AND id<>?", [d.code, k.id])) return this.err(`Oznaka ${d.code} već postoji.`);
      if (d.status === null || d.status === statuses[0]) d.status = null;
      d.customer = d.customer || "";
      try { this.db.kegs_bulk_update(ids, d); } catch (e) { return this.err(e); }
    } else {
      const codes = ids.map((i) => this.db.one("SELECT code FROM kegs WHERE id=?", [i]).code).sort();
      const d = await askForm(`Grupna izmjena – ${ids.length} kegova`, [
        { key: "info", label: "Odabrani kegovi", type: "info", default: codes.slice(0, 10).join(", ") + (codes.length > 10 ? " …" : "") },
        { label: "Nove oznake (neobavezno)", type: "section" },
        { key: "renum", label: "Promijeni oznake redom (po sadašnjem redoslijedu oznaka)", type: "check" },
        { key: "prefix", label: "Prefiks (npr. K20-, PA)" },
        { key: "start", label: "Početni broj", type: "num", min: 0, default: 1 },
        { key: "digits", label: "Broj znamenki (npr. 3 → 001)", type: "num", min: 1, default: 3 },
        { label: "Ostalo – prazno polje ostaje kako je", type: "section" },
        { key: "size_l", label: "Volumen (L)", type: "num", min: 0 },
        { key: "keg_type", label: "Tip" },
        { key: "status", label: "Status (ručna ispravka)", type: "combo", options: statuses, default: statuses[0] },
        { key: "note", label: "Napomena" }], {}, { columns: 1, width: 560 });
      if (!d) return;
      const data = { size_l: d.size_l || null, keg_type: d.keg_type, note: d.note,
        status: d.status === null || d.status === statuses[0] ? null : d.status };
      const renum = d.renum ? [d.prefix || "", Math.trunc(d.start || 1), Math.trunc(d.digits || 3)] : null;
      try { this.db.kegs_bulk_update(ids, data, renum); } catch (e) { return this.err(e); }
    }
    this.app.refreshAll();
    this.app.toast(`Izmijenjeno kegova: ${ids.length}.`);
  }

  async delete() {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Označite kegove koje želite obrisati.", "Brisanje");
    const codes = ids.map((i) => this.db.one("SELECT code FROM kegs WHERE id=?", [i]).code).sort();
    const busyK = codes.filter((c) => ["Pun", "Kod kupca"].includes(this.db.val("SELECT status FROM kegs WHERE code=?", [c])));
    let msg = `Trajno obrisati ${ids.length} keg(ov)a?\n${codes.slice(0, 12).join(", ")}${codes.length > 12 ? " …" : ""}\n\n`
      + "Briše se i povijest tih kegova. Evidencije pakiranja i otpremnice ostaju (oznake su u njima upisane tekstom).";
    if (busyK.length) msg += `\n\n⚠ Puni ili kod kupca: ${busyK.join(", ")}`;
    msg += "\n\nAko je keg samo izbačen iz upotrebe, bolje je Više… → Otpiši.";
    if (await confirm(msg, "Brisanje kegova", { danger: true })) {
      this.db.delete_kegs(ids);
      this.app.refreshAll();
      this.app.toast(`Obrisano kegova: ${ids.length}.`);
    }
  }

  async action(action) {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Odaberite jedan ili više kegova.", "Odabir");
    const fields = [{ key: "date", label: "Datum", type: "date", required: true, default: today() }];
    if (action === "Napuni") {
      const bs = this.db.batches().filter((b) => ["Fermentacija", "Odležavanje", "Pakirano"].includes(b.status));
      fields.unshift({ key: "batch_id", label: "Šarža", type: "combo", required: true,
        options: bs.map((b) => [`${b.batch_no} · ${b.recipe} (${b.status})`, b.id]) });
    }
    if (action === "Isporuči") {
      fields.unshift({ key: "customer", label: "Kupac", type: "combo", editable: true, required: true, options: this.db.customer_names() });
    }
    fields.push({ key: "note", label: "Napomena" });
    if (action === "Napuni") {
      fields.push({ key: "operator", label: "Operater", type: "combo", editable: true, options: this.db.employee_names(),
        default: opBrew(this.db) },
      { key: "cip", label: "CIP kegova proveden prije punjenja – otvori zapisnik", type: "check", default: 1 },
      { key: "pack", label: "Upiši u HACCP evidenciju pakiranja", type: "check", default: 1 },
      { key: "labels", label: "Nakon punjenja ispiši naljepnice", type: "check", default: 1 });
      fillFields(this, ids, fields);
    }
    if (action === "Isporuči") {
      const bad = ids.map((i) => this.db.keg_ship_error(this.db.one("SELECT * FROM kegs WHERE id=?", [i]))).filter(Boolean);
      if (bad.length) return this.err(bad.join("\n"));
    }
    const d = await askForm(`${action} – ${ids.length} keg(ov)a`, fields, {}, { okText: action, columns: action === "Napuni" ? 2 : undefined });
    if (!d) return;
    const litres = (i) => (action === "Napuni" ? d["l_" + i] : null);
    if (action === "Napuni" && d.cip) {
      const codes = this.app.py.call("web_extras.compress_codes", ids.map((i) => this.db.one("SELECT code FROM kegs WHERE id=?", [i]).code));
      const b = this.db.batch(d.batch_id);
      const cd = haccpFn(this.app, "cipDefaults");
      if (cd) {
        let init = null;
        try {
          init = cd(this.app, { cip_type: "CIP kegova prije punjenja", equipment: ["Kegovi", "Keg punilica"], keg_codes: codes,
            batch_no: b.batch_no, date: d.date, ver_date: d.date, review_date: d.date,
            operator: d.operator || opDoc(this.db) });
        } catch (e) { console.error(e); }
        await callHaccp(this.app, "editCip", init, null);
      }
    }
    const errors = []; let done = 0; const filled = [];
    for (const i of ids) {
      try {
        this.db.keg_action(i, action, d.batch_id ?? null, d.customer ?? null, d.date, d.note, false, litres(i));
        done++; filled.push(i);
      } catch (e) { errors.push(e.message); }
    }
    if (errors.length && await confirm(errors.slice(0, 10).join("\n") + "\n\nŽelite li ipak provesti akciju za te kegove?", "Upozorenje")) {
      const target = K(this.app).KEG_ACTIONS[action][1];
      for (const i of ids) {
        const k = this.db.one("SELECT status FROM kegs WHERE id=?", [i]);
        if (k.status !== target) {
          try {
            this.db.keg_action(i, action, d.batch_id ?? null, d.customer ?? null, d.date, d.note, true, litres(i));
            done++; filled.push(i);
          } catch (e) { this.err(e); }
        }
      }
    }
    if (action === "Napuni" && d.pack && filled.length) {
      this.db.package_from_kegs(d.batch_id, filled, d.date, d.operator);
      const b = this.db.batch(d.batch_id);
      if (["Fermentacija", "Odležavanje"].includes(b.status)) this.db.update_batch(b.id, { status: "Pakirano" });
    }
    this.app.refreshAll();
    this.app.toast(`${action}: ${done} keg(ov)a.` + (action === "Napuni" && d.pack && filled.length ? " Pakiranje upisano u HACCP evidenciju." : ""));
    if (action === "Napuni" && filled.length && d.labels) {
      await this.labels(filled);
    }
  }

  history() {
    const id = this.need(this.table, "keg");
    if (!id) return;
    const k = this.db.one("SELECT * FROM kegs WHERE id=?", [id]);
    const rows = this.db.keg_log(id).map((g) => ({ id: g.id, ts: d2ui(g.ts.slice(0, 10)) + g.ts.slice(10), action: g.action,
      status: g.status, batch: g.batch_no || "", customer: g.customer || "", note: g.note || "" }));
    tableDialog(`Povijest kega ${k.code}`, [
      ["ts", "Vrijeme", 140, "w"], ["action", "Akcija", 130, "w"], ["status", "Novi status", 100, "w"],
      ["batch", "Šarža", 90, "w"], ["customer", "Kupac", 160, "w"], ["note", "Napomena", 180, "w"]], rows);
  }
}

// ================================================================== Planer fermentora
class PlannerPage extends Page {
  static title = "Plan fermentora";
  static flat = true;
  static subtitle = "Koja je šarža u kojem fermentoru i do kada · iscrtkano = procjena kraja · svijetlo = planirano";

  build() {
    this.tbtn("＋ Planiraj šaržu", () => this.app.show("batches", "new"));
    this.tbtn("◀ Ranije", () => this.shift(-14), "ghost");
    this.tbtn("Danas", () => this.shift(null), "ghost");
    this.tbtn("Kasnije ▶", () => this.shift(14), "ghost");
    this.start = addDays(today(), -14);
    this.days = 63;
    this.card = h("div", { class: "chart", style: { overflowX: "auto" } });
    this.info = h("div", { class: "msg" });
    this.content.append(this.card, this.info);
  }

  shift(days) {
    this.start = days === null ? addDays(today(), -14) : addDays(this.start, days);
    this.draw();
  }

  refresh() { this.draw(); }

  draw() {
    const W = 1200;
    const tanks = this.db.fermentors().map((f) => f.name);
    const end = addDays(this.start, this.days);
    const [bars, conflicts] = this.db.planner(this.start, end);
    for (const b of bars) if (!tanks.includes(b.tank)) tanks.push(b.tank);
    const left = 130, top = 66;
    const rowH = Math.min(70, (360 - top - 10) / Math.max(1, tanks.length));
    const H = top + rowH * tanks.length + 26;
    const dw = (W - left - 10) / this.days;
    const X = (d) => left + dayDiff(d, this.start) * dw;
    const months = ["sij", "velj", "ožu", "tra", "svi", "lip", "srp", "kol", "ruj", "lis", "stu", "pro"];
    const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: { minWidth: "820px", fontFamily: "inherit" } });
    const muted = { fill: "var(--muted)" }, grid = { stroke: "var(--line)" };
    for (let i = 0; i <= this.days; i++) {
      const day = addDays(this.start, i);
      const dd = new Date(day + "T12:00:00");
      const x = left + i * dw;
      if (dd.getDay() === 1) {
        svg.append(S("line", { x1: x, y1: top - 6, x2: x, y2: top + rowH * tanks.length, style: grid }));
        svg.append(S("text", { x: x + 3, y: top - 12, "font-size": 11, style: muted }, `${dd.getDate()}. ${months[dd.getMonth()]}`));
      }
    }
    tanks.forEach((tank, r) => {
      const y = top + r * rowH;
      svg.append(S("line", { x1: left, y1: y + rowH, x2: W - 10, y2: y + rowH, style: grid }));
      svg.append(S("text", { x: 12, y: y + rowH / 2 + 5, "font-size": 13, "font-weight": 700, style: { fill: "var(--text)" } }, tank));
    });
    const tx = X(today());
    svg.append(S("line", { x1: tx, y1: top - 4, x2: tx, y2: top + rowH * tanks.length, stroke: "#E0675A", "stroke-width": 2, "stroke-dasharray": "4 3" }));
    svg.append(S("text", { x: tx, y: top + rowH * tanks.length + 16, "text-anchor": "middle", fill: "#E0675A", "font-size": 11, "font-weight": 700 }, "danas"));
    const bad = new Set();
    for (const [a, c] of conflicts) { bad.add(a.batch_id); bad.add(c.batch_id); }
    for (const b of bars) {
      const r = tanks.indexOf(b.tank);
      const y = top + r * rowH + rowH * 0.2;
      const bh = rowH * 0.6;
      const x0 = Math.max(left, X(b.start)), x1 = Math.min(W - 10, X(b.end));
      if (x1 <= left) continue;
      const col = bad.has(b.batch_id) ? "#E0675A" : (b.status === "Fermentacija" ? "#4F9DDE" : b.status === "Odležavanje" ? "#E3A12B"
        : b.planned ? "#8A8F98" : "#5BBF7A");
      const g = S("g", { style: { cursor: "pointer" } });
      g.append(S("title", {}, `${b.batch_no} · ${b.recipe || ""}\n${d2ui(b.start)} – ${d2ui(b.end)}${b.estimated ? " (procjena)" : ""} · ${b.status}`));
      if (b.planned) g.append(S("rect", { x: x0, y, width: Math.max(1, x1 - x0), height: bh, fill: "#C9CDD4", stroke: bad.has(b.batch_id) ? "#E0675A" : "#8A8F98", "stroke-dasharray": "4 3", "stroke-width": 2 }));
      else g.append(S("rect", { x: x0, y, width: Math.max(1, x1 - x0), height: bh, fill: col, stroke: col }));
      if (b.estimated) g.append(S("line", { x1, y1: y - 2, x2: x1, y2: y + bh + 2, "stroke-dasharray": "2 2", style: { stroke: "var(--text)" } }));
      if (x1 - x0 > 60) {
        const label = `${b.batch_no} · ${b.recipe || ""}`;
        const maxCh = Math.floor((x1 - x0 - 10) / 6.5);
        g.append(S("text", { x: x0 + 6, y: y + bh / 2 + 4, fill: "#111111", "font-size": 11, "font-weight": 700 },
          label.length > maxCh ? label.slice(0, Math.max(1, maxCh - 1)) + "…" : label));
      }
      g.addEventListener("dblclick", () => this.open(b.batch_id));
      svg.append(g);
    }
    const lg = [["#4F9DDE", "Fermentacija"], ["#E3A12B", "Odležavanje"], ["#5BBF7A", "Pakirano / završeno"],
      ["#8A8F98", "Planirano"], ["#E0675A", "Preklapanje!"]];
    let x = left;
    for (const [col, txt] of lg) {
      svg.append(S("rect", { x, y: 6, width: 12, height: 12, fill: col }));
      svg.append(S("text", { x: x + 18, y: 16, "font-size": 11, style: muted }, txt));
      x += 30 + txt.length * 7;
    }
    this.card.innerHTML = "";
    this.card.append(svg);
    const msg = [];
    for (const f of tanks) {
      const fr = this.db.free_from(f);
      msg.push(`${f}: slobodan od ${fr && fr > today() ? d2ui(fr) : "danas"}`);
    }
    let text = msg.join("   ·   ");
    if (conflicts.length) text += "\n⚠ Preklapanje: " + conflicts.map(([a, c]) => `${a.batch_no} i ${c.batch_no} (${a.tank})`).join("; ");
    text += "\nDvoklik na traku otvara šaržu. Kraj se procjenjuje iz recepture (dana u fermentoru) dok se ne upiše završetak fermentacije.";
    this.info.textContent = text;
  }

  open(batchId) {
    const p = this.app.show("batches");
    if (p && p.table) {
      p.table.select([batchId]);
      const tr = p.table.tbody.querySelector(`tr[data-id="${batchId}"]`);
      if (tr) tr.scrollIntoView({ block: "nearest" });
    }
  }
}

// ================================================================== Kupci i otpremnice
class DeliveryDialog extends Dialog {
  constructor(page) {
    super("Nova otpremnica", { width: 900 });
    this.page = page; this.db = page.db;
    const custs = this.db.customers_list();
    this.cmap = new Map(custs.map((c) => [c.name, c.id]));
    this.cust = h("select", {}, h("option", { value: "" }, ""), custs.map((c) => h("option", { value: c.name }, c.name)));
    this.date = h("input", { type: "date", value: today() });
    this.note = h("input", { placeholder: "Napomena" });
    const lab = (t, el) => h("div", { class: "fcell", style: { flex: "1 1 200px" } }, h("label", { class: "flab" }, t), el);
    this.body.append(h("div", { class: "row", style: { gap: "10px", alignItems: "flex-end" } },
      lab("Kupac", this.cust), lab("Datum", this.date), lab("Napomena", this.note)));
    this.body.append(h("div", { class: "sec", style: { marginTop: "10px" } }, "1. Puni kegovi (označite one koji idu kupcu – Ctrl/Shift za više; na mobitelu dodirom)"));
    this.kegs = T([["code", "Keg", 100, "w"], ["size", "L piva", 60, "e"], ["lot", "LOT piva", 130, "w"],
      ["beer", "Pivo", 200, "w"], ["filled", "Punjeno", 100, "center"]], { multi: true, height: 7 });
    const full = this.db.kegs().filter((k) => k.status === "Pun");
    const partial = full.filter((k) => this.db.keg_ship_error(k));
    this.kegs.setRows(full.filter((k) => !partial.includes(k)).map((k) => ({ id: k.id, code: k.code, size: fq(k.fill_l || k.size_l, 2),
      lot: k.batch_no || "", beer: k.beer || "", filled: d2ui(k.filled_date) })));
    this.body.append(this.kegs.el);
    if (partial.length) {
      this.body.append(h("div", { class: "muted", style: { fontSize: "12.5px" } },
        `Nisu ponuđeni (manje od ${fq(kegFill(this))} L piva – ne izdaju se kupcu): ` + partial.map((k) => `${k.code} (${fq(k.fill_l, 2)} L)`).join(", ")));
    }
    this.body.append(h("div", { class: "sec", style: { marginTop: "10px" } }, "2. Ostalo (boce, limenke) – neobavezno"));
    this.bopts = this.db.brewed_batches().map((b) => [`${b.batch_no} · ${b.recipe}`, b.id]);
    this.bsel = h("select", { style: { flex: "1 1 240px" } }, h("option", { value: "" }, ""), this.bopts.map((o, i) => h("option", { value: String(i) }, o[0])));
    const dl = h("datalist", { id: "dn-ptype" }, ["Boca", "Limenka", "Ostalo"].map((x) => h("option", { value: x })));
    this.ptype = h("input", { list: "dn-ptype", value: "Boca", style: { width: "120px" } });
    this.qty = h("input", { placeholder: "Kom.", inputmode: "numeric", style: { width: "80px" } });
    this.unit = h("input", { placeholder: "L/kom", value: "0,5", inputmode: "decimal", style: { width: "90px" } });
    this.body.append(h("div", { class: "card row", style: { padding: "8px", gap: "8px", marginTop: "4px" } },
      this.bsel, this.ptype, dl, this.qty, this.unit, btn("+ Dodaj", () => this.add())));
    this.others = [];
    this.olbl = h("div", { class: "msg", style: { fontSize: "13px" } });
    this.body.append(this.olbl);
    this.buttons("Izradi otpremnicu", () => this.ok());
    this.onEnter = null;
  }
  add() {
    let q, u;
    try { q = Math.trunc(num(this.qty.value)); u = num(this.unit.value); } catch { return this.err("Količina i L/kom moraju biti brojevi."); }
    if (this.bsel.value === "" || q <= 0) return this.err("Odaberite šaržu i količinu.");
    const [label, id] = this.bopts[+this.bsel.value];
    const pt = this.ptype.value.trim() || "Boca";
    this.others.push({ batch_id: id, pack_type: pt, qty: q, unit_l: u, label: `${q} × ${pt} ${fq(u)} L – ${label}` });
    this.olbl.textContent = this.others.map((o) => "• " + o.label).join("\n");
    this.qty.value = "";
    this.err("");
  }
  ok() {
    if (!this.cmap.has(this.cust.value)) return this.err("Odaberite kupca (kupce dodajete u Prodaja → Otpremnice i kupci).");
    try {
      const nid = this.db.create_delivery(this.cmap.get(this.cust.value), this.date.value || today(), this.kegs.selectedIds(),
        this.others, this.note.value.trim() || null, this.db.get_setting("default_operator"));
      this.close(nid);
    } catch (e) { this.err(e.message); }
  }
}

class SalesPage extends Page {
  static title = "Otpremnice i kupci";
  static subtitle = "Otpremnica s LOT-om piva · kegovi na otpremnici automatski idu kupcu · pregled kegova i depozita po kupcu";

  static FIELDS = [{ key: "customer_type", label: "Vrsta kupca", type: "combo", options: ["Pravna osoba", "Fizička osoba"], default: "Pravna osoba" },
    { key: "name", label: "Naziv / ime i prezime", required: true }, { key: "oib", label: "OIB" },
    { key: "address", label: "Adresa (ulica i broj)" }, { key: "postal_code", label: "Poštanski broj" }, { key: "city", label: "Mjesto" },
    { key: "contact", label: "Kontakt osoba" },
    { key: "phone", label: "Telefon" }, { key: "email", label: "E-mail" }, { key: "note", label: "Napomena" }];

  build() {
    this.tbtn("＋ Nova otpremnica", () => this.newDn());
    this.tbtn("＋ Novi kupac", () => this.newC(), "ghost");
    this.tbtn("Uredi kupca", () => this.editC(), "ghost|main");
    this.tbtn("Obriši otpremnicu", () => this.delDn(), "ghost");
    this.tbtn("🖨 PDF", () => this.printDn("PDF"), "primary", true);
    this.cust = T([["name", "Kupac", 170, "w"], ["addr", "Adresa", 160, "w"], ["kegs", "Kegova kod kupca", 110, "center"],
      ["dep", "Depozit", 90, "e"]], { onDouble: () => this.editC() });
    this.dn = T([["no", "Broj", 120, "w"], ["date", "Datum", 95, "center"], ["cust", "Kupac", 160, "w"],
      ["kegs", "Kegova", 65, "center"], ["l", "Litara", 75, "e"], ["note", "Napomena", 150, "w"]],
    { onDouble: () => this.printDn("PDF") });
    const col = (t, tb) => [h("h3", { style: { margin: "0 0 4px", fontSize: "15px" } }, t), tb.el];
    this.sum = h("div", {});
    this.content.append(split(col("Kupci", this.cust), col("Otpremnice", this.dn)), this.sum);
  }

  refresh() {
    const dep = parseFloat(this.db.get_setting("keg_deposit") || 0) || 0;
    const cs = this.db.customers_list();
    this.cust.setRows(cs.map((c) => ({ id: c.id, name: c.name, addr: c.address || "", kegs: c.kegs_held || "",
      dep: dep && c.kegs_held ? money(c.kegs_held * dep) : "" })));
    this.dn.setRows(this.db.delivery_notes().map((d) => ({ id: d.id, no: d.no, date: d2ui(d.date), cust: d.customer,
      kegs: d.kegs || "", l: fq(d.litres, 1), note: d.note || "" })));
    const total = cs.reduce((a, c) => a + (c.kegs_held || 0), 0);
    this.sum.textContent = `Ukupno kegova kod kupaca: ${total}` + (dep ? ` · depozit ${money(total * dep)} (${money(dep)} po kegu)`
      : " · depozit po kegu postavite u Postavkama");
  }

  async newC() {
    const d = await askForm("Novi kupac", SalesPage.FIELDS, {}, { columns: 2 });
    if (d) { this.db.save_customer(d); this.refresh(); }
  }

  async editC() {
    const i = this.need(this.cust, "kupca");
    if (!i) return;
    const d = await askForm("Kupac", SalesPage.FIELDS, this.db.one("SELECT * FROM customers WHERE id=?", [i]), { columns: 2 });
    if (d) {
      const old = this.db.val("SELECT name FROM customers WHERE id=?", [i]);
      this.db.save_customer(d, i);
      if (old !== d.name) this.db.x("UPDATE kegs SET customer=? WHERE customer=?", [d.name, old]);
      this.refresh();
    }
  }

  async newDn() {
    if (!this.db.customers_list().length) return info("Najprije dodajte kupca (＋ Novi kupac).", "Otpremnica");
    const nid = await new DeliveryDialog(this).show();
    if (nid) {
      this.refresh();
      const no = this.db.val("SELECT no FROM delivery_notes WHERE id=?", [nid]);
      this.app.toast(`Otpremnica ${no} izrađena.`);
      if (await confirm("Ispisati otpremnicu (PDF)?", "Otpremnica")) {
        this.dn.select([nid]);
        await this.printDn("PDF");
      }
    }
  }

  async delDn() {
    const i = this.need(this.dn, "otpremnicu");
    if (i && await confirm("Obrisati otpremnicu? (Kegovi ostaju kod kupca – po potrebi ih vratite na ekranu Kegovi.)", "Brisanje")) {
      this.db.delete_delivery(i);
      this.refresh();
    }
  }

  async printDn(fmt) {
    const i = this.need(this.dn, "otpremnicu");
    if (!i) return;
    const p = await this.app.doc("web_extras.print_dn", i, fmt);
    if (p) this.app.toast(`Spremljeno: ${String(p).split("/").pop()}`);
  }
}

// ================================================================== Trošarine (MI-PI)
class ExcisePage extends Page {
  static title = "Trošarine";
  static subtitle = "Mjesečna prijava MI-PI · označite piva koja prijavljujete (✓) · ispis pokazuje žutom bojom što i gdje upisati u obrazac Carinske uprave";

  build() {
    this.monthList = this.app.py.call("web_extras.excise_months");
    this.month = h("select", { style: { width: "130px" } }, this.monthList.map(([l, v]) => h("option", { value: v }, l)));
    this.month.value = this.monthList[1][1];
    this.month.addEventListener("change", () => this.refresh());
    this.tb.insertBefore(this.month, this.tbRight);
    this.tbtn("✓ Prijavi / ne prijavi", () => this.toggle(), "ghost");
    this.tbtn("＋ Dodaj pivo", () => this.add(), "ghost");
    this.tbtn("✎ Uredi", () => this.edit(), "ghost");
    this.tbtn("🗑 Ukloni", () => this.remove(), "ghost");
    this.tbtn("Postavke", () => this.settings(), "ghost");
    this.repBtn = this.tbtn("✔ Označi kao prijavljeno", () => this.mark(), "ghost", true);
    this.tbtn("🖨 Ispis za MI-PI", () => this.printMipi(), "primary", true);
    this.banner = h("div", { class: "banner warn" });
    this.table = T([["inc", "Prijavi", 60, "center"], ["date", "Datum pakiranja", 105, "center"],
      ["lot", "LOT piva", 125, "w"], ["name", "Trgovački naziv", 170, "w"], ["hl", "Količina (hl)", 95, "e"],
      ["abv", "% vol", 65, "e"], ["cls", "Razred", 105, "w"], ["ex", "Trošarina", 100, "e"], ["note", "Napomena", 160, "w"]],
    { multi: true, onDouble: () => this.toggle() });
    this.sum = h("div", { class: "msg", style: { fontWeight: 700, fontSize: "14px" } });
    this.content.append(this.banner, this.table.el, this.sum,
      h("div", { class: "muted", style: { fontSize: "12px" } }, "Pakiranja iz odabranog mjeseca dodaju se sama. Dvoklik ili „Prijavi / ne prijavi” "
        + "uključuje i isključuje pivo. Isto pivo s istim % vol zbraja se u jedan redak specifikacije (npr. dvije šarže LAGER-a). "
        + "Izračun: hl × % vol × stopa, na 2 decimale."));
  }

  period() { return this.month.value; }
  monthLabel() { const m = this.monthList.find((x) => x[1] === this.period()); return m ? m[0] : this.period(); }

  refresh() {
    const period = this.period();
    const v = this.app.py.call("web_extras.excise_view", period);
    this.entries = v.entries;
    this.table.setRows(v.rows);
    this.sum.textContent = v.summary;
    if (v.reported) {
      this.banner.className = "banner ok";
      this.banner.textContent = `${this.monthLabel()} je prijavljen carini ${d2ui(v.reported)}.`;
      this.repBtn.textContent = "↺ Poništi oznaku prijave";
    } else {
      let txt = `${this.monthLabel()} još nije prijavljen.`;
      if (v.reminder && v.reminder[0] === period) txt = v.reminder[1] + " Odaberite piva, ispišite pomoć i predajte obrazac.";
      this.banner.className = "banner warn";
      this.banner.textContent = txt;
      setLabel(this.repBtn, "Označi kao prijavljeno");
    }
  }

  toggle() {
    for (const i of this.table.selectedIds()) {
      const e = this.entries.find((x) => x.id === i);
      if (e) this.db.save_excise_entry({ include: e.include ? 0 : 1 }, i);
    }
    this.refresh();
  }

  form(init, title) {
    const opts = [["— bez šarže (ručni unos) —", null]].concat(this.db.brewed_batches().map((b) => [`${b.batch_no} · ${b.recipe}`, b.id]));
    return askForm(title, [
      { key: "batch_id", label: "Šarža (neobavezno – za sljedivost)", type: "combo", options: opts },
      { key: "date", label: "Datum istakanja / pakiranja", type: "date", required: true },
      { key: "trade_name", label: "Trgovački naziv (kako ga prijavljujete, npr. LAGER)", required: true },
      { key: "hl", label: "Količina (hl) – npr. 2,21", type: "num", required: true, positive: true },
      { key: "abv", label: "Stvarni alkohol (% vol, jedna decimala)", type: "num", required: true, positive: true },
      { key: "include", label: "Prijavi u ovom mjesecu", type: "check" },
      { key: "note", label: "Napomena" }], init);
  }

  async add() {
    const period = this.period();
    const d = await this.form({ date: this.db.period_bounds(period)[1], include: 1 }, "Dodaj pivo za prijavu");
    if (!d) return;
    if (d.batch_id) {
      const b = this.db.batch(d.batch_id);
      d.trade_name = d.trade_name || (b.recipe || "").toUpperCase();
    }
    Object.assign(d, { period, trade_name: d.trade_name.toUpperCase(), abv: Math.round(d.abv * 10) / 10, hl: Math.round(d.hl * 1000) / 1000 });
    this.db.save_excise_entry(d);
    this.refresh();
  }

  async edit() {
    const i = this.need(this.table, "stavku");
    if (!i) return;
    const e = this.entries.find((x) => x.id === i);
    const d = await this.form(e, "Uredi stavku");
    if (!d) return;
    Object.assign(d, { trade_name: d.trade_name.toUpperCase(), abv: Math.round(d.abv * 10) / 10, hl: Math.round(d.hl * 1000) / 1000 });
    this.db.save_excise_entry(d, i);
    this.refresh();
  }

  async remove() {
    const ids = this.table.selectedIds();
    if (ids.length && await confirm("Ukloniti odabrane stavke iz prijave?\n(Pakiranje u HACCP evidenciji ostaje; ako želite da se ne prijavljuje, dovoljno je ukloniti ✓.)", "Ukloni")) {
      for (const i of ids) {
        const e = this.entries.find((x) => x.id === i);
        if (e && e.packaging_id) this.db.save_excise_entry({ include: 0 }, i);
        else this.db.delete_excise_entry(i);
      }
      this.refresh();
    }
  }

  async mark() {
    const period = this.period();
    if (this.db.excise_reported(period)) {
      if (await confirm(`Poništiti oznaku da je ${this.monthLabel()} prijavljen?`, "Prijava")) this.db.set_excise_reported(period, null);
    } else {
      const d = await askForm("Prijava predana", [{ key: "date", label: "Datum predaje obrasca MI-PI", type: "date", required: true, default: today() }],
        {}, { okText: "Označi" });
      if (d) this.db.set_excise_reported(period, d.date);
    }
    this.refresh();
  }

  async settings() {
    const keys = ["small_brewery", "excise_reduced", "excise_rate", "company_oib", "company_address", "customs_office", "excise_no"];
    const init = Object.fromEntries(keys.map((k) => [k, this.db.get_setting(k)]));
    init.small_brewery = init.small_brewery === "1";
    const d = await askForm("Trošarine – postavke", [
      { key: "small_brewery", label: "Mala nezavisna pivovara (snižena stopa)", type: "check" },
      { key: "excise_reduced", label: "Snižena stopa (€ po 1 % vol. po hl)", type: "num", min: 0 },
      { key: "excise_rate", label: "Opća stopa (€ po 1 % vol. po hl)", type: "num", min: 0 },
      { key: "company_oib", label: "OIB" }, { key: "company_address", label: "Sjedište (adresa)" },
      { key: "customs_office", label: "Carinski ured" }, { key: "excise_no", label: "Trošarinski broj" }], init, { columns: 2 });
    if (d) {
      d.small_brewery = d.small_brewery ? "1" : "0";
      for (const [k, v] of Object.entries(d)) this.db.set_setting(k, v !== null && v !== undefined ? v : "");
      this.refresh();
    }
  }

  async printMipi() {
    const period = this.period();
    const s = this.db.excise_summary(period);
    if (s.missing.length && !(await confirm(`${s.missing.length} označenih stavki nema % alkohola i neće ući u izračun. Nastaviti?`, "Nedostaje % vol"))) return;
    const p = await this.app.doc("web_extras.print_mipi", period);
    if (p) this.app.toast(`Spremljeno: ${String(p).split("/").pop()}`);
  }
}

// ================================================================== Sljedivost i povlačenje
class RecallPage extends Page {
  static title = "Sljedivost i povlačenje";
  static flat = true;
  static subtitle = "Upišite LOT sirovine (npr. dobavljačev LOT slada) ili LOT piva: program pokazuje šarže, pakiranja, kegove i kupce";

  build() {
    this.q = h("input", { placeholder: "LOT sirovine ili LOT piva…", style: { width: "320px", maxWidth: "100%" } });
    this.q.addEventListener("keydown", (e) => { if (e.key === "Enter") this.refresh(); });
    this.tb.insertBefore(this.q, this.tbRight);
    this.tbtn("🔍 Traži", () => this.refresh());
    this.tbtn("🖨 PDF", () => this.print("PDF"), "primary", true);
    this.table = T([["lvl", "Razina", 150, "w"], ["what", "Što", 300, "w"], ["detail", "Detalj", 520, "w"]]);
    this.content.append(this.table.el);
    this.rows = []; this.lastQ = "";
  }

  refresh() {
    const t = this.q.value.trim();
    this.rows = t ? this.app.py.call("web_extras.recall_rows", t) : [];
    this.lastQ = t;
    this.table.setRows(this.rows.map((r) => ({ ...r, lvl: r.lvl.replace(/^ +/, (m) => " ".repeat(m.length * 2)) })));
  }

  async print(fmt) {
    if (!this.rows.length) return info("Najprije potražite LOT.", "Ispis");
    const p = await this.app.doc("web_extras.print_recall", this.lastQ, fmt);
    if (p) this.app.toast(`Spremljeno: ${String(p).split("/").pop()}`);
  }
}

// ================================================================== Mjerenja fermentacije i senzorika
class ReadingsDialog extends Dialog {
  constructor(app, batchId) {
    const b = app.db.batch(batchId);
    super(`Mjerenja fermentacije – ${b.batch_no}`, { width: 980 });
    this.app = app; this.db = app.db; this.bid = batchId; this.rows = [];
    this.sens = h("span", { class: "muted", style: { marginLeft: "auto", fontSize: "12px" } });
    const wrapBtn = (t, fn, k) => btn(t, async () => { try { await fn(); } catch (e) { error(e); } }, k);
    this.body.append(h("div", { class: "row", style: { gap: "8px" } },
      wrapBtn("＋ Mjerenje", () => this.add()), wrapBtn("Obriši", () => this.delete(), "ghost"),
      wrapBtn("★ Senzorska ocjena", () => this.sensory(), "ghost"), this.sens));
    this.chart = h("div", { class: "chart", style: { margin: "8px 0" } });
    this.body.append(this.chart);
    this.table = T([["date", "Datum", 95, "center"], ["time", "Vrijeme", 70, "center"],
      ["sg", "Gustoća", 80, "e"], ["temp", "Temp. °C", 80, "e"], ["ph", "pH", 60, "e"],
      ["by", "Mjerio", 120, "w"], ["note", "Napomena", 220, "w"]], { height: 7 });
    this.body.append(this.table.el);
    this.buttons(null, null, "Zatvori");
    this.load();
  }

  load() {
    this.rows = this.db.readings(this.bid);
    this.table.setRows(this.rows.map((r) => ({ id: r.id, date: d2ui(r.date), time: r.time || "", sg: sg(r.sg),
      temp: r.temp !== null && r.temp !== undefined ? fq(r.temp, 1) : "", ph: r.ph ? fq(r.ph, 2) : "", by: r.by || "", note: r.note || "" })));
    const b = this.db.batch(this.bid);
    this.sens.textContent = b.sensory_score ? `Ocjena: ${fq(b.sensory_score, 1)}/5 · ${b.sensory_note || ""}` : "Senzorska ocjena još nije upisana";
    this.draw();
  }

  draw() {
    const w = 940, ht = 230;
    const svg = S("svg", { viewBox: `0 0 ${w} ${ht}`, width: w, height: ht });
    const muted = { fill: "var(--muted)" };
    const pts = this.rows.filter((r) => r.sg);
    this.chart.innerHTML = "";
    this.chart.append(svg);
    if (pts.length < 2) {
      svg.append(S("text", { x: w / 2, y: ht / 2, "text-anchor": "middle", "font-size": 13, style: muted }, "Graf se prikazuje od dva mjerenja gustoće"));
      return;
    }
    const left = 60, right = 60, top = 20, bottom = 30;
    const days = pts.map((r) => r.date);
    const d0 = days.reduce((a, b) => (a < b ? a : b)), d1 = days.reduce((a, b) => (a > b ? a : b));
    const span = Math.max(dayDiff(d1, d0), 1);
    const g = pts.map((r) => r.sg);
    const gmin = Math.min(...g) - 0.002, gmax = Math.max(...g) + 0.002;
    const temps = pts.filter((r) => r.temp !== null && r.temp !== undefined).map((r) => r.temp);
    const [tmin, tmax] = temps.length ? [Math.min(...temps) - 2, Math.max(...temps) + 2] : [0, 1];
    const X = (d) => left + dayDiff(d, d0) / span * (w - left - right);
    const Yg = (v) => top + (gmax - v) / (gmax - gmin) * (ht - top - bottom);
    const Yt = (v) => top + (tmax - v) / (tmax - tmin) * (ht - top - bottom);
    for (let k = 0; k < 5; k++) {
      const v = gmin + (gmax - gmin) * k / 4;
      const y = Yg(v);
      svg.append(S("line", { x1: left, y1: y, x2: w - right, y2: y, style: { stroke: "var(--line)" } }));
      svg.append(S("text", { x: left - 6, y: y + 4, "text-anchor": "end", fill: "#E3A12B", "font-size": 11 }, v.toFixed(3).replace(".", ",")));
      if (temps.length) svg.append(S("text", { x: w - right + 6, y: y + 4, fill: "#4F9DDE", "font-size": 11 }, fq(tmin + (tmax - tmin) * k / 4, 1)));
    }
    const xy = pts.map((r) => [X(r.date), Yg(r.sg)]);
    svg.append(S("polyline", { points: xy.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#E3A12B", "stroke-width": 3 }));
    for (const [x, y] of xy) svg.append(S("circle", { cx: x, cy: y, r: 4, fill: "#E3A12B" }));
    const tp = pts.filter((r) => r.temp !== null && r.temp !== undefined).map((r) => [X(r.date), Yt(r.temp)]);
    if (tp.length >= 2) svg.append(S("polyline", { points: tp.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#4F9DDE", "stroke-width": 2, "stroke-dasharray": "5 3" }));
    svg.append(S("text", { x: left, y: ht - 8, "font-size": 11, style: muted }, d2ui(d0)));
    svg.append(S("text", { x: w - right, y: ht - 8, "text-anchor": "end", "font-size": 11, style: muted }, d2ui(d1)));
    svg.append(S("text", { x: w / 2, y: ht - 8, "text-anchor": "middle", "font-size": 11, style: muted }, "— gustoća (lijevo)   - - temperatura °C (desno)"));
  }

  async add() {
    const last = this.rows.length ? this.rows[this.rows.length - 1] : {};
    const d = await askForm("Mjerenje", [
      { key: "date", label: "Datum", type: "date", required: true, default: today() },
      { key: "time", label: "Vrijeme (SS:MM)", default: nowHM() },
      { key: "sg", label: "Gustoća (npr. 1,012)", type: "num", min: 0 },
      { key: "temp", label: "Temperatura (°C)", type: "num", default: last.temp },
      { key: "ph", label: "pH (neobavezno)", type: "num", min: 0 },
      { key: "by", label: "Mjerio", type: "combo", editable: true, options: this.db.employee_names(), default: this.db.get_setting("default_operator") },
      { key: "note", label: "Napomena" }]);
    if (!d) return;
    d.batch_id = this.bid;
    for (const k of ["sg", "ph"]) d[k] = d[k] || null;
    this.db.save_reading(d);
    this.load();
  }

  delete() {
    const i = this.table.selectedId();
    if (i !== null) { this.db.delete_reading(i); this.load(); }
  }

  async sensory() {
    const b = this.db.batch(this.bid);
    const init = { ...b, sensory_score: b.sensory_score ? String(b.sensory_score).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") : null };
    const d = await askForm("Senzorska ocjena prije pakiranja", [
      { key: "sensory_score", label: "Ocjena (1 = loše … 5 = odlično)", type: "combo", options: ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"] },
      { key: "sensory_note", label: "Miris, okus, izgled, bistrina, pjena…", type: "multi", height: 70 },
      { key: "sensory_by", label: "Ocijenio", type: "combo", editable: true, options: this.db.employee_names(), default: this.db.get_setting("default_operator") },
      { key: "sensory_date", label: "Datum", type: "date", default: today() }], init);
    if (!d) return;
    d.sensory_score = d.sensory_score ? parseFloat(d.sensory_score) : null;
    this.db.update_batch(this.bid, d);
    this.load();
  }
}

export async function openReadings(app, batchId) {
  return new ReadingsDialog(app, batchId).show();
}

export const PAGES = {
  recipes: RecipesPage, planner: PlannerPage, batches: BatchesPage, kegs: KegsPage,
  sales: SalesPage, excise: ExcisePage, recall: RecallPage,
};
