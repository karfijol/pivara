// Google kalendar: najave kušanja se upisuju, mijenjaju i brišu izravno u kalendaru (Google Calendar API).
// Prijava preko Google Identity Services (OAuth u pregledniku): Client ID upisuje se u Postavke → Prodaja i ponude.
import { h, btn, info, toast, Dialog } from "./ui.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/";
let gisReady = null, tokenClient = null, tokenClientId = null;
let TOKEN = null; // { token, until }
let askConsent = false; // ponovno traži dopuštenje (korisnik nije označio kalendar)
try { const t = JSON.parse(sessionStorage.getItem("gcal_token") || "null"); if (t && t.until > Date.now()) TOKEN = t; } catch { /* */ }

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gisReady) {
    gisReady = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => res(); s.onerror = () => { gisReady = null; rej(new Error("Google prijava se ne može učitati (nema interneta?).")); };
      document.head.append(s);
    });
  }
  return gisReady;
}

export function settings(app) {
  return { clientId: (app.db.get_setting("gcal_client_id") || "").trim(), calId: (app.db.get_setting("gcal_calendar_id") || "").trim() || "primary" };
}
export function configured(app) { return !!settings(app).clientId; }
export function connected() { return !!(TOKEN && TOKEN.until > Date.now() + 60000); }

// pripremi Google prijavu unaprijed (da se prozor za prijavu otvori odmah na klik)
export async function prepare(app) {
  const { clientId } = settings(app);
  if (!clientId) return false;
  await loadGis();
  if (!tokenClient || tokenClientId !== clientId) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
    tokenClientId = clientId;
  }
  return true;
}

// prijava – poziva se na klik korisnika (preglednik inače blokira prozor za prijavu)
export function connect(app) {
  return new Promise((resolve, reject) => {
    const go = () => {
      tokenClient.callback = (r) => {
        if (r && r.access_token && window.google.accounts.oauth2.hasGrantedAllScopes && !window.google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
          askConsent = true;
          reject(new Error("Google nije dao dopuštenje za kalendar. Kliknite ponovno i u Googleovom prozoru označite kvačicu „Pregled i uređivanje događaja u svim vašim kalendarima” (View and edit events)."));
        } else if (r && r.access_token) {
          askConsent = false;
          TOKEN = { token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          try { sessionStorage.setItem("gcal_token", JSON.stringify(TOKEN)); } catch { /* */ }
          resolve(true);
        } else reject(new Error((r && (r.error_description || r.error)) || "Google prijava nije uspjela."));
      };
      tokenClient.error_callback = (e) => reject(new Error(e && e.type === "popup_closed" ? "Prozor za Google prijavu je zatvoren." : "Preglednik je blokirao prozor za Google prijavu – dopustite skočne prozore za ovu stranicu."));
      tokenClient.requestAccessToken({ prompt: askConsent ? "consent" : "" });
    };
    if (tokenClient && tokenClientId === settings(app).clientId) go();
    else prepare(app).then(go).catch(reject);
  });
}

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: "Bearer " + TOKEN.token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { TOKEN = null; try { sessionStorage.removeItem("gcal_token"); } catch { /* */ } const e = new Error("Google prijava je istekla – kliknite „Pošalji u Google kalendar”."); e.relogin = true; throw e; }
  if (r.status === 404 || r.status === 410) return { gone: true };
  if (r.status === 403) {
    let m = ""; try { m = (await r.json()).error.message; } catch { /* */ }
    if (/scope/i.test(m)) {
      TOKEN = null; askConsent = true; try { sessionStorage.removeItem("gcal_token"); } catch { /* */ }
      throw new Error("Google nije dao dopuštenje za kalendar. Kliknite ponovno „Poveži i provjeri” i u Googleovom prozoru označite kvačicu za uređivanje događaja u kalendaru.");
    }
    throw new Error(`Google kalendar: greška 403${m ? " – " + m : ""}`);
  }
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch { /* */ } throw new Error(`Google kalendar: greška ${r.status}${m ? " – " + m : ""}`); }
  return r.status === 204 ? {} : r.json();
}

function addMin(date, time, min) {
  const [y, mo, d] = date.split("-").map(Number), [hh, mm] = (time || "00:00").split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, hh, mm) + min * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}
const COLOR = { Najavljeno: "5", "Potvrđeno": "10", "Održano": "8" }; // žuta, zelena, siva

function eventOf(b) {
  const desc = [b.status && `Status: ${b.status}`, b.people && `Broj osoba: ${b.people}`, b.package && `Vrsta: ${b.package}`,
    b.contact && `Kontakt: ${b.contact}`, b.phone && `Telefon: ${b.phone}`, b.email && `E-mail: ${b.email}`,
    b.price_pp && `Cijena po osobi: ${String(b.price_pp).replace(".", ",")} €` + (b.people ? ` (ukupno ${String(Math.round(b.price_pp * b.people * 100) / 100).replace(".", ",")} €)` : ""),
    b.no_alcohol && `Od toga bez alkohola: ${b.no_alcohol}`, b.language && `Jezik: ${b.language}`,
    b.space && `Prostor: ${b.space}`, b.staff && `Vodi: ${b.staff}`, b.source && `Izvor: ${b.source}`,
    b.company && `Tvrtka: ${b.company}${b.company_oib ? `, OIB ${b.company_oib}` : ""}${b.company_address ? `, ${b.company_address}` : ""}`,
    b.deposit && `Predujam: ${String(b.deposit).replace(".", ",")} €`, (b.pay_status || b.pay_method) && `Plaćanje: ${[b.pay_status, b.pay_method].filter(Boolean).join(", ")}`,
    b.note && `Napomena: ${b.note}`].filter(Boolean).join("\n");
  const ev = { summary: `🍺 ${b.package || "Rezervacija"}: ${b.group_name}${b.people ? ` (${b.people} os.)` : ""}${b.staff ? ` – ${b.staff}` : ""}${b.status === "Najavljeno" ? " – nepotvrđeno" : ""}`,
    description: desc, colorId: COLOR[b.status] || "5", location: b.space || "",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 120 }] },
    extendedProperties: { private: { pivovaraBooking: String(b.id) } } };
  if (b.time) {
    ev.start = { dateTime: `${b.date}T${b.time}:00`, timeZone: "Europe/Zagreb" };
    ev.end = { dateTime: addMin(b.date, b.time, b.duration_min || 120), timeZone: "Europe/Zagreb" };
  } else {
    const d = new Date(b.date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
    ev.start = { date: b.date }; ev.end = { date: d.toISOString().slice(0, 10) };
  }
  return ev;
}

// pošalji sve izmijenjene najave; vraća { done, failed }
export async function syncAll(app) {
  if (!connected()) throw Object.assign(new Error("Niste prijavljeni u Google kalendar."), { relogin: true });
  const { calId } = settings(app);
  const base = API + encodeURIComponent(calId) + "/events";
  const list = app.py.call("web_bookings.pending");
  let done = 0; const failed = [];
  for (const b of list) {
    try {
      const remove = b.deleted || b.status === "Otkazano";
      if (remove) {
        if (b.gcal_id) await call("DELETE", `${base}/${encodeURIComponent(b.gcal_id)}`);
        app.py.call("web_bookings.mark_synced", b.id, null, true);
      } else if (b.gcal_id) {
        const r = await call("PUT", `${base}/${encodeURIComponent(b.gcal_id)}`, eventOf(b));
        if (r.gone) { const n = await call("POST", base, eventOf(b)); app.py.call("web_bookings.mark_synced", b.id, n.id, false); }
        else app.py.call("web_bookings.mark_synced", b.id, b.gcal_id, false);
      } else {
        const n = await call("POST", base, eventOf(b));
        app.py.call("web_bookings.mark_synced", b.id, n.id, false);
      }
      done++;
    } catch (e) { if (e.relogin) throw e; failed.push(`${b.group_name}: ${e.message}`); }
  }
  return { done, failed };
}

// nakon spremanja najave: pošalji odmah ako je veza aktivna (inače čeka tipku „Pošalji u Google kalendar”)
export async function syncQuiet(app) {
  if (!configured(app) || !connected()) return null;
  try { return await syncAll(app); } catch (e) { console.warn(e); return null; }
}

// tipka „Pošalji u Google kalendar” (klik korisnika: po potrebi otvara Google prijavu)
export async function syncClick(app) {
  if (!configured(app)) return setupHelp(app);
  try {
    if (!connected()) await connect(app);
    const r = await syncAll(app);
    if (r.failed.length) await info(`Poslano: ${r.done}. Nije uspjelo:\n` + r.failed.join("\n"), "Google kalendar");
    else toast(r.done ? `Google kalendar ažuriran (${r.done}).` : "Google kalendar je već ažuran.");
    return r;
  } catch (e) { await info(e.message, "Google kalendar"); return null; }
}

export function setupHelp(app) {
  const d = new Dialog("Povezivanje s Google kalendarom", { width: 680 });
  const origin = location.origin;
  d.body.append(h("div", { class: "msg" },
    "Jednokratno postavljanje (oko 15 minuta), na Google računu čiji kalendar koristite:\n\n" +
    "1. Otvorite console.cloud.google.com → gore „Select a project” → „New project” → naziv npr. Pivovara → Create.\n" +
    "2. Izbornik → APIs & Services → Library → potražite „Google Calendar API” → Enable.\n" +
    "3. APIs & Services → OAuth consent screen (Google Auth Platform) → Get started: naziv aplikacije (npr. Pivovara), vaš e-mail, " +
    "Audience: External → Create. Zatim Audience → Test users → Add users → upišite svoj Gmail (i Gmail kolega koji će slati najave).\n" +
    "4. APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: Web application → " +
    `Authorized JavaScript origins → Add URI: ${origin} → Create.\n` +
    "5. Kopirajte „Client ID” (završava s .apps.googleusercontent.com) i upišite ga u Postavke → Prodaja i ponude → Google kalendar.\n" +
    "6. Kalendar: prazno = vaš glavni kalendar. Za poseban kalendar (preporuka: „Rezervacije”, koji možete podijeliti s osobljem) " +
    "u Google kalendaru otvorite njegove postavke → „Integrate calendar” → kopirajte „Calendar ID”.\n" +
    "7. Kliknite „Poveži i provjeri”. Prvi put Google pita za dopuštenje (može pisati da aplikacija nije provjerena – kliknite Continue/Nastavi)."));
  d.buttons(null, null, "Zatvori");
  d.bar.prepend(btn("Otvori Google Cloud", () => window.open("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com", "_blank"), "ghost"),
    btn("Postavke", () => { d.close(null); app.show("settings"); }, "primary"));
  return d.show();
}

// provjera veze (Postavke): prijava + čitanje kalendara
export async function testCalendar(app) {
  if (!configured(app)) return "Upišite Google Client ID i kliknite Spremi.";
  try {
    if (!connected()) await connect(app);
    const { calId } = settings(app);
    const r = await call("GET", API + encodeURIComponent(calId) + "/events?maxResults=1");
    if (r.gone) return "✗ Kalendar nije pronađen – provjerite Calendar ID (ili ostavite prazno za glavni kalendar).";
    return `✓ Povezano s kalendarom „${r.summary || calId}”. Najave se šalju automatski.`;
  } catch (e) { return "✗ " + e.message; }
}
