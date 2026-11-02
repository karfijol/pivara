// HACCP evidencije (prijenos haccp_ui.py) i upozorenja / zadaci (prijenos alerts_ui.py).
import { h, btn, Page, Table, Dialog, Form, askForm, confirm, info, error, toast, fq, d2ui, today, checkTime, sg } from "../ui.js";

// ------------------------------------------------------------------ konstante iz haccp_db (jednom iz Pythona)
let CONST = null;
function K(app) {
  if (!CONST) CONST = app.py.call("web_haccp.consts");
  return CONST;
}

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ------------------------------------------------------------------ zajednički pomoćnici
function empOpts(db) { return db.employee_names(); }
function batchOpts(db, withNone = false) {
  const o = db.brewed_batches().map((b) => [`${b.batch_no} · ${b.recipe || ""}`, b.id]);
  return (withNone ? [["— nema —", null]] : []).concat(o);
}
function fermentorOpts(db, withNone = true) {
  const o = db.fermentors().map((f) => [f.name, f.id]);
  return (withNone ? [["— nema —", null]] : []).concat(o);
}

async function printDoc(app, key, fmt, { d_from = null, d_to = null, rec_id = null, equipment_id = null } = {}) {
  const path = await app.doc("web_haccp.print_doc", key, fmt, d_from, d_to, rec_id, equipment_id);
  if (path) {
    const names = [].concat(path).map((p) => p.split("/").pop());
    app.toast(`Dokument spremljen: ${names.join(", ")}`);
  }
  return path;
}

function askPeriod(title) {
  return askForm(title, [
    { key: "d_from", label: "Od datuma", type: "date", default: yearStart() },
    { key: "d_to", label: "Do datuma", type: "date", default: today() }], {}, { okText: "Izradi dokument" });
}

// Jedna tipka: svi HACCP dokumenti za razdoblje -> ZIP za preuzimanje (u pregledniku nema odabira mape)
export async function exportAll(app) {
  const t = new Date();
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const prevEnd = new Date(t.getFullYear(), t.getMonth(), 0);
  const [dFrom, dTo] = t.getDate() <= 10
    ? [isoOf(new Date(prevEnd.getFullYear(), prevEnd.getMonth(), 1)), isoOf(prevEnd)]
    : [isoOf(first), isoOf(t)];
  const d = await askForm("Izradi sve HACCP dokumente", [
    { key: "info", label: "Dokumenti se izrađuju u jednu ZIP datoteku", type: "info",
      default: "Sve evidencije za razdoblje (PDF i/ili Word) – preuzmite ZIP i spremite ga npr. na Google Disk." },
    { key: "d_from", label: "Od datuma", type: "date", required: true, default: dFrom },
    { key: "d_to", label: "Do datuma", type: "date", required: true, default: dTo },
    { key: "fmt", label: "Format", type: "combo", options: ["PDF", "Word", "PDF i Word"], default: "PDF" }],
  {}, { okText: "Izradi", width: 620 });
  if (!d) return null;
  const fmt = { PDF: "PDF", Word: "WORD", "PDF i Word": "BOTH" }[d.fmt || "PDF"];
  const path = await app.doc("web_haccp.export_all", d.d_from, d.d_to, fmt);
  if (!path) return null;
  let res = {};
  try { res = app.py.call("web_haccp.last_export") || {}; } catch (e) { console.warn(e); }
  app.toast(`Izrađeno ${res.n ?? ""} dokumenata.`);
  if (res.errors && res.errors.length)
    await info(`Izrađeno ${res.n} dokumenata (ZIP: ${res.name}).\n\nNije izrađeno:\n` + res.errors.slice(0, 10).join("\n"), "Izrada dokumenata");
  return path;
}

// ------------------------------------------------------------------ obrasci koje koristi i ostatak programa
export function cipDefaults(app, over = {}) {
  const db = app.db;
  const last = db.last_cip() || {};
  const op = db.get_setting("default_operator");
  const base = {
    date: today(), start_time: "", end_time: "", cip_type: K(app).CIP_TYPES[1], equipment: [],
    operator: op, closed: 1,
    alk_agent: last.alk_agent || "BIS L 4040", alk_conc: last.alk_conc || 2,
    alk_temp: last.alk_temp || 65, alk_time: last.alk_time || 30, alk_ok: 1,
    rinse_ready: 1, dis_agent: last.dis_agent || "BIS PER S",
    dis_conc: last.dis_conc || 0.2, dis_time: last.dis_time || 30, dis_done: 1,
    ver_visual: 1, ver_date: today(), ver_by: op,
    ver_result: "Oprema je oprana i dezinficirana", op_sign: op,
    manager_sign: db.get_setting("prod_lead"), review_date: today(),
  };
  return Object.assign(base, over || {});
}

export async function editCip(app, initial = null, id = null) {
  const db = app.db;
  const C = K(app);
  const emps = empOpts(db);
  let init = { ...(initial || {}) };
  if (id) init = db.record("cips", id) || {};
  const fields = [
    { label: "1. Identifikacija", type: "section" },
    { key: "cip_type", label: "Vrsta CIP-a", type: "combo", options: C.CIP_TYPES, required: true },
    { key: "batch_no", label: "Broj proizvodne šarže (ako je primjenjivo)", type: "combo", editable: true,
      options: db.brewed_batches().map((b) => b.batch_no).concat(db.batches().filter((b) => b.status === "Planirano").map((b) => b.batch_no)) },
    { label: "2. Oprema", type: "section" },
    { key: "equipment", label: "Oprema obuhvaćena CIP-om", type: "multicheck", options: C.CIP_EQUIPMENT, per_row: 4 },
    { key: "fermentor_id", label: "Fermentor (oznaka)", type: "combo", options: fermentorOpts(db) },
    { key: "keg_codes", label: "Kegovi (oznake)" },
    { key: "other_eq", label: "Ostalo (opis)" },
    { label: "3. Podaci o ciklusu", type: "section" },
    { key: "date", label: "Datum CIP-a", type: "date", required: true },
    { key: "operator", label: "Operater", type: "combo", options: emps, editable: true, required: true },
    { key: "start_time", label: "Vrijeme početka (SS:MM)" },
    { key: "end_time", label: "Vrijeme završetka (SS:MM)" },
    { key: "closed", label: "Oprema ostaje zatvorena do početka proizvodnje", type: "check" },
    { label: "4. Alkalno pranje", type: "section" },
    { key: "alk_agent", label: "Sredstvo" }, { key: "alk_conc", label: "Koncentracija (%)", type: "num", min: 0 },
    { key: "alk_temp", label: "Temperatura (°C)", type: "num", min: 0 },
    { key: "alk_time", label: "Vrijeme cirkulacije (min)", type: "num", min: 0 },
    { key: "alk_ok", label: "Rezultat: zadovoljava", type: "check" },
    { key: "alk_corr", label: "Ako ne zadovoljava – korektivna radnja" },
    { label: "5. Ispiranje", type: "section" },
    { key: "rinse_ready", label: "Oprema spremna za proizvodnju", type: "check" },
    { key: "rinse_note", label: "Dodatno ispiranje (ako je provedeno)" },
    { label: "6. Dezinfekcija", type: "section" },
    { key: "dis_agent", label: "Sredstvo" }, { key: "dis_conc", label: "Koncentracija (%)", type: "num", min: 0 },
    { key: "dis_time", label: "Vrijeme kontakta (min)", type: "num", min: 0 },
    { key: "dis_done", label: "Završeno prema proceduri", type: "check" },
    { label: "7. Verifikacija", type: "section" },
    { key: "ver_visual", label: "Vizualna kontrola", type: "check" },
    { key: "ver_date", label: "Datum verifikacije", type: "date" },
    { key: "ver_by", label: "Proveo", type: "combo", options: emps, editable: true },
    { key: "ver_result", label: "Rezultat" },
    { label: "8. Korektivne radnje", type: "section" },
    { key: "corrective", label: "Korektivne radnje (ako ih je bilo)", type: "multi", full: true, height: 50 },
    { label: "9. Odobrenje", type: "section" },
    { key: "op_sign", label: "Operater (potpis)", type: "combo", options: emps, editable: true },
    { key: "manager_sign", label: "Voditelj proizvodnje (potpis)", type: "combo", options: emps, editable: true },
    { key: "review_date", label: "Datum pregleda", type: "date" },
  ];
  const validate = (d) => {
    checkTime(d.start_time, d.end_time);
    if (!(d.equipment || []).length && !d.fermentor_id) throw new Error("Označite opremu obuhvaćenu CIP-om.");
  };
  const d = await askForm("Zapisnik o provedbi CIP postupka", fields, init, { columns: 2, width: 820, validate });
  if (!d) return null;
  d.equipment = d.equipment || [];
  if (d.fermentor_id && !d.equipment.includes("Fermentor")) d.equipment.push("Fermentor");
  if (d.keg_codes && !d.equipment.includes("Kegovi")) d.equipment.push("Kegovi");
  const b = d.batch_no ? db.one("SELECT id FROM batches WHERE batch_no=?", [d.batch_no]) : null;
  d.batch_id = b ? b.id : null;
  const rid = db.save_record("cips", d, id || null);
  app.toast("CIP zapisnik spremljen.");
  return rid;
}

export async function editReceipt(app, initial = null, id = null) {
  const db = app.db;
  const C = K(app);
  const emps = empOpts(db);
  let init = { ...(initial || {}) };
  if (id) init = db.record("receipts", id) || {};
  const checks = (init.checks && typeof init.checks === "object") ? init.checks : {};
  const keys = {};
  const fields = [
    { label: "1. Osnovni podaci", type: "section" },
    { key: "date", label: "Datum prijema", type: "date", required: true },
    { key: "doc_no", label: "Otpremnica / račun" },
    { key: "supplier", label: "Dobavljač", type: "combo", editable: true, options: db.suppliers().map((s) => s.name) },
    { key: "material", label: "Naziv materijala / opis", required: true },
    { key: "mat_type", label: "Vrsta", type: "combo", options: ["Sirovina", "Ambalaža"], default: "Sirovina" },
    { key: "quantity", label: "Količina (npr. 3 kg, 3 vreće od 1 kg)" },
    { key: "lot_no", label: "LOT dobavljača" },
    { label: "2. Dokumentacija dobavljača", type: "section" },
    { key: "docs", label: "Priložena dokumentacija", type: "multicheck", options: C.RECEIPT_DOCS, per_row: 2 },
    { key: "docs_other", label: "Ostalo (dokumentacija)", full: true }];
  for (const [title, items, isPack] of [["3.1 Kontrola – svi materijali", C.RECEIPT_CHECKS_ALL, false],
    ["3.2 Dodatno za SIROVINU (slad)", C.RECEIPT_CHECKS_RAW, false],
    ["3.3 Dodatno za AMBALAŽU", C.RECEIPT_CHECKS_PACK, true]]) {
    fields.push({ label: title, type: "section" });
    for (const it of items) {
      const k = `chk${Object.keys(keys).length}`;
      keys[k] = it;
      fields.push({ key: k, label: it, type: "combo", options: ["DA", "NE", "—"], default: checks[it] || (isPack ? "—" : "DA") });
    }
  }
  fields.push(
    { label: "4.–6. Odstupanja, odluka i potpisi", type: "section" },
    { key: "deviations", label: "Opis eventualnih odstupanja", type: "multi", full: true, height: 50 },
    { key: "decision", label: "Odluka o prijemu", type: "combo", options: ["PRIHVAĆENO", "NEPRIHVATLJIVO"], default: "PRIHVAĆENO" },
    { key: "inspector", label: "Pregled izvršio", type: "combo", options: emps, editable: true, default: db.get_setting("default_operator") },
    { key: "qm", label: "QM provjera", type: "combo", options: emps, editable: true },
    { key: "qm_date", label: "Datum", type: "date", default: today() });
  const validate = (d) => {
    if (d.decision === "NEPRIHVATLJIVO" && !d.deviations) throw new Error("Za neprihvatljiv prijem opišite odstupanja.");
  };
  const d = await askForm("Evidencija prijema materijala", fields, init, { columns: 2, width: 820, validate });
  if (!d) return null;
  const ch = {};
  for (const k of Object.keys(d)) {
    if (k in keys) {
      if (d[k] !== null && d[k] !== undefined && d[k] !== "—") ch[keys[k]] = d[k];
      delete d[k];
    }
  }
  d.checks = ch;
  d.lot_id = init.lot_id ?? null;
  const rid = db.save_record("receipts", d, id || null);
  app.toast("Zapisnik o prijemu spremljen.");
  return rid;
}

export async function editCcp(app, initial = null, id = null) {
  const db = app.db;
  let init = { ...(initial || {}) };
  if (id) init = db.record("ccp_boil", id) || {};
  if (!("temp" in init)) init.temp = 100;
  if (!("operator" in init)) init.operator = db.get_setting("default_operator");
  const validate = (d) => {
    checkTime(d.start_time, d.end_time);
    if (!d.start_time || !d.end_time) throw new Error("Upišite vrijeme početka i završetka kuhanja.");
    if ((d.temp || 0) < 100 && !d.corrective)
      throw new Error("Temperatura je ispod 100 °C – upišite korektivnu radnju (produženo kuhanje...).");
  };
  const d = await askForm("CCP kontrola kuhanja sladovine", [
    { key: "batch_id", label: "Šarža (LOT)", type: "combo", options: batchOpts(db), required: true },
    { key: "date", label: "Datum", type: "date", required: true, default: today() },
    { key: "start_time", label: "Vrijeme početka kuhanja (SS:MM)", required: true },
    { key: "end_time", label: "Vrijeme završetka kuhanja (SS:MM)", required: true },
    { key: "temp", label: "Temperatura kuhanja (°C) – granica ≥ 100 °C", type: "num", required: true },
    { key: "corrective", label: "Korektivna radnja (ako postoji)" },
    { key: "operator", label: "Operater", type: "combo", options: empOpts(db), editable: true, required: true },
  ], init, { validate });
  if (!d) return null;
  d.minutes = null;
  d.lot = null;
  const rid = db.save_ccp(d, id || null);
  app.toast("CCP zapis spremljen." + ((d.temp || 0) >= 100 ? "" : " Temperatura ispod granice – zabilježena korektivna radnja."));
  return rid;
}

export async function editMillCheck(app, initial = null, id = null) {
  const db = app.db;
  const m = db.mill();
  if (!m) { await info("U opremi nije upisan mlin (kategorija 'Mlin').", "Mlin"); return null; }
  let init = { ...(initial || {}) };
  if (id) init = db.record("eq_checks", id) || {};
  const d = await askForm(`Kontrola mlina – ${m.name}`, [
    { key: "date", label: "Datum pregleda", type: "date", required: true, default: today() },
    { key: "note", label: "Napomena", default: "Uređaj je u redu" },
    { key: "operator", label: "Operater", type: "combo", options: empOpts(db), editable: true, default: db.get_setting("default_operator") },
    { key: "batch_id", label: "Za šaržu (neobavezno)", type: "combo", options: batchOpts(db, true) }], init);
  if (!d) return null;
  Object.assign(d, { equipment_id: m.id, kind: "kontrola" });
  return db.save_record("eq_checks", d, id || null);
}

// ------------------------------------------------------------------ osnova panela
class Panel {
  static title = "";
  static info = "";
  static key = null;

  constructor(page) {
    this.page = page; this.app = page.app;
    const C = this.constructor;
    this.key = C.key;
    this.el = h("div", { class: "panel" });
    this.tb = h("div", { class: "toolbar", style: { margin: "4px 0 0" } });
    this.tbRight = h("div", { class: "tb-right" });
    this.tb.append(this.tbRight);
    this.body = h("div", { class: "content" });
    this.el.append(h("div", { class: "panel-head" }, h("h2", {}, C.title), C.info ? h("div", { class: "muted" }, C.info) : null),
      this.tb, this.body);
    this.build();
  }
  get db() { return this.app.db; }
  build() {}
  refresh() {}
  err(e) { console.error(e); error(e instanceof Error ? e.message : String(e)); }
  tbtn(text, fn, kind = "ghost", right = false) {
    const b = btn(text, async () => { try { await fn(); } catch (e) { this.err(e); } }, kind);
    if (right) this.tbRight.append(b); else this.tb.insertBefore(b, this.tbRight);
    return b;
  }
  printButtons() {
    this.tbtn("🖨 PDF", () => this.print("PDF"), "primary", true);
    this.tbtn("🖨 Word", () => this.print("WORD"), "ghost", true);
  }
  async print(fmt) {
    const p = await askPeriod(`Ispis: ${K(this.app).DOC_NAMES[this.key]}`);
    if (p) await printDoc(this.app, this.key, fmt, p);
  }
  need(table, what = "zapis") {
    const i = table.selectedId();
    if (i === null || i === undefined) { info(`Najprije odaberite ${what} u tablici.`, "Odabir"); return null; }
    return i;
  }
  done() { this.refresh(); }
}

class RecordPanel extends Panel {
  async print(fmt) {
    const rid = this.need(this.table);
    if (rid !== null) await printDoc(this.app, this.key, fmt, { rec_id: rid });
  }
  async delete(tableName) {
    const rid = this.need(this.table);
    if (rid !== null && await confirm("Obrisati odabrani zapis?", "Brisanje")) {
      this.db.delete_record(tableName, rid);
      this.done();
    }
  }
}

// ------------------------------------------------------------------ pregled i zadaci
class TasksPanel extends Panel {
  static title = "Pregled i zadaci";
  static info = "Što u HACCP evidencijama nedostaje ili čeka. Dvoklik na zadatak prikazuje točne zapise – " +
    "odatle ih možete odmah ispuniti, otvoriti evidenciju ili zanemariti.";

  build() {
    this.tbtn("📦 Izradi sve dokumente", () => exportAll(this.app), "primary");
    this.tbtn("↻ Osvježi", () => this.refresh());
    this.disBtn = this.tbtn("🔕 Zanemarena", () => this.showDismissed());
    this.strip = h("div", { class: "cards" });
    this.table = new Table([["area", "Područje", 130, "w"], ["text", "Zadatak", 640, "w"]], { onDouble: () => this.goto() });
    this.body.append(this.strip, this.table.el);
  }

  refresh() {
    this.strip.innerHTML = "";
    for (const f of this.db.fermentor_status()) {
      const col = f.need_cip ? "var(--warn)" : (f.state.startsWith("Prazan") ? "var(--ok)" : "var(--text)");
      this.strip.append(h("div", { class: "card", style: { padding: "10px 14px" } },
        h("div", { style: { fontWeight: 700, fontSize: "14px" } }, f.name),
        h("div", { style: { color: col, fontSize: "12.5px" } }, f.state)));
    }
    this.strip.style.display = this.strip.children.length ? "" : "none";
    const rows = rowsFor(this.db.haccp_tasks());
    this.table.setRows(rows.length ? rows : [{ id: 0, area: "✓", text: "Sve HACCP evidencije su ažurne.", _tag: "ok" }]);
    const n = dismissedCount(this.app);
    this.disBtn.textContent = n ? `🔕 Zanemarena (${n})` : "🔕 Zanemarena";
  }

  async goto() { await openWarningFromTable(this.app, this.table, () => this.refresh()); }

  async showDismissed() { await showDismissed(this.app); this.refresh(); }
}

// ------------------------------------------------------------------ fermentacija
class FermPanel extends Panel {
  static title = "Evidencija fermentacije";
  static info = "Svaka skuhana šarža: tank, početak i temperatura fermentacije, završetak, finalna gustoća i alkohol.";
  static key = "ferm";

  build() {
    this.tbtn("Uredi zapis", () => this.edit(), "primary");
    this.tbtn("✔ Završi fermentaciju", () => this.finish());
    this.tbtn("📈 Mjerenja i ocjena", () => this.readings());
    this.printButtons();
    this.table = new Table([
      ["lot", "LOT piva", 120, "w"], ["recipe", "Pivo", 150, "w"], ["tank", "Tank", 100, "w"],
      ["start", "Početak", 95, "center"], ["temp", "Temp. °C", 70, "e"], ["end", "Završetak", 95, "center"],
      ["og", "OG", 65, "e"], ["fg", "Finalna gustoća", 105, "e"], ["abv", "Etanol %", 75, "e"],
      ["by", "Odgovorna osoba", 140, "w"], ["status", "Status", 105, "w"]], { onDouble: () => this.edit() });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.brewed_batches().map((b) => {
      const missing = (b.ferm_temp === null || b.ferm_temp === undefined || b.ferm_temp === 0) || !b.ferm_by;
      return {
        id: b.id, lot: b.batch_no, recipe: b.recipe || "", tank: b.tank || "",
        start: d2ui(b.ferm_start || b.brew_date),
        temp: b.ferm_temp !== null && b.ferm_temp !== undefined ? fq(b.ferm_temp, 1) : "",
        end: d2ui(b.ferm_end), og: sg(b.og_sg), fg: sg(b.fg_sg),
        abv: b.abv ? fq(b.abv, 1) : "", by: b.ferm_by || "", status: b.status,
        _tag: missing ? "warn" : (b.ferm_end ? "ok" : ""),
      };
    }));
  }

  async edit() {
    const bid = this.need(this.table, "šaržu");
    if (bid === null) return;
    const b = this.db.batch(bid);
    const init = { ...b, ferm_start: b.ferm_start || b.brew_date };
    const d = await askForm(`Fermentacija – ${b.batch_no}`, [
      { key: "tank", label: "Tank / fermentor", type: "combo", editable: true, options: this.db.fermentors().map((f) => f.name) },
      { key: "ferm_start", label: "Datum početka fermentacije", type: "date", required: true },
      { key: "ferm_temp", label: "Temperatura fermentacije (°C)", type: "num" },
      { key: "ferm_end", label: "Datum završetka fermentacije", type: "date" },
      { key: "og_sg", label: "Originalna gustoća (npr. 1,050)", type: "num", min: 0 },
      { key: "fg_sg", label: "Finalna gustoća (npr. 1,012)", type: "num", min: 0 },
      { key: "abv", label: "Količina etanola % (prazno = izračun iz OG/FG)", type: "num", min: 0 },
      { key: "ferm_by", label: "Odgovorna osoba", type: "combo", options: empOpts(this.db), editable: true }],
    init, { columns: 2 });
    if (!d) return;
    if (!d.abv) d.abv = this.app.py.call("web_haccp.abv_from_sg", d.og_sg, d.fg_sg);
    const newlyEnded = d.ferm_end && !b.ferm_end;
    for (const k of ["og_sg", "fg_sg"]) d[k] = d[k] || null;
    this.db.update_batch(bid, d);
    this.done();
    if (newlyEnded) await this.afterEnd(bid);
  }

  async readings() {
    const bid = this.need(this.table, "šaržu");
    if (bid === null) return;
    let fn = null;
    try { fn = (await import("./production.js")).openReadings; } catch (e) { console.warn(e); }
    if (typeof fn !== "function") { await info("Mjerenja fermentacije trenutno nisu dostupna.", "Mjerenja"); return; }
    await fn(this.app, bid);
    this.done();
  }

  async finish() {
    const bid = this.need(this.table, "šaržu");
    if (bid === null) return;
    const b = this.db.batch(bid);
    const d = await askForm(`Završetak fermentacije – ${b.batch_no}`, [
      { key: "date", label: "Datum završetka", type: "date", required: true, default: today() },
      { key: "fg_sg", label: "Finalna gustoća (npr. 1,012)", type: "num", min: 0 },
      { key: "by", label: "Odgovorna osoba", type: "combo", options: empOpts(this.db), editable: true,
        default: b.ferm_by || this.db.get_setting("default_operator") }], {}, { okText: "Završi" });
    if (d) {
      this.db.finish_fermentation(bid, d.date, d.fg_sg || null, null, d.by || null);
      this.done();
      await this.afterEnd(bid);
    }
  }

  async afterEnd(bid) {
    const b = this.db.batch(bid);
    const f = b.tank ? this.db.one("SELECT * FROM equipment WHERE name=?", [b.tank]) : null;
    if (await confirm(`Fermentacija šarže ${b.batch_no} je završena.\n\nCIP se provodi nad fermentorom ` +
      "nakon fermentacije. Evidentirati CIP sada?", "CIP nakon fermentacije")) {
      await editCip(this.app, cipDefaults(this.app, { cip_type: K(this.app).CIP_TYPES[0], batch_no: b.batch_no,
        fermentor_id: f ? f.id : null, equipment: ["Fermentor"], date: b.ferm_end || today() }));
      this.done();
    }
  }
}

// ------------------------------------------------------------------ kuhanje i utrošak
class ConsumptionDialog extends Dialog {
  constructor(panel, batchId) {
    const b = panel.db.batch(batchId);
    super(`Utrošak sirovina – ${b.batch_no}`, { width: 860 });
    this.panel = panel; this.app = panel.app; this.db = panel.db; this.bid = batchId;
    this.body.append(h("div", { class: "muted", style: { marginBottom: "8px" } },
      "Stvarno utrošene količine. Povećanje se skida s najstarijih LOT-ova (FIFO), smanjenje se vraća u zadnje korištene LOT-ove."));
    const bar = h("div", { class: "row gap", style: { marginBottom: "6px" } },
      btn("Promijeni količinu", () => this.change().catch((e) => error(e))),
      btn("+ Dodaj sirovinu", () => this.add().catch((e) => error(e)), "ghost"));
    this.table = new Table([["cat", "Vrsta", 90, "w"], ["name", "Sirovina", 230, "w"], ["qty", "Količina", 90, "e"],
      ["unit", "Jed.", 50, "center"], ["lots", "LOT-ovi", 300, "w"]], { onDouble: () => this.change(), height: 10 });
    this.body.append(bar, this.table.el);
    this.buttons(null, null, "Zatvori");
    this.load();
  }

  load() {
    this.rows = {};
    for (const r of this.db.batch_item_totals(this.bid)) this.rows[String(r.item_id)] = r;
    this.table.setRows(Object.values(this.rows).map((r) => ({
      id: r.item_id, cat: r.category || "", name: r.name, qty: r.display && !r.qty ? r.display : fq(r.qty),
      unit: r.unit, lots: r.lots || "" })));
  }

  async change() {
    const iid = this.table.selectedId();
    if (iid === null) return;
    const r = this.rows[String(iid)];
    const d = await askForm(r.name, [{ key: "qty", label: `Ukupno utrošeno (${r.unit})`, type: "num", min: 0, required: true }], { qty: r.qty });
    if (d) await this._apply(iid, d.qty);
  }

  async add() {
    const opts = this.app.py.callKw("db.items", [], { chemicals: false }).map((i) => [`${i.name} (${i.unit})`, i.id]);
    const d = await askForm("Dodatna sirovina (npr. dry hop)", [
      { key: "item_id", label: "Sirovina", type: "combo", options: opts, required: true },
      { key: "qty", label: "Količina", type: "num", required: true, positive: true }]);
    if (d) {
      const cur = (this.rows[String(d.item_id)] || {}).qty || 0;
      await this._apply(d.item_id, cur + d.qty);
    }
  }

  async _apply(itemId, qty) {
    try { this.db.batch_set_item_qty(this.bid, itemId, qty); } catch (e) { await error(e.message, "Utrošak"); return; }
    this.load();
    this.panel.done();
  }
}

class BrewPanel extends Panel {
  static title = "Evidencija kuhanja i utroška sirovina";
  static info = "Utrošak se puni automatski pri kuhanju (FIFO, s LOT-ovima). Ovdje upisujete volumen sladovine, OG, pH i tko je kuhao.";
  static key = "brew";

  build() {
    this.tbtn("Podaci kuhanja", () => this.edit(), "primary");
    this.tbtn("Utrošak sirovina…", () => this.consumption());
    this.tbtn("+ CCP zapis", () => this.ccp());
    this.printButtons();
    this.table = new Table([
      ["lot", "LOT piva", 120, "w"], ["date", "Datum kuhanja", 100, "center"], ["recipe", "Recept / stil", 160, "w"],
      ["vol", "Volumen sladovine (L)", 130, "e"], ["og", "OG (g/cm³)", 85, "e"], ["ph", "pH", 55, "e"],
      ["brewer", "Kuhao", 130, "w"], ["items", "Sirovina", 70, "center"], ["ccp", "CCP zapisa", 85, "center"]],
    { onDouble: () => this.consumption() });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.brewed_batches().map((b) => {
      const nItems = this.db.val("SELECT COUNT(DISTINCT item_id) FROM batch_consumption WHERE batch_id=?", [b.id]);
      const nCcp = this.db.val("SELECT COUNT(*) FROM ccp_boil WHERE batch_id=?", [b.id]);
      return {
        id: b.id, lot: b.batch_no, date: d2ui(b.brew_date),
        recipe: `${b.recipe || ""}` + (b.style ? ` / ${b.style}` : ""),
        vol: fq(b.wort_l || b.volume_l, 1), og: sg(b.og_sg), ph: b.ph ? fq(b.ph, 2) : "", brewer: b.brewer || "",
        items: nItems, ccp: nCcp || "", _tag: !nCcp || !b.brewer || !b.og_sg ? "warn" : "",
      };
    }));
  }

  async edit() {
    const bid = this.need(this.table, "šaržu");
    if (bid === null) return;
    const b = this.db.batch(bid);
    const d = await askForm(`Podaci kuhanja – ${b.batch_no}`, [
      { key: "brew_date", label: "Datum kuhanja", type: "date", required: true },
      { key: "wort_l", label: "Volumen sladovine (L)", type: "num", min: 0 },
      { key: "og_sg", label: "Originalna gustoća (g/cm³, npr. 1,050)", type: "num", min: 0 },
      { key: "ph", label: "pH", type: "num", min: 0 },
      { key: "brewer", label: "Kuhao", type: "combo", options: empOpts(this.db), editable: true }],
    { ...b, wort_l: b.wort_l || b.volume_l });
    if (d) {
      d.og_sg = d.og_sg || null;
      d.ph = d.ph || null;
      this.db.update_batch(bid, d);
      this.done();
    }
  }

  async consumption() {
    const bid = this.need(this.table, "šaržu");
    if (bid === null) return;
    await new ConsumptionDialog(this, bid).show();
    this.done();
  }

  async ccp() {
    const bid = this.table.selectedId();
    const b = bid !== null ? this.db.batch(bid) : null;
    if (await editCcp(this.app, { batch_id: bid, date: b ? b.brew_date : today() })) this.done();
  }
}

// ------------------------------------------------------------------ CCP
class CCPPanel extends Panel {
  static title = "CCP kontrola kuhanja sladovine – temperatura";
  static info = "CCP1: kritična granica ≥ 100 °C. Evidentira se svaka serija (jedan ili više unosa po LOT-u) nakon završetka ciklusa.";
  static key = "ccp";

  build() {
    this.tbtn("＋ Novi zapis", () => this.new(), "primary");
    this.tbtn("Uredi", () => this.edit());
    this.tbtn("Obriši", () => this.delete());
    this.printButtons();
    this.table = new Table([
      ["date", "Datum", 95, "center"], ["lot", "Broj serije / LOT", 130, "w"], ["start", "Početak", 75, "center"],
      ["end", "Završetak", 80, "center"], ["temp", "Temp. °C", 75, "e"], ["min", "Min", 55, "e"],
      ["limit", "≥ 100 °C", 75, "center"], ["result", "Rezultat", 75, "center"],
      ["corr", "Korektivna radnja", 200, "w"], ["op", "Operater", 130, "w"]], { onDouble: () => this.edit() });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.ccp_rows().reverse().map((c) => ({
      id: c.id, date: d2ui(c.date), lot: c.batch_no || c.lot || "", start: c.start_time || "", end: c.end_time || "",
      temp: fq(c.temp, 1), min: c.minutes || "", limit: c.limit_ok ? "DA" : "NE", result: c.result || "",
      corr: c.corrective || "/", op: c.operator || "", _tag: c.limit_ok ? "" : "bad" })));
  }

  async new() { if (await editCcp(this.app)) this.done(); }
  async edit() {
    const rid = this.need(this.table);
    if (rid !== null && await editCcp(this.app, null, rid)) this.done();
  }
  async delete() {
    const rid = this.need(this.table);
    if (rid !== null && await confirm("Obrisati CCP zapis?", "Brisanje")) { this.db.delete_record("ccp_boil", rid); this.done(); }
  }
}

// ------------------------------------------------------------------ pakiranje
class PackPanel extends Panel {
  static title = "Evidencija pakiranja";
  static info = "Punjenje kegova na ekranu Kegovi automatski upisuje pakiranje. Ovdje se dodaju boce/limenke i ispravci.";
  static key = "pack";

  build() {
    this.tbtn("＋ Novo pakiranje", () => this.new(), "primary");
    this.tbtn("Uredi", () => this.edit());
    this.tbtn("Obriši", () => this.delete());
    this.printButtons();
    this.table = new Table([
      ["date", "Datum", 105, "center"], ["lot", "LOT piva", 120, "w"], ["type", "Tip ambalaže", 90, "w"],
      ["plot", "LOT ambalaže", 150, "w"], ["units", "Kom.", 55, "e"], ["unit", "L/kom", 65, "e"],
      ["tl", "Ukupno L", 75, "e"], ["hl", "Ukupno hL", 80, "e"], ["bb", "Rok trajanja", 140, "w"], ["op", "Operater", 120, "w"]],
    { onDouble: () => this.edit() });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.packaging_rows().reverse().map((p) => ({
      id: p.id, date: d2ui(p.date), lot: p.batch_no || p.lot || "", type: p.pack_type || "", plot: p.pack_lot || "",
      units: p.units || "", unit: fq(p.unit_l, 2),
      tl: fq(p.total_l, 1) + (p.total_l && p.units && p.unit_l && Math.abs(p.total_l - p.units * p.unit_l) > 1e-6 ? " ✎" : ""),
      hl: fq((p.total_l || 0) / 100, 3),
      bb: (p.shelf_months ? `${p.shelf_months} mj. – ` : "") + d2ui(p.best_before), op: p.operator || "" })));
  }

  _form(init, title) {
    return askForm(title, [
      { key: "batch_id", label: "Šarža (LOT piva)", type: "combo", options: batchOpts(this.db), required: true },
      { key: "date", label: "Datum pakiranja", type: "date", required: true, default: today() },
      { key: "pack_type", label: "Tip ambalaže", type: "combo", options: K(this.app).PACK_TYPES, default: "Keg" },
      { key: "pack_lot", label: "LOT ambalaže (npr. K30-001–K30-013)" },
      { key: "units", label: "Broj komada", type: "num", min: 0, required: true, positive: true },
      { key: "unit_l", label: "Volumen po komadu (L)", type: "num", min: 0, required: true, positive: true },
      { key: "total_l", label: "Stvarna ukupna količina (L) – ako zadnji keg nije pun; prazno = kom × L", type: "num", min: 0 },
      { key: "shelf_months", label: "Rok trajanja (mjeseci)", type: "num", min: 0,
        default: parseInt(this.db.get_setting("shelf_months") || 6, 10) || 6 },
      { key: "operator", label: "Operater", type: "combo", options: empOpts(this.db), editable: true, default: this.db.get_setting("default_operator") },
      { key: "note", label: "Napomena" }], init, { columns: 2 });
  }

  async _save(d, id = null) {
    d.units = Math.trunc(d.units);
    d.shelf_months = Math.trunc(d.shelf_months || 0) || null;
    Object.assign(d, { best_before: null, lot: null });
    if (!d.total_l) d.total_l = null;
    else if (d.total_l > d.units * d.unit_l + 1e-6) {
      await error("Stvarna količina je veća od kom × L/kom – provjerite unos.", "Pakiranje");
      return;
    }
    this.db.save_packaging(d, id);
    this.done();
  }

  async new() {
    const d = await this._form({}, "Novo pakiranje");
    if (d) await this._save(d);
  }
  async edit() {
    const rid = this.need(this.table);
    if (rid === null) return;
    const d = await this._form(this.db.record("packaging", rid), "Uredi pakiranje");
    if (d) await this._save(d, rid);
  }
  async delete() {
    const rid = this.need(this.table);
    if (rid !== null && await confirm("Obrisati zapis o pakiranju?", "Brisanje")) { this.db.delete_record("packaging", rid); this.done(); }
  }
}

// ------------------------------------------------------------------ prijem robe
class ReceiptPanel extends RecordPanel {
  static title = "Prijem robe i ambalaže";
  static info = "Zapisnik o prijemu za svaku primljenu sirovinu i ambalažu. Primke bez zapisnika nalaze se pod 'Iz primke'.";
  static key = "receipt";

  build() {
    this.tbtn("＋ Iz primke (LOT)", () => this.fromLot(), "primary");
    this.tbtn("＋ Ručni unos", async () => { if (await editReceipt(this.app)) this.done(); });
    this.tbtn("Uredi", () => this.edit());
    this.tbtn("Obriši", () => this.delete("receipts"));
    this.printButtons();
    this.pending = h("div", { class: "banner warn" });
    this.table = new Table([
      ["date", "Datum", 95, "center"], ["material", "Materijal", 210, "w"], ["type", "Vrsta", 85, "w"],
      ["lot", "LOT", 140, "w"], ["qty", "Količina", 100, "w"], ["sup", "Dobavljač", 160, "w"],
      ["doc", "Otpremnica", 110, "w"], ["dec", "Odluka", 120, "w"], ["insp", "Pregledao", 120, "w"]],
    { onDouble: () => this.edit() });
    this.body.append(this.pending, this.table.el);
  }

  refresh() {
    const n = this.db.lots_without_receipt().length;
    this.pending.textContent = n ? `⚠ ${n} primljenih LOT-ova (zadnjih 90 dana) još nema zapisnik o prijemu.` : "";
    this.pending.style.display = n ? "" : "none";
    this.table.setRows(this.db.receipts().map((r) => ({
      id: r.id, date: d2ui(r.date), material: r.material || "", type: r.mat_type || "", lot: r.lot_no || "",
      qty: r.quantity || "", sup: r.supplier || "", doc: r.doc_no || "", dec: r.decision || "", insp: r.inspector || "",
      _tag: r.decision === "NEPRIHVATLJIVO" ? "bad" : "" })));
  }

  async fromLot() {
    const lots = this.db.lots_without_receipt(365);
    if (!lots.length) { await info("Sve primke iz zadnjih godinu dana imaju zapisnik o prijemu.", "Prijem"); return; }
    const d = await askForm("Zapisnik za primku", [{ key: "lot_id", label: "Primljeni LOT", type: "combo", required: true,
      options: lots.map((l) => [`${d2ui(l.received_date)} · ${l.item_name} · LOT ${l.lot_no}`, l.id]) }], {}, { width: 640 });
    if (d && await editReceipt(this.app, this.db.receipt_defaults(d.lot_id))) this.done();
  }

  async edit() {
    const rid = this.need(this.table);
    if (rid !== null && await editReceipt(this.app, null, rid)) this.done();
  }
}

// ------------------------------------------------------------------ CIP
class CIPPanel extends RecordPanel {
  static title = "Zapisnik o provedbi CIP postupka";
  static info = "CIP se provodi nad svakim fermentorom prije kuhanja i nakon fermentacije, nad kegovima prije istakanja " +
    "piva u kegove, a nad sustavom za kuhanje po potrebi.";
  static key = "cip";

  build() {
    this.tbtn("＋ Novi CIP", () => this.new(), "primary");
    this.tbtn("Uredi", () => this.edit());
    this.tbtn("Kopiraj kao novi", () => this.copy());
    this.tbtn("Obriši", () => this.delete("cips"));
    this.printButtons();
    this.strip = h("div", { style: { fontSize: "12.5px" } });
    this.table = new Table([
      ["date", "Datum", 110, "center"], ["time", "Vrijeme", 105, "center"], ["type", "Vrsta CIP-a", 220, "w"],
      ["eq", "Oprema", 260, "w"], ["batch", "Šarža", 110, "w"], ["op", "Operater", 110, "w"],
      ["res", "Rezultat", 110, "w"]], { onDouble: () => this.edit() });
    this.body.append(this.strip, this.table.el);
  }

  refresh() {
    const st = this.db.fermentor_status();
    this.strip.textContent = st.map((f) => `${f.name}: ${f.state}`).join("   ");
    this.strip.style.display = st.length ? "" : "none";
    this.table.setRows(this.db.cips().map((c) => {
      const eq = (this.db.record("cips", c.id) || {}).equipment || [];
      const eqs = (Array.isArray(eq) ? eq : []).map((e) => e === "Fermentor"
        ? "Fermentor " + (c.fermentor || "").replace("Fermentor ", "") : e).join(", ");
      const ok = c.alk_ok && c.rinse_ready && c.dis_done;
      return { id: c.id, date: d2ui(c.date), time: `${c.start_time || ""}–${c.end_time || ""}`, type: c.cip_type || "",
        eq: eqs, batch: c.batch_no || "", op: c.operator || "", res: ok ? "Spremno" : "Odstupanje", _tag: ok ? "" : "bad" };
    }));
  }

  async new() { if (await editCip(this.app, cipDefaults(this.app))) this.done(); }
  async edit() {
    const rid = this.need(this.table);
    if (rid !== null && await editCip(this.app, null, rid)) this.done();
  }
  async copy() {
    const rid = this.need(this.table);
    if (rid === null) return;
    const r = this.db.record("cips", rid) || {};
    for (const k of ["id", "date", "ver_date", "review_date", "start_time", "end_time", "batch_no", "batch_id"]) delete r[k];
    const over = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
    if (await editCip(this.app, cipDefaults(this.app, over))) this.done();
  }
}

// ------------------------------------------------------------------ mlin i održavanje
class MillPanel extends Panel {
  static title = "Zapisnik o kontroli mlina";
  static info = "Mlin se kontrolira prije svakog kuhanja piva. Kod potvrde kuhanja program sam nudi ovaj upis.";
  static key = "mill";

  build() {
    this.tbtn("＋ Kontrola mlina", () => this.new(), "primary");
    this.tbtn("Uredi", () => this.edit());
    this.tbtn("Obriši", () => this.delete());
    this.printButtons();
    this.head = h("div", { class: "muted" });
    this.table = new Table([["date", "Datum pregleda", 120, "center"], ["note", "Napomena", 380, "w"],
      ["op", "Operater", 150, "w"], ["batch", "Šarža", 130, "w"]], { onDouble: () => this.edit() });
    this.body.append(this.head, this.table.el);
  }

  refresh() {
    const m = this.db.mill();
    this.head.textContent = m ? `${m.name} · ${m.model || ""} · ${m.manufacturer || ""}`
      : "Mlin nije upisan u opremu (Održavanje opreme → Nova oprema, kategorija 'Mlin').";
    const rows = m ? this.db.eq_checks(m.id, "kontrola") : [];
    this.table.setRows(rows.reverse().map((c) => ({ id: c.id, date: d2ui(c.date), note: c.note || "",
      op: c.operator || "", batch: c.batch_no || "" })));
  }

  async new() { if (await editMillCheck(this.app)) this.done(); }
  async edit() {
    const rid = this.need(this.table);
    if (rid !== null && await editMillCheck(this.app, null, rid)) this.done();
  }
  async delete() {
    const rid = this.need(this.table);
    if (rid !== null && await confirm("Obrisati zapis?", "Brisanje")) { this.db.delete_record("eq_checks", rid); this.done(); }
  }
}

class MaintPanel extends Panel {
  static title = "Zapisnik o održavanju opreme";
  static info = "Redovita kontrola SS Brewtech sustava 1 BBL za kuhanje i fermentora. Interval kontrole (dana) postavlja se po uređaju.";
  static key = "maint";

  eqFields() {
    return [{ key: "name", label: "Naziv opreme", required: true }, { key: "code", label: "Broj / kod uređaja" },
      { key: "model", label: "Oznaka i tip uređaja" }, { key: "manufacturer", label: "Proizvođač" },
      { key: "mfg_date", label: "Datum proizvodnje", type: "date" },
      { key: "category", label: "Kategorija", type: "combo", options: K(this.app).EQ_CATEGORIES, default: "Ostalo" },
      { key: "capacity_l", label: "Kapacitet (L)", type: "num", min: 0 },
      { key: "interval_days", label: "Interval redovite kontrole (dana, 0 = nema)", type: "num", min: 0, default: 30 },
      { key: "active", label: "Aktivna", type: "check", default: 1 }, { key: "note", label: "Napomena" }];
  }

  build() {
    this.tbtn("＋ Zapis održavanja", () => this.newCheck(), "primary");
    this.tbtn("Uredi zapis", () => this.editCheck());
    this.tbtn("Obriši zapis", () => this.delCheck());
    this.tbtn("Nova oprema", () => this.newEq());
    this.tbtn("Uredi opremu", () => this.editEq());
    this.printButtons();
    this.eq = new Table([["name", "Oprema", 220, "w"], ["cat", "Kategorija", 100, "w"], ["model", "Tip", 150, "w"],
      ["man", "Proizvođač", 120, "w"], ["int", "Interval (dana)", 105, "center"],
      ["last", "Zadnje održavanje", 125, "center"], ["due", "Sljedeće", 105, "center"]],
    { onDouble: () => this.editEq(), height: 7, onSelect: () => this.showChecks() });
    this.checks = new Table([["date", "Datum održavanja", 130, "center"], ["note", "Napomena", 420, "w"],
      ["op", "Operater", 160, "w"]], { onDouble: () => this.editCheck(), height: 8 });
    this.chkHead = h("div", { style: { fontWeight: 700, marginTop: "4px" } }, "Zapisi održavanja");
    this.body.append(this.eq.el, this.chkHead, this.checks.el);
  }

  refresh() {
    const t = today();
    const rows = this.db.equipment().map((e) => {
      let due = "", tag = "";
      if (e.interval_days) {
        if (e.last_maint) {
          const dd = new Date(e.last_maint + "T12:00:00");
          dd.setDate(dd.getDate() + e.interval_days);
          due = isoOf(dd);
        }
        tag = (!due || due < t) ? "bad" : "";
      }
      return { id: e.id, name: e.name, cat: e.category || "", model: e.model || "", man: e.manufacturer || "",
        int: e.interval_days || "—", last: d2ui(e.last_maint), due: due ? d2ui(due) : (e.interval_days ? "odmah" : ""), _tag: tag };
    });
    this.eq.setRows(rows);
    if (this.eq.selectedId() === null && rows.length) this.eq.select(rows[0].id);
    this.showChecks();
  }

  showChecks() {
    const eid = this.eq.selectedId();
    const row = this.eq.selectedRow();
    this.chkHead.textContent = "Zapisi održavanja" + (row ? ` – ${row.name}` : "");
    const rows = eid !== null ? this.db.eq_checks(eid, "odrzavanje") : [];
    this.checks.setRows(rows.reverse().map((c) => ({ id: c.id, date: d2ui(c.date), note: c.note || "", op: c.operator || "" })));
  }

  _checkForm(init, title) {
    return askForm(title, [
      { key: "date", label: "Datum održavanja", type: "date", required: true, default: today() },
      { key: "note", label: "Napomena", default: "Uređaj je u ispravnom stanju" },
      { key: "operator", label: "Operater", type: "combo", options: empOpts(this.db), editable: true, default: this.db.get_setting("default_operator") }], init);
  }

  async newCheck() {
    const eid = this.need(this.eq, "opremu");
    if (eid === null) return;
    const d = await this._checkForm({}, "Zapis održavanja – " + this.db.one("SELECT name FROM equipment WHERE id=?", [eid]).name);
    if (d) {
      Object.assign(d, { equipment_id: eid, kind: "odrzavanje" });
      this.db.save_record("eq_checks", d, null);
      this.done();
    }
  }
  async editCheck() {
    const rid = this.need(this.checks);
    if (rid === null) return;
    const d = await this._checkForm(this.db.record("eq_checks", rid), "Uredi zapis održavanja");
    if (d) { this.db.save_record("eq_checks", d, rid); this.done(); }
  }
  async delCheck() {
    const rid = this.need(this.checks);
    if (rid !== null && await confirm("Obrisati zapis održavanja?", "Brisanje")) { this.db.delete_record("eq_checks", rid); this.done(); }
  }
  async newEq() {
    const d = await askForm("Nova oprema", this.eqFields(), {}, { columns: 2 });
    if (d) {
      d.interval_days = Math.trunc(d.interval_days || 0);
      const id = this.db.save_equipment(d, null);
      this.done();
      if (id) { this.eq.select(id); this.showChecks(); }
    }
  }
  async editEq() {
    const eid = this.need(this.eq, "opremu");
    if (eid === null) return;
    const d = await askForm("Uredi opremu", this.eqFields(), this.db.one("SELECT * FROM equipment WHERE id=?", [eid]), { columns: 2 });
    if (d) {
      d.interval_days = Math.trunc(d.interval_days || 0);
      this.db.save_equipment(d, eid);
      this.done();
    }
  }
  async print(fmt) {
    const eid = this.need(this.eq, "opremu");
    if (eid === null) return;
    const p = await askPeriod("Ispis: održavanje opreme");
    if (p) await printDoc(this.app, "maint", fmt, { ...p, equipment_id: eid });
  }
}

// ------------------------------------------------------------------ štetnici
class PestPanel extends RecordPanel {
  static title = "Zapisnik o pojavi štetnika";
  static info = "Svaka uočena pojava štetnika: gdje, što, poduzete mjere i verifikacija.";
  static key = "pest";

  build() {
    this.tbtn("＋ Nova pojava", () => this.form(), "primary");
    this.tbtn("Uredi", () => { const id = this.need(this.table); if (id !== null) return this.form(id); });
    this.tbtn("Obriši", () => this.delete("pests"));
    this.printButtons();
    this.table = new Table([
      ["date", "Datum", 95, "center"], ["time", "Vrijeme", 70, "center"], ["pest", "Štetnik / količina", 220, "w"],
      ["room", "Prostorija", 150, "w"], ["corr", "Korektivne radnje", 220, "w"], ["ver", "Verifikacija", 160, "w"]],
    { onDouble: (id) => this.form(id) });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.pests().map((p) => ({
      id: p.id, date: d2ui(p.date), time: p.time || "", pest: p.pest || "", room: p.room || "", corr: p.corrective || "",
      ver: (d2ui(p.ver_date) + " " + (p.ver_result || "")).trim(), _tag: p.ver_date ? "" : "warn" })));
  }

  async form(rid = null) {
    const emps = empOpts(this.db);
    const init = rid ? this.db.record("pests", rid)
      : { date: today(), operator: this.db.get_setting("default_operator"), manager: this.db.get_setting("prod_lead") };
    const d = await askForm("Zapisnik o pojavi štetnika", [
      { label: "1. Podaci o pojavi", type: "section" },
      { key: "date", label: "Datum", type: "date", required: true }, { key: "time", label: "Vrijeme (SS:MM)" },
      { key: "pest", label: "Vrsta štetnika / količina", required: true }, { key: "room", label: "Prostorija" },
      { key: "measures", label: "Korektivne mjere", type: "multi", full: true, height: 45 },
      { label: "2. Korektivne radnje", type: "section" },
      { key: "corrective", label: "Korektivne radnje", type: "multi", full: true, height: 45 },
      { key: "corrective_date", label: "Datum provođenja", type: "date" },
      { label: "3. Verifikacija kontrole", type: "section" },
      { key: "ver_visual", label: "Vizualna kontrola", type: "check" },
      { key: "ver_date", label: "Datum verifikacije", type: "date" },
      { key: "ver_by", label: "Proveo", type: "combo", options: emps, editable: true },
      { key: "ver_result", label: "Rezultat" },
      { label: "4. Odobrenje", type: "section" },
      { key: "operator", label: "Operater", type: "combo", options: emps, editable: true },
      { key: "manager", label: "Voditelj proizvodnje", type: "combo", options: emps, editable: true },
      { key: "review_date", label: "Datum pregleda", type: "date" }], init,
    { columns: 2, width: 780, validate: (x) => checkTime(x.time) });
    if (d) { this.db.save_record("pests", d, rid); this.done(); }
  }
}

// ------------------------------------------------------------------ edukacija
class TrainingDialog extends Dialog {
  constructor(app, init) {
    super("Evidencija o edukaciji", { width: 860 });
    this.app = app; this.db = app.db;
    const emps = empOpts(this.db);
    this.form = new Form([
      { key: "topic", label: "Tema edukacije", required: true, full: true }, { key: "goal", label: "Cilj edukacije", full: true },
      { key: "date", label: "Datum", type: "date", required: true, default: today() }, { key: "time", label: "Vrijeme (SS:MM)" },
      { key: "duration_h", label: "Trajanje (h)", type: "num", min: 0 }, { key: "place", label: "Mjesto održavanja" },
      { key: "lecturer", label: "Predavač / organizator", type: "combo", options: emps, editable: true },
      { key: "test_result", label: "Rezultat provjere znanja", type: "combo", options: ["", "✔", "✖"] },
      { key: "test_methods", label: "Provjera znanja", type: "multicheck", options: ["Usmeno", "Pismeno", "Praktično"] },
      { key: "content", label: "Sadržaj edukacije (kratki opis)", type: "multi", full: true, height: 60 },
      { key: "made_by", label: "Izradio", type: "combo", options: emps, editable: true },
      { key: "reviewed_by", label: "Pregledao", type: "combo", options: emps, editable: true },
      { key: "made_date", label: "Datum", type: "date", default: today() }], init, 2);
    this.body.append(this.form.el, h("div", { style: { fontWeight: 700, fontSize: "14px", margin: "12px 0 4px" } }, "Sudionici"));
    this.roles = Object.fromEntries(this.db.employees().map((e) => [e.name, e.role || ""]));
    const dlId = "trn-emps-" + Math.random().toString(36).slice(2);
    this.name = h("input", { list: dlId, placeholder: "Ime i prezime", autocomplete: "off", style: { width: "220px" } });
    this.name.addEventListener("change", () => { this.role.value = this.roles[this.name.value.trim()] || ""; });
    this.role = h("input", { placeholder: "Funkcija", style: { width: "170px" } });
    this.note = h("select", { style: { width: "140px" } }, h("option", {}, "nova obuka"), h("option", {}, "obnova"));
    const add = h("div", { class: "card row gap", style: { padding: "8px" } },
      this.name, h("datalist", { id: dlId }, emps.map((e) => h("option", { value: e }))), this.role, this.note,
      btn("+ Dodaj", () => this.add()), btn("Svi zaposlenici", () => this.addAll(), "ghost"),
      h("span", { style: { flex: 1 } }), btn("Ukloni", () => this.remove(), "ghost"));
    this.table = new Table([["name", "Ime i prezime", 220, "w"], ["role", "Funkcija", 200, "w"], ["note", "Napomena", 160, "w"]], { height: 5 });
    this.table.el.style.marginTop = "6px";
    this.body.append(add, this.table.el);
    this.parts = Array.isArray(init.participants) ? init.participants.map((p) => ({ ...p })) : [];
    this.render();
    this.buttons("Spremi", () => this.ok());
  }

  render() { this.table.setRows(this.parts.map((p, i) => ({ ...p, id: i }))); }

  add() {
    const n = this.name.value.trim();
    if (n) {
      this.parts.push({ name: n, role: this.role.value.trim(), note: this.note.value });
      this.name.value = ""; this.role.value = "";
      this.render();
    }
  }
  addAll() {
    const have = new Set(this.parts.map((p) => p.name));
    for (const e of this.db.employees()) if (!have.has(e.name)) this.parts.push({ name: e.name, role: e.role || "", note: this.note.value });
    this.render();
  }
  remove() {
    const i = this.table.selectedId();
    if (i !== null) { this.parts.splice(Number(i), 1); this.render(); }
  }
  ok() {
    try {
      const d = this.form.get();
      checkTime(d.time);
      d.participants = this.parts;
      this.close(d);
    } catch (e) { this.err(e.message); }
  }
}

class TrainingPanel extends RecordPanel {
  static title = "Evidencija o edukaciji zaposlenika";
  static info = "Teme, predavač, provjera znanja i popis sudionika. Ispis sadrži stupac za potpise sudionika.";
  static key = "training";

  build() {
    this.tbtn("＋ Nova edukacija", () => this.form(), "primary");
    this.tbtn("Uredi", () => { const id = this.need(this.table); if (id !== null) return this.form(id); });
    this.tbtn("Obriši", () => this.delete("trainings"));
    this.printButtons();
    this.table = new Table([["date", "Datum", 95, "center"], ["topic", "Tema", 320, "w"], ["lect", "Predavač", 150, "w"],
      ["dur", "Trajanje", 75, "e"], ["n", "Sudionika", 80, "center"], ["res", "Provjera", 120, "w"]],
    { onDouble: (id) => this.form(id) });
    this.body.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.trainings().map((t) => {
      const r = this.db.record("trainings", t.id) || {};
      const tm = Array.isArray(r.test_methods) ? r.test_methods : [];
      return { id: t.id, date: d2ui(t.date), topic: t.topic || "", lect: t.lecturer || "",
        dur: t.duration_h ? `${fq(t.duration_h, 1)} h` : "", n: (Array.isArray(r.participants) ? r.participants : []).length,
        res: tm.join(", ") + (t.test_result ? ` ${t.test_result}` : "") };
    }));
  }

  async form(rid = null) {
    const init = rid ? this.db.record("trainings", rid) : { made_by: this.db.get_setting("approved_by") };
    const d = await new TrainingDialog(this.app, init || {}).show();
    if (d) { this.db.save_record("trainings", d, rid); this.done(); }
  }
}

// ------------------------------------------------------------------ postavke HACCP
class HaccpSettingsPanel extends Panel {
  static title = "Postavke HACCP dokumenata";
  static info = "Podaci koji se ispisuju u zaglavlju i potpisima, zaposlenici te šifre/verzije pojedinih dokumenata.";

  build() {
    this.tb.style.display = "none";
    const c = h("div", { class: "card" });
    this.form = new Form([
      { key: "company", label: "Naziv tvrtke (zaglavlje dokumenata)" },
      { key: "approved_by", label: "Odobrio/la (dokumente)" },
      { key: "haccp_lead", label: "Voditelj HACCP tima (verifikacija)" },
      { key: "prod_lead", label: "Voditelj proizvodnje" },
      { key: "default_operator", label: "Zadani operater" },
      { key: "shelf_months", label: "Rok trajanja piva (mjeseci)", type: "num", min: 0 }],
    Object.fromEntries(["company", "approved_by", "haccp_lead", "prod_lead", "default_operator", "shelf_months"]
      .map((k) => [k, this.db.get_setting(k)])), 3);
    c.append(this.form.el, h("div", { style: { marginTop: "10px" } }, btn("Spremi", () => this.save())));
    const ce = h("div", { class: "card" },
      h("h3", {}, "Izradi sve dokumente"),
      h("div", { class: "muted", style: { marginBottom: "8px" } },
        "Sve HACCP evidencije za odabrano razdoblje (PDF i/ili Word) izrađuju se u jednu ZIP datoteku za preuzimanje. " +
        "ZIP možete spremiti npr. na Google Disk."),
      btn("📦 Izradi sve dokumente", async () => { try { await exportAll(this.app); } catch (e) { this.err(e); } }));
    this.emps = new Table([["name", "Ime i prezime", 180, "w"], ["role", "Funkcija", 170, "w"]], { height: 8, onDouble: () => this.editEmp() });
    this.meta = new Table([["name", "Evidencija", 160, "w"], ["code", "Šifra", 150, "w"], ["ver", "Verzija", 60, "center"],
      ["vdate", "Datum", 95, "center"]], { height: 10, onDouble: () => this.editMeta() });
    const left = h("div", {},
      h("div", { class: "row gap", style: { marginBottom: "6px" } }, h("b", { style: { fontSize: "15px", flex: 1 } }, "Zaposlenici"),
        btn("＋ Dodaj", () => this.addEmp().catch((e) => this.err(e))), btn("Uredi", () => this.editEmp().catch((e) => this.err(e)), "ghost"),
        btn("Ukloni", () => this.delEmp().catch((e) => this.err(e)), "ghost")),
      this.emps.el);
    const right = h("div", {},
      h("div", { class: "row gap", style: { marginBottom: "6px" } }, h("b", { style: { fontSize: "15px", flex: 1 } }, "Dokumenti (šifra, verzija, datum)"),
        btn("Uredi", () => this.editMeta().catch((e) => this.err(e)), "ghost")),
      this.meta.el);
    this.body.append(c, ce, h("div", { class: "grid2" }, left, right));
  }

  refresh() {
    const names = K(this.app).DOC_NAMES;
    this.emps.setRows(this.db.employees().map((e) => ({ id: e.id, name: e.name, role: e.role || "" })));
    this.meta.setRows(this.db.all_doc_meta().map((m) => ({ id: m.key, name: names[m.key] || m.key, code: m.code,
      ver: m.version, vdate: d2ui(m.vdate) })));
  }

  save() {
    let d;
    try { d = this.form.get(); } catch (e) { error(e.message); return; }
    d.shelf_months = Math.trunc(d.shelf_months || 6);
    for (const [k, v] of Object.entries(d)) this.db.set_setting(k, v ?? "");
    this.app.toast("HACCP postavke spremljene.");
  }

  _empForm(init) {
    return askForm("Zaposlenik", [{ key: "name", label: "Ime i prezime", required: true }, { key: "role", label: "Funkcija" }], init);
  }
  async addEmp() {
    const d = await this._empForm({});
    if (d) { this.db.save_employee(d, null); this.refresh(); }
  }
  async editEmp() {
    const i = this.need(this.emps, "zaposlenika");
    if (i === null) return;
    const d = await this._empForm(this.db.one("SELECT * FROM employees WHERE id=?", [i]));
    if (d) { this.db.save_employee(d, i); this.refresh(); }
  }
  async delEmp() {
    const i = this.need(this.emps, "zaposlenika");
    if (i !== null && await confirm("Ukloniti zaposlenika s popisa? (Postojeći zapisi ostaju.)", "Zaposlenik")) {
      this.db.delete_employee(i);
      this.refresh();
    }
  }
  async editMeta() {
    const k = this.need(this.meta, "dokument");
    if (k === null) return;
    const key = String(k);
    const m = this.db.doc_meta(key);
    const d = await askForm(`Dokument: ${K(this.app).DOC_NAMES[key] || key}`, [
      { key: "code", label: "Šifra", required: true }, { key: "title", label: "Naziv dokumenta", required: true },
      { key: "version", label: "Verzija" }, { key: "vdate", label: "Datum verzije", type: "date" }], m, { width: 640 });
    if (d) { this.db.save_doc_meta(key, d); this.refresh(); }
  }
}

// ------------------------------------------------------------------ HACCP stranica
const SECTIONS = [["tasks", "📋  Pregled i zadaci", TasksPanel], [null, "PROIZVODNJA", null],
  ["brew", "🔥  Kuhanje i utrošak", BrewPanel], ["ccp", "🌡  CCP kuhanje sladovine", CCPPanel],
  ["ferm", "🧫  Fermentacija", FermPanel], ["pack", "🛢  Pakiranje", PackPanel],
  [null, "PRP / HIGIJENA", null], ["cip", "🧼  CIP postupak", CIPPanel], ["mill", "⚙  Kontrola mlina", MillPanel],
  ["maint", "🔧  Održavanje opreme", MaintPanel], ["pest", "🐭  Štetnici", PestPanel],
  [null, "OSTALO", null], ["receipt", "📦  Prijem robe i ambalaže", ReceiptPanel],
  ["training", "🎓  Edukacija", TrainingPanel], ["hset", "⚙  Postavke HACCP", HaccpSettingsPanel]];

class HaccpPage extends Page {
  static title = "HACCP evidencije";
  static subtitle = "Zapisi o sigurnosti hrane · svaki se može ispisati kao PDF ili Word dokument";

  build() {
    this.tb.style.display = "none";
    this.nav = h("div", { class: "side2" });
    this.host = h("div", { class: "panel" });
    this.content.append(h("div", { class: "subnav" }, this.nav, this.host));
    this.navb = {}; this.panels = {}; this.cur = null;
    this.classes = {};
    for (const [key, label, cls] of SECTIONS) {
      if (!key) { this.nav.append(h("div", { class: "sec" }, label)); continue; }
      const a = h("a", { href: `#haccp/${key}`, onclick: (e) => { e.preventDefault(); this.show(key); } }, label);
      this.nav.append(a);
      this.navb[key] = a;
      this.classes[key] = cls;
    }
  }

  show(key) {
    if (!this.classes[key]) key = "tasks";
    if (this.cur && this.navb[this.cur]) this.navb[this.cur].classList.remove("on");
    if (!this.panels[key]) {
      try { this.panels[key] = new this.classes[key](this); } catch (e) { console.error(e); error("Greška pri izradi: " + e.message); return; }
    }
    this.cur = key;
    this.navb[key].classList.add("on");
    this.host.innerHTML = "";
    this.host.append(this.panels[key].el);
    if (this.app.current === "haccp") history.replaceState(null, "", `#haccp/${key}`);
    try { this.panels[key].refresh(); } catch (e) { console.error(e); error(e.message); }
  }

  refresh() {
    let key = this.cur;
    if (!key) {
      const sub = location.hash.slice(1).split("/")[1];
      key = sub && this.classes[sub] ? sub : "tasks";
    }
    this.show(key);
  }
}

// ================================================================== upozorenja (alerts_ui.py)
export const TYPE_INFO = {
  "Prijem": { group: "haccp", agg: true, title: "Primljeni LOT-ovi bez zapisnika o prijemu",
    info: "Ovi LOT-ovi sirovina i ambalaže zaprimljeni su na skladište, ali za njih nije ispunjen " +
      "HACCP zapisnik o prijemu. Označite LOT i ispunite zapisnik ili ga zanemarite.",
    cols: ["LOT", "Materijal · dobavljač · količina", "Primljeno"], fix: "📝 Ispuni zapisnik o prijemu", goto: ["haccp", "receipt"] },
  "CCP": { group: "haccp", title: "Šarže bez CCP kontrole kuhanja",
    info: "Za ove šarže nije upisana CCP kontrola kuhanja sladovine (vrijeme i temperatura ≥ 100 °C).",
    cols: ["LOT piva", "Opis", "Kuhano"], fix: "📝 Upiši CCP kontrolu", goto: ["haccp", "ccp"] },
  "Mlin": { group: "haccp", title: "Kuhanja bez kontrole mlina",
    info: "Mlin se kontrolira prije svakog kuhanja. Za ove dane kuhanja nema zapisa kontrole mlina.",
    cols: ["LOT piva", "Opis", "Kuhano"], fix: "📝 Upiši kontrolu mlina", goto: ["haccp", "mill"] },
  "CIP": { group: "haccp", title: "Fermentori kojima treba CIP",
    info: "Fermentacija je završena, a nakon toga nije evidentiran CIP fermentora.",
    cols: ["Fermentor", "Opis", "Kraj ferm."], fix: "📝 Upiši CIP", goto: ["haccp", "cip"] },
  "Fermentacija": { group: "haccp", title: "Šarže bez upisanog završetka fermentacije",
    info: "Šarža je pakirana ili završena, a u evidenciji fermentacije nema datuma završetka.",
    cols: ["LOT piva", "Opis", "Kuhano"], fix: "📝 Upiši završetak", goto: ["haccp", "ferm"] },
  "Pakiranje": { group: "haccp", title: "Šarže bez evidencije pakiranja",
    info: "Šarža je označena kao pakirana ili završena, a nema zapisa u evidenciji pakiranja.",
    cols: ["LOT piva", "Opis", "Kuhano"], goto: ["haccp", "pack"] },
  "Održavanje": { group: "haccp", title: "Oprema kojoj je istekla redovita kontrola",
    info: "Za ovu opremu istekao je rok redovite kontrole/održavanja ili kontrola nikad nije upisana.",
    cols: ["Oprema", "Opis", "Rok"], goto: ["haccp", "maint"] },
  "Istekao rok": { group: "stock", title: "LOT-ovi kojima je istekao rok",
    info: "Ovi LOT-ovi su na zalihi, a rok trajanja (ili rok nakon otvaranja) je istekao. " +
      "Otpišite ih korekcijom količine ili zanemarite upozorenje.",
    cols: ["LOT", "Artikl · zaliha", "Rok"], goto: ["lots", null] },
  "Rok ističe": { group: "stock", title: "LOT-ovi kojima uskoro ističe rok",
    info: "Rok trajanja ovih LOT-ova ističe uskoro – iskoristite ih prve.",
    cols: ["LOT", "Artikl · zaliha", "Rok"], goto: ["lots", null] },
  "Ispod minimuma": { group: "stock", title: "Artikli ispod minimalne zalihe",
    info: "Zaliha ovih artikala pala je ispod minimuma. Naručite ih (Što trebam naručiti) ili zanemarite upozorenje.",
    cols: ["Artikl", "Zaliha / minimum", ""], goto: ["reorder", null] },
  "Kasni isporuka": { group: "stock", title: "Narudžbenice koje kasne",
    info: "Očekivani datum isporuke je prošao, a narudžbenica nije zaprimljena.",
    cols: ["Narudžbenica", "Dobavljač", "Očekivano"], goto: ["po", null] },
  "Trošarine MI-PI": { group: "stock", title: "Trošarine – prijava MI-PI",
    info: "Pivo istočeno prošli mjesec treba prijaviti carini obrascem MI-PI.",
    cols: ["Razdoblje", "Opis", ""], goto: ["excise", null] },
};

export function typeInfo(typ) {
  return TYPE_INFO[typ] || { title: typ, info: "", cols: ["Zapis", "Opis", "Datum"] };
}

function lotsWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return "primljeni LOT";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "primljena LOT-a";
  return "primljenih LOT-ova";
}

// Redovi za tablicu: zbirne vrste (npr. Prijem) prikazuju se u jednom redu.
export function rowsFor(items, areaKey = "area") {
  const rows = [], agg = {};
  for (const it of items || []) {
    if (typeInfo(it.type).agg) { (agg[it.type] = agg[it.type] || []).push(it); continue; }
    rows.push({ id: it.key, [areaKey]: it.type, type: it.type, text: it.text,
      date: it.type !== "Trošarine MI-PI" ? d2ui(it.date) : "", _tag: it.sev, _typ: it.type });
  }
  for (const [typ, lst] of Object.entries(agg)) {
    const n = lst.length;
    const text = typ === "Prijem" ? `${n} ${lotsWord(n)} bez zapisnika o prijemu` : `${n} × ${typeInfo(typ).title}`;
    rows.push({ id: `agg:${typ}`, [areaKey]: typ, type: typ, text: text + "  (dvoklik za popis)", date: "",
      _tag: lst[0].sev, _typ: typ });
  }
  return rows;
}

// Dvoklik na red tablice upozorenja -> detalji
export async function openWarningFromTable(app, table, onChange = null) {
  const row = table.selectedRow();
  if (!row || !row._typ) return;
  const key = String(row.id).startsWith("agg:") ? null : row.id;
  await new WarningDialog(app, row._typ, key).show();
  if (onChange) onChange();
}

export class WarningDialog extends Dialog {
  constructor(app, typ, key = null) {
    const meta = typeInfo(typ);
    super(meta.title, { width: 920 });
    this.app = app; this.db = app.db; this.typ = typ; this.meta = meta;
    this.body.append(h("div", { style: { fontWeight: 700, fontSize: "17px" } }, meta.title),
      h("div", { class: "muted", style: { margin: "2px 0 8px" } }, meta.info || ""));
    const [c1, c2, c3] = meta.cols;
    this.table = new Table([["rec", c1, 140, "w"], ["desc", c2, 520, "w"], ["date", c3 || " ", 100, "center"]],
      { multi: true, height: 11, onDouble: meta.fix ? () => this.run(() => this.fix()) : null });
    this.count = h("div", { class: "muted", style: { marginTop: "4px" } });
    const row2 = h("div", { class: "row gap", style: { marginTop: "8px" } });
    if (meta.fix) row2.append(btn(meta.fix, () => this.run(() => this.fix())));
    if (meta.goto) row2.append(btn("↗ Otvori evidenciju", () => this.goto(), "ghost"));
    row2.append(btn("🔕 Zanemari označeno", () => this.run(() => this.dismissSel()), "ghost"),
      btn("🔕 Zanemari sva ove vrste", () => this.run(() => this.dismissType()), "ghost"));
    this.body.append(this.table.el, this.count, row2);
    this.buttons(null, null, "Zatvori");
    this.load(key);
  }

  async run(fn) { try { await fn(); } catch (e) { console.error(e); error(e.message || String(e)); } }

  load(select = null) {
    this.items = this.app.py.call("web_haccp.collect", this.meta.group || null).filter((i) => i.type === this.typ);
    this.byKey = Object.fromEntries(this.items.map((i) => [String(i.key), i]));
    this.table.setRows(this.items.map((i) => ({ id: i.key, rec: i.rec || "", desc: i.desc || i.text,
      date: this.meta.cols[2] ? d2ui(i.date) : "", _tag: i.sev })));
    if (select !== null && select !== undefined && this.byKey[String(select)]) {
      this.table.select(select);
      const tr = this.table.tbody.querySelector("tr.sel");
      if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
    } else if (this.items.length === 1) this.table.select(this.items[0].key);
    this.count.textContent = this.items.length ? `Ukupno: ${this.items.length}` : "✓ Nema više otvorenih stavki.";
  }

  selected() { return this.table.selectedIds().map(String).filter((k) => k in this.byKey).map((k) => this.byKey[k]); }

  async fix() {
    const sel = this.selected();
    if (!sel.length) { this.err("Označite stavku u popisu."); return; }
    this.err("");
    const r = sel[0].ref || {};
    const app = this.app, db = this.db;
    if (this.typ === "Prijem") await editReceipt(app, db.receipt_defaults(r.lot_id));
    else if (this.typ === "CCP") await editCcp(app, { batch_id: r.batch_id, date: r.brew_date });
    else if (this.typ === "Mlin") {
      if (await editMillCheck(app, { date: r.brew_date, batch_id: r.batch_id })) app.toast("Kontrola mlina spremljena.");
    } else if (this.typ === "CIP") {
      await editCip(app, cipDefaults(app, { cip_type: K(app).CIP_TYPES[0], batch_no: r.batch_no,
        fermentor_id: r.fermentor_id, equipment: ["Fermentor"], date: today() }));
    } else if (this.typ === "Fermentacija") {
      const b = db.batch(r.batch_id);
      const d = await askForm(`Završetak fermentacije – ${b.batch_no}`, [
        { key: "ferm_end", label: "Datum završetka fermentacije", type: "date", required: true,
          default: b.ferm_start || b.brew_date }]);
      if (d) db.update_batch(b.id, d);
    }
    this.load();
  }

  goto() {
    const [page, sub] = this.meta.goto;
    this.close(null);
    const p = this.app.show(page);
    if (sub && p && typeof p.show === "function") p.show(sub);
  }

  dismissSel() {
    const sel = this.selected();
    if (!sel.length) { this.err("Označite jednu ili više stavki (Ctrl/Shift za više)."); return; }
    this.err("");
    this.db.dismiss(sel);
    this.app.toast(`Zanemareno: ${sel.length}. Vratiti ih možete tipkom „🔕 Zanemarena“.`);
    this.load();
  }

  async dismissType() {
    if (!await confirm(`Više ne prikazivati NIJEDNO upozorenje vrste „${this.typ}“ (ni sadašnja ni buduća)?\n\n` +
      "Može se vratiti tipkom „🔕 Zanemarena“.", "Zanemari vrstu upozorenja")) return;
    this.app.py.call("web_haccp.dismiss_type", this.typ);
    this.app.toast(`Upozorenja vrste „${this.typ}“ se više ne prikazuju.`);
    this.close(null);
  }
}

export class DismissedDialog extends Dialog {
  constructor(app) {
    super("Zanemarena upozorenja", { width: 860 });
    this.app = app; this.db = app.db;
    this.body.append(h("div", { class: "muted", style: { marginBottom: "8px" } },
      "Upozorenja koja ste zanemarili ne prikazuju se na nadzornoj ploči ni u HACCP zadacima. " +
      "Označite ih i vratite ako ih opet želite vidjeti."));
    this.table = new Table([["type", "Vrsta", 140, "w"], ["label", "Upozorenje", 520, "w"], ["date", "Zanemareno", 100, "center"]],
      { multi: true, height: 11 });
    this.body.append(this.table.el, h("div", { class: "row gap", style: { marginTop: "8px" } },
      btn("↩ Vrati označeno", () => this.restore()), btn("↩ Vrati sve", () => this.restoreAll(), "ghost")));
    this.buttons(null, null, "Zatvori");
    this.load();
  }

  load() {
    const rows = this.db.dismissed_list().map((r) => ({ id: r.key, type: r.type || "",
      label: (r.key.startsWith("type:") ? "★ " : "") + (r.label || ""), date: d2ui(r.date),
      _tag: r.key.startsWith("type:") ? "bold" : "" }));
    this.table.setRows(rows.length ? rows : [{ id: "-", type: "", label: "Nema zanemarenih upozorenja.", date: "" }]);
  }

  restore() {
    const keys = this.table.selectedIds().map(String).filter((k) => k !== "-");
    if (keys.length) { this.db.undismiss(keys); this.load(); }
  }

  restoreAll() {
    const keys = this.db.dismissed_list().map((r) => r.key);
    if (keys.length) { this.db.undismiss(keys); this.load(); }
  }
}

export async function showDismissed(app) { await new DismissedDialog(app).show(); }

export function dismissedCount(app) { return app.db.dismissed_list().length; }

export const PAGES = { haccp: HaccpPage };
