// Računi dobavljača: učitaj račun (PDF / e-račun XML / fotografija) -> provjeri -> primka robe jednim klikom.
// Datoteke računa spremaju se u repozitorij s podacima (mapa racuni/GODINA/), popis je na stranici Skladište → Računi.
import { h, btn, Page, Table, Dialog, askForm, choice, info, error, toast, fq, d2ui, today, busy, saveBlob, setLabel } from "../ui.js";
import { icon } from "../icons.js";
import * as store from "../store.js";

const eur = (x) => x === null || x === undefined || x === "" ? "" : Number(x).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n2 = (s) => { const v = parseFloat(String(s ?? "").replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return Number.isFinite(v) ? v : 0; };
const fin = (x, d = 4) => x === null || x === undefined || x === "" ? "" : String(Math.round(Number(x) * 10 ** d) / 10 ** d).replace(".", ",");
const MIME = { pdf: "application/pdf", xml: "application/xml", jpg: "image/jpeg" };
const SKIP = "__skip__", NEW = "__new__";

// ------------------------------------------------------------------ datoteke računa (GitHub + lokalna kopija)
const PENDING = "racuni_pending";
function pendingList() { try { return JSON.parse(localStorage.getItem(PENDING) || "[]"); } catch { return []; } }
function setPending(l) { try { localStorage.setItem(PENDING, JSON.stringify(l)); } catch { /* */ } }

async function putRemote(cfg, path, bytes) {
  try { await store.remotePut(cfg, bytes, null, `Račun dobavljača: ${path.split("/").pop()}`, path); } catch (e) {
    if (!(e instanceof store.ConflictError)) throw e;
    const meta = await store.remoteMeta(cfg, path); // ista datoteka već postoji -> zamijeni
    await store.remotePut(cfg, bytes, meta ? meta.sha : null, `Račun dobavljača: ${path.split("/").pop()}`, path);
  }
}
export async function saveInvoiceFile(path, bytes) {
  await store.localPut("racun:" + path, bytes);
  const cfg = store.getConfig() || {};
  if (cfg.mode !== "github") return "local";
  try { await putRemote(cfg, path, bytes); return "ok"; } catch (e) {
    console.warn("račun", e);
    setPending([...new Set([...pendingList(), path])]);
    return "pending";
  }
}
export async function retryPending() {
  const cfg = store.getConfig() || {};
  const l = pendingList();
  if (cfg.mode !== "github" || !l.length || !navigator.onLine) return 0;
  const left = [];
  for (const p of l) {
    const b = await store.localGet("racun:" + p);
    if (!b) continue;
    try { await putRemote(cfg, p, b); } catch { left.push(p); }
  }
  setPending(left);
  return l.length - left.length;
}
async function loadInvoiceFile(path) {
  let b = await store.localGet("racun:" + path);
  if (b) return b;
  const cfg = store.getConfig() || {};
  if (cfg.mode !== "github") return null;
  const r = await store.remoteGet(cfg, path);
  if (r) { await store.localPut("racun:" + path, r.bytes); return r.bytes; }
  return null;
}
async function showInvoiceFile(inv) {
  if (!inv.file_path) return info("Uz ovaj račun nije spremljena datoteka.");
  const b = await busy("Otvaram račun…", () => loadInvoiceFile(inv.file_path));
  if (!b) return error("Datoteka računa nije pronađena (možda još nije prenesena s uređaja na kojem je učitana).");
  const ext = inv.file_path.split(".").pop();
  saveBlob(new Blob([b], { type: MIME[ext] || "application/octet-stream" }), inv.file_path.split("/").pop(), true);
}

// ------------------------------------------------------------------ odabir datoteke / fotografiranje
function pickFiles({ accept, capture = false, multiple = false }) {
  return new Promise((res) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    if (capture) inp.setAttribute("capture", "environment");
    if (multiple) inp.multiple = true;
    inp.addEventListener("change", () => { res([...inp.files]); inp.remove(); });
    inp.addEventListener("cancel", () => { res([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
// fotografija -> JPEG najviše 1800 px (manja datoteka, dovoljno oštro za čitanje)
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}

// Učitaj račun: PDF / XML datoteka ili fotografije (sve stranice) -> dijalog primke
export async function newInvoice(app, mode = "file", files = null) {
  const py = app.py;
  if (!files) {
    files = mode === "photo"
      ? await pickFiles({ accept: "image/*", capture: true, multiple: true })
      : await pickFiles({ accept: ".pdf,.xml,application/pdf,text/xml,application/xml,image/*", multiple: true });
  }
  if (!files || !files.length) return null;
  let prep, bytes, kind, name;
  try {
    prep = await busy("Čitam račun…", async (set) => {
      await py.ensureDocs(set);
      set("Čitam račun…");
      const imgs = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
      if (imgs.length) {
        const paths = [];
        for (const [i, f] of imgs.entries()) {
          const p = `/tmp/racun_${i}.jpg`;
          py.writeFile(p, await shrinkImage(f));
          paths.push(p);
        }
        const pdf = py.call("web_invoices.images_to_pdf", paths, "racun_slika.pdf");
        bytes = py.readFile(pdf); kind = "image"; name = imgs.length > 1 ? `${imgs.length} fotografije` : imgs[0].name;
        return py.call("web_invoices.prepare", { header: {}, lines: [], kind: "image" });
      }
      const f = files[0];
      name = f.name;
      bytes = new Uint8Array(await f.arrayBuffer());
      const isXml = /\.xml$/i.test(f.name) || /xml/.test(f.type);
      const tmp = "/tmp/racun." + (isXml ? "xml" : "pdf");
      py.writeFile(tmp, bytes);
      const parsed = py.call("web_invoices.parse_file", tmp, isXml ? "xml" : "pdf");
      kind = parsed.kind;
      return py.call("web_invoices.prepare", parsed);
    });
  } catch (e) { error("Račun se ne može pročitati: " + e.message); return null; }
  const res = await new InvoiceDialog(app, prep, { bytes, kind, name }).show();
  return res;
}

// ------------------------------------------------------------------ dijalog: provjera i primka
class InvoiceDialog extends Dialog {
  constructor(app, prep, file) {
    super("Račun dobavljača → primka robe", { width: 1180, cls: "inv-dlg" });
    this.app = app; this.py = app.py; this.db = app.db; this.file = file;
    const hd = prep.header || {};
    this.items = this.db.items().filter((i) => i.active !== 0).sort((a, b) => a.name.localeCompare(b.name, "hr"));
    this.sups = this.db.suppliers();
    this.lines = (prep.lines || []).map((l) => ({ ...l, stock_qty: l.item_id && !l.skip ? round4(l.qty * (l.factor || 1)) : 0 }));

    // --- obavijest o čitanju
    const kindTxt = { pdf: "Podaci su pročitani iz PDF-a.", "pdf+xml": "Podaci su pročitani iz e-računa (XML u PDF-u).",
      xml: "Podaci su pročitani iz e-računa (XML).", image: "Fotografija računa – odaberite dobavljača i upišite stavke (program pamti stavke dobavljača)." }[file.kind] || "";
    const n = this.lines.length, ok = this.lines.filter((l) => (l.item_id && l.sure) || l.skip).length;
    const note = prep.scan ? "PDF je skeniran (slika bez teksta) – stavke upišite ručno." :
      (file.kind === "image" ? kindTxt : `${kindTxt} ${n ? `Prepoznato ${n} stavki, ${ok} spremno` + (ok < n ? " – crveno i žuto označene provjerite." : ".") : "Stavke nisu prepoznate – dodajte ih ručno."}`);
    const url = URL.createObjectURL(new Blob([file.bytes], { type: file.kind === "xml" ? "text/xml" : "application/pdf" }));
    this.url = url;
    const top = h("div", { class: "inv-top" },
      h("div", { class: "inv-file" }, icon("doc", 18), h("b", {}, file.name || "račun"),
        h("a", { href: url, target: "_blank", rel: "noopener", class: "btn btn-ghost btn-sm" }, icon("eye", 16), h("span", {}, "Pogledaj račun"))),
      h("div", { class: "muted", style: { fontSize: "12.5px" } }, note));
    this.body.append(top);
    if (hd.duplicate) this.body.append(h("div", { class: "banner warn" },
      `Račun ${hd.inv_no} ovog dobavljača već je upisan (${d2ui(hd.duplicate.recv_date)}). Spremanjem bi se roba zaprimila dvaput.`));
    // pregled računa uz obrazac (na širokom zaslonu)
    if (file.kind !== "xml" && window.matchMedia("(min-width: 1200px)").matches) {
      const det = h("details", { class: "inv-prev" }, h("summary", {}, "Prikaži račun ovdje"),
        h("iframe", { src: url, title: "Račun" }));
      this.body.append(det);
    }

    // --- zaglavlje
    this.sel = h("select", {}, h("option", { value: "" }, "— odaberite dobavljača —"),
      this.sups.map((s) => h("option", { value: String(s.id) }, s.name)),
      h("option", { value: NEW }, hd.supplier_name && !hd.supplier_id ? `＋ Novi dobavljač: ${hd.supplier_name}` : "＋ Novi dobavljač…"));
    this.newSup = { name: hd.supplier_name || "", oib: hd.oib || "", address: hd.address || "" };
    this.sel.value = hd.supplier_id ? String(hd.supplier_id) : (hd.supplier_name ? NEW : "");
    this.sel.addEventListener("change", () => this.onSupplier());
    const inp = (v, attrs = {}) => { const e = h("input", attrs); e.value = v ?? ""; return e; };
    this.f = {
      inv_no: inp(hd.inv_no), inv_date: inp(hd.inv_date || "", { type: "date" }), recv_date: inp(today(), { type: "date" }),
      due_date: inp(hd.due_date || "", { type: "date" }), total: inp(hd.total ? fin(hd.total, 2) : "", { inputmode: "decimal" }),
      iban: inp(hd.iban || ""), ref: inp([hd.pay_model, hd.pay_ref].filter(Boolean).join(" ")),
    };
    this.f.recv_date.addEventListener("change", () => this.recvChanged());
    const cell = (lab, el, req = false, wide = false) => h("div", { class: "fcell" + (wide ? " w2" : "") }, h("label", { class: "flab" }, lab + (req ? " *" : "")), el);
    this.supInfo = h("div", { class: "muted", style: { fontSize: "12px" } });
    this.body.append(h("div", { class: "sec" }, "Račun"),
      h("div", { class: "inv-head" }, cell("Dobavljač", h("div", {}, this.sel, this.supInfo), true, true), cell("Broj računa", this.f.inv_no, true),
        cell("Datum računa", this.f.inv_date), cell("Roba primljena", this.f.recv_date), cell("Dospijeće plaćanja", this.f.due_date),
        cell("Iznos za platiti €", this.f.total), cell("IBAN dobavljača", this.f.iban, false, true), cell("Poziv na broj", this.f.ref)));
    this.onSupplier(true);

    // --- stavke
    this.rowsEl = h("div", { class: "inv-lines" });
    this.sumEl = h("div", { class: "inv-sum" });
    this.body.append(h("div", { class: "sec row", style: { justifyContent: "space-between", alignItems: "center" } }, "Stavke računa",
      btn("＋ Dodaj stavku", () => { this.lines.push({ name: "", qty: 1, unit: "", amount: 0, factor: 1, stock_qty: 0, key: "" }); this.renderLines(true); }, "ghost")),
    h("div", { class: "inv-legend muted" }, "Stavka s računa → artikl u skladištu. Količina „na skladište” je u jedinici artikla (npr. 6 vreća × 25 kg = 150 kg). Iznos je bez PDV-a."),
    this.rowsEl, this.sumEl);
    this.renderLines();

    // --- što još napraviti
    this.poSel = h("select", {}, h("option", { value: "" }, "— bez narudžbenice —"));
    this.fillPOs(prep.pos || []);
    this.haccp = h("input", { type: "checkbox" }); this.haccp.checked = true;
    this.paid = h("input", { type: "checkbox" }); this.paid.checked = !!hd.paid;
    this.inspector = inp((app.user && app.user.name) || this.db.get_setting("default_operator") || "", { placeholder: "tko je pregledao robu", style: { maxWidth: "220px" } });
    this.body.append(h("div", { class: "sec" }, "Uz primku"),
      h("div", { class: "inv-opts" },
        h("label", { class: "row gap" }, h("span", {}, "Narudžbenica:"), this.poSel),
        h("label", { class: "chk" }, this.haccp, " Roba je pregledana i ispravna – upiši HACCP zapisnik o prijemu (PRIHVAĆENO)"),
        h("label", { class: "chk" }, this.paid, " Račun je već plaćen (karticom, gotovinom ili unaprijed)" + (hd.paid ? " – tako piše na računu" : "")),
        h("label", { class: "row gap" }, h("span", { class: "muted" }, "Pregledao:"), this.inspector)));

    this.buttons("✔ Spremi račun i primku", () => this.save());
  }

  close(r) { try { URL.revokeObjectURL(this.url); } catch { /* */ } super.close(r); }

  onSupplier(first = false) {
    const v = this.sel.value;
    this.supInfo.textContent = "";
    if (v === NEW) {
      if (!first || !this.newSup.name) {
        askForm("Novi dobavljač", [{ key: "name", label: "Naziv", required: true }, { key: "oib", label: "OIB" }, { key: "address", label: "Adresa" }],
          this.newSup).then((d) => {
          if (!d) { this.sel.value = ""; return; }
          this.newSup = d;
          this.sel.options[this.sel.options.length - 1].textContent = `＋ Novi dobavljač: ${d.name}`;
          this.supInfo.textContent = d.oib ? `OIB ${d.oib}` : "";
        });
      } else this.supInfo.textContent = (this.newSup.oib ? `OIB ${this.newSup.oib} · ` : "") + "dodaje se u dobavljače pri spremanju";
    } else if (v && !first) {
      // drugi dobavljač -> ponovno pridruži stavke prema onome što je zapamćeno za tog dobavljača
      try {
        const p = this.py.call("web_invoices.prepare", { header: { recv_date: this.f.recv_date.value }, lines: this.lines.map((l) => ({ ...l, item_id: null })) }, Number(v));
        this.lines = p.lines.map((l) => ({ ...l, stock_qty: l.item_id && !l.skip ? round4(l.qty * (l.factor || 1)) : 0 }));
        this.fillPOs(p.pos || []);
        this.renderLines();
      } catch (e) { console.warn(e); }
    }
  }

  fillPOs(pos) {
    this.poSel.length = 1;
    for (const p of pos) this.poSel.append(h("option", { value: String(p.id) }, `${p.po_no} · ${d2ui(p.date)}` + (p.match ? ` · ${p.match} stavki odgovara` : "")));
    this.poSel.value = pos.length && pos[0].match ? String(pos[0].id) : "";
  }

  recvChanged() {
    for (const l of this.lines) {
      if (l.item_id && l.expiry_guess) {
        try { const x = this.py.call("web_invoices.item_defaults", l.item_id, this.f.recv_date.value); if (x.expiry) l.expiry = x.expiry; } catch { /* */ }
      }
    }
    this.renderLines();
  }

  renderLines(focusLast = false) {
    this.rowsEl.innerHTML = "";
    const itemOpts = () => [h("option", { value: "" }, "— odaberite artikl —"), h("option", { value: SKIP }, "— ne ide na skladište (usluga, dostava…) —"),
      ...this.items.map((i) => h("option", { value: String(i.id) }, `${i.name} (${i.unit})`)), h("option", { value: NEW }, "＋ Novi artikl…")];
    this.lines.forEach((l, idx) => {
      const it = this.items.find((x) => x.id === l.item_id);
      const name = h("input", { value: l.name || "", placeholder: "naziv s računa" });
      const qty = h("input", { value: fin(l.qty), inputmode: "decimal", class: "num" });
      const unit = h("input", { value: l.unit || "", placeholder: "jed.", class: "unit" });
      const sel = h("select", {}, itemOpts()); sel.value = l.skip ? SKIP : (l.item_id ? String(l.item_id) : "");
      const sq = h("input", { value: l.skip ? "" : fin(l.stock_qty), inputmode: "decimal", class: "num" });
      const amt = h("input", { value: fin(l.amount, 2), inputmode: "decimal", class: "num" });
      const per = h("span", { class: "muted per" });
      const lot = h("input", { value: l.lot_no || "", placeholder: "LOT dobavljača" });
      const exp = h("input", { type: "date", value: (l.expiry || "").slice(0, 10) });
      const del = h("button", { type: "button", class: "btn btn-ghost btn-sm", title: "Ukloni stavku", "aria-label": "Ukloni stavku" }, icon("trash", 18));
      const row = h("div", { class: "inv-line" });
      const paint = () => {
        const need = !l.skip && !l.item_id;
        const unsure = !l.skip && l.item_id && !l.sure && !l.learned;
        row.classList.toggle("need", need); row.classList.toggle("unsure", !!unsure); row.classList.toggle("skip", !!l.skip);
        const u = (this.items.find((x) => x.id === l.item_id) || {}).unit || "";
        per.textContent = !l.skip && l.stock_qty > 0 ? `${eur(l.amount / l.stock_qty)} €/${u}` + (unsure ? " · provjerite količinu" : "") : (need ? "odaberite artikl" : "");
        this.updateSum();
      };
      name.addEventListener("change", () => { l.name = name.value; });
      qty.addEventListener("change", () => {
        const q = n2(qty.value); const f = l.qty ? (l.stock_qty / l.qty || l.factor || 1) : (l.factor || 1);
        l.qty = q; if (!l.skip && l.item_id) { l.stock_qty = round4(q * f); sq.value = fin(l.stock_qty); } paint();
      });
      unit.addEventListener("change", () => { l.unit = unit.value.trim(); });
      sq.addEventListener("change", () => { l.stock_qty = n2(sq.value); l.factor = l.qty ? l.stock_qty / l.qty : 1; l.sure = true; paint(); });
      amt.addEventListener("change", () => { l.amount = n2(amt.value); paint(); });
      lot.addEventListener("change", () => { l.lot_no = lot.value.trim(); });
      exp.addEventListener("change", () => { l.expiry = exp.value || null; l.expiry_guess = false; });
      sel.addEventListener("change", async () => {
        let v = sel.value;
        if (v === NEW) {
          const id = await this.newItem(l.name);
          if (!id) { sel.value = l.item_id ? String(l.item_id) : ""; return; }
          v = String(id);
          this.renderLines(); // novi artikl u svim izbornicima
          l.item_id = id;
        }
        l.skip = v === SKIP;
        l.item_id = l.skip || !v ? null : Number(v);
        if (l.item_id) {
          try {
            const x = this.py.call("web_invoices.line_for_item", l.name, l.unit, l.item_id, this.f.recv_date.value);
            l.factor = x.factor; l.sure = x.sure; l.learned = false;
            if (x.expiry && !l.expiry) { l.expiry = x.expiry; l.expiry_guess = true; }
          } catch { l.factor = 1; l.sure = false; }
          l.stock_qty = round4((l.qty || 0) * (l.factor || 1));
        } else l.stock_qty = 0;
        this.renderLines();
      });
      del.addEventListener("click", () => { this.lines.splice(idx, 1); this.renderLines(); });
      const stockPart = l.skip ? h("div", { class: "il-stock muted" }, "ne ide na skladište")
        : h("div", { class: "il-stock" }, h("label", {}, "Na skladište"), h("div", { class: "row" }, sq, h("span", { class: "u" }, it ? it.unit : "")), per);
      row.append(
        h("div", { class: "il-name" }, h("label", {}, "Stavka s računa"), name, l.raw && l.raw !== l.name ? h("div", { class: "raw muted", title: l.raw }, l.raw) : null),
        h("div", { class: "il-qty" }, h("label", {}, "Količina"), h("div", { class: "row" }, qty, unit)),
        h("div", { class: "il-item" }, h("label", {}, "Artikl u skladištu" + (l.learned ? " · zapamćeno" : "")), sel),
        stockPart,
        h("div", { class: "il-amt" }, h("label", {}, "Iznos € bez PDV"), amt),
        l.skip ? h("div", {}) : h("div", { class: "il-lot" }, h("label", {}, "LOT · rok trajanja"), h("div", { class: "row" }, lot, exp)),
        h("div", { class: "il-del" }, del));
      this.rowsEl.append(row);
      paint();
    });
    if (!this.lines.length) this.rowsEl.append(h("div", { class: "muted", style: { padding: "8px 0" } }, "Nema stavki – kliknite „＋ Dodaj stavku”."));
    if (focusLast) { const r = this.rowsEl.lastChild; const i = r && r.querySelector("input"); if (i) i.focus(); }
    this.updateSum();
  }

  updateSum() {
    const net = this.lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
    const tot = n2(this.f.total.value);
    const stockN = this.lines.filter((l) => !l.skip && l.item_id && l.stock_qty > 0).length;
    const need = this.lines.filter((l) => !l.skip && !l.item_id).length;
    let txt = `Zbroj stavki bez PDV-a: ${eur(net)} €`;
    if (tot) {
      const vat = net ? (tot / net - 1) * 100 : 0;
      txt += ` · iznos računa ${eur(tot)} €` + (net && vat > -1 && vat < 26.5 ? ` (≈ ${Math.round(vat)} % PDV)` : " – provjerite stavke");
    }
    txt += ` · na skladište: ${stockN} stavki` + (need ? ` · ⚠ ${need} bez artikla` : "");
    this.sumEl.textContent = txt;
    if (this.okBtn) setLabel(this.okBtn, stockN ? "Spremi račun i primku" : "Spremi račun");
  }

  async newItem(name) {
    const v = await askForm("Novi artikl", [
      { key: "name", label: "Naziv artikla u skladištu", required: true },
      { key: "category", label: "Kategorija", type: "combo", editable: true, options: ["Slad", "Hmelj", "Kvasac", "Dodaci", "Ambalaža", "Kemikalija", "Ostalo"], default: "Slad" },
      { key: "unit", label: "Jedinica", type: "combo", editable: true, options: ["kg", "g", "L", "kom"], default: "kg" }],
    { name: (name || "").replace(/\b\d+([.,]\d+)?\s*(kg|g|l|ml)\b/gi, "").replace(/\s+/g, " ").trim() });
    if (!v) return null;
    try {
      const sid = this.sel.value && this.sel.value !== NEW ? Number(this.sel.value) : null;
      const id = this.db.save_item({ ...v, supplier_id: sid, is_chemical: v.category === "Kemikalija" ? 1 : 0 });
      this.items = this.db.items().filter((i) => i.active !== 0).sort((a, b) => a.name.localeCompare(b.name, "hr"));
      return id;
    } catch (e) { error(e); return null; }
  }

  async save() {
    this.err("");
    const sv = this.sel.value;
    if (!sv) return this.err("Odaberite dobavljača.");
    if (sv === NEW && !this.newSup.name) return this.err("Upišite naziv novog dobavljača.");
    if (!this.f.inv_no.value.trim()) return this.err("Upišite broj računa.");
    const bad = this.lines.find((l) => !l.skip && !l.item_id && (l.qty || l.amount));
    if (bad) return this.err(`Stavka „${bad.name || "bez naziva"}”: odaberite artikl ili „ne ide na skladište”.`);
    const zero = this.lines.find((l) => !l.skip && l.item_id && !(l.stock_qty > 0));
    if (zero) return this.err(`Stavka „${zero.name}”: upišite količinu na skladište.`);
    const ref = this.f.ref.value.trim().match(/^(HR\d{2})\s*(.*)$/i);
    const data = {
      supplier_id: sv === NEW ? null : Number(sv), new_supplier: sv === NEW ? this.newSup : null,
      oib: sv === NEW ? null : (this.newSup.oib || null),
      inv_no: this.f.inv_no.value.trim(), inv_date: this.f.inv_date.value || null, recv_date: this.f.recv_date.value || today(),
      due_date: this.f.due_date.value || null, total: n2(this.f.total.value) || null, iban: this.f.iban.value.trim() || null,
      pay_model: ref ? ref[1].toUpperCase() : (this.f.ref.value.trim() ? "HR00" : null),
      pay_ref: ref ? ref[2].trim() : (this.f.ref.value.trim() || null),
      file_name: this.file.name, file_type: this.file.kind === "pdf+xml" ? "pdf" : this.file.kind,
      paid_date: this.paid.checked ? (this.f.inv_date.value || this.f.recv_date.value || today()) : null,
    };
    const lines = this.lines.map((l) => ({ ...l }));
    const opts = { po_id: this.poSel.value ? Number(this.poSel.value) : null, haccp: this.haccp.checked, inspector: this.inspector.value.trim() || null };
    let r;
    try { r = this.py.call("web_invoices.save_invoice", data, lines, opts); } catch (e) { return this.err(e.message); }
    let st = "local";
    if (r.file_path && this.file.bytes) st = await busy("Spremam datoteku računa…", () => saveInvoiceFile(r.file_path, this.file.bytes));
    this.app.refreshAll();
    const parts = [`Račun ${data.inv_no} spremljen.`];
    if (r.lot_ids.length) parts.push(`Zaprimljeno ${r.lot_ids.length} LOT-ova.`);
    if (r.receipts) parts.push(`HACCP zapisnika: ${r.receipts}.`);
    if (st === "pending") parts.push("Datoteka računa prenijet će se kad bude interneta.");
    toast(parts.join(" "), 6000);
    this.close(r);
  }
}
function round4(x) { return Math.round((Number(x) || 0) * 10000) / 10000; }

// ------------------------------------------------------------------ detalji računa
async function invoiceDetails(app, id) {
  const py = app.py;
  const r = py.call("web_invoices.invoice", id);
  const d = new Dialog(`Račun ${r.inv_no} – ${r.supplier || ""}`, { width: 860 });
  const kv = (k, v) => h("div", {}, h("span", { class: "muted" }, k + ": "), h("b", {}, v || "—"));
  d.body.append(h("div", { class: "inv-kv" }, kv("Datum računa", d2ui(r.inv_date)), kv("Roba primljena", d2ui(r.recv_date)),
    kv("Dospijeće", d2ui(r.due_date)), kv("Iznos", r.total ? eur(r.total) + " €" : ""), kv("Plaćeno", r.paid_date ? d2ui(r.paid_date) : "ne"),
    kv("IBAN", r.iban), kv("Poziv na broj", [r.pay_model, r.pay_ref].filter(Boolean).join(" ")), kv("Upisao", `${r.created_by || ""} ${r.created || ""}`.trim())));
  const t = new Table([["lot", "LOT", 130, "w"], ["name", "Artikl", 200, "w"], ["qty", "Primljeno", 90, "e"], ["left", "Preostalo", 90, "e"],
    ["price", "€/jed. bez PDV", 100, "e"], ["exp", "Rok", 90, "center"]], { height: 6 });
  t.setRows(r.lots.map((l) => ({ id: l.id, lot: l.lot_no, name: l.name, qty: `${fq(l.qty_received)} ${l.unit}`, left: fq(l.qty_left),
    price: fq(l.unit_price, 4), exp: d2ui(l.expiry_date) })));
  const other = (r.lines || []).filter((l) => l.skip);
  d.body.append(h("div", { class: "sec" }, r.lots.length ? "Zaprimljena roba" : "Na ovom računu nije bilo robe za skladište"), r.lots.length ? t.el : null,
    other.length ? h("div", { class: "muted", style: { marginTop: "6px", fontSize: "12.5px" } }, "Ne ide na skladište: " + other.map((l) => `${l.name} (${eur(l.amount)} €)`).join(", ")) : null,
    r.note ? h("p", {}, r.note) : null);
  d.bar.append(btn("📄 Datoteka računa", () => showInvoiceFile(r), "ghost"),
    btn("✎ Uredi podatke", async () => { d.close(); await editInvoice(app, id); }, "ghost"),
    btn("Zatvori", () => d.close(), "primary"));
  await d.show();
}

async function editInvoice(app, id) {
  const r = app.py.call("web_invoices.invoice", id);
  const v = await askForm(`Račun ${r.inv_no}`, [
    { key: "inv_no", label: "Broj računa", required: true }, { key: "inv_date", label: "Datum računa", type: "date" },
    { key: "due_date", label: "Dospijeće", type: "date" }, { key: "total", label: "Iznos za platiti €", type: "num", min: 0 },
    { key: "iban", label: "IBAN dobavljača" }, { key: "ref", label: "Poziv na broj (npr. HR00 2026-123)" },
    { key: "paid_date", label: "Plaćeno (datum)", type: "date" }, { key: "note", label: "Napomena", type: "multi", full: true }],
  { ...r, ref: [r.pay_model, r.pay_ref].filter(Boolean).join(" ") }, { columns: 2 });
  if (!v) return false;
  const m = (v.ref || "").trim().match(/^(HR\d{2})\s*(.*)$/i);
  v.pay_model = m ? m[1].toUpperCase() : (v.ref ? "HR00" : null);
  v.pay_ref = m ? m[2] : (v.ref || null);
  delete v.ref;
  app.py.call("web_invoices.update_invoice", id, v);
  toast("Račun spremljen.");
  return true;
}

async function payDialog(app, id) {
  let p;
  try { p = await busy("Pripremam barkod…", async () => { await app.py.ensureDocs(); return app.py.call("web_invoices.pay_code", id); }); } catch (e) { return error(e.message); }
  const d = new Dialog("Plaćanje računa", { width: 560 });
  const row = (k, v) => h("div", { class: "row gap", style: { margin: "3px 0" } }, h("span", { class: "muted", style: { width: "110px" } }, k), h("b", { style: { flex: 1 } }, v),
    btn("Kopiraj", () => { navigator.clipboard && navigator.clipboard.writeText(String(v)); toast("Kopirano."); }, "ghost"));
  d.body.append(h("div", { class: "muted", style: { fontSize: "12.5px" } }, p.foreign
    ? "Dobavljač je u inozemstvu – barkod za „Slikaj i plati” vrijedi samo za hrvatske račune. U mobilnom bankarstvu napravite SEPA nalog i prepišite (kopirajte) podatke ispod."
    : "Skenirajte barkod aplikacijom mobilnog bankarstva (Plaćanje → Slikaj i plati). Na mobitelu podatke možete kopirati."),
    p.png ? h("div", { style: { textAlign: "center", margin: "10px 0", background: "#fff", padding: "10px", borderRadius: "8px" } },
      h("img", { src: p.png, alt: "HUB3 barkod", style: { maxWidth: "100%", imageRendering: "pixelated" } })) : null,
    row("Primatelj", p.recipient), row("IBAN", p.iban), row("Iznos", eur(p.amount) + " €"), row("Model", p.model), row("Poziv na broj", p.ref || "—"), row("Opis", p.desc));
  let paid = false;
  d.bar.append(btn("Zatvori", () => d.close(), "ghost"), btn("✔ Plaćeno danas", () => { paid = true; d.close(); }, "primary"));
  await d.show();
  if (paid) { app.py.call("web_invoices.set_paid", [id], today()); toast("Označeno kao plaćeno."); }
  return paid;
}

// ------------------------------------------------------------------ stranica Skladište → Računi
class InvoicesPage extends Page {
  static title = "Računi dobavljača";
  static subtitle = "Učitajte račun (PDF ili fotografiju) – program sam pripremi primku robe · svi računi na jednom mjestu";

  build() {
    this.tbtn("📄 Učitaj račun", () => this.load("file"));
    this.tbtn("📷 Slikaj račun", () => this.load("photo"), "ghost");
    this.tbtn("💳 Plati", () => this.pay(), "ghost");
    this.tbtn("👁 Pogledaj račun", () => this.file(), "ghost");
    this.tbtn("✔ Označi plaćeno", () => this.markPaid(), "ghost|rec");
    this.tbtn("✎ Uredi podatke", () => this.edit(), "ghost|rec");
    this.tbtn("🗑 Obriši", () => this.del(), "ghost|more");
    this.tbtn("📦 Računi za mjesec (ZIP)", () => this.monthZip(), "ghost|more");
    this.year = h("select", { style: { width: "auto" } });
    this.status = h("select", { style: { width: "auto" } }, ["Svi", "Neplaćeni", "Plaćeni"].map((x) => h("option", { value: x }, x)));
    this.year.addEventListener("change", () => this.refresh());
    this.status.addEventListener("change", () => this.refresh());
    this.tbRight.append(this.year, this.status);
    this.table = new Table([["date", "Primljeno", 95, "center"], ["sup", "Dobavljač", 200, "w"], ["no", "Broj računa", 130, "w"],
      ["idate", "Datum računa", 95, "center"], ["total", "Iznos €", 95, "e"], ["due", "Dospijeće", 95, "center"],
      ["status", "Plaćanje", 100, "w"], ["lots", "Roba", 70, "center"], ["file", "Datoteka", 70, "center"]],
    { onDouble: (id) => invoiceDetails(this.app, id).then(() => this.refresh()), multi: true });
    this.search(this.table);
    this.sum = h("div", { class: "muted", style: { fontSize: "12.5px", marginTop: "6px" } });
    // povuci i ispusti PDF na stranicu (računalo)
    this.drop = h("div", { class: "inv-drop" }, "Povucite PDF računa ovamo ili kliknite „Učitaj račun”. Na mobitelu: „Slikaj račun” (sve stranice).");
    this.el.addEventListener("dragover", (e) => { e.preventDefault(); this.drop.classList.add("over"); });
    this.el.addEventListener("dragleave", () => this.drop.classList.remove("over"));
    this.el.addEventListener("drop", (e) => {
      e.preventDefault(); this.drop.classList.remove("over");
      const fs = [...(e.dataTransfer.files || [])];
      if (fs.length) this.load("file", fs);
    });
    this.content.append(this.drop, this.table.el, this.sum);
  }

  refresh() {
    const py = this.app.py;
    const ys = py.call("web_invoices.years");
    const cur = this.year.value || ys[0];
    this.year.innerHTML = "";
    for (const y of ys) this.year.append(h("option", { value: y }, y));
    this.year.value = ys.includes(cur) ? cur : ys[0];
    let rows = py.call("web_invoices.invoices", this.year.value);
    this.all = rows;
    if (this.status.value === "Neplaćeni") rows = rows.filter((r) => !r.paid_date);
    if (this.status.value === "Plaćeni") rows = rows.filter((r) => r.paid_date);
    this.table.setRows(rows.map((r) => ({ id: r.id, date: d2ui(r.recv_date), sup: r.supplier || "", no: r.inv_no, idate: d2ui(r.inv_date),
      total: eur(r.total), due: d2ui(r.due_date), status: r.paid_date ? `✔ ${d2ui(r.paid_date)}` : r.status, lots: r.n_lots ? `${r.n_lots} LOT` : "—",
      file: r.file_path ? (pendingList().includes(r.file_path) ? "čeka prijenos" : "da") : "",
      _tag: r.paid_date ? "" : (r.status === "Dospjelo" ? "bad" : "") })));
    const unpaid = this.all.filter((r) => !r.paid_date);
    const late = unpaid.filter((r) => r.status === "Dospjelo");
    this.sum.textContent = this.all.length
      ? `${this.all.length} računa · neplaćeno ${unpaid.length} (${eur(unpaid.reduce((a, r) => a + (r.total || 0), 0))} €)` + (late.length ? ` · ⚠ dospjelo ${late.length}` : "") + " · dvoklik otvara račun"
      : "Još nema računa – učitajte prvi račun.";
    retryPending().then((n) => { if (n) { toast(`Preneseno ${n} datoteka računa.`); this.refresh(); } }).catch(() => {});
  }

  async load(mode, files = null) {
    const r = await newInvoice(this.app, mode, files);
    if (r) this.refresh();
  }
  sel() { return this.need(this.table, "račun"); }
  async pay() { const id = this.sel(); if (id && await payDialog(this.app, id)) this.refresh(); }
  async markPaid() {
    const ids = this.table.selectedIds();
    if (!ids.length) return info("Označite račun(e) u tablici.");
    const v = await askForm("Plaćeno", [{ key: "date", label: "Datum plaćanja", type: "date", default: today() }]);
    if (!v) return;
    this.app.py.call("web_invoices.set_paid", ids, v.date || today());
    this.refresh();
  }
  async file() { const id = this.sel(); if (id) await showInvoiceFile(this.app.py.call("web_invoices.invoice", id)); }
  async edit() { const id = this.sel(); if (id && await editInvoice(this.app, id)) this.refresh(); }
  async del() {
    const id = this.sel(); if (!id) return;
    const r = this.app.py.call("web_invoices.invoice", id);
    const opts = [["Odustani", null, "ghost"], ["Obriši samo račun", "inv", "ghost"]];
    if (r.lots.length) opts.push(["Obriši račun i poništi primku", "all", "danger"]);
    const c = await choice(`Račun ${r.inv_no} (${r.supplier}).` + (r.lots.length ? `\n\nS njim je zaprimljeno ${r.lots.length} LOT-ova. „Poništi primku” briše i te LOT-ove (samo ako roba još nije potrošena).` : ""), "Brisanje računa", opts);
    if (!c) return;
    try { this.app.py.call("web_invoices.delete_invoice", id, c === "all"); } catch (e) { return error(e.message); }
    this.app.refreshAll();
    toast("Račun obrisan." + (r.file_path ? " Datoteka ostaje u povijesti repozitorija." : ""));
  }
  async monthZip() {
    const now = new Date(); const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const v = await askForm("Računi za knjigovođu", [{ key: "month", label: "Mjesec (GGGG-MM)", default: `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, "0")}` }]);
    if (!v || !/^\d{4}-\d{2}$/.test(v.month || "")) return;
    const py = this.app.py;
    const list = py.call("web_invoices.month_list", v.month);
    if (!list.length) return info("U tom mjesecu nema računa.");
    const files = [];
    await busy("Preuzimam račune…", async (set) => {
      for (const [i, r] of list.entries()) {
        if (!r.file_path) continue;
        set(`Preuzimam račune… ${i + 1}/${list.length}`);
        try {
          const b = await loadInvoiceFile(r.file_path);
          if (b) { const p = `/tmp/zip/${r.file_path.split("/").pop()}`; py.writeFile(p, b); files.push([p, r.file_path.split("/").pop()]); }
        } catch (e) { console.warn(e); }
      }
    });
    await this.app.doc("web_invoices.month_zip", v.month, files);
  }
}

export const PAGES = { invoices: InvoicesPage };
