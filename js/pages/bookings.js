// Kušanja: najave grupa koje dolaze na kušanje piva; svaka najava se upisuje u Google kalendar.
import { h, btn, Page, Table, askForm, confirm, info, error, toast, fq, d2ui, today } from "../ui.js";
import * as gcal from "../gcal.js";
import { oibButton } from "../oib.js";

const DAYS = ["ned", "pon", "uto", "sri", "čet", "pet", "sub"];
const eur = (x) => (x || x === 0 ? Number(x).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "");

export class BookingsPage extends Page {
  static title = "Rezervacije";
  static subtitle = "Rezervacije grupa za kušanje i druge dolaske · svaka se automatski upisuje u Google kalendar";

  build() {
    this.tbtn("＋ Nova rezervacija", () => this.edit(null));
    this.tbtn("✎ Uredi", () => { const id = this.need(this.table, "najavu"); if (id) return this.edit(id); }, "ghost|rec");
    this.tbtn("✔ Potvrđeno", () => this.status("Potvrđeno"), "ghost|rec");
    this.tbtn("🍺 Održano", () => this.status("Održano"), "ghost|rec");
    this.tbtn("✕ Otkaži", () => this.status("Otkazano"), "ghost|rec");
    this.tbtn("🗑 Obriši", () => this.del(), "ghost|more");
    this.tbtn("📅 Pošalji u Google kalendar", () => this.sync(), "ghost|more");
    this.tbtn("Izvoz CSV", () => this.table.exportCsv("rezervacije"), "ghost|more");
    this.past = h("input", { type: "checkbox", onchange: () => this.refresh() });
    this.tb.insertBefore(h("label", { class: "chk", style: { marginLeft: "8px" } }, this.past, " Prikaži i prošla"), this.tbRight);
    this.calBar = h("div", { class: "banner warn", style: { display: "none" } });
    this.table = new Table([["date", "Datum", 120, "w"], ["time", "Vrijeme", 70, "center"], ["group", "Grupa", 200, "w"],
      ["people", "Osoba", 90, "e"], ["contact", "Kontakt", 170, "w"], ["package", "Vrsta", 170, "w"], ["total", "Iznos", 90, "e"],
      ["space", "Prostor", 110, "w"], ["staff", "Zadužen", 120, "w"], ["pay", "Plaćanje", 110, "w"],
      ["status", "Status", 100, "w"], ["cal", "Kalendar", 90, "center"], ["note", "Napomena", 200, "w"]],
    { onDouble: (id) => this.edit(id) });
    this.search(this.table);
    this.sum = h("div", { class: "muted", style: { margin: "6px 2px" } });
    this.content.append(this.calBar, this.table.el, this.sum);
    gcal.prepare(this.app).catch(() => {});
  }

  refresh() {
    const rows = this.app.py.call("web_bookings.bookings", this.past.checked);
    this.table.setRows(rows.map((b) => {
      const d = new Date(b.date + "T00:00:00");
      return { id: b.id, date: `${DAYS[d.getDay()]} ${d2ui(b.date)}`, time: b.time || "", group: b.group_name + (b.company ? ` · ${b.company}` : "") + (b.language && b.language !== "Hrvatski" ? ` · ${b.language}` : ""),
        people: (b.people || "") + (b.no_alcohol ? ` (${b.no_alcohol} bez alk.)` : ""), space: b.space || "", staff: b.staff || "",
        pay: [b.pay_status, b.pay_method].filter(Boolean).join(" · "),
        contact: [b.contact, b.phone].filter(Boolean).join(" · "), package: b.package || "", total: b.total ? eur(b.total) : "",
        status: b.status, cal: b.gcal_dirty ? (gcal.configured(this.app) ? "čeka" : "—") : (b.gcal_id ? "✓" : ""), note: b.note || "",
        _tag: b.status === "Otkazano" ? "muted" : b.days === 0 ? "bad" : b.days > 0 && b.days <= 3 ? "warn" : b.status === "Potvrđeno" ? "ok" : "" };
    }));
    if (!rows.length) this.table.tbody.querySelector("tr.empty td").textContent = "Nema rezervacija – kliknite „Nova rezervacija”.";
    const act = rows.filter((b) => b.status !== "Otkazano");
    this.sum.textContent = act.length ? `${act.length} najav${act.length === 1 ? "a" : "e"} · ${act.reduce((a, b) => a + (b.people || 0), 0)} osoba · ${eur(act.reduce((a, b) => a + (b.total || 0), 0))}` : "";
    this.renderCalBar();
  }

  renderCalBar() {
    const n = this.app.py.call("web_bookings.pending").length;
    this.calBar.innerHTML = "";
    if (!gcal.configured(this.app)) {
      this.calBar.style.display = "";
      this.calBar.className = "banner warn";
      this.calBar.append(h("span", {}, "Google kalendar još nije povezan – najave se spremaju samo u program."), btn("Kako povezati", () => gcal.setupHelp(this.app), "ghost"));
      return;
    }
    if (n) {
      this.calBar.style.display = "";
      this.calBar.className = "banner warn";
      this.calBar.append(h("span", {}, `${n} najav${n === 1 ? "a čeka" : "e čekaju"} slanje u Google kalendar.`), btn("📅 Pošalji sada", () => this.sync(), "primary"));
    } else this.calBar.style.display = "none";
  }

  async sync() {
    await gcal.syncClick(this.app);
    this.refresh();
  }

  async afterChange(msg) {
    this.app.refreshAll();
    const r = await gcal.syncQuiet(this.app);
    this.refresh();
    toast(msg + (r && r.done ? " · upisano u Google kalendar" : gcal.configured(this.app) ? " · kliknite „Pošalji sada” za Google kalendar" : ""));
  }

  async edit(id) {
    const py = this.app.py;
    const c = py.call("web_bookings.consts");
    const b = id ? py.call("web_bookings.booking", id) : null;
    if (id && !b) return;
    // izbornik + „Upiši drugo…” (slobodan tekst)
    const pick = (key, label, options, title) => ({ key, label, type: "combo", options, addNewLabel: "✎ Upiši drugo…",
      addNew: async () => { const v = await askForm(title || label, [{ key: "t", label, required: true }], {}, { okText: "U redu" }); return v && v.t ? v.t.trim() : null; } });
    const fields = [
      { label: "Termin", type: "section" },
      { key: "date", label: "Datum", type: "date", required: true },
      { key: "time", label: "Vrijeme dolaska", type: "time" },
      { key: "duration_min", label: "Trajanje (min)", type: "num", min: 0 },
      pick("space", "Prostor", c.spaces),
      pick("staff", "Zadužen (vodi kušanje)", c.staff, "Zaduženi djelatnik"),
      { key: "status", label: "Status", type: "combo", options: c.statuses },
      { label: "Grupa", type: "section" },
      { key: "group_name", label: "Grupa (naziv ili ime)", required: true },
      { key: "people", label: "Broj osoba", type: "num", min: 0 },
      { key: "no_alcohol", label: "Od toga bez alkohola (vozači, djeca…)", type: "num", min: 0 },
      pick("package", "Vrsta kušanja", c.packages, "Vrsta kušanja"),
      pick("language", "Jezik grupe", c.languages),
      pick("source", "Izvor rezervacije", c.sources),
      { label: "Kontakt i tvrtka (za R1 račun)", type: "section" },
      { key: "contact", label: "Kontakt osoba" },
      { key: "phone", label: "Telefon" },
      { key: "email", label: "E-mail" },
      { key: "company", label: "Tvrtka / agencija" },
      { key: "company_oib", label: "OIB tvrtke" },
      { key: "company_address", label: "Adresa tvrtke" },
      { label: "Cijena i plaćanje", type: "section" },
      { key: "price_pp", label: "Cijena po osobi (€)", type: "num", min: 0 },
      { key: "deposit", label: "Plaćeni predujam (€)", type: "num", min: 0 },
      pick("pay_method", "Način plaćanja", c.pay_methods),
      { key: "pay_status", label: "Plaćanje", type: "combo", options: c.pay_status },
      { key: "note", label: "Napomena (alergije, posebne želje…)", type: "multi", full: true }];
    const onReady = (f) => {
      f.w.company_oib.el.parentElement.append(h("div", { class: "row gap", style: { marginTop: "4px" } },
        oibButton(this.app, () => f.w.company_oib.get(), (r) => {
          f.w.company.set(r.name); f.w.company_oib.set(r.oib);
          f.w.company_address.set(r.address || [r.street, [r.postal, r.city].filter(Boolean).join(" ")].filter(Boolean).join(", "));
        })));
    };
    const init = b || { date: today(), time: "18:00", duration_min: 120, status: "Najavljeno", package: c.packages[0], language: c.languages[0], pay_status: c.pay_status[0] };
    const v = await askForm(b ? `Rezervacija – ${b.group_name}` : "Nova rezervacija", fields, init, { columns: 3, width: 960, onReady });
    if (!v) return;
    // preklapanje s drugim rezervacijama i kapacitet prostora
    if (v.status !== "Otkazano") {
      const k = py.call("web_bookings.conflicts", v, id || null);
      if (k.overlap.length || k.over) {
        const list = k.overlap.map((o) => `• ${o.time || "cijeli dan"} – ${o.group_name}${o.people ? `, ${o.people} os.` : ""}${o.space ? ` (${o.space})` : ""}`).join("\n");
        const msg = (k.overlap.length ? `U isto vrijeme${v.space ? ` u prostoru „${v.space}”` : ""} već ${k.overlap.length === 1 ? "je rezervacija" : "su rezervacije"}:\n${list}\n\n` : "")
          + (k.capacity ? `Ukupno gostiju u isto vrijeme: ${k.people} (kapacitet ${k.capacity})${k.over ? " – KAPACITET JE PREMAŠEN." : "."}\n\n` : "")
          + "Spremiti rezervaciju svejedno?";
        if (!(await confirm(msg, "Preklapanje rezervacija", { ok: "Spremi svejedno", cancel: "Vrati se" }))) return this.edit(id);
      }
    }
    try { py.call("web_bookings.save", v, id || null); } catch (e) { return error(e); }
    await this.afterChange(b ? "Rezervacija spremljena" : "Rezervacija upisana");
  }

  async status(st) {
    const id = this.need(this.table, "najavu");
    if (!id) return;
    const b = this.app.py.call("web_bookings.booking", id);
    if (st === "Otkazano" && !(await confirm(`Otkazati kušanje „${b.group_name}” (${d2ui(b.date)})?\n\nDogađaj se briše iz Google kalendara, a najava ostaje u programu kao otkazana.`, "Otkazivanje", { ok: "Otkaži" }))) return;
    this.app.py.call("web_bookings.set_status", id, st);
    await this.afterChange(`Status: ${st}`);
  }

  async del() {
    const id = this.need(this.table, "najavu");
    if (!id) return;
    const b = this.app.py.call("web_bookings.booking", id);
    if (!(await confirm(`Obrisati najavu „${b.group_name}” (${d2ui(b.date)})?${b.gcal_id ? "\n\nDogađaj se briše i iz Google kalendara." : ""}`, "Brisanje", { danger: true, ok: "Obriši" }))) return;
    this.app.py.call("web_bookings.delete", id);
    await this.afterChange("Najava obrisana");
  }
}

export const PAGES = { bookings: BookingsPage };
