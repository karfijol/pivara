// Skladište i nabava: nadzorna ploča, sirovine, LOT-ovi, kemikalije, što naručiti, narudžbenice, dobavljači.
import { h, btn, Page, Table, Form, Dialog, askForm, confirm, info, error, toast, tableDialog, saveBlob, openFile,
  fq, money, fin, num, d2ui, today, daysLeft, EPS, setLabel } from "../ui.js";
import { icon } from "../icons.js";
import * as auth from "../auth.js";
import * as store from "../store.js";

const CATEGORIES = ["Slad", "Hmelj", "Kvasac", "Dodaci", "Ambalaža", "Kemikalija", "Ostalo"];
const UNITS = ["kg", "g", "L", "ml", "kom", "pak"];
const RED = "#E0675A";
const PALETTE = ["#E3A12B", "#4F9DDE", "#5BBF7A", "#E0675A", "#A57BD6", "#3FB8B0", "#C9C24A", "#8A8F98"];
const KEG_COLORS = { "Čist": "#5BBF7A", "Pun": "#E3A12B", "Kod kupca": "#4F9DDE", "Prljav": "#B9864A",
  "Servis": "#E0675A", "Otpisan": "#8A8F98" };

// ---------- funkcije iz haccp.js (drugi modul) – poziv u trenutku izvođenja, uz zaštitu ako modul još nije gotov
async function hx(app, name) {
  let mod = app.modules && app.modules.haccp;
  if (!mod) { try { mod = await import("./haccp.js"); } catch (e) { console.error(e); mod = null; } }
  const fn = mod && mod[name];
  return typeof fn === "function" ? fn : null;
}
function hxSync(app, name) {
  const mod = app.modules && app.modules.haccp;
  const fn = mod && mod[name];
  return typeof fn === "function" ? fn : null;
}
async function editReceipt(app, initial = null, id = null) {
  const fn = await hx(app, "editReceipt");
  if (!fn) { await info("HACCP zapisnik o prijemu trenutno nije dostupan (modul HACCP se nije učitao).", "HACCP"); return null; }
  return fn(app, initial, id);
}
function rowsFor(app, items, areaKey = "area") {
  const fn = hxSync(app, "rowsFor");
  if (fn) { try { return fn(items, areaKey); } catch (e) { console.error(e); } }
  return items.map((it) => ({ id: it.key, [areaKey]: it.type, type: it.type, text: it.text,
    date: it.type === "Trošarine MI-PI" ? "" : d2ui(it.date), _tag: it.sev, _typ: it.type }));
}

// zajedničke opcije (Page.supplier_opts / item_opts iz ui.py)
function supplierOpts(db) { return [["— nema —", null], ...db.suppliers().map((s) => [s.name, s.id])]; }
function itemOpts(db, chemicals = null) {
  return db.items(chemicals).map((i) => [`${i.name} (${i.unit})`, i.id, i.unit, i.price]);
}

// ======================================================================== grafovi (charts.py) kao inline SVG
const SVGNS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  return e;
}
function fmt(x, dec = 0) {
  return Number(x || 0).toLocaleString("hr-HR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const C_FG = "fill:var(--text)", C_MUTED = "fill:var(--muted)";

class ChartCard {
  constructor(title, subtitle = "", height = 230) {
    this.height = height;
    this.sub = h("span", { class: "s" }, subtitle);
    this.box = h("div", { style: { height: height + "px" } });
    this.el = h("div", { class: "chart" },
      h("div", { class: "row", style: { justifyContent: "space-between", gap: "8px", marginBottom: "4px" } }, h("h4", {}, title), this.sub),
      this.box);
    this.data = null;
    if (window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => { const w = this.box.clientWidth; if (w && w !== last) { last = w; this.redraw(); } }).observe(this.box);
    }
  }
  set(data, subtitle = null) {
    this.data = data;
    if (subtitle !== null && subtitle !== undefined) this.sub.textContent = subtitle;
    this.redraw();
  }
  redraw() {
    const w = this.box.clientWidth || 520, hh = this.height;
    this.box.innerHTML = "";
    if (this.data === null) return;
    const svg = S("svg", { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, "font-family": "inherit" });
    svg.style.width = "100%"; svg.style.height = hh + "px";
    if (!this.data.length) svg.append(S("text", { x: w / 2, y: hh / 2, "text-anchor": "middle", "font-size": 12, style: C_MUTED }, "Još nema podataka"));
    else this.draw(svg, w, hh);
    this.box.append(svg);
  }
  draw() {}
}

class MonthBars extends ChartCard {
  static MONTHS = ["sij", "velj", "ožu", "tra", "svi", "lip", "srp", "kol", "ruj", "lis", "stu", "pro"];
  draw(c, w, hh) {
    const left = 44, right = 10, top = 14, bottom = 26;
    const vmax = Math.max(...this.data.map((d) => d[1])) || 1;
    let step = 10 ** Math.max(0, Math.floor(Math.log10(vmax)));
    const nice = Math.ceil(vmax / step) * step;
    if (nice / step <= 3) step /= 2;
    const ph = hh - top - bottom;
    for (let k = 0; k * step <= nice + 1e-9; k++) {
      const y = top + ph - ph * (k * step) / nice;
      c.append(S("line", { x1: left, y1: y, x2: w - right, y2: y, style: "stroke:var(--line)" }));
      c.append(S("text", { x: left - 6, y: y + 4, "text-anchor": "end", "font-size": 10.5, style: C_MUTED }, fmt(k * step)));
    }
    const n = this.data.length, slot = (w - left - right) / n, bw = Math.min(34, slot * 0.62);
    this.data.forEach(([m, v], i) => {
      const x = left + slot * i + slot / 2, last = i === n - 1;
      if (v > 0) {
        const y = top + ph - ph * v / nice;
        c.append(S("rect", { x: x - bw / 2, y, width: bw, height: top + ph - y, rx: 2, style: `fill: ${last ? "var(--accent)" : "var(--chart)"}` }));
        c.append(S("text", { x, y: y - 5, "text-anchor": "middle", "font-size": 10, "font-weight": last ? 700 : 400, style: C_FG }, fmt(v)));
      }
      c.append(S("text", { x, y: hh - bottom + 16, "text-anchor": "middle", "font-size": 11, style: last ? C_FG : C_MUTED },
        MonthBars.MONTHS[+String(m).slice(5, 7) - 1] || m));
    });
  }
}

class Donut extends ChartCard {
  draw(c, w, hh) {
    const total = this.data.reduce((a, d) => a + d[1], 0);
    const R = Math.min(hh - 16, w * 0.45) / 2, ring = R * 0.30, r = R - ring / 2;
    const cx = 18 + R, cy = hh / 2, C = 2 * Math.PI * r;
    c.append(S("circle", { cx, cy, r, fill: "none", "stroke-width": ring, style: "stroke:var(--line)" }));
    let acc = 0;
    for (const [, v, col] of this.data) {
      if (v <= 0) continue;
      const len = C * v / total;
      c.append(S("circle", { cx, cy, r, fill: "none", stroke: col, "stroke-width": ring,
        "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -acc, transform: `rotate(-90 ${cx} ${cy})` }));
      acc += len;
    }
    c.append(S("text", { x: cx, y: cy + 2, "text-anchor": "middle", "font-size": 24, "font-weight": 700, style: C_FG }, fmt(total)));
    c.append(S("text", { x: cx, y: cy + 20, "text-anchor": "middle", "font-size": 11, style: C_MUTED }, this.unit || "ukupno"));
    const lx = cx + R + 30, gap = Math.min(26, (hh - 20) / Math.max(1, this.data.length));
    const y0 = cy - gap * (this.data.length - 1) / 2;
    this.data.forEach(([label, v, col], i) => {
      const y = y0 + i * gap;
      c.append(S("rect", { x: lx, y: y - 6, width: 12, height: 12, rx: 2, fill: col }));
      c.append(S("text", { x: lx + 20, y: y + 4, "font-size": 12, style: C_FG }, label));
      c.append(S("text", { x: w - 12, y: y + 4, "text-anchor": "end", "font-size": 12, "font-weight": 700, style: C_FG }, fmt(v)));
    });
  }
}

class HBars extends ChartCard {
  // data = [[oznaka, vrijednost, tekst_desno, boja, marker|null]]
  set(data, subtitle = null, maxValue = null, markerLabel = null) {
    this.maxValue = maxValue; this.markerLabel = markerLabel;
    super.set(data, subtitle);
  }
  fit(text, width) {
    const cw = 6.6; // približna širina znaka (12px)
    if (text.length * cw <= width) return text;
    let t = text;
    while (t && (t.length + 1) * cw > width) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }
  draw(c, w, hh) {
    const n = this.data.length, labelW = Math.min(170, w * 0.36), valW = 92;
    const x0 = labelW + 10, x1 = w - valW;
    const gap = Math.min(32, (hh - 22) / Math.max(n, 1)), bh = Math.min(14, gap * 0.55);
    const vmax = this.maxValue || Math.max(...this.data.map((d) => d[1])) || 1;
    const top = (hh - 18 - gap * n) / 2 + gap / 2;
    this.data.forEach(([label, v, right, col, marker], i) => {
      const y = top + i * gap;
      const t = S("text", { x: x0 - 10, y: y + 4, "text-anchor": "end", "font-size": 12, style: C_FG }, this.fit(String(label), labelW - 6));
      t.append(S("title", {}, String(label)));
      c.append(t);
      c.append(S("rect", { x: x0, y: y - bh / 2, width: Math.max(0, x1 - x0), height: bh, rx: 3, style: "fill:var(--line)" }));
      const frac = Math.max(0, Math.min(1, v / vmax));
      if (frac > 0) c.append(S("rect", { x: x0, y: y - bh / 2, width: (x1 - x0) * frac, height: bh, rx: 3, fill: col }));
      if (marker !== null && marker !== undefined) {
        const mx = x0 + (x1 - x0) * Math.min(1, marker / vmax);
        c.append(S("line", { x1: mx, y1: y - bh / 2 - 4, x2: mx, y2: y + bh / 2 + 4, "stroke-width": 2, style: "stroke:var(--text)" }));
      }
      c.append(S("text", { x: w - 8, y: y + 4, "text-anchor": "end", "font-size": 11, style: C_MUTED }, right));
    });
    if (this.markerLabel) {
      const mx = x0 + (x1 - x0) * Math.min(1, 1 / vmax);
      c.append(S("text", { x: mx, y: hh - 4, "text-anchor": "middle", "font-size": 11, style: C_MUTED }, this.markerLabel));
    }
  }
}

// ======================================================================== Nadzorna ploča
class DashboardPage extends Page {
  static title = "Nadzorna ploča";
  static flat = true;

  build() {
    this.tbtn("🔥 Dan kuhanja", () => this.app.show("batches", "brewDay"));
    this.tbtn("📄 Učitaj račun (primka)", async () => {
      const m = await this.app.loadModule("invoices");
      if (m && await m.newInvoice(this.app)) this.refresh();
    }, "ghost");
    this.tbtn("🛒 Što trebam naručiti", () => this.app.show("reorder"), "ghost");
    this.tbtn("🛡 HACCP evidencije", () => this.app.show("haccp"), "ghost|more");
    this.disBtn = this.tbtn("🔕 Zanemarena", () => this.showDismissed(), "ghost");
    this.dateLbl = h("span", { class: "muted", style: { fontSize: "13px" } });
    this.tbRight.append(this.dateLbl);

    this.cardW = {};
    const cards = h("div", { class: "cards" });
    const specs = [["low", "Ispod minimuma", "artikala", "items", "#E0675A"],
      ["exp", "Rokovi", "istekli / uskoro", "lots", "#E3A12B"],
      ["batch", "Šarže u tijeku", "", "batches", "#4F9DDE"],
      ["kegs", "Kegovi vani", "pun / kod kupca", "kegs", "#5BBF7A"],
      ["haccp", "HACCP zadaci", "otvoreno", "haccp", "#A57BD6"],
      ["value", "Vrijednost zaliha", "", "lots", "#3FB8B0"]];
    for (const [k, t, sub, page, col] of specs) {
      const v = h("div", { class: "val" }, "–"), s = h("div", { class: "s" }, sub);
      cards.append(h("div", { class: "kpi", onclick: () => this.app.show(page), title: "Otvori" },
        h("div", { class: "bar", style: { background: col } }), h("div", { class: "lab" }, t), v, s));
      this.cardW[k] = [v, s];
    }
    this.chProd = new MonthBars("Proizvodnja piva", "litara proizvedenog piva · zadnjih 12 mjeseci");
    this.chKegs = new Donut("Kegovi po statusu", "");
    this.chKegs.unit = "kegova";
    this.chVal = new HBars("Vrijednost zaliha po kategoriji", "");
    this.chProd.el.classList.add("span2");
    const charts = h("div", { class: "grid2" }, this.chProd.el, this.chKegs.el, this.chVal.el);

    this.alerts = new Table([["type", "Vrsta", 120, "w"], ["text", "Opis", 360, "w"], ["date", "Datum", 95, "center"]],
      { height: 8, onDouble: () => this.openAlert(this.alerts) });
    this.tasks = new Table([["area", "Područje", 110, "w"], ["text", "Zadatak", 420, "w"]],
      { height: 8, onDouble: () => this.openAlert(this.tasks) });
    const head = (t) => h("div", { class: "row", style: { justifyContent: "space-between", gap: "8px", marginBottom: "6px" } },
      h("b", { style: { fontSize: "16px" } }, t), h("span", { class: "muted", style: { fontSize: "11.5px" } }, "dvoklik = detalji / zanemari"));
    // upozorenja skladišta: sklopljena (sažetak po vrsti), "Prikaži sve" otvara cijeli popis
    this.alertsN = h("span", {});
    this.alertsSum = h("div", { class: "muted", style: { fontSize: "13px", marginTop: "4px" } });
    this.alertsBox = h("details", { class: "card kw-recent dash-alerts" },
      h("summary", {}, h("span", {}, "Upozorenja skladišta"), this.alertsN, h("span", { class: "kw-recent-btn" })),
      h("div", { class: "muted", style: { fontSize: "11.5px", margin: "0 0 6px" } }, "dvoklik = detalji / zanemari"), this.alerts.el);
    this.alertsBox.addEventListener("toggle", () => { this.alertsSum.style.display = this.alertsBox.open ? "none" : ""; });
    this.alertsSum.classList.add("dash-alerts-sum");
    this.alertsBox.querySelector("summary").append(this.alertsSum);
    // HACCP zadaci: isto sklopljeno
    this.tasksN = h("span", {});
    this.tasksSum = h("div", { class: "muted dash-alerts-sum", style: { fontSize: "13px", marginTop: "4px" } });
    this.tasksBox = h("details", { class: "card kw-recent dash-alerts" },
      h("summary", {}, h("span", {}, "HACCP – što nedostaje"), this.tasksN, h("span", { class: "kw-recent-btn" }), this.tasksSum),
      h("div", { class: "muted", style: { fontSize: "11.5px", margin: "0 0 6px" } }, "dvoklik = detalji / zanemari"), this.tasks.el);
    this.tasksBox.addEventListener("toggle", () => { this.tasksSum.style.display = this.tasksBox.open ? "none" : ""; });
    const low = h("div", { class: "grid2" },
      h("div", {}, this.alertsBox),
      h("div", {}, this.tasksBox));
    // podsjetnik za trošarine (umjesto skočnog prozora pri ulasku)
    this.exciseBar = h("div", { class: "banner warn", style: { display: "none", cursor: "pointer" }, onclick: () => this.app.show("excise") });
    this.tokenBar = h("div", { class: "banner warn", style: { display: "none", cursor: "pointer" }, onclick: () => this.app.show("settings") });
    this.invBar = h("div", { class: "banner warn", style: { display: "none", cursor: "pointer" }, onclick: () => this.app.show("invoices") });
    this.remBar = h("div", { class: "banner warn rem-bar", style: { display: "none", cursor: "pointer" }, onclick: () => this.app.show("reminders") });
    this.dryBar = h("div", { class: "banner ok dry-bar", style: { display: "none" } });
    this.content.append(this.tokenBar, this.remBar, this.dryBar, this.exciseBar, this.invBar, cards, charts, low);
  }

  // podsjetnik za dry hop (danas ili kasni) + obavijest na uređaju
  renderDry() {
    const due = this.app.py.call("web_more.dry_hop_due", 0);
    this.dryBar.innerHTML = "";
    this.dryBar.style.display = due.length ? "" : "none";
    if (!due.length) return;
    this.dryBar.className = "banner dry-bar " + (due.some((x) => x.late) ? "warn" : "ok");
    this.dryBar.append(h("b", { class: "row gap" }, icon("leaf", 18), "Dry hop"));
    for (const x of due) {
      this.dryBar.append(h("div", { class: "dry-item" },
        h("span", {}, `${x.recipe} ${x.batch_no}${x.tank ? " · " + x.tank : ""} – ${x.late ? "kasni od " + d2ui(x.date) : "danas" + (x.time ? " u " + x.time : "")}`
          + (x.hops.length ? ": " + x.hops.join(", ") : "")),
        btn("✔ Obavljeno", () => { this.app.py.call("web_more.dry_hop_mark", x.batch_id, true); toast("Dry hop označen kao obavljen."); this.refresh(); }, "ghost")));
    }
    const N = window.Notification;
    if (N && N.permission === "default") {
      this.dryBar.append(h("a", { href: "#", onclick: (e) => { e.preventDefault(); N.requestPermission().then(() => this.refresh()); } },
        "Uključi obavijesti na ovom uređaju"));
    }
    if (N && N.permission === "granted") {
      const today2 = today();
      for (const x of due) {
        const k = `dryhop_note_${x.batch_id}_${today2}`;
        try { if (localStorage.getItem(k)) continue; localStorage.setItem(k, "1"); } catch { /* */ }
        const body = `${x.recipe} ${x.batch_no}${x.tank ? " · " + x.tank : ""}` + (x.hops.length ? "\n" + x.hops.join(", ") : "");
        navigator.serviceWorker?.getRegistration().then((r) => r ? r.showNotification("Dry hop danas", { body, icon: "icons/icon-192.png", tag: "dry-" + x.batch_id })
          : new N("Dry hop danas", { body })).catch(() => {});
      }
    }
  }

  refresh() {
    const days = ["nedjelja", "ponedjeljak", "utorak", "srijeda", "četvrtak", "petak", "subota"];
    const td = new Date();
    const dn = days[td.getDay()];
    this.dateLbl.textContent = `${dn[0].toUpperCase() + dn.slice(1)}, ${d2ui(today())}`;
    const d = this.db.dashboard();
    const tasks = rowsFor(this.app, this.db.haccp_tasks());
    const alerts = rowsFor(this.app, this.db.visible(d.alerts), "type");
    const setV = (k, text, red = false) => { this.cardW[k][0].textContent = text; this.cardW[k][0].style.color = red ? RED : ""; };
    setV("low", String(d.low), !!d.low);
    this.cardW.low[1].textContent = `artikala · narudžbi ${d.open_pos}`;
    setV("exp", `${d.expired} / ${d.expiring}`, !!d.expired);
    setV("batch", String(d.active_batches));
    this.cardW.batch[1].textContent = `+ ${d.planned} planirano`;
    const k = d.kegs;
    setV("kegs", `${k["Pun"] || 0} / ${k["Kod kupca"] || 0}`);
    this.cardW.kegs[1].textContent = `čistih ${k["Čist"] || 0} · prljavih ${k["Prljav"] || 0}`;
    setV("haccp", String(tasks.length), tasks.some((t) => t._tag === "bad"));
    setV("value", money(d.stock_value));

    const c = this.db.chart_data();
    const total = c.production.reduce((a, x) => a + x[1], 0);
    this.chProd.set(total ? c.production : [], `${fq(total, 0)} L proizvedenog piva · zadnjih 12 mjeseci`);
    const kd = Object.entries(c.kegs).filter(([s, n]) => n || ["Čist", "Pun", "Kod kupca"].includes(s))
      .map(([s, n]) => [s, n, KEG_COLORS[s] || "#8A8F98"]);
    const kn = kd.reduce((a, x) => a + x[1], 0);
    this.chKegs.set(kn ? kd : [], `${kn} ukupno`);
    const vmax = Math.max(...(c.value.length ? c.value.map((x) => x[1]) : [1]));
    this.chVal.set(c.value.map(([cat, v], i) => [cat, v, money(v), PALETTE[i % PALETTE.length], null]),
      money(c.value.reduce((a, x) => a + x[1], 0)), vmax);

    alerts.sort((a, b) => (String(a.type).startsWith("Trošarine") ? 0 : 1) - (String(b.type).startsWith("Trošarine") ? 0 : 1));
    this.alerts.setRows(alerts.length ? alerts : [{ id: 0, type: "✓", text: "Sve je u redu – nema upozorenja.", _tag: "ok" }]);
    this.alertsN.textContent = alerts.length ? ` (${alerts.length})` : "";
    const kinds = {};
    for (const r of alerts) kinds[r.type] = (kinds[r.type] || 0) + 1;
    this.alertsSum.textContent = alerts.length ? Object.entries(kinds).map(([k, v]) => `${k}: ${v}`).join(" · ") : "✓ Sve je u redu – nema upozorenja.";
    this.tasks.setRows(tasks.length ? tasks : [{ id: 0, area: "✓", text: "HACCP evidencije su ažurne.", _tag: "ok" }]);
    this.tasksN.textContent = tasks.length ? ` (${tasks.length})` : "";
    const areas = {};
    for (const r of tasks) areas[r.area] = (areas[r.area] || 0) + 1;
    this.tasksSum.textContent = tasks.length ? Object.entries(areas).map(([k, v]) => `${k}: ${v}`).join(" · ") : "✓ HACCP evidencije su ažurne.";
    try { this.renderDry(); } catch (e) { console.warn(e); }
    try {
      const ts = this.app.py.call("web_more.token_status");
      const warn = ts && ts.days <= 30;
      this.tokenBar.style.display = warn ? "" : "none";
      if (warn) this.tokenBar.textContent = ts.days < 0
        ? `GitHub token je istekao ${d2ui(ts.date)} – spremanje ne radi. Administrator: napravite novi token i upišite ga u Postavke → Korisnici → 🔑 Zamijeni tokene.`
        : `GitHub token ističe za ${ts.days} dana (${d2ui(ts.date)}). Administrator: na GitHubu napravite novi token i upišite ga u Postavke → Korisnici → 🔑 Zamijeni tokene.`;
    } catch (e) { console.warn(e); }
    try {
      const rd = auth.canSee(this.app.user, "reminders") ? this.app.py.call("web_reminders.due") : [];
      this.remBar.style.display = rd.length ? "" : "none";
      this.remBar.innerHTML = "";
      if (rd.length) {
        const urgent = rd.some((r) => r.stage === "late" || r.stage === "today");
        this.remBar.className = "banner rem-bar " + (urgent ? "bad" : "warn");
        const box = h("div", { class: "rem-list" }, h("b", {}, rd.length === 1 ? "Podsjetnik" : `Podsjetnici (${rd.length})`),
          ...rd.slice(0, 4).map((r) => h("div", {}, r.message)), rd.length > 4 ? h("div", { class: "muted" }, `… i još ${rd.length - 4} – kliknite za sve podsjetnike.`) : null);
        this.remBar.append(box);
        import("./reminders.js").then((m) => m.notifyReminders(this.app, rd)).catch(() => {});
      }
    } catch (e) { console.warn(e); }
    try {
      const due = this.app.py.call("web_invoices.due_summary");
      this.invBar.style.display = due.length ? "" : "none";
      if (due.length) {
        const t0 = today();
        const late = due.filter((r) => r.due_date < t0);
        const sum = due.reduce((a, r) => a + (r.total || 0), 0);
        this.invBar.textContent = `${due.length} račun(a) dobavljača ${late.length ? `(dospjelo: ${late.length}) ` : ""}za platiti uskoro – `
          + `${sum.toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €. Kliknite za Račune.`;
      }
    } catch (e) { console.warn(e); }
    try {
      const rem = this.db.excise_reminder();
      const show = rem && !this.db.is_dismissed({ key: `excise:${rem[0]}`, type: "Trošarine MI-PI" });
      this.exciseBar.style.display = show ? "" : "none";
      if (show) this.exciseBar.textContent = rem[1] + " – kliknite za Trošarine.";
    } catch (e) { console.warn(e); }
    let n = 0;
    const cnt = hxSync(this.app, "dismissedCount");
    try { n = cnt ? cnt(this.app) : this.db.dismissed_list().length; } catch (e) { console.error(e); }
    setLabel(this.disBtn, n ? `Zanemarena (${n})` : "Zanemarena");
  }

  async openAlert(table) {
    const fn = await hx(this.app, "openWarningFromTable");
    if (!fn) return info("Detalji upozorenja trenutno nisu dostupni (modul HACCP se nije učitao).");
    try { await fn(this.app, table, () => this.refresh()); } catch (e) { this.err(e); }
  }

  async showDismissed() {
    const fn = await hx(this.app, "showDismissed");
    if (!fn) return info("Popis zanemarenih upozorenja trenutno nije dostupan (modul HACCP se nije učitao).");
    await fn(this.app);
    this.refresh();
  }
}

// ======================================================================== Sirovine
class ItemsPage extends Page {
  static title = "Sirovine i materijal";
  static subtitle = "Artikli na skladištu, zalihe (samo valjani LOT-ovi), minimalne zalihe";

  build() {
    this.tbtn("＋ Novi artikl", () => this.new());
    this.tbtn("Uredi", () => this.edit(), "ghost");
    this.tbtn("📄 Primka iz računa", async () => {
      const m = await this.app.loadModule("invoices");
      if (m && await m.newInvoice(this.app)) this.refresh();
    });
    this.tbtn("⬇ Ručna primka (LOT)", () => this.receive(), "ghost");
    this.tbtn("⬆ Izdavanje (FIFO)", () => this.issue(), "ghost");
    this.tbtn("Kartica artikla", () => this.card(), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.cat = "Sve";
    this.seg = h("div", { class: "seg" });
    for (const c of ["Sve", ...CATEGORIES]) {
      const b = h("button", { type: "button", class: c === this.cat ? "on" : "", onclick: () => {
        this.cat = c;
        for (const x of this.seg.children) x.classList.toggle("on", x === b);
        this.refresh();
      } }, c);
      this.seg.append(b);
    }
    this.table = new Table([
      ["code", "Šifra", 80, "w"], ["name", "Naziv", 250, "w"], ["category", "Kategorija", 100, "w"],
      ["stock", "Zaliha", 90, "e"], ["unit", "Jed.", 50, "center"], ["min", "Minimum", 80, "e"],
      ["lots", "LOT-ova", 70, "center"], ["expired", "Istekla", 80, "e"],
      ["supplier", "Dobavljač", 170, "w"], ["price", "Cijena", 80, "e"], ["state", "Stanje", 110, "w"]],
    { onDouble: () => this.card() });
    this.search(this.table);
    this.content.append(h("div", {}, this.seg), this.table.el);
  }

  refresh() {
    const cat = this.cat, rows = [];
    for (const i of this.db.items()) {
      if (cat !== "Sve" && (i.category || "Ostalo") !== cat) continue;
      const low = i.min_stock && i.stock < i.min_stock;
      const state = i.stock <= EPS ? "Nema zalihe" : (low ? "Ispod minimuma" : "OK");
      rows.push({ id: i.id, code: i.code || "", name: i.name, category: i.category || "",
        stock: fq(i.stock), unit: i.unit, min: fq(i.min_stock), lots: i.lot_count,
        expired: i.expired ? fq(i.expired) : "", supplier: i.supplier_name || "", price: fq(i.price, 2), state,
        _tag: i.stock <= EPS ? "bad" : (low || i.expired ? "warn" : "") });
    }
    this.table.setRows(rows);
  }

  fields(chem = false) {
    return [
      { key: "code", label: "Šifra" }, { key: "name", label: "Naziv", required: true },
      { key: "category", label: "Kategorija", type: "combo", options: CATEGORIES, editable: true, default: chem ? "Kemikalija" : "Slad" },
      { key: "unit", label: "Jedinica mjere", type: "combo", options: UNITS, editable: true, default: chem ? "L" : "kg" },
      { key: "min_stock", label: "Minimalna zaliha", type: "num", min: 0, default: 0 },
      { key: "reorder_qty", label: "Pakiranje / min. narudžba", type: "num", min: 0, default: 0 },
      { key: "supplier_id", label: "Glavni dobavljač", type: "combo", options: supplierOpts(this.db) },
      { key: "price", label: "Nabavna cijena (€/jed.)", type: "num", min: 0, default: 0 },
      { key: "is_chemical", label: "Kemikalija (praćenje sigurnosnih rokova)", type: "check", default: chem ? 1 : 0 },
      { key: "shelf_after_open_days", label: "Rok nakon otvaranja (dana, 0 = nema)", type: "num", min: 0, default: 0 },
      { key: "hazard", label: "Oznake opasnosti (H/P oznake, GHS)" },
      { key: "storage", label: "Uvjeti skladištenja" },
      { key: "sds_path", label: "Sigurnosno-tehnički list (putanja do PDF-a)" },
      { key: "note", label: "Napomena", type: "multi", height: 50 },
    ];
  }

  _save(data, id = null) {
    data.shelf_after_open_days = Math.trunc(data.shelf_after_open_days || 0);
    this.db.save_item(data, id);
    this.app.refreshAll();
  }

  async new(chem = false) {
    const d = await askForm("Novi artikl", this.fields(chem), {}, { columns: 2 });
    if (d) this._save(d);
  }

  async edit(id = null) {
    id = id || this.need(this.table, "artikl");
    if (!id) return;
    const d = await askForm("Uredi artikl", this.fields(), this.db.item(id), { columns: 2 });
    if (d) this._save(d, id);
  }

  async receive(itemId = null, chem = null) {
    if (itemId === null && chem === null) itemId = this.table ? this.table.selectedId() : null;
    const opts = itemOpts(this.db, chem).map((o) => [o[0], o[1]]);
    const it = itemId ? this.db.item(itemId) : null;
    const d = await askForm("Primka robe – novi LOT", [
      { key: "item_id", label: "Artikl", type: "combo", options: opts, required: true },
      { key: "lot_no", label: "LOT broj (prazno = automatski interni)" },
      { key: "qty", label: "Količina", type: "num", required: true, positive: true },
      { key: "received", label: "Datum primitka", type: "date", required: true, default: today() },
      { key: "expiry", label: "Rok trajanja (najbolje upotrijebiti do)", type: "date" },
      { key: "supplier_id", label: "Dobavljač", type: "combo", options: supplierOpts(this.db) },
      { key: "unit_price", label: "Cijena €/jed. (bez PDV-a, s računa)", type: "num", min: 0 },
      { key: "invoice_no", label: "Broj računa dobavljača (za izvještaj knjigovođi)" },
      { key: "alpha", label: "Alfa kiseline % (samo hmelj, s deklaracije)", type: "num", min: 0 },
      { key: "note", label: "Napomena (br. otpremnice…)" },
      { key: "haccp", label: "Odmah ispuni HACCP zapisnik o prijemu (sirovine i ambalaža)", type: "check" },
    ], { item_id: itemId, supplier_id: it ? it.supplier_id : null, unit_price: it ? it.price : 0, haccp: chem ? 0 : 1 });
    if (!d) return;
    const want = d.haccp;
    const alpha = d.alpha;
    delete d.haccp; delete d.alpha;
    let lotId;
    try {
      lotId = this.db.receive_lot(d.item_id, d.qty, d.lot_no, d.received, d.expiry, d.supplier_id, d.unit_price || 0, null, d.note);
      if (d.invoice_no) this.app.py.call("web_costs.set_lot_invoice", [lotId], d.invoice_no);
      if (alpha) this.app.py.call("web_more.set_lot_alpha", [lotId], alpha);
      this.app.refreshAll();
      this.app.toast("Primka spremljena.");
    } catch (e) { this.err(e); return; }
    if (want && !this.db.lot(lotId).is_chemical) {
      await editReceipt(this.app, this.db.receipt_defaults(lotId));
      this.app.refreshAll();
    }
  }

  async issue(itemId = null, chem = null) {
    if (itemId === null && chem === null) itemId = this.table ? this.table.selectedId() : null;
    const opts = itemOpts(this.db, chem).map((o) => [o[0], o[1]]);
    const d = await askForm("Izdavanje sa skladišta (FIFO)", [
      { key: "item_id", label: "Artikl", type: "combo", options: opts, required: true },
      { key: "qty", label: "Količina", type: "num", required: true, positive: true },
      { key: "mtype", label: "Vrsta", type: "combo", options: ["IZDAVANJE", "OTPIS", "ČIŠĆENJE", "UZORAK"], default: "IZDAVANJE" },
      { key: "ref", label: "Referenca (npr. šarža, tank)" }, { key: "note", label: "Napomena" },
    ], { item_id: itemId });
    if (!d) return;
    try {
      const alloc = this.db.issue_fifo(d.item_id, d.qty, d.mtype, d.ref || "", d.note || "");
      this.app.refreshAll();
      this.app.toast("Izdano iz LOT-ova: " + alloc.map((a) => `${a[1]} (${fq(a[2])})`).join(", "));
    } catch (e) { this.err(e); }
  }

  card() {
    const id = this.need(this.table, "artikl");
    if (!id) return;
    const it = this.db.item(id);
    const rows = this.db.movements(id).map((m) => ({ id: m.id, ts: d2ui(m.ts.slice(0, 10)) + m.ts.slice(10), type: m.type,
      lot: m.lot_no || "", qty: fq(m.qty), ref: m.ref || "", note: m.note || "", _tag: m.qty > 0 ? "ok" : "" }));
    const lots = this.db.lots(true, id).map((l) => `${l.lot_no}: ${fq(l.qty_left)}`).join(", ");
    return tableDialog(`Kartica: ${it.name}`, [
      ["ts", "Vrijeme", 140, "w"], ["type", "Vrsta", 100, "w"], ["lot", "LOT", 130, "w"],
      ["qty", `Količina (${it.unit})`, 110, "e"], ["ref", "Referenca", 130, "w"], ["note", "Napomena", 200, "w"]],
    rows, { info: `Zaliha: ${fq(this.db.stock(id))} ${it.unit}   ·   Aktivni LOT-ovi (FIFO redom): ${lots || "—"}` });
  }

  async delete() {
    const id = this.need(this.table, "artikl");
    if (id && await confirm("Obrisati odabrani artikl?\n(Ako ima povijest, bit će samo deaktiviran.)", "Brisanje")) {
      const r = this.db.delete_item(id);
      this.app.refreshAll();
      this.app.toast(`Artikl ${r}.`);
    }
  }
}

// ======================================================================== LOT-ovi
function tbSwitch(page, text, onChange) {
  const cb = h("input", { type: "checkbox", onchange: () => onChange() });
  page.tb.insertBefore(h("label", { class: "chk", style: { marginLeft: "8px" } }, cb, " ", text), page.tbRight);
  return cb;
}

// ======================================================================== Inventura
// usporedi sva kuhanja sa svom zaprimljenom robom: po FIFO pravilu ponovno raspodijeli utrošak šarži po LOT-ovima
// (sljedivost, HACCP, trošak šarže), izračuna stanje LOT-ova i kartice artikala; ništa se ne mijenja bez potvrde
const lotList = (a) => a.map((x) => `${x.lot_no}: ${fq(x.qty)}`).join(", ");
export async function inventory(app) {
  const py = app.py;
  const ro = auth.isReadonly(app.user);
  const d = new Dialog("Inventura – kuhanja i zaprimljena roba", { width: 1100 });
  const mode = h("select", { style: { maxWidth: "100%", minWidth: "0", flex: "1 1 260px" } }, h("option", { value: "recipe" }, "po recepturama (receptura × volumen šarže, prema datumu kuhanja)"),
    h("option", { value: "evidence" }, "po evidenciji kuhanja (stvarno skinuto); što nedostaje – po recepturi"));
  const corr = h("input", { type: "checkbox" });
  const corrLbl = h("span", {});
  const head = h("div", { class: "msg", style: { fontSize: "13px" } });
  const todoBox = h("div", {});
  const t = new Table([["name", "Artikl", 180, "w"], ["unit", "Jed.", 40, "center"], ["received", "Primljeno", 80, "e"],
    ["c_old", "Utrošeno sada", 95, "e"], ["c_new", "Utrošeno novo", 95, "e"], ["s_old", "Stanje sada", 85, "e"], ["s_new", "Stanje novo", 85, "e"],
    ["nb", "Šarže", 55, "center"], ["nl", "LOT-ovi", 60, "center"], ["warn", "Upozorenje", 200, "w"]],
  { multi: true, height: 12, onDouble: (id) => detail(id) });
  let res = null;
  const load = () => {
    res = py.call("web_stockcheck.calc", mode.value, corr.checked);
    const ch = res.items.filter((x) => x.changed);
    head.textContent = `Pregledano ${res.n_brewed} skuhanih šarži i sva zaprimljena roba (${res.n_items_all} artikala). `
      + (ch.length ? `Promjene kod ${ch.length} artikala – dvoklik na artikl pokazuje što se mijenja po šaržama i LOT-ovima. `
        + "Označite artikle koje prihvaćate (ili „Primijeni sve”); ostale odbacujete tako da ih ne označite." : "Evidencija odgovara izračunu – nema promjena.")
      + (res.last_inv ? ` Zadnja inventura: ${d2ui(res.last_inv.slice(0, 10))}${res.last_inv.slice(10)}.` : "");
    corrLbl.textContent = `uzmi u obzir i ranije ručne korekcije količine${res.corr_skipped ? ` (${res.corr_skipped} zapisa prije zadnje inventure)` : ""}`;
    todoBox.innerHTML = "";
    if (res.todo.length) todoBox.append(h("div", { class: "msg warn", style: { fontSize: "13px" } }, h("b", {}, "Što trebate napraviti:"),
      h("ul", { style: { margin: "4px 0 0 18px", padding: 0 } }, res.todo.map((x) => h("li", {}, x)))));
    t.setRows(res.items.map((x) => ({ id: x.item_id, name: x.name, unit: x.unit, received: fq(x.received), c_old: fq(x.cons_old), c_new: fq(x.cons_new),
      s_old: fq(x.stock_old), s_new: fq(x.stock_new), nb: x.n_batches || "", nl: x.n_lots || "", warn: x.warn,
      _tag: x.short > 0.0005 ? "bad" : x.changed ? "warn" : "" })));
    if (!res.items.length) t.tbody.querySelector("tr.empty td").textContent = "Nema razlika – utrošak i stanje skladišta odgovaraju kuhanjima i primkama.";
  };
  const detail = async (iid) => {
    const it = res.items.find((x) => x.item_id === iid);
    const dd = new Dialog(`Inventura – ${it.name}`, { width: 1000 });
    const tb = new Table([["batch", "Šarža", 115, "w"], ["date", "Kuhano", 90, "center"], ["beer", "Pivo", 120, "w"], ["need", `Potrebno (${it.unit})`, 95, "e"],
      ["old", "Sada (LOT: količina)", 230, "w"], ["new", "Novo (LOT: količina)", 230, "w"], ["short", "Nedostaje", 80, "e"]], { height: 9 });
    tb.setRows(res.batches.filter((c) => c.item_id === iid).map((c, i) => ({ id: i, batch: c.batch_no, date: d2ui(c.date), beer: c.recipe,
      need: fq(c.need), old: lotList(c.old) || "—", new: lotList(c.new) || "—", short: c.short ? fq(c.short) : "",
      _tag: c.short ? "bad" : c.changed ? "warn" : "" })));
    const tl = new Table([["lot", "LOT", 160, "w"], ["date", "Primljeno", 95, "center"], ["rec", "Primljeno kol.", 100, "e"],
      ["old", "Preostalo sada", 110, "e"], ["new", "Preostalo novo", 110, "e"]], { height: 6 });
    tl.setRows(res.lots.filter((l) => l.item_id === iid).map((l, i) => ({ id: i, lot: l.lot_no, date: d2ui(l.received_date), rec: fq(l.received),
      old: fq(l.old), new: fq(l.new), _tag: l.changed ? "warn" : "" })));
    dd.body.append(h("div", { class: "msg" }, `Primljeno ${fq(it.received)} ${it.unit} · utrošeno ${fq(it.cons_old)} → ${fq(it.cons_new)} · stanje ${fq(it.stock_old)} → ${fq(it.stock_new)} ${it.unit}`),
      h("div", { class: "sec" }, "Utrošak po šaržama (sljedivost)"), tb.el, h("div", { class: "sec", style: { marginTop: "8px" } }, "Stanje LOT-ova"), tl.el);
    dd.buttons(null, null, "Zatvori");
    await dd.show();
  };
  const run = async (ids) => {
    const sel = res.items.filter((x) => ids.includes(x.item_id) && x.changed);
    if (!sel.length) return d.err("Označite artikle s promjenama (ili kliknite „Primijeni sve”).");
    const nb = sel.reduce((a, x) => a + x.n_batches, 0), nl = sel.reduce((a, x) => a + x.n_lots, 0);
    const msg = `Primijeniti inventuru za ${sel.length} artikl(a)?\n\n${sel.slice(0, 12).map((x) => `• ${x.name}: stanje ${fq(x.stock_old)} → ${fq(x.stock_new)} ${x.unit}`).join("\n")}${sel.length > 12 ? "\n…" : ""}\n\n`
      + "Mijenja se:\n"
      + `• utrošak sirovina u šaržama (${nb} zapisa po šaržama) – sljedivost LOT-ova, HACCP evidencija kuhanja i utroška, trošak šarže i izvještaj za knjigovođu\n`
      + `• preostala količina na LOT-ovima (${nl}) – stanje skladišta, „Što trebam naručiti”, vrijednost zalihe\n`
      + "• kartice artikala – kretanja „KUHANJE” prema novoj raspodjeli i „INVENTURA” za usklađenje\n\n"
      + "Prije potvrde preporuka: Postavke → sigurnosna kopija baze.";
    if (!(await confirm(msg, "Potvrda inventure", { ok: "Primijeni", cancel: "Odbaci" }))) return;
    let r;
    try { r = py.call("web_stockcheck.apply", sel.map((x) => x.item_id), mode.value, corr.checked); } catch (e) { return error(e); }
    app.refreshAll();
    load();
    await info(`Inventura upisana: ${r.items} artikl(a), ${r.batches} šarž(i) s promijenjenim utroškom, ${r.lots} LOT(-ova) s novim stanjem.`
      + (r.todo.length ? "\n\nŠto još trebate napraviti:\n" + r.todo.map((x) => "• " + x).join("\n") : "\n\nNema otvorenih stavki.")
      + "\n\nNa kraju fizički provjerite zalihu; ako se stanje razlikuje, upišite ga s „Korekcija količine” na LOT-u.", "Inventura");
  };
  mode.addEventListener("change", load);
  corr.addEventListener("change", load);
  d.body.append(head, todoBox, h("div", { class: "row gap", style: { alignItems: "center", flexWrap: "wrap", margin: "6px 0" } },
    h("b", {}, "Utrošak kuhanja:"), mode, h("label", { class: "row gap", style: { alignItems: "center" } }, corr, corrLbl)),
  t.el, h("div", { class: "muted", style: { fontSize: "12px", marginTop: "4px" } },
    "FIFO: svako kuhanje uzima s najstarijeg LOT-a koji je bio na skladištu na dan kuhanja. Ništa se ne mijenja dok ne kliknete „Primijeni…”."));
  d.buttons(null, null, "Odbaci / zatvori");
  d.bar.prepend(btn("Izvoz CSV", () => t.exportCsv("inventura"), "ghost"));
  if (!ro) d.bar.prepend(btn("Primijeni označene", () => run(t.selectedIds()), "ghost"),
    btn("Primijeni sve", () => run(res.items.filter((x) => x.changed).map((x) => x.item_id)), "primary"));
  if (!ro) { const bs = [...d.bar.children]; d.bar.append(bs[2], bs[0], bs[1]); }
  load();
  await d.show();
}

class LotsPage extends Page {
  static title = "LOT-ovi i zalihe";
  static subtitle = "Svi primljeni LOT-ovi redom FIFO (najstariji prvi) · dvoklik = sljedivost";

  build() {
    this.tbtn("Sljedivost LOT-a", () => this.trace());
    this.tbtn("✎ Uredi LOT", () => this.editLot(), "ghost|rec");
    this.tbtn("🧾 Račun / cijena / alfa", () => this.invoice(), "ghost|rec");
    this.tbtn("Korekcija količine", () => this.adjust(), "ghost");
    this.tbtn("Otpis LOT-a", () => this.writeoff(), "ghost");
    this.tbtn("Izvoz CSV", () => this.table.exportCsv("lotovi"), "ghost");
    this.tbtn("🗑 Obriši LOT", () => this.del(), "ghost|more");
    this.tbtn("☑ Inventura", () => inventory(this.app), "ghost");
    this.all = tbSwitch(this, "Prikaži i potrošene", () => this.refresh());
    this.table = new Table([
      ["item", "Artikl", 230, "w"], ["lot", "LOT", 140, "w"], ["received", "Primljeno", 95, "center"],
      ["qty_r", "Primljeno kol.", 100, "e"], ["qty_l", "Preostalo", 90, "e"], ["unit", "Jed.", 50, "center"],
      ["expiry", "Rok", 95, "center"], ["days", "Dana do isteka", 105, "e"],
      ["supplier", "Dobavljač", 160, "w"], ["invoice", "Račun", 120, "w"], ["price", "Cijena €", 80, "e"], ["alpha", "Alfa %", 65, "e"],
      ["fifo", "FIFO", 60, "center"]], { onDouble: () => this.trace(), multi: true });
    this.search(this.table);
    this.content.append(this.table.el);
  }

  refresh() {
    const rows = [], order = {};
    const warn = parseInt(this.db.get_setting("warn_days"), 10) || 30;
    for (const l of this.db.lots(!this.all.checked)) {
      const dl = daysLeft(l.eff_expiry);
      const tag = l.qty_left <= EPS ? "muted" : (dl !== null && dl < 0 ? "bad" : (dl !== null && dl <= warn ? "warn" : ""));
      let fifo = "";
      if (l.qty_left > EPS && !(dl !== null && dl < 0)) {
        order[l.item_id] = (order[l.item_id] || 0) + 1;
        fifo = String(order[l.item_id]);
      }
      rows.push({ id: l.id, item: l.item_name, lot: l.lot_no, received: d2ui(l.received_date),
        qty_r: fq(l.qty_received), qty_l: fq(l.qty_left), unit: l.unit, expiry: d2ui(l.eff_expiry),
        days: dl === null ? "" : dl, supplier: l.supplier_name || "", invoice: l.invoice_no || "",
        price: l.unit_price ? fq(l.unit_price, 4) : "", alpha: l.alpha ? fq(l.alpha, 1) : "", fifo, _tag: tag });
    }
    this.table.setRows(rows);
  }

  trace() {
    const id = this.need(this.table, "LOT");
    if (!id) return;
    const l = this.db.lot(id);
    const rows = this.db.lot_trace(id).map((t, n) => ({ id: n, batch: t.batch_no, recipe: t.recipe, date: d2ui(t.brew_date),
      status: t.status, qty: fq(t.qty) }));
    return tableDialog(`Sljedivost LOT ${l.lot_no}`, [
      ["batch", "Šarža", 100, "w"], ["recipe", "Pivo", 200, "w"], ["date", "Kuhano", 100, "center"],
      ["status", "Status", 120, "w"], ["qty", `Utrošeno (${l.unit})`, 120, "e"]], rows,
    { info: `${l.item_name}  ·  LOT ${l.lot_no}  ·  primljeno ${d2ui(l.received_date)}  ·  ` +
        `rok ${d2ui(l.eff_expiry) || "—"}\nPrimljeno ${fq(l.qty_received)} ${l.unit}, preostalo ${fq(l.qty_left)} ${l.unit}`,
    width: 760 });
  }

  // broj LOT-a, datum primitka i rok (i za LOT-ove već korištene u kuhanju – sljedivost ide preko LOT-a, ne preko broja)
  async editLot() {
    const id = this.need(this.table, "LOT");
    if (!id) return;
    const l = this.db.lot(id);
    const used = this.db.val("SELECT COUNT(DISTINCT batch_id) FROM batch_consumption WHERE lot_id=?", [id]) || 0;
    const v = await askForm(`Uredi LOT – ${l.item_name}`, [
      { key: "info", label: "", type: "info", default: `${l.item_name} · primljeno ${fq(l.qty_received)} ${l.unit}, preostalo ${fq(l.qty_left)} ${l.unit}`
        + (used ? ` · korišten u ${used} šarž${used === 1 ? "i" : "e"} – novi broj vidjet će se i u sljedivosti i HACCP evidencijama` : "") },
      { key: "lot_no", label: "Broj LOT-a", required: true },
      { key: "received_date", label: "Datum primitka", type: "date", required: true },
      { key: "expiry_date", label: "Rok trajanja", type: "date" }],
    { lot_no: l.lot_no, received_date: l.received_date, expiry_date: l.expiry_date || "" });
    if (!v) return;
    let r;
    try { r = this.app.py.call("web_more.edit_lot", id, v); } catch (e) { return error(e); }
    toast(r.changed ? `LOT spremljen (${r.what.join("; ")}).` : "Nema promjena.");
    this.app.refreshAll();
  }

  // brisanje označenih LOT-ova; ako je LOT utrošen u šaržama, nakon brisanja Inventura ponovno raspodijeli utrošak po FIFO
  async del() {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Označite jedan ili više LOT-ova (Ctrl/Shift za više; na mobitelu dodirom).", "Brisanje LOT-a");
    const chk = this.app.py.call("web_more.lots_delete_check", ids);
    const list = chk.ok.map((l) => `• ${l.item} · LOT ${l.lot_no} · preostalo ${fq(l.qty_left)} ${l.unit}`
      + (l.batches.length ? ` · utrošen u: ${l.batches.join(", ")}` : "")).join("\n");
    const used = chk.used.length ? "\n\nPAŽNJA: dio LOT-ova utrošen je u šaržama. Te šarže ostat će bez tog utroška (sljedivost) dok ne pokrenete "
      + "Inventuru – ona utrošak ponovno raspodijeli po FIFO na preostale LOT-ove." : "";
    if (!(await confirm(`Obrisati ${chk.ok.length === 1 ? "LOT" : chk.ok.length + " LOT-ova"}?\n\n${list}\n\n`
      + "Briše se LOT i njegova kretanja na skladištu, pa se zaliha artikla smanji za preostalu količinu. Brisanje se ne može poništiti." + used,
    "Brisanje LOT-a", { danger: true, ok: "Obriši" }))) return;
    const r = this.app.py.call("web_more.delete_lots", ids);
    this.app.refreshAll();
    if (r.batches.length && await confirm(`Obrisano LOT-ova: ${r.deleted}. Šarže bez dijela utroška: ${r.batches.join(", ")}.\n\nPokrenuti Inventuru sada?`,
      "Brisanje LOT-a", { ok: "Pokreni inventuru", cancel: "Kasnije" })) await inventory(this.app);
    else toast(`Obrisano LOT-ova: ${r.deleted}.`);
  }

  // broj računa dobavljača i nabavna cijena (bez PDV-a) za jedan ili više označenih LOT-ova
  async invoice() {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Označite jedan ili više LOT-ova (Ctrl/Shift za više; na mobitelu dodirom).", "Račun");
    const l = this.db.lot(ids[0]);
    const d = await askForm(ids.length > 1 ? `Račun – ${ids.length} LOT-ova` : `Račun – LOT ${l.lot_no}`, [
      { key: "info", label: "Artikl", type: "info", default: ids.length > 1 ? `${ids.length} označenih LOT-ova` : `${l.item_name} · primljeno ${d2ui(l.received_date)}` },
      { key: "invoice_no", label: "Broj računa dobavljača" },
      ...(ids.length === 1 ? [{ key: "unit_price", label: "Cijena €/jed. (bez PDV-a)", type: "num", min: 0 }] : []),
      ...(ids.length === 1 && l.category === "Hmelj" ? [{ key: "alpha", label: "Alfa kiseline % (s deklaracije)", type: "num", min: 0 }] : [])],
    { invoice_no: l.invoice_no || "", unit_price: l.unit_price || 0, alpha: l.alpha || null });
    if (!d) return;
    this.app.py.call("web_costs.set_lot_invoice", ids, d.invoice_no || "", ids.length === 1 ? d.unit_price : null);
    if (ids.length === 1 && l.category === "Hmelj") this.app.py.call("web_more.set_lot_alpha", ids, d.alpha || null);
    this.refresh();
    toast("Račun spremljen.");
  }

  async adjust() {
    const id = this.need(this.table, "LOT");
    if (!id) return;
    const l = this.db.lot(id);
    const d = await askForm(`Korekcija – LOT ${l.lot_no}`, [
      { key: "info", label: "Artikl", type: "info", default: `${l.item_name} · trenutno ${fq(l.qty_left)} ${l.unit}` },
      { key: "qty", label: "Nova (stvarna) količina", type: "num", min: 0, required: true },
      { key: "note", label: "Razlog (inventura, rasip...)" }], { qty: l.qty_left });
    if (d) {
      try { this.db.adjust_lot(id, d.qty, d.note || "Inventura"); } catch (e) { return this.err(e); }
      this.app.refreshAll();
    }
  }

  async writeoff() {
    const id = this.need(this.table, "LOT");
    if (!id) return;
    const l = this.db.lot(id);
    if (await confirm(`Otpisati cijeli preostali LOT ${l.lot_no} (${fq(l.qty_left)} ${l.unit})?`, "Otpis")) {
      this.db.adjust_lot(id, 0, "Otpis (istek roka / oštećenje)", "OTPIS");
      this.app.refreshAll();
    }
  }
}

// ======================================================================== Kemikalije
class ChemicalsPage extends Page {
  static title = "Kemikalije";
  static subtitle = "Sredstva za čišćenje i dezinfekciju · rok trajanja i rok nakon otvaranja · oznake opasnosti";

  get items() { return this.app.page("items"); }

  build() {
    this.tbtn("＋ Nova kemikalija", () => this.items.new(true));
    this.tbtn("⬇ Primka", () => this.items.receive(this._item(), true));
    this.tbtn("Označi otvoreno", () => this.openLot(), "ghost|rec");
    this.tbtn("⬆ Izdavanje (FIFO)", () => this.items.issue(this._item(), true), "ghost|rec");
    this.tbtn("Otpis LOT-a", () => this.writeoff(), "ghost");
    this.tbtn("Sigurnosni list", () => this.sds(), "ghost|rec");
    this.tbtn("Uredi kemikaliju", () => { const i = this._item(); if (i) return this.items.edit(i); }, "ghost");
    this.table = new Table([
      ["name", "Kemikalija", 240, "w"], ["lot", "LOT", 120, "w"], ["qty", "Količina", 80, "e"],
      ["unit", "Jed.", 45, "center"], ["received", "Primljeno", 95, "center"], ["opened", "Otvoreno", 95, "center"],
      ["expiry", "Rok proizv.", 95, "center"], ["eff", "Vrijedi do", 95, "center"], ["days", "Dana", 60, "e"],
      ["state", "Stanje", 110, "w"], ["hazard", "Opasnosti", 180, "w"]]);
    this.search(this.table);
    this.content.append(this.table.el, h("div", { class: "muted", style: { fontSize: "12px" } },
      "„Vrijedi do“ = raniji od roka proizvođača i (datum otvaranja + rok nakon otvaranja). " +
      "Istekli LOT-ovi ne koriste se kod izdavanja."));
  }

  _item() {
    const id = this.table.selectedId();
    if (id === null || id === undefined) return null;
    if (typeof id === "string" && id.startsWith("i")) return parseInt(id.slice(1), 10);
    return this.db.lot(id).item_id;
  }

  refresh() {
    const warn = parseInt(this.db.get_setting("warn_days"), 10) || 30;
    const rows = [];
    const lots = this.db.lots(true, null, true);
    const withLots = new Set(lots.map((l) => l.item_id));
    for (const l of lots) {
      const dl = daysLeft(l.eff_expiry);
      let state = "OK", tag = "";
      if (dl !== null && dl < 0) { state = "ISTEKLO"; tag = "bad"; } else if (dl !== null && dl <= warn) { state = "Ističe uskoro"; tag = "warn"; }
      rows.push({ id: l.id, name: l.item_name, lot: l.lot_no, qty: fq(l.qty_left), unit: l.unit,
        received: d2ui(l.received_date), opened: d2ui(l.opened_date), expiry: d2ui(l.expiry_date), eff: d2ui(l.eff_expiry),
        days: dl === null ? "" : dl, state, hazard: l.hazard || "", _tag: tag });
    }
    for (const i of this.db.items(true)) {
      if (!withLots.has(i.id)) rows.push({ id: `i${i.id}`, name: i.name, lot: "—", qty: "0", unit: i.unit,
        state: "Nema zalihe", hazard: i.hazard || "", _tag: i.min_stock ? "bad" : "muted" });
    }
    this.table.setRows(rows);
  }

  async openLot() {
    const id = this.need(this.table, "LOT kemikalije");
    if (!id || typeof id === "string") return;
    const l = this.db.lot(id);
    const d = await askForm(`Otvaranje – ${l.item_name}`, [
      { key: "date", label: "Datum otvaranja", type: "date", required: true, default: today() }]);
    if (d) { this.db.open_lot(id, d.date); this.app.refreshAll(); }
  }

  async writeoff() {
    const id = this.need(this.table, "LOT kemikalije");
    if (!id || typeof id === "string") return;
    const l = this.db.lot(id);
    if (await confirm(`Otpisati LOT ${l.lot_no} (${fq(l.qty_left)} ${l.unit})?\n` +
        "Zbrinjavanje opasnog otpada evidentirajte prema propisima.", "Otpis")) {
      this.db.adjust_lot(id, 0, "Otpis kemikalije", "OTPIS");
      this.app.refreshAll();
    }
  }

  // Sigurnosni list: web nema putanje na disku – PDF se sprema uz podatke (preglednik + GitHub repozitorij)
  async sds() {
    const iid = this._item();
    if (!iid) return info("Odaberite kemikaliju.", "Odabir");
    const it = this.db.item(iid);
    const p = it.sds_path || "";
    if (/^https?:\/\//i.test(p)) { window.open(p, "_blank", "noopener"); return; }
    if (p.startsWith("sds/")) {
      let bytes = await store.localGet(p);
      if (!bytes && this.app.sync) bytes = await this.app.sync.getFile(p);
      if (bytes) { saveBlob(new Blob([bytes], { type: "application/pdf" }), `${it.name} - sigurnosni list.pdf`, true); return; }
    }
    const file = await new Promise((res) => {
      const inp = h("input", { type: "file", accept: ".pdf,application/pdf", style: { display: "none" } });
      inp.addEventListener("change", () => { res(inp.files[0] || null); inp.remove(); });
      document.body.append(inp);
      inp.click();
    });
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = `sds/${iid}.pdf`;
    await store.localPut(path, bytes);
    try { if (this.app.sync) await this.app.sync.putFile(path, bytes); } catch (e) { console.warn(e); }
    this.db.x("UPDATE items SET sds_path=? WHERE id=?", [path, iid]);
    this.app.toast("Sigurnosni list povezan.");
  }
}

// ======================================================================== Dobavljači
class SuppliersPage extends Page {
  static title = "Dobavljači";

  static FIELDS = [
    { key: "name", label: "Naziv", required: true }, { key: "oib", label: "OIB" },
    { key: "contact", label: "Kontakt osoba" }, { key: "phone", label: "Telefon" },
    { key: "email", label: "E-mail" }, { key: "address", label: "Adresa" },
    { key: "lead_days", label: "Uobičajeni rok isporuke (dana)", type: "num", default: 7, min: 0 },
    { key: "note", label: "Napomena" }];

  build() {
    this.tbtn("＋ Novi dobavljač", () => this.new());
    this.tbtn("Uredi", () => this.edit(), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.table = new Table([
      ["name", "Naziv", 220, "w"], ["oib", "OIB", 110, "w"], ["contact", "Kontakt osoba", 150, "w"],
      ["phone", "Telefon", 130, "w"], ["email", "E-mail", 200, "w"], ["address", "Adresa", 200, "w"],
      ["lead", "Rok isporuke (dana)", 130, "center"]], { onDouble: () => this.edit() });
    this.search(this.table);
    this.content.append(this.table.el);
  }

  refresh() {
    this.table.setRows(this.db.suppliers().map((s) => ({
      id: s.id, name: s.name, oib: s.oib || "", contact: s.contact || "", phone: s.phone || "",
      email: s.email || "", address: s.address || "", lead: fq(s.lead_days || 0) })));
  }

  async new() {
    const d = await askForm("Novi dobavljač", SuppliersPage.FIELDS, {}, { columns: 2 });
    if (d) { this.db.save_supplier(d); this.app.refreshAll(); }
  }

  async edit() {
    const id = this.need(this.table, "dobavljača");
    if (id === null) return;
    const d = await askForm("Uredi dobavljača", SuppliersPage.FIELDS, this.db.one("SELECT * FROM suppliers WHERE id=?", [id]), { columns: 2 });
    if (d) { this.db.save_supplier(d, id); this.app.refreshAll(); }
  }

  async delete() {
    const id = this.need(this.table, "dobavljača");
    if (id === null) return;
    if (await confirm("Obrisati dobavljača?", "Brisanje")) {
      try { this.db.delete_supplier(id); this.app.refreshAll(); } catch (e) { this.err(e); }
    }
  }
}

// ======================================================================== LinesDialog (ui.py): zaglavlje + stavke
export class LinesDialog extends Dialog {
  // itemOpts: [[label, item_id, unit, price]]; rezultat: [zaglavlje, stavke] ili null
  constructor(title, headerFields, headerInitial, itemOptsList, lines, { withPrice = false, qtyLabel = "Količina", width = 860 } = {}) {
    super(title, { width });
    this.itemOpts = itemOptsList; this.withPrice = withPrice;
    this.form = new Form(headerFields, headerInitial || {}, headerFields.length > 6 ? 3 : 2);
    this.body.append(this.form.el, h("div", { style: { fontWeight: 700, fontSize: "15px", margin: "12px 0 4px" } }, "Stavke"));
    this.cb = h("select", { style: { flex: "1 1 260px", minWidth: "200px" }, onchange: () => this._itemChanged() },
      h("option", { value: "" }, ""), itemOptsList.map((o, i) => h("option", { value: String(i) }, o[0])));
    this.qty = h("input", { placeholder: qtyLabel, inputmode: "decimal", style: { width: "110px" } });
    this.qty.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this._add(); } });
    this.price = null;
    const add = h("div", { class: "card row gap", style: { padding: "8px", gap: "8px", marginBottom: "6px" } }, this.cb, this.qty);
    if (withPrice) {
      this.price = h("input", { placeholder: "Cijena €/jed.", inputmode: "decimal", style: { width: "110px" } });
      this.price.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this._add(); } });
      add.append(this.price);
    }
    add.append(btn("+ Dodaj", () => this._add()), h("span", { style: { flex: "1" } }), btn("Ukloni odabrano", () => this._remove(), "ghost"));
    this.body.append(add);
    const cols = [["name", "Artikl", 320, "w"], ["qty", qtyLabel, 110, "e"], ["unit", "Jed.", 60, "center"]];
    if (withPrice) cols.push(["price", "Cijena", 100, "e"], ["total", "Iznos", 110, "e"]);
    this.table = new Table(cols, { height: 8 });
    this.body.append(this.table.el);
    this.lines = (lines || []).map((ln) => ({ ...ln }));
    this._refresh();
    this.buttons("Spremi", () => this._ok());
  }
  _opt() { return this.cb.value === "" ? null : this.itemOpts[+this.cb.value]; }
  _itemChanged() {
    const o = this._opt();
    if (this.price && o) this.price.value = fin(o[3] || 0);
    this.qty.focus();
  }
  _refresh() {
    const units = new Map(this.itemOpts.map((o) => [o[1], [o[0], o[2]]]));
    this.table.setRows(this.lines.map((ln, n) => {
      const [name, unit] = units.get(ln.item_id) || [ln.name || "?", ln.unit || ""];
      const i = name.lastIndexOf(" (");
      const r = { id: n, name: i > 0 && units.has(ln.item_id) ? name.slice(0, i) : name, qty: fq(ln.qty), unit };
      if (this.withPrice) { r.price = fq(ln.unit_price || 0, 4); r.total = money(ln.qty * (ln.unit_price || 0)); }
      return r;
    }));
  }
  _add() {
    const opt = this._opt();
    let q, p;
    try { q = num(this.qty.value); p = this.price ? num(this.price.value) : 0; } catch { return this.err("Količina i cijena moraju biti brojevi."); }
    if (!opt || q <= 0) return this.err("Odaberite artikl i upišite količinu > 0.");
    this.err("");
    const ex = this.lines.find((ln) => ln.item_id === opt[1]);
    if (ex) { ex.qty = q; ex.unit_price = p; } else this.lines.push({ item_id: opt[1], qty: q, unit_price: p });
    this.qty.value = ""; this.cb.value = "";
    this._refresh();
  }
  _remove() {
    const sel = this.table.selectedId();
    if (sel !== null) { this.lines.splice(+sel, 1); this._refresh(); }
  }
  _ok() {
    let head;
    try { head = this.form.get(); } catch (e) { return this.err(e.message); }
    if (!this.lines.length) return this.err("Dodajte barem jednu stavku.");
    this.close([head, this.lines]);
  }
}

// ======================================================================== Zaprimanje narudžbenice
class ReceivePODialog extends Dialog {
  constructor(db, poId) {
    super("Zaprimanje narudžbenice", { width: 900 });
    this.db = db; this.poId = poId;
    const p = db.po(poId);
    this.body.append(h("div", { style: { marginBottom: "8px" } },
      `${p.po_no} · ${p.supplier_name || ""}  —  upišite zaprimljene količine, LOT brojeve s deklaracije i rokove trajanja.`));
    this.date = h("input", { type: "date", value: today() });
    this.inv = h("input", { placeholder: "npr. 2026-03125", style: { width: "170px" } });
    this.haccp = h("input", { type: "checkbox" }); this.haccp.checked = true;
    this.body.append(h("div", { class: "row gap", style: { gap: "8px", justifyContent: "space-between", marginBottom: "8px", flexWrap: "wrap" } },
      h("label", { class: "row", style: { gap: "8px" } }, "Datum primitka:", this.date),
      h("label", { class: "row", style: { gap: "8px" } }, "Broj računa:", this.inv),
      h("label", { class: "chk" }, this.haccp, " Odmah ispuni HACCP zapisnike o prijemu")));
    const heads = ["Artikl", "Naručeno", "Već zaprimljeno", "Zaprimam sad", "LOT broj", "Rok trajanja", "Alfa %"];
    const tbody = h("tbody");
    this.rows = [];
    for (const ln of db.po_lines(poId)) {
      const rem = Math.max(ln.qty - ln.qty_received, 0);
      const q = h("input", { inputmode: "decimal", style: { width: "90px" } }); q.value = fin(rem);
      const lot = h("input", { placeholder: "auto", style: { width: "130px" } });
      const exp = h("input", { type: "date", style: { width: "150px" } });
      const isHop = (db.item(ln.item_id) || {}).category === "Hmelj";
      const al = h("input", { inputmode: "decimal", placeholder: isHop ? "npr. 4,1" : "—", disabled: !isHop, style: { width: "80px" } });
      tbody.append(h("tr", {}, h("td", { style: { whiteSpace: "normal", minWidth: "160px" } }, `${ln.name} (${ln.unit})`), h("td", { class: "al-e" }, fq(ln.qty)),
        h("td", { class: "al-e" }, fq(ln.qty_received)), h("td", {}, q), h("td", {}, lot), h("td", {}, exp), h("td", {}, al)));
      this.rows.push([ln.id, q, lot, exp, al]);
    }
    const tbl = h("table", { class: "grid recv", style: { tableLayout: "auto" } }, h("thead", {}, h("tr", {}, heads.map((x, i) =>
      h("th", { class: i === 1 || i === 2 ? "al-e" : "al-w" }, x)))), tbody);
    this.body.append(h("div", { class: "table-wrap", style: { maxHeight: "50vh" } }, tbl));
    this.buttons("Zaprimi na skladište", () => this._ok());
  }
  _ok() {
    let lots;
    try {
      const date = this.date.value || today();
      const rc = this.rows.map(([lid, q, lot, exp]) => ({ line_id: lid, qty: num(q.value), lot_no: lot.value.trim() || null, expiry: exp.value || null }));
      if (!rc.some((r) => r.qty > 0)) throw new Error("Nema količina za zaprimanje.");
      const alphas = this.rows.filter(([, q]) => num(q.value) > 0).map((r) => r[4].value.trim() ? num(r[4].value) : null);
      lots = this.db.receive_po(this.poId, rc, date);
      lots.forEach((lid, i) => { if (alphas[i]) window.APP.py.call("web_more.set_lot_alpha", [lid], alphas[i]); });
      if (this.inv.value.trim() && lots.length) window.APP.py.call("web_costs.set_lot_invoice", lots, this.inv.value.trim());
    } catch (e) { return this.err(e.message); }
    this.close(this.haccp.checked ? lots : true);
  }
}

// ======================================================================== Narudžbenice
class POPage extends Page {
  static title = "Narudžbenice";
  static subtitle = "Nacrt → Poslano → Zaprimljeno (zaprimanje automatski kreira LOT-ove na skladištu)";

  build() {
    this.tbtn("＋ Nova narudžbenica", () => this.new());
    this.tbtn("Uredi", () => this.edit(), "ghost");
    this.tbtn("✉ Označi poslano", () => this.setStatus("Poslano"), "ghost");
    this.tbtn("⬇ Zaprimi robu", () => this.receive());
    this.tbtn("🖨 Ispis / PDF", () => this.printPo(), "ghost");
    this.tbtn("Otkaži", () => this.setStatus("Otkazano"), "ghost");
    this.tbtn("Obriši", () => this.delete(), "ghost");
    this.table = new Table([
      ["no", "Broj", 130, "w"], ["supplier", "Dobavljač", 220, "w"], ["date", "Datum", 100, "center"],
      ["exp", "Očekivano", 100, "center"], ["n", "Stavki", 60, "center"], ["total", "Iznos", 120, "e"],
      ["status", "Status", 110, "w"], ["note", "Napomena", 260, "w"]], { onDouble: () => this.edit(), onSelect: () => this.showLines() });
    this.table.el.style.maxHeight = "calc(60vh - 120px)";
    this.lines = new Table([["name", "Artikl", 260, "w"], ["qty", "Naručeno", 100, "e"],
      ["rec", "Zaprimljeno", 100, "e"], ["unit", "Jed.", 60, "center"],
      ["price", "Cijena", 100, "e"], ["total", "Iznos", 120, "e"]], { height: 5 });
    this.search(this.table);
    this.content.append(this.table.el, this.lines.el);
  }

  refresh() {
    const t = today();
    this.table.setRows(this.db.pos().map((p) => {
      const late = ["Poslano", "Djelomično"].includes(p.status) && p.expected_date && p.expected_date < t;
      return { id: p.id, no: p.po_no, supplier: p.supplier_name || "", date: d2ui(p.order_date), exp: d2ui(p.expected_date),
        n: p.n_lines, total: money(p.total), status: p.status + (late ? " (kasni)" : ""), note: p.note || "",
        _tag: late ? "bad" : ({ Nacrt: "", Poslano: "warn", "Djelomično": "warn", Zaprimljeno: "ok", Otkazano: "muted" }[p.status] || "") };
    }));
    this.showLines();
  }

  showLines() {
    const id = this.table.selectedId();
    this.lines.setRows((id ? this.db.po_lines(id) : []).map((l) => ({ id: l.id, name: l.name, qty: fq(l.qty), rec: fq(l.qty_received),
      unit: l.unit, price: fq(l.unit_price, 4), total: money(l.qty * l.unit_price), _tag: l.qty_received >= l.qty - EPS ? "ok" : "" })));
  }

  _dialog(title, head = null, lines = []) {
    return new LinesDialog(title, [
      { key: "supplier_id", label: "Dobavljač", type: "combo", options: supplierOpts(this.db).slice(1), required: true },
      { key: "order_date", label: "Datum narudžbe", type: "date", default: today() },
      { key: "expected_date", label: "Očekivana isporuka", type: "date" },
      { key: "note", label: "Napomena" }], head || {}, itemOpts(this.db), lines, { withPrice: true }).show();
  }

  async new() {
    const res = await this._dialog("Nova narudžbenica");
    if (res) {
      res[0].status = "Nacrt";
      res[0].order_date = res[0].order_date || today();
      this.db.save_po(res[0], res[1]);
      this.app.refreshAll();
    }
  }

  async edit() {
    const id = this.need(this.table, "narudžbenicu");
    if (!id) return;
    const p = this.db.po(id);
    if (!["Nacrt", "Poslano"].includes(p.status))
      return info("Mogu se uređivati samo narudžbenice u statusu Nacrt ili Poslano.", "Uređivanje");
    const res = await this._dialog(`Narudžbenica ${p.po_no}`, p, this.db.po_lines(id));
    if (res) { this.db.save_po(res[0], res[1], id); this.app.refreshAll(); }
  }

  setStatus(status) {
    const id = this.need(this.table, "narudžbenicu");
    if (id) { this.db.set_po_status(id, status); this.app.refreshAll(); }
  }

  async receive() {
    const id = this.need(this.table, "narudžbenicu");
    if (!id) return;
    if (["Zaprimljeno", "Otkazano"].includes(this.db.po(id).status))
      return info("Narudžbenica je već zaprimljena ili otkazana.", "Zaprimanje");
    const res = await new ReceivePODialog(this.db, id).show();
    if (!res) return;
    this.app.refreshAll();
    this.app.toast("Roba zaprimljena – LOT-ovi kreirani.");
    if (Array.isArray(res)) {
      for (const lotId of res) {
        if (!this.db.lot(lotId).is_chemical) {
          const r = await editReceipt(this.app, this.db.receipt_defaults(lotId));
          if ((r === null || r === undefined) && !(await confirm("Nastaviti sa zapisnicima za ostale stavke?", "Prijem"))) break;
        }
      }
      this.app.refreshAll();
    }
  }

  async delete() {
    const id = this.need(this.table, "narudžbenicu");
    if (id && await confirm("Obrisati narudžbenicu?", "Brisanje")) {
      try { this.db.delete_po(id); this.app.refreshAll(); } catch (e) { this.err(e); }
    }
  }

  // Desktop: HTML s gumbom "Ispis / Spremi PDF". Web: isti HTML ili PDF/Word dokument.
  async printPo() {
    const id = this.need(this.table, "narudžbenicu");
    if (!id) return;
    const d = new Dialog("Ispis narudžbenice", { width: 480 });
    d.body.append(h("div", { class: "msg" }, "Odaberite oblik ispisa:"));
    d.bar.append(btn("Odustani", () => d.close(null), "ghost"), btn("Word", () => d.close("WORD"), "ghost"),
      btn("PDF", () => d.close("PDF"), "ghost"), btn("🖨 Ispis (stranica)", () => d.close("HTML")));
    const fmtSel = await d.show();
    if (!fmtSel) return;
    if (fmtSel === "HTML") {
      const path = this.app.py.call("web_main.po_html", id);
      const blob = new Blob([this.app.py.readFile(path)], { type: "text/html" });
      saveBlob(blob, path.split("/").pop(), true);
    } else await this.app.doc("web_main.po_doc", id, fmtSel);
  }
}

// ======================================================================== Što trebam naručiti
class ReorderPage extends Page {
  static title = "Što trebam naručiti";
  static flat = true;
  static subtitle = "Prijedlog = minimum + planirana kuhanja − (zaliha + već naručeno), zaokruženo na pakiranje. " +
    "Istekli LOT-ovi se ne računaju.";

  build() {
    this.tbtn("↻ Osvježi", () => this.refresh(), "ghost");
    this.tbtn("🛒 Izradi narudžbenice (nacrt)", () => this.create());
    this.tbtn("Izvoz CSV", () => this.table.exportCsv("sto_naruciti"), "ghost");
    this.all = tbSwitch(this, "Prikaži sve artikle", () => this.refresh());
    this.table = new Table([
      ["supplier", "Dobavljač", 170, "w"], ["name", "Artikl", 230, "w"], ["stock", "Zaliha", 80, "e"],
      ["on_order", "Naručeno", 80, "e"], ["planned", "Planirano kuhanje", 120, "e"], ["min", "Minimum", 80, "e"],
      ["proj", "Projekcija", 90, "e"], ["suggest", "NARUČITI", 90, "e"], ["unit", "Jed.", 50, "center"],
      ["value", "Proc. iznos", 110, "e"], ["note", "Napomena", 160, "w"]], { multi: true });
    this.search(this.table);
    this.total = h("div", { style: { textAlign: "right", fontWeight: 700, fontSize: "14px" } });
    this.content.append(this.table.el, this.total);
  }

  refresh() {
    this.data = this.db.reorder_report(!this.all.checked);
    const rows = [];
    let tot = 0;
    const sorted = [...this.data].sort((a, b) => {
      const ka = (a.supplier_name || "zzz"), kb = (b.supplier_name || "zzz");
      return ka < kb ? -1 : ka > kb ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    for (const r of sorted) {
      const v = r.suggest * r.price;
      tot += v;
      const note = [];
      if (r.expired) note.push(`isteklo ${fq(r.expired)}`);
      if (!r.supplier_id) note.push("nema dobavljača!");
      rows.push({ id: r.item_id, supplier: r.supplier_name || "—", name: r.name, stock: fq(r.stock),
        on_order: r.on_order ? fq(r.on_order) : "", planned: r.planned ? fq(r.planned) : "", min: fq(r.min_stock),
        proj: fq(r.projected), suggest: r.suggest ? fq(r.suggest) : "", unit: r.unit, value: v ? money(v) : "",
        note: note.join(", "),
        _tag: r.suggest > EPS && r.projected >= 0 ? "bold" : (r.suggest > EPS ? "bad" : "muted") });
    }
    this.table.setRows(rows);
    const n = this.data.filter((r) => r.suggest > EPS).length;
    this.total.textContent = `Za naručiti: ${n} artikala  ·  procijenjeno ${money(tot)}`;
  }

  async create() {
    const sel = new Set(this.table.selectedIds().map(String));
    const rows = this.data.filter((r) => r.suggest > EPS && (!sel.size || sel.has(String(r.item_id))));
    if (!rows.length) return info("Nema stavki za naručiti.", "Narudžbe");
    const nosup = rows.filter((r) => !r.supplier_id).map((r) => r.name);
    let msg = `Izraditi narudžbenice (nacrt) za ${rows.length} stavki${sel.size ? " (samo odabrane)" : ""}, grupirano po dobavljaču?`;
    if (nosup.length) msg += "\n\nPreskočit će se (nemaju dobavljača): " + nosup.join(", ");
    if (await confirm(msg, "Narudžbe")) {
      const ids = this.db.create_pos_from_report(rows);
      this.app.refreshAll();
      this.app.toast(`Izrađeno ${ids.length} narudžbenica – provjerite ih pod 'Narudžbenice'.`);
      this.app.show("po");
    }
  }
}

export const PAGES = { dash: DashboardPage, items: ItemsPage, lots: LotsPage, chem: ChemicalsPage,
  reorder: ReorderPage, po: POPage, suppliers: SuppliersPage };
export { MonthBars, HBars, Donut, ChartCard };
