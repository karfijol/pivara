// Izvješća: godišnji pregled (proizvodnja, trošak po litri, kupci) i kegovi za povrat.
import { h, btn, Page, Table, info, error, toast, fq, money, d2ui } from "../ui.js";
import { MonthBars, HBars } from "./stock.js";

const PALETTE = ["#E3A12B", "#4F9DDE", "#5BBF7A", "#A57BD6", "#E0675A", "#3FB8B0", "#C98B1E", "#8A8F98"];
const eur = (x, d = 2) => Number(x || 0).toLocaleString("hr-HR", { minimumFractionDigits: d, maximumFractionDigits: d });

function T(columns, opts = {}) {
  const t = new Table(columns, opts);
  const sum = columns.reduce((a, c) => a + (c[2] || 100), 0);
  t.table.style.minWidth = `${Math.round(sum * 0.6)}px`;
  return t;
}

// ------------------------------------------------------------------ godišnji pregled
class YearPage extends Page {
  static title = "Godišnji pregled";
  static subtitle = "Proizvedeno pivo po mjesecima i po vrsti, trošak sirovina po litri i prodaja po kupcima";

  build() {
    this.year = h("select", { style: { width: "110px" } });
    this.year.addEventListener("change", () => this.refresh());
    this.tb.insertBefore(this.year, this.tbRight);
    this.sum = h("div", { class: "msg", style: { fontWeight: 700, fontSize: "14px" } });
    this.chL = new MonthBars("Proizvedeno pivo", "litara po mjesecima");
    this.chC = new MonthBars("Trošak sirovina po litri", "€/L po mjesecima (bez PDV-a)");
    this.chB = new HBars("Po vrsti piva", "litara");
    this.chS = new HBars("Prodaja po kupcima", "litara na otpremnicama");
    this.chL.el.classList.add("span2");
    this.beers = T([["beer", "Pivo", 170, "w"], ["brews", "Kuhanja", 70, "center"], ["litres", "Litara", 90, "e"],
      ["cost", "Sirovine €", 100, "e"], ["perl", "€/L", 80, "e"]]);
    this.sales = T([["customer", "Kupac", 200, "w"], ["notes", "Otpremnica", 90, "center"], ["kegs", "Kegova", 80, "center"],
      ["litres", "Litara", 90, "e"]]);
    this.content.append(this.sum, h("div", { class: "grid2" }, this.chL.el, this.chC.el, this.chB.el),
      h("div", { class: "grid2", style: { marginTop: "14px" } },
        h("div", {}, h("h3", { class: "sec" }, "Piva"), this.beers.el), h("div", {}, h("h3", { class: "sec" }, "Kupci"), this.sales.el)));
    this.chS.el.style.display = "none";
  }

  refresh() {
    const y = this.year.value || String(new Date().getFullYear());
    const d = this.app.py.call("web_more.year_overview", y);
    if (!this.year.options.length || [...this.year.options].map((o) => o.value).join() !== d.years.join()) {
      this.year.innerHTML = "";
      for (const v of d.years) this.year.append(h("option", { value: v }, v));
      this.year.value = String(d.year);
    }
    this.sum.textContent = `${d.year}.: ${d.brews} kuhanja · ${fq(d.total_l, 0)} L proizvedenog piva · sirovine ${money(d.total_cost)}`
      + (d.total_l ? ` · prosječno ${eur(d.total_cost / d.total_l, 3)} €/L` : "");
    this.chL.set(d.total_l ? d.litres : [], `${fq(d.total_l, 0)} L`);
    this.chC.set(d.per_l.some((x) => x[1]) ? d.per_l.map(([m, v]) => [m, Math.round(v * 100) / 100]) : [], "€/L");
    const bmax = Math.max(1, ...d.beers.map((b) => b.litres));
    this.chB.set(d.beers.map((b, i) => [b.beer, b.litres, `${fq(b.litres, 0)} L`, PALETTE[i % PALETTE.length], null]), "", bmax);
    this.beers.setRows(d.beers.map((b, i) => ({ id: i, beer: b.beer, brews: b.brews, litres: fq(b.litres, 0), cost: eur(b.cost),
      perl: b.litres ? eur(b.cost / b.litres, 3) : "" })));
    this.sales.setRows(d.sales.map((s, i) => ({ id: i, customer: s.customer, notes: s.notes, kegs: s.kegs || "", litres: fq(s.litres, 0) })));
  }
}

// ------------------------------------------------------------------ kegovi za povrat
class ReturnsPage extends Page {
  static title = "Kegovi za povrat";
  static subtitle = "Kegovi kod kupaca: koliko dugo su vani i koliko depozita je u njima · popis za vozača";

  build() {
    this.days = h("input", { type: "number", min: "0", style: { width: "80px" }, value: this.db.get_setting("keg_return_days") || "30" });
    this.days.addEventListener("change", () => { this.db.set_setting("keg_return_days", this.days.value || "30"); this.refresh(); });
    this.tb.insertBefore(h("span", { class: "muted" }, "Vani dulje od"), this.tbRight);
    this.tb.insertBefore(this.days, this.tbRight);
    this.tb.insertBefore(h("span", { class: "muted" }, "dana"), this.tbRight);
    this.tbtn("🖨 Popis za vozača (PDF)", () => this.app.doc("web_more.keg_returns_pdf", Number(this.days.value || 30), true), "primary", true);
    this.tbtn("Svi kegovi kod kupaca (PDF)", () => this.app.doc("web_more.keg_returns_pdf", Number(this.days.value || 30), false), "ghost", true);
    this.sum = h("div", { class: "msg", style: { fontWeight: 700 } });
    this.cust = T([["customer", "Kupac", 200, "w"], ["n", "Kegova vani", 90, "center"], ["old", "Za povrat", 90, "center"],
      ["oldest", "Najduže (dana)", 100, "center"], ["dep", "Depozit", 90, "e"], ["phone", "Telefon", 120, "w"]],
    { onSelect: () => this.showKegs() });
    this.kegs = T([["code", "Keg", 90, "w"], ["beer", "Pivo", 140, "w"], ["lot", "LOT", 120, "w"], ["since", "Kod kupca od", 105, "center"],
      ["days", "Dana", 70, "center"]]);
    this.content.append(this.sum, this.cust.el, h("h3", { class: "sec" }, "Kegovi odabranog kupca"), this.kegs.el);
  }

  refresh() {
    this.data = this.app.py.call("web_more.keg_returns", Number(this.days.value || 30));
    const d = this.data;
    this.sum.textContent = d.total ? `${d.total} kegova kod ${d.customers.length} kupaca · za povrat (vani dulje od ${d.days} dana): ${d.old}`
      + (d.deposit ? ` · depozit ukupno ${money(d.deposit * d.total)}` : "") : "Nema kegova kod kupaca.";
    this.cust.setRows(d.customers.map((c, i) => ({ id: i, customer: c.customer, n: c.n, old: c.old || "", oldest: c.oldest,
      dep: d.deposit ? money(c.deposit) : "", phone: c.phone, _tag: c.old ? "warn" : "" })));
    this.showKegs();
  }
  showKegs() {
    const i = this.cust.selectedId();
    const c = this.data && this.data.customers[i ?? 0];
    this.kegs.setRows(c ? c.kegs.map((k, j) => ({ id: j, code: k.code, beer: k.beer, lot: k.lot, since: d2ui(k.since), days: k.days,
      _tag: k.old ? "warn" : "" })) : []);
  }
}

export const PAGES = { year: YearPage, returns: ReturnsPage };
