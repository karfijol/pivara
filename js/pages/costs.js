// Troškovi sirovina po kuhanju i mjesečni izvještaj za knjigovođu (PDF / Word / Excel).
// Cijene se uzimaju s LOT-ova sirovina (cijena s računa dobavljača); mogu se uvesti iz Excela "Matematika piva".
import { h, btn, Page, Table, Dialog, info, error, toast, busy, fq, money, d2ui } from "../ui.js";

const MONTHS = ["siječanj", "veljača", "ožujak", "travanj", "svibanj", "lipanj", "srpanj", "kolovoz", "rujan", "listopad", "studeni", "prosinac"];
const pad = (n) => String(n).padStart(2, "0");
function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${pad(last)}`];
}
function monthLabel(ym) { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}.`; }
function eur(x, d = 4) { return Number(x || 0).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: d }); }

function T(columns, opts = {}) {
  const t = new Table(columns, opts);
  const sum = columns.reduce((a, c) => a + (c[2] || 100), 0);
  t.table.style.minWidth = `${Math.round(sum * 0.6)}px`;
  return t;
}

function pickFile(accept) {
  return new Promise((res) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    inp.addEventListener("change", () => { res(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

class CostsPage extends Page {
  static title = "Troškovi i izvještaj za knjigovođu";
  static flat = true;
  static subtitle = "Što je kuhano u mjesecu, koje su sirovine utrošene i po kojoj cijeni (cijene bez PDV-a s računa dobavljača, po LOT-u)";

  build() {
    const now = new Date();
    const cur = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const prev = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();
    let months = [];
    try { months = this.app.py.call("web_costs.months_with_brews"); } catch { /* */ }
    const set = new Set([cur, prev, ...months]);
    this.months = [...set].sort().reverse();
    this.month = h("select", { style: { width: "150px" } },
      this.months.map((m) => h("option", { value: m }, monthLabel(m) + (months.includes(m) ? "" : " (nema kuhanja)"))),
      h("option", { value: "range" }, "Od – do…"));
    this.month.value = months.includes(prev) ? prev : (months[0] || prev);
    this.from = h("input", { type: "date", style: { width: "140px", display: "none" } });
    this.to = h("input", { type: "date", style: { width: "140px", display: "none" } });
    const onMonth = () => {
      const r = this.month.value === "range";
      this.from.style.display = this.to.style.display = r ? "" : "none";
      if (r && !this.from.value) { const [a, b] = monthRange(this.months[0]); this.from.value = a; this.to.value = b; }
      this.refresh();
    };
    this.month.addEventListener("change", onMonth);
    this.from.addEventListener("change", () => this.refresh());
    this.to.addEventListener("change", () => this.refresh());
    for (const el of [this.month, this.from, this.to]) this.tb.insertBefore(el, this.tbRight);
    this.tbtn("🖨 PDF", () => this.print("PDF"), "primary");
    this.tbtn("📝 Word", () => this.print("WORD"), "ghost");
    this.tbtn("📊 Excel", () => this.excel(), "ghost");
    this.tbtn("📥 Uvezi cijene iz Excela…", () => this.importPrices(), "ghost", true);

    this.banner = h("div", { class: "banner", style: { display: "none" } });
    this.sum = h("div", { class: "msg", style: { fontWeight: 700, fontSize: "14px" } });
    this.brews = T([["date", "Datum", 90, "center"], ["lot", "LOT piva", 125, "w"], ["beer", "Pivo", 150, "w"],
      ["brewed", "Skuhano L", 85, "e"], ["packaged", "Pakirano L", 85, "e"], ["cost", "Sirovine €", 95, "e"], ["perl", "€/L", 75, "e"]],
    { onDouble: (id) => this.brewDetail(id) });
    this.mats = T([["name", "Sirovina", 170, "w"], ["category", "Vrsta", 80, "w"], ["qty", "Količina", 85, "e"], ["unit", "Jed.", 45, "w"],
      ["avg", "Prosj. cijena €", 95, "e"], ["value", "Iznos € (bez PDV)", 105, "e"], ["invoices", "Računi", 170, "w"]]);
    this.content.append(this.banner, this.sum,
      h("h3", { class: "sec" }, "Kuhanja u razdoblju"), this.brews.el,
      h("div", { class: "muted", style: { fontSize: "12px" } }, "Dvoklik na kuhanje pokazuje sve sirovine tog kuhanja s LOT-om, cijenom i brojem računa."),
      h("h3", { class: "sec" }, "Utrošene sirovine (zbirno)"), this.mats.el,
      h("div", { class: "muted", style: { fontSize: "12px" } },
        "Cijena dolazi s LOT-a sirovine (račun dobavljača). Ako LOT nema cijenu, uzima se zadnja poznata cijena artikla i stavka se označi kao procjena (*). "
        + "Litre: pakirana količina, a dok pivo nije pakirano – skuhana količina sladovine."));
  }

  period() {
    if (this.month.value === "range") return [this.from.value, this.to.value];
    return monthRange(this.month.value);
  }
  periodName() {
    if (this.month.value === "range") return `${d2ui(this.from.value)} – ${d2ui(this.to.value)}`;
    return monthLabel(this.month.value);
  }

  refresh() {
    const [a, b] = this.period();
    if (!a || !b) return;
    const d = this.app.py.call("web_costs.report_data", a, b);
    this.data = d;
    this.brews.setRows(d.brews.map((x) => ({ id: x.id, date: d2ui(x.date), lot: x.lot, beer: x.beer, brewed: fq(x.brewed_l, 0),
      packaged: x.packaged_l ? fq(x.packaged_l, 0) : "—", cost: eur(x.cost, 2), perl: eur(x.per_l, 4),
      _tag: x.lines.some((l) => l.estimated) ? "warn" : "" })));
    this.mats.setRows(d.materials.map((m, i) => ({ id: i, name: m.name, category: m.category, qty: fq(m.qty), unit: m.unit,
      avg: eur(m.avg, 4), value: eur(m.value, 2), invoices: m.invoices })));
    this.sum.textContent = d.brews.length
      ? `${this.periodName()}: ${d.brews.length} kuhanja · ${fq(d.total_litres, 0)} L · sirovine ${money(d.total_cost)} · ${eur(d.per_l, 4)} €/L`
      : `${this.periodName()}: nema kuhanja u ovom razdoblju.`;
    const est = d.brews.reduce((n, x) => n + x.lines.filter((l) => l.estimated).length, 0);
    const msgs = [];
    if (d.missing_price) msgs.push(`${d.missing_price} stavki nema nikakvu cijenu – uvezite cijene iz Excela ili upišite cijenu artiklu.`);
    if (est) msgs.push(`ℹ ${est} stavki ima procijenjenu cijenu (LOT bez računa – uzeta zadnja cijena artikla), označeno * u izvještaju.`);
    this.banner.style.display = msgs.length ? "" : "none";
    this.banner.className = "banner " + (d.missing_price ? "warn" : "ok");
    this.banner.textContent = msgs.join("  ");
  }

  brewDetail(id) {
    const b = this.data && this.data.brews.find((x) => x.id === id);
    if (!b) return;
    const dlg = new Dialog(`${b.beer} · ${b.lot} · ${d2ui(b.date)}`, { width: 900 });
    const t = T([["name", "Sastojak", 170, "w"], ["lot", "LOT sirovine", 130, "w"], ["qty", "Utrošeno", 80, "e"], ["unit", "Jed.", 45, "w"],
      ["price", "Cijena €/jed.", 90, "e"], ["value", "Iznos €", 85, "e"], ["invoice", "Račun", 120, "w"]]);
    t.setRows(b.lines.map((l, i) => ({ id: i, name: l.name + (l.estimated ? " *" : ""), lot: l.lot, qty: fq(l.qty), unit: l.unit,
      price: eur(l.price, 4), value: eur(l.value, 2), invoice: l.invoice || (l.estimated ? "procjena" : "") })));
    dlg.body.append(t.el, h("div", { class: "msg", style: { fontWeight: 700 } },
      `Ukupno ${money(b.cost)} · ${fq(b.litres, 0)} L · ${eur(b.per_l, 4)} €/L`));
    dlg.bar.append(btn("Zatvori", () => dlg.close(), "ghost"));
    dlg.show();
  }

  async print(fmt) {
    const [a, b] = this.period();
    await this.app.doc("web_costs.report_doc", a, b, fmt);
  }
  async excel() {
    const [a, b] = this.period();
    await this.app.doc("web_costs.report_xlsx", a, b);
  }

  // ------------------------------------------------ uvoz cijena iz Excela (listovi Jecam, Hmelj, Kvasac, Ostalo)
  async importPrices() {
    const f = await pickFile(".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    if (!f) return;
    const path = "/tmp/cijene.xlsx";
    let pv;
    try {
      pv = await busy("Čitam Excel…", async (set) => {
        await this.app.py.ensureDocs(set);
        this.app.py.writeFile(path, new Uint8Array(await f.arrayBuffer()));
        set("Spajam stavke s računa s LOT-ovima…");
        return this.app.py.call("web_costs.price_preview", path);
      });
    } catch (e) { error(e.message); return; }
    if (!pv.rows.length) { info("U datoteci nisu pronađeni listovi s cijenama (Jecam, Hmelj, Kvasac, Ostalo)."); return; }
    this.previewDialog(path, pv, f.name);
  }

  previewDialog(path, pv, fname) {
    const dlg = new Dialog(`Uvoz cijena – ${fname}`, { width: 1000 });
    const itemOpts = [["— ne uvozi —", ""]].concat(pv.items);
    const mapping = { ...pv.mapping };
    const names = [...new Set(pv.rows.map((r) => r.name))].sort((a, b) => a.localeCompare(b, "hr"));
    const mapBox = h("div", { class: "map-grid", style: { display: "grid", gridTemplateColumns: "minmax(140px,1fr) minmax(180px,2fr)", gap: "6px 10px", alignItems: "center" } });
    const t = T([["sheet", "List", 70, "w"], ["invoice", "Račun", 115, "w"], ["name", "Naziv u Excelu", 150, "w"], ["item", "Artikl u programu", 170, "w"],
      ["qty", "Kol.", 60, "e"], ["price", "Cijena €", 80, "e"], ["date", "Primljeno", 90, "center"], ["lots", "LOT", 150, "w"], ["status", "Stanje", 100, "w"]],
    { height: 10 });
    const sum = h("div", { class: "msg" });
    const show = (p) => {
      pv = p;
      t.setRows(p.rows.map((r, i) => ({ id: i, sheet: r.sheet, invoice: r.invoice, name: r.name, item: r.item || "—", qty: fq(r.qty),
        price: eur(r.price, 4), date: d2ui(r.date), lots: r.lots, status: r.status, _tag: r.status === "ok" ? "" : "warn" })));
      const ok = p.rows.filter((r) => r.status === "ok").length;
      sum.textContent = `${p.rows.length} stavki s računa · ${ok} spojeno s LOT-om · ${p.rows.length - ok} bez LOT-a (te cijene postat će zadnja cijena artikla).`;
    };
    const reload = () => {
      try { show(this.app.py.call("web_costs.price_preview", path, mapping)); } catch (e) { error(e.message); }
    };
    for (const n of names) {
      const sel = h("select", {}, itemOpts.map(([l, v]) => h("option", { value: String(v) }, l)));
      sel.value = mapping[n] ? String(mapping[n]) : "";
      sel.addEventListener("change", () => { mapping[n] = sel.value ? Number(sel.value) : null; reload(); });
      mapBox.append(h("div", {}, n), sel);
    }
    const det = h("details", {}, h("summary", { style: { cursor: "pointer", fontWeight: 600, margin: "6px 0" } },
      `Povezivanje naziva iz Excela s artiklima (${names.length}) – promijenite ako je nešto krivo spojeno`), mapBox);
    dlg.body.append(sum, det, t.el,
      h("div", { class: "muted", style: { fontSize: "12px" } },
        "Svakom LOT-u upisuje se cijena i broj računa. LOT-ovi koji još nemaju cijenu dobiju zadnju cijenu artikla (označeno kao procjena)."));
    show(pv);
    dlg.bar.append(btn("Odustani", () => dlg.close(), "ghost"), btn("✔ Uvezi cijene", () => {
      try {
        const r = this.app.py.call("web_costs.apply_prices", pv.rows);
        dlg.close();
        info(`Upisano: ${r.lots} LOT-ova s cijenom s računa, ${r.items} artikala dobilo je zadnju cijenu`
          + (r.estimated ? `, ${r.estimated} LOT-ova bez računa dobilo je procijenjenu cijenu.` : ".")
          + (r.missing.length ? `\n\n${r.missing.length} stavki s računa nije pronađeno među primljenim LOT-ovima: `
            + r.missing.map((m) => `${m.name} (${m.invoice})`).join(", ") : ""), "Cijene su uvezene");
        this.refresh();
      } catch (e) { error(e.message); }
    }, "primary"));
    dlg.show();
  }
}

export const PAGES = { costs: CostsPage };
