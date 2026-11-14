// Kušanja: najave grupa koje dolaze na kušanje piva; svaka najava se upisuje u Google kalendar.
import { h, btn, Page, Table, askForm, confirm, info, error, toast, fq, d2ui, today } from "../ui.js";
import * as gcal from "../gcal.js";

const DAYS = ["ned", "pon", "uto", "sri", "čet", "pet", "sub"];
const eur = (x) => (x || x === 0 ? Number(x).toLocaleString("hr-HR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" : "");

export class BookingsPage extends Page {
  static title = "Kušanja i grupe";
  static subtitle = "Najave grupa za kušanje piva · svaka najava se automatski upisuje u Google kalendar";

  build() {
    this.tbtn("＋ Nova najava", () => this.edit(null));
    this.tbtn("✎ Uredi", () => { const id = this.need(this.table, "najavu"); if (id) return this.edit(id); }, "ghost|rec");
    this.tbtn("✔ Potvrđeno", () => this.status("Potvrđeno"), "ghost|rec");
    this.tbtn("🍺 Održano", () => this.status("Održano"), "ghost|rec");
    this.tbtn("✕ Otkaži", () => this.status("Otkazano"), "ghost|rec");
    this.tbtn("🗑 Obriši", () => this.del(), "ghost|more");
    this.tbtn("📅 Pošalji u Google kalendar", () => this.sync(), "ghost|more");
    this.tbtn("Izvoz CSV", () => this.table.exportCsv("kusanja"), "ghost|more");
    this.past = h("input", { type: "checkbox", onchange: () => this.refresh() });
    this.tb.insertBefore(h("label", { class: "chk", style: { marginLeft: "8px" } }, this.past, " Prikaži i prošla"), this.tbRight);
    this.calBar = h("div", { class: "banner warn", style: { display: "none" } });
    this.table = new Table([["date", "Datum", 120, "w"], ["time", "Vrijeme", 70, "center"], ["group", "Grupa", 200, "w"],
      ["people", "Osoba", 60, "e"], ["contact", "Kontakt", 170, "w"], ["package", "Vrsta", 170, "w"], ["total", "Iznos", 90, "e"],
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
      return { id: b.id, date: `${DAYS[d.getDay()]} ${d2ui(b.date)}`, time: b.time || "", group: b.group_name, people: b.people || "",
        contact: [b.contact, b.phone].filter(Boolean).join(" · "), package: b.package || "", total: b.total ? eur(b.total) : "",
        status: b.status, cal: b.gcal_dirty ? (gcal.configured(this.app) ? "čeka" : "—") : (b.gcal_id ? "✓" : ""), note: b.note || "",
        _tag: b.status === "Otkazano" ? "muted" : b.days === 0 ? "bad" : b.days > 0 && b.days <= 3 ? "warn" : b.status === "Potvrđeno" ? "ok" : "" };
    }));
    if (!rows.length) this.table.tbody.querySelector("tr.empty td").textContent = "Nema najavljenih kušanja – kliknite „Nova najava”.";
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
    const v = await askForm(b ? `Najava – ${b.group_name}` : "Nova najava kušanja", [
      { key: "date", label: "Datum", type: "date", required: true },
      { key: "time", label: "Vrijeme dolaska", type: "time" },
      { key: "duration_min", label: "Trajanje (min)", type: "num", min: 0 },
      { key: "group_name", label: "Grupa (naziv ili ime)", required: true },
      { key: "people", label: "Broj osoba", type: "num", min: 0 },
      { key: "package", label: "Vrsta kušanja", type: "combo", editable: true, options: c.packages },
      { key: "contact", label: "Kontakt osoba" },
      { key: "phone", label: "Telefon" },
      { key: "email", label: "E-mail" },
      { key: "price_pp", label: "Cijena po osobi (€)", type: "num", min: 0 },
      { key: "deposit", label: "Plaćeni predujam (€)", type: "num", min: 0 },
      { key: "status", label: "Status", type: "combo", options: c.statuses },
      { key: "note", label: "Napomena (alergije, jezik, posebne želje…)", type: "multi", full: true }],
    b || { date: today(), time: "18:00", duration_min: 120, status: "Najavljeno", package: c.packages[0] }, { columns: 3, width: 900 });
    if (!v) return;
    try { py.call("web_bookings.save", v, id || null); } catch (e) { return error(e); }
    await this.afterChange(b ? "Najava spremljena" : "Najava upisana");
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
