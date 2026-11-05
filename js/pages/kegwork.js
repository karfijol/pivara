// Rad s kegovima (za mobitel): istakanje, pranje, punjenje, otprema, povrat – skeniranjem QR koda ili upisom broja.
import { h, btn, Page, Table, Dialog, Form, askForm, confirm, choice, info, error, toast, fq, d2ui, today, num } from "../ui.js";
import { Scanner, beep } from "../scanner.js";
import { qrSvg } from "../qr.js";

const FLOWS = [
  ["tap", "🍺", "Istočeno u pivnici", "Pun → prazan (prljav)", "#E3A12B"],
  ["wash", "🧼", "Pranje", "Prljav → čist", "#4F9DDE"],
  ["fill", "⬇", "Punjenje (istakanje)", "Čist → pun · 17 L po kegu", "#5BBF7A"],
  ["ship", "🚚", "Otprema", "Pun (17 L) → kod kupca + otpremnica", "#A57BD6"],
  ["return", "↩", "Povrat od kupca", "Kod kupca → prljav", "#E0675A"],
];
const STATUS_COLORS = { "Pun": "#E3A12B", "Prljav": "#B9864A", "Čist": "#5BBF7A", "Kod kupca": "#4F9DDE",
  "Servis": "#E0675A", "Otpisan": "#8A8F98" };

function ls(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
  return null;
}
export function deviceUser(app) {
  return ls("pivovara_user") || app.db.get_setting("default_operator") || "";
}
function badge(status) {
  return h("span", { class: "badge", style: { background: STATUS_COLORS[status] || "#8A8F98" } }, status);
}

// ------------------------------------------------------------------ detalji kega
export async function kegDetail(app, kegId) {
  const py = app.py;
  let d;
  try { d = py.call("web_kegs.keg_detail", kegId); } catch (e) { return error(e); }
  const k = d.keg;
  const dlg = new Dialog(`Keg ${k.code}`, { width: 860 });
  const facts = [
    ["Status", badge(k.status)], ["Volumen", `${fq(k.size_l)} L`],
    ["Piva u kegu", k.fill_l ? `${fq(k.fill_l, 2)} L` : "—"], ["Tip", k.keg_type || "—"],
    ["Pivo", k.beer || "—"], ["LOT", k.batch_no || "—"], ["Punjeno", d2ui(k.filled_date) || "—"],
    ["Kupac", k.customer || "—"], ["Zadnja promjena", d2ui(k.status_date) || "—"], ["Broj punjenja", String(d.fills)],
    ["Napomena", k.note || "—"]];
  const qrBox = h("div", { class: "qr-box" });
  qrSvg(k.code, 132).then((svg) => qrBox.append(svg, h("div", { class: "qr-code" }, k.code))).catch(() => {});
  dlg.body.append(h("div", { class: "row gap", style: { alignItems: "flex-start", flexWrap: "wrap" } }, qrBox,
    h("div", { class: "facts", style: { flex: "1", minWidth: "240px" } }, facts.map(([a, b]) => h("div", { class: "fact" }, h("span", { class: "muted" }, a), h("b", {}, b))))));
  dlg.body.append(h("h4", {}, "Povijest"));
  const t = new Table([["ts", "Vrijeme", 130, "w"], ["action", "Radnja", 150, "w"], ["status", "Status", 100, "w"],
    ["lot", "LOT", 120, "w"], ["customer", "Kupac", 150, "w"], ["note", "Napomena", 200, "w"]], { height: 8 });
  t.setRows(d.log.map((g, i) => ({ id: i, ts: d2ui(g.ts.slice(0, 10)) + g.ts.slice(10), action: g.action, status: g.status,
    lot: g.batch_no || "", customer: g.customer || "", note: g.note || "" })));
  dlg.body.append(t.el);
  if (d.services.length) {
    dlg.body.append(h("h4", {}, "Servisni pregledi"));
    const st = new Table([["date", "Datum", 100, "center"], ["ok", "Rezultat", 100, "w"], ["bad", "Neispravno", 330, "w"],
      ["by", "Pregledao", 140, "w"], ["note", "Napomena", 200, "w"]], { height: 5 });
    st.setRows(d.services.map((s) => ({ id: s.id, date: d2ui(s.date), ok: s.ok ? "✔ ispravan" : "✖ neispravan",
      bad: Object.entries(s.items || {}).filter(([, v]) => v !== "DA").map(([a]) => a).join(", "), by: s.by || "",
      note: s.note || "", _tag: s.ok ? "ok" : "bad" })));
    dlg.body.append(st.el);
  }
  dlg.bar.append(btn("🔳 QR naljepnica", () => app.doc("web_kegs.qr_sheet", [k.code]), "ghost"));
  dlg.bar.append(btn("🏷 Nova oznaka", async () => {
    const r = await askForm(`Nova oznaka za ${k.code}`, [{ key: "code", label: "Oznaka s QR naljepnice (npr. Keg-023) – upišite ili skenirajte", required: true }],
      {}, { okText: "Spremi" });
    if (r) { try { app.py.call("web_kegs.assign_code", kegId, r.code); toast("Oznaka promijenjena."); dlg.close("changed"); } catch (e) { error(e); } }
  }, "ghost"));
  dlg.bar.append(btn("✎ Napomena", async () => {
    const r = await askForm(`Napomena – ${k.code}`, [{ key: "note", label: "Napomena", type: "multi" }], { note: k.note });
    if (r) { py.call("web_kegs.set_note", kegId, r.note); dlg.close("changed"); }
  }, "ghost"));
  dlg.bar.append(btn("🛠 Servisni pregled", async () => { if (await serviceDialog(app, kegId)) dlg.close("changed"); }, "ghost"));
  dlg.bar.append(btn("Zatvori", () => dlg.close(null), "primary"));
  return dlg.show();
}

export async function serviceDialog(app, kegId) {
  const py = app.py;
  const k = app.db.one("SELECT * FROM kegs WHERE id=?", [kegId]);
  const items = py.call("web_kegs.consts").service_items;
  const fields = [{ type: "section", label: `Kontrolna lista – ${k.code} (status: ${k.status})` }];
  items.forEach((it, i) => fields.push({ key: "i" + i, label: it, type: "combo", options: ["DA", "NE"], default: "DA" }));
  fields.push(
    { key: "after", label: "Nakon pregleda", type: "combo", full: true, default: "auto",
      options: [["Automatski: ako je nešto NE → keg ide na servis", "auto"], ["Servis završen → keg je čist", "Očisti"],
        ["Pošalji na servis", "Na servis"], ["Bez promjene statusa", "none"]] },
    { key: "date", label: "Datum", type: "date", default: today() },
    { key: "by", label: "Pregledao", default: deviceUser(app) },
    { key: "note", label: "Napomena (što je popravljeno / zamijenjeno)", type: "multi", full: true });
  const d = await askForm("Servisni pregled kega", fields, {}, { columns: 2, okText: "Spremi pregled" });
  if (!d) return false;
  const res = {};
  items.forEach((it, i) => { res[it] = d["i" + i] || "DA"; });
  const to = d.after === "auto" ? null : d.after === "none" ? "" : d.after;
  try {
    const ok = py.callKw("web_kegs.save_service", [kegId, res], { by: d.by, note: d.note, date: d.date, to_status: to });
    toast(ok ? `Keg ${k.code}: pregled spremljen – ispravan.` : `Keg ${k.code}: neispravan – označen za servis.`);
    return true;
  } catch (e) { error(e); return false; }
}

async function newCustomer(app) {
  const d = await askForm("Novi kupac", [
    { key: "customer_type", label: "Vrsta kupca", type: "combo", options: ["Pravna osoba", "Fizička osoba"], default: "Pravna osoba" },
    { key: "name", label: "Naziv / ime i prezime", required: true }, { key: "oib", label: "OIB" },
    { key: "address", label: "Adresa (ulica i broj)" }, { key: "postal_code", label: "Poštanski broj" },
    { key: "city", label: "Mjesto" }, { key: "contact", label: "Kontakt osoba" }, { key: "phone", label: "Telefon" },
    { key: "email", label: "E-mail" }], {}, {
    columns: 2, validate: (x) => { if (x.oib && !/^\d{11}$/.test(x.oib.trim())) throw new Error("OIB mora imati točno 11 znamenki."); } });
  if (!d) return null;
  return app.py.call("web_kegs.save_customer", d);
}

// ------------------------------------------------------------------ QR oznake (Keg-001 … Keg-150)
const SIZES = [["18 L", 18], ["20 L", 20], ["30 L", 30], ["50 L", 50]];

// Skeniran / upisan keg koji ne postoji u programu -> dodaj novi ili dodijeli oznaku postojećem
export async function unknownKeg(app, text) {
  let code = String(text || "").trim();
  const m = code.match(/KEG:([^;]+)/i);
  if (m) code = m[1].trim();
  if (!code || code.length > 30) return null;
  const st = app.py.call("web_kegs.qr_status", 1, 1);
  const other = st.other.filter((k) => k.status !== "Otpisan");
  const d = new Dialog(`Keg ${code} nije u programu`, { width: 560 });
  d.body.append(h("div", { class: "msg" }, `Oznaka „${code}” još nije dodijeljena nijednom kegu. Što je ovo?`));
  const f = new Form([
    { key: "what", label: "", type: "combo", full: true, default: "new",
      options: [["Novi keg s tom oznakom", "new"], ...(other.length ? [["Postojeći keg iz programa (stara oznaka)", "old"]] : [])] },
    { key: "size_l", label: "Volumen (novi keg)", type: "combo", options: SIZES, default: 18 },
    { key: "keg_type", label: "Tip (neobavezno)" },
    ...(other.length ? [{ key: "keg_id", label: "Postojeći keg (dobit će novu oznaku, povijest ostaje)", type: "combo", full: true,
      options: other.map((k) => [`${k.code} · ${k.size_l} L · ${k.status}`, k.id]) }] : [])], {}, 2);
  d.body.append(f.el);
  d.buttons("Spremi", () => {
    try {
      const v = f.get();
      if (v.what === "old") {
        if (!v.keg_id) throw new Error("Odaberite postojeći keg.");
        app.py.call("web_kegs.assign_code", v.keg_id, code);
      } else app.py.call("web_kegs.qr_add_kegs", [code], v.size_l || 18, v.keg_type || null);
      d.close(code);
    } catch (e) { d.err(e.message); }
  });
  return d.show();
}

export async function qrManager(app) {
  const py = app.py;
  const d = new Dialog("QR oznake kegova", { width: 880 });
  const form = new Form([
    { key: "start", label: "Od broja", type: "num", default: 1, min: 1 },
    { key: "end", label: "Do broja", type: "num", default: 150, min: 1 },
    { key: "prefix", label: "Oznaka počinje s", default: "Keg-" },
    { key: "digits", label: "Znamenki u broju", type: "num", default: 3, min: 1 }], {}, 4);
  const stat = h("div", { class: "banner ok", style: { margin: "6px 0 10px" } });
  const t = new Table([["code", "Oznaka u programu", 140, "w"], ["size", "L", 60, "e"], ["status", "Status", 100, "w"]], { multi: true, height: 7 });
  const rng = () => {
    const v = form.get();
    if (v.end < v.start) throw new Error("'Do broja' mora biti veći od 'Od broja'.");
    if (v.end - v.start > 2000) throw new Error("Najviše 2000 oznaka odjednom.");
    return v;
  };
  const codesOf = (v) => Array.from({ length: Math.round(v.end - v.start) + 1 }, (_, i) =>
    `${v.prefix}${String(Math.round(v.start) + i).padStart(Math.round(v.digits), "0")}`);
  let st = null;
  const load = () => {
    try {
      const v = rng();
      st = py.call("web_kegs.qr_status", v.start, v.end, v.prefix, v.digits);
      stat.textContent = `Raspon ${codesOf(v)[0]} – ${codesOf(v).slice(-1)[0]}: u programu ${st.used.length}, još nedodijeljeno ${st.free.length}. ` +
        `Kegova sa starim oznakama: ${st.other.length}.`;
      t.setRows(st.other.map((k) => ({ id: k.id, code: k.code, size: fq(k.size_l), status: k.status })));
      d.err("");
    } catch (e) { d.err(e.message); }
  };
  form.el.addEventListener("change", load);
  const size = new Form([{ key: "size_l", label: "Volumen novih kegova", type: "combo", options: SIZES, default: 18 },
    { key: "keg_type", label: "Tip (neobavezno)" }], {}, 2);
  d.body.append(h("div", { class: "muted" }, "Oznake s vaših QR naljepnica (QR kod sadrži samo oznaku, npr. „Keg-023”). " +
    "Skeniranjem naljepnice program pronalazi keg u Radu s kegovima."), form.el, stat,
  h("div", { class: "card" }, h("h3", {}, "1. Novi kegovi"), size.el, h("div", { class: "row gap", style: { marginTop: "8px" } },
    btn("＋ Dodaj sve nedodijeljene oznake kao nove kegove", async () => {
      if (!st || !st.free.length) return info("Sve oznake iz raspona već su u programu.");
      const sv = size.get();
      if (!(await confirm(`Dodati ${st.free.length} novih kegova (${st.free[0]} … ${st.free.slice(-1)[0]}), ${sv.size_l} L, status Čist?`, "Novi kegovi"))) return;
      const added = py.call("web_kegs.qr_add_kegs", st.free, sv.size_l || 18, sv.keg_type || null);
      toast(`Dodano ${added.length} kegova.`); load();
    }))),
  h("div", { class: "card" }, h("h3", {}, "2. Postojeći kegovi sa starim oznakama"),
    h("div", { class: "muted", style: { fontSize: "12.5px", marginBottom: "6px" } }, "Najlakše: u Radu s kegovima skenirajte novu naljepnicu na kegu i odaberite „Postojeći keg”. Ili ovdje označite kegove i dodijelite im oznake redom."),
    t.el, h("div", { class: "row gap", style: { marginTop: "8px" } },
      btn("Dodijeli označenima prve slobodne oznake", async () => {
        const ids = t.selectedIds();
        if (!ids.length) return info("Označite kegove u tablici (Ctrl/Shift, na mobitelu dodirom).");
        if (!st.free.length) return info("Nema slobodnih oznaka u rasponu.");
        const rows = t.view.filter((r) => ids.map(String).includes(String(r.id)));
        const pairs = rows.slice(0, st.free.length).map((r, i) => [r.id, r.code, st.free[i]]);
        if (!(await confirm(pairs.map(([, a, b]) => `${a} → ${b}`).join("\n"), "Nove oznake"))) return;
        try { for (const [id, , c] of pairs) py.call("web_kegs.assign_code", id, c); toast(`Promijenjeno ${pairs.length} oznaka.`); } catch (e) { error(e); }
        load();
      }, "ghost"))),
  h("div", { class: "card" }, h("h3", {}, "3. Ispis QR naljepnica"),
    h("div", { class: "muted", style: { fontSize: "12.5px" } }, "A4, 5 × 7 naljepnica (40 × 40 mm), isti QR sadržaj kao na vašem PDF-u. Za zamjenu oštećene naljepnice ili nove kegove."),
    h("div", { class: "row gap", style: { marginTop: "8px" } },
      btn("🖨 Ispiši cijeli raspon", () => { try { app.doc("web_kegs.qr_sheet", codesOf(rng())); } catch (e) { error(e); } }),
      btn("🖨 Samo nedodijeljene", () => { if (st && st.free.length) app.doc("web_kegs.qr_sheet", st.free); else info("Nema nedodijeljenih oznaka."); }, "ghost"))));
  d.buttons(null, null, "Zatvori");
  load();
  await d.show();
  app.refreshAll();
}

// ------------------------------------------------------------------ stranica
class KegWorkPage extends Page {
  static title = "Rad s kegovima";
  static subtitle = "Skenirajte QR kod s naljepnice ili upišite broj kega · napravljeno za mobitel";

  build() {
    this.consts = this.app.py.call("web_kegs.consts");
    this.flow = null;
    this.tbtn("🔍 Pronađi keg", () => this.findKeg(), "ghost");
    this.tbtn("🛠 Servis kega", () => this.findKeg("service"), "ghost");
    if (!this.app.user || this.app.user.role !== "kegovi") this.tbtn("🔳 QR oznake", () => qrManager(this.app), "ghost");
    this.home = h("div", { class: "content" });
    this.work = h("div", { class: "content hidden" });
    this.content.append(this.home, this.work);
    // početni zaslon
    this.counts = h("div", { class: "cards kw-counts" });
    this.tiles = h("div", { class: "tiles" }, FLOWS.map(([key, ico, name, sub, col]) =>
      h("button", { class: "tile", type: "button", style: { borderTopColor: col }, onclick: () => this.open(key) },
        h("span", { class: "tile-ico" }, ico), h("span", { class: "tile-name" }, name), h("span", { class: "tile-sub" }, sub),
        h("span", { class: "tile-cart", "data-flow": key }))));
    this.stockT = new Table([["beer", "Pivo", 160, "w"], ["lot", "LOT", 130, "w"], ["kegs", "Kegova", 70, "center"],
      ["litres", "Litara", 80, "e"], ["oldest", "Najstarije punjenje", 130, "center"]], { height: 8 });
    this.seg = h("div", { class: "seg" });
    this.listFilter = "Pun";
    for (const s of ["Pun", "Prljav", "Čist", "Kod kupca", "Servis", "Sve"]) {
      const b = h("button", { type: "button", class: s === this.listFilter ? "on" : "" }, s === "Prljav" ? "Prazni (prljavi)" : s);
      b.onclick = () => { this.listFilter = s; this.seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); this.renderList(); };
      this.seg.append(b);
    }
    this.listT = new Table([["code", "Keg", 90, "w"], ["status", "Status", 90, "w"], ["beer", "Pivo", 140, "w"],
      ["lot", "LOT", 120, "w"], ["filled", "Punjeno", 95, "center"], ["customer", "Kupac", 150, "w"]],
    { onDouble: (id) => this.detail(id), height: 12 });
    this.recentT = new Table([["ts", "Vrijeme", 120, "w"], ["code", "Keg", 80, "w"], ["action", "Radnja", 150, "w"],
      ["status", "Novi status", 90, "w"], ["info", "LOT / kupac", 180, "w"]], { height: 8 });
    // zadnje radnje: na dnu stranice, zatvoreno dok se ne otvori
    this.recentBox = h("details", { class: "card kw-recent" },
      h("summary", {}, h("span", { class: "kw-recent-t" }, "Zadnje radnje"), this.recentN = h("span", { class: "muted" }, ""),
        h("span", { class: "kw-recent-btn" })),
      this.recentT.el);
    this.home.append(this.tiles, this.counts,
      h("div", { class: "card" }, h("h3", {}, "Zaliha piva u punim kegovima"), this.stockSum = h("div", { class: "muted" }), this.stockT.el),
      h("div", { class: "card" }, h("h3", {}, "Kegovi po statusu"), h("div", { style: { margin: "4px 0 8px" } }, this.seg),
        h("div", { class: "muted", style: { fontSize: "12px", marginBottom: "6px" } }, "Dvoklik (ili dvostruki dodir) na keg prikazuje njegovu povijest."),
        this.listT.el),
      this.recentBox);
    this.buildWork();
  }

  refresh() {
    const o = this.app.py.call("web_kegs.overview");
    const c = o.counts;
    this.counts.innerHTML = "";
    for (const [lab, val, col, sub] of [["Puni", c["Pun"], "#E3A12B", `${fq(o.total_litres, 0)} L piva`],
      ["Prazni (prljavi)", c["Prljav"], "#B9864A", "za pranje"], ["Čisti", c["Čist"], "#5BBF7A", "spremni za punjenje"],
      ["Kod kupaca", c["Kod kupca"], "#4F9DDE", "vani"], ["Servis", c["Servis"], "#E0675A", `ukupno kegova ${o.total}`]]) {
      this.counts.append(h("div", { class: "kpi" }, h("div", { class: "bar", style: { background: col } }),
        h("div", { class: "lab" }, lab), h("div", { class: "val" }, String(val || 0)), h("div", { class: "s" }, sub)));
    }
    this.stockT.setRows(o.stock.map((s, i) => ({ id: i, beer: s.beer, lot: s.lot, kegs: s.kegs, litres: fq(s.litres, 1),
      oldest: d2ui(s.oldest) })));
    this.stockSum.textContent = o.stock.length ? `Ukupno ${fq(o.total_litres, 1)} L u ${c["Pun"]} kegova` : "Nema punih kegova.";
    this.kegs = this.db.kegs();
    this.renderList();
    const rec = this.app.py.call("web_kegs.recent", 25);
    this.recentN.textContent = rec.length ? ` · ${rec.length}` : "";
    this.recentT.setRows(rec.map((g) => ({ id: g.id, ts: d2ui(g.ts.slice(0, 10)) + g.ts.slice(10),
      code: g.code, action: g.action, status: g.status, info: [g.batch_no, g.customer].filter(Boolean).join(" · ") })));
    for (const el of this.tiles.querySelectorAll(".tile-cart")) {
      const n = (ls("kegcart_" + el.dataset.flow) || []).length;
      el.textContent = n ? `${n} na listi` : "";
    }
    if (this.flow) this.renderCart();
  }

  renderList() {
    const f = this.listFilter;
    const rows = (this.kegs || []).filter((k) => f === "Sve" ? k.status !== "Otpisan" : k.status === f);
    this.listT.setRows(rows.map((k) => ({ id: k.id, code: k.code, status: k.status, beer: k.beer || "", lot: k.batch_no || "",
      filled: d2ui(k.filled_date), customer: k.customer || "" })));
  }

  async detail(id) {
    const r = await kegDetail(this.app, id);
    if (r) this.refresh();
  }

  async findKeg(mode = "detail") {
    const dlg = new Dialog(mode === "service" ? "Servis kega – odaberite keg" : "Pronađi keg", { width: 520 });
    const inp = h("input", { placeholder: "Broj kega, npr. 7 ili K30-007", style: { width: "100%" } });
    const sc = new Scanner((code) => go(code));
    const go = (text) => {
      const found = this.app.py.call("web_kegs.find_keg", text);
      if (found.length === 1) { beep(true); sc.stop(); dlg.close(found[0].id); }
      else if (!found.length && /[a-z]/i.test(text)) {
        beep(false); sc.stop();
        unknownKeg(this.app, text).then((code) => {
          if (!code) return;
          const f2 = this.app.py.call("web_kegs.find_keg", code);
          if (f2.length === 1) dlg.close(f2[0].id);
        });
      } else { beep(false); sc.flash(false); dlg.err(found.length ? `Više kegova odgovara: ${found.map((k) => k.code).join(", ")}` : `Keg „${text}” nije pronađen.`); }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(inp.value); } });
    dlg.body.append(sc.el, h("div", { class: "row gap" }, inp), h("div", { class: "row gap", style: { marginTop: "8px" } },
      btn("📷 Skeniraj QR", async () => { try { await sc.start(); } catch (e) { dlg.err(e.message); } }, "ghost"),
      btn("Traži", () => go(inp.value))));
    dlg.buttons(null, null, "Zatvori");
    const id = await dlg.show();
    sc.stop();
    if (id === null || id === undefined) return;
    if (mode === "service") { if (await serviceDialog(this.app, id)) this.refresh(); } else this.detail(id);
  }

  // -------------------------------------------------------------- radna lista
  buildWork() {
    this.wTitle = h("h2", {});
    this.wHint = h("div", { class: "muted" });
    this.scanner = new Scanner((code) => this.add(code, true));
    this.camBtn = btn("📷 Uključi kameru", () => this.toggleCam(), "primary");
    this.inp = h("input", { placeholder: "Broj kega (npr. 7, K30-007) – Enter", inputmode: "text", autocomplete: "off", style: { flex: "1", minWidth: "160px" } });
    this.inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.add(this.inp.value); this.inp.value = ""; } });
    this.msg = h("div", { class: "scan-msg" });
    this.cartT = new Table([["code", "Keg", 90, "w"], ["size", "L", 50, "e"], ["status", "Status", 90, "w"],
      ["beer", "Pivo / LOT", 200, "w"], ["customer", "Kupac", 140, "w"]], { multi: true });
    this.extra = h("div", {});
    this.confirmBtn = btn("✔ Potvrdi", () => this.confirmFlow(), "primary");
    this.work.append(
      h("div", { class: "row gap" }, btn("← Natrag", () => this.close(), "ghost"), this.wTitle),
      this.wHint,
      h("div", { class: "card" }, this.scanner.el,
        h("div", { class: "row gap" }, this.camBtn, this.inp, btn("＋ Dodaj", () => { this.add(this.inp.value); this.inp.value = ""; }, "ghost")),
        this.msg),
      h("div", { class: "card" }, h("div", { class: "row gap", style: { justifyContent: "space-between" } },
        this.cartTitle = h("h3", {}, "Lista"),
        h("div", { class: "row gap" }, btn("Ukloni označene", () => this.removeSel(), "ghost"), btn("Očisti listu", () => this.clearCart(), "ghost"))),
      this.cartT.el),
      h("div", { class: "card" }, this.extra, h("div", { class: "row gap", style: { marginTop: "10px", justifyContent: "flex-end" } }, this.confirmBtn)));
  }

  open(flow) {
    this.flow = flow;
    const wf = this.consts.workflows[flow];
    const f = FLOWS.find((x) => x[0] === flow);
    this.wTitle.textContent = `${f[1]} ${f[2]}`;
    this.wHint.textContent = `Dodajte kegove na listu (status mora biti: ${wf.from.join(", ")}). Nakon potvrde postaju: ${wf.to}.`;
    this.cart = ls("kegcart_" + flow) || [];
    this.fillL = ls("kegfill_l") || {};
    this.buildExtra();
    this.home.classList.add("hidden");
    this.work.classList.remove("hidden");
    this.msg.textContent = ""; this.msg.className = "scan-msg";
    this.renderCart();
    setTimeout(() => this.inp.focus(), 50);
  }

  onBack() { // natrag: iz radne liste na početni zaslon Rada s kegovima
    if (this.flow) { this.close(); return true; }
    return false;
  }

  close() {
    this.scanner.stop();
    this.camBtn.textContent = "📷 Uključi kameru";
    this.flow = null;
    this.work.classList.add("hidden");
    this.home.classList.remove("hidden");
    this.refresh();
  }

  async toggleCam() {
    if (this.scanner.running) { this.scanner.stop(); this.camBtn.textContent = "📷 Uključi kameru"; return; }
    try { await this.scanner.start(); this.camBtn.textContent = "⏹ Isključi kameru"; } catch (e) {
      this.say(false, e.name === "NotAllowedError" ? "Pristup kameri nije dopušten – dopustite ga u postavkama preglednika." : e.message);
    }
  }

  say(ok, text) {
    this.msg.textContent = text;
    this.msg.className = "scan-msg " + (ok ? "ok" : "bad");
    this.scanner.flash(ok);
    beep(ok);
  }

  add(text, fromScan = false) {
    text = (text || "").trim();
    if (!text) return;
    const found = this.app.py.call("web_kegs.find_keg", text);
    if (!found.length) {
      this.say(false, `Keg „${text}” nije u programu.`);
      if (fromScan || /[a-z]/i.test(text)) {
        if (this.scanner.running) this.scanner.stop();
        unknownKeg(this.app, text).then((code) => {
          if (code) { toast(`Keg ${code} spremljen.`); this.add(code); }
          if (this.camBtn.textContent.startsWith("⏹")) this.scanner.start().catch(() => {});
        });
      }
      return;
    }
    if (found.length > 1) return this.say(false, `Više kegova odgovara upisu: ${found.map((k) => k.code).join(", ")} – upišite punu oznaku.`);
    const k = found[0];
    if (this.cart.includes(k.id)) return this.say(true, `${k.code} je već na listi.`);
    const [ok, why] = this.app.py.call("web_kegs.check", this.flow, k.id);
    if (!ok) return this.say(false, why);
    this.cart.push(k.id);
    ls("kegcart_" + this.flow, this.cart);
    this.say(true, `✔ ${k.code} dodan${k.beer ? ` (${k.beer})` : ""} – ukupno ${this.cart.length}.`);
    this.renderCart();
    if (!fromScan) this.inp.focus();
  }

  renderCart() {
    const byId = new Map(this.db.kegs().map((k) => [k.id, k]));
    this.cart = this.cart.filter((id) => byId.has(id));
    const fill = this.flow === "fill";
    const lit = (k) => fill ? this.litresOf(k) : (k.fill_l || (k.status === "Pun" || k.status === "Kod kupca" ? k.size_l : 0) || 0);
    const rows = this.cart.map((id) => {
      const k = byId.get(id);
      const ok = this.consts.workflows[this.flow].from.includes(k.status);
      return { id, code: k.code, size: fq(lit(k), 2) || fq(k.size_l), status: k.status, beer: [k.beer, k.batch_no].filter(Boolean).join(" · "),
        customer: k.customer || "", _tag: ok ? "" : "bad" };
    });
    this.cartT.setRows(rows);
    const litres = this.cart.reduce((a, id) => a + lit(byId.get(id)), 0);
    this.cartTitle.textContent = `Lista: ${this.cart.length} keg(ova) · ${fq(litres, 1)} L`;
    this.confirmBtn.textContent = `✔ Potvrdi (${this.cart.length})`;
    if (fill) this.renderFill(byId);
  }

  // punjenje: svaki keg 17 L; zadnji keg (i bilo koji drugi) može se upisati ručno
  defaultFill(k) { const f = this.consts.keg_fill || 17; return k && k.size_l ? Math.min(f, k.size_l) : f; }
  litresOf(k) { const v = this.fillL[k.id]; return v === undefined || v === "" || v === null ? this.defaultFill(k) : Number(v); }
  renderFill(byId) {
    if (!this.fillBox) return;
    this.fillBox.innerHTML = "";
    if (!this.cart.length) { this.fillBox.append(h("div", { class: "muted" }, "Dodajte kegove na listu – svaki dobiva 17 L.")); return; }
    const grid = h("div", { class: "fill-grid" });
    this.cart.forEach((id, i) => {
      const k = byId.get(id);
      const last = i === this.cart.length - 1;
      const manual = this.fillL[id] !== undefined && this.fillL[id] !== "";
      const inp = h("input", { type: "text", inputmode: "decimal", value: fq(this.litresOf(k), 2), style: { width: "80px", textAlign: "right" },
        "data-keg": String(id), class: manual ? "manual" : "" });
      inp.addEventListener("change", () => {
        const v = inp.value.trim();
        if (v === "") delete this.fillL[id];
        else {
          const n = num(v);
          if (!(n > 0) || (k.size_l && n > k.size_l + 1e-9)) { inp.value = fq(this.litresOf(k), 2); return this.say(false, `${k.code}: količina mora biti veća od 0 i najviše ${fq(k.size_l)} L.`); }
          if (Math.abs(n - this.defaultFill(k)) < 1e-9) delete this.fillL[id]; else this.fillL[id] = n;
        }
        ls("kegfill_l", this.fillL);
        this.renderCart();
      });
      grid.append(h("div", { class: "fill-row" + (last ? " last" : "") },
        h("span", { class: "fill-code" }, k.code, last ? h("span", { class: "muted" }, " · zadnji keg") : null), inp, h("span", {}, "L"),
        manual ? btn("↺", () => { delete this.fillL[id]; ls("kegfill_l", this.fillL); this.renderCart(); }, "ghost") : null));
    });
    this.fillBox.append(grid);
  }

  removeSel() {
    const sel = new Set(this.cartT.selectedIds().map(Number));
    this.cart = this.cart.filter((id) => !sel.has(id));
    ls("kegcart_" + this.flow, this.cart);
    this.renderCart();
  }
  async clearCart() {
    if (this.cart.length && !(await confirm("Ukloniti sve kegove s liste?", "Lista"))) return;
    this.cart = [];
    ls("kegcart_" + this.flow, this.cart);
    this.renderCart();
  }

  buildExtra() {
    this.extra.innerHTML = "";
    const user = deviceUser(this.app);
    const base = [{ key: "date", label: "Datum", type: "date", default: today() },
      { key: "operator", label: "Radnik", default: user, type: "combo", editable: true, options: this.db.employee_names() }];
    let fields;
    if (this.flow === "fill") {
      const bs = this.app.py.call("web_kegs.fill_batches");
      fields = [{ key: "batch_id", label: "Šarža (LOT piva)", type: "combo", required: true, options: bs.map((b) => [b.label, b.id]),
        default: ls("kegfill_batch") }, ...base,
      { key: "pack", label: "Upiši u HACCP evidenciju pakiranja", type: "check", default: 1 }];
    } else if (this.flow === "ship") {
      const cs = this.app.py.call("web_kegs.customers");
      fields = [{ key: "customer_id", label: "Kupac", type: "combo", required: true,
        options: cs.map((c) => [`${c.name}${c.city ? " · " + c.city : ""}${c.kegs_held ? ` (ima ${c.kegs_held} keg.)` : ""}`, c.id]) },
      ...base, { key: "note", label: "Napomena na otpremnici" }];
    } else fields = [...base, { key: "note", label: "Napomena (neobavezno)" }];
    this.form = new Form(fields, {}, 2);
    this.extra.append(this.form.el);
    this.fillBox = null;
    if (this.flow === "fill") {
      this.fillBox = h("div", {});
      this.extra.append(h("h3", { class: "sec" }, "Količina piva u kegovima"),
        h("div", { class: "muted", style: { fontSize: "12.5px", margin: "4px 0 6px" } },
          `Svaki keg dobiva ${fq(this.consts.keg_fill || 17)} L. Ako zadnji keg (ili bilo koji drugi) nije pun, upišite stvarnu količinu. `
          + `Kupcu se mogu izdati samo kegovi s ${fq(this.consts.keg_fill || 17)} L.`), this.fillBox);
    }
    if (this.flow === "ship") {
      this.extra.append(h("div", { class: "row gap", style: { marginTop: "6px" } }, btn("＋ Novi kupac", async () => {
        const id = await newCustomer(this.app);
        if (id) { this.buildExtra(); this.form.w.customer_id.set(id); toast("Kupac spremljen."); }
      }, "ghost")));
    }
  }

  async confirmFlow() {
    if (!this.cart.length) return info("Lista je prazna – skenirajte ili upišite kegove.");
    let p;
    try { p = this.form.get(); } catch (e) { return error(e); }
    if (p.operator) ls("pivovara_user", p.operator);
    const f = FLOWS.find((x) => x[0] === this.flow);
    let ask = `${f[2]}: ${this.cart.length} keg(ova). Potvrditi?`;
    if (this.flow === "fill") {
      ls("kegfill_batch", p.batch_id);
      const byId = new Map(this.db.kegs().map((k) => [k.id, k]));
      p.litres = {};
      for (const id of this.cart) p.litres[id] = this.litresOf(byId.get(id));
      const tot = Object.values(p.litres).reduce((a, b) => a + b, 0);
      const part = this.cart.filter((id) => p.litres[id] + 1e-9 < (this.consts.keg_fill || 17)).map((id) => `${byId.get(id).code} (${fq(p.litres[id], 2)} L)`);
      ask = `Punjenje: ${this.cart.length} keg(ova), ukupno ${fq(tot, 2)} L.` + (part.length ? `\n\nNisu puni: ${part.join(", ")} – ti se kegovi ne mogu izdati kupcu.` : "") + "\n\nPotvrditi?";
    }
    let printLabels = false;
    if (this.flow === "fill") {
      const c = await choice(ask, f[2], [["Odustani", null, "ghost"], ["Potvrdi", "ok", "ghost"], ["Potvrdi i ispiši naljepnice", "print"]]);
      if (!c) return;
      printLabels = c === "print";
    } else if (!(await confirm(ask, f[2]))) return;
    let res;
    try { res = this.app.py.call("web_kegs.apply", this.flow, this.cart, p); } catch (e) { return error(e); }
    const ids = this.cart.slice();
    this.cart = [];
    ls("kegcart_" + this.flow, []);
    if (this.flow === "fill") { this.fillL = {}; ls("kegfill_l", {}); }
    this.renderCart();
    this.scanner.stop(); this.camBtn.textContent = "📷 Uključi kameru";
    if (this.flow === "ship") {
      const d = new Dialog("Otpremnica izrađena", { width: 480 });
      d.body.append(h("div", { class: "msg" }, `Otpremnica ${res.delivery_no} – ${res.done} keg(ova) kod kupca.`));
      d.bar.append(btn("Zatvori", () => d.close(), "ghost"),
        btn("📄 PDF otpremnice", () => { d.close(); this.app.doc("web_extras.print_dn", res.delivery_id, "PDF"); }, "primary"));
      await d.show();
    } else if (this.flow === "fill") {
      toast(`Napunjeno ${res.done} keg(ova).` + (res.packaged ? " Pakiranje upisano u HACCP evidenciju." : ""));
      if (printLabels) {
        try { const m = await import("./production.js"); await m.printKegLabels(this.app, ids); } catch (e) { error(e); }
      }
    } else toast(`${f[2]}: ${res.done} keg(ova) potvrđeno.`);
    this.close();
  }
}

export const PAGES = { kegwork: KegWorkPage };
