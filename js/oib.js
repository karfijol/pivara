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

// Prijava (OAuth2 client_credentials). Sudski registar traži Basic prijavu, a preglednik je ne smije poslati izravno
// (registar za prijavu ne dopušta pozive s druge stranice – CORS). Zato: 1) posrednik (Cloudflare Worker), ako je upisan;
// 2) izravni pokušaj s podacima u tijelu zahtjeva. Client ID i Secret uvijek završavaju s „..” – dodaju se ako su izgubljeni.
function variants(v) { v = String(v || "").trim(); return v.endsWith("..") ? [v] : [v, v.replace(/\.*$/, "") + ".."]; }
async function tryToken(proxy, id, secret) {
  const key = id + ":" + secret;
  if (proxy) {
    try {
      const r = await fetch(proxy.replace(/\/+$/, "") + "/token", { method: "POST", headers: { Authorization: "Basic " + btoa(key) } });
      if (r.ok) return { ok: true, j: await r.json() };
      return { ok: false, status: r.status, via: "proxy" };
    } catch { return { ok: false, status: 0, via: "proxy" }; }
  }
  try {
    const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}` });
    if (r.ok) return { ok: true, j: await r.json() };
    return { ok: false, status: r.status, via: "direct" };
  } catch { return { ok: false, status: 0, via: "direct" }; }
}
async function token(id, secret, proxy) {
  const ck = id + ":" + secret + ":" + proxy;
  if (TOKEN && TOKEN.key === ck && TOKEN.until > Date.now() + 30000) return TOKEN.token;
  let last = null;
  for (const i of variants(id)) {
    for (const sc of variants(secret)) {
      const r = await tryToken(proxy, i, sc);
      if (r.ok && r.j && r.j.access_token) {
        TOKEN = { key: ck, token: r.j.access_token, until: Date.now() + (Number(r.j.expires_in) || 3600) * 1000 };
        return TOKEN.token;
      }
      last = r;
      if (r.status === 0) break;
    }
    if (last && last.status === 0) break;
  }
  const e = new Error(last && last.status === 0
    ? (proxy ? "Posrednik (Cloudflare Worker) nije dostupan – provjerite adresu posrednika u Postavkama → Ponude."
      : "Sudski registar nije dostupan (nema veze s internetom ili je servis privremeno nedostupan).")
    : (proxy ? "Sudski registar je odbio pristupne podatke – provjerite Client ID i Client Secret (moraju završavati s dvije točke „..”)."
      : "Sudski registar ne prihvaća prijavu izravno iz preglednika (ili pristupni podaci nisu ispravni). Postavite besplatnog posrednika – upute su u Postavke → Ponude → „Upute za posrednika”."));
  e.authFail = true; e.needProxy = !proxy && last && last.status !== 0;
  throw e;
}

// provjera pristupa (Postavke → Ponude): vraća tekst rezultata
export async function testAccess(app) {
  const id = (app.db.get_setting("sudreg_client_id") || "").trim(), secret = (app.db.get_setting("sudreg_client_secret") || "").trim();
  const proxy = (app.db.get_setting("sudreg_proxy") || "").trim();
  if (!id || !secret) return "Upišite Client ID i Client Secret pa kliknite Spremi.";
  TOKEN = null;
  try {
    await token(id, secret, proxy);
    const r = await lookupOib(app, "28921383001"); // provjera na poznatom OIB-u (HEP d.d.)
    return r ? `✓ Pristup radi${proxy ? " (preko posrednika)" : ""}. Probni upit: ${r.name}` : "✓ Prijava radi, ali probni upit nije vratio podatke.";
  } catch (e) { return "✗ " + e.message; }
}

// upute i kod za posrednika (Cloudflare Worker, besplatno)
export const WORKER_CODE = `// Posrednik za aplikaciju pivovare: prijava u Sudski registar (sudreg-data.gov.hr) i provjera OIB-a u EU VIES (tvrtke i obrti u sustavu PDV-a)
const ALLOWED = ["https://app.pivara.hr"];
export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
      "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!ALLOWED.includes(origin)) return new Response("Zabranjeno", { status: 403, headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path.endsWith("/token")) {
      const r = await fetch("https://sudreg-data.gov.hr/api/oauth/token", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: req.headers.get("Authorization") || "" },
        body: "grant_type=client_credentials" });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const m = path.match(/\\/vies\\/(\\d{11})$/);
    if (req.method === "GET" && m) {
      const r = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/HR/vat/" + m[1], { headers: { Accept: "application/json" } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("Nije pronađeno", { status: 404, headers: cors });
  },
};`;

export async function proxyHelp() {
  const d = new Dialog("Posrednik za Sudski registar i VIES (Cloudflare Worker)", { width: 720 });
  const code = h("textarea", { readonly: true, rows: 14, style: { width: "100%", fontFamily: "monospace", fontSize: "12px" } });
  code.value = WORKER_CODE;
  d.body.append(h("div", { class: "msg" },
    "Sudski registar dopušta prijavu samo na način koji preglednik ne smije izravno poslati s druge web stranice. " +
    "Zato prijavu obavlja mali besplatni posrednik na Cloudflareu (radi samo za app.pivara.hr i ne sprema podatke). Isti posrednik pretražuje i EU registar PDV obveznika (VIES) – tako se pronalaze i obrti u sustavu PDV-a.\n\n" +
    "Ako ste workera već napravili, samo zamijenite njegov kod novim kodom ispod (Edit code → zalijepi → Deploy).\n\n" +
    "1. Otvorite dash.cloudflare.com i napravite besplatan račun (ili se prijavite).\n" +
    "2. Workers & Pages → Create → Create Worker → nazovite ga npr. sudreg → Deploy.\n" +
    "3. Edit code → obrišite postojeći kod i zalijepite kod ispod → Deploy.\n" +
    "4. Kopirajte adresu workera (npr. https://sudreg.vase-ime.workers.dev) i upišite je u Postavke → Ponude → „Adresa posrednika”.\n" +
    "5. Kliknite „Provjeri pristup”."), code);
  d.buttons(null, null, "Zatvori");
  d.bar.prepend(btn("Kopiraj kod", async () => { try { await navigator.clipboard.writeText(WORKER_CODE); toast("Kod kopiran."); } catch { code.select(); } }, "ghost"),
    btn("Otvori Cloudflare", () => window.open("https://dash.cloudflare.com/", "_blank"), "ghost"));
  return d.show();
}

// vraća { oib, name, street, postal, city, address, status, form } ili null (nije u sudskom registru)
export async function lookupOib(app, oib) {
  const s = String(oib || "").replace(/\s/g, "");
  if (!oibValid(s)) throw new Error("OIB nije ispravan (mora imati 11 znamenki i ispravnu kontrolnu znamenku).");
  const id = (app.db.get_setting("sudreg_client_id") || "").trim(), secret = (app.db.get_setting("sudreg_client_secret") || "").trim();
  if (!id || !secret) { const e = new Error("NOCREDS"); e.noCreds = true; throw e; }
  const t = await token(id, secret, (app.db.get_setting("sudreg_proxy") || "").trim());
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

// EU VIES (preko posrednika): tvrtke i obrti u sustavu PDV-a – naziv i adresa
export async function lookupVies(app, oib) {
  const proxy = (app.db.get_setting("sudreg_proxy") || "").trim().replace(/\/+$/, "");
  if (!proxy) return null;
  let r;
  try { r = await fetch(`${proxy}/vies/${oib}`); } catch { throw new Error("Posrednik (Cloudflare Worker) nije dostupan – provjerite adresu u Postavkama."); }
  if (r.status === 404) throw new Error("Posrednik još nema provjeru obrta (VIES) – u Cloudflareu zamijenite kod workera novim kodom iz „Upute za posrednika” i kliknite Deploy.");
  if (!r.ok) throw new Error(`VIES: greška ${r.status}.`);
  const j = await r.json();
  if (!j || !j.isValid || !j.name || j.name === "---") return null;
  const parts = String(j.address || "").split(/\n|,\s*/).map((x) => x.trim()).filter(Boolean);
  let postal = "", city = "";
  const pi = parts.findIndex((x) => /^\d{5}\b/.test(x));
  if (pi >= 0) { const m = parts[pi].match(/^(\d{5})\s*(.*)$/); postal = m[1]; city = m[2]; parts.splice(pi, 1); }
  const t = (x) => x.toLowerCase().replace(/(^|[\s\-\/(.])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());
  const street = t(parts.join(", "));
  city = t(city);
  return { oib, name: String(j.name).trim(), street, postal, city, address: [street, [postal, city].filter(Boolean).join(" ")].filter(Boolean).join(", "), source: "VIES" };
}

// obrt koji nije u sustavu PDV-a: otvori Pretraživač obrtnog registra (OIB vlasnika = OIB obrta), OIB je u međuspremniku
export async function craftHelp(oib) {
  const d = new Dialog("Pretraga obrta", { width: 560 });
  d.body.append(h("div", { class: "msg" },
    "Subjekt nije pronađen u Sudskom registru ni u EU registru PDV obveznika (VIES).\n\n" +
    "Ako je obrt koji nije u sustavu PDV-a: Obrtni registar ima zaštitu od automatskih upita pa ga program ne može sam pretražiti. " +
    "Kliknite „Otvori Obrtni registar” – OIB je već kopiran: zalijepite ga u polje „OIB vlasnika”, kliknite Pretraži i prepišite naziv i adresu obrta."));
  d.buttons(null, null, "Zatvori");
  d.bar.prepend(btn("Otvori Obrtni registar", async () => {
    try { await navigator.clipboard.writeText(oib); toast("OIB kopiran – zalijepite ga u „OIB vlasnika”."); } catch { /* */ }
    window.open("https://pretrazivac-obrta.gov.hr/pretraga.htm", "_blank");
  }, "primary"));
  return d.show();
}

// upute kad pristupni podaci nisu upisani
export async function credsHelp(app) {
  const d = new Dialog("Pretraga po OIB-u – Sudski registar", { width: 560 });
  d.body.append(h("div", { class: "msg" },
    "Podaci tvrtki (d.o.o., j.d.o.o., d.d., udruge u sudskom registru) preuzimaju se s Portala otvorenih podataka Sudskog registra. " +
    "Pristup je besplatan, ali traži jednokratnu registraciju:\n\n" +
    "1. Otvorite sudreg-data.gov.hr i kliknite „Registracija”.\n" +
    "2. Potvrdite e-mail adresu – otvorit će se stranica s pristupnim podacima (Client ID i Client Secret).\n" +
    "3. Upišite ih u Postavke → Ponude → „Sudski registar – pretraga po OIB-u” (kopirajte ih cijele – uvijek završavaju s dvije točke „..”).\n\n" +
    "Obrti: preko istog posrednika program pretražuje i EU registar PDV obveznika (VIES) – pronalazi tvrtke i obrte u sustavu PDV-a. " +
    "Obrte izvan sustava PDV-a treba prepisati iz Obrtnog registra (pretrazivac-obrta.gov.hr)."));
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
      const s2 = oib.replace(/\s/g, "");
      if (!oibValid(s2)) return info("OIB nije ispravan (mora imati 11 znamenki i ispravnu kontrolnu znamenku).", "Pretraga po OIB-u");
      const hasCreds = (app.db.get_setting("sudreg_client_id") || "").trim() && (app.db.get_setting("sudreg_client_secret") || "").trim();
      const hasProxy = !!(app.db.get_setting("sudreg_proxy") || "").trim();
      if (!hasCreds && !hasProxy) return credsHelp(app);
      let r = null, err = null;
      if (hasCreds) { try { r = await lookupOib(app, s2); } catch (e) { err = e; } }
      if (!r && hasProxy) { try { r = await lookupVies(app, s2); } catch (e) { err = err || e; } }
      if (r) { fill(r); toast(`Upisano iz ${r.source === "VIES" ? "EU registra PDV obveznika (VIES)" : "Sudskog registra"}: ${r.name}`); return; }
      if (err && err.needProxy) {
        const d = new Dialog("Pretraga po OIB-u", { width: 520 });
        d.body.append(h("div", { class: "msg" }, err.message));
        d.buttons(null, null, "Zatvori");
        d.bar.prepend(btn("Upute za posrednika", () => { d.close(null); proxyHelp(); }, "primary"));
        await d.show();
      } else if (err && !hasProxy) await info(err.message, "Pretraga po OIB-u");
      else if (err && err.message && /posrednik|VIES/i.test(err.message)) await info(err.message, "Pretraga po OIB-u");
      else await craftHelp(s2);
    } catch (e) { await info(e.message, "Pretraga po OIB-u");
    } finally { b.disabled = false; b.textContent = old; }
  }, "ghost");
  return b;
}
