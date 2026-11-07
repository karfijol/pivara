"""Dodaci (web 2.9): povijest promjena, arhiva, QR oprema, kalendar (.ics), kegovi za povrat, godišnji pregled,
dan kuhanja, ponuda -> otpremnica, cijene po kupcu."""
import os
import io
import re
import json
import zipfile
import datetime as dt

OUT = "/out"


def r4(x):
    return round(float(x or 0) + 0.0, 4)


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
    # 2.10: raspored hmelja (kuhanje) i podsjetnik za dry hop
    cols = {r["name"] for r in db.q("PRAGMA table_info(recipes)")}
    for col, typ in (("hop_schedule", "TEXT"), ("boil_min", "INTEGER"), ("dry_hop", "INTEGER DEFAULT 0"),
                     ("dry_hop_days", "INTEGER DEFAULT 3"), ("dry_hop_time", "TEXT DEFAULT '09:00'"), ("hop_alpha", "TEXT")):
        if col not in cols:
            c.execute(f"ALTER TABLE recipes ADD COLUMN {col} {typ}")
    cols = {r["name"] for r in db.q("PRAGMA table_info(batches)")}
    for col, typ in (("hop_schedule", "TEXT"), ("boil_min", "INTEGER"), ("dry_hop_on", "INTEGER DEFAULT 0"),
                     ("dry_hop_date", "TEXT"), ("dry_hop_time", "TEXT"), ("dry_hop_done", "TEXT")):
        if col not in cols:
            c.execute(f"ALTER TABLE batches ADD COLUMN {col} {typ}")
    # 2.25: alfa kiseline hmelja na LOT-u (s deklaracije / certifikata)
    if "alpha" not in {r["name"] for r in db.q("PRAGMA table_info(lots)")}:
        c.execute("ALTER TABLE lots ADD COLUMN alpha REAL")
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
    timed = []
    for b in db.q("""SELECT b.*, r.name AS recipe FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                     WHERE COALESCE(b.dry_hop_on,0)=1 AND b.dry_hop_done IS NULL AND b.dry_hop_date IS NOT NULL
                     AND b.status<>'Planirano'"""):
        if today.isoformat() <= b["dry_hop_date"] <= to:
            hops = [f"{x['name']} {x['g']:g} {x['unit']}" for x in hop_plan(db, b["id"])["rows"] if x["stage"] == "dry"]
            timed.append((f"dry-{b['id']}", b["dry_hop_date"], b.get("dry_hop_time") or "09:00",
                          f"Dry hop: {b['recipe'] or ''} {b['batch_no']} ({b.get('tank') or 'fermentor'})", ", ".join(hops)))
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
    for uid, date, tm, title, desc in timed:
        hh, mm = (tm or "09:00").split(":")[:2]
        start = f"{date.replace('-', '')}T{int(hh):02d}{int(mm):02d}00"
        endt = (dt.datetime.fromisoformat(f"{date}T{int(hh):02d}:{int(mm):02d}") + dt.timedelta(minutes=30)).strftime("%Y%m%dT%H%M%S")
        lines += ["BEGIN:VEVENT", f"UID:{uid}@pivara", f"DTSTAMP:{stamp}", f"DTSTART:{start}", f"DTEND:{endt}",
                  f"SUMMARY:{_ics_text(title)}", f"DESCRIPTION:{_ics_text(desc)}",
                  "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(title)}", "END:VALARM",
                  "END:VEVENT"]
    # podsjetnici: obavijest mjesec dana prije, tjedan dana prije i na dan isteka
    n_rem = 0
    try:
        import web_reminders
        lim = (today + dt.timedelta(days=730)).isoformat()
        for r in web_reminders.reminders(db):
            if not (today.isoformat() <= r["due_date"] <= lim):
                continue
            d0 = r["due_date"].replace("-", "")
            d1 = (dt.date.fromisoformat(r["due_date"]) + dt.timedelta(days=1)).isoformat().replace("-", "")
            title = "Ističe: " + r["title"] + (f" ({r['person']})" if r.get("person") else "")
            lines += ["BEGIN:VEVENT", f"UID:rem-{r['id']}@pivara", f"DTSTAMP:{stamp}", f"DTSTART;VALUE=DATE:{d0}",
                      f"DTEND;VALUE=DATE:{d1}", f"SUMMARY:{_ics_text(title)}", f"DESCRIPTION:{_ics_text(r.get('note') or 'Podsjetnik iz programa PIVARA')}"]
            for trig, txt in (("-P29DT15H", "za mjesec dana"), ("-P6DT15H", "za tjedan dana"), ("PT9H", "danas")):
                lines += ["BEGIN:VALARM", f"TRIGGER:{trig}", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(title + ' – ' + txt)}", "END:VALARM"]
            lines.append("END:VEVENT")
            n_rem += 1
    except Exception:  # noqa: BLE001
        pass
    lines.append("END:VCALENDAR")
    os.makedirs(os.path.join(OUT, "kalendar"), exist_ok=True)
    path = os.path.join(OUT, "kalendar", "PIVARA_kalendar.ics")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(lines) + "\r\n")
    return {"path": path, "n": len(ev) + len(timed) + n_rem}


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
    pack = {m: 0.0 for m in months}
    pcost = {m: 0.0 for m in months}
    per_beer = {}
    for b in rep["brews"]:
        m = b["date"][:7]
        if m in litres:
            litres[m] += b["litres"] or 0
            cost[m] += b["cost"] or 0
            if b["packaged_l"]:
                pack[m] += b["packaged_l"]
                pcost[m] += b["cost"] or 0
        pb = per_beer.setdefault(b["beer"] or "?", {"beer": b["beer"] or "?", "litres": 0.0, "cost": 0.0, "brews": 0,
                                                     "pack": 0.0, "pcost": 0.0})
        pb["litres"] += b["litres"] or 0
        pb["cost"] += b["cost"] or 0
        if b["packaged_l"]:
            pb["pack"] += b["packaged_l"]
            pb["pcost"] += b["cost"] or 0
        pb["brews"] += 1
    per_l = [(m, round(pcost[m] / pack[m], 4) if pack[m] else 0) for m in months]  # €/L prema pakiranoj količini
    # proizvedeno po mjesecima i vrsti piva (složeni stupci) + isporučeno na otpremnicama po mjesecima
    by_beer_month = {}
    for b in rep["brews"]:
        m = b["date"][:7]
        if m in litres:
            by_beer_month.setdefault(b["beer"] or "?", {mm: 0.0 for mm in months})[m] += b["litres"] or 0
    delivered = {m: 0.0 for m in months}
    for r in db.q("""SELECT substr(d.date,1,7) AS m, SUM(l.qty*COALESCE(l.unit_l,0)) AS v FROM delivery_notes d
                     JOIN delivery_lines l ON l.note_id=d.id WHERE d.date BETWEEN ? AND ? GROUP BY m""", (d_from, d_to)):
        if r["m"] in delivered:
            delivered[r["m"]] = r["v"] or 0
    sales = db.q("""SELECT d.customer AS customer, COUNT(DISTINCT d.id) AS notes,
                    SUM(CASE WHEN l.pack_type='Keg' THEN l.qty ELSE 0 END) AS kegs, SUM(l.qty*COALESCE(l.unit_l,0)) AS litres
                    FROM delivery_notes d JOIN delivery_lines l ON l.note_id=d.id
                    WHERE d.date BETWEEN ? AND ? GROUP BY d.customer ORDER BY litres DESC""", (d_from, d_to))
    years = [r["y"] for r in db.q("""SELECT DISTINCT substr(brew_date,1,4) AS y FROM batches WHERE brew_date IS NOT NULL
                                     UNION SELECT DISTINCT substr(date,1,4) FROM delivery_notes ORDER BY 1 DESC""") if r["y"]]
    return {"year": year, "years": years or [str(year)], "litres": [(m, litres[m]) for m in months], "per_l": per_l,
            "beers": sorted(per_beer.values(), key=lambda x: -x["litres"]), "sales": sales,
            "months": months, "stack": [{"beer": k, "values": [v[m] for m in months]}
                                        for k, v in sorted(by_beer_month.items(), key=lambda kv: -sum(kv[1].values()))],
            "delivered": [delivered[m] for m in months], "total_delivered": sum(delivered.values()),
            "total_l": sum(litres.values()), "total_cost": sum(cost.values()), "brews": len(rep["brews"])}


# ------------------------------------------------------------------ dan kuhanja (jedno kuhanje; fermentor = n kuhanja)
def brew_day(db, batch_id):
    import web_brew
    b = db.batch(batch_id)
    if not b:
        raise ValueError("Šarža ne postoji.")
    r = db.recipe(b["recipe_id"]) if b.get("recipe_id") else {}
    bi = web_brew.batch_info(db, b)
    all_done = b["status"] != "Planirano" and bi["done"] >= bi["n"]
    k = bi["n"] if all_done else bi["done"] + 1
    brew_row = next((x for x in bi["brews"] if x["n"] == k), None) or {}
    vol_k = brew_row.get("volume_l") or bi["brew_vol"]

    def describe(needs, stage, consumed=None):
        items = []
        for nd in needs:
            items.append({"name": nd["name"], "need": nd["need"], "unit": nd["unit"], "cat": nd.get("category") or "",
                          "missing": nd.get("missing", 0), "alpha_adjusted": nd.get("alpha_adjusted", False),
                          "lots": ", ".join(f"{a[1]}" for a in nd.get("alloc", [])), "stage": stage})
        return items
    if not all_done:
        brew = [dict(p, stage="brew") for p in web_brew.stage_needs(db, b["recipe_id"], "brew", vol_k)]
        for p in brew:
            p["alloc"], p["missing"] = db.allocate_fifo(p["item_id"], p["need"])
        brew = alpha_adjust_needs(db, batch_id, brew)
        ferm = [dict(p, stage="ferm") for p in web_brew.stage_needs(db, b["recipe_id"], "ferm", b["volume_l"])]
        for p in ferm:
            p["alloc"], p["missing"] = db.allocate_fifo(p["item_id"], p["need"])
        items, ferm_items = describe(brew, "brew"), describe(ferm, "ferm")
    else:  # sva kuhanja gotova: prikaz utroška (zadnje kuhanje + fermentor)
        cons = db.q("""SELECT c.qty, c.brew_no, c.lot_id, i.name, i.unit, i.category, l.lot_no FROM batch_consumption c
                       JOIN items i ON i.id=c.item_id JOIN lots l ON l.id=c.lot_id WHERE c.batch_id=?""", (batch_id,))
        def grp(rows, stage):
            g = {}
            for c in rows:
                e = g.setdefault(c["name"], {"name": c["name"], "need": 0, "unit": c["unit"], "cat": c["category"] or "",
                                              "missing": 0, "lots": [], "stage": stage})
                e["need"] = r4(e["need"] + c["qty"])
                e["lots"].append(c["lot_no"])
            for e in g.values():
                e["lots"] = ", ".join(dict.fromkeys(e["lots"]))
            return list(g.values())
        items = grp([c for c in cons if c["brew_no"] not in (0,) and (c["brew_no"] in (None, k))], "brew")
        ferm_items = grp([c for c in cons if c["brew_no"] == 0], "ferm")
    order = {"Slad": 0, "Hmelj": 1, "Kvasac": 2}
    items.sort(key=lambda x: (order.get(x["cat"], 3), x["name"]))
    ferm_items.sort(key=lambda x: (order.get(x["cat"], 3), x["name"]))
    first = next((x for x in bi["brews"] if x["n"] == 1), None) or {}
    return {"batch": b, "recipe_note": (r or {}).get("note") or "", "items": items, "ferm_items": ferm_items,
            "mill": bool(db.mill()), "planned": not all_done, "k": k, "n": bi["n"], "last": k >= bi["n"],
            "brew_vol": vol_k, "brew": brew_row, "first_date": first.get("brew_date") or b.get("brew_date"),
            "mash": web_brew.mash_steps(r), "lauter_min": (r or {}).get("lauter_min") or 45,
            "whirl_min": (r or {}).get("whirl_min") or 15, "boil_min": int((b or {}).get("boil_min") or (r or {}).get("boil_min") or 60),
            "targets": {"og": (r or {}).get("target_og"), "fg": (r or {}).get("target_fg"),
                        "ferm_temp": (r or {}).get("target_ferm_temp"), "cool_temp": (r or {}).get("cool_temp")}}


def brew_day_finish(db, batch_id, data):
    """Kraj jednog kuhanja: skidanje sirovina (kuhanje k; zadnje kuhanje i fermentor), mjerenja kuhanja, CCP, mlin."""
    import web_brew
    b = db.batch(batch_id)
    date = data.get("date") or _today()
    op = data.get("operator") or db.get_setting("default_operator")
    bi = web_brew.batch_info(db, b)
    all_done = b["status"] != "Planirano" and bi["done"] >= bi["n"]
    if not all_done:
        k = db.brew_batch(batch_id, date, data.get("brew_vol") or None, True if data.get("last") else None)
    else:
        k = bi["n"]
    brew = {"wort_l": data.get("wort_l"), "og_sg": data.get("og_sg"), "ph": data.get("ph"), "brewer": op,
            "boil_start": data.get("boil_start") or None, "boil_end": data.get("boil_end") or None,
            "boil_min": data.get("boil_min") or None, "boil_temp": data.get("boil_temp") or None}
    if db.val("SELECT COUNT(*) FROM batch_brews WHERE batch_id=? AND n=?", (batch_id, k)):
        keys = [x for x in brew if brew[x] not in (None, "")]
        if keys:
            db.x(f"UPDATE batch_brews SET {','.join(x + '=?' for x in keys)} WHERE batch_id=? AND n=?",
                 [brew[x] for x in keys] + [batch_id, k])
    else:  # šarža skuhana prije 2.37 (bez zapisa kuhanja)
        db.x("INSERT INTO batch_brews(batch_id,n,brew_date,volume_l,wort_l,og_sg,ph,brewer,boil_start,boil_end,boil_min,boil_temp,done) "
             "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)", (batch_id, k, date, b["volume_l"], brew["wort_l"], brew["og_sg"], brew["ph"], op,
                                                    brew["boil_start"], brew["boil_end"], brew["boil_min"], brew["boil_temp"]))
    # šarža (fermentor): zbroj sladovine, OG ponderiran volumenom, pH zadnjeg kuhanja
    rows = db.q("SELECT * FROM batch_brews WHERE batch_id=? AND done=1 ORDER BY n", (batch_id,))
    upd = {"brewer": op}
    wort = [x["wort_l"] for x in rows if x.get("wort_l")]
    if wort:
        upd["wort_l"] = round(sum(wort), 1)
    og = [(x["og_sg"], x.get("wort_l") or 1) for x in rows if x.get("og_sg")]
    if og:
        upd["og_sg"] = round(sum(a * w for a, w in og) / sum(w for _a, w in og), 4)
    ph = [x["ph"] for x in rows if x.get("ph")]
    if ph:
        upd["ph"] = ph[-1]
    if data.get("tank"):
        upd["tank"] = data["tank"]
    if k == 1:
        upd["ferm_start"] = date  # prvo kuhanje = početak punjenja fermentora
    if data.get("ferm_temp"):
        upd["ferm_temp"] = data["ferm_temp"]
    db.update_batch(batch_id, upd)
    b = db.batch(batch_id)
    if data.get("boil_temp"):
        t = float(data["boil_temp"])
        ok = t >= 100
        rec = {"batch_id": batch_id, "lot": b["batch_no"], "date": date,
               "start_time": data.get("boil_start") or None, "end_time": data.get("boil_end") or None,
               "temp": t, "minutes": data.get("boil_min") or None, "limit_ok": 1 if ok else 0,
               "result": "OK" if ok else "NE", "corrective": data.get("corrective") or ("/" if ok else ""),
               "operator": op}
        cid = db.save_record("ccp_boil", rec)
        try:
            db.x("UPDATE ccp_boil SET brew_no=? WHERE id=?", (k, cid))
        except Exception:  # noqa: BLE001
            pass
    if data.get("mill_ok"):
        db.add_mill_check(date, "Uređaj je u redu", op, batch_id)
    dry = data.get("dry") or {}
    if "on" in dry:
        on = 1 if dry.get("on") else 0
        days = int(dry.get("days") or 3)
        start = b.get("brew_date") or date
        db.update_batch(batch_id, {"dry_hop_on": on, "dry_hop_time": dry.get("time") or "09:00",
                                   "dry_hop_date": (dt.date.fromisoformat(start[:10]) + dt.timedelta(days=days)).isoformat() if on else None})
    b = db.batch(batch_id)
    bi = web_brew.batch_info(db, b)
    return {"batch_no": b["batch_no"], "k": k, "n": bi["n"], "done_all": bi["done"] >= bi["n"],
            "dry_hop_date": b.get("dry_hop_date") if b.get("dry_hop_on") else None}


# ------------------------------------------------------------------ hmeljenje: raspored za kuhanje i dry hop
# Hmelj u kuhanju = sastojak recepture „po kuhanju” (količina za JEDNO kuhanje); dry hop = sastojak „za fermentor”.
# Raspored: redak {item_id, stage: 'boil'|'dry', min, frac} – frac = dio količine tog hmelja u toj fazi.
def _hop_needs(db, recipe_id, brew_vol, ferm_vol):
    """{(item_id, 'boil'|'dry'): (naziv, količina, jedinica)} – kuhanje za jedno kuhanje, dry hop za cijeli fermentor."""
    import web_brew
    out = {}
    for stage, key, vol in (("brew", "boil", brew_vol), ("ferm", "dry", ferm_vol)):
        for ln in web_brew.stage_needs(db, recipe_id, stage, vol):
            if (ln.get("category") or "") == "Hmelj":
                out[(ln["item_id"], key)] = (ln["name"], ln["need"], ln["unit"])
    return out


def _grams(q, unit):
    u = (unit or "").lower()
    return q * 1000 if u == "kg" else q


def _vols(db, b, r):
    """(volumen jednog kuhanja, volumen fermentora) za šaržu ili recepturu."""
    import web_brew
    if b:
        bi = web_brew.batch_info(db, b)
        return (bi["brew_vol"] or 0), (b.get("volume_l") or 0)
    if r.get("id"):
        bs, _n, fs = web_brew.sizes(db, r["id"])
        return bs, fs
    return 0, 0


def hop_plan(db, batch_id=None, recipe_id=None):
    """Raspored hmelja kao u BeerSmithu: svaki dodatak ima VRIJEME KUHANJA (min = koliko dugo se kuha; boil = na početku,
    0 = na kraju). Izvor su retci recepture (svaki dodatak hmelja zaseban redak), a šarža može imati vlastiti raspored.
    Kuhanje: količina za jedno kuhanje; dry hop: za cijeli fermentor (min = dan nakon kuhanja)."""
    import web_brew
    b = db.batch(batch_id) if batch_id else None
    rid = b["recipe_id"] if b else recipe_id
    r = db.one("SELECT * FROM recipes WHERE id=?", (rid,)) or {}
    brew_vol, ferm_vol = _vols(db, b, r)
    needs = _hop_needs(db, rid, brew_vol, ferm_vol) if rid else {}
    boil = int((b or {}).get("boil_min") or r.get("boil_min") or 60)
    raw = (b or {}).get("hop_schedule")
    try:
        rows = json.loads(raw) if raw else []
    except ValueError:
        rows = []
    custom = bool(rows)
    bs, _n, fs = web_brew.sizes(db, rid) if rid else (1, 1, 1)
    if not rows and rid:  # iz recepture: svaki redak hmelja = jedan dodatak
        for ln in db.recipe_lines(rid):
            if (ln.get("category") or "") != "Hmelj":
                continue
            stg = "dry" if ln.get("stage") == "ferm" else "boil"
            tot = needs.get((ln["item_id"], stg))
            if not tot:
                continue
            q = ln["qty"] * ((brew_vol or bs) / bs if stg == "boil" else (ferm_vol or fs) / fs)
            t = ln.get("add_min")
            rows.append({"item_id": ln["item_id"], "stage": stg, "frac": round(q / tot[1], 6) if tot[1] else 0,
                         "min": (boil if t in (None, "") else int(t)) if stg == "boil" else int(t or 0)})
    out = []
    for x in rows:
        stg = x.get("stage") or "boil"
        key = (x.get("item_id"), stg)
        if key not in needs:
            continue
        name, q, unit = needs[key]
        g = round(_grams(q * float(x.get("frac") or 0), unit), 1)
        mn = int(x.get("min") or 0)
        adj = x.get("adj")
        if adj is None:
            adj = _auto_adj(stg, mn, boil)
        out.append({"item_id": x["item_id"], "name": name, "stage": stg,
                    "min": mn, "frac": float(x.get("frac") or 0), "g": g, "adj": bool(adj),
                    "unit": "g" if (unit or "").lower() in ("kg", "g") else unit})
    out.sort(key=lambda x: (x["stage"] != "boil", -x["min"] if x["stage"] == "boil" else x["min"], x["name"]))
    dry_rows = [x for x in out if x["stage"] == "dry"]
    on = (b or {}).get("dry_hop_on")
    rec_on = 1 if (int(r.get("dry_hop") or 0) or dry_rows) else 0
    on = rec_on if on is None or (b and not b.get("dry_hop_date") and b["status"] == "Planirano") else int(on)
    days_l = [x["min"] for x in dry_rows if x["min"] > 0]
    days = min(days_l) if days_l else int(r.get("dry_hop_days") or 3)
    tm = (b or {}).get("dry_hop_time") or r.get("dry_hop_time") or "09:00"
    date = (b or {}).get("dry_hop_date")
    if not date and b and b.get("brew_date") and b["status"] != "Planirano":
        date = (dt.date.fromisoformat(b["brew_date"][:10]) + dt.timedelta(days=days)).isoformat()
    hops = {}
    for (iid, st), (n, q, u) in needs.items():
        hp = hops.setdefault(iid, {"item_id": iid, "name": n, "g_boil": 0.0, "g_dry": 0.0,
                                   "unit": "g" if (u or "").lower() in ("kg", "g") else u})
        hp["g_boil" if st == "boil" else "g_dry"] = round(_grams(q, u), 1)
    hops = sorted(hops.values(), key=lambda x: x["name"])
    # korekcija prema alfa kiselinama: recept (alfa u recepturi) / LOT koji se troši (FIFO ili stvarno utrošen)
    boil_needs = {iid: v for (iid, st), v in needs.items() if st == "boil"}
    alpha = _alpha_info(db, b, r, boil_needs)
    for x in out:
        f = (alpha.get(x["item_id"]) or {}).get("factor")
        if x["stage"] == "boil" and x["adj"] and f and abs(f - 1) > 1e-6:
            x["g_adj"] = round(x["g"] * f, 1)
    for hp in hops:
        hp["alpha"] = alpha.get(hp["item_id"]) or {}
        hp["g"] = round(hp["g_boil"] + hp["g_dry"], 1)
    # ostali dodaci u kuhanju s vremenom kuhanja (npr. Whirlfloc 15 min) – za alarm
    adds = []
    if rid:
        for ln in db.recipe_lines(rid):
            if (ln.get("category") or "") == "Hmelj" or ln.get("stage") == "ferm" or ln.get("add_min") in (None, ""):
                continue
            adds.append({"item_id": ln["item_id"], "name": ln["name"], "min": int(ln["add_min"]),
                         "qty": r4(ln["qty"] * (brew_vol or bs) / bs), "unit": ln["unit"]})
    return {"rows": out, "boil_min": boil, "hops": hops, "dry": {"on": on, "days": days, "time": tm, "date": date,
                                                                 "done": (b or {}).get("dry_hop_done")},
            "recipe": r.get("name") or "", "recipe_id": rid, "alpha": {str(k): v for k, v in alpha.items()},
            "adds": adds, "brew_vol": brew_vol, "ferm_vol": ferm_vol, "custom": custom}


def _auto_adj(stage, minute, boil):
    """Dodatak za gorčinu (korigira se prema alfi): u kuhanju i kuha se barem 30 min (minute = vrijeme kuhanja)."""
    return stage == "boil" and int(minute or 0) >= 30


def _recipe_alpha(r):
    try:
        d = json.loads((r or {}).get("hop_alpha") or "{}")
        return {int(k): float(v) for k, v in d.items() if v not in (None, "")}
    except (ValueError, TypeError):
        return {}


def _alpha_info(db, b, r, needs):
    """{item_id: {recipe, lot, factor, lots}} – lot = ponderirana alfa LOT-ova koji se troše."""
    ra = _recipe_alpha(r)
    out = {}
    for iid, (name, q, unit) in needs.items():
        info = {"recipe": ra.get(iid), "lot": None, "factor": None, "lots": []}
        if b and b.get("status") != "Planirano":
            used = db.q("""SELECT l.lot_no, l.alpha, c.qty FROM batch_consumption c JOIN lots l ON l.id=c.lot_id
                           WHERE c.batch_id=? AND c.item_id=? AND COALESCE(c.brew_no,1)<>0""", (b["id"], iid))
            parts = [(u["lot_no"], u["alpha"], u["qty"]) for u in used]
        else:
            alloc, _miss = db.allocate_fifo(iid, q)
            parts = []
            for lid, lot_no, qty in alloc:
                parts.append((lot_no, db.val("SELECT alpha FROM lots WHERE id=?", (lid,)), qty))
        info["lots"] = [{"lot": p[0], "alpha": p[1]} for p in parts]
        tot = sum(p[2] for p in parts)
        if parts and tot > 0 and all(p[1] for p in parts):
            info["lot"] = round(sum(p[1] * p[2] for p in parts) / tot, 2)
        if info["recipe"] and info["lot"]:
            info["factor"] = round(info["recipe"] / info["lot"], 4)
        out[iid] = info
    return out


def alpha_adjust_needs(db, batch_id, prev):
    """Kuhanje: količinu hmelja za gorčinu skida se prema alfi LOT-a (prev iz preview_brew se mijenja na mjestu)."""
    b = db.batch(batch_id)
    plan = hop_plan(db, batch_id)
    for p in prev:
        if p.get("stage") == "ferm":
            continue
        a = (plan.get("alpha") or {}).get(str(p["item_id"])) or {}
        f = a.get("factor")
        if not f or abs(f - 1) < 1e-6:
            continue
        frac_adj = sum(x["frac"] for x in plan["rows"] if x["item_id"] == p["item_id"] and x["stage"] == "boil" and x["adj"])
        if frac_adj <= 0:
            continue
        new = round(p["need"] * (1 + frac_adj * (f - 1)), 4)
        alloc, missing = db.allocate_fifo(p["item_id"], new)
        p.update({"need": new, "alloc": alloc, "missing": missing, "alpha_adjusted": True})
    return prev


def save_hop_plan(db, rows, boil_min=60, dry=None, batch_id=None, recipe_id=None, as_default=False, alpha=None):
    """rows: [{item_id, stage, min, g}] – g se preračuna u dio količine tog hmelja u toj fazi (frac)."""
    b = db.batch(batch_id) if batch_id else None
    rid = b["recipe_id"] if b else recipe_id
    r = db.one("SELECT * FROM recipes WHERE id=?", (rid,)) or {}
    brew_vol, ferm_vol = _vols(db, b, r)
    needs = _hop_needs(db, rid, brew_vol, ferm_vol)
    names = {iid: v[0] for (iid, _s), v in needs.items()}
    clean = []
    for x in (rows or []) if rows is not None else []:
        iid = x.get("item_id")
        stg = x.get("stage") or "boil"
        if (iid, stg) not in needs:
            nm = names.get(iid) or db.val("SELECT name FROM items WHERE id=?", (iid,)) or "Hmelj"
            raise ValueError(f"{nm}: za {'dry hop' if stg == 'dry' else 'kuhanje'} dodajte ovaj hmelj u recepturu kao sastojak "
                             f"„{'za fermentor' if stg == 'dry' else 'po kuhanju'}”.")
        tot = _grams(needs[(iid, stg)][1], needs[(iid, stg)][2]) or 1
        g = float(x.get("g") or 0)
        mn = int(float(x.get("min") or 0))
        if stg == "boil" and not 0 <= mn <= int(boil_min or 60):
            raise ValueError(f"{needs[(iid, stg)][0]}: vrijeme kuhanja mora biti od 0 (na kraju) do {boil_min} min (na početku).")
        row = {"item_id": iid, "stage": stg, "min": mn, "frac": round(g / tot, 4)}
        if x.get("adj") is not None and bool(x.get("adj")) != _auto_adj(row["stage"], mn, boil_min):
            row["adj"] = bool(x["adj"])  # ručno odabrano (inače automatski: gorčina = kuha se ≥ 30 min)
        clean.append(row)
    js = json.dumps(clean)
    d = dry or {}
    on = 1 if d.get("on") else 0
    days = int(d.get("days") or 3)
    tm = d.get("time") or "09:00"
    if b:
        upd = {"boil_min": int(boil_min or 60), "dry_hop_on": on, "dry_hop_time": tm}
        if rows is not None:
            upd["hop_schedule"] = js
        if d.get("date"):
            upd["dry_hop_date"] = d["date"]
        elif b.get("brew_date") and b["status"] != "Planirano":
            upd["dry_hop_date"] = (dt.date.fromisoformat(b["brew_date"][:10]) + dt.timedelta(days=days)).isoformat()
        db.update_batch(batch_id, upd)
    if as_default or not b:
        db.x("UPDATE recipes SET hop_schedule=NULL, boil_min=?, dry_hop=?, dry_hop_days=?, dry_hop_time=? WHERE id=?",
             (int(boil_min or 60), on, days, tm, rid))
        if rows is not None:  # raspored šarže kao zadano za recepturu: retci hmelja recepture (količina po kuhanju / fermentoru)
            import web_brew
            bs, _n, fs = web_brew.sizes(db, rid)
            with db.con:
                db.con.execute("DELETE FROM recipe_items WHERE recipe_id=? AND item_id IN (SELECT id FROM items WHERE category='Hmelj')", (rid,))
                for x in clean:
                    name, q, unit = needs[(x["item_id"], x["stage"])]
                    qty = q * x["frac"] * ((bs / brew_vol) if x["stage"] == "boil" and brew_vol else (fs / ferm_vol) if ferm_vol else 1)
                    db.con.execute("INSERT INTO recipe_items(recipe_id,item_id,qty,stage,add_min) VALUES(?,?,?,?,?)",
                                   (rid, x["item_id"], r4(qty), "brew" if x["stage"] == "boil" else "ferm", x["min"]))
    if alpha is not None:  # alfa kiseline u recepturi (uvijek za recepturu)
        clean_a = {str(int(k)): float(v) for k, v in alpha.items() if v not in (None, "", 0)}
        db.x("UPDATE recipes SET hop_alpha=? WHERE id=?", (json.dumps(clean_a), rid))
    return True


def set_lot_alpha(db, lot_ids, alpha):
    v = float(alpha) if alpha not in (None, "") else None
    for lid in lot_ids if isinstance(lot_ids, list) else [lot_ids]:
        db.con.execute("UPDATE lots SET alpha=? WHERE id=?", (v, lid))
    db.con.commit()
    return True


def dry_hop_due(db, days_ahead=0):
    """Šarže kojima je dry hop danas ili je kasnio (ili u sljedećih N dana)."""
    lim = (dt.date.today() + dt.timedelta(days=days_ahead)).isoformat()
    out = []
    for b in db.q("""SELECT b.*, r.name AS recipe FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                     WHERE COALESCE(b.dry_hop_on,0)=1 AND b.dry_hop_done IS NULL AND b.dry_hop_date IS NOT NULL
                     AND b.dry_hop_date<=? AND b.status IN ('Fermentacija','Odležavanje')""", (lim,)):
        p = hop_plan(db, b["id"])
        out.append({"batch_id": b["id"], "batch_no": b["batch_no"], "recipe": b["recipe"], "tank": b.get("tank") or "",
                    "date": b["dry_hop_date"], "time": b.get("dry_hop_time") or "", "late": b["dry_hop_date"] < _today(),
                    "hops": [f"{x['name']} {x['g']:g} {x['unit']}".replace(".", ",") for x in p["rows"] if x["stage"] == "dry"]})
    return out


def dry_hop_mark(db, batch_id, done=True):
    db.update_batch(batch_id, {"dry_hop_done": _today() if done else None})
    return True


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


# ------------------------------------------------------------------ brisanje LOT-ova (LOT-ovi i zalihe)
def lots_delete_check(db, lot_ids):
    """Podaci o LOT-ovima za potvrdu brisanja; za LOT utrošen u šaržama vraća popis šarži."""
    out = []
    for lid in lot_ids or []:
        l = db.one("SELECT l.id, l.lot_no, l.qty_received, l.qty_left, i.name AS item, i.unit FROM lots l "
                   "JOIN items i ON i.id=l.item_id WHERE l.id=?", (lid,))
        if not l:
            continue
        used = [r["batch_no"] for r in db.q("SELECT DISTINCT b.batch_no FROM batch_consumption c JOIN batches b ON b.id=c.batch_id "
                                             "WHERE c.lot_id=? ORDER BY b.batch_no", (lid,))]
        out.append({**l, "batches": used})
    return {"ok": out, "used": [l for l in out if l["batches"]]}


def delete_lots(db, lot_ids):
    """Briše LOT-ove s njihovim kretanjima. Ako je LOT bio utrošen u šaržama, briše se i taj dio evidencije utroška
    (šarže ostaju bez tog LOT-a dok se ne pokrene Inventura, koja utrošak ponovno raspodijeli po FIFO).
    HACCP zapis o prijemu robe ostaje, samo se odvoji od LOT-a."""
    chk = lots_delete_check(db, lot_ids)
    ids = [l["id"] for l in chk["ok"]]
    with db.con:
        for lid in ids:
            db.con.execute("DELETE FROM batch_consumption WHERE lot_id=?", (lid,))
            db.con.execute("DELETE FROM movements WHERE lot_id=?", (lid,))
            try:
                db.con.execute("UPDATE receipts SET lot_id=NULL WHERE lot_id=?", (lid,))
            except Exception:  # noqa: BLE001
                pass
            db.con.execute("DELETE FROM lots WHERE id=?", (lid,))
    return {"deleted": len(ids), "batches": sorted({b for l in chk["used"] for b in l["batches"]})}


# ------------------------------------------------------------------ uređivanje LOT-a (broj, datum primitka, rok)
def lot_edit_data(db, lot_id):
    """Podaci za dijalog „Uredi LOT”: svi podaci LOT-a, koliko je utrošeno i popisi za izbor."""
    ensure(db)
    l = db.one("SELECT * FROM v_lots WHERE id=?", (lot_id,))
    if not l:
        raise ValueError("LOT ne postoji.")
    used_batches = [r["batch_no"] for r in db.q("SELECT DISTINCT b.batch_no FROM batch_consumption c JOIN batches b ON b.id=c.batch_id "
                                                 "WHERE c.lot_id=? ORDER BY b.batch_no", (lot_id,))]
    return {"lot": l, "used": round((l["qty_received"] or 0) - (l["qty_left"] or 0), 4), "batches": used_batches,
            "items": [[f"{i['name']} ({i['unit']})", i["id"]] for i in db.q("SELECT id, name, unit FROM items ORDER BY name")],
            "suppliers": [[x["name"], x["id"]] for x in db.suppliers()]}


def _h(x):
    return f"{round(float(x), 4):g}".replace(".", ",")


def edit_lot(db, lot_id, data):
    """Mijenja sve podatke LOT-a: artikl (samo ako LOT nije korišten u kuhanju), broj LOT-a, datume, količine,
    dobavljača, račun, cijenu, alfa kiseline i napomenu. Sljedivost i HACCP vežu se na LOT (id), pa promjene vrijede svuda.
    Promjene se bilježe na kartici artikla; promjena količina kao kretanje, ostalo kao „PROMJENA LOT” (količina 0)."""
    ensure(db)
    try:
        import web_costs
        web_costs.ensure(db)
    except Exception:  # noqa: BLE001
        pass
    l = db.one("SELECT * FROM lots WHERE id=?", (lot_id,))
    if not l:
        raise ValueError("LOT ne postoji.")
    g = lambda k, d=None: data[k] if k in data else d  # noqa: E731

    def num(v, name, allow_none=False):
        if v in (None, ""):
            if allow_none:
                return None
            raise ValueError(f"Upišite {name}.")
        try:
            return round(float(str(v).replace(",", ".")), 4)
        except ValueError:
            raise ValueError(f"{name[:1].upper() + name[1:]} mora biti broj.") from None

    new_no = (g("lot_no", l["lot_no"]) or "").strip()
    if not new_no:
        raise ValueError("Upišite broj LOT-a.")
    item_id = int(g("item_id", l["item_id"]) or l["item_id"])
    used_in_batches = db.val("SELECT COUNT(*) FROM batch_consumption WHERE lot_id=?", (lot_id,)) or 0
    if item_id != l["item_id"] and used_in_batches:
        raise ValueError("Artikl se ne može promijeniti jer je LOT već korišten u kuhanju. Obrišite LOT i zaprimite ga ispravno, "
                         "pa pokrenite Inventuru.")
    rec = (g("received_date", l["received_date"]) or "")[:10]
    if not rec:
        raise ValueError("Odaberite datum primitka.")
    exp = (g("expiry_date", l["expiry_date"]) or "")[:10] or None
    if exp and exp < rec:
        raise ValueError("Rok trajanja ne može biti prije datuma primitka.")
    opened = (g("opened_date", l.get("opened_date")) or "")[:10] or None
    q_rec = num(g("qty_received", l["qty_received"]), "primljenu količinu")
    q_left = num(g("qty_left", l["qty_left"]), "preostalu količinu")
    if q_rec <= 0:
        raise ValueError("Primljena količina mora biti veća od 0.")
    if q_left < 0:
        raise ValueError("Preostala količina ne može biti negativna.")
    if q_left > q_rec + 1e-9:
        raise ValueError("Preostala količina ne može biti veća od primljene.")
    price = num(g("unit_price", l["unit_price"]), "cijenu", True) or 0
    alpha = num(g("alpha", l.get("alpha")), "alfa kiseline", True) or None
    sup = g("supplier_id", l["supplier_id"])
    sup = int(sup) if sup not in (None, "") else None
    inv = (g("invoice_no", l.get("invoice_no")) or "").strip() or None
    note = (g("note", l.get("note")) or "").strip() or None
    if db.val("SELECT COUNT(*) FROM lots WHERE item_id=? AND lot_no=? AND id<>?", (item_id, new_no, lot_id)):
        raise ValueError(f"Ovaj artikl već ima LOT „{new_no}”.")

    def name_of(table, id_):
        return (db.val(f"SELECT name FROM {table} WHERE id=?", (id_,)) or "-") if id_ else "-"
    ch = []
    if item_id != l["item_id"]:
        ch.append(f"artikl {name_of('items', l['item_id'])} → {name_of('items', item_id)}")
    if new_no != l["lot_no"]:
        ch.append(f"LOT {l['lot_no']} → {new_no}")
    if rec != (l["received_date"] or "")[:10]:
        ch.append(f"primljeno {l['received_date'] or '-'} → {rec}")
    if exp != ((l["expiry_date"] or "")[:10] or None):
        ch.append(f"rok {l['expiry_date'] or '-'} → {exp or '-'}")
    if opened != ((l.get("opened_date") or "")[:10] or None):
        ch.append(f"otvoreno {l.get('opened_date') or '-'} → {opened or '-'}")
    if abs(q_rec - l["qty_received"]) > 1e-9:
        ch.append(f"primljena količina {_h(l['qty_received'])} → {_h(q_rec)}")
    if abs(q_left - l["qty_left"]) > 1e-9:
        ch.append(f"preostalo {_h(l['qty_left'])} → {_h(q_left)}")
    if sup != l["supplier_id"]:
        ch.append(f"dobavljač {name_of('suppliers', l['supplier_id'])} → {name_of('suppliers', sup)}")
    if inv != (l.get("invoice_no") or None):
        ch.append(f"račun {l.get('invoice_no') or '-'} → {inv or '-'}")
    if abs((price or 0) - (l["unit_price"] or 0)) > 1e-9:
        ch.append(f"cijena {_h(l['unit_price'] or 0)} → {_h(price)}")
    if (alpha or None) != (l.get("alpha") or None):
        ch.append(f"alfa {_h(l.get('alpha')) if l.get('alpha') else '-'} → {_h(alpha) if alpha else '-'}")
    if note != (l.get("note") or None):
        ch.append("napomena")
    if not ch:
        return {"changed": 0, "what": []}
    ts = __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M")
    d_rec = round(q_rec - l["qty_received"], 4)
    d_left = round(q_left - (l["qty_left"] + d_rec), 4)   # promjena preostalog povrh promjene primljenog
    with db.con:
        db.con.execute("""UPDATE lots SET item_id=?, lot_no=?, received_date=?, expiry_date=?, opened_date=?, qty_received=?,
                          qty_left=?, supplier_id=?, invoice_no=?, unit_price=?, alpha=?, note=? WHERE id=?""",
                       (item_id, new_no, rec, exp, opened, q_rec, q_left, sup, inv, price, alpha, note, lot_id))
        if item_id != l["item_id"]:
            db.con.execute("UPDATE movements SET item_id=? WHERE lot_id=?", (item_id, lot_id))
        if new_no != l["lot_no"]:
            db.con.execute("UPDATE movements SET ref=? WHERE lot_id=? AND ref=?", (new_no, lot_id, l["lot_no"]))
            try:
                db.con.execute("UPDATE receipts SET lot_no=? WHERE lot_id=?", (new_no, lot_id))
            except Exception:  # noqa: BLE001
                pass
        if abs(d_rec) > 1e-9:
            db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                           (ts, item_id, lot_id, d_rec, "KOREKCIJA PRIMKE", new_no, f"primljeno {_h(l['qty_received'])} → {_h(q_rec)}"))
        if abs(d_left) > 1e-9:
            db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                           (ts, item_id, lot_id, d_left, "KOREKCIJA", new_no, "Uredi LOT – preostala količina"))
        db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                       (ts, item_id, lot_id, 0, "PROMJENA LOT", new_no, "; ".join(ch)))
    return {"changed": len(ch), "what": ch}
