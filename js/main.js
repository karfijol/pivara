// Glavni dio web aplikacije: izbornik, stranice, učitavanje i spremanje baze.
import * as py from "./py.js";
import * as store from "./store.js";
import * as auth from "./auth.js";
import * as undo from "./undo.js";
import { h, btn, toast, info, error, confirm, busy, openFile, dbProxy, Dialog } from "./ui.js";
import { icon } from "./icons.js";

export const VERSION = "web 2.42";

// modul (datoteka u js/pages) za svaku stranicu (karticu); skupine i kartice su u auth.GROUPS
const MOD_OF = {
  dash: "stock", items: "stock", lots: "stock", chem: "stock", reorder: "stock", po: "stock", suppliers: "stock",
  kegwork: "kegwork", kegs: "production", returns: "reports", batches: "production", recipes: "production", planner: "production",
  haccp: "haccp", offers: "offers", pricelist: "offers", sales: "production", costs: "costs", year: "reports",
  excise: "production", recall: "production", settings: "settings", invoices: "invoices", reminders: "reminders",
};
const MODULES = ["stock", "production", "haccp", "settings", "kegwork", "costs", "offers", "reports", "invoices", "reminders"];
// donja traka na mobitelu (prve dostupne skupine prema ulozi)
const BOTTOM = ["dash", "kegovi", "proizvodnja", "skladiste", "prodaja", "haccp", "izvjesca", "settings"];
const SHORT = { dash: "Početna", kegovi: "Kegovi", proizvodnja: "Proizv.", prodaja: "Prodaja", skladiste: "Skladište",
  haccp: "HACCP", izvjesca: "Izvješća", settings: "Postavke" };

class App {
  constructor() {
    this.db = dbProxy();
    this.py = py;
    this.pages = {};
    this.classes = {};
    this.modules = {};
    this._mods = {};
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
    this.watchUpdates();

    this.sync = new store.Sync({
      getBytes: () => py.dbBytes(),
      onStatus: (s, d) => this.syncStatus(s, d),
      onRemoteChange: (bytes) => { py.openDb(bytes); this.refreshAll(); toast("Učitane su promjene s drugog uređaja."); },
    });
    this.sync.onConflict = () => this.conflict();
    this.sync.journalLen = () => py.journal.length;
    this.sync.journalDone = (n) => py.journal.splice(0, n);
    py.setOnChange((name) => { undo.changed(name); this.sync.changed(); });

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
    if (this.user && hasUsers) {
      // uloga i dopuštene stranice uvijek prema svježem users.json (administrator ih je možda promijenio)
      const u = (this.users.users || []).find((x) => x.username === this.user.username);
      if (u) {
        this.user.role = u.role || "korisnik";
        if (Array.isArray(u.pages) && u.pages.length) this.user.pages = u.pages; else delete this.user.pages;
        if (u.readonly != null) this.user.readonly = !!u.readonly; else delete this.user.readonly;
        this.user.name = u.name || this.user.name;
      }
    }
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

  // stranice se učitavaju po potrebi: najprije samo ona koja se otvara, ostale u pozadini
  loadModule(m) {
    if (!this._mods[m]) {
      this._mods[m] = import(`./pages/${m}.js`).then((mod) => {
        if (mod && mod.PAGES) Object.assign(this.classes, mod.PAGES);
        this.modules[m] = mod;
        return mod;
      }).catch((e) => { console.error(m, e); delete this._mods[m]; return null; });
    }
    return this._mods[m];
  }
  loadAllModules() { return Promise.all(MODULES.map((m) => this.loadModule(m))); }
  // u pozadini, kad je program otvoren: ostale stranice, zatim alati za PDF/Excel (prvi dokument je odmah gotov)
  preload() {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
    idle(async () => {
      await this.loadAllModules();
      setTimeout(() => { py.ensureDocs().catch((e) => console.warn("alati za dokumente:", e)); }, 2500);
    });
  }

  async openApp(bytes) {
    py.openDb(bytes || null);
    try {
      let who = this.user ? this.user.name : "";
      if (!who) { try { who = JSON.parse(localStorage.getItem("pivovara_user") || '""') || ""; } catch { /* */ } }
      py.call("webapi.set_user", who);
      py.call("webapi.set_readonly", auth.isReadonly(this.user));
    } catch (e) { console.warn(e); }
    const first = auth.firstPage(this.user);
    let key = (location.hash || "#" + first).slice(1).split("/")[0];
    if (!MOD_OF[key] || !auth.canSee(this.user, key)) key = first;
    await Promise.all([this.loadLogos(), this.loadModule(MOD_OF[key] || "stock")]);
    document.getElementById("splash")?.remove();
    this.buildShell();
    this.show(this.classes[key] ? key : first);
    window.addEventListener("hashchange", () => {
      const k = location.hash.slice(1).split("/")[0];
      if (k && k !== this.current && MOD_OF[k]) this.show(k);
    });
    this.preload();
    this.setupBack();
    setInterval(() => this.sync.poll(), 45000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.sync.poll(); });
    window.addEventListener("beforeunload", (e) => {
      if (this.sync.dirty || this.sync.saving) { this.sync.save(); e.preventDefault(); e.returnValue = ""; }
    });
    this.afterStart();
    undo.init();
    this.setupUndo();
  }

  // ↶ Poništi zadnju promjenu: tipka u izborniku, plutajuća tipka nakon promjene i Ctrl+Z
  setupUndo() {
    if (auth.isReadonly(this.user)) return;
    const fab = h("button", { type: "button", class: "undo-fab hidden", onclick: () => this.undo() }, icon("undo", 18), h("span", {}, "Poništi"));
    document.body.append(fab);
    let hideT = null;
    undo.onUpdate(() => {
      const e = undo.last();
      if (this.undoBtn) {
        this.undoBtn.classList.toggle("hidden", !e);
        this.undoBtn.title = e ? `Poništi: ${e.label}` : "";
      }
      clearTimeout(hideT);
      if (e && Date.now() - e.ts < 2000) {
        fab.title = `Poništi: ${e.label}`;
        fab.classList.remove("hidden");
        hideT = setTimeout(() => fab.classList.add("hidden"), 12000);
      } else fab.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector(".modal-back")) return;
      e.preventDefault();
      this.undo();
    });
  }

  async undo() {
    const e = undo.last();
    if (!e) return info("Nema promjena koje se mogu poništiti (pamti se zadnjih 15 radnji na ovom uređaju od otvaranja programa).", "Poništi");
    if (!(await confirm(`Poništiti zadnju promjenu?\n\n${e.label}\n(${undo.ago(e.ts)})\n\nBaza se vraća na stanje prije te radnje. `
      + "Datoteke već spremljene na GitHub (npr. PDF računa) ostaju, ali se više ne vide u programu.", "Poništi", { ok: "Poništi" }))) return;
    const r = undo.undo();
    if (!r) return;
    this.sync.changed();
    this.refreshAll();
    const n = undo.last();
    toast(`Poništeno: ${r.label}` + (n ? " · ponovno ↶ Poništi za prethodnu promjenu" : ""), 5000);
  }

  afterStart() {
    // podsjetnik za trošarine više ne iskače pri ulasku – prikazuje se kao traka na nadzornoj ploči
    this.checkDbSize();
    try { if (store.tokenExpiry) py.call("web_more.set_token_expires", store.tokenExpiry); } catch (e) { console.warn(e); }
    // jednokratno (2.33): prazni kegovi bez kupca, šarže i piva – ostaje samo u povijesti kega
    try {
      if (this.db.get_setting("keg_empty_clear") !== "1") {
        py.call("web_kegs.clear_returned_customers");
        this.db.set_setting("keg_empty_clear", "1");
      }
    } catch (e) { console.warn(e); }
    // jednokratno (2.16): operateri na HACCP dokumentima – Ivan Barić, kuhanje i pakiranje Igor Ilić (mijenja se u Postavkama HACCP)
    try {
      if (this.db.get_setting("haccp_ops_set") !== "1") {
        if (!this.db.get_setting("haccp_doc_operator")) this.db.set_setting("haccp_doc_operator", "Ivan Barić");
        if (!this.db.get_setting("haccp_brew_operator")) this.db.set_setting("haccp_brew_operator", "Igor Ilić");
        this.db.set_setting("haccp_ops_set", "1");
      }
    } catch (e) { console.warn(e); }
    // jednokratno: brojevi računa iz Excela "Matematika piva" za postojeće LOT-ove
    try {
      if (this.db.get_setting("excel_invoices_done") !== "1") {
        const n = py.call("web_costs.auto_invoices");
        if (n) toast(`Brojevi računa upisani za ${n} LOT-ova (iz Excela „Matematika piva”).`);
      }
    } catch (e) { console.warn(e); }
  }

  // baza raste s godinama: upozori ako se približi veličini kod koje spremanje postaje sporo
  checkDbSize() {
    try {
      const n = py.dbBytes().length;
      this.dbSize = n;
      if (n > 5 * 1024 * 1024) toast(`Baza ima ${(n / 1048576).toFixed(1)} MB – spremanje je sporije. Javite se za arhiviranje starih podataka.`);
    } catch { /* */ }
  }

  // ------------------------------------------------------------ nova verzija programa
  // program se otvara odmah iz spremljene kopije; nova verzija preuzme se u pozadini i nudi se tipkom „Osvježi”
  watchUpdates() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const offer = (w) => { if (w && navigator.serviceWorker.controller) this.updateBanner(w); };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => { if (w.state === "installed") offer(w); });
      });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (this._wantReload && !reloading) { reloading = true; location.reload(); } });
  }
  updateBanner(worker) {
    if (document.getElementById("upd-banner")) return;
    const bar = h("div", { id: "upd-banner", class: "upd-banner" }, h("span", {}, "Dostupna je nova verzija programa."),
      btn("Osvježi", async () => {
        try { if (this.sync && (this.sync.dirty || this.sync.saving)) await busy("Spremam…", () => this.sync.save()); } catch { /* */ }
        this._wantReload = true;
        worker.postMessage({ type: "skip" });
        setTimeout(() => location.reload(), 3000);
      }), btn("Kasnije", () => bar.remove(), "ghost"));
    document.body.append(bar);
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
    if (u) {
      // svijetli (bijeli) ili tamni logo: u izborniku se prilagodi svijetloj / tamnoj temi
      const img = h("img", { src: u, alt: "logo" });
      img.addEventListener("load", () => {
        try {
          const c = document.createElement("canvas"); const w = c.width = 48, ht = c.height = 48;
          const x = c.getContext("2d"); x.drawImage(img, 0, 0, w, ht);
          const d = x.getImageData(0, 0, w, ht).data; let n = 0, lum = 0, sat = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            const r = d[i], g = d[i + 1], b = d[i + 2]; n++;
            lum += (0.299 * r + 0.587 * g + 0.114 * b) / 255; sat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
          }
          if (n > 30 && n < w * ht * 0.92 && sat / n < 0.15) img.classList.add(lum / n > 0.75 ? "logo-light" : lum / n < 0.25 ? "logo-dark" : "logo-mid");
        } catch { /* */ }
      });
      box.append(img);
    } else box.append(h("img", { src: "icons/pivara-logo.png", alt: "PIVARA", class: "brand-pivara" }));
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
    this.groupBtns = {};
    for (const [g, ic, label] of this.visibleGroups()) {
      const b = h("a", { class: "nav-btn", href: "#" + this.groupTarget(g), onclick: (e) => { e.preventDefault(); this.closeMenu(); this.show(this.groupTarget(g)); } },
        h("span", { class: "ico" }, icon(ic)), label);
      this.groupBtns[g] = b;
      navList.append(b);
    }
    // mobitel: donja traka s prvim dostupnim skupinama + "Izbornik"
    this.bottomBtns = {};
    const bottom = h("nav", { class: "bottom-bar" });
    const vis = new Map(this.visibleGroups().map((x) => [x[0], x]));
    for (const g of BOTTOM.filter((k) => vis.has(k) && (k !== "settings" || vis.size <= 4)).slice(0, 4)) {
      const b = h("a", { href: "#" + this.groupTarget(g), class: "bb-btn", onclick: (e) => { e.preventDefault(); this.closeMenu(); this.show(this.groupTarget(g)); } },
        icon(vis.get(g)[1], 22), h("span", {}, SHORT[g] || vis.get(g)[2]));
      this.bottomBtns[g] = b;
      bottom.append(b);
    }
    bottom.append(h("button", { type: "button", class: "bb-btn", onclick: () => document.body.classList.toggle("menu-open") },
      icon("more", 22), h("span", {}, "Više")));
    this.statusEl = h("div", { class: "sync-status", title: "" });
    const who = this.user ? h("div", { class: "who" }, h("span", { class: "who-n" }, icon("user", 16), " " + this.user.name,
        auth.isReadonly(this.user) ? h("span", { class: "ro" }, "samo čitanje") : null),
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.logout(); } }, "Odjava")) : null;
    // tipka je uvijek vidljiva (osim kad je program već otvoren kao aplikacija); bez automatske ponude preglednika prikaže upute
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const inst = h("a", { href: "#", class: "install" + (standalone ? " hidden" : ""), onclick: (e) => { e.preventDefault(); this.closeMenu(); this.install(); } },
      icon("install", 16), " Instaliraj kao aplikaciju");
    this.undoBtn = h("a", { href: "#", class: "undo-link hidden", onclick: (e) => { e.preventDefault(); this.closeMenu(); this.undo(); } },
      icon("undo", 16), " Poništi zadnju promjenu");
    this.side.append(brand, navList, h("div", { class: "side-foot" }, inst, this.undoBtn, who, this.statusEl, h("div", { class: "ver" }, VERSION)));
    const burger = h("button", { class: "burger", type: "button", onclick: () => document.body.classList.toggle("menu-open") }, "☰");
    const scrim = h("div", { class: "scrim", onclick: () => this.closeMenu() });
    root.append(burger, this.side, scrim, this.main, bottom);
    this.applyLogo();
    this.syncStatus(this.sync.status);
    this.applyTheme();
  }
  // skupine (glavne stranice) s barem jednom dopuštenom karticom
  visibleGroups() {
    return auth.GROUPS.map(([g, ic, label, tabs]) => [g, ic, label, tabs.filter(([k]) => auth.canSee(this.user, k))])
      .filter((x) => x[3].length);
  }
  // kartica koja se otvara klikom na skupinu: zadnja korištena (ako je dopuštena), inače prva
  groupTarget(g) {
    const grp = this.visibleGroups().find((x) => x[0] === g);
    if (!grp) return auth.firstPage(this.user);
    let last = null;
    try { last = localStorage.getItem("tab_" + g); } catch { /* */ }
    return grp[3].some(([k]) => k === last) ? last : grp[3][0][0];
  }
  tabsBar(key) {
    const g = auth.GROUP_OF[key];
    const grp = this.visibleGroups().find((x) => x[0] === g);
    if (!grp) return null;
    const tabs = grp[3];
    const cur = tabs.find((t) => t[0] === key);
    const parent = cur && cur[2] ? cur[2] : key;
    const top = tabs.filter((t) => !t[2]);
    const sub = tabs.filter((t) => t[0] === parent || t[2] === parent);
    const subKey = (k) => { try { return localStorage.getItem("sub_" + k) || k; } catch { return k; } };
    if (cur && sub.length > 1) { try { localStorage.setItem("sub_" + parent, key); } catch { /* */ } }
    const wrap = h("div", { class: "tabs-wrap" });
    if (top.length > 1) {
      wrap.append(h("div", { class: "page-tabs" }, top.map(([k, label]) => {
        const target = tabs.some((t) => t[2] === k) ? subKey(k) : k;
        const go = tabs.some((t) => t[0] === target) ? target : k;
        return h("a", { href: "#" + go, class: "page-tab" + (k === parent ? " active" : ""), onclick: (e) => { e.preventDefault(); this.show(go); } }, label);
      })));
    }
    if (sub.length > 1) {
      wrap.append(h("div", { class: "sub-tabs" }, sub.map(([k, label, , subLabel]) =>
        h("a", { href: "#" + k, class: "sub-tab" + (k === key ? " active" : ""), onclick: (e) => { e.preventDefault(); this.show(k); } }, subLabel || label))));
    }
    return wrap.childNodes.length ? wrap : null;
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
      try { if (p.layoutActions) p.layoutActions(); } catch (e) { console.error(e); }
      p.built = true;
      this.pages[key] = p;
    }
    return this.pages[key];
  }
  show(key, action = null, isBack = false) {
    if (!MOD_OF[key] || !auth.canSee(this.user, key)) key = auth.firstPage(this.user);
    if (!this.classes[key] && MOD_OF[key]) {
      // stranica još nije učitana: učitaj je pa prikaži (traje djelić sekunde)
      this.loadModule(MOD_OF[key]).then(() => { if (this.classes[key]) this.show(key, action, isBack); });
      return null;
    }
    const p = this.page(key);
    if (!p) return null;
    if (!isBack && this.current && this.current !== key) {
      this.backStack = (this.backStack || []).filter((k) => k !== key).concat(this.current).slice(-30);
    }
    this.current = key;
    const g = auth.GROUP_OF[key];
    try { localStorage.setItem("tab_" + g, key); } catch { /* */ }
    for (const [k, b] of Object.entries(this.groupBtns || {})) { b.classList.toggle("active", k === g); b.href = "#" + this.groupTarget(k); }
    for (const [k, b] of Object.entries(this.bottomBtns || {})) { b.classList.toggle("active", k === g); b.href = "#" + this.groupTarget(k); }
    if (location.hash.slice(1).split("/")[0] !== key) history.replaceState(null, "", "#" + key);
    this.main.innerHTML = "";
    const tb = this.tabsBar(key);
    if (tb) this.main.append(...tb.childNodes);
    this.main.append(p.el);
    this.main.scrollTop = 0;
    try { p.refresh(); } catch (e) { console.error(e); error(e.message); }
    document.body.classList.remove("has-selbar");
    if (p._selUpd) p._selUpd();
    if (action && typeof p[action] === "function") setTimeout(() => p[action](), 50);
    return p;
  }
  // ------------------------------------------------------------ natrag (povlačenje prstom s lijeva na desno, tipka natrag)
  // redom: zatvori otvoreni prozor (dijalog) → izbornik → radni prikaz stranice (npr. lista kegova) → prethodna stranica
  goBack() {
    const modals = [...document.querySelectorAll(".modal-back")];
    if (modals.length) {
      const top = modals.sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0)).pop();
      const x = top.querySelector(".modal-x") || [...top.querySelectorAll(".modal-bar button")].find((b) => /^(Odustani|Zatvori|Ne)$/.test(b.textContent.trim()));
      if (x) { x.click(); return true; }
    }
    if (document.body.classList.contains("menu-open")) { document.body.classList.remove("menu-open"); return true; }
    const p = this.current && this.pages[this.current];
    if (p && typeof p.onBack === "function" && p.onBack()) return true;
    const prev = (this.backStack || []).pop();
    if (prev) { this.show(prev, null, true); return true; }
    return false;
  }

  setupBack() {
    if (this._backReady) return;
    this._backReady = true;
    // sistemska tipka / gesta natrag (Android, preglednik): ostaje u programu dok ima kamo natrag
    try { history.pushState({ pivovaraGuard: 1 }, "", location.href); } catch { /* */ }
    window.addEventListener("popstate", () => {
      const k = location.hash.slice(1).split("/")[0];
      if (k && k !== this.current && MOD_OF[k]) return; // promjena adrese (#stranica) – obradi hashchange
      if (this.goBack()) { try { history.pushState({ pivovaraGuard: 1 }, "", location.href); } catch { /* */ } }
    });
    // povlačenje prstom s lijeva na desno (mobitel)
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    let st = null;
    const scrollsX = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (e.scrollWidth > e.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowX)) return true;
        if (e.matches && e.matches("input[type=range], video, canvas, .scanner, .no-swipe")) return true;
      }
      return false;
    };
    document.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { st = null; return; }
      const t = e.touches[0];
      // rub zaslona (≈ 20 px) prepuštamo sustavu – njegova gesta natrag dolazi kao popstate
      st = t.clientX < 20 || scrollsX(e.target) ? null : { x: t.clientX, y: t.clientY, t: Date.now() };
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
      if (!st) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - st.x, dy = t.clientY - st.y, dt = Date.now() - st.t;
      st = null;
      if (dx > 80 && Math.abs(dy) < 60 && dx > 2.5 * Math.abs(dy) && dt < 700) {
        const sel = window.getSelection && String(window.getSelection());
        if (sel) return;
        this.goBack();
      }
    }, { passive: true });
  }

  refreshAll() {
    const n = document.getElementById("brand-name");
    if (n) n.textContent = this.db.get_setting("brewery_name");
    if (this.current) { try { this.pages[this.current].refresh(); } catch (e) { console.error(e); } }
  }
  toast(t) { toast(t); }

  // Izrada dokumenta u Pythonu (PDF/Excel) i ponuda za otvaranje/preuzimanje
  async doc(name, ...args) {
    try {
      const path = await busy("Izrađujem dokument…", async (set) => {
        await py.ensureDocs(set);
        set("Izrađujem dokument…");
        return py.call(name, ...args);
      });
      if (Array.isArray(path)) path.forEach((p) => p && openFile(p));
      else if (path && typeof path === "object" && path.path) openFile(path.path);
      else if (path) openFile(path);
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
    card.append(h("img", { src: "icons/pivara-logo.png", alt: "PIVARA", class: "login-logo pivara-logo" }), h("h1", {}, "Skladište"), h("p", { class: "sub" }, "Prijavite se svojim korisničkim imenom i lozinkom."),
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
    card.append(h("img", { src: "icons/pivara-logo.png", alt: "PIVARA", class: "login-logo pivara-logo" }), h("h1", {}, "Skladište"), h("p", { class: "sub" },
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
      // povezano, ali još nema baze -> učitaj sigurnosnu kopiju / prazno / demo
      step1.style.display = "none";
      const file = h("input", { type: "file", accept: ".db,.sqlite,application/octet-stream" });
      const st2 = h("div", { class: "setup-step" },
        h("h2", {}, "2. Podaci"),
        h("p", {}, "Učitajte postojeću bazu (sigurnosnu kopiju ", h("b", {}, "skladiste.db"),
          " preuzetu u Postavke → Podaci i arhiva) ili počnite s praznom bazom."),
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
