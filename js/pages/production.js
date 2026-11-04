// Proizvodnja i prodaja: recepture, planer fermentora, šarže, kegovi, kupci i otpremnice, trošarine, sljedivost.
// Preneseno iz app.py (RecipesPage, BrewPreview, BatchesPage, KegsPage) i extras_ui.py (PlannerPage, SalesPage,
// DeliveryDialog, ExcisePage, RecallPage, ReadingsDialog, naljepnice).
import {
  h, btn, Page, Table, Form, Dialog, askForm, confirm, info, error, toast, tableDialog,
  fq, money, fin, num, d2ui, today, addDays, daysLeft, sg, EPS,
} from "../ui.js";

// ---------------------------------------------------------------- zajedničko
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
export class LinesDialog extends Dialog {
  constructor(title, headerFields, headerInitial, opts, lines, { withPrice = false, qtyLabel = "Količina", width = 860 } = {}) {
    super(title, { width });
    this.itemOpts = opts; // [[label, item_id, unit, price]]
    this.withPrice = withPrice;
    this.form = new Form(headerFields, headerInitial || {}, headerFields.length > 6 ? 3 : 2);
    this.body.append(this.form.el, h("div", { class: "sec", style: { marginTop: "10px" } }, "Stavke"));
    this.cb = h("select", { style: { flex: "1 1 260px", minWidth: "200px" } }, h("option", { value: "" }, ""),
      opts.map((o, i) => h("option", { value: String(i) }, o[0])));
    this.qty = h("input", { placeholder: qtyLabel, inputmode: "decimal", style: { width: "110px" } });
    this.price = withPrice ? h("input", { placeholder: "Cijena €/jed.", inputmode: "decimal", style: { width: "110px" } }) : null;
    this.cb.addEventListener("change", () => {
      const o = this.itemOpts[+this.cb.value];
      if (this.price && o) this.price.value = fin(o[3] || 0);
      this.qty.focus();
    });
    this.qty.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this.add(); } });
    const add = h("div", { class: "card row gap", style: { padding: "8px", gap: "8px", margin: "4px 0 6px" } },
      this.cb, this.qty, this.price, btn("+ Dodaj", () => this.add()),
      h("span", { style: { flex: "1" } }), btn("Ukloni odabrano", () => this.remove(), "ghost"));
    this.body.append(add);
    let cols = [["name", "Artikl", 320, "w"], ["qty", qtyLabel, 110, "e"], ["unit", "Jed.", 60, "center"]];
    if (withPrice) cols = cols.concat([["price", "Cijena", 100, "e"], ["total", "Iznos", 110, "e"]]);
    this.table = T(cols, { height: 8 });
    this.body.append(this.table.el);
    this.lines = (lines || []).map((ln) => ({ ...ln }));
    this.refreshLines();
    this.buttons("Spremi", () => this.ok());
  }
  refreshLines() {
    const units = new Map(this.itemOpts.map((o) => [o[1], [o[0], o[2]]]));
    this.table.setRows(this.lines.map((ln, n) => {
      const [name, unit] = units.get(ln.item_id) || [ln.name || "?", ln.unit || ""];
      const r = { id: n, name: name.includes(" (") ? name.slice(0, name.lastIndexOf(" (")) : name, qty: fq(ln.qty), unit };
      if (this.withPrice) { r.price = fq(ln.unit_price || 0, 4); r.total = money(ln.qty * (ln.unit_price || 0)); }
      return r;
    }));
  }
  add() {
    const opt = this.cb.value === "" ? null : this.itemOpts[+this.cb.value];
    let q, p;
    try { q = num(this.qty.value); p = this.price ? num(this.price.value) : 0; } catch { return this.err("Količina i cijena moraju biti brojevi."); }
    if (!opt || q <= 0) return this.err("Odaberite artikl i upišite količinu > 0.");
    this.err("");
    const ex = this.lines.find((ln) => ln.item_id === opt[1]);
    if (ex) { ex.qty = q; ex.unit_price = p; } else this.lines.push({ item_id: opt[1], qty: q, unit_price: p });
    this.qty.value = ""; this.cb.value = "";
    this.refreshLines();
  }
  remove() {
    const s = this.table.selectedId();
    if (s !== null) { this.lines.splice(+s, 1); this.refreshLines(); }
  }
  ok() {
    let head;
    try { head = this.form.get(); } catch (e) { return this.err(e.message); }
    if (!this.lines.length) return this.err("Dodajte barem jednu stavku.");
    this.close([head, this.lines]);
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
    this.tbtn("🏷 Naljepnice po vrsti piva", () => printBeerLabels(this.app), "ghost");
    this.table = T([["name", "Naziv", 200, "w"], ["code", "Oznaka", 65, "center"], ["style", "Stil", 120, "w"],
      ["size", "Šarža (L)", 90, "e"], ["n", "Sastojaka", 80, "center"], ["b", "Kuhano puta", 90, "center"]],
    { onDouble: () => this.edit(), onSelect: () => this.showLines() });
    this.lines = T([["name", "Sastojak", 250, "w"], ["qty", "Količina", 100, "e"], ["unit", "Jed.", 60, "center"],
      ["stock", "Na zalihi", 100, "e"], ["brews", "Dovoljno za", 100, "e"]]);
    this.search(this.table);
    this.content.append(split(this.table.el, this.lines.el));
  }

  refresh() {
    this.table.setRows(this.db.recipes().map((r) => ({ id: r.id, name: r.name, code: this.db.recipe_code(r.id), style: r.style || "",
      size: fq(r.batch_size_l), n: r.n_items, b: r.n_batches })));
    this.showLines();
  }

  showLines() {
    const id = this.table.selectedId();
    const rows = [];
    if (id) {
      for (const ln of this.db.recipe_lines(id)) {
        const st = this.db.stock(ln.item_id);
        const n = ln.qty ? Math.trunc(st / ln.qty) : 0;
        rows.push({ id: ln.id, name: ln.name, qty: fq(ln.qty), unit: ln.unit, stock: fq(st), brews: `${n} šarži`,
          _tag: n < 1 ? "bad" : (n < 2 ? "warn" : "") });
      }
    }
    this.lines.setRows(rows);
  }

  dialog(title, r = null, lines = []) {
    return new LinesDialog(title, [
      { key: "name", label: "Naziv piva", required: true }, { key: "style", label: "Stil" },
      { key: "code", label: "Oznaka za LOT (2 slova, npr. PA, IP, ST)" },
      { key: "batch_size_l", label: "Veličina šarže (L)", type: "num", required: true, positive: true, default: 290 },
      { key: "ferm_days", label: "Dana u fermentoru (za planer)", type: "num", min: 1, default: 14 },
      { key: "official_abv", label: "Alkohol – službena analiza (% vol)", type: "num", min: 0 },
      { key: "allergens", label: "Alergeni (prazno = automatski)" },
      { key: "label_ingredients", label: "Sastojci (prazno = automatski)" },
      { key: "label_color", label: "Boja zastavice (prazno = prema vrsti piva)", type: "combo", editable: true,
        options: [""].concat(K(this.app).LABEL_COLORS) },
      { key: "note", label: "Napomena" }], r || {}, itemOpts(this.db), lines, { qtyLabel: "Kol./šarža" }).show();
  }

  async new() {
    const res = await this.dialog("Nova receptura");
    if (res) { this.db.save_recipe(res[0], res[1]); this.app.refreshAll(); }
  }

  async edit() {
    const id = this.need(this.table, "recepturu");
    if (!id) return;
    const res = await this.dialog("Uredi recepturu", this.db.recipe(id), this.db.recipe_lines(id));
    if (res) { this.db.save_recipe(res[0], res[1], id); this.app.refreshAll(); }
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

class BatchesPage extends Page {
  static title = "Šarže piva";
  static subtitle = "Evidencija kuhanja · kod potvrde kuhanja sirovine se automatski skidaju (FIFO)";

  build() {
    this.tbtn("＋ Nova šarža", () => this.new());
    this.tbtn("🔥 Skuhaj planiranu", () => this.brew());
    this.tbtn("✎ Uredi šaržu", () => this.edit(), "ghost");
    this.tbtn("Sljedivost (LOT-ovi)", () => this.detail(), "ghost");
    this.tbtn("📈 Mjerenja", () => this.readings(), "ghost");
    this.tbtn("Storno kuhanja", () => this.undo(), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.table = T([
      ["no", "LOT piva", 120, "w"], ["recipe", "Pivo", 180, "w"], ["style", "Stil", 110, "w"],
      ["date", "Datum kuhanja", 105, "center"], ["vol", "Volumen (L)", 90, "e"], ["tank", "Tank", 100, "w"],
      ["og", "OG", 65, "e"], ["fg", "FG", 65, "e"], ["abv", "Alkohol %", 75, "e"],
      ["status", "Status", 110, "w"], ["kegs", "Kegova vani", 90, "center"], ["cost", "Trošak €/L", 85, "e"],
      ["note", "Napomena", 160, "w"]], { onDouble: () => this.detail() });
    this.search(this.table);
    this.content.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.batches().map((b) => ({
      id: b.id, no: b.batch_no, recipe: b.recipe || "", style: b.style || "", date: d2ui(b.brew_date), vol: fq(b.wort_l || b.volume_l),
      tank: b.tank || "", og: sg(b.og_sg), fg: sg(b.fg_sg), abv: b.abv ? fq(b.abv, 1) : "", status: b.status,
      kegs: b.kegs_out || "", note: b.note || "",
      cost: b.status !== "Planirano" ? fq(this.db.batch_cost(b.id)[2], 2) : "",
      _tag: b.status === "Planirano" ? "muted" : (b.status === "Fermentacija" ? "ok" : "") })));
  }

  async new() {
    const recipes = this.db.recipes();
    if (!recipes.length) return info("Najprije unesite recepturu.", "Šarža");
    const d = await askForm("Nova šarža", [
      { key: "recipe_id", label: "Receptura", type: "combo", options: recipes.map((r) => [r.name, r.id]), required: true },
      { key: "volume", label: "Volumen (L)", type: "num", required: true, positive: true, default: recipes[0].batch_size_l },
      { key: "date", label: "Datum kuhanja", type: "date", required: true, default: today() },
      { key: "batch_no", label: "LOT piva (prazno = automatski: DDMMGGGG + oznaka + broj)" },
      { key: "tank", label: "Fermentor / tank", type: "combo", editable: true, options: this.db.fermentors().map((f) => f.name) },
      { key: "brewer", label: "Kuhao", type: "combo", editable: true, options: this.db.employee_names(),
        default: this.db.get_setting("default_operator") },
      { key: "planned", label: "Samo planiraj (sirovine se ne skidaju dok se ne skuha)", type: "check" },
      { key: "note", label: "Napomena" }]);
    if (!d) return;
    if (d.tank) {
      const free = this.db.free_from(d.tank);
      if (free && free > d.date && !(await confirm(`${d.tank} je prema planeru zauzet do ${d2ui(free)}.\n\nNastaviti ipak?`, "Fermentor zauzet"))) return;
    }
    const res = await new BrewPreview(this.db, d.recipe_id, d.volume, d.planned).show();
    if (!res) return;
    let bid, b;
    try {
      bid = this.app.py.callKw("db.create_batch", [d.recipe_id, d.volume, d.date],
        { planned: !!d.planned || res === "planned", batch_no: d.batch_no, tank: d.tank, note: d.note });
      this.db.update_batch(bid, { brewer: d.brewer, wort_l: d.volume });
      b = this.db.batch(bid);
      this.app.refreshAll();
      this.app.toast(`Šarža ${b.batch_no} spremljena (${b.status}).`);
    } catch (e) { return this.err(e); }
    if (b.status !== "Planirano") await this.haccpAfterBrew(bid);
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
          default: b.brewer || this.db.get_setting("default_operator") });
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
      await callHaccp(app, "editCcp", { batch_id: bid, date: b.brew_date, operator: b.brewer || this.db.get_setting("default_operator") }, null);
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
      { key: "volume_l", label: "Volumen (L) – stvarno skuhano", type: "num", required: true, positive: true },
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
      { key: "note", label: "Napomena", type: "multi", full: true }], { ...b, volume_l: b.wort_l || b.volume_l }, { columns: 3, width: 980 });
    if (d) {
      for (const k of ["og_sg", "fg_sg", "abv", "ph", "ferm_temp", "sensory_score"]) if (!d[k]) d[k] = null;
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
    const rows = this.db.batch_consumption(id).map((c) => ({ id: c.id, name: c.name, lot: c.lot_no, qty: fq(c.qty), unit: c.unit,
      sup: c.supplier_name || "", exp: d2ui(c.expiry_date) }));
    const kegs = this.db.kegs().filter((k) => k.batch_id === id).map((k) => k.code);
    const [raw, total, perL] = this.db.batch_cost(id);
    tableDialog(`Sljedivost šarže ${b.batch_no}`, [
      ["name", "Sirovina", 230, "w"], ["lot", "LOT", 140, "w"], ["qty", "Količina", 90, "e"],
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
  static subtitle = "Ciklus: Čist → Pun (šarža) → Kod kupca → Prljav → Čist  ·  moguć višestruki odabir (Ctrl/Shift, na mobitelu dodirom)";

  build() {
    this.tbtn("＋ Novi kegovi", () => this.new());
    for (const a of ["Napuni", "Isporuči", "Vrati", "Istočeno (pivnica)", "Očisti"]) {
      this.tbtn(a, () => this.action(a), a === "Napuni" ? "primary" : "ghost");
    }
    this.tbtn("✎ Uredi", () => this.edit(), "ghost");
    this.tbtn("🗑 Obriši", () => this.delete(), "ghost");
    const opts = ["Više…", "🔳 QR oznake kegova", "🏷 Naljepnice (PDF)", "🏷 Naljepnice po vrsti piva", "Na servis", "Otpiši", "Povijest kega", "Izvoz CSV"];
    this.more = h("select", { class: "more", style: { width: "auto" } }, opts.map((o) => h("option", { value: o }, o)));
    this.more.addEventListener("change", () => { const v = this.more.value; this.more.value = "Više…"; this._more(v); });
    this.tb.insertBefore(this.more, this.tbRight);
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
        default: this.db.get_setting("default_operator") },
      { key: "cip", label: "CIP kegova proveden prije punjenja – otvori zapisnik", type: "check", default: 1 },
      { key: "pack", label: "Upiši u HACCP evidenciju pakiranja", type: "check", default: 1 });
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
            operator: d.operator || this.db.get_setting("default_operator") });
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
    if (action === "Napuni" && filled.length && await confirm("Ispisati naljepnice za napunjene kegove?", "Naljepnice")) {
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
  static title = "Planer fermentora";
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
    if (!this.cmap.has(this.cust.value)) return this.err("Odaberite kupca (kupce dodajete na ekranu Kupci i otpremnice).");
    try {
      const nid = this.db.create_delivery(this.cmap.get(this.cust.value), this.date.value || today(), this.kegs.selectedIds(),
        this.others, this.note.value.trim() || null, this.db.get_setting("default_operator"));
      this.close(nid);
    } catch (e) { this.err(e.message); }
  }
}

class SalesPage extends Page {
  static title = "Kupci i otpremnice";
  static subtitle = "Otpremnica s LOT-om piva · kegovi na otpremnici automatski idu kupcu · pregled kegova i depozita po kupcu";

  static FIELDS = [{ key: "customer_type", label: "Vrsta kupca", type: "combo", options: ["Pravna osoba", "Fizička osoba"], default: "Pravna osoba" },
    { key: "name", label: "Naziv / ime i prezime", required: true }, { key: "oib", label: "OIB" },
    { key: "address", label: "Adresa (ulica i broj)" }, { key: "postal_code", label: "Poštanski broj" }, { key: "city", label: "Mjesto" },
    { key: "contact", label: "Kontakt osoba" },
    { key: "phone", label: "Telefon" }, { key: "email", label: "E-mail" }, { key: "note", label: "Napomena" }];

  build() {
    this.tbtn("＋ Nova otpremnica", () => this.newDn());
    this.tbtn("＋ Novi kupac", () => this.newC(), "ghost");
    this.tbtn("Uredi kupca", () => this.editC(), "ghost");
    this.tbtn("Obriši otpremnicu", () => this.delDn(), "ghost");
    this.tbtn("🖨 PDF", () => this.printDn("PDF"), "primary", true);
    this.tbtn("🖨 Word", () => this.printDn("WORD"), "ghost", true);
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
      this.banner.textContent = `✔ ${this.monthLabel()} je prijavljen carini ${d2ui(v.reported)}.`;
      this.repBtn.textContent = "↺ Poništi oznaku prijave";
    } else {
      let txt = `⚠ ${this.monthLabel()} još nije prijavljen.`;
      if (v.reminder && v.reminder[0] === period) txt = "⚠ " + v.reminder[1] + " Odaberite piva, ispišite pomoć i predajte obrazac.";
      this.banner.className = "banner warn";
      this.banner.textContent = txt;
      this.repBtn.textContent = "✔ Označi kao prijavljeno";
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
  static subtitle = "Upišite LOT sirovine (npr. dobavljačev LOT slada) ili LOT piva: program pokazuje šarže, pakiranja, kegove i kupce";

  build() {
    this.q = h("input", { placeholder: "LOT sirovine ili LOT piva…", style: { width: "320px", maxWidth: "100%" } });
    this.q.addEventListener("keydown", (e) => { if (e.key === "Enter") this.refresh(); });
    this.tb.insertBefore(this.q, this.tbRight);
    this.tbtn("🔍 Traži", () => this.refresh());
    this.tbtn("🖨 PDF", () => this.print("PDF"), "primary", true);
    this.tbtn("🖨 Word", () => this.print("WORD"), "ghost", true);
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
