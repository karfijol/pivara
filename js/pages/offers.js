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
    const ops = this.py.call("web_offers.operators");
    if (data.operator && !ops.some((x) => x.toLowerCase() === String(data.operator).toLowerCase())) ops.push(data.operator);
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
      { key: "valid_until", label: "Ponuda vrijedi do", type: "date" },
      { key: "price_mode", label: "Prikaz cijena", type: "combo", default: "gross",
        options: [["S PDV-om (maloprodaja)", "gross"], ["Bez PDV-a (veleprodaja)", "net"]], command: () => this.renderLines() },
      { key: "payment_method", label: "Način plaćanja", type: "combo", editable: true, options: this.consts.payment_methods },
      { key: "operator", label: "Oznaka operatera", type: "combo", options: ops, addNewLabel: "＋ Novi operater…",
        addNew: async () => {
          const v = await askForm("Novi operater", [{ key: "name", label: "Ime i prezime ili oznaka operatera", required: true }], {}, { okText: "Dodaj" });
          if (!v || !v.name) return null;
          this.py.call("web_offers.remember_operator", v.name.trim());
          return v.name.trim();
        } },
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
    this.buttons("Spremi ponudu", () => this.ok(false));
    this.okBtn.className = "btn btn-ghost";
    this.bar.append(btn("Spremi i izradi PDF", () => this.ok(true)));
    this.onEnter = null;
    this.cprices = data.customer_id ? this.py.call("web_more.customer_prices", data.customer_id) : {};
    this.toggleSaveCust();
    this.renderLines();
  }

  pickCustomer(id) {
    this.cprices = id ? this.py.call("web_more.customer_prices", id) : {};
    if (id) {
      const c = this.py.call("web_offers.customer_info", id);
      for (const k of ["cust_name", "cust_address", "cust_oib"]) this.form.w[k].set(c[k]);
      // posebne cijene kupca za stavke koje su već na ponudi
      let n = 0;
      for (const l of this.lines) { const cp = this.cprices[String(l.product_id)]; if (cp !== undefined && Number(l.price) !== cp) { l.price = cp; n++; } }
      if (n) { this.renderLines(); toast(`Primijenjene cijene kupca na ${n} stavki.`); }
    }
    this.toggleSaveCust();
  }
  net() { return this.form && this.form.w.price_mode && this.form.w.price_mode.get() === "net"; }
  shown(l) { const r = Number(l.vat || 0); return this.net() && r ? Number(l.price) / (1 + r / 100) : Number(l.price); }
  toggleSaveCust() { this.saveCustRow.style.display = this.form.w.customer_id.get() ? "none" : ""; }

  addLine() {
    const id = Number(this.psel.value);
    if (!id) return this.err("Odaberite proizvod.");
    let q;
    try { q = num(this.pqty.value); } catch { q = 0; }
    if (!(q > 0)) return this.err("Upišite količinu veću od 0.");
    const p = this.products.find((x) => x.id === id);
    const cp = (this.cprices || {})[String(id)];
    const price = cp !== undefined ? cp : p.price;
    const ex = this.lines.find((l) => l.product_id === id && Number(l.price) === Number(price));
    if (ex) ex.qty = Number(ex.qty) + q;
    else this.lines.push({ product_id: p.id, name: p.name, descr: p.descr || "", unit: p.unit || "kom", qty: q, price, vat: p.vat });
    if (cp !== undefined) toast("Cijena za ovog kupca.");
    this.err(""); this.psel.value = ""; this.pqty.value = "1"; this.psel.focus();
    this.renderLines();
  }

  renderLines() {
    this.linesEl.innerHTML = "";
    if (!this.lines.length) {
      this.linesEl.append(h("div", { class: "muted", style: { padding: "8px 0" } }, "Još nema stavki – odaberite proizvod i količinu pa kliknite „Dodaj”."));
    } else {
      this.linesEl.append(h("div", { class: "ol-row ol-head" }, h("span", {}, "#"), h("span", {}, "Proizvod"), h("span", {}, "Količina"),
        h("span", {}, this.net() ? "Cijena € bez PDV" : "Cijena €"), h("span", {}, this.net() ? "Iznos € bez PDV" : "Iznos €"), h("span", {})));
      this.lines.forEach((l, i) => {
        const q = h("input", { value: fq(l.qty), inputmode: "decimal" });
        const pr = h("input", { value: eur(this.shown(l)), inputmode: "decimal" });
        const amt = h("span", { class: "ol-amt" }, eur(l.qty * this.shown(l)));
        const upd = () => {
          try {
            l.qty = num(q.value);
            const v = num(pr.value), r = Number(l.vat || 0);
            l.price = this.net() && r ? Math.round(v * (1 + r / 100) * 10000) / 10000 : v;
          } catch { /* */ }
          amt.textContent = eur(l.qty * this.shown(l)); this.renderTot();
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

  ok(pdf = false) {
    try {
      const d = this.form.get();
      for (const l of this.lines) if (!(Number(l.qty) > 0)) throw new Error(`Količina za „${l.name}” mora biti veća od 0.`);
      this.close({ data: d, lines: this.lines, saveCustomer: !d.customer_id && this.saveCust.checked, pdf });
    } catch (e) { this.err(e.message); }
  }
}

// ------------------------------------------------------------------ posebne cijene po kupcu
async function customerPrices(app, productId) {
  const py = app.py;
  const p = py.call("web_offers.products").find((x) => x.id === productId);
  const custs = app.db.customers_list();
  const d = new Dialog(`Cijene po kupcu – ${p.name}`, { width: 640 });
  const t = T([["customer", "Kupac", 220, "w"], ["price", "Cijena € s PDV", 110, "e"], ["net", "bez PDV", 100, "e"]], { height: 8 });
  const load = () => t.setRows(py.call("web_more.product_customer_prices", productId).map((r) => ({ id: r.customer_id, customer: r.customer,
    price: eur(r.price), net: eur(r.price / (1 + (p.vat || 0) / 100)) })));
  d.body.append(h("div", { class: "muted", style: { fontSize: "12.5px" } }, `Osnovna cijena: ${eur(p.price)} € s PDV-om. Kad u ponudi odaberete kupca s posebnom cijenom, ona se upiše sama.`),
    h("div", { class: "row gap", style: { margin: "8px 0", flexWrap: "wrap" } },
      btn("＋ Cijena za kupca", async () => {
        const v = await askForm("Posebna cijena", [{ key: "customer_id", label: "Kupac", type: "combo", required: true, options: custs.map((c) => [c.name, c.id]) },
          { key: "net", label: "Cijena € bez PDV-a", type: "num", min: 0 }, { key: "price", label: "ili cijena € s PDV-om", type: "num", min: 0 }]);
        if (!v) return;
        const price = v.price || (v.net ? Math.round(v.net * (1 + (p.vat || 0) / 100) * 10000) / 10000 : null);
        if (!price) return info("Upišite cijenu.");
        py.call("web_more.set_customer_price", v.customer_id, productId, price); load();
      }),
      btn("🗑 Ukloni", () => { const id = t.selectedId(); if (id === null) return; py.call("web_more.set_customer_price", id, productId, null); load(); }, "ghost")),
    t.el);
  d.buttons(null, null, "Zatvori");
  load();
  await d.show();
}

// ------------------------------------------------------------------ ponuda -> otpremnica
async function toDelivery(app, offerId) {
  const py = app.py;
  const plan = py.call("web_more.offer_delivery_plan", offerId);
  const o = plan.offer;
  if (o.delivery_id) return info("Za ovu ponudu otpremnica je već izrađena (Kupci i otpremnice).");
  const d = new Dialog(`Otpremnica iz ponude ${o.no} – ${o.cust_name}`, { width: 760 });
  const pick = [];
  d.body.append(h("div", { class: "muted", style: { fontSize: "12.5px" } },
    "Za pivo u kegovima odaberite kegove (ponuđeni su puni kegovi tog piva, najstarije punjenje prvo). Ostale stavke idu na otpremnicu kao komadi."));
  for (const l of plan.lines) {
    if (l.keg) {
      const need = Math.round(l.qty);
      const box = h("div", { class: "keg-pick" });
      const cnt = h("span", { class: "muted" });
      const upd = () => { const n = box.querySelectorAll("input:checked").length; cnt.textContent = ` odabrano ${n} / ${need}`; cnt.style.color = n === need ? "var(--ok)" : "var(--warn)"; };
      l.candidates.forEach((k, i) => {
        const cb = h("input", { type: "checkbox", value: String(k.id) }); cb.checked = i < need;
        cb.addEventListener("change", upd);
        box.append(h("label", { class: "chk" }, cb, ` ${k.code} · ${k.lot} · ${d2ui(k.filled)}`));
      });
      if (!l.candidates.length) box.append(h("div", { class: "banner warn" }, "Nema punih kegova tog piva (17 L) – napunite ih u Radu s kegovima."));
      d.body.append(h("div", { class: "sec" }, `${l.name} · ${fq(l.qty)} ${l.unit}`, cnt), box);
      pick.push(() => [...box.querySelectorAll("input:checked")].map((x) => Number(x.value)));
      upd();
    }
  }
  const others = plan.lines.filter((l) => !l.keg);
  const ocb = {};
  if (others.length) {
    d.body.append(h("div", { class: "sec" }, "Ostale stavke"));
    for (const l of others) {
      const cb = h("input", { type: "checkbox" }); cb.checked = true; ocb[l.id] = cb;
      d.body.append(h("label", { class: "chk" }, cb, ` ${l.name} · ${fq(l.qty)} ${l.unit}`));
    }
  }
  const date = h("input", { type: "date", value: o.delivery_date || today() });
  d.body.append(h("div", { class: "row gap", style: { marginTop: "10px" } }, h("span", {}, "Datum isporuke"), date));
  d.buttons("🚚 Izradi otpremnicu", () => d.close(true));
  if (!(await d.show())) return;
  try {
    const kegs = pick.flatMap((f) => f());
    const oth = Object.entries(ocb).filter(([, cb]) => cb.checked).map(([id]) => Number(id));
    const r = py.call("web_more.offer_to_delivery", offerId, kegs, oth, date.value || null, app.db.get_setting("default_operator"));
    app.refreshAll();
    if (await confirm(`Otpremnica ${r.no} je izrađena. Izraditi PDF otpremnice?`, "Otpremnica", { ok: "PDF otpremnice", cancel: "Zatvori" }))
      await app.doc("web_extras.print_dn", r.delivery_id, "PDF");
  } catch (e) { error(e); }
}

// ------------------------------------------------------------------ cjenik
async function priceList(app) {
  const py = app.py;
  const d = new Dialog("Cjenik proizvoda za ponude", { width: 960 });
  const t = T([["grp", "Grupa", 120, "w"], ["name", "Proizvod", 220, "w"], ["descr", "Opis", 190, "w"], ["unit", "Jed.", 55, "center"],
    ["price", "Cijena € s PDV", 100, "e"], ["net", "bez PDV", 80, "e"], ["vat", "PDV %", 55, "e"], ["active", "U ponudi", 70, "center"]],
  { onDouble: (id) => edit(id), height: 14 });
  const load = () => t.setRows(py.call("web_offers.products").map((p) => ({ id: p.id, grp: p.grp || "", name: p.name, descr: p.descr || "",
    unit: p.unit || "", price: eur(p.price), net: eur(p.price / (1 + (p.vat || 0) / 100)), vat: fq(p.vat),
    active: p.active ? "✔" : (p.price > 0 ? "—" : "upišite cijenu"), _tag: p.active ? "" : "muted" })));
  const groups = py.call("web_offers.consts").groups.concat(["Veleprodaja – kegovi"]);
  const recipes = [["— nije pivo u kegu —", null]].concat(app.db.recipes().map((r) => [r.name, r.id]));
  const form = async (init, title) => {
    const r0 = Number((init || {}).vat ?? 25);
    const v = await askForm(title, [
      { key: "grp", label: "Grupa", type: "combo", editable: true, options: groups },
      { key: "name", label: "Naziv proizvoda", required: true },
      { key: "descr", label: "Opis (neobavezno, ispisuje se ispod naziva)" },
      { key: "unit", label: "Jedinica (kom, boca, osoba, keg…)", default: "kom" },
      { key: "price", label: "Cijena € s PDV-om", type: "num", min: 0 },
      { key: "net", label: "ili cijena € bez PDV-a (veleprodaja) – preračuna se", type: "num", min: 0 },
      { key: "vat", label: "Stopa PDV-a (%)", type: "num", min: 0, default: 25 },
      { key: "recipe_id", label: "Pivo u kegu (za otpremnicu iz ponude)", type: "combo", options: recipes },
      { key: "active", label: "Nudi se u ponudama", type: "check", default: 1 }],
    { ...init, net: init && init.price ? Math.round(init.price / (1 + r0 / 100) * 100) / 100 : null });
    if (!v) return null;
    const r = Number(v.vat || 0);
    const netOld = init && init.price ? Math.round(init.price / (1 + r0 / 100) * 100) / 100 : null;
    if (v.net && v.net !== netOld) v.price = Math.round(v.net * (1 + r / 100) * 10000) / 10000;
    delete v.net;
    if (v.active && !(v.price > 0)) { await info("Proizvod bez cijene ne može se nuditi – upišite cijenu.", "Cjenik"); v.active = 0; }
    if (v.recipe_id && !v.keg_l) v.keg_l = parseFloat(app.db.get_setting("keg_size_l") || 18) || 18;
    return v;
  };
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
    btn("👥 Cijene po kupcu", () => { const id = t.selectedId(); if (id === null) return info("Odaberite proizvod."); customerPrices(app, id); }, "ghost"),
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
    this.status = h("select", { class: "more", style: { width: "auto" } },
      ["Status…", "Izrađena", "Poslana", "Prihvaćena", "Odbijena"].map((x) => h("option", { value: x }, x)));
    this.status.addEventListener("change", () => {
      const v = this.status.value; this.status.value = "Status…";
      const id = this.need(this.table, "ponudu"); if (!id || v === "Status…") return;
      this.app.py.call("web_more.set_offer_status", id, v); this.refresh();
    });
    this.tb.insertBefore(this.status, this.tbRight);
    this.tbtn("🚚 Otpremnica", async () => { const id = this.need(this.table, "ponudu"); if (id) { await toDelivery(this.app, id); this.refresh(); } }, "ghost");
    this.tbtn("🖨 PDF", () => this.pdf(), "primary", true);
    this.table = T([["no", "Broj", 85, "w"], ["date", "Izdano", 130, "center"], ["cust", "Kupac", 200, "w"],
      ["deliv", "Isporuka", 95, "center"], ["place", "Mjesto isporuke", 150, "w"], ["total", "Iznos €", 95, "e"],
      ["valid", "Vrijedi do", 95, "center"], ["op", "Operater", 110, "w"], ["status", "Status", 95, "w"]], { onDouble: () => this.edit() });
    this.search(this.table);
    this.sum = h("div", { class: "muted", style: { fontSize: "12.5px" } });
    this.content.append(this.table.el, this.sum);
  }

  refresh() {
    const rows = this.app.py.call("web_offers.offers");
    this.table.setRows(rows.map((o) => ({ id: o.id, no: o.no, date: `${d2ui(o.issue_date)} ${o.issue_time || ""}`.trim(), cust: o.cust_name || "",
      deliv: d2ui(o.delivery_date), place: o.delivery_place || "", total: eur(o.total), op: o.operator || "", status: o.status || "",
      valid: d2ui(o.valid_until), _tag: o.status === "Prihvaćena" ? "ok" : o.status === "Odbijena" ? "muted"
        : (o.valid_until && o.valid_until < today() && !["Isporučena", "Prihvaćena"].includes(o.status) ? "warn" : "") })));
    this.sum.textContent = rows.length ? `${rows.length} ponuda · dvoklik otvara ponudu` : "Još nema ponuda – kliknite „Nova ponuda”.";
  }

  async open(data, title, id = null) {
    const res = await new OfferDialog(this.app, data, title).show();
    if (!res) return null;
    try {
      const oid = this.app.py.callKw("web_offers.save_offer", [res.data, res.lines], { id, save_customer: !!res.saveCustomer });
      this.app.refreshAll();
      toast("Ponuda spremljena.");
      if (res.pdf) await this.app.doc("web_offers.offer_pdf", oid, "PDF");
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
