// Service worker: program se otvara odmah iz spremljene kopije (i bez interneta), a nova verzija se preuzme
// u pozadini i ponudi tipkom „Osvježi”. Velike datoteke (Python, fontovi, ikone) čuvaju se trajno.
// Podaci (baza na GitHubu) i popis korisnika NE idu kroz ovu predmemoriju.
// VERSION i FILES upisuje skripta za objavu (build_web.py).
const VERSION = "web 2.38-6abfe311";
const FILES = ["./", "index.html", "manifest.webmanifest", "py/app.zip?v=0f8e44f3", "css/app.css", "js/auth.js", "js/icons.js", "js/main.js", "js/py.js", "js/qr.js", "js/scanner.js", "js/store.js", "js/ui.js", "js/undo.js", "js/pages/costs.js", "js/pages/haccp.js", "js/pages/invoices.js", "js/pages/kegwork.js", "js/pages/offers.js", "js/pages/production.js", "js/pages/reminders.js", "js/pages/reports.js", "js/pages/settings.js", "js/pages/stock.js", "js/vendor/jsQR.js", "js/vendor/qrcode-generator.js"];
const STATIC = "pivovara-static-v2";   // pyodide, fontovi, ikone
const APP = "pivovara-app-" + VERSION;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    // prva instalacija ili prijelaz sa starog načina (bez verzija): odmah; inače čeka da korisnik klikne „Osvježi”
    if (!self.registration.active || await caches.has("pivovara-app")) await self.skipWaiting();
  })());
});
self.addEventListener("message", (e) => { if (e.data && e.data.type === "skip") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== STATIC && k !== APP) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // GitHub API (podaci) – uvijek izravno
  if (url.pathname.endsWith("/users.json")) return;    // popis korisnika – uvijek svježe
  const isStatic = /\/(pyodide|fonts|icons)\//.test(url.pathname);
  e.respondWith((async () => {
    const c = await caches.open(isStatic ? STATIC : APP);
    const key = req.mode === "navigate" ? new Request(new URL("./", self.registration.scope).href) : req;
    const hit = await c.match(key, { ignoreSearch: !isStatic });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && (isStatic || req.mode === "navigate")) c.put(key, res.clone());
    return res;
  })());
});
