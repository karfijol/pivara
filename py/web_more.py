"""Dodaci (web 2.9): povijest promjena, arhiva, QR oprema, kalendar (.ics), kegovi za povrat, godišnji pregled,
dan kuhanja, ponuda -> otpremnica, cijene po kupcu."""
import os
import io
import re
import json
import zipfile
import datetime as dt

OUT = "/out"


def _today():
    return dt.date.today().isoformat()


def _d(iso):
    if not iso:
        return ""
    s = str(iso)[:10].split("-")
    return f"{s[2]}.{s[1]}.{s[0]}." if len(s) == 3 else str(iso)


def _hr(x, dec=2):
    s = f"{float(x or 0):,.{dec}f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return s


def ensure(db):
    c = db.con
    c.execute("""CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY, ts TEXT, user TEXT, action TEXT, target TEXT, detail TEXT)""")
    c.execute("CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target)")
    c.execute("""CREATE TABLE IF NOT EXISTS customer_prices(
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, price REAL NOT NULL,
        UNIQUE(customer_id, product_id))""")
    cols = {r["name"] for r in db.q("PRAGMA table_info(products)")}
    for col, typ in (("recipe_id", "INTEGER"), ("keg_l", "REAL")):
        if col not in cols:
            c.execute(f"ALTER TABLE products ADD COLUMN {col} {typ}")
    cols = {r["name"] for r in db.q("PRAGMA table_info(offers)")}
    for col, typ in (("valid_until", "TEXT"), ("price_mode", "TEXT"), ("delivery_id", "INTEGER")):
        if col not in cols:
            c.execute(f"ALTER TABLE offers ADD COLUMN {col} {typ}")
    for k, v in (("keg_return_days", "30"), ("token_expires", "")):
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    # veleprodaja: keg 18 L za svaku recepturu (cijena se upisuje u cjeniku; dok je 0, ne nudi se)
    if not db.val("SELECT value FROM settings WHERE key='wholesale_seeded'"):
        try:
            size = db.keg_size_default()
            for r in db.q("SELECT id, name FROM recipes WHERE COALESCE(active,1)=1 ORDER BY name"):
                c.execute("""INSERT INTO products(grp,name,descr,unit,price,vat,active,sort,recipe_id,keg_l)
                             VALUES('Veleprodaja – kegovi',?,?, 'keg', 0, 25, 0, ?, ?, ?)""",
                          (f"Keg {size:g} L – {r['name']}", f"Povratni keg, neto {db.keg_fill_default():g} L piva",
                           900 + r["id"], r["id"], size))
            c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('wholesale_seeded','1')")
        except Exception:  # noqa: BLE001 – tablica products još ne postoji (web_offers.ensure je poziva)
            pass
    c.commit()


# ------------------------------------------------------------------ povijest promjena
ACTIONS = {
    "db.update_batch": "Šarža izmijenjena", "db.create_batch": "Nova šarža", "db.brew_batch": "Šarža skuhana",
    "db.undo_brew": "Storno kuhanja", "db.delete_batch": "Šarža obrisana", "db.keg_action": "Keg",
    "db.save_keg": "Keg spremljen", "db.kegs_bulk_update": "Kegovi izmijenjeni", "db.delete_kegs": "Kegovi obrisani",
    "db.save_item": "Sirovina spremljena", "db.receive_lot": "Primka (LOT)", "db.save_lot": "LOT izmijenjen",
    "db.save_record": "HACCP zapis", "db.delete_record": "HACCP zapis obrisan", "db.create_delivery": "Otpremnica",
    "db.delete_delivery": "Otpremnica obrisana", "db.save_customer": "Kupac spremljen", "db.save_recipe": "Receptura",
    "db.set_setting": "Postavka", "web_kegs.apply": "Rad s kegovima", "web_offers.save_offer": "Ponuda spremljena",
    "web_offers.delete_offer": "Ponuda obrisana", "web_offers.save_product": "Cjenik", "web_costs.apply_prices": "Uvoz cijena",
    "web_more.offer_to_delivery": "Ponuda → otpremnica", "web_more.set_offer_status": "Status ponude",
    "web_more.brew_day_finish": "Dan kuhanja", "web_more.set_customer_price": "Cijena za kupca",
}
SKIP = {"db.set_setting:offer_last_operator", "db.set_setting:offer_operators"}


def _target(db, name, args):
    """Čitljiv opis zapisa na koji se promjena odnosi (npr. 'Šarža 23092026IP3', 'Keg Keg-023')."""
    try:
        a0 = args[0] if args else None
        if name in ("db.update_batch", "db.brew_batch", "db.undo_brew", "db.delete_batch") and a0:
            no = db.val("SELECT batch_no FROM batches WHERE id=?", (a0,))
            return f"Šarža {no or a0}"
        if name == "db.create_batch":
            return "Šarža " + (db.val("SELECT batch_no FROM batches ORDER BY id DESC LIMIT 1") or "")
        if name == "db.keg_action" and a0:
            return f"Keg {db.val('SELECT code FROM kegs WHERE id=?', (a0,)) or a0}"
        if name == "web_kegs.apply" and len(args) > 1:
            codes = [db.val("SELECT code FROM kegs WHERE id=?", (k,)) for k in (args[1] or [])[:12]]
            return "Kegovi " + ", ".join(c for c in codes if c) + (" …" if len(args[1] or []) > 12 else "")
        if name == "web_offers.save_offer" and a0:
            return f"Ponuda {a0.get('no')}" if isinstance(a0, dict) else "Ponuda"
        if name in ("web_more.offer_to_delivery", "web_more.set_offer_status", "web_offers.delete_offer") and a0:
            return f"Ponuda {db.val('SELECT no FROM offers WHERE id=?', (a0,)) or a0}"
        if name == "db.save_record" and a0:
            return f"HACCP {a0}"
        if name == "db.set_setting" and a0:
            return f"Postavka {a0}"
        if name in ("db.save_customer",) and isinstance(a0, dict):
            return f"Kupac {a0.get('name') or ''}"
        if name == "web_more.brew_day_finish" and a0:
            return f"Šarža {db.val('SELECT batch_no FROM batches WHERE id=?', (a0,)) or a0}"
    except Exception:  # noqa: BLE001
        pass
    return ""


def _detail(name, args, kwargs):
    def short(v):
        if isinstance(v, dict):
            return ", ".join(f"{k}={short(x)}" for k, x in list(v.items())[:10] if x not in (None, "", []))
        if isinstance(v, list):
            return f"[{len(v)}]" if len(v) > 4 else ", ".join(short(x) for x in v)
        return str(v)[:60]
    parts = [short(a) for a in args] + [f"{k}={short(v)}" for k, v in (kwargs or {}).items() if k != "app"]
    if name == "db.keg_action" and len(args) > 1:
        parts = [str(args[1])] + [p for p in parts[2:] if p not in ("None", "False")]
    return "; ".join(p for p in parts if p and p != "None")[:400]


def log_change(db, user, name, args, kwargs):
    if name.startswith("web_more.audit") or name in ("db.dismiss",):
        return
    if name == "db.set_setting" and args and f"db.set_setting:{args[0]}" in SKIP:
        return
    try:
        db.con.execute("INSERT INTO audit_log(ts,user,action,target,detail) VALUES(?,?,?,?,?)",
                       (dt.datetime.now().strftime("%Y-%m-%d %H:%M"), user or "", ACTIONS.get(name, name),
                        _target(db, name, args), _detail(name, args, kwargs)))
    except Exception:  # noqa: BLE001
        pass


def audit(db, text="", limit=300):
    ensure(db)
    sql = "SELECT * FROM audit_log"
    args = []
    if text:
        sql += " WHERE target LIKE ? OR action LIKE ? OR user LIKE ? OR detail LIKE ?"
        args = [f"%{text}%"] * 4
    return db.q(sql + " ORDER BY id DESC LIMIT ?", args + [int(limit)])


# ------------------------------------------------------------------ token
def token_status(db):
    """Dana do isteka tokena (Postavke → Korisnici: 'Token vrijedi do', ili zaglavlje GitHuba)."""
    exp = (db.get_setting("token_expires") or "").strip()[:10]
    if not exp:
        return None
    try:
        days = (dt.date.fromisoformat(exp) - dt.date.today()).days
    except ValueError:
        return None
    return {"date": exp, "days": days}


def set_token_expires(db, date_iso):
    cur = (db.get_setting("token_expires") or "")[:10]
    if date_iso and date_iso[:10] != cur:
        db.set_setting("token_expires", date_iso[:10])
    return True


# ------------------------------------------------------------------ mjesečna arhiva
def archive(db, month, app=None):
    """ZIP za mjesec 'GGGG-MM': baza, svi HACCP dokumenti (cijela povijest), ponude mjeseca, izvještaj za knjigovođu."""
    import shutil
    import haccp_docs
    import web_costs
    import web_offers
    y, m = (int(x) for x in month.split("-"))
    last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).isoformat()
    first = f"{month}-01"
    base = os.path.join(OUT, "arhiva_tmp")
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base, exist_ok=True)
    files, errors = [], []
    logo = app.logo_path() if app else None
    db.con.commit()
    dbcopy = os.path.join(base, f"skladiste_{month}.db")
    src = db.con
    import sqlite3
    dst = sqlite3.connect(dbcopy)
    src.backup(dst)
    dst.close()
    files.append(dbcopy)
    _, hf, he = haccp_docs.make_all(db, base, ("PDF",), logo, mode="all")
    files += hf
    errors += he
    rep_dir = os.path.join(base, "Izvještaj za knjigovođu")
    os.makedirs(rep_dir, exist_ok=True)
    for fn in (lambda: web_costs.report_doc(db, first, last, "PDF", app), lambda: web_costs.report_xlsx(db, first, last, app)):
        try:
            p = fn()
            q = os.path.join(rep_dir, os.path.basename(p))
            shutil.copy(p, q)
            files.append(q)
        except Exception as e:  # noqa: BLE001
            errors.append(f"Izvještaj: {e}")
    off_dir = os.path.join(base, "Ponude")
    os.makedirs(off_dir, exist_ok=True)
    for o in db.q("SELECT id FROM offers WHERE issue_date BETWEEN ? AND ?", (first, last)):
        try:
            p = web_offers.offer_pdf(db, o["id"], "PDF", app)
            q = os.path.join(off_dir, os.path.basename(p))
            shutil.copy(p, q)
            files.append(q)
        except Exception as e:  # noqa: BLE001
            errors.append(f"Ponuda: {e}")
    zpath = os.path.join(OUT, f"Arhiva_PIVARA_{month}.zip")
    if os.path.exists(zpath):
        os.remove(zpath)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, os.path.join(f"Arhiva {month}", os.path.relpath(f, base)))
        if errors:
            z.writestr(f"Arhiva {month}/NAPOMENE.txt", "Nije izrađeno:\n" + "\n".join(errors))
    return zpath


# ------------------------------------------------------------------ QR oprema
def eq_code(e):
    return f"OPREMA-{e['code'] or e['id']}"


def equipment_list(db):
    rows = db.q("SELECT * FROM equipment WHERE COALESCE(active,1)=1 ORDER BY category, name")
    for e in rows:
        e["qr"] = eq_code(e)
    return rows


def find_equipment(db, text):
    t = (text or "").strip()
    m = re.match(r"^OPREMA-(.+)$", t, re.I)
    if not m:
        return None
    key = m.group(1).strip()
    for e in equipment_list(db):
        if str(e["code"] or "").lower() == key.lower() or str(e["id"]) == key:
            last = db.one("SELECT kind, date FROM eq_checks WHERE equipment_id=? ORDER BY date DESC, id DESC LIMIT 1", (e["id"],))
            lcip = db.one("SELECT date FROM cips WHERE fermentor_id=? ORDER BY date DESC, id DESC LIMIT 1", (e["id"],))
            e["last_check"] = last
            e["last_cip"] = lcip["date"] if lcip else None
            return e
    return None


def eq_qr_sheet(db, ids=None, app=None):
    """A4 list QR naljepnica za opremu (sadržaj 'OPREMA-<oznaka>', ispod naziv opreme)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl
    from reportlab.graphics.barcode import qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    from docgen import _register_fonts
    body, bold, _ = _register_fonts()
    eqs = [e for e in equipment_list(db) if not ids or e["id"] in ids]
    os.makedirs("/out/naljepnice", exist_ok=True)
    path = "/out/naljepnice/QR_oprema.pdf"
    c = rl.Canvas(path, pagesize=A4)
    c.setTitle("QR oznake opreme")
    W, H = A4
    cell = 60 * mm
    cols, rows = 3, 4
    x0 = (W - cols * cell) / 2
    y0 = H - (H - rows * cell) / 2
    s = 40 * mm
    for i, e in enumerate(eqs):
        if i and i % (cols * rows) == 0:
            c.showPage()
        j = i % (cols * rows)
        x = x0 + (j % cols) * cell
        y = y0 - (j // cols + 1) * cell
        c.setStrokeColorRGB(0.8, 0.8, 0.8)
        c.setDash(1, 2)
        c.rect(x, y, cell, cell)
        c.setDash()
        q = qr.QrCodeWidget(eq_code(e))
        q.barLevel = "M"
        bx = q.getBounds()
        dwg = Drawing(s, s, transform=[s / (bx[2] - bx[0]), 0, 0, s / (bx[3] - bx[1]), 0, 0])
        dwg.add(q)
        renderPDF.draw(dwg, c, x + (cell - s) / 2, y + 13 * mm)
        c.setFillColorRGB(0, 0, 0)
        c.setFont(bold, 11)
        c.drawCentredString(x + cell / 2, y + 8 * mm, e["name"][:30])
        c.setFont(body, 8)
        c.setFillColorRGB(0.35, 0.35, 0.35)
        c.drawCentredString(x + cell / 2, y + 4 * mm, f"{eq_code(e)} · skeniraj za CIP / kontrolu")
    c.save()
    return path


# ------------------------------------------------------------------ kalendar (.ics)
def _ics_text(t):
    return str(t or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def calendar_ics(db, days_ahead=120):
    """Planirana kuhanja, procijenjeni kraj fermentacije, CIP nakon fermentacije i rokovi održavanja opreme."""
    today = dt.date.today()
    to = (today + dt.timedelta(days=days_ahead)).isoformat()
    ev = []

    def add(uid, date, title, desc=""):
        if date and today.isoformat() <= date <= to:
            ev.append((uid, date, title, desc))
    for b in db.q("""SELECT b.*, r.name AS recipe FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                     WHERE b.status='Planirano'"""):
        add(f"brew-{b['id']}", b["brew_date"], f"Kuhanje: {b['recipe'] or ''} ({b['batch_no']})",
            f"Planirano kuhanje {b['batch_no']}, {b['volume_l'] or ''} L, tank {b['tank'] or '-'}")
    bars, _ = db.planner(today.isoformat(), to)
    for x in bars:
        if x["estimated"] and not x["planned"]:
            add(f"ferm-{x['batch_id']}", x["end"], f"Kraj fermentacije: {x['batch_no']} ({x['tank']})",
                "Procjena prema broju dana fermentacije u recepturi. Nakon pražnjenja: CIP fermentora.")
            add(f"cip-{x['batch_id']}", x["end"], f"CIP {x['tank']} nakon fermentacije {x['batch_no']}")
    for e in db.q("SELECT * FROM equipment WHERE COALESCE(active,1)=1 AND COALESCE(interval_days,0)>0"):
        last = db.val("SELECT MAX(date) FROM eq_checks WHERE equipment_id=? AND kind='odrzavanje'", (e["id"],))
        due = (dt.date.fromisoformat(last) + dt.timedelta(days=int(e["interval_days"]))) if last else today
        add(f"maint-{e['id']}-{due.isoformat()}", max(due, today).isoformat(), f"Održavanje: {e['name']}",
            f"Interval {e['interval_days']} dana" + (f", zadnje {_d(last)}" if last else ""))
    stamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PIVARA//Skladiste//HR", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:PIVARA – proizvodnja"]
    for uid, date, title, desc in sorted(ev, key=lambda x: x[1]):
        d0 = date.replace("-", "")
        d1 = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat().replace("-", "")
        lines += ["BEGIN:VEVENT", f"UID:{uid}@pivara", f"DTSTAMP:{stamp}", f"DTSTART;VALUE=DATE:{d0}",
                  f"DTEND;VALUE=DATE:{d1}", f"SUMMARY:{_ics_text(title)}", f"DESCRIPTION:{_ics_text(desc)}",
                  "BEGIN:VALARM", "TRIGGER:-PT15H", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(title)}", "END:VALARM",
                  "END:VEVENT"]
    lines.append("END:VCALENDAR")
    os.makedirs(os.path.join(OUT, "kalendar"), exist_ok=True)
    path = os.path.join(OUT, "kalendar", "PIVARA_kalendar.ics")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(lines) + "\r\n")
    return {"path": path, "n": len(ev)}


# ------------------------------------------------------------------ kegovi za povrat
def keg_returns(db, days=None):
    days = int(days if days not in (None, "") else (db.get_setting("keg_return_days") or 30))
    dep = float(db.get_setting("keg_deposit") or 0)
    today = dt.date.today()
    rows = db.q("""SELECT k.*, b.batch_no, r.name AS beer FROM kegs k LEFT JOIN batches b ON b.id=k.batch_id
                   LEFT JOIN recipes r ON r.id=b.recipe_id WHERE k.status='Kod kupca' ORDER BY k.customer, k.status_date""")
    by = {}
    for k in rows:
        try:
            age = (today - dt.date.fromisoformat(k["status_date"][:10])).days if k.get("status_date") else 0
        except ValueError:
            age = 0
        k["days"] = age
        c = by.setdefault(k["customer"] or "(nepoznat kupac)", {"customer": k["customer"] or "(nepoznat kupac)",
                                                                "kegs": [], "old": 0})
        c["kegs"].append(k)
        if age >= days:
            c["old"] += 1
    out = []
    for c in by.values():
        cust = db.one("SELECT * FROM customers WHERE name=?", (c["customer"],)) or {}
        out.append({"customer": c["customer"], "phone": cust.get("phone") or "", "address": cust.get("address") or "",
                    "n": len(c["kegs"]), "old": c["old"], "oldest": max(k["days"] for k in c["kegs"]),
                    "deposit": dep * len(c["kegs"]),
                    "kegs": [{"code": k["code"], "beer": k.get("beer") or "", "lot": k.get("batch_no") or "",
                              "since": k.get("status_date"), "days": k["days"], "old": k["days"] >= days}
                             for k in c["kegs"]]})
    out.sort(key=lambda c: (-c["old"], -c["oldest"]))
    return {"days": days, "deposit": dep, "customers": out,
            "total": sum(c["n"] for c in out), "old": sum(c["old"] for c in out)}


def keg_returns_pdf(db, days=None, only_old=True, app=None):
    from docgen import Doc, render
    data = keg_returns(db, days)
    m = {"code": "KEG-POVRAT", "title": "POPIS KEGOVA ZA POVRAT", "version": "1", "vdate": _d(_today())}
    doc = Doc(m, db.get_setting("company") or db.get_setting("brewery_name"), app.logo_path() if app else None,
              False, f"Kegovi za povrat {_today()}")
    doc.add("title", f"KEGOVI ZA POVRAT – stanje {_d(_today())}")
    doc.add("note", f"Kegovi kod kupca dulje od {data['days']} dana" + ("" if only_old else " (i ostali kegovi kod kupaca)")
            + (f" · depozit {_hr(data['deposit'])} € po kegu" if data["deposit"] else ""))
    for c in data["customers"]:
        ks = [k for k in c["kegs"] if k["old"] or not only_old]
        if not ks:
            continue
        doc.add("h", f"{c['customer']} – {len(ks)} keg(ova)" + (f" · {c['phone']}" if c["phone"] else ""))
        if c["address"]:
            doc.add("note", c["address"])
        doc.add("table", ["Keg", "Pivo", "LOT", "Kod kupca od", "Dana", "Vraćeno ✓"],
                [[k["code"], k["beer"], k["lot"], _d(k["since"]), str(k["days"]), ""] for k in ks],
                [0.16, 0.24, 0.18, 0.16, 0.1, 0.16], {"size": 9.5})
    doc.add("sign", [("Preuzeo (vozač)", ""), ("Datum", "")])
    return render(doc, os.path.join(OUT, "kegovi"), "PDF")


# ------------------------------------------------------------------ godišnji pregled
def year_overview(db, year=None):
    import web_costs
    year = int(year or dt.date.today().year)
    months = [f"{year}-{m:02d}" for m in range(1, 13)]
    d_from, d_to = f"{year}-01-01", f"{year}-12-31"
    rep = web_costs.report_data(db, d_from, d_to)
    litres = {m: 0.0 for m in months}
    cost = {m: 0.0 for m in months}
    per_beer = {}
    for b in rep["brews"]:
        m = b["date"][:7]
        if m in litres:
            litres[m] += b["litres"] or 0
            cost[m] += b["cost"] or 0
        pb = per_beer.setdefault(b["beer"] or "?", {"beer": b["beer"] or "?", "litres": 0.0, "cost": 0.0, "brews": 0})
        pb["litres"] += b["litres"] or 0
        pb["cost"] += b["cost"] or 0
        pb["brews"] += 1
    per_l = [(m, round(cost[m] / litres[m], 4) if litres[m] else 0) for m in months]
    sales = db.q("""SELECT d.customer AS customer, COUNT(DISTINCT d.id) AS notes,
                    SUM(CASE WHEN l.pack_type='Keg' THEN l.qty ELSE 0 END) AS kegs, SUM(l.qty*COALESCE(l.unit_l,0)) AS litres
                    FROM delivery_notes d JOIN delivery_lines l ON l.note_id=d.id
                    WHERE d.date BETWEEN ? AND ? GROUP BY d.customer ORDER BY litres DESC""", (d_from, d_to))
    years = [r["y"] for r in db.q("""SELECT DISTINCT substr(brew_date,1,4) AS y FROM batches WHERE brew_date IS NOT NULL
                                     UNION SELECT DISTINCT substr(date,1,4) FROM delivery_notes ORDER BY 1 DESC""") if r["y"]]
    return {"year": year, "years": years or [str(year)], "litres": [(m, litres[m]) for m in months], "per_l": per_l,
            "beers": sorted(per_beer.values(), key=lambda x: -x["litres"]), "sales": sales,
            "total_l": sum(litres.values()), "total_cost": sum(cost.values()), "brews": len(rep["brews"])}


# ------------------------------------------------------------------ dan kuhanja
def brew_day(db, batch_id):
    b = db.batch(batch_id)
    if not b:
        raise ValueError("Šarža ne postoji.")
    r = db.recipe(b["recipe_id"]) if b.get("recipe_id") else {}
    needs = db.preview_brew(b["recipe_id"], b["volume_l"]) if b["status"] == "Planirano" else [
        {"name": c["name"], "need": c["qty"], "unit": c["unit"], "missing": 0,
         "alloc": [[c["lot_id"], c["lot_no"], c["qty"]]]} for c in db.batch_consumption(batch_id)]
    items = []
    for n in needs:
        cat = db.val("SELECT category FROM items WHERE name=?", (n["name"],)) or ""
        items.append({"name": n["name"], "need": n["need"], "unit": n["unit"], "cat": cat, "missing": n.get("missing", 0),
                      "lots": ", ".join(f"{a[1]}" for a in n.get("alloc", []))})
    order = {"Slad": 0, "Hmelj": 1, "Kvasac": 2}
    items.sort(key=lambda x: (order.get(x["cat"], 3), x["name"]))
    return {"batch": b, "recipe_note": (r or {}).get("note") or "", "items": items, "mill": bool(db.mill()),
            "planned": b["status"] == "Planirano"}


def brew_day_finish(db, batch_id, data):
    """Zapis s kraja dana kuhanja: kuhanje (skidanje sirovina), OG/pH/volumen, CCP kuhanja, kontrola mlina."""
    b = db.batch(batch_id)
    date = data.get("date") or _today()
    op = data.get("operator") or db.get_setting("default_operator")
    if b["status"] == "Planirano":
        db.brew_batch(batch_id, date)
    upd = {k: data[k] for k in ("og_sg", "ph") if data.get(k)}
    if data.get("wort_l"):
        upd["wort_l"] = data["wort_l"]
    upd["brewer"] = op
    db.update_batch(batch_id, upd)
    b = db.batch(batch_id)
    if data.get("boil_temp"):
        t = float(data["boil_temp"])
        ok = t >= 100
        db.save_record("ccp_boil", {"batch_id": batch_id, "lot": b["batch_no"], "date": date,
                                    "start_time": data.get("boil_start") or None, "end_time": data.get("boil_end") or None,
                                    "temp": t, "minutes": data.get("boil_min") or None, "limit_ok": 1 if ok else 0,
                                    "result": "OK" if ok else "NE", "corrective": data.get("corrective") or ("/" if ok else ""),
                                    "operator": op})
    if data.get("mill_ok"):
        db.add_mill_check(date, "Uređaj je u redu", op, batch_id)
    return {"batch_no": b["batch_no"]}


# ------------------------------------------------------------------ ponude: status, cijene po kupcu, otpremnica
OFFER_STATUS = ["Izrađena", "Poslana", "Prihvaćena", "Odbijena", "Isporučena"]


def set_offer_status(db, offer_id, status):
    if status not in OFFER_STATUS:
        raise ValueError("Nepoznat status.")
    db.x("UPDATE offers SET status=? WHERE id=?", (status, offer_id))
    return True


def customer_prices(db, customer_id):
    ensure(db)
    return {str(r["product_id"]): r["price"] for r in db.q("SELECT * FROM customer_prices WHERE customer_id=?", (customer_id,))}


def product_customer_prices(db, product_id):
    ensure(db)
    return db.q("""SELECT cp.*, c.name AS customer FROM customer_prices cp JOIN customers c ON c.id=cp.customer_id
                   WHERE cp.product_id=? ORDER BY c.name""", (product_id,))


def set_customer_price(db, customer_id, product_id, price):
    ensure(db)
    if price in (None, ""):
        db.x("DELETE FROM customer_prices WHERE customer_id=? AND product_id=?", (customer_id, product_id))
    else:
        db.x("""INSERT INTO customer_prices(customer_id,product_id,price) VALUES(?,?,?)
                ON CONFLICT(customer_id,product_id) DO UPDATE SET price=excluded.price""", (customer_id, product_id, float(price)))
    return True


def offer_delivery_plan(db, offer_id):
    """Što ide na otpremnicu: stavke s kegovima (izbor punih kegova tog piva) i ostale stavke."""
    import web_offers
    o = web_offers.offer(db, offer_id)
    kegs = [k for k in db.kegs() if k["status"] == "Pun" and not db.keg_ship_error(k)]
    lines = []
    for ln in o["lines"]:
        p = db.one("SELECT * FROM products WHERE id=?", (ln["product_id"],)) if ln.get("product_id") else None
        rid = p.get("recipe_id") if p else None
        cand = []
        if rid:
            cand = [{"id": k["id"], "code": k["code"], "lot": k.get("batch_no") or "", "filled": k.get("filled_date")}
                    for k in kegs if db.val("SELECT recipe_id FROM batches WHERE id=?", (k["batch_id"],)) == rid]
            cand.sort(key=lambda k: k["filled"] or "")   # FIFO: najstarije punjenje prvo
        lines.append({"id": ln["id"], "name": ln["name"], "unit": ln["unit"], "qty": ln["qty"], "keg": bool(rid),
                      "candidates": cand})
    return {"offer": {k: o[k] for k in ("id", "no", "cust_name", "cust_address", "cust_oib", "customer_id",
                                        "delivery_date", "delivery_id", "status")}, "lines": lines}


def offer_to_delivery(db, offer_id, keg_ids, other_line_ids, date=None, operator=None):
    import web_offers
    o = web_offers.offer(db, offer_id)
    if o.get("delivery_id") and db.val("SELECT 1 FROM delivery_notes WHERE id=?", (o["delivery_id"],)):
        raise ValueError("Za ovu ponudu otpremnica je već izrađena.")
    cid = o.get("customer_id")
    if not cid or not db.val("SELECT 1 FROM customers WHERE id=?", (cid,)):
        cid = db.val("SELECT id FROM customers WHERE name=?", (o["cust_name"],))
    if not cid:
        cid = db.save_customer({"name": o["cust_name"], "address": o.get("cust_address") or None,
                                "oib": o.get("cust_oib") or None})
    others = [ln for ln in o["lines"] if ln["id"] in (other_line_ids or [])]
    if not keg_ids and not others:
        raise ValueError("Odaberite kegove ili stavke za otpremnicu.")
    date = date or o.get("delivery_date") or _today()
    note = f"Prema ponudi {o['no']}"
    if keg_ids:
        nid = db.create_delivery(cid, date, keg_ids, [], note, operator)
    else:
        cust = db.one("SELECT * FROM customers WHERE id=?", (cid,))
        nid = db.x("""INSERT INTO delivery_notes(no,date,customer_id,customer,note,deposit_per_keg,operator)
                      VALUES(?,?,?,?,?,?,?)""", (db.next_dn_no(), date, cid, cust["name"], note,
                                                 float(db.get_setting("keg_deposit") or 0), operator))
    for ln in others:
        db.x("""INSERT INTO delivery_lines(note_id,batch_id,lot,beer,pack_type,qty,unit_l) VALUES(?,?,?,?,?,?,?)""",
             (nid, None, "", ln["name"], ln["unit"] or "kom", ln["qty"], 0))
    db.x("UPDATE offers SET delivery_id=?, status='Isporučena', customer_id=COALESCE(customer_id, ?) WHERE id=?",
         (nid, cid, offer_id))
    return {"delivery_id": nid, "no": db.val("SELECT no FROM delivery_notes WHERE id=?", (nid,))}
