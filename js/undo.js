// Poništavanje zadnje promjene (↶ Poništi / Ctrl+Z).
// Prije svake korisnikove radnje koja mijenja bazu sprema se kopija baze (zadnjih 15 radnji, samo u memoriji ovog
// uređaja). Pozivi u istoj radnji (npr. primka + alfa) spajaju se u jednu stavku. Poništavanje vraća bazu kakva je bila
// prije te radnje i sprema je kao novu verziju (GitHub). Kad se učita verzija s drugog uređaja, popis se briše.
import * as py from "./py.js";

const MAX = 15;
const GROUP_MS = 1500;       // pozivi unutar ovog razmaka = jedna radnja
const CLICK_MS = 20000;      // promjena unutar 20 s od klika = korisnikova radnja (inače pozadinska – ne nudi se poništavanje)
const stack = [];
let base = null, group = null, lastClick = null, restoring = false, listeners = [];

const IGNORE_BTN = /^(odustani|zatvori|ne|kasnije|odbaci|poništi|↶)/i;

function capture(e) {
  const b = e.target.closest && e.target.closest("button, .menu-item, a.tile, .tile, .bb-btn");
  if (!b) return;
  const text = (b.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || IGNORE_BTN.test(text)) return;
  const modal = b.closest(".modal");
  const title = modal ? (modal.querySelector(".modal-head span")?.textContent || "").trim()
    : (document.querySelector(".page:not(.hidden) .page-head h1, .page-head h1")?.textContent || "").trim();
  lastClick = { text: text.slice(0, 60), title: title.slice(0, 60), ts: Date.now() };
}

function snap() { try { return py.dbBytes().slice(); } catch { return null; } }
function emit() { for (const f of listeners) { try { f(); } catch { /* */ } } }

export function init() {
  document.addEventListener("click", capture, true);
  py.setOnOpen(() => { if (!restoring) reset(); });
  reset();
}
export function reset() {
  stack.length = 0;
  if (group) { clearTimeout(group.timer); group = null; }
  base = snap();
  emit();
}
export function onUpdate(fn) { listeners.push(fn); }
export function canUndo() { return stack.length > 0; }
export function last() { return stack[stack.length - 1] || null; }

// poziva se nakon svake promjene u bazi (py.setOnChange)
export function changed(name) {
  if (restoring || py.isReplaying()) return;
  const now = Date.now();
  if (group) {
    clearTimeout(group.timer);
    group.timer = setTimeout(closeGroup, GROUP_MS);
    return;
  }
  const user = lastClick && now - lastClick.ts < CLICK_MS;
  const entry = user && base ? {
    bytes: base, ts: now, name,
    label: lastClick.title && lastClick.title.toLowerCase() !== lastClick.text.toLowerCase() ? `${lastClick.title} → ${lastClick.text}` : lastClick.text,
    jfirst: py.journal[py.journal.length - 1] || null,
  } : null;
  if (entry) { stack.push(entry); if (stack.length > MAX) stack.shift(); lastClick = null; }
  group = { entry, timer: setTimeout(closeGroup, GROUP_MS) };
  emit();
}
function closeGroup() {
  group = null;
  base = snap();
}

// vraća bazu na stanje prije zadnje radnje; vraća opis poništene radnje ili null
export function undo() {
  if (group) { clearTimeout(group.timer); closeGroup(); }
  const e = stack.pop();
  if (!e) return null;
  restoring = true;
  try {
    py.openDb(e.bytes);
    // promjene iz te radnje koje još nisu spremljene na GitHub više se ne ponavljaju pri spajanju s drugim uređajem
    const i = e.jfirst ? py.journal.indexOf(e.jfirst) : -1;
    if (i >= 0) py.journal.splice(i);
  } finally { restoring = false; }
  base = snap();
  emit();
  return e;
}

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "upravo";
  const m = Math.round(s / 60);
  if (m < 60) return `prije ${m} min`;
  return `prije ${Math.round(m / 60)} h`;
}
