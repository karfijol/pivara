// Python (Pyodide) u pregledniku: učitava postojeću logiku programa i bazu SQLite.
import { loadPyodide } from "../pyodide/pyodide_esm.js";

const PY_FILES = ["db.py", "haccp_db.py", "extras_db.py", "docgen.py", "haccp_docs.py", "mipi.py", "importer.py",
  "webutil.py", "labels.py", "webapi.py", "web_main.py", "web_extras.py", "web_haccp.py", "web_kegs.py", "web_costs.py", "web_offers.py", "web_more.py", "web_invoices.py", "web_reminders.py", "web_stockcheck.py", "web_brew.py", "web_units.py"];
const WHEELS = ["charset_normalizer-3.4.2-py3-none-any.whl", "reportlab-4.4.4-py3-none-any.whl",
"et_xmlfile-2.0.0-py3-none-any.whl", "openpyxl-3.1.5-py2.py3-none-any.whl", "pdf417gen-0.8.1-py3-none-any.whl", "pypdf-5.4.0-py3-none-any.whl"];
const BUNDLE = "py/app.zip?v=ebb18900";
export const DB_PATH = "/data/skladiste.db";
export const DATA_DIR = "/home/pyodide/Documents/PivovaraSkladiste";

let pyo = null;
let api = null;
let onChange = () => {};
let docsReady = null;

export function setOnChange(fn) { onChange = fn; }
let onOpen = () => {};
export function setOnOpen(fn) { onOpen = fn; }
export const isReplaying = () => replaying;

// Dnevnik promjena od zadnjeg spremanja na GitHub – kod sukoba s drugim uređajem promjene se
// ponove nad novijom verzijom baze (spajanje), pa se ništa ne gubi.
export const journal = [];
let replaying = false;
export function replayJournal(entries) {
  const failed = [];
  replaying = true;
  try {
    for (const e of entries) {
      try { callKw(e.name, e.args, e.kwargs); } catch (err) { failed.push([e, err.message]); }
    }
  } finally { replaying = false; }
  return failed;
}

export async function init(progress = () => {}) {
  const base = new URL("../", import.meta.url).href;
  progress("Pokrećem Python u pregledniku…");
  pyo = await loadPyodide({ indexURL: base + "pyodide/" });
  progress("Učitavam bazu podataka (SQLite)…");
  await pyo.loadPackage(["sqlite3"], { messageCallback: () => {} });
  pyo.FS.mkdirTree("/app");
  pyo.FS.mkdirTree("/data");
  pyo.FS.mkdirTree(DATA_DIR);
  pyo.FS.mkdirTree("/out");
  progress("Učitavam program…");
  // svi Python moduli u jednoj datoteci (py/app.zip, izrađuje je skripta za objavu); ako je nema, datoteku po datoteku
  let bundled = false;
  try {
    const r = await fetch(base + BUNDLE);
    if (r.ok) { pyo.unpackArchive(await r.arrayBuffer(), "zip", { extractDir: "/app" }); bundled = true; }
  } catch (e) { console.warn("app.zip", e); }
  if (!bundled) {
    await Promise.all(PY_FILES.map(async (f) => {
      const r = await fetch(base + "py/" + f, { cache: "no-cache" });
      if (r.ok) pyo.FS.writeFile("/app/" + f, await r.text());
    }));
  }
  pyo.runPython("import sys; sys.path.insert(0, '/app')");
  api = pyo.pyimport("webapi");
  return pyo;
}

// Paketi za PDF i Excel (reportlab, openpyxl) učitavaju se tek kad zatrebaju.
export function ensureDocs(progress = () => {}) {
  if (docsReady) return docsReady;
  docsReady = (async () => {
    const base = new URL("../", import.meta.url).href;
    progress("Učitavam alate za PDF i Excel (samo prvi put)…");
    await pyo.loadPackage(["micropip", "pillow", "typing-extensions"], { messageCallback: () => {} });
    const mp = pyo.pyimport("micropip");
    for (const w of WHEELS) await mp.install.callKwargs(base + "pyodide/" + w, { deps: false });
    const fdir = "/usr/share/fonts/truetype/dejavu/";
    pyo.FS.mkdirTree(fdir);
    for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
      const r = await fetch(base + "fonts/" + f);
      pyo.FS.writeFile(fdir + f, new Uint8Array(await r.arrayBuffer()));
    }
    try { // logo PIVARA za zaglavlje ponuda
      const r = await fetch(base + "icons/pivara-logo.png");
      if (r.ok) pyo.FS.writeFile("/app/pivara_logo.png", new Uint8Array(await r.arrayBuffer()));
    } catch { /* bez loga */ }
  })();
  docsReady.catch(() => { docsReady = null; });
  return docsReady;
}

export function openDb(bytes) {
  if (bytes) pyo.FS.writeFile(DB_PATH, bytes);
  api.open_db(DB_PATH);
  try { onOpen(); } catch (e) { console.warn(e); }
}

export function dbBytes() {
  api.flush();
  return pyo.FS.readFile(DB_PATH);
}

export function writeFile(path, bytes) {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) pyo.FS.mkdirTree(dir);
  pyo.FS.writeFile(path, bytes);
}

export function readFile(path) { return pyo.FS.readFile(path); }
export function exists(path) { try { pyo.FS.stat(path); return true; } catch { return false; } }
export function unlink(path) { try { pyo.FS.unlink(path); } catch { /* nema */ } }

export class PyError extends Error {
  constructor(msg, type, trace) { super(msg); this.pyType = type; this.trace = trace; }
}

// Poziv Python funkcije: call("db.items") ili call("web_main.nesto", arg1, arg2)
export function call(name, ...args) {
  return callKw(name, args, {});
}

export function callKw(name, args = [], kwargs = {}) {
  const out = JSON.parse(api.call(name, JSON.stringify(args), JSON.stringify(kwargs)));
  if (out.changed) { journal.push({ name, args, kwargs }); onChange(name); }
  if (!out.ok) {
    console.warn(out.trace);
    throw new PyError(out.error, out.type, out.trace);
  }
  return out.result;
}

// Za ispise: učita PDF/Excel alate pa pozove funkciju koja vraća putanju datoteke
export async function callDoc(name, ...args) {
  await ensureDocs();
  return call(name, ...args);
}
