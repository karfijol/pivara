// Prijava korisnika (korisničko ime + lozinka) bez poslužitelja.
//
// Datoteka users.json u repozitoriju STRANICE sadrži samo ŠIFRIRANE podatke:
//  - vault:       AES-GCM(ključ tima,   {token za podatke, vlasnik, repozitorij})
//  - adminVault:  AES-GCM(ključ admina, {token za stranicu + podatke})
//  - users[]:     za svakog korisnika ključ tima (i ključ admina za administratore) šifriran ključem
//                 izvedenim iz njegove lozinke (PBKDF2-SHA256, 600 000 iteracija).
// Bez ispravne lozinke iz datoteke se ne može doznati token. Lozinke se nigdje ne spremaju.
import * as store from "./store.js";

export const ROLES = [
  ["admin", "Administrator – sve, uključujući korisnike i postavke"],
  ["korisnik", "Korisnik – sav rad u programu, bez korisnika i postavki podataka"],
  ["kegovi", "Rad s kegovima – samo kegovi, otpremnice i kupci"],
];
export const ROLE_PAGES = {
  kegovi: ["kegwork", "kegs", "sales", "settings"],
};
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
  if (!m) return null;
  const first = location.pathname.split("/").filter(Boolean)[0];
  return { owner: m[1], repo: first && !first.includes(".") ? first : `${m[1]}.github.io` };
}

// users.json: najprije svježe preko GitHub API-ja (javni repozitorij), inače datoteka sa stranice
export async function loadUsers() {
  const sr = siteRepo();
  if (sr) {
    try {
      const r = await fetch(`https://api.github.com/repos/${sr.owner}/${sr.repo}/contents/users.json?t=${Date.now()}`,
        { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
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
export async function upsertUser(users, adminKeys, { username, name, role, password }, isNew) {
  const un = normUser(username);
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) throw new Error("Korisničko ime: 3–30 znakova, mala slova, brojke, točka, crtica.");
  const list = users.users || (users.users = []);
  let u = list.find((x) => x.username === un);
  if (isNew && u) throw new Error(`Korisnik '${un}' već postoji.`);
  if (!isNew && !u) throw new Error(`Korisnik '${un}' ne postoji.`);
  if (!u) { u = { username: un, created: new Date().toISOString() }; list.push(u); }
  u.name = name || un;
  const roleChanged = u.role !== role;
  u.role = role;
  if (password || roleChanged) {
    if (!password) throw new Error("Kod promjene uloge upišite i novu lozinku (ključevi se ponovno šifriraju).");
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

export function canSee(role, page) {
  const allowed = ROLE_PAGES[role];
  return !allowed || allowed.includes(page);
}
