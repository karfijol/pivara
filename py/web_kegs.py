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
    "tap": ("Istočeno (pivnica)", ["Pun"], "Prljav", "Istočeno u pivnici"),
    "wash": ("Očisti", ["Prljav", "Servis"], "Čist", "Pranje"),
    "fill": ("Napuni", ["Čist"], "Pun", "Punjenje (istakanje)"),
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


def clear_returned_customers(db):
    """Jednokratno: prazni kegovi (nisu puni ni kod kupca) – bez kupca, šarže i piva; to ostaje samo u povijesti kega."""
    w = "status NOT IN ('Pun','Kod kupca')"
    n = db.val(f"SELECT COUNT(*) FROM kegs WHERE {w} AND (COALESCE(customer,'')<>'' OR batch_id IS NOT NULL "
               "OR filled_date IS NOT NULL OR fill_l IS NOT NULL)") or 0
    if n:
        db.x(f"UPDATE kegs SET customer=NULL, batch_id=NULL, filled_date=NULL, fill_l=NULL WHERE {w}")
    return n


def consts(db):
    return {"workflows": {k: {"action": v[0], "from": v[1], "to": v[2], "name": v[3]} for k, v in WORKFLOWS.items()},
            "service_items": SERVICE_ITEMS, "keg_size": db.keg_size_default(), "keg_fill": db.keg_fill_default()}


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
    mq = re.match(r"^keg[\s\-_]*0*(\d+)$", t, re.I)
    if mq:  # oznaka s QR naljepnice (Keg-023, keg23, KEG 23) -> samo kegovi s takvim oznakama
        n = mq.group(1)
        return [k for k in kegs if re.match(r"^keg[\s\-_]*0*" + n + r"$", k["code"], re.I)]
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
            s["litres"] += k.get("fill_l") or k["size_l"] or 0
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
    if flow == "ship":
        err = db.keg_ship_error(k)
        if err:
            return [False, err]
    return [True, ""]


def apply(db, flow, keg_ids, params=None):
    """Potvrda liste. params: date, operator, note; fill: batch_id, pack (1/0), litres {keg_id: L}; ship: customer_id."""
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
    litres = {str(k): v for k, v in (p.get("litres") or {}).items()}
    if flow == "fill":  # provjera svih količina prije punjenja
        for kid in keg_ids:
            k = db.one("SELECT * FROM kegs WHERE id=?", (kid,))
            v = litres.get(str(kid))
            v = db.keg_default_fill(k) if v in (None, "") else float(v)
            if v <= 0 or (k["size_l"] and v > k["size_l"] + 1e-9):
                raise ValueError(f"{k['code']}: količina mora biti veća od 0 i najviše {k['size_l']:g} L.")
    for kid in keg_ids:
        db.keg_action(kid, action, batch_id=p.get("batch_id") if flow == "fill" else None, date=date, note=note,
                      fill_l=litres.get(str(kid)) if flow == "fill" else None)
    res = {"done": len(keg_ids)}
    if flow == "fill":
        if p.get("pack"):
            db.package_from_kegs(p["batch_id"], keg_ids, date, p.get("operator"))
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


def clear_log(db):
    """Briše svu povijest radnji s kegovima (popis „Zadnje radnje” i povijest svakog kega). Kegovi i njihov status ostaju."""
    n = db.val("SELECT COUNT(*) FROM keg_log") or 0
    db.x("DELETE FROM keg_log")
    return n


_ = dt


# ------------------------------------------------------------------ QR oznake kegova (Keg-001 … Keg-150)
QR_RE = re.compile(r"^keg-\d{1,4}$", re.I)


def qr_code_name(n, prefix="Keg-", digits=3):
    return f"{prefix}{int(n):0{int(digits)}d}"


def qr_status(db, start=1, end=150, prefix="Keg-", digits=3):
    """Koje su oznake iz raspona već u programu, a koje nisu."""
    codes = [qr_code_name(n, prefix, digits) for n in range(int(start), int(end) + 1)]
    have = {k["code"].lower(): k for k in db.kegs()}
    used = [c for c in codes if c.lower() in have]
    free = [c for c in codes if c.lower() not in have]
    other = [k for k in db.kegs() if not QR_RE.match(k["code"])]
    return {"used": used, "free": free, "other": [{"id": k["id"], "code": k["code"], "size_l": k["size_l"],
                                                    "status": k["status"]} for k in other]}


def qr_add_kegs(db, codes, size_l=None, keg_type=None, status="Čist"):
    """Dodaje kegove s oznakama s QR naljepnica (postojeće oznake preskače)."""
    have = {k["code"].lower() for k in db.kegs()}
    added = []
    for c in codes:
        if c.lower() in have:
            continue
        db.save_keg({"code": c, "size_l": size_l or db.keg_size_default(), "keg_type": keg_type, "status": status})
        added.append(c)
    return added


def assign_code(db, keg_id, code):
    """Postojećem kegu dodijeli oznaku s QR naljepnice (povijest kega ostaje)."""
    code = (code or "").strip()
    m = re.search(r"KEG:([^;]+)", code, re.I)
    if m:
        code = m.group(1).strip()
    if not code:
        raise ValueError("Oznaka je prazna.")
    other = db.one("SELECT id FROM kegs WHERE lower(code)=lower(?) AND id<>?", (code, keg_id))
    if other:
        raise ValueError(f"Oznaku {code} već ima drugi keg.")
    old = db.val("SELECT code FROM kegs WHERE id=?", (keg_id,))
    db.x("UPDATE kegs SET code=? WHERE id=?", (code, keg_id))
    db.x("INSERT INTO keg_log(keg_id,ts,action,status,note) VALUES(?,?,?,(SELECT status FROM kegs WHERE id=?),?)",
         (keg_id, dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "Nova oznaka", keg_id, f"{old} → {code} (QR naljepnica)"))
    return code


def qr_sheet(db, codes, app=None, size_mm=30, with_beer=False):
    """A4 list QR naljepnica: 5 × 7 po stranici (40 × 40 mm), QR sadrži samo oznaku (npr. 'Keg-023')."""
    import os
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl
    from reportlab.graphics.barcode import qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    from docgen import _register_fonts
    body, bold, _ = _register_fonts()
    os.makedirs("/out/naljepnice", exist_ok=True)
    name = f"QR_kegovi_{codes[0]}_{codes[-1]}.pdf" if codes else "QR_kegovi.pdf"
    path = os.path.join("/out/naljepnice", name)
    c = rl.Canvas(path, pagesize=A4)
    c.setTitle("QR oznake kegova")
    W, H = A4
    cell = 40 * mm
    cols, rows = 5, 7
    x0 = (W - cols * cell) / 2
    y0 = H - (H - rows * cell) / 2
    s = size_mm * mm
    brand = db.get_setting("label_brand") or ""
    for i, code in enumerate(codes):
        if i and i % (cols * rows) == 0:
            c.showPage()
        j = i % (cols * rows)
        x = x0 + (j % cols) * cell
        y = y0 - (j // cols + 1) * cell
        c.setStrokeColorRGB(0.8, 0.8, 0.8)
        c.setLineWidth(0.3)
        c.setDash(1, 2)
        c.rect(x, y, cell, cell)
        c.setDash()
        q = qr.QrCodeWidget(code)
        q.barLevel = "M"
        bx = q.getBounds()
        dwg = Drawing(s, s, transform=[s / (bx[2] - bx[0]), 0, 0, s / (bx[3] - bx[1]), 0, 0])
        dwg.add(q)
        renderPDF.draw(dwg, c, x + (cell - s) / 2, y + 7 * mm)
        c.setFillColorRGB(0, 0, 0)
        c.setFont(bold, 11)
        c.drawCentredString(x + cell / 2, y + 3.2 * mm, code)
        if brand:
            c.setFont(body, 5.5)
            c.setFillColorRGB(0.4, 0.4, 0.4)
            c.drawCentredString(x + cell / 2, y + cell - 3 * mm, brand)
    c.save()
    return path
