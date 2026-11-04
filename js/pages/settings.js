// Postavke: izgled, osnovni podaci, logo, prodaja, naljepnice, podaci i povezivanje s GitHubom.
import { h, btn, Page, Form, confirm, info, error, busy, toast, saveBlob, tableDialog, today } from "../ui.js";
import * as store from "../store.js";
import * as auth from "../auth.js";
import { Table, askForm } from "../ui.js";

function card(title, note = null) {
  const c = h("div", { class: "card" }, h("h3", {}, title));
  if (note) c.append(h("div", { class: "muted", style: { marginBottom: "8px", fontSize: "12.5px" } }, note));
  return c;
}

function pickFile(accept) {
  return new Promise((res) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    inp.addEventListener("change", () => { res(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

// slika -> PNG (najviše 900 px), kao što desktop sprema logo.png
function toPng(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(async (b) => { URL.revokeObjectURL(url); res(new Uint8Array(await b.arrayBuffer())); }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Slika se ne može učitati.")); };
    img.src = url;
  });
}

class SettingsPage extends Page {
  static title = "Postavke";

  build() {
    const db = this.db;
    const g = (k) => db.get_setting(k);

    // ---------- izgled i osnovno
    const c = card("Izgled");
    let theme = "system";
    try { theme = localStorage.getItem("theme") || "system"; } catch { /* */ }
    const seg = h("div", { class: "seg", style: { marginBottom: "12px" } });
    for (const [v, lab] of [["dark", "Tamna"], ["light", "Svijetla"], ["system", "Sustav"]]) {
      const b = h("button", { type: "button", class: v === theme ? "on" : "" }, lab);
      b.onclick = () => {
        try { localStorage.setItem("theme", v); } catch { /* */ }
        seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        this.app.applyTheme();
        if (this.app.pages.dash) setTimeout(() => this.app.pages.dash.refresh && 0, 50);
      };
      seg.append(b);
    }
    c.append(seg);
    let me = "";
    try { me = JSON.parse(localStorage.getItem("pivovara_user") || '""') || ""; } catch { /* */ }
    const meInp = h("input", { value: me, placeholder: "npr. Ivan", style: { maxWidth: "280px" } });
    meInp.addEventListener("change", () => {
      try { localStorage.setItem("pivovara_user", JSON.stringify(meInp.value.trim())); } catch { /* */ }
      toast("Ime spremljeno za ovaj uređaj.");
    });
    c.append(h("div", { class: "row gap", style: { margin: "0 0 12px" } },
      btn("📲 Ikona na početnom zaslonu", async () => {
        const m = await import("../main.js");
        if (window.__installPrompt) this.app.install(); else info(m.installHelp(), "Ikona na početnom zaslonu");
      }, "ghost")));
    c.append(h("label", { class: "flab" }, "Moje ime na ovom uređaju (upisuje se kao radnik kod rada s kegovima)"), meInp,
      h("div", { style: { height: "12px" } }));
    this.form = new Form([
      { key: "brewery_name", label: "Naziv pivovare (u programu i na narudžbenicama)" },
      { key: "warn_days", label: "Upozori na istek roka (dana unaprijed)", type: "num", min: 0 },
      { key: "batch_scheme", label: "Broj šarže (LOT piva)", type: "combo",
        options: [["HACCP: DDMMGGGG + oznaka + broj (npr. 16032026PA1)", "haccp"],
          ["Klasično: prefiks + godina + broj (npr. B26-001)", "classic"]] },
      { key: "batch_prefix", label: "Prefiks (samo za klasični broj šarže)" },
      { key: "po_prefix", label: "Prefiks broja narudžbenice" }],
    Object.fromEntries(["brewery_name", "warn_days", "batch_scheme", "batch_prefix", "po_prefix"].map((k) => [k, g(k)])), 2);
    c.append(this.form.el, h("div", { style: { marginTop: "10px" } }, btn("Spremi postavke", () => this.save())));

    // ---------- logo
    const cl = card("Logo pivovare", "Možete imati dva loga: jedan za izbornik u programu (npr. svijetla verzija za tamnu pozadinu) " +
      "i drugi za dokumente, naljepnice i ikonu kartice preglednika. Ako logo za program nije odabran, koristi se logo za dokumente. " +
      "Preporuka: PNG s prozirnom pozadinom.");
    this.logoPrev = {};
    for (const [which, title] of [["app", "Logo u programu (izbornik)"], ["doc", "Logo na dokumentima i naljepnicama"]]) {
      this.logoPrev[which] = h("div", { class: "logo-prev" });
      cl.append(h("div", { class: "row gap", style: { margin: "10px 0" } },
        h("div", { style: { width: "250px", fontWeight: 600 } }, title), this.logoPrev[which],
        btn("Odaberi…", () => this.pickLogo(which)), btn("Ukloni", () => this.removeLogo(which), "ghost")));
    }

    // ---------- prodaja
    const cs = card("Prodaja i troškovi");
    const k2 = ["keg_size_l", "keg_fill_l", "keg_deposit", "extra_cost_l", "dn_prefix", "dn_company", "dn_address", "company_oib", "dn_contact", "dn_iban"];
    this.form2 = new Form([
      { key: "keg_size_l", label: "Osnovna veličina kega (L)", type: "num", required: true, positive: true },
      { key: "keg_fill_l", label: "Piva u punom kegu (L) – kupcu se izdaju samo kegovi s ovom količinom", type: "num", required: true, positive: true },
      { key: "keg_deposit", label: "Depozit po kegu (€)", type: "num", min: 0 },
      { key: "extra_cost_l", label: "Ostali troškovi po litri piva (€) – ambalaža, energija, rad", type: "num", min: 0 },
      { key: "dn_prefix", label: "Prefiks broja otpremnice" },
      { key: "dn_company", label: "Isporučitelj na otpremnici (naziv tvrtke)" },
      { key: "dn_address", label: "Adresa isporučitelja" },
      { key: "company_oib", label: "OIB tvrtke" },
      { key: "dn_contact", label: "Kontakt (telefon / e-mail, neobavezno)" },
      { key: "dn_iban", label: "IBAN (neobavezno)" }], Object.fromEntries(k2.map((k) => [k, g(k)])), 3);
    cs.append(this.form2.el, h("div", { style: { marginTop: "10px" } }, btn("Spremi", () => this.save2())));

    // ---------- naljepnice
    const cn = card("Naljepnice za kegove", "Obvezni podaci prema Uredbi (EU) 1169/2011. Naziv piva, alkohol, neto količina, " +
      "datum punjenja, rok i LOT uzimaju se iz šarže i kega.");
    const checks = ["label_show_style", "label_qr", "label_show_ingredients", "label_pictograms"];
    const lk = ["label_brand", "label_food_name", "label_producer", "label_address", "label_allergens", "label_storage", ...checks];
    this.form3 = new Form([
      { key: "label_brand", label: "Naziv pivovare (zaglavlje)" },
      { key: "label_food_name", label: "Naziv hrane (npr. Pivo, Svijetlo pivo)" },
      { key: "label_producer", label: "Proizvođač" },
      { key: "label_address", label: "Adresa proizvođača" },
      { key: "label_allergens", label: "Alergeni – zadano (VELIKIM slovima)" },
      { key: "label_storage", label: "Uvjeti čuvanja" },
      { key: "label_show_style", label: "Ispiši stil piva uz naziv hrane", type: "check" },
      { key: "label_qr", label: "QR kod (keg, LOT) na naljepnici", type: "check" },
      { key: "label_show_ingredients", label: "Popis sastojaka (dobrovoljno; automatski iz recepture)", type: "check" },
      { key: "label_pictograms", label: "Piktogrami: 18+, ne za trudnice, ne vozi (dobrovoljno)", type: "check" }],
    Object.fromEntries(lk.map((k) => [k, checks.includes(k) ? (g(k) === "0" || !g(k) ? 0 : 1) : g(k)])), 2);
    cn.append(this.form3.el, h("div", { class: "row gap", style: { marginTop: "10px" } },
      btn("Spremi", () => this.save3()), btn("🏷 Probne naljepnice (PDF)", () => this.labelSample(), "ghost")));

    // ---------- podaci i povezivanje
    const cfg = store.getConfig() || {};
    const cd = card("Podaci i spremanje");
    if (cfg.mode === "github") {
      cd.append(h("div", {}, "Podaci se spremaju u privatni GitHub repozitorij ", h("b", {}, `${cfg.owner}/${cfg.repo}`),
        " (datoteka skladiste.db). Svako spremanje je nova verzija – stare verzije su u povijesti repozitorija."),
      h("div", { class: "row gap", style: { margin: "10px 0" } },
        btn("☁ Spremi odmah", () => this.app.sync.save().then(() => toast("Spremljeno."))),
        h("a", { class: "btn btn-ghost", href: `https://github.com/${cfg.owner}/${cfg.repo}/commits`, target: "_blank", rel: "noopener" }, "🕘 Povijest verzija"),
        btn("Promijeni povezivanje / token", () => this.reconnect(), "ghost")));
    } else {
      cd.append(h("div", { class: "banner warn" }, "Podaci su spremljeni samo u ovom pregledniku. Za rad na više uređaja povežite GitHub."),
        h("div", { class: "row gap", style: { margin: "10px 0" } }, btn("Poveži s GitHubom", () => this.reconnect())));
    }
    cd.append(h("div", { class: "row gap", style: { marginTop: "6px" } },
      btn("💾 Preuzmi bazu (.db)", () => this.backup()),
      btn("📤 Učitaj bazu iz desktop programa…", () => this.replaceDb(), "ghost"),
      btn("Učitaj demo podatke", () => this.demo(), "ghost"),
      btn("📥 Uvezi povijesne podatke…", () => this.importHistory(), "ghost")),
    h("p", { class: "note" }, "Preuzeta datoteka skladiste.db može se kopirati u Dokumenti\\PivovaraSkladiste i otvoriti u programu na " +
      "računalu (i obrnuto). Ne radite istovremeno u obje verzije – vrijedi zadnja spremljena baza."),
    h("div", { class: "row gap", style: { marginTop: "6px" } },
      btn("Odjavi ovaj uređaj", () => this.logout(), "ghost")));

    const role = this.app.user ? this.app.user.role : "admin";
    this.usersCard = card("Korisnici i prijava");
    if (role === "admin") for (const x of [c, this.usersCard, cl, cs, cn, cd]) this.content.append(x);
    else {
      // korisnik bez administratorskih prava vidi samo izgled i svoje podatke
      [...c.children].forEach((ch, i) => { if (i > 0 && ch === this.form.el) ch.remove(); });
      c.querySelectorAll(".btn").forEach((b) => { if (b.textContent.includes("Spremi postavke")) b.remove(); });
      this.content.append(c, this.usersCard);
    }
    this.renderUsers();
  }

  // -------------------------------------------------------------- korisnici
  renderUsers() {
    const box = this.usersCard;
    while (box.children.length > 1) box.lastChild.remove();
    const cfg = store.getConfig() || {};
    const users = this.app.users;
    const me = this.app.user;
    if (me && me.role !== "admin") {
      box.append(h("div", {}, `Prijavljeni ste kao `, h("b", {}, `${me.name} (${me.username})`), ` · uloga: ${me.role}.`),
        h("p", { class: "note" }, "Promjenu lozinke napravit će administrator (Postavke → Korisnici)."),
        btn("Odjava", () => this.app.logout(), "ghost"));
      return;
    }
    if (!users || !(users.users || []).length) {
      box.append(h("div", { class: "muted" }, "Prijava korisnika je isključena – program se otvara tokenom spremljenim na uređaju. " +
        "Uključite prijavu da se svaki radnik prijavljuje svojim korisničkim imenom i lozinkom, bez tokena."));
      if (cfg.mode === "github") box.append(h("div", { class: "row gap", style: { marginTop: "10px" } },
        btn("👥 Uključi prijavu korisnika…", () => this.enableUsers())));
      else box.append(h("p", { class: "note" }, "Najprije povežite program s GitHubom (kartica Podaci i spremanje)."));
      return;
    }
    if (!cfg.keys || !cfg.adminToken) {
      box.append(h("div", { class: "muted" }, "Korisnicima upravlja administrator nakon prijave svojim korisničkim imenom."),
        btn("Odjava i prijava kao administrator", () => this.app.logout(), "ghost"));
      return;
    }
    const roleName = Object.fromEntries(auth.ROLES.map(([k, d]) => [k, d.split(" – ")[0]]));
    this.uT = new Table([["username", "Korisničko ime", 140, "w"], ["name", "Ime i prezime", 180, "w"], ["role", "Uloga", 130, "w"],
      ["created", "Dodan", 100, "center"]], { onDouble: () => this.editUser(), height: 8 });
    this.uT.setRows(users.users.map((u) => ({ id: u.username, username: u.username, name: u.name || "", role: roleName[u.role] || u.role,
      created: (u.created || "").slice(0, 10).split("-").reverse().join(".") + ".", _tag: u.username === me.username ? "bold" : "" })));
    box.append(this.uT.el, h("div", { class: "row gap", style: { marginTop: "10px" } },
      btn("＋ Novi korisnik", () => this.newUser()), btn("✎ Uredi / nova lozinka", () => this.editUser(), "ghost"),
      btn("🗑 Obriši", () => this.deleteUser(), "ghost"), btn("🔑 Zamijeni tokene", () => this.replaceTokens(), "ghost")),
    h("p", { class: "note" }, "Uloge: " + auth.ROLES.map(([, d]) => d).join(" · ") + ". Lozinke se ne spremaju nigdje – " +
      "ako ih netko zaboravi, administrator postavlja novu. Kad netko ode iz tvrtke: obrišite ga i zamijenite tokene."));
  }

  userFields(isNew, u = {}) {
    return [
      { key: "username", label: "Korisničko ime (mala slova, bez razmaka)", required: true, default: u.username },
      { key: "name", label: "Ime i prezime", required: true, default: u.name },
      { key: "role", label: "Uloga", type: "combo", options: auth.ROLES.map(([k, d]) => [d, k]), default: u.role || "korisnik", full: true },
      { key: "password", label: isNew ? "Lozinka (najmanje 10 znakova)" : "Nova lozinka (prazno = bez promjene)", required: isNew },
      { key: "password2", label: "Ponovite lozinku", required: isNew }];
  }

  async saveUsersFile(users, msg) {
    const cfg = store.getConfig();
    // adresa stranice je možda promijenjena (preimenovan repozitorij) -> spremi u trenutni repozitorij stranice
    const here = auth.siteRepo();
    if (here) users.site = here;
    await busy("Spremam korisnike na GitHub…", () => auth.saveUsers(users, users.site, cfg.adminToken));
    this.app.users = users;
    toast(msg);
    this.renderUsers();
  }

  async newUser() {
    const d = await askForm("Novi korisnik", this.userFields(true), {}, { columns: 2, validate: (x) => {
      if (x.password !== x.password2) throw new Error("Lozinke se ne podudaraju.");
      auth.checkPassword(x.password);
    } });
    if (!d) return;
    try {
      const users = structuredClone(this.app.users);
      await auth.upsertUser(users, store.getConfig().keys, d, true);
      await this.saveUsersFile(users, `Korisnik ${auth.normUser(d.username)} dodan. Neka se prijavi na adresi stranice.`);
    } catch (e) { this.err(e); }
  }

  async editUser() {
    const id = this.need(this.uT, "korisnika");
    if (id === null) return;
    const u = this.app.users.users.find((x) => x.username === String(id));
    const fields = this.userFields(false, u);
    fields[0] = { key: "username", label: "Korisničko ime", type: "info", default: u.username };
    const d = await askForm(`Korisnik ${u.username}`, fields, {}, { columns: 2, validate: (x) => {
      if ((x.password || "") !== (x.password2 || "")) throw new Error("Lozinke se ne podudaraju.");
      if (x.password) auth.checkPassword(x.password);
      if (x.role !== u.role && !x.password) throw new Error("Kod promjene uloge upišite novu lozinku za korisnika.");
    } });
    if (!d) return;
    try {
      const users = structuredClone(this.app.users);
      const admins = users.users.filter((x) => x.role === "admin");
      if (u.role === "admin" && d.role !== "admin" && admins.length === 1) throw new Error("Mora ostati barem jedan administrator.");
      await auth.upsertUser(users, store.getConfig().keys, { ...d, username: u.username }, false);
      await this.saveUsersFile(users, `Korisnik ${u.username} spremljen.` + (d.password ? " Nova lozinka vrijedi odmah." : ""));
      if (u.username === this.app.user.username && d.password) {
        await info("Promijenili ste svoju lozinku – prijavite se ponovno novom lozinkom.");
        this.app.logout();
      }
    } catch (e) { this.err(e); }
  }

  async deleteUser() {
    const id = this.need(this.uT, "korisnika");
    if (id === null) return;
    if (String(id) === this.app.user.username) return info("Ne možete obrisati sami sebe.");
    if (!(await confirm(`Obrisati korisnika ${id}? Više se neće moći prijaviti.`, "Brisanje korisnika", { danger: true }))) return;
    try {
      const users = auth.removeUser(structuredClone(this.app.users), String(id));
      await this.saveUsersFile(users, `Korisnik ${id} obrisan.`);
      info("Korisnik je obrisan. Ako je osoba otišla iz tvrtke, preporuka je i zamijeniti tokene (🔑 Zamijeni tokene) " +
        "– tada stari token prestaje vrijediti i na uređajima na kojima je ostao zapamćen.");
    } catch (e) { this.err(e); }
  }

  async replaceTokens() {
    const cfg = store.getConfig();
    const d = await askForm("Zamjena tokena", [
      { key: "info", type: "info", label: "", default: "Na GitHubu napravite nove tokene, ovdje ih upišite, pa stare obrišite (Settings → Developer settings → Fine-grained tokens). Korisnici ne moraju ništa mijenjati." },
      { key: "worker", label: "Novi token za podatke (samo repozitorij podataka, Contents: Read and write) – prazno = bez promjene" },
      { key: "admin", label: "Novi token administratora (repozitorij podataka + stranice) – prazno = bez promjene" }], {}, { width: 640 });
    if (!d || (!d.worker && !d.admin)) return;
    try {
      if (d.worker) await store.testRepo({ owner: cfg.owner, repo: cfg.repo, token: d.worker.trim() });
      if (d.admin) {
        const sr = auth.siteRepo() || this.app.users.site;
        const t = await store.testRepo({ owner: sr.owner, repo: sr.repo, token: d.admin.trim() });
        if (!t.push) throw new Error("Token administratora nema pravo pisanja u repozitorij stranice.");
      }
      const users = structuredClone(this.app.users);
      if (auth.siteRepo()) users.site = auth.siteRepo();
      await auth.replaceTokens(users, cfg.keys, { workerToken: d.worker && d.worker.trim(), adminToken: d.admin && d.admin.trim() });
      const adminTok = d.admin ? d.admin.trim() : cfg.adminToken;
      await busy("Spremam…", () => auth.saveUsers(users, users.site, adminTok));
      this.app.users = users;
      await info("Tokeni su zamijenjeni. Prijavite se ponovno.");
      this.app.logout();
    } catch (e) { this.err(e); }
  }

  async enableUsers() {
    const cfg = store.getConfig();
    const sr = auth.siteRepo() || { owner: cfg.owner, repo: "pivovara" };
    const d = await askForm("Uključi prijavu korisnika", [
      { type: "section", label: "1. Repozitoriji" },
      { key: "site", label: "Repozitorij stranice (vlasnik/naziv)", required: true, default: `${sr.owner}/${sr.repo}` },
      { key: "info1", type: "info", label: "", default: `Podaci: ${cfg.owner}/${cfg.repo}` },
      { type: "section", label: "2. Tokeni" },
      { key: "worker", label: "Token za korisnike – samo repozitorij PODATAKA (Contents: Read and write)", required: true, default: cfg.token, full: true },
      { key: "admin", label: "Token administratora – repozitoriji PODATAKA i STRANICE (Contents: Read and write)", required: true, full: true },
      { type: "section", label: "3. Prvi administrator (vi)" },
      { key: "username", label: "Korisničko ime", required: true },
      { key: "name", label: "Ime i prezime", required: true, default: (this.app.user && this.app.user.name) || "" },
      { key: "password", label: "Lozinka (najmanje 10 znakova)", required: true },
      { key: "password2", label: "Ponovite lozinku", required: true }], {}, { columns: 2, okText: "Uključi prijavu", validate: (x) => {
      if (x.password !== x.password2) throw new Error("Lozinke se ne podudaraju.");
      auth.checkPassword(x.password);
      if (!/^[^/\s]+\/[^/\s]+$/.test(x.site.trim())) throw new Error("Repozitorij stranice upišite kao vlasnik/naziv, npr. ivan/pivovara.");
    } });
    if (!d) return;
    try {
      const [so, sn] = d.site.trim().split("/");
      const site = { owner: so, repo: sn };
      await busy("Provjeravam tokene…", async () => {
        const a1 = await store.testRepo({ owner: so, repo: sn, token: d.admin.trim() });
        if (!a1.push) throw new Error("Token administratora nema pravo pisanja u repozitorij stranice " + d.site);
        const a2 = await store.testRepo({ owner: cfg.owner, repo: cfg.repo, token: d.admin.trim() });
        if (!a2.push) throw new Error("Token administratora nema pravo pisanja u repozitorij podataka.");
        const w = await store.testRepo({ owner: cfg.owner, repo: cfg.repo, token: d.worker.trim() });
        if (!w.push) throw new Error("Token za korisnike nema pravo pisanja u repozitorij podataka.");
      });
      if (this.app.sync.dirty) await this.app.sync.save();
      const users = await auth.initUsers({ owner: cfg.owner, repo: cfg.repo, workerToken: d.worker.trim(), adminToken: d.admin.trim(),
        site, admin: { username: d.username, name: d.name, password: d.password } });
      await busy("Spremam korisnike na GitHub…", () => auth.saveUsers(users, site, d.admin.trim()));
      this.app.users = users;
      try { localStorage.removeItem("pivovara_token_login"); } catch { /* */ }
      await info(`Prijava korisnika je uključena. Prijavite se kao '${auth.normUser(d.username)}' i dodajte ostale korisnike (Postavke → Korisnici).`);
      this.app.logout();
    } catch (e) { this.err(e); }
  }

  refresh() {
    for (const [which, box] of Object.entries(this.logoPrev)) {
      const path = this.app.py.DATA_DIR + "/" + (which === "app" ? "logo_app.png" : "logo.png");
      box.innerHTML = "";
      if (this.app.py.exists(path)) {
        box.append(h("img", { src: URL.createObjectURL(new Blob([this.app.py.readFile(path)], { type: "image/png" })) }));
      } else box.textContent = which === "app" ? "(kao logo za dokumente)" : "(nema loga)";
    }
  }

  async pickLogo(which) {
    const f = await pickFile("image/*");
    if (!f) return;
    try {
      const png = await toPng(f);
      await busy("Spremam logo…", () => this.app.setLogo(which, png));
      this.refresh();
      toast("Logo spremljen.");
    } catch (e) { this.err(e); }
  }
  async removeLogo(which) {
    if (await confirm("Ukloniti ovaj logo?", "Logo")) {
      await this.app.setLogo(which, null);
      this.refresh();
    }
  }

  save() {
    try {
      const d = this.form.get();
      d.warn_days = Math.round(d.warn_days || 30);
      for (const [k, v] of Object.entries(d)) this.db.set_setting(k, v ?? "");
      this.app.refreshAll();
      toast("Postavke spremljene.");
    } catch (e) { this.err(e); }
  }
  save2() {
    try {
      const d = this.form2.get();
      const oib = (d.company_oib || "").trim();
      if (oib && !/^\d{11}$/.test(oib)) throw new Error("OIB mora imati točno 11 znamenki.");
      if (d.keg_fill_l > d.keg_size_l) throw new Error("Količina piva u kegu ne može biti veća od veličine kega.");
      for (const [k, v] of Object.entries(d)) this.db.set_setting(k, v ?? "");
      toast("Postavke spremljene.");
    } catch (e) { this.err(e); }
  }
  save3(quiet = false) {
    const d = this.form3.get();
    for (const [k, v] of Object.entries(d)) this.db.set_setting(k, v === null || v === undefined ? "" : String(v));
    if (!quiet) toast("Postavke naljepnica spremljene.");
  }

  async labelSample() {
    try { this.save3(true); } catch (e) { return this.err(e); }
    const seen = new Set(), ids = [];
    for (const k of this.db.kegs()) {
      if (k.batch_id) {
        const rid = this.db.val("SELECT recipe_id FROM batches WHERE id=?", [k.batch_id]);
        if (!seen.has(rid)) { seen.add(rid); ids.push(k.id); }
      }
    }
    if (!ids.length) {
      const all = this.db.kegs();
      if (all.length) ids.push(all[0].id);
    }
    if (!ids.length) return this.err("Nema kegova za probni ispis.");
    const fmts = this.app.py.call("web_extras.consts").FLAG_FORMATS;
    const fmt = this.db.get_setting("label_format") || fmts[0];
    await this.app.doc("web_extras.keg_labels", fmt === fmts[2] ? ids.slice(0, 1) : ids, fmts.includes(fmt) ? fmt : fmts[0], {});
  }

  backup() {
    const bytes = this.app.py.dbBytes();
    saveBlob(new Blob([bytes], { type: "application/octet-stream" }), `skladiste_${today()}.db`);
  }

  async replaceDb() {
    const f = await pickFile(".db,.sqlite,application/octet-stream");
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3") return error("Odabrana datoteka nije baza programa (skladiste.db).");
    if (!(await confirm("Svi podaci u web verziji zamijenit će se podacima iz odabrane datoteke " +
      `(${f.name}). Trenutna verzija ostaje u povijesti na GitHubu (ako je povezan). Nastaviti?`, "Zamjena baze", { danger: true }))) return;
    const old = this.app.py.dbBytes();
    try {
      this.app.py.openDb(bytes);
      this.app.py.call("db.set_setting", "web_imported", new Date().toISOString().slice(0, 16));
    } catch (e) { this.app.py.openDb(old); return error("Baza se ne može otvoriti: " + e.message); }
    await busy("Spremam…", () => this.app.sync.save());
    toast("Baza učitana.");
    this.app.pages = {};
    this.app.show("dash");
  }

  async demo() {
    if (!this.db.is_empty()) return info("Demo podaci se mogu učitati samo u praznu bazu.", "Demo");
    this.db.seed_demo();
    this.app.refreshAll();
  }

  async importHistory() {
    const db = this.db;
    if (db.get_setting("history_imported")) return info("Povijesni podaci su već uvezeni:\n" + db.get_setting("history_imported"), "Uvoz");
    const f = await pickFile(".json,application/json");
    if (!f) return;
    if (!(await confirm("Uvest će se nabava, kuhanja s utroškom po LOT-ovima, recepture te HACCP evidencije " +
      "(fermentacija, pakiranje, CCP, mlin, održavanje, CIP, prijem) iz vaših Excel/Word evidencija.\n\n" +
      "Prije uvoza radi se sigurnosna kopija baze. Nastaviti?", "Uvoz povijesnih podataka"))) return;
    const backup = this.app.py.dbBytes();
    this.app.py.writeFile("/tmp/povijesni_podaci.json", new Uint8Array(await f.arrayBuffer()));
    if (this.app.py.call("importer.has_demo") && await confirm("U bazi su demo podaci (izmišljeni dobavljači, šarže, kegovi...).\n\n" +
      "Obrisati ih prije uvoza? (Postavke, zaposlenici i oprema ostaju.)", "Demo podaci")) this.app.py.call("importer.wipe_data");
    let res;
    try { res = this.app.py.call("importer.import_history", "/tmp/povijesni_podaci.json"); } catch (e) {
      this.app.py.openDb(backup);
      this.app.sync.changed();
      return error("Uvoz nije uspio: " + e.message + "\n\nBaza je vraćena na stanje prije uvoza.");
    }
    const [s, report] = res;
    this.app.refreshAll();
    tableDialog("Uvoz povijesnih podataka – izvještaj", [["type", "Vrsta", 170, "w"], ["text", "Opis", 640, "w"]],
      report.map(([t, x], n) => ({ id: n, type: t, text: x })), {
        info: `Uvezeno: ${s.items} artikala, ${s.lots} primki (LOT-ova), ${s.batches} šarži, ${s.packaging} pakiranja, ` +
          `${s.ccp} CCP zapisa, ${s.mill} kontrola mlina, ${s.maint} zapisa održavanja.\n\n` +
          "Napomene ispod provjerite; zalihe uskladite inventurom (LOT-ovi → Korekcija količine).", width: 960 });
  }

  async reconnect() {
    if (this.app.sync.dirty) await this.app.sync.save();
    if (!(await confirm("Otvorit će se zaslon za povezivanje s GitHubom. Podaci ostaju u repozitoriju (i preuzeti su u ovaj preglednik).",
      "Povezivanje"))) return;
    const cfg = store.getConfig();
    store.setConfig(null);
    if (cfg && cfg.mode === "github") localStorage.setItem("pivovara_sync_prev", JSON.stringify({ owner: cfg.owner, repo: cfg.repo }));
    location.reload();
  }

  async logout() {
    if (!(await confirm("Na ovom uređaju obrisat će se token i lokalna kopija podataka. Podaci na GitHubu ostaju. Nastaviti?",
      "Odjava", { danger: true }))) return;
    if (this.app.sync.dirty) await this.app.sync.save();
    store.setConfig(null);
    await store.localClear();
    location.reload();
  }
}

export const PAGES = { settings: SettingsPage };
