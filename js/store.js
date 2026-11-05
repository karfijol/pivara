// Spremanje baze: lokalno u pregledniku (IndexedDB) + sinkronizacija u PRIVATNI GitHub repozitorij.
// Svako spremanje na GitHub je nova verzija (povijest = automatske sigurnosne kopije).

const CFG_KEY = "pivovara_sync";
const DB_FILE = "skladiste.db";

// Konfiguracija (repozitorij + token). Prijava bez "Zapamti me" drži je samo dok je kartica otvorena (sessionStorage).
export function getConfig() {
  try {
    return JSON.parse(sessionStorage.getItem(CFG_KEY) || localStorage.getItem(CFG_KEY) || "null");
  } catch { return null; }
}
export function setConfig(cfg, { persist = true } = {}) {
  try {
    sessionStorage.removeItem(CFG_KEY);
    localStorage.removeItem(CFG_KEY);
    if (cfg) (persist ? localStorage : sessionStorage).setItem(CFG_KEY, JSON.stringify(cfg));
  } catch { /* privatni način rada */ }
}
// Kod prijave bez "Zapamti me" podaci se ne spremaju trajno u preglednik (tuđe / zajedničko računalo).
function ephemeral() { const c = getConfig(); return !!(c && c.ephemeral); }

// ---------------------------------------------------------------- IndexedDB (lokalna kopija)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pivovara", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function localGet(key) {
  if (ephemeral()) return null;
  try {
    const db = await idb();
    return await new Promise((res) => {
      const t = db.transaction("files").objectStore("files").get(key);
      t.onsuccess = () => res(t.result || null);
      t.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function localPut(key, value) {
  if (ephemeral()) return;
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const t = db.transaction("files", "readwrite");
      t.objectStore("files").put(value, key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch (e) { console.warn("IndexedDB", e); }
}
export async function localClear() {
  try {
    const db = await idb();
    await new Promise((res) => { const t = db.transaction("files", "readwrite"); t.objectStore("files").clear(); t.oncomplete = res; });
  } catch { /* */ }
}

// ---------------------------------------------------------------- GitHub API
function b64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export class ConflictError extends Error {}
export class AuthError extends Error {}

function headers(cfg, raw = false) {
  return {
    Authorization: "Bearer " + cfg.token,
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function url(cfg, path) {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

async function check(r) {
  if (r.status === 401 || r.status === 403) throw new AuthError("GitHub odbija pristup – provjerite token i naziv repozitorija.");
  if (r.status === 409 || r.status === 422) throw new ConflictError("Datoteku je u međuvremenu promijenio drugi uređaj.");
  if (!r.ok) throw new Error(`GitHub greška ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// Provjera pristupa repozitoriju
export async function testRepo(cfg) {
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
    { headers: headers(cfg) });
  if (r.status === 404) throw new AuthError("Repozitorij nije pronađen (ili token nema pristup njemu).");
  await check(r);
  const j = await r.json();
  return { private: j.private, name: j.full_name, push: !!(j.permissions && j.permissions.push) };
}

// Vraća {sha} ili null ako datoteka ne postoji
// datum isteka tokena (GitHub ga šalje u zaglavlju odgovora, ako ga preglednik smije pročitati)
export let tokenExpiry = null;
function noteExpiry(r) {
  try {
    const v = r.headers.get("github-authentication-token-expiration");
    if (v) tokenExpiry = v.slice(0, 10);
  } catch { /* */ }
}

export async function remoteMeta(cfg, path = DB_FILE) {
  const r = await fetch(url(cfg, path) + "?t=" + Date.now(), { headers: headers(cfg), cache: "no-store" });
  noteExpiry(r);
  if (r.status === 404) return null;
  await check(r);
  const j = await r.json();
  return { sha: j.sha, size: j.size };
}

export async function remoteGet(cfg, path = DB_FILE) {
  const meta = await remoteMeta(cfg, path);
  if (!meta) return null;
  const r = await fetch(url(cfg, path) + "?t=" + Date.now(), { headers: headers(cfg, true), cache: "no-store" });
  await check(r);
  return { sha: meta.sha, bytes: new Uint8Array(await r.arrayBuffer()) };
}

export async function remotePut(cfg, bytes, sha, message, path = DB_FILE) {
  const who = (getConfig() || {}).user;
  const body = { message: who ? `${message} – ${who.name || who.username}` : message, content: b64(bytes) };
  if (sha) body.sha = sha;
  const r = await fetch(url(cfg, path), {
    method: "PUT", headers: { ...headers(cfg), "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  await check(r);
  const j = await r.json();
  return j.content.sha;
}

// ---------------------------------------------------------------- sinkronizator baze
export class Sync {
  constructor({ getBytes, onStatus, onRemoteChange }) {
    this.cfg = getConfig();
    this.getBytes = getBytes;
    this.onStatus = onStatus || (() => {});
    this.onRemoteChange = onRemoteChange || (() => {});
    this.sha = null;
    this.dirty = false;
    this.saving = null;
    this.timer = null;
    this.status = "";
  }

  get remote() { return !!(this.cfg && this.cfg.mode === "github"); }

  setStatus(s, detail = "") { this.status = s; this.onStatus(s, detail); }

  // Prvo učitavanje: vraća bajtove baze (ili null ako baze još nema)
  async load() {
    const local = await localGet("db");
    if (!this.remote) {
      this.setStatus("local");
      return local ? local.bytes : null;
    }
    this.setStatus("loading");
    let remote;
    try {
      remote = await remoteGet(this.cfg);
    } catch (e) {
      if (local) { this.setStatus("offline", e.message); this.sha = local.sha; this.dirty = !!local.dirty; return local.bytes; }
      throw e;
    }
    if (local && local.dirty && (!remote || local.sha === remote.sha)) {
      // nespremljene promjene s ovog uređaja -> pošalji ih
      this.sha = remote ? remote.sha : null;
      this.dirty = true;
      this.schedule(100);
      return local.bytes;
    }
    if (local && local.dirty && remote && local.sha !== remote.sha) {
      this.conflictLocal = local; // odluku donosi korisnik (main.js)
    }
    if (!remote) {
      // repozitorij je prazan: ako u pregledniku već postoje podaci (npr. rad bez GitHuba), pošalji ih
      this.sha = null;
      if (local) { this.dirty = true; this.schedule(300); this.setStatus("pending"); return local.bytes; }
      this.setStatus("saved");
      return null;
    }
    this.sha = remote.sha;
    await localPut("db", { bytes: remote.bytes, sha: remote.sha, dirty: false });
    this.setStatus("saved");
    return remote.bytes;
  }

  // Nakon svake promjene u bazi
  changed() {
    this.dirty = true;
    this.setStatus(this.remote ? "pending" : "local");
    this.schedule(this.remote ? 1500 : 400);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), ms);
  }

  async save() {
    if (this.saving) { this.schedule(500); return this.saving; }
    const bytes = this.getBytes();
    const jn = this.journalLen ? this.journalLen() : 0;
    await localPut("db", { bytes, sha: this.sha, dirty: this.remote, ts: Date.now() });
    if (!this.remote) { this.dirty = false; this.setStatus("local"); return; }
    this.setStatus("saving");
    this.saving = (async () => {
      try {
        const sha = await remotePut(this.cfg, bytes, this.sha, `Spremljeno: ${new Date().toLocaleString("hr-HR")}`);
        this.sha = sha;
        this.dirty = false;
        if (this.journalDone) this.journalDone(jn);
        await localPut("db", { bytes, sha, dirty: false, ts: Date.now() });
        this.setStatus("saved");
      } catch (e) {
        if (e instanceof ConflictError) { this.setStatus("conflict", e.message); this.onConflict && this.onConflict(); }
        else this.setStatus("offline", e.message);
      } finally { this.saving = null; }
    })();
    return this.saving;
  }

  // Provjera ima li novije verzije na GitHubu (drugi uređaj)
  async poll() {
    if (!this.remote || this.dirty || this.saving) return false;
    try {
      const m = await remoteMeta(this.cfg);
      if (m && m.sha !== this.sha) {
        const r = await remoteGet(this.cfg);
        this.sha = r.sha;
        await localPut("db", { bytes: r.bytes, sha: r.sha, dirty: false });
        this.onRemoteChange(r.bytes);
        this.setStatus("saved");
        return true;
      }
      if (this.status === "offline") this.setStatus("saved");
    } catch (e) { this.setStatus("offline", e.message); }
    return false;
  }

  // Preuzmi najnoviju verziju s GitHuba i odbaci lokalne nespremljene promjene
  async takeRemote() {
    const r = await remoteGet(this.cfg);
    this.sha = r ? r.sha : null;
    this.dirty = false;
    if (r) await localPut("db", { bytes: r.bytes, sha: r.sha, dirty: false });
    this.setStatus("saved");
    return r ? r.bytes : null;
  }

  // Zadrži lokalnu verziju i prepiši onu na GitHubu
  async forceLocal(bytes) {
    const m = await remoteMeta(this.cfg);
    this.sha = m ? m.sha : null;
    await localPut("db", { bytes, sha: this.sha, dirty: true });
    this.dirty = true;
    return this.save();
  }

  // Dodatne datoteke (logo) u istom repozitoriju
  async putFile(path, bytes) {
    if (!this.remote) return;
    const m = await remoteMeta(this.cfg, path);
    await remotePut(this.cfg, bytes, m ? m.sha : null, `Datoteka ${path}`, path);
  }
  async getFile(path) {
    if (!this.remote) return null;
    try { const r = await remoteGet(this.cfg, path); return r ? r.bytes : null; } catch { return null; }
  }
  async deleteFile(path) {
    if (!this.remote) return;
    const m = await remoteMeta(this.cfg, path);
    if (!m) return;
    await fetch(url(this.cfg, path), {
      method: "DELETE", headers: { ...headers(this.cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Obrisano ${path}`, sha: m.sha }),
    });
  }
}
