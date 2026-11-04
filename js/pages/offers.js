// Ponude kupcima: odabir proizvoda iz cjenika, količine, zbroj; PDF s logom PIVARA. Cjenik se uređuje ovdje.
import { h, btn, Page, Table, Dialog, Form, askForm, confirm, info, error, toast, fq, money, num, d2ui, today } from "../ui.js";

const eur = (x) => Number(x || 0).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function T(columns, opts = {}) {
  const t = new Table(columns, opts);
  const sum = columns.reduce((a, c) => a + (c[2] || 100), 0);
  t.table.style.minWidth = `${Math.round(sum * 0.6)}px`;
  return t;
}

// zbroj: cijene uključuju PDV -> osnovica i PDV po stopi
function totals(lines) {
  let total = 0; const by = {};
  for (const l of lines) {
    const amt = Math.round(Number(l.qty || 0) * Number(l.price || 0) * 100) / 100;
    total += amt;
    const r = Number(l.vat || 0);
    const base = r ? amt / (1 + r / 100) : amt;
    by[r] = by[r] || [0, 0]; by[r][0] += base; by[r][1] += amt - base;
  }
  return [Math.round(total * 100) / 100, by];
}

// ------------------------------------------------------------------ dijalog ponude
class OfferDialog extends Dialog {
  constructor(app, data, title) {
    super(title, { width: 1000, cls: "offer-dlg" });
    this.app = app; this.py = app.py;
    this.products = this.py.call("web_offers.products", true);
    this.consts = this.py.call("web_offers.consts");
    this.lines = (data.lines || []).map((l) => ({ ...l }));
    const custs = app.db.customers_list();
    this.custs = custs;
    const ops = app.db.employee_names();
    this.form = new Form([
      { key: "no", label: "Broj ponude (npr. 32-2026)", required: true },
      { key: "issue_date", label: "Datum izdavanja", type: "date", required: true },
      { key: "issue_time", label: "Vrijeme izdavanja", type: "time" },
      { label: "Kupac kojem je ponuda namijenjena", type: "section" },
      { key: "customer_id", label: "Odaberi postojećeg kupca (neobavezno)", type: "combo", full: true,
        options: [["— upiši ručno —", null], ...custs.map((c) => [`${c.name}${c.city ? " · " + c.city : ""}`, c.id])],
        command: (id) => this.pickCustomer(id) },
      { key: "cust_name", label: "Naziv / ime i prezime", required: true },
      { key: "cust_address", label: "Adresa" },
      { key: "cust_oib", label: "OIB" },
      { label: "Isporuka i plaćanje", type: "section" },
      { key: "delivery_date", label: "Datum isporuke", type: "date" },
      { key: "delivery_place", label: "Mjesto isporuke" },
      { key: "payment_due", label: "Rok plaćanja", type: "date" },
      { key: "payment_method", label: "Način plaćanja", type: "combo", editable: true, options: this.consts.payment_methods },
      { key: "operator", label: "Oznaka operatera", type: "combo", editable: true, options: ops },
      { key: "payment_desc", label: "Opis plaćanja", full: true },
      { key: "note", label: "Napomena (neobavezno)", type: "multi", full: true, height: 50 }], data, 3);
    this.saveCust = h("input", { type: "checkbox" });
    this.saveCustRow = h("label", { class: "chk", style: { marginTop: "2px" } }, this.saveCust, " Spremi kupca u popis kupaca");
    // stavke
    const groups = {};
    for (const p of this.products) (groups[p.grp || "Ostalo"] = groups[p.grp || "Ostalo"] || []).push(p);
    this.psel = h("select", { style: { flex: "1 1 260px", minWidth: "0" } }, h("option", { value: "" }, "— odaberite proizvod iz cjenika —"),
      Object.entries(groups).map(([g, ps]) => h("optgroup", { label: g }, ps.map((p) => h("option", { value: String(p.id) }, `${p.name} · ${eur(p.price)} €`)))));
    this.pqty = h("input", { value: "1", inputmode: "decimal", style: { width: "80px", textAlign: "right" } });
    this.pqty.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this.addLine(); } });
    this.linesEl = h("div", { class: "offer-lines" });
    this.totEl = h("div", { class: "offer-tot" });
    this.body.append(this.form.el, this.saveCustRow,
      h("div", { class: "sec", style: { marginTop: "12px" } }, "Proizvodi"),
      h("div", { class: "row gap", style: { flexWrap: "wrap", margin: "6px 0" } }, this.psel, this.pqty, btn("＋ Dodaj", () => this.addLine())),
      this.linesEl, this.totEl);
    this.buttons("Spremi ponudu", () => this.ok());
    this.onEnter = null;
    this.toggleSaveCust();
    this.renderLines();
  }

  pickCustomer(id) {
    if (id) {
      const c = this.py.call("web_offers.customer_info", id);
      for (const k of ["cust_name", "cust_address", "cust_oib"]) this.form.w[k].set(c[k]);
    }
    this.toggleSaveCust();
  }
  toggleSaveCust() { this.saveCustRow.style.display = this.form.w.customer_id.get() ? "none" : ""; }

  addLine() {
    const id = Number(this.psel.value);
    if (!id) return this.err("Odaberite proizvod.");
    let q;
    try { q = num(this.pqty.value); } catch { q = 0; }
    if (!(q > 0)) return this.err("Upišite količinu veću od 0.");
    const p = this.products.find((x) => x.id === id);
    const ex = this.lines.find((l) => l.product_id === id && Number(l.price) === Number(p.price));
    if (ex) ex.qty = Number(ex.qty) + q;
    else this.lines.push({ product_id: p.id, name: p.name, descr: p.descr || "", unit: p.unit || "kom", qty: q, price: p.price, vat: p.vat });
    this.err(""); this.psel.value = ""; this.pqty.value = "1"; this.psel.focus();
    this.renderLines();
  }

  renderLines() {
    this.linesEl.innerHTML = "";
    if (!this.lines.length) {
      this.linesEl.append(h("div", { class: "muted", style: { padding: "8px 0" } }, "Još nema stavki – odaberite proizvod i količinu pa kliknite „Dodaj”."));
    } else {
      this.linesEl.append(h("div", { class: "ol-row ol-head" }, h("span", {}, "#"), h("span", {}, "Proizvod"), h("span", {}, "Količina"),
        h("span", {}, "Cijena €"), h("span", {}, "Iznos €"), h("span", {})));
      this.lines.forEach((l, i) => {
        const q = h("input", { value: fq(l.qty), inputmode: "decimal" });
        const pr = h("input", { value: eur(l.price), inputmode: "decimal" });
        const amt = h("span", { class: "ol-amt" }, eur(l.qty * l.price));
        const upd = () => {
          try { l.qty = num(q.value); l.price = num(pr.value); } catch { /* */ }
          amt.textContent = eur(l.qty * l.price); this.renderTot();
        };
        q.addEventListener("input", upd); pr.addEventListener("input", upd);
        const up = btn("↑", () => { if (i) { [this.lines[i - 1], this.lines[i]] = [this.lines[i], this.lines[i - 1]]; this.renderLines(); } }, "ghost");
        const del = btn("✕", () => { this.lines.splice(i, 1); this.renderLines(); }, "ghost");
        this.linesEl.append(h("div", { class: "ol-row" }, h("span", { class: "muted" }, `${i + 1}.`),
          h("span", { class: "ol-name" }, h("b", {}, l.name), l.descr ? h("small", { class: "muted" }, l.descr) : null),
          h("span", { class: "ol-q" }, q, h("small", { class: "muted" }, l.unit)), h("span", { class: "ol-q" }, pr, h("small", { class: "muted" }, "€")), amt,
          h("span", { class: "ol-act" }, up, del)));
      });
    }
    this.renderTot();
  }

  renderTot() {
    const [total, by] = totals(this.lines);
    this.totEl.innerHTML = "";
    for (const [r, [b, v]] of Object.entries(by)) {
      if (!Number(r)) continue;
      this.totEl.append(h("div", { class: "muted" }, `Osnovica ${eur(b)} € · PDV ${fq(r)} % ${eur(v)} €`));
    }
    this.totEl.append(h("div", { class: "offer-sum" }, "UKUPNO: ", h("b", {}, `${eur(total)} €`)));
  }

  ok() {
    try {
      const d = this.form.get();
      for (const l of this.lines) if (!(Number(l.qty) > 0)) throw new Error(`Količina za „${l.name}” mora biti veća od 0.`);
      this.close({ data: d, lines: this.lines, saveCustomer: !d.customer_id && this.saveCust.checked });
    } catch (e) { this.err(e.message); }
  }
}

// ------------------------------------------------------------------ cjenik
async function priceList(app) {
  const py = app.py;
  const d = new Dialog("Cjenik proizvoda za ponude", { width: 960 });
  const t = T([["grp", "Grupa", 120, "w"], ["name", "Proizvod", 230, "w"], ["descr", "Opis", 220, "w"], ["unit", "Jed.", 55, "center"],
    ["price", "Cijena € (s PDV-om)", 110, "e"], ["vat", "PDV %", 60, "e"], ["active", "U ponudi", 70, "center"]],
  { onDouble: (id) => edit(id), height: 14 });
  const load = () => t.setRows(py.call("web_offers.products").map((p) => ({ id: p.id, grp: p.grp || "", name: p.name, descr: p.descr || "",
    unit: p.unit || "", price: eur(p.price), vat: fq(p.vat), active: p.active ? "✔" : "—", _tag: p.active ? "" : "muted" })));
  const groups = py.call("web_offers.consts").groups;
  const form = (init, title) => askForm(title, [
    { key: "grp", label: "Grupa", type: "combo", editable: true, options: groups },
    { key: "name", label: "Naziv proizvoda", required: true },
    { key: "descr", label: "Opis (neobavezno, ispisuje se ispod naziva)" },
    { key: "unit", label: "Jedinica (kom, boca, osoba…)", default: "kom" },
    { key: "price", label: "Cijena € s PDV-om", type: "num", min: 0, required: true },
    { key: "vat", label: "Stopa PDV-a (%)", type: "num", min: 0, default: 25 },
    { key: "active", label: "Nudi se u ponudama", type: "check", default: 1 }], init);
  const edit = async (id) => {
    id = id ?? t.selectedId();
    if (id === null || id === undefined) return info("Odaberite proizvod.");
    const p = py.call("web_offers.products").find((x) => x.id === id);
    const v = await form(p, `Proizvod: ${p.name}`);
    if (v) { try { py.call("web_offers.save_product", v, id); load(); } catch (e) { error(e); } }
  };
  t.el.style.marginTop = "6px";
  d.body.append(h("div", { class: "muted", style: { fontSize: "12.5px" } },
    "Cijene su u eurima i uključuju PDV (kao u cjeniku od 10.09.2026.). Promjena cijene vrijedi za nove ponude – izdane ponude ostaju kakve jesu. "
    + "Stopu PDV-a po proizvodu provjerite s knjigovođom."),
  h("div", { class: "row gap", style: { marginTop: "8px", flexWrap: "wrap" } },
    btn("＋ Novi proizvod", async () => { const v = await form({}, "Novi proizvod"); if (v) { try { py.call("web_offers.save_product", v); load(); } catch (e) { error(e); } } }),
    btn("✎ Uredi", () => edit(), "ghost"),
    btn("🗑 Obriši", async () => {
      const id = t.selectedId(); if (id === null) return info("Odaberite proizvod.");
      if (await confirm("Obrisati proizvod iz cjenika? (Izdane ponude se ne mijenjaju.)", "Brisanje", { danger: true })) { py.call("web_offers.delete_product", id); load(); }
    }, "ghost")), t.el);
  d.buttons(null, null, "Zatvori");
  load();
  await d.show();
}

// ------------------------------------------------------------------ stranica
class OffersPage extends Page {
  static title = "Ponude";
  static subtitle = "Ponude kupcima iz cjenika · broj ponude, kupac, isporuka i plaćanje · PDF s logom PIVARA";

  build() {
    this.tbtn("＋ Nova ponuda", () => this.new());
    this.tbtn("✎ Uredi", () => this.edit(), "ghost");
    this.tbtn("⧉ Kopiraj", () => this.copy(), "ghost");
    this.tbtn("🗑 Obriši", () => this.del(), "ghost");
    this.tbtn("📋 Cjenik", async () => { await priceList(this.app); }, "ghost");
    this.tbtn("🖨 PDF", () => this.pdf(), "primary", true);
    this.table = T([["no", "Broj", 85, "w"], ["date", "Izdano", 130, "center"], ["cust", "Kupac", 200, "w"],
      ["deliv", "Isporuka", 95, "center"], ["place", "Mjesto isporuke", 150, "w"], ["total", "Iznos €", 95, "e"],
      ["op", "Operater", 110, "w"], ["status", "Status", 95, "w"]], { onDouble: () => this.edit() });
    this.search(this.table);
    this.sum = h("div", { class: "muted", style: { fontSize: "12.5px" } });
    this.content.append(this.table.el, this.sum);
  }

  refresh() {
    const rows = this.app.py.call("web_offers.offers");
    this.table.setRows(rows.map((o) => ({ id: o.id, no: o.no, date: `${d2ui(o.issue_date)} ${o.issue_time || ""}`.trim(), cust: o.cust_name || "",
      deliv: d2ui(o.delivery_date), place: o.delivery_place || "", total: eur(o.total), op: o.operator || "", status: o.status || "" })));
    this.sum.textContent = rows.length ? `${rows.length} ponuda · dvoklik otvara ponudu` : "Još nema ponuda – kliknite „Nova ponuda”.";
  }

  async open(data, title, id = null) {
    const res = await new OfferDialog(this.app, data, title).show();
    if (!res) return null;
    try {
      const oid = this.app.py.callKw("web_offers.save_offer", [res.data, res.lines], { id, save_customer: !!res.saveCustomer });
      this.app.refreshAll();
      toast("Ponuda spremljena.");
      if (await confirm("Izraditi PDF ponude?", "Ponuda")) await this.app.doc("web_offers.offer_pdf", oid, "PDF");
      return oid;
    } catch (e) {
      error(e);
      return this.open({ ...res.data, lines: res.lines }, title, id); // ispravak bez gubitka unosa
    }
  }

  async new() { await this.open(this.app.py.call("web_offers.new_offer_defaults"), "Nova ponuda"); }

  async edit() {
    const id = this.need(this.table, "ponudu");
    if (!id) return;
    const o = this.app.py.call("web_offers.offer", id);
    await this.open(o, `Ponuda ${o.no}`, id);
  }

  async copy() {
    const id = this.need(this.table, "ponudu");
    if (!id) return;
    const nid = this.app.py.call("web_offers.copy_offer", id);
    this.refresh();
    const o = this.app.py.call("web_offers.offer", nid);
    toast(`Kopija: ponuda ${o.no}`);
    await this.open(o, `Ponuda ${o.no}`, nid);
  }

  async del() {
    const id = this.need(this.table, "ponudu");
    if (!id) return;
    const o = this.app.py.call("web_offers.offer", id);
    if (await confirm(`Obrisati ponudu ${o.no} (${o.cust_name})?`, "Brisanje", { danger: true })) {
      this.app.py.call("web_offers.delete_offer", id); this.refresh();
    }
  }

  async pdf() {
    const id = this.need(this.table, "ponudu");
    if (id) await this.app.doc("web_offers.offer_pdf", id, "PDF");
  }
}

export const PAGES = { offers: OffersPage };
