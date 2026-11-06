// Podsjetnici (Postavke → Podsjetnici): rokovi koje korisnik sam upisuje, obavijest 30 dana i 7 dana prije te na dan isteka.
import { h, Page, Table, askForm, confirm, info, error, toast, d2ui, tableDialog } from "../ui.js";

let REPEATS = null;
const repeats = (app) => REPEATS || (REPEATS = app.py.call("web_reminders.consts").repeats);

function left(days) {
  if (days < 0) return `isteklo prije ${-days} ${-days === 1 ? "dan" : "dana"}`;
  if (days === 0) return "ističe danas";
  if (days === 1) return "sutra";
  return `za ${days} dana`;
}

export class RemindersPage extends Page {
  static title = "Podsjetnici";
  static subtitle = "Rokovi koje sami upisujete (pregledi, umjeravanja, osiguranja, certifikati…) · obavijest mjesec dana i tjedan dana prije te na dan isteka";

  build() {
    this.tbtn("＋ Novi podsjetnik", () => this.edit(null));
    this.tbtn("↻ Obnovi na novi datum", () => this.renew(), "ghost|rec");
    this.tbtn("✎ Uredi", () => { const id = this.need(this.table, "podsjetnik"); if (id) return this.edit(id); }, "ghost|rec");
    this.tbtn("🕘 Povijest", () => this.history(), "ghost|rec");
    this.tbtn("🗑 Obriši", () => this.del(), "ghost|more");
    this.tbtn("📅 Preuzmi kalendar (.ics)", async () => { const m = await import("./settings.js"); await m.exportCalendar(this.app); }, "ghost|more");
    this.table = new Table([["title", "Naziv", 230, "w"], ["person", "Odnosi se na", 170, "w"], ["due", "Ističe", 100, "center"],
      ["left", "Preostalo", 150, "w"], ["repeat", "Ponavljanje", 130, "w"], ["note", "Napomena", 220, "w"]],
    { onDouble: (id) => this.edit(id) });
    this.search(this.table);
    this.hint = h("p", { class: "note" }, "Obavijest se prikazuje na nadzornoj ploči i, ako ste dopustili obavijesti, na ovom uređaju: mjesec dana prije, " +
      "tjedan dana prije i na dan isteka. Istekli podsjetnik ostaje crven dok ga ne obnovite na novi datum. " +
      "Za podsjetnik i kad program nije otvoren: ⋯ Više → Preuzmi kalendar (.ics) i uvezite ga u kalendar na mobitelu.");
    this.content.append(this.table.el, this.hint);
  }

  refresh() {
    const rows = this.app.py.call("web_reminders.reminders");
    this.table.setRows(rows.map((r) => ({ id: r.id, title: r.title, person: r.person || "", due: d2ui(r.due_date), left: left(r.days),
      repeat: r.repeat, note: r.note || "",
      _tag: r.stage === "late" || r.stage === "today" ? "bad" : r.stage === "week" ? "warn" : r.stage === "month" ? "bold" : "" })));
    if (!rows.length) this.table.tbody.querySelector("tr.empty td").textContent = "Još nema podsjetnika – kliknite „Novi podsjetnik”.";
  }

  async edit(id) {
    const py = this.app.py;
    const r = id ? py.call("web_reminders.reminders", true).find((x) => x.id === id) : null;
    if (id && !r) return;
    const v = await askForm(r ? "Uredi podsjetnik" : "Novi podsjetnik", [
      { key: "title", label: "Naziv (npr. Liječnički pregled, Umjeravanje vage, Osiguranje vozila)", required: true },
      { key: "person", label: "Odnosi se na (osoba, oprema, vozilo…)", type: "combo", editable: true, options: py.call("web_reminders.people") },
      { key: "due_date", label: "Datum isteka", type: "date", required: true },
      { key: "repeat_months", label: "Ponavljanje (za prijedlog novog datuma pri obnovi)", type: "combo", options: repeats(this.app).map(([k, l]) => [l, k]), default: 12 },
      { key: "note", label: "Napomena (neobavezno)", type: "multi", full: true }],
    r || {}, { columns: 2 });
    if (!v) return;
    try { py.call("web_reminders.save_reminder", v, id || null); } catch (e) { return error(e); }
    toast(r ? "Podsjetnik spremljen." : "Podsjetnik upisan.");
    this.app.refreshAll();
  }

  async renew() {
    const id = this.need(this.table, "podsjetnik");
    if (!id) return;
    const py = this.app.py;
    const r = py.call("web_reminders.reminders", true).find((x) => x.id === id);
    const v = await askForm("Obnovi podsjetnik", [
      { key: "info", label: "", type: "info", default: `${r.title}${r.person ? " · " + r.person : ""} – dosadašnji datum isteka ${d2ui(r.due_date)} (${left(r.days)}).` },
      { key: "new_due", label: "Novi datum isteka", type: "date", required: true },
      { key: "note", label: "Napomena (npr. obavljen pregled, novi broj police)" }],
    { new_due: py.call("web_reminders.next_date", id) }, { okText: "Obnovi" });
    if (!v) return;
    try { py.call("web_reminders.renew", id, v.new_due, v.note || null); } catch (e) { return error(e); }
    toast(`Podsjetnik obnovljen – novi datum ${d2ui(v.new_due)}.`);
    this.app.refreshAll();
  }

  async history() {
    const id = this.need(this.table, "podsjetnik");
    if (!id) return;
    const rows = this.app.py.call("web_reminders.history", id);
    await tableDialog("Povijest podsjetnika", [["ts", "Kada", 130, "center"], ["user", "Tko", 130, "w"], ["old", "Stari datum", 100, "center"],
      ["new", "Novi datum", 100, "center"], ["note", "Napomena", 220, "w"]],
    rows.map((x) => ({ id: x.id, ts: x.ts, user: x.user || "", old: d2ui(x.old_due), new: d2ui(x.new_due), note: x.note || "" })), { width: 760 });
  }

  async del() {
    const id = this.need(this.table, "podsjetnik");
    if (!id) return;
    const r = this.app.py.call("web_reminders.reminders", true).find((x) => x.id === id);
    if (!(await confirm(`Obrisati podsjetnik „${r.title}”? Ako se rok ponavlja, umjesto brisanja ga obnovite na novi datum.`, "Brisanje", { danger: true }))) return;
    this.app.py.call("web_reminders.delete_reminder", id);
    this.app.refreshAll();
  }
}

// Obavijest na uređaju (jednom po fazi: mjesec dana, tjedan dana, na dan isteka, isteklo)
export function notifyReminders(app, due) {
  const N = window.Notification;
  if (!N || N.permission !== "granted") return;
  for (const r of due) {
    const key = `rem_notif_${r.id}_${r.due_date}_${r.stage}`;
    try { if (localStorage.getItem(key)) continue; localStorage.setItem(key, "1"); } catch { continue; }
    const title = r.stage === "late" ? "Rok je istekao" : r.stage === "today" ? "Rok ističe danas" : r.stage === "week" ? "Rok ističe za tjedan dana" : "Rok ističe za mjesec dana";
    const opts = { body: r.message, icon: "icons/icon-192.png", tag: key };
    navigator.serviceWorker?.getRegistration().then((reg) => reg ? reg.showNotification(title, opts) : new N(title, opts)).catch(() => {});
  }
}

export const PAGES = { reminders: RemindersPage };
