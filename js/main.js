// Glavni dio web aplikacije: izbornik, stranice, učitavanje i spremanje baze.
import * as py from "./py.js";
import * as store from "./store.js";
import * as auth from "./auth.js";
import { h, btn, toast, info, error, confirm, busy, openFile, dbProxy, Dialog } from "./ui.js";

export const VERSION = "web 2.1";

const NAV = [
  ["dash", "🏠", "Nadzorna ploča", "stock"],
  [null, "", "SKLADIŠTE"],
  ["items", "🌾", "Sirovine", "stock"],
  ["lots", "🏷", "LOT-ovi / FIFO", "stock"],
  ["chem", "🧪", "Kemikalije", "stock"],
  ["kegs", "🛢", "Kegovi", "production"],
  ["kegwork", "📱", "Rad s kegovima (QR)", "kegwork"],
  [null, "", "PROIZVODNJA"],
  ["recipes", "📋", "Recepture", "production"],
  ["planner", "📅", "Planer fermentora", "production"],
  ["batches", "🍺", "Šarže piva", "production"],
  ["haccp", "🛡", "HACCP evidencije", "haccp"],
  [null, "", "PRODAJA"],
  ["offers", "💰", "Ponude", "offers"],
  ["sales", "🤝", "Kupci i otpremnice", "production"],
  [null, "", "NABAVA"],
  ["reorder", "🛒", "Što naručiti", "stock"],
  ["po", "📄", "Narudžbenice", "stock"],
  ["suppliers", "🚚", "Dobavljači", "stock"],
  [null, "", "IZVJEŠĆA"],
  ["costs", "🧾", "Troškovi · knjigovođa", "costs"],
  ["excise", "💶", "Trošarine", "production"],
  ["recall", "🔎", "Sljedivost i povlačenje", "production"],
  [null, "", ""],
  ["settings", "⚙", "Postavke", "settings"],
];

class App {
  constructor() {
    this.db = dbProxy();
    this.py = py;
    this.pages = {};
    this.classes = {};
    this.current = null;
    this.navBtns = {};
  }

  // ------------------------------------------------------------ pokretanje
  async start() {
    const splash = document.getElementById("splash-text");
    const progress = (t) => { if (splash) splash.textContent = t; };
    try {
      await py.init(progress);
    } catch (e) {
      progress("Python se ne može pokrenuti u ovom pregledniku: " + e.message + ". Koristite noviji Chrome, Edge ili Firefox.");
      throw e;
    }
    const mods = await Promise.all(["stock", "production", "haccp", "settings", "kegwork", "costs", "offers"].map(async (m) => {
      try { return [m, await import(`./pages/${m}.js`)]; } catch (e) { console.error(m, e); return [m, null]; }
    }));
    for (const [m, mod] of mods) if (mod && mod.PAGES) Object.assign(this.classes, mod.PAGES);
    this.modules = Object.fromEntries(mods);

    this.sync = new store.Sync({
      getBytes: () => py.dbBytes(),
      onStatus: (s, d) => this.syncStatus(s, d),
      onRemoteChange: (bytes) => { py.openDb(bytes); this.refreshAll(); toast("Učitane su promjene s drugog uređaja."); },
    });
    this.sync.onConflict = () => this.conflict();
    this.sync.journalLen = () => py.journal.length;
    this.sync.journalDone = (n) => py.journal.splice(0, n);
    py.setOnChange(() => this.sync.changed());

    let cfg = store.getConfig();
    // prijava korisnika (ako je administrator uključio korisnike – users.json u repozitoriju stranice)
    progress("Provjeravam prijavu…");
    this.users = await auth.loadUsers();
    const hasUsers = !!(this.users && (this.users.users || []).length);
    if (hasUsers && cfg && cfg.user && !auth.stillValid(this.users, cfg)) {
      store.setConfig(null); await store.localClear(); cfg = null;
    }
    if (hasUsers && !(cfg && cfg.user) && !(cfg && cfg.mode === "github" && localStorage.getItem("pivovara_token_login") === "1")) {
      progress(""); return this.loginScreen();
    }
    this.user = cfg && cfg.user ? cfg.user : null;
    if (this.user) {
      try { localStorage.setItem("pivovara_user", JSON.stringify(this.user.name)); } catch { /* */ }
    }
    if (!cfg) { progress(""); return this.setupScreen(); }
    progress("Učitavam podatke" + (cfg.mode === "github" ? " s GitHuba…" : "…"));
    let bytes;
    try { bytes = await this.sync.load(); } catch (e) {
      progress("");
      await error(e.message + "\n\nProvjerite postavke povezivanja.", "Podaci se ne mogu učitati");
      return this.setupScreen(cfg);
    }
    if (!bytes) { progress(""); return this.setupScreen(cfg, true); }
    await this.openApp(bytes);
    if (this.sync.conflictLocal) this.localConflict();
  }

  async openApp(bytes) {
    py.openDb(bytes || null);
    await this.loadLogos();
    document.getElementById("splash")?.remove();
    this.buildShell();
    const role = this.user ? this.user.role : "admin";
    const first = (auth.ROLE_PAGES[role] || ["dash"])[0];
    const key = (location.hash || "#" + first).slice(1).split("/")[0];
    this.show(this.classes[key] ? key : first);
    window.addEventListener("hashchange", () => {
      const k = location.hash.slice(1).split("/")[0];
      if (k && k !== this.current && this.classes[k]) this.show(k);
    });
    setInterval(() => this.sync.poll(), 45000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.sync.poll(); });
    window.addEventListener("beforeunload", (e) => {
      if (this.sync.dirty || this.sync.saving) { this.sync.save(); e.preventDefault(); e.returnValue = ""; }
    });
    this.afterStart();
  }

  afterStart() {
    try {
      const rem = this.db.excise_reminder();
      if (rem && !this.db.is_dismissed({ key: `excise:${rem[0]}`, type: "Trošarine MI-PI" })) {
        const k = "excise_popup_" + rem[0];
        const t = new Date().toISOString().slice(0, 10);
        if (localStorage.getItem(k) !== t) {
          localStorage.setItem(k, t);
          confirm(rem[1] + "\n\nOtvoriti Trošarine sada?", "Trošarine – podsjetnik").then((y) => { if (y) this.show("excise"); });
        }
      }
    } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------ logo
  async loadLogos() {
    for (const f of ["logo.png", "logo_app.png"]) {
      let bytes = null;
      const local = await store.localGet(f);
      if (this.sync.remote) bytes = await this.sync.getFile(f);
      if (!bytes && local) bytes = local;
      if (bytes) { py.writeFile(py.DATA_DIR + "/" + f, bytes); await store.localPut(f, bytes); }
    }
  }
  logoUrl(which = "app") {
    const p = py.DATA_DIR + "/" + (which === "app" && py.exists(py.DATA_DIR + "/logo_app.png") ? "logo_app.png" : "logo.png");
    if (!py.exists(p)) return null;
    return URL.createObjectURL(new Blob([py.readFile(p)], { type: "image/png" }));
  }
  async setLogo(which, bytes) {
    const f = which === "app" ? "logo_app.png" : "logo.png";
    const p = py.DATA_DIR + "/" + f;
    if (bytes) { py.writeFile(p, bytes); await store.localPut(f, bytes); await this.sync.putFile(f, bytes); }
    else { py.unlink(p); await store.localPut(f, null); await this.sync.deleteFile(f); }
    this.applyLogo();
  }
  applyLogo() {
    const box = document.getElementById("brand-logo");
    if (!box) return;
    const u = this.logoUrl("app");
    box.innerHTML = "";
    box.append(u ? h("img", { src: u, alt: "logo" }) : h("span", { class: "brand-txt" }, "🍺 Pivovara"));
    const fav = document.querySelector("link[rel=icon]");
    const d = this.logoUrl("doc");
    if (fav && d) fav.href = d;
  }

  // ------------------------------------------------------------ izgled
  buildShell() {
    const root = document.getElementById("app");
    root.innerHTML = "";
    this.side = h("nav", { class: "side" });
    this.main = h("main", { class: "main" });
    const brand = h("div", { class: "brand" }, h("div", { id: "brand-logo", class: "brand-logo" }),
      h("div", { class: "brand-name", id: "brand-name" }, this.db.get_setting("brewery_name")));
    const navList = h("div", { class: "nav" });
    const role = this.user ? this.user.role : "admin";
    for (const [key, icon, label] of NAV) {
      if (!key) { if (!auth.ROLE_PAGES[role]) navList.append(h("div", { class: "nav-sec" }, label)); continue; }
      if (!auth.canSee(role, key)) continue;
      const b = h("a", { class: "nav-btn", href: "#" + key, onclick: () => this.closeMenu() }, h("span", { class: "ico" }, icon), label);
      this.navBtns[key] = b;
      navList.append(b);
    }
    this.statusEl = h("div", { class: "sync-status", title: "" });
    const who = this.user ? h("div", { class: "who" }, h("span", {}, "👤 " + this.user.name),
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.logout(); } }, "Odjava")) : null;
    // tipka je uvijek vidljiva (osim kad je program već otvoren kao aplikacija); bez automatske ponude preglednika prikaže upute
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const inst = h("a", { href: "#", class: "install" + (standalone ? " hidden" : ""), onclick: (e) => { e.preventDefault(); this.closeMenu(); this.install(); } },
      "📲 Instaliraj kao aplikaciju");
    this.side.append(brand, navList, h("div", { class: "side-foot" }, inst, who, this.statusEl, h("div", { class: "ver" }, VERSION)));
    const burger = h("button", { class: "burger", type: "button", onclick: () => document.body.classList.toggle("menu-open") }, "☰");
    const scrim = h("div", { class: "scrim", onclick: () => this.closeMenu() });
    root.append(burger, this.side, scrim, this.main);
    this.applyLogo();
    this.syncStatus(this.sync.status);
    this.applyTheme();
  }
  closeMenu() { document.body.classList.remove("menu-open"); }
  applyTheme() {
    let t = "system";
    try { t = localStorage.getItem("theme") || "system"; } catch { /* */ }
    document.documentElement.dataset.theme = t === "system" ? "" : t;
  }

  syncStatus(s, detail = "") {
    if (!this.statusEl) return;
    const map = {
      saved: ["ok", "● Spremljeno na GitHub"], pending: ["warn", "● Promjene čekaju spremanje…"], saving: ["warn", "● Spremam…"],
      loading: ["warn", "● Učitavam…"], local: ["muted", "● Spremljeno u ovom pregledniku"],
      offline: ["bad", "● Nije spremljeno na GitHub (nema veze)"], conflict: ["bad", "● Sukob s drugim uređajem"],
    };
    const [cls, txt] = map[s] || ["muted", ""];
    this.statusEl.className = "sync-status " + cls;
    this.statusEl.textContent = txt;
    this.statusEl.title = detail || "";
    this.statusEl.onclick = s === "offline" ? () => this.sync.save() : null;
  }

  async conflict() {
    // Drugi uređaj je u međuvremenu spremio promjene: preuzmi njegovu verziju i ponovi naše promjene nad njom.
    const pending = py.journal.splice(0);
    let bytes;
    try { bytes = await this.sync.takeRemote(); } catch (e) { this.syncStatus("offline", e.message); py.journal.unshift(...pending); return; }
    const before = py.dbBytes();
    py.openDb(bytes);
    const failed = py.replayJournal(pending);
    if (failed.length === pending.length && pending.length) {
      // ništa se ne može ponoviti -> pitaj korisnika
      py.openDb(before);
      py.journal.push(...pending);
      const take = await confirm("Netko je na drugom uređaju u međuvremenu spremio promjene, a vaše se promjene ne mogu automatski spojiti.\n\n" +
        "• Preuzmi noviju verziju – vaše zadnje promjene s ovog uređaja se odbacuju.\n" +
        "• Zadrži moju verziju – prepisuje se verzija s GitHuba (promjene s drugog uređaja se gube).",
      "Sukob verzija", { ok: "Preuzmi noviju verziju", cancel: "Zadrži moju verziju" });
      if (take) { py.journal.splice(0); py.openDb(bytes); this.refreshAll(); }
      else await this.sync.forceLocal(py.dbBytes());
      return;
    }
    this.refreshAll();
    if (pending.length) this.sync.changed();
    if (failed.length) info("Promjene s drugog uređaja su učitane. Neke vaše promjene nije bilo moguće ponoviti:\n\n" +
      failed.map(([e, m]) => `• ${e.name}: ${m}`).join("\n"), "Spajanje promjena");
    else toast("Spojene su promjene s drugog uređaja.");
  }
  async localConflict() {
    const local = this.sync.conflictLocal;
    this.sync.conflictLocal = null;
    const take = await confirm("Na ovom uređaju postoje promjene koje nisu stigle na GitHub, a u međuvremenu je drugi uređaj spremio novu verziju.",
      "Nespremljene promjene", { ok: "Koristi verziju s GitHuba", cancel: "Zadrži verziju s ovog uređaja" });
    if (!take) { py.openDb(local.bytes); await this.sync.forceLocal(local.bytes); this.refreshAll(); }
  }

  // ------------------------------------------------------------ navigacija
  page(key) {
    if (!this.pages[key]) {
      const C = this.classes[key];
      if (!C) return null;
      const p = new C(this);
      p.key = key;
      try { p.build(); } catch (e) { console.error(e); error("Greška pri izradi stranice: " + e.message); }
      p.built = true;
      this.pages[key] = p;
    }
    return this.pages[key];
  }
  show(key, action = null) {
    const role = this.user ? this.user.role : "admin";
    if (!auth.canSee(role, key)) key = (auth.ROLE_PAGES[role] || ["dash"])[0];
    const p = this.page(key);
    if (!p) return null;
    if (this.current && this.navBtns[this.current]) this.navBtns[this.current].classList.remove("active");
    this.current = key;
    if (this.navBtns[key]) this.navBtns[key].classList.add("active");
    if (location.hash.slice(1).split("/")[0] !== key) history.replaceState(null, "", "#" + key);
    this.main.innerHTML = "";
    this.main.append(p.el);
    this.main.scrollTop = 0;
    try { p.refresh(); } catch (e) { console.error(e); error(e.message); }
    if (action && typeof p[action] === "function") setTimeout(() => p[action](), 50);
    return p;
  }
  refreshAll() {
    const n = document.getElementById("brand-name");
    if (n) n.textContent = this.db.get_setting("brewery_name");
    if (this.current) { try { this.pages[this.current].refresh(); } catch (e) { console.error(e); } }
  }
  toast(t) { toast(t); }

  // Izrada dokumenta u Pythonu (PDF/Word) i ponuda za otvaranje/preuzimanje
  async doc(name, ...args) {
    try {
      const path = await busy("Izrađujem dokument…", async (set) => {
        await py.ensureDocs(set);
        set("Izrađujem dokument…");
        return py.call(name, ...args);
      });
      if (Array.isArray(path)) path.forEach((p) => p && openFile(p)); else if (path) openFile(path);
      return path;
    } catch (e) { error(e.message); return null; }
  }

  // ------------------------------------------------------------ prijava korisnika
  loginScreen() {
    document.getElementById("splash")?.remove();
    const root = document.getElementById("app");
    root.innerHTML = "";
    const card = h("div", { class: "setup login" });
    root.append(h("div", { class: "setup-wrap" }, card));
    const un = h("input", { placeholder: "korisničko ime", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
    const pw = h("input", { type: "password", placeholder: "lozinka", autocomplete: "current-password" });
    const rem = h("input", { type: "checkbox" });
    const msg = h("div", { class: "modal-err" });
    const go = async () => {
      msg.style.display = "none";
      try {
        const cfg = await busy("Prijava…", () => auth.login(this.users, un.value, pw.value));
        const remember = rem.checked;
        store.setConfig({ ...cfg, ephemeral: !remember }, { persist: remember });
        try { localStorage.setItem("pivovara_user", JSON.stringify(cfg.user.name)); localStorage.removeItem("pivovara_token_login"); } catch { /* */ }
        location.reload();
      } catch (e) { msg.textContent = e.message; msg.style.display = "block"; pw.select(); }
    };
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    un.addEventListener("keydown", (e) => { if (e.key === "Enter") pw.focus(); });
    card.append(h("h1", {}, "🍺 Pivovara · Skladište"), h("p", { class: "sub" }, "Prijavite se svojim korisničkim imenom i lozinkom."),
      h("label", { class: "flab" }, "Korisničko ime"), un, h("label", { class: "flab" }, "Lozinka"), pw,
      h("label", { class: "chk", style: { margin: "4px 0 12px" } }, rem, " Zapamti me na ovom uređaju (samo na svom mobitelu/računalu)"),
      msg, h("div", { class: "row gap" }, btn("Prijava", go)),
      h("p", { class: "note", style: { marginTop: "18px" } }, "Zaboravljena lozinka? Novu lozinku postavlja administrator (Postavke → Korisnici)."),
      h("a", { href: "#", class: "note", onclick: (e) => { e.preventDefault(); localStorage.setItem("pivovara_token_login", "1"); this.setupScreen(); } },
        "Napredno: povezivanje tokenom (administrator)"));
    setTimeout(() => un.focus(), 50);
  }

  async install() {
    const p = window.__installPrompt;
    if (p) {
      p.prompt();
      try { await p.userChoice; } catch { /* */ }
      window.__installPrompt = null;
      return;
    }
    info(installHelp(), "Ikona na početnom zaslonu");
  }

  async logout() {
    if (this.sync && (this.sync.dirty || this.sync.saving)) await busy("Spremam…", () => this.sync.save());
    store.setConfig(null);
    await store.localClear();
    try { localStorage.removeItem("pivovara_token_login"); } catch { /* */ }
    location.hash = "";
    location.reload();
  }

  // ------------------------------------------------------------ prvo pokretanje / povezivanje
  async setupScreen(cfg = null, noData = false) {
    document.getElementById("splash")?.remove();
    const root = document.getElementById("app");
    root.innerHTML = "";
    const card = h("div", { class: "setup" });
    root.append(h("div", { class: "setup-wrap" }, card));
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem("pivovara_sync_prev") || "{}"); } catch { /* */ }
    const c = cfg || prev;
    card.append(h("h1", {}, "🍺 Pivovara · Skladište"), h("p", { class: "sub" },
      "Web verzija programa. Podaci se spremaju u vaš privatni GitHub repozitorij, pa su isti na svim uređajima."));
    const own = h("input", { placeholder: "npr. loopin-pivovara", value: c.owner || "" });
    const repo = h("input", { placeholder: "npr. pivovara-podaci", value: c.repo || "pivovara-podaci" });
    const tok = h("input", { type: "password", placeholder: "github_pat_…", value: c.token || "" });
    const msg = h("div", { class: "modal-err" });
    const step1 = h("div", { class: "setup-step" },
      h("h2", {}, "1. Povezivanje s GitHubom"),
      h("label", { class: "flab" }, "GitHub korisničko ime (vlasnik repozitorija)"), own,
      h("label", { class: "flab" }, "Privatni repozitorij za podatke"), repo,
      h("label", { class: "flab" }, "Pristupni token (fine-grained, samo za taj repozitorij: Contents – Read and write)"), tok,
      h("p", { class: "note" }, "Token se sprema samo u ovom pregledniku. Upute: datoteka UPUTE_WEB.pdf ili README u repozitoriju stranice."),
      msg);
    const row = h("div", { class: "row gap" });
    step1.append(row);
    card.append(step1);
    const connect = async () => {
      msg.style.display = "none";
      const newCfg = { mode: "github", owner: own.value.trim(), repo: repo.value.trim(), token: tok.value.trim() };
      if (!newCfg.owner || !newCfg.repo || !newCfg.token) { msg.textContent = "Upišite sva tri podatka."; msg.style.display = "block"; return; }
      try {
        const r = await busy("Provjeravam pristup…", () => store.testRepo(newCfg));
        if (!r.private && !(await confirm("Repozitorij " + r.name + " je JAVAN – podaci bi bili vidljivi svima. Preporuka: postavite ga kao Private (Settings → Danger zone → Change visibility). Nastaviti svejedno?", "Upozorenje"))) return;
        const old = store.getConfig() || prev;
        if (old && old.owner && (old.owner !== newCfg.owner || old.repo !== newCfg.repo)) await store.localClear();
        store.setConfig(newCfg);
        location.reload();
      } catch (e) { msg.textContent = e.message; msg.style.display = "block"; }
    };
    row.append(btn("Poveži", connect));
    row.append(btn("Bez GitHuba (samo ovaj preglednik)", () => {
      store.setConfig({ mode: "local" }); location.reload();
    }, "ghost"));

    if (noData) {
      // povezano, ali još nema baze -> uvoz iz desktop programa / prazno / demo
      step1.style.display = "none";
      const file = h("input", { type: "file", accept: ".db,.sqlite,application/octet-stream" });
      const st2 = h("div", { class: "setup-step" },
        h("h2", {}, "2. Podaci"),
        h("p", {}, "Učitajte bazu iz programa na računalu: datoteka ", h("b", {}, "skladiste.db"), " je u mapi ",
          h("b", {}, "Dokumenti\\PivovaraSkladiste"), ". (U desktop programu najprije zatvorite program.)"),
        file,
        h("div", { class: "row gap" },
          btn("Učitaj odabranu bazu", async () => {
            if (!file.files[0]) return info("Odaberite datoteku skladiste.db.");
            const bytes = new Uint8Array(await file.files[0].arrayBuffer());
            const head = new TextDecoder().decode(bytes.slice(0, 15));
            if (head !== "SQLite format 3") return error("Odabrana datoteka nije baza programa (skladiste.db).");
            await this.firstData(bytes);
          }),
          btn("Počni s praznom bazom", () => this.firstData(null, false), "ghost"),
          btn("Demo podaci (za probu)", () => this.firstData(null, true), "ghost")),
        h("p", { class: "note" }, "Logo pivovare možete kasnije postaviti u Postavkama."));
      card.append(st2);
      if (cfg && cfg.mode === "github") card.append(h("p", { class: "note" }, `Povezano: ${cfg.owner}/${cfg.repo}`),
        btn("Promijeni povezivanje", () => { store.setConfig(null); location.reload(); }, "ghost"));
    }
  }

  async firstData(bytes, demo = false) {
    await busy("Pripremam podatke…", async () => {
      py.openDb(bytes);
      if (!bytes && demo) py.call("db.seed_demo");
      if (!bytes && !demo) py.call("db.set_setting", "first_run_done", "1");
      await this.sync.save();
    });
    location.reload();
  }
}

export function installHelp() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (window.matchMedia("(display-mode: standalone)").matches) return "Program je već otvoren kao aplikacija s početnog zaslona.";
  if (ios) return "iPhone / iPad (Safari):\n1. Tipka Dijeli (kvadrat sa strelicom) na dnu zaslona\n2. „Dodaj na početni zaslon”\n3. „Dodaj” – na zaslonu se pojavi ikona Pivovara.";
  return "Android (Chrome):\n1. Izbornik ⋮ gore desno\n2. „Instaliraj aplikaciju” ili „Dodaj na početni zaslon”\n3. Potvrdite – na zaslonu se pojavi ikona Pivovara.\n\nRačunalo (Chrome / Edge): ikona za instalaciju desno u traci adrese.";
}

const app = new App();
window.APP = app; // za otklanjanje grešaka
app.start().catch((e) => console.error(e));
export default app;
