// Prijava korisnika (korisničko ime + lozinka) bez poslužitelja.
//
// Datoteka users.json u repozitoriju STRANICE sadrži samo ŠIFRIRANE podatke:
//  - vault:       AES-GCM(ključ tima,   {token za podatke, vlasnik, repozitorij})
//  - adminVault:  AES-GCM(ključ admina, {token za stranicu + podatke})
//  - users[]:     za svakog korisnika ključ tima (i ključ admina za administratore) šifriran ključem
//                 izvedenim iz njegove lozinke (PBKDF2-SHA256, 600 000 iteracija).
// Bez ispravne lozinke iz datoteke se ne može doznati token. Lozinke se nigdje ne spremaju.
import * as store from "./store.js";

// Glavne stranice (skupine) i njihove kartice: [ključ skupine, ikona, naziv, [[ključ kartice, naziv kartice], ...]]
export const GROUPS = [
  ["dash", "dash", "Nadzorna ploča", [["dash", "Nadzorna ploča"]]],
  ["kegovi", "kegs", "Kegovi", [["kegwork", "Rad s kegovima (QR)"], ["kegs", "Popis kegova"], ["returns", "Kegovi za povrat"]]],
  ["proizvodnja", "batches", "Proizvodnja", [["batches", "Šarže i dan kuhanja"], ["planner", "Plan"], ["recipes", "Recepture"]]],
  ["skladiste", "items", "Skladište", [["items", "Sirovine"], ["invoices", "Računi"], ["lots", "LOT-ovi"], ["chem", "Kemikalije"], ["reorder", "Što naručiti"],
    ["po", "Narudžbenice"], ["suppliers", "Dobavljači"]]],
  ["prodaja", "offers", "Prodaja", [["offers", "Ponude"], ["sales", "Otpremnice i kupci"], ["pricelist", "Cjenik"]]],
  ["izvjesca", "year", "Izvješća", [["costs", "Troškovi · knjigovođa"], ["year", "Godišnji pregled"], ["excise", "Trošarine"],
    ["recall", "Sljedivost"]]],
  ["haccp", "haccp", "HACCP", [["haccp", "HACCP evidencije"]]],
  ["settings", "settings", "Postavke", [["settings", "Postavke"]]],
];
export const GROUP_OF = Object.fromEntries(GROUPS.flatMap(([g, , , tabs]) => tabs.map(([k]) => [k, g])));

export const ROLES = [
  ["admin", "Administrator – sve, uključujući korisnike i postavke"],
  ["korisnik", "Korisnik – sve stranice, bez korisnika i postavki podataka"],
  ["pivar", "Pivar – Proizvodnja i HACCP"],
  ["prodaja", "Prodaja – Prodaja i Kegovi"],
  ["kegovi", "Rad s kegovima – Kegovi te otpremnice i kupci"],
  ["knjigovodja", "Knjigovođa – Izvješća i računi dobavljača, samo čitanje"],
];
// stranice (kartice) koje uloga vidi; uloga bez popisa vidi sve
export const ROLE_PAGES = {
  pivar: ["batches", "planner", "recipes", "haccp", "settings"],
  prodaja: ["offers", "sales", "pricelist", "kegwork", "kegs", "returns", "settings"],
  kegovi: ["kegwork", "kegs", "returns", "sales", "settings"],
  knjigovodja: ["costs", "year", "excise", "recall", "invoices", "settings"],
};
export const ROLE_READONLY = { knjigovodja: true };

// Stranice koje korisnik vidi: vlastiti izbor skupina (polje pages) ili prema ulozi
export function allowedPages(user) {
  if (!user || user.role === "admin") return null;
  if (Array.isArray(user.pages) && user.pages.length) {
    const set = new Set(["settings"]);
    for (const [g, , , tabs] of GROUPS) if (user.pages.includes(g)) for (const [k] of tabs) set.add(k);
    return [...set];
  }
  return ROLE_PAGES[user.role] || null;
}
export function isReadonly(user) {
  if (!user || user.role === "admin") return false;
  return user.readonly != null ? !!user.readonly : !!ROLE_READONLY[user.role];
}
export function firstPage(user) {
  const a = allowedPages(user);
  if (!a) return "dash";
  for (const [, , , tabs] of GROUPS) for (const [k] of tabs) if (a.includes(k)) return k;
  return "settings";
}
const ITER = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

function b64(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(s) { const r = atob(s); const b = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b; }
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }

async function pwKey(password, salt, iter = ITER) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function rawKey(bytes) { return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(key, obj) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(key, box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export function normUser(u) { return String(u || "").trim().toLowerCase(); }

// Repozitorij stranice iz adrese: https://<vlasnik>.github.io/<repozitorij>/
export function siteRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) {
    // vlastita domena (npr. skladiste.pivara.hr): repozitorij stranice zapamćen iz users.json
    try { const c = JSON.parse(localStorage.getItem("pivovara_site") || "null"); if (c && c.owner && c.repo) return c; } catch { /* */ }
    return null;
  }
  const first = location.pathname.split("/").filter(Boolean)[0];
  return { owner: m[1], repo: first && !first.includes(".") ? first : `${m[1]}.github.io` };
}

// users.json: najprije svježe preko GitHub API-ja (javni repozitorij), inače datoteka sa stranice
export async function loadUsers() {
  const u = await loadUsersRaw();
  if (u && u.site && u.site.owner) {
    try { localStorage.setItem("pivovara_site", JSON.stringify(u.site)); } catch { /* */ }
  }
  return u;
}

async function loadUsersRaw() {
  const sr = siteRepo();
  if (sr) {
    try {
      const r = await fetch(`https://api.github.com/repos/${sr.owner}/${sr.repo}/contents/users.json?t=${Date.now()}`,
        { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
      if (r.ok) return await r.json();
    } catch { /* npr. ograničenje broja upita – koristi datoteku sa stranice */ }
  }
  try {
    const r = await fetch(new URL("../users.json", import.meta.url).href + "?t=" + Date.now(), { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch { /* nema datoteke */ }
  return null;
}

// Prijava -> {user, cfg, secrets}; baca Error s porukom
export async function login(users, username, password) {
  const u = (users.users || []).find((x) => x.username === normUser(username));
  if (!u) throw new Error("Pogrešno korisničko ime ili lozinka.");
  let keys;
  try {
    const k = await pwKey(password, unb64(u.salt), u.iter || ITER);
    keys = await open(k, u.wrap);
  } catch { throw new Error("Pogrešno korisničko ime ili lozinka."); }
  const team = await open(await rawKey(unb64(keys.team)), users.vault);
  let admin = null;
  if (keys.admin && users.adminVault) admin = await open(await rawKey(unb64(keys.admin)), users.adminVault);
  const user = { username: u.username, name: u.name || u.username, role: u.role || "korisnik", stamp: u.wrap.ct.slice(0, 16) };
  if (Array.isArray(u.pages) && u.pages.length) user.pages = u.pages;
  if (u.readonly != null) user.readonly = !!u.readonly;
  const cfg = { mode: "github", owner: team.owner, repo: team.repo, token: team.token, user,
    site: users.site, keys: u.role === "admin" ? keys : null, adminToken: admin ? admin.token : null };
  return cfg;
}

async function wrapFor(password, keys) {
  const salt = rand(16);
  const k = await pwKey(password, salt);
  return { salt: b64(salt), iter: ITER, wrap: await seal(k, keys) };
}

export function checkPassword(pw) {
  if (!pw || pw.length < 10) throw new Error("Lozinka mora imati najmanje 10 znakova (preporuka: 3–4 riječi, npr. 'hmelj-slad-kegovi-7').");
}

// Prvo uključivanje prijave: novi ključevi + prvi administrator
export async function initUsers({ owner, repo, workerToken, adminToken, site, admin }) {
  const team = rand(32), adminKey = rand(32);
  const users = {
    version: 1, site, created: new Date().toISOString(),
    vault: await seal(await rawKey(team), { owner, repo, token: workerToken }),
    adminVault: await seal(await rawKey(adminKey), { token: adminToken }),
    users: [],
  };
  const keys = { team: b64(team), admin: b64(adminKey) };
  users.users.push({ username: normUser(admin.username), name: admin.name, role: "admin", created: new Date().toISOString(),
    ...(await wrapFor(admin.password, keys)) });
  return users;
}

// Dodaj / promijeni korisnika (samo administrator: treba ključeve iz svoje prijave)
export async function upsertUser(users, adminKeys, { username, name, role, password, pages, readonly }, isNew) {
  const un = normUser(username);
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) throw new Error("Korisničko ime: 3–30 znakova, mala slova, brojke, točka, crtica.");
  const list = users.users || (users.users = []);
  let u = list.find((x) => x.username === un);
  if (isNew && u) throw new Error(`Korisnik '${un}' već postoji.`);
  if (!isNew && !u) throw new Error(`Korisnik '${un}' ne postoji.`);
  if (!u) { u = { username: un, created: new Date().toISOString() }; list.push(u); }
  u.name = name || un;
  // nova lozinka treba samo kad korisnik postaje ili prestaje biti administrator (drugi ključevi)
  const keysChanged = !isNew && (u.role === "admin") !== (role === "admin");
  u.role = role;
  if (Array.isArray(pages) && pages.length) u.pages = pages; else delete u.pages;
  if (readonly == null) delete u.readonly; else u.readonly = !!readonly;
  if (isNew || password || keysChanged) {
    if (!password) throw new Error(isNew ? "Upišite lozinku." : "Kod promjene administratorske uloge upišite i novu lozinku (ključevi se ponovno šifriraju).");
    checkPassword(password);
    const keys = role === "admin" ? adminKeys : { team: adminKeys.team };
    Object.assign(u, await wrapFor(password, keys));
  }
  u.updated = new Date().toISOString();
  return users;
}

export function removeUser(users, username) {
  const un = normUser(username);
  const admins = users.users.filter((u) => u.role === "admin");
  if (admins.length === 1 && admins[0].username === un) throw new Error("Ne možete obrisati jedinog administratora.");
  users.users = users.users.filter((u) => u.username !== un);
  return users;
}

// Novi tokeni (npr. kad stari istekne ili netko ode): ponovno šifrira vault i adminVault istim ključevima
export async function replaceTokens(users, adminKeys, { workerToken, adminToken, owner, repo }) {
  const t = await open(await rawKey(unb64(adminKeys.team)), users.vault);
  users.vault = await seal(await rawKey(unb64(adminKeys.team)), { owner: owner || t.owner, repo: repo || t.repo, token: workerToken || t.token });
  if (adminToken) users.adminVault = await seal(await rawKey(unb64(adminKeys.admin)), { token: adminToken });
  return users;
}

// Spremi users.json u repozitorij stranice (token administratora mora imati Contents: write za taj repozitorij)
export async function saveUsers(users, site, adminToken) {
  const cfg = { owner: site.owner, repo: site.repo, token: adminToken };
  const meta = await store.remoteMeta(cfg, "users.json");
  const bytes = new TextEncoder().encode(JSON.stringify(users, null, 1));
  await store.remotePut(cfg, bytes, meta ? meta.sha : null, `Korisnici: ${new Date().toLocaleString("hr-HR")}`, "users.json");
}

// Je li korisnik iz zapamćene prijave i dalje u users.json (npr. administrator ga je obrisao)?
export function stillValid(users, cfg) {
  if (!users || !cfg || !cfg.user) return true;
  const u = (users.users || []).find((x) => x.username === cfg.user.username);
  return !!(u && u.wrap && u.wrap.ct.slice(0, 16) === cfg.user.stamp);
}

// user: objekt prijavljenog korisnika (ili null = bez prijave, sve stranice)
export function canSee(user, page) {
  const allowed = allowedPages(user);
  return !allowed || allowed.includes(page);
}
