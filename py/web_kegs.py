"""Brzi rad s kegovima (mobitel, QR): istakanje, pranje, punjenje, otprema, povrat, servis kega.

Dodaci bazi (ista baza kao desktop program; desktop ih jednostavno ne koristi):
- tablica keg_service (servisni pregled kega s kontrolnom listom)
- kupci: vrsta (pravna/fizička osoba), poštanski broj, mjesto
"""
import re
import json
import datetime as dt

from db import today

SERVICE_ITEMS = ["Vanjski izgled (udubljenja, oštećenja)", "Spear / ventil", "Brtve (O-prsteni)",
                 "Tlačna proba (bez propuštanja)", "Sigurnosni prsten / plomba", "Oznaka kega čitljiva"]

# radni tok -> (akcija u bazi, dopušteni statusi, novi status, naziv)
WORKFLOWS = {
    "tap": ("Istočeno (pivnica)", ["Pun"], "Prljav", "Istakanje"),
    "wash": ("Očisti", ["Prljav", "Servis"], "Čist", "Pranje"),
    "fill": ("Napuni", ["Čist"], "Pun", "Punjenje"),
    "ship": ("Isporuči", ["Pun"], "Kod kupca", "Otprema"),
    "return": ("Vrati", ["Kod kupca"], "Prljav", "Povrat od kupca"),
}


def ensure(db):
    db.con.execute("""CREATE TABLE IF NOT EXISTS keg_service(
        id INTEGER PRIMARY KEY, keg_id INTEGER NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
        date TEXT, items TEXT, ok INTEGER DEFAULT 1, by TEXT, note TEXT)""")
    cols = {r["name"] for r in db.q("PRAGMA table_info(customers)")}
    for c in ("customer_type", "postal_code", "city"):
        if c not in cols:
            db.con.execute(f"ALTER TABLE customers ADD COLUMN {c} TEXT")
    db.con.commit()


def consts(db):
    return {"workflows": {k: {"action": v[0], "from": v[1], "to": v[2], "name": v[3]} for k, v in WORKFLOWS.items()},
            "service_items": SERVICE_ITEMS}


# ------------------------------------------------------------------ pronalaženje kega (QR ili ručni upis)
def _digits(s):
    m = re.findall(r"\d+", s or "")
    if not m:
        return None
    return m[-1].lstrip("0") or "0"


def find_keg(db, text):
    """Vraća listu kegova koji odgovaraju upisu ili QR kodu.
    QR s naljepnice: 'KEG:K30-001;LOT:...'. Ručno: točna oznaka, ili samo broj (npr. '7' -> K30-007)."""
    t = (text or "").strip()
    if not t:
        return []
    m = re.search(r"KEG:([^;]+)", t, re.I)
    if m:
        t = m.group(1).strip()
    kegs = db.kegs()
    exact = [k for k in kegs if k["code"].lower() == t.lower()]
    if exact:
        return exact
    norm = re.sub(r"[\s\-_./]", "", t.lower())
    exact = [k for k in kegs if re.sub(r"[\s\-_./]", "", k["code"].lower()) == norm]
    if exact:
        return exact
    d = _digits(t)
    if d is None:
        return [k for k in kegs if norm in re.sub(r"[\s\-_./]", "", k["code"].lower())]
    letters = re.sub(r"[^a-z]", "", t.lower())
    out = [k for k in kegs if _digits(k["code"]) == d]
    if letters and len(out) > 1:
        narrowed = [k for k in out if k["code"].lower().startswith(letters[:1])]
        out = narrowed or out
    if len(out) > 1:  # 'K30-7' -> broj 30 ili 7: zadnji broj je redni broj, prefiks bira veličinu
        pref = re.sub(r"\d+$", "", re.sub(r"[\s\-_./]", "", t.lower()))
        narrowed = [k for k in out if re.sub(r"[\s\-_./]", "", k["code"].lower()).startswith(pref)] if pref else []
        out = narrowed or out
    return out


# ------------------------------------------------------------------ pregled
def overview(db):
    kegs = db.kegs()
    counts = db.keg_summary()
    stock = {}
    for k in kegs:
        if k["status"] == "Pun":
            key = (k.get("beer") or "?", k.get("batch_no") or "")
            s = stock.setdefault(key, {"beer": key[0], "lot": key[1], "kegs": 0, "litres": 0.0, "oldest": None})
            s["kegs"] += 1
            s["litres"] += k["size_l"] or 0
            if k.get("filled_date") and (not s["oldest"] or k["filled_date"] < s["oldest"]):
                s["oldest"] = k["filled_date"]
    out = sorted(stock.values(), key=lambda s: (s["beer"], s["lot"]))
    return {"counts": counts, "stock": out, "total": len(kegs),
            "total_litres": sum(s["litres"] for s in out)}


def keg_detail(db, keg_id):
    k = db.one("""SELECT k.*, b.batch_no, r.name AS beer FROM kegs k LEFT JOIN batches b ON b.id=k.batch_id
                  LEFT JOIN recipes r ON r.id=b.recipe_id WHERE k.id=?""", (keg_id,))
    if not k:
        raise ValueError("Keg ne postoji.")
    ensure(db)
    log = db.keg_log(keg_id)
    services = db.q("SELECT * FROM keg_service WHERE keg_id=? ORDER BY date DESC, id DESC", (keg_id,))
    for s in services:
        try:
            s["items"] = json.loads(s["items"] or "{}")
        except ValueError:
            s["items"] = {}
    fills = sum(1 for g in log if g["action"] == "Napuni")
    return {"keg": k, "log": log, "services": services, "fills": fills}


# ------------------------------------------------------------------ radni tokovi
def check(db, flow, keg_id):
    """Smije li se keg dodati na listu za ovaj radni tok? Vraća (True, '') ili (False, razlog)."""
    k = db.one("SELECT * FROM kegs WHERE id=?", (keg_id,))
    _, allowed, _, name = WORKFLOWS[flow]
    if not k:
        return [False, "Keg ne postoji."]
    if k["status"] not in allowed:
        return [False, f"{k['code']} je '{k['status']}' – za {name.lower()} mora biti: {', '.join(allowed)}."]
    return [True, ""]


def apply(db, flow, keg_ids, params=None):
    """Potvrda liste. params: date, operator, note; fill: batch_id, pack (1/0), real_total; ship: customer_id."""
    p = params or {}
    action, allowed, new, name = WORKFLOWS[flow]
    date = p.get("date") or today()
    if not keg_ids:
        raise ValueError("Lista je prazna.")
    bad = [c for c in (check(db, flow, k) for k in keg_ids) if not c[0]]
    if bad:
        raise ValueError("\n".join(b[1] for b in bad))
    if flow == "ship":
        if not p.get("customer_id"):
            raise ValueError("Odaberite kupca.")
        nid = db.create_delivery(p["customer_id"], date, keg_ids, [], p.get("note"), p.get("operator"))
        dn = db.one("SELECT * FROM delivery_notes WHERE id=?", (nid,))
        return {"done": len(keg_ids), "delivery_id": nid, "delivery_no": dn["no"]}
    if flow == "fill":
        if not p.get("batch_id"):
            raise ValueError("Odaberite šaržu (LOT piva).")
    note = p.get("note") or None
    for kid in keg_ids:
        db.keg_action(kid, action, batch_id=p.get("batch_id") if flow == "fill" else None, date=date, note=note)
    res = {"done": len(keg_ids)}
    if flow == "fill":
        if p.get("pack"):
            db.package_from_kegs(p["batch_id"], keg_ids, date, p.get("operator"), p.get("real_total") or None)
            res["packaged"] = True
        b = db.batch(p["batch_id"])
        if b and b["status"] in ("Fermentacija", "Odležavanje"):
            db.update_batch(b["id"], {"status": "Pakirano"})
    return res


def fill_batches(db):
    """Šarže iz kojih se puni (nisu planirane ni završene)."""
    return [{"id": b["id"], "label": f"{b['batch_no']} · {b['recipe'] or ''}", "status": b["status"]}
            for b in db.batches() if b["status"] in ("Fermentacija", "Odležavanje", "Pakirano")]


def customers(db):
    ensure(db)
    rows = db.customers_list()
    return rows


def save_customer(db, data, id=None):
    ensure(db)
    d = dict(data)
    oib = (d.get("oib") or "").strip()
    if oib and not (oib.isdigit() and len(oib) == 11):
        raise ValueError("OIB mora imati točno 11 znamenki.")
    if not (d.get("name") or "").strip():
        raise ValueError("Upišite naziv / ime i prezime kupca.")
    return db.save_customer(d, id)


# ------------------------------------------------------------------ servis kega
def save_service(db, keg_id, items, by=None, note=None, date=None, to_status=None):
    """items: {stavka: 'DA'|'NE'}. Ako je neka stavka NE, keg ide na servis (ako nije drugačije odabrano)."""
    ensure(db)
    ok = all(v == "DA" for v in items.values()) if items else True
    db.x("INSERT INTO keg_service(keg_id,date,items,ok,by,note) VALUES(?,?,?,?,?,?)",
         (keg_id, date or today(), json.dumps(items, ensure_ascii=False), 1 if ok else 0, by, note))
    k = db.one("SELECT * FROM kegs WHERE id=?", (keg_id,))
    target = to_status or (None if ok else "Na servis")
    if target == "Na servis" and k["status"] != "Servis":
        db.keg_action(keg_id, "Na servis", date=date, note="Servisni pregled: " + (note or "neispravno"))
    elif target == "Očisti" and k["status"] == "Servis":
        db.keg_action(keg_id, "Očisti", date=date, note="Servis završen" + (f": {note}" if note else ""))
    return ok


def set_note(db, keg_id, note):
    db.x("UPDATE kegs SET note=? WHERE id=?", (note, keg_id))
    return True


def recent(db, limit=30):
    """Zadnje radnje s kegovima (za pregled rada)."""
    return db.q("""SELECT g.*, k.code, b.batch_no FROM keg_log g JOIN kegs k ON k.id=g.keg_id
                   LEFT JOIN batches b ON b.id=g.batch_id ORDER BY g.ts DESC, g.id DESC LIMIT ?""", (limit,))


_ = dt
