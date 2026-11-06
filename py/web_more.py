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


# ------------------------------------------------------------------ dan kuhanja
def brew_day(db, batch_id):
    b = db.batch(batch_id)
    if not b:
        raise ValueError("Šarža ne postoji.")
    r = db.recipe(b["recipe_id"]) if b.get("recipe_id") else {}
    needs = alpha_adjust_needs(db, batch_id, db.preview_brew(b["recipe_id"], b["volume_l"])) if b["status"] == "Planirano" else [
        {"name": c["name"], "need": c["qty"], "unit": c["unit"], "missing": 0,
         "alloc": [[c["lot_id"], c["lot_no"], c["qty"]]]} for c in db.batch_consumption(batch_id)]
    items = []
    for n in needs:
        cat = db.val("SELECT category FROM items WHERE name=?", (n["name"],)) or ""
        items.append({"name": n["name"], "need": n["need"], "unit": n["unit"], "cat": cat, "missing": n.get("missing", 0),
                      "alpha_adjusted": n.get("alpha_adjusted", False),
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
    # dan kuhanja = početak fermentacije u odabranom fermentoru
    if data.get("tank"):
        upd["tank"] = data["tank"]
    upd["ferm_start"] = date
    if data.get("ferm_temp"):
        upd["ferm_temp"] = data["ferm_temp"]
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
    dry = data.get("dry") or {}
    if "on" in dry:
        on = 1 if dry.get("on") else 0
        days = int(dry.get("days") or 3)
        db.update_batch(batch_id, {"dry_hop_on": on, "dry_hop_time": dry.get("time") or "09:00",
                                   "dry_hop_date": (dt.date.fromisoformat(date) + dt.timedelta(days=days)).isoformat() if on else None})
    b = db.batch(batch_id)
    return {"batch_no": b["batch_no"], "dry_hop_date": b.get("dry_hop_date") if b.get("dry_hop_on") else None}


# ------------------------------------------------------------------ hmeljenje: raspored za kuhanje i dry hop
def _hop_needs(db, recipe_id, volume):
    """Ukupna količina svakog hmelja u recepturi za zadani volumen: {item_id: (naziv, količina, jedinica)}."""
    out = {}
    for ln in db.scaled_needs(recipe_id, volume):
        cat = db.val("SELECT category FROM items WHERE id=?", (ln["item_id"],)) or ""
        if cat != "Hmelj":
            continue
        n, q, u = out.get(ln["item_id"], (ln["name"], 0, ln["unit"]))
        out[ln["item_id"]] = (n, q + ln["need"], u)
    return out


def _grams(q, unit):
    u = (unit or "").lower()
    return q * 1000 if u == "kg" else q


def hop_plan(db, batch_id=None, recipe_id=None):
    """Raspored hmelja: dodaci tijekom kuhanja (minuta od početka) i dry hop (u fermentoru, X dana nakon kuhanja).
    Redak: {item_id, stage: 'boil'|'dry', min, frac} – frac = dio ukupne količine tog hmelja u recepturi."""
    b = db.batch(batch_id) if batch_id else None
    rid = b["recipe_id"] if b else recipe_id
    r = db.one("SELECT * FROM recipes WHERE id=?", (rid,)) or {}
    vol = (b.get("volume_l") if b else None) or r.get("batch_size_l") or 0
    needs = _hop_needs(db, rid, vol) if rid else {}
    raw = (b or {}).get("hop_schedule") or r.get("hop_schedule")
    try:
        rows = json.loads(raw) if raw else []
    except ValueError:
        rows = []
    if not rows:  # zadano: sav hmelj na početku kuhanja
        rows = [{"item_id": iid, "stage": "boil", "min": 0, "frac": 1} for iid in needs]
    boil = int((b or {}).get("boil_min") or r.get("boil_min") or 60)
    out = []
    for x in rows:
        if x.get("item_id") not in needs:
            continue
        name, q, unit = needs[x["item_id"]]
        g = round(_grams(q * float(x.get("frac") or 0), unit), 1)
        stg = x.get("stage") or "boil"
        mn = int(x.get("min") or 0)
        adj = x.get("adj")
        if adj is None:
            adj = _auto_adj(stg, mn, boil)
        out.append({"item_id": x["item_id"], "name": name, "stage": stg,
                    "min": mn, "frac": float(x.get("frac") or 0), "g": g, "adj": bool(adj),
                    "unit": "g" if (unit or "").lower() in ("kg", "g") else unit})
    out.sort(key=lambda x: (x["stage"] != "boil", x["min"], x["name"]))
    on = (b or {}).get("dry_hop_on")
    on = int(r.get("dry_hop") or 0) if on is None or (b and not b.get("dry_hop_date") and b["status"] == "Planirano") else int(on)
    days = int(r.get("dry_hop_days") or 3)
    tm = (b or {}).get("dry_hop_time") or r.get("dry_hop_time") or "09:00"
    date = (b or {}).get("dry_hop_date")
    if not date and b and b.get("brew_date") and b["status"] != "Planirano":
        date = (dt.date.fromisoformat(b["brew_date"][:10]) + dt.timedelta(days=days)).isoformat()
    hops = [{"item_id": iid, "name": n, "g": round(_grams(q, u), 1), "unit": "g" if (u or "").lower() in ("kg", "g") else u}
            for iid, (n, q, u) in needs.items()]
    # korekcija prema alfa kiselinama: recept (alfa u recepturi) / LOT koji se troši (FIFO ili stvarno utrošen)
    alpha = _alpha_info(db, b, r, needs)
    for x in out:
        f = (alpha.get(x["item_id"]) or {}).get("factor")
        if x["stage"] == "boil" and x["adj"] and f and abs(f - 1) > 1e-6:
            x["g_adj"] = round(x["g"] * f, 1)
    for hp in hops:
        hp["alpha"] = alpha.get(hp["item_id"]) or {}
    return {"rows": out, "boil_min": boil, "hops": hops, "dry": {"on": on, "days": days, "time": tm, "date": date,
                                                                 "done": (b or {}).get("dry_hop_done")},
            "recipe": r.get("name") or "", "recipe_id": rid, "alpha": {str(k): v for k, v in alpha.items()}}


def _auto_adj(stage, minute, boil):
    """Dodatak za gorčinu (korigira se prema alfi): u kuhanju i kuha se barem 30 min."""
    return stage == "boil" and (int(boil or 60) - int(minute or 0)) >= 30


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
                           WHERE c.batch_id=? AND c.item_id=?""", (b["id"], iid))
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
    """rows: [{item_id, stage, min, g}] – g se preračuna u dio ukupne količine (frac)."""
    b = db.batch(batch_id) if batch_id else None
    rid = b["recipe_id"] if b else recipe_id
    r = db.one("SELECT * FROM recipes WHERE id=?", (rid,)) or {}
    vol = (b.get("volume_l") if b else None) or r.get("batch_size_l") or 0
    needs = _hop_needs(db, rid, vol)
    clean = []
    for x in rows or []:
        iid = x.get("item_id")
        if iid not in needs:
            continue
        tot = _grams(needs[iid][1], needs[iid][2]) or 1
        g = float(x.get("g") or 0)
        mn = int(float(x.get("min") or 0))
        if x.get("stage", "boil") == "boil" and not 0 <= mn <= int(boil_min or 60):
            raise ValueError(f"{needs[iid][0]}: minuta mora biti između 0 (početak) i {boil_min} (kraj kuhanja).")
        row = {"item_id": iid, "stage": x.get("stage") or "boil", "min": mn, "frac": round(g / tot, 4)}
        if x.get("adj") is not None and bool(x.get("adj")) != _auto_adj(row["stage"], mn, boil_min):
            row["adj"] = bool(x["adj"])  # ručno odabrano (inače automatski: gorčina = kuha se ≥ 30 min)
        clean.append(row)
    js = json.dumps(clean)
    d = dry or {}
    on = 1 if d.get("on") else 0
    days = int(d.get("days") or 3)
    tm = d.get("time") or "09:00"
    if b:
        upd = {"hop_schedule": js, "boil_min": int(boil_min or 60), "dry_hop_on": on, "dry_hop_time": tm}
        if d.get("date"):
            upd["dry_hop_date"] = d["date"]
        elif b.get("brew_date") and b["status"] != "Planirano":
            upd["dry_hop_date"] = (dt.date.fromisoformat(b["brew_date"][:10]) + dt.timedelta(days=days)).isoformat()
        db.update_batch(batch_id, upd)
    if as_default or not b:
        db.x("UPDATE recipes SET hop_schedule=?, boil_min=?, dry_hop=?, dry_hop_days=?, dry_hop_time=? WHERE id=?",
             (js, int(boil_min or 60), on, days, tm, rid))
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
