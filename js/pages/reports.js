// Izvješća: godišnji pregled (proizvodnja, trošak po litri, kupci) i kegovi za povrat.
import { h, btn, Page, Table, info, error, toast, fq, money, d2ui } from "../ui.js";
import { MonthBars, HBars, ChartCard } from "./stock.js";

const SVGNS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  return e;
}
const MON = ["sij", "velj", "ožu", "tra", "svi", "lip", "srp", "kol", "ruj", "lis", "stu", "pro"];
const nf = (x) => Number(x || 0).toLocaleString("hr-HR", { maximumFractionDigits: 0 });
function axis(c, w, hh, vmax, left, right, top, bottom) {
  let step = 10 ** Math.max(0, Math.floor(Math.log10(vmax || 1)));
  const nice = Math.ceil((vmax || 1) / step) * step;
  if (nice / step <= 3) step /= 2;
  const ph = hh - top - bottom;
  for (let k = 0; k * step <= nice + 1e-9; k++) {
    const y = top + ph - ph * (k * step) / nice;
    c.append(S("line", { x1: left, y1: y, x2: w - right, y2: y, style: "stroke:var(--line)" }));
    c.append(S("text", { x: left - 6, y: y + 4, "text-anchor": "end", "font-size": 10.5, style: "fill:var(--muted)" }, nf(k * step)));
  }
  return { nice, ph };
}
function legend(c, items, x, y) {
  let lx = x;
  for (const [label, col] of items) {
    c.append(S("rect", { x: lx, y: y - 9, width: 11, height: 11, rx: 2, fill: col }));
    const t = S("text", { x: lx + 15, y, "font-size": 11.5, style: "fill:var(--text)" }, label);
    c.append(t);
    lx += 22 + label.length * 6.6;
  }
}

// proizvedeno pivo po mjesecima, stupci složeni po vrsti piva
class StackBars extends ChartCard {
  draw(c, w, hh) {
    const { months, series } = this.data[0];
    const left = 44, right = 10, top = 30, bottom = 24;
    const tot = months.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
    const { nice, ph } = axis(c, w, hh, Math.max(...tot), left, right, top, bottom);
    const slot = (w - left - right) / 12, bw = Math.min(34, slot * 0.62);
    months.forEach((m, i) => {
      const x = left + slot * i + slot / 2;
      let y0 = top + ph;
      series.forEach((s) => {
        const v = s.values[i]; if (!v) return;
        const hgt = ph * v / nice;
        const r = S("rect", { x: x - bw / 2, y: y0 - hgt, width: bw, height: hgt, fill: s.col });
        r.append(S("title", {}, `${s.beer}: ${nf(v)} L`));
        c.append(r); y0 -= hgt;
      });
      if (tot[i]) c.append(S("text", { x, y: y0 - 5, "text-anchor": "middle", "font-size": 10, style: "fill:var(--text)" }, nf(tot[i])));
      c.append(S("text", { x, y: hh - bottom + 16, "text-anchor": "middle", "font-size": 11, style: "fill:var(--muted)" }, MON[i]));
    });
    legend(c, series.map((s) => [s.beer, s.col]), left, 14);
  }
}

// proizvedeno i isporučeno (otpremnice) po mjesecima, dva stupca jedan do drugog
class PairBars extends ChartCard {
  draw(c, w, hh) {
    const { a, b, la, lb } = this.data[0];
    const left = 44, right = 10, top = 30, bottom = 24;
    const { nice, ph } = axis(c, w, hh, Math.max(...a, ...b), left, right, top, bottom);
    const slot = (w - left - right) / 12, bw = Math.min(16, slot * 0.32);
    for (let i = 0; i < 12; i++) {
      const x = left + slot * i + slot / 2;
      [[a[i], "#E3A12B", -1], [b[i], "#4F9DDE", 1]].forEach(([v, col, side]) => {
        if (!v) return;
        const hgt = ph * v / nice;
        const r = S("rect", { x: side < 0 ? x - bw - 1 : x + 1, y: top + ph - hgt, width: bw, height: hgt, fill: col, rx: 2 });
        r.append(S("title", {}, `${nf(v)} L`));
        c.append(r);
      });
      c.append(S("text", { x, y: hh - bottom + 16, "text-anchor": "middle", "font-size": 11, style: "fill:var(--muted)" }, MON[i]));
    }
    legend(c, [[la, "#E3A12B"], [lb, "#4F9DDE"]], left, 14);
  }
}

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
  static flat = true;
  static subtitle = "Proizvedeno pivo po mjesecima i vrsti piva, proizvedeno prema isporučenom i prodaja po kupcima";

  build() {
    this.year = h("select", { style: { width: "110px" } });
    this.year.addEventListener("change", () => this.refresh());
    this.tb.insertBefore(this.year, this.tbRight);
    this.sum = h("div", { class: "msg", style: { fontWeight: 700, fontSize: "14px" } });
    this.chL = new StackBars("Proizvedeno pivo po mjesecima", "litara, po vrsti piva", 260);
    this.chC = new PairBars("Proizvedeno i isporučeno", "litara po mjesecima", 230);
    this.chL.el.classList.add("span2");
    this.chC.el.classList.add("span2");
    this.beers = T([["beer", "Pivo", 170, "w"], ["brews", "Kuhanja", 70, "center"], ["litres", "Litara", 90, "e"],
      ["cost", "Sirovine €", 100, "e"], ["perl", "€/L", 80, "e"]]);
    this.sales = T([["customer", "Kupac", 200, "w"], ["notes", "Otpremnica", 90, "center"], ["kegs", "Kegova", 80, "center"],
      ["litres", "Litara", 90, "e"]]);
    this.content.append(this.sum, h("div", { class: "grid2" }, this.chL.el, this.chC.el),
      h("div", { class: "grid2", style: { marginTop: "14px" } },
        h("div", {}, h("h3", { class: "sec" }, "Piva"), this.beers.el), h("div", {}, h("h3", { class: "sec" }, "Kupci"), this.sales.el)));
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
    const series = d.stack.map((s, i) => ({ beer: s.beer, values: s.values, col: PALETTE[i % PALETTE.length] }));
    this.chL.set(d.total_l ? [{ months: d.months, series }] : [], `${fq(d.total_l, 0)} L ukupno`);
    const prod = d.months.map((_, i) => d.stack.reduce((a, s) => a + s.values[i], 0));
    this.chC.set(d.total_l || d.total_delivered ? [{ a: prod, b: d.delivered, la: "Proizvedeno", lb: "Isporučeno (otpremnice)" }] : [],
      `${fq(d.total_l, 0)} L proizvedeno · ${fq(d.total_delivered, 0)} L isporučeno`);
    this.beers.setRows(d.beers.map((b, i) => ({ id: i, beer: b.beer, brews: b.brews, litres: fq(b.litres, 0), cost: eur(b.cost),
      perl: b.litres ? eur(b.cost / b.litres, 3) : "" })));
    this.sales.setRows(d.sales.map((s, i) => ({ id: i, customer: s.customer, notes: s.notes, kegs: s.kegs || "", litres: fq(s.litres, 0) })));
  }
}

// ------------------------------------------------------------------ kegovi za povrat
class ReturnsPage extends Page {
  static title = "Kegovi za povrat";
  static flat = true;
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
