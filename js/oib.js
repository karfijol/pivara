// Pretraga po OIB-u u Sudskom registru (Portal otvorenih podataka Sudskog registra, sudreg-data.gov.hr).
// Pristup je besplatan uz registraciju: korisnik dobije Client ID i Client Secret i upiše ih u Postavke → Ponude.
// Obrtni registar nema javno sučelje (API) – obrti se upisuju ručno.
import { h, btn, info, toast, Dialog } from "./ui.js";

const API = "https://sudreg-data.gov.hr/api/javni";
const TOKEN_URL = "https://sudreg-data.gov.hr/api/oauth/token";
let TOKEN = null; // { key, token, until }

// kontrolna znamenka OIB-a (ISO 7064, MOD 11,10)
export function oibValid(oib) {
  const s = String(oib || "").replace(/\s/g, "");
  if (!/^\d{11}$/.test(s)) return false;
  let a = 10;
  for (let i = 0; i < 10; i++) { a = (a + Number(s[i])) % 10; if (a === 0) a = 10; a = (a * 2) % 11; }
  let k = 11 - a; if (k === 10) k = 0;
  return k === Number(s[10]);
}

async function token(id, secret) {
  const key = id + ":" + secret;
  if (TOKEN && TOKEN.key === key && TOKEN.until > Date.now() + 30000) return TOKEN.token;
  const form = `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`;
  let r = null;
  try { r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form }); } catch { r = null; }
  if (!r || !r.ok) { // drugi način prijave: pristupni podaci u zaglavlju (Basic)
    try { r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(key) }, body: "grant_type=client_credentials" }); } catch { /* */ }
  }
  if (!r) throw new Error("Sudski registar nije dostupan (nema veze s internetom ili je servis privremeno nedostupan).");
  if (r.status === 401 || r.status === 400) throw new Error("Sudski registar je odbio pristupne podatke – provjerite Client ID i Client Secret (Postavke → Ponude).");
  if (!r.ok) throw new Error(`Sudski registar: greška ${r.status} pri prijavi.`);
  const j = await r.json();
  TOKEN = { key, token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return TOKEN.token;
}

// vraća { oib, name, street, postal, city, address, status, form } ili null (nije u sudskom registru)
export async function lookupOib(app, oib) {
  const s = String(oib || "").replace(/\s/g, "");
  if (!oibValid(s)) throw new Error("OIB nije ispravan (mora imati 11 znamenki i ispravnu kontrolnu znamenku).");
  const id = (app.db.get_setting("sudreg_client_id") || "").trim(), secret = (app.db.get_setting("sudreg_client_secret") || "").trim();
  if (!id || !secret) { const e = new Error("NOCREDS"); e.noCreds = true; throw e; }
  const t = await token(id, secret);
  let r;
  try {
    r = await fetch(`${API}/detalji_subjekta?tip_identifikatora=oib&identifikator=${s}&expand_relations=true&no_data_error=0`,
      { headers: { Authorization: "Bearer " + t, Accept: "application/json" } });
  } catch { throw new Error("Sudski registar nije dostupan (nema veze s internetom ili je servis privremeno nedostupan)."); }
  if (r.status === 401) { TOKEN = null; throw new Error("Prijava u Sudski registar je istekla – pokušajte ponovno."); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Sudski registar: greška ${r.status}.`);
  const j = await r.json();
  if (!j || !j.tvrtka) return null;
  const sj = j.sjediste || {};
  const broj = [sj.kucni_broj, sj.kucni_podbroj].filter((x) => x !== undefined && x !== null && x !== "").join("");
  const street = [sj.ulica, broj].filter(Boolean).join(" ").trim();
  const city = sj.naziv_naselja || sj.naselje_van_sifrarnika || sj.naziv_opcine || "";
  const postal = sj.postanski_broj ? String(sj.postanski_broj) : "";
  const name = (j.tvrtka.ime || "").trim();
  return { oib: s, name, short: j.skracena_tvrtka && j.skracena_tvrtka.ime, street, postal, city,
    address: [street, [postal, city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    status: j.status, form: j.pravni_oblik && (j.pravni_oblik.vrsta_pravnog_oblika ? j.pravni_oblik.vrsta_pravnog_oblika.naziv : "") };
}

// upute kad pristupni podaci nisu upisani
export async function credsHelp(app) {
  const d = new Dialog("Pretraga po OIB-u – Sudski registar", { width: 560 });
  d.body.append(h("div", { class: "msg" },
    "Podaci tvrtki (d.o.o., j.d.o.o., d.d., udruge u sudskom registru) preuzimaju se s Portala otvorenih podataka Sudskog registra. " +
    "Pristup je besplatan, ali traži jednokratnu registraciju:\n\n" +
    "1. Otvorite sudreg-data.gov.hr i kliknite „Registracija”.\n" +
    "2. Potvrdite e-mail adresu – otvorit će se stranica s pristupnim podacima (Client ID i Client Secret).\n" +
    "3. Upišite ih u Postavke → Ponude → „Sudski registar – pretraga po OIB-u”.\n\n" +
    "Obrtni registar nema javno sučelje za programe – podatke obrta upišite ručno (provjera: pretrazivac-obrta.gov.hr)."));
  d.buttons(null, null, "Zatvori");
  d.bar.prepend(btn("Otvori sudreg-data.gov.hr", () => window.open("https://sudreg-data.gov.hr/", "_blank"), "ghost"),
    btn("Postavke", () => { d.close(null); app.show("settings"); }, "primary"));
  return d.show();
}

// tipka „Pretraži” uz polje OIB; fill(res) upisuje podatke u obrazac
export function oibButton(app, getOib, fill) {
  const b = btn("🔍 Pretraži registar", async () => {
    const oib = String(getOib() || "").trim();
    if (!oib) return info("Upišite OIB pa kliknite „Pretraži registar”.", "Pretraga po OIB-u");
    b.disabled = true; const old = b.textContent; b.textContent = "Tražim…";
    try {
      const r = await lookupOib(app, oib);
      if (!r) {
        await info("Subjekt s tim OIB-om nije pronađen u Sudskom registru.\n\nAko je obrt ili fizička osoba, podatke upišite ručno "
          + "(obrt možete provjeriti na pretrazivac-obrta.gov.hr).", "Pretraga po OIB-u");
        return;
      }
      fill(r);
      toast(`Upisano iz Sudskog registra: ${r.name}`);
    } catch (e) {
      if (e.noCreds) await credsHelp(app);
      else await info(e.message, "Pretraga po OIB-u");
    } finally { b.disabled = false; b.textContent = old; }
  }, "ghost");
  return b;
}
