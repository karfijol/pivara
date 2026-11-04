// Service worker: program se može instalirati na mobitel / računalo (ikona) i brže se otvara.
// Velike datoteke (Python, fontovi, knjižnice) čuvaju se u pregledniku; ostalo se uvijek dohvaća svježe s mreže
// (ako nema mreže, koristi se zadnja spremljena verzija). Podaci (baza) NE idu kroz ovu predmemoriju.
const STATIC = "pivovara-static-v2";   // pyodide, fontovi, ikone – mijenja se samo s novom verzijom Pythona
const APP = "pivovara-app";

self.addEventListener("install", (e) => { self.skipWaiting(); });
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
  const isStatic = /\/(pyodide|fonts|icons|js\/vendor)\//.test(url.pathname);
  if (isStatic) {
    e.respondWith((async () => {
      const c = await caches.open(STATIC);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
  } else {
    e.respondWith((async () => {
      const c = await caches.open(APP);
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
