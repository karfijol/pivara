"""Ponude kupcima: cjenik proizvoda (PIVARA CJENIK – GRUPE) i ponude s brojem 'N-GGGG', PDF ispis.

Tablice (ista baza kao desktop program; desktop ih ne koristi):
- products: cjenik (grupa, naziv, opis, jedinica, cijena s PDV-om, stopa PDV-a)
- offers, offer_lines: ponude i stavke (naziv i cijena se kopiraju u stavku, pa kasnija promjena cjenika
  ne mijenja već izdane ponude)
"""
import os
import re
import datetime as dt

OUT = "/out"
LOGO = "/app/pivara_logo.png"   # logo PIVARA (web: js/py.js ga zapiše iz icons/pivara-logo.png)

GROUPS = ["Paketi", "Pivo", "Bezalkoholna pića", "Grickalice", "Ostalo", "Piće po narudžbi"]

# cjenik od 10.09.2026. (cijene u € s PDV-om)
PRICE_LIST = [
    ("Paketi", "Taste & Snack", "Pivska degustacijska daska (5 × 1,5 dcl) + grickalice po izboru", "kom", 13),
    ("Paketi", "Taste & Pick", "Pivska degustacijska daska (5 × 1,5 dcl) + pivo 0,4 L po izboru", "kom", 15),
    ("Paketi", "Taste & All", "Pivska degustacijska daska (5 × 1,5 dcl) + grickalice po izboru + pivo 0,4 L po izboru", "kom", 16),
    ("Paketi", "All you can drink", "Neograničeno pivo, max. 2 bezalkoholna pića i 2 grickalice, trajanje 3 sata", "osoba", 30),
    ("Pivo", "Pivo Lager 0,4 L", "", "kom", 3.5),
    ("Pivo", "Pivo Pale Ale 0,4 L", "", "kom", 4.5),
    ("Pivo", "Pivo IPA 0,4 L", "", "kom", 4.5),
    ("Pivo", "Pivo Stout 0,4 L", "", "kom", 4.5),
    ("Pivo", "Pivo Sour 0,4 L", "", "kom", 5.5),
    ("Pivo", "Pivska degustacijska daska (5 × 1,5 dcl)", "", "kom", 12),
    ("Bezalkoholna pića", "Gazirana voda 0,33 L", "", "kom", 2.5),
    ("Bezalkoholna pića", "Negazirana voda 0,33 L", "", "kom", 2.5),
    ("Bezalkoholna pića", "Gazirana voda 0,75 L", "", "kom", 5),
    ("Bezalkoholna pića", "Negazirana voda 0,75 L", "", "kom", 5),
    ("Bezalkoholna pića", "Coca-Cola 0,25 L", "", "kom", 3),
    ("Bezalkoholna pića", "Cedevita 19 g", "", "kom", 2.5),
    ("Bezalkoholna pića", "Kapronca 0,29 L", "", "kom", 3),
    ("Grickalice", "Kikiriki 50 g", "", "kom", 2.5),
    ("Grickalice", "Slane perece 50 g", "", "kom", 2.5),
    ("Grickalice", "Slani krekeri 70 g", "", "kom", 2.5),
    ("Ostalo", "Pivska čaša s logom", "", "kom", 6),
    ("Ostalo", "Rakija (razna) 0,03 L", "", "kom", 3.5),
    ("Ostalo", "Kava", "", "kom", 1.5),
    ("Piće po narudžbi", "Pelinkovac Antique 1 L", "", "boca", 55),
    ("Piće po narudžbi", "Pelinkovac Antique 0,7 L", "", "boca", 45),
    ("Piće po narudžbi", "Jack Daniels 1 L", "", "boca", 60),
    ("Piće po narudžbi", "Jack Daniels 0,7 L", "", "boca", 50),
    ("Piće po narudžbi", "Vino bijelo 1 L", "", "boca", 11),
    ("Piće po narudžbi", "Vino crno 1 L", "", "boca", 13),
    ("Piće po narudžbi", "Beefeater Gin 1 L", "", "boca", 60),
    ("Piće po narudžbi", "Old Pilots Gin 0,7 L", "", "boca", 110),
    ("Piće po narudžbi", "Schweppes Tonic 0,25 L", "", "kom", 3),
    ("Piće po narudžbi", "Jägermeister 1 L", "", "boca", 55),
    ("Piće po narudžbi", "Jägermeister 0,7 L", "", "boca", 45),
    ("Piće po narudžbi", "Slano pecivo za 5 osoba 1 kg", "", "kom", 25),
    ("Piće po narudžbi", "Hladna plata za 10 osoba 1 kg", "", "kom", 100),
]

SETTINGS = {
    "offer_header1": "PIVNICA I PIVOVARA PIVARA\nKOLODVORSKA 130, 31315 KARANAC",
    "offer_header2": "LOOP IN d.o.o.\nKOLODVORSKA 130, 31315 KARANAC\nOIB: 67906993916",
    "offer_footer": ("LOOP IN društvo s ograničenom odgovornošću za računalno programiranje; Registrirano kod: "
                     "Trgovački sud u Osijeku; član uprave: Josipa Milić; MBS: 030259681; OIB: HR67906993916; "
                     "Temeljni kapital: 2.650,00 EUR uplaćen u cijelosti; IBAN: HR4924020061101334527, kod "
                     "Erste&Steiermärkische Bank d.d., Jadranski trg 3A, 51000 Rijeka"),
    "offer_payment_desc": "Plaćanje po ponudi, s pozivom na broj ponude.",
    "offer_payment_method": "Transakcijski račun",
    "offer_valid_days": "15",
    "offer_vat": "25",
    "offer_first_no": "1",
    # HUB 3 2D kod za plaćanje (PDF417) na ponudi
    "offer_hub3": "1",
    "offer_iban": "HR4924020061101334527",
    "offer_recipient": "LOOP IN d.o.o.",
    "offer_recipient_street": "Kolodvorska 130",
    "offer_recipient_place": "31315 Karanac",
    "offer_model": "HR00",
    "offer_purpose": "OTHR",
    "offer_desc_tpl": "Ponuda br. {broj}",
}
PAYMENT_METHODS = ["Transakcijski račun", "Gotovina", "Kartica", "Ostalo"]


def ensure(db):
    c = db.con
    c.execute("""CREATE TABLE IF NOT EXISTS products(
        id INTEGER PRIMARY KEY, grp TEXT, name TEXT NOT NULL, descr TEXT, unit TEXT DEFAULT 'kom',
        price REAL DEFAULT 0, vat REAL DEFAULT 25, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0)""")
    c.execute("""CREATE TABLE IF NOT EXISTS offers(
        id INTEGER PRIMARY KEY, no TEXT NOT NULL UNIQUE, year INTEGER, seq INTEGER,
        issue_date TEXT, issue_time TEXT, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        cust_name TEXT, cust_address TEXT, cust_oib TEXT, delivery_date TEXT, delivery_place TEXT,
        payment_desc TEXT, payment_due TEXT, operator TEXT, payment_method TEXT, note TEXT,
        status TEXT DEFAULT 'Izrađena', created TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS offer_lines(
        id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, name TEXT, descr TEXT, unit TEXT,
        qty REAL, price REAL, vat REAL, sort INTEGER)""")
    for k, v in SETTINGS.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    if not db.val("SELECT COUNT(*) FROM products") and not db.val("SELECT value FROM settings WHERE key='offer_seeded'"):
        for n, (g, name, descr, unit, price) in enumerate(PRICE_LIST):
            c.execute("INSERT INTO products(grp,name,descr,unit,price,vat,sort) VALUES(?,?,?,?,?,?,?)",
                      (g, name, descr, unit, price, 25, n))
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('offer_seeded','1')")
    c.commit()


def consts(db):
    ensure(db)
    return {"groups": GROUPS, "payment_methods": PAYMENT_METHODS}


# ------------------------------------------------------------------ cjenik
def products(db, active_only=False):
    ensure(db)
    sql = "SELECT * FROM products" + (" WHERE active=1" if active_only else "")
    rows = db.q(sql)
    order = {g: i for i, g in enumerate(GROUPS)}
    rows.sort(key=lambda r: (order.get(r["grp"], 99), r["grp"] or "", r["sort"] or 0, r["name"]))
    return rows


def save_product(db, data, id=None):
    ensure(db)
    d = {k: data.get(k) for k in ("grp", "name", "descr", "unit", "price", "vat", "active", "recipe_id", "keg_l") if k in data}
    if not (d.get("name") or "").strip() and not id:
        raise ValueError("Upišite naziv proizvoda.")
    if d.get("price") is not None and float(d["price"]) < 0:
        raise ValueError("Cijena ne može biti negativna.")
    if not id:
        d["sort"] = (db.val("SELECT MAX(sort) FROM products") or 0) + 1
    return db._upsert("products", d, id)


def delete_product(db, id):
    ensure(db)
    db.x("DELETE FROM products WHERE id=?", (id,))
    return True


# ------------------------------------------------------------------ ponude
def _parse_no(no):
    m = re.fullmatch(r"\s*(\d+)\s*[-/]\s*(\d{4})\s*", no or "")
    if not m:
        raise ValueError("Broj ponude upišite u obliku redni broj-godina, npr. 32-2026.")
    return int(m.group(1)), int(m.group(2))


def next_no(db, year=None):
    ensure(db)
    year = int(year or dt.date.today().year)
    last = db.val("SELECT MAX(seq) FROM offers WHERE year=?", (year,))
    if last:
        return f"{last + 1}-{year}"
    try:
        first = int(db.get_setting("offer_first_no") or 1)
    except ValueError:
        first = 1
    return f"{max(first, 1)}-{year}"


def offers(db):
    ensure(db)
    rows = db.q("""SELECT o.*, (SELECT COALESCE(SUM(qty*price),0) FROM offer_lines WHERE offer_id=o.id) AS total,
                   (SELECT COUNT(*) FROM offer_lines WHERE offer_id=o.id) AS n_lines
                   FROM offers o ORDER BY o.year DESC, o.seq DESC, o.id DESC""")
    return rows


def offer(db, id):
    ensure(db)
    o = db.one("SELECT * FROM offers WHERE id=?", (id,))
    if not o:
        raise ValueError("Ponuda ne postoji.")
    o["lines"] = db.q("SELECT * FROM offer_lines WHERE offer_id=? ORDER BY sort, id", (id,))
    return o


def new_offer_defaults(db):
    ensure(db)
    now = dt.datetime.now()
    try:
        days = int(db.get_setting("offer_valid_days") or 15)
    except ValueError:
        days = 15
    return {"no": next_no(db), "issue_date": now.date().isoformat(), "issue_time": now.strftime("%H:%M"),
            "payment_due": (now.date() + dt.timedelta(days=days)).isoformat(),
            "valid_until": (now.date() + dt.timedelta(days=days)).isoformat(), "price_mode": "gross",
            "payment_desc": db.get_setting("offer_payment_desc"),
            "payment_method": db.get_setting("offer_payment_method") or PAYMENT_METHODS[0],
            "operator": db.get_setting("offer_last_operator") or db.get_setting("default_operator"), "lines": []}


def operators(db):
    """Operateri za padajući izbornik: zapamćeni operateri ponuda, zaposlenici i operateri iz izdanih ponuda."""
    import json
    ensure(db)
    try:
        saved = json.loads(db.get_setting("offer_operators") or "[]")
    except ValueError:
        saved = []
    names = list(saved) + [r["operator"] for r in db.q("SELECT DISTINCT operator FROM offers WHERE operator<>''")]
    try:
        names += db.employee_names()
    except Exception:  # noqa: BLE001
        pass
    if db.get_setting("default_operator"):
        names.append(db.get_setting("default_operator"))
    out, seen = [], set()
    for n in names:
        n = (n or "").strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return sorted(out, key=str.lower)


def remember_operator(db, name):
    import json
    name = (name or "").strip()
    if not name:
        return operators(db)
    try:
        saved = json.loads(db.get_setting("offer_operators") or "[]")
    except ValueError:
        saved = []
    if name.lower() not in {x.lower() for x in saved}:
        saved.append(name)
        db.set_setting("offer_operators", json.dumps(saved, ensure_ascii=False))
    db.set_setting("offer_last_operator", name)
    return operators(db)


def forget_operator(db, name):
    import json
    try:
        saved = json.loads(db.get_setting("offer_operators") or "[]")
    except ValueError:
        saved = []
    db.set_setting("offer_operators", json.dumps([x for x in saved if x.lower() != (name or "").lower()], ensure_ascii=False))
    return operators(db)


def customer_info(db, customer_id):
    c = db.one("SELECT * FROM customers WHERE id=?", (customer_id,)) or {}
    place = " ".join(x for x in (c.get("postal_code"), c.get("city")) if x)
    addr = ", ".join(x for x in (c.get("address"), place) if x)
    return {"cust_name": c.get("name") or "", "cust_address": addr, "cust_oib": c.get("oib") or ""}


def save_offer(db, data, lines, id=None, save_customer=False):
    """data: zaglavlje ponude; lines: [{product_id, name, descr, unit, qty, price, vat}]."""
    ensure(db)
    d = {k: data.get(k) for k in ("no", "issue_date", "issue_time", "customer_id", "cust_name", "cust_address",
                                  "cust_oib", "delivery_date", "delivery_place", "payment_desc", "payment_due",
                                  "operator", "payment_method", "note", "status", "valid_until", "price_mode")}
    seq, year = _parse_no(d["no"])
    d["no"] = f"{seq}-{year}"
    d["seq"], d["year"] = seq, year
    if db.val("SELECT 1 FROM offers WHERE no=? AND id<>?", (d["no"], id or 0)):
        raise ValueError(f"Ponuda broj {d['no']} već postoji.")
    if not (d.get("cust_name") or "").strip():
        raise ValueError("Upišite naziv kupca kojem je ponuda namijenjena.")
    oib = (d.get("cust_oib") or "").strip().upper().removeprefix("HR")
    if oib and not (oib.isdigit() and len(oib) == 11):
        raise ValueError("OIB kupca mora imati točno 11 znamenki.")
    d["cust_oib"] = oib
    if not d.get("issue_date"):
        raise ValueError("Upišite datum izdavanja ponude.")
    clean = []
    for ln in lines or []:
        qty, price = float(ln.get("qty") or 0), float(ln.get("price") or 0)
        if not (ln.get("name") or "").strip():
            continue
        if qty <= 0:
            raise ValueError(f"Količina za '{ln['name']}' mora biti veća od 0.")
        clean.append({"product_id": ln.get("product_id"), "name": ln["name"].strip(), "descr": ln.get("descr") or "",
                      "unit": ln.get("unit") or "kom", "qty": qty, "price": price,
                      "vat": float(ln.get("vat") if ln.get("vat") not in (None, "") else 25)})
    if not clean:
        raise ValueError("Ponuda nema stavki – dodajte barem jedan proizvod.")
    if save_customer and not d.get("customer_id"):
        d["customer_id"] = db.save_customer({"name": d["cust_name"].strip(), "address": d.get("cust_address") or None,
                                             "oib": d["cust_oib"] or None})
    if not id:
        d["created"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        d["status"] = d.get("status") or "Izrađena"
    else:
        d = {k: v for k, v in d.items() if not (k == "status" and v is None)}
    if (d.get("operator") or "").strip():
        d["operator"] = d["operator"].strip()
        remember_operator(db, d["operator"])  # zapamti operatera za padajući izbornik i sljedeću ponudu
    oid = db._upsert("offers", d, id)
    with db.con:
        db.con.execute("DELETE FROM offer_lines WHERE offer_id=?", (oid,))
        for n, ln in enumerate(clean):
            db.con.execute("""INSERT INTO offer_lines(offer_id,product_id,name,descr,unit,qty,price,vat,sort)
                              VALUES(?,?,?,?,?,?,?,?,?)""", (oid, ln["product_id"], ln["name"], ln["descr"],
                                                            ln["unit"], ln["qty"], ln["price"], ln["vat"], n))
    return oid


def delete_offer(db, id):
    ensure(db)
    db.x("DELETE FROM offers WHERE id=?", (id,))
    return True


def copy_offer(db, id):
    """Nova ponuda s istim kupcem i stavkama (novi broj, današnji datum)."""
    o = offer(db, id)
    d = new_offer_defaults(db)
    for k in ("customer_id", "cust_name", "cust_address", "cust_oib", "delivery_place", "payment_desc",
              "payment_method", "note", "price_mode"):
        d[k] = o.get(k)
    return save_offer(db, d, o["lines"])


def totals(lines):
    """(ukupno s PDV-om, {stopa: (osnovica, pdv)}) – cijene u cjeniku uključuju PDV."""
    total, by = 0.0, {}
    for ln in lines:
        amt = round(float(ln["qty"]) * float(ln["price"]), 2)
        total += amt
        r = float(ln.get("vat") or 0)
        base = amt / (1 + r / 100) if r else amt
        b, v = by.get(r, (0.0, 0.0))
        by[r] = (b + base, v + amt - base)
    return round(total, 2), by


# ------------------------------------------------------------------ HUB 3 (2D kod za plaćanje)
HUB3_REF_OK = re.compile(r"^[0-9A-Za-zČčĆćĐđŠšŽžQqWwXxYy ,.:\-+?'/()]*$")


def iban_ok(iban):
    s = re.sub(r"\s+", "", iban or "").upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", s):
        return False
    r = s[4:] + s[:4]
    return int("".join(str(int(c, 36)) for c in r)) % 97 == 1


def _cut(t, n):
    return " ".join(str(t or "").split())[:n]


def _split_address(addr):
    """'Glavna 5, 31300 Beli Manastir' -> ('Glavna 5', '31300 Beli Manastir')."""
    a = " ".join(str(addr or "").split())
    if "," in a:
        st, pl = a.rsplit(",", 1)
        return st.strip(), pl.strip()
    m = re.match(r"^(.*?)(\d{5}\s+.+)$", a)
    return (m.group(1).strip(), m.group(2).strip()) if m else (a, "")


def hub3_data(db, o, total):
    """Podaci za HUB 3 2D kod (HUB3A, PDF417): 14 polja, svako završava znakom LF, UTF-8."""
    g = db.get_setting
    iban = re.sub(r"\s+", "", g("offer_iban") or "").upper()
    if not iban_ok(iban):
        raise ValueError("IBAN primatelja u Postavkama → Ponude nije ispravan.")
    model = (g("offer_model") or "HR00").strip().upper()
    ref = _cut(o["no"], 22)
    if not HUB3_REF_OK.match(ref):
        ref = re.sub(r"[^0-9A-Za-z\-]", "-", ref)
    tpl = g("offer_desc_tpl") or "Ponuda br. {broj}"
    desc = _cut(tpl.replace("{broj}", o["no"]).replace("{kupac}", o.get("cust_name") or ""), 35)
    st, pl = _split_address(o.get("cust_address"))
    fields = ["HRVHUB30", "EUR", f"{int(round(total * 100)):015d}",
              _cut(o.get("cust_name"), 30), _cut(st, 27), _cut(pl, 27),
              _cut(g("offer_recipient"), 25), _cut(g("offer_recipient_street"), 25), _cut(g("offer_recipient_place"), 27),
              iban, model, ref, _cut((g("offer_purpose") or "").upper(), 4), desc]
    return {"text": "".join(f + "\n" for f in fields), "iban": iban, "model": model, "ref": ref, "desc": desc,
            "recipient": _cut(g("offer_recipient"), 25), "amount": total}


def hub3_flowable(data, width_mm=58):
    """PDF417 (stupaca 9, razina ispravljanja 4, omjer 3:1) kao vektorski crtež za reportlab."""
    from pdf417gen import encode, render_image
    from reportlab.graphics.shapes import Drawing, Rect
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    codes = encode(data["text"], columns=9, security_level=4, encoding="utf-8")
    img = render_image(codes, scale=1, ratio=1, padding=0).convert("1")
    w, h = img.size
    mod = width_mm * mm / (w + 4)          # tihi zona 2 modula sa svake strane
    rh = mod * 3
    d = Drawing((w + 4) * mod, (h + 4) * rh)
    px = img.load()
    for y in range(h):
        x = 0
        while x < w:
            if px[x, y] == 0:
                x0 = x
                while x < w and px[x, y] == 0:
                    x += 1
                d.add(Rect((x0 + 2) * mod, (h - y + 1) * rh, (x - x0) * mod, rh, fillColor=colors.black,
                           strokeColor=None, strokeWidth=0))
            else:
                x += 1
    return d


# ------------------------------------------------------------------ PDF
def _d(iso):
    if not iso:
        return ""
    s = str(iso)[:10].split("-")
    return f"{s[2]}.{s[1]}.{s[0]}." if len(s) == 3 else str(iso)


def _m(x, dec=2):
    s = f"{x:,.{dec}f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return s


def _q(x):
    s = f"{float(x):.3f}".rstrip("0").rstrip(".")
    return s.replace(".", ",")


def offer_pdf(db, id, fmt="PDF", app=None):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Table, TableStyle, Spacer,
                                    KeepTogether)
    from reportlab.lib.utils import ImageReader
    from docgen import _register_fonts
    from xml.sax.saxutils import escape

    o = offer(db, id)
    body, bold, _ = _register_fonts()
    g = db.get_setting
    W, H = A4
    lm = rm = 16 * mm
    accent = colors.HexColor("#1D1D1F")
    grey = colors.HexColor("#6B7280")
    line = colors.HexColor("#D5D8DE")
    st = lambda size=9.5, b=False, col=colors.black, align=0, lead=None: ParagraphStyle(  # noqa: E731
        "s", fontName=bold if b else body, fontSize=size, leading=lead or size * 1.3, textColor=col, alignment=align)
    P = lambda t, *a, **k: Paragraph(escape(str(t or "")).replace("\n", "<br/>"), st(*a, **k))  # noqa: E731

    logo = LOGO if os.path.exists(LOGO) else (app.logo_path() if app and app.logo_path() else None)
    footer = g("offer_footer") or SETTINGS["offer_footer"]
    h1 = g("offer_header1") or SETTINGS["offer_header1"]
    h2 = g("offer_header2") or SETTINGS["offer_header2"]

    def page(c, doc_):
        c.saveState()
        top = H - 14 * mm
        if logo:
            try:
                ir = ImageReader(logo)
                iw, ih = ir.getSize()
                lh = 24 * mm
                lw = min(62 * mm, lh * iw / ih)
                lh = lw * ih / iw
                c.drawImage(ir, lm, top - lh, lw, lh, mask="auto")
            except Exception:  # noqa: BLE001
                pass
        # zaglavlje desno: pivnica i tvrtka
        x = W - rm
        y = top - 3.5 * mm
        for blk in (h1, h2):
            for i, ln in enumerate(blk.split("\n")):
                c.setFont(bold if i == 0 else body, 9.5 if i == 0 else 8.5)
                c.setFillColor(colors.black if i == 0 else grey)
                c.drawRightString(x, y, ln)
                y -= 4.2 * mm
            y -= 1.6 * mm
        c.setStrokeColor(line)
        c.setLineWidth(0.8)
        c.line(lm, top - 30 * mm, W - rm, top - 30 * mm)
        # podnožje
        fp = Paragraph(escape(footer), st(7, col=grey, align=1, lead=9))
        fw, fh = fp.wrap(W - lm - rm, 30 * mm)
        c.line(lm, 12 * mm + fh + 2.5 * mm, W - rm, 12 * mm + fh + 2.5 * mm)
        fp.drawOn(c, lm, 12 * mm)
        c.setFont(body, 7.5)
        c.setFillColor(grey)
        c.drawRightString(W - rm, 7 * mm, f"Ponuda {o['no']} · stranica {doc_.page}")
        c.restoreState()

    fp = Paragraph(escape(footer), st(7, lead=9))
    _, fh = fp.wrap(W - lm - rm, 30 * mm)
    out_dir = os.path.join(OUT, "ponude")
    os.makedirs(out_dir, exist_ok=True)
    safe = re.sub(r"[^\w\-]+", "_", o["cust_name"] or "")[:40].strip("_")
    path = os.path.join(out_dir, f"Ponuda_{o['no']}" + (f"_{safe}" if safe else "") + ".pdf")
    doc = BaseDocTemplate(path, pagesize=A4, leftMargin=lm, rightMargin=rm, topMargin=48 * mm,
                          bottomMargin=16 * mm + fh, title=f"Ponuda {o['no']}", author=h2.split("\n")[0])
    frame = Frame(lm, doc.bottomMargin, W - lm - rm, H - doc.topMargin - doc.bottomMargin, id="f",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=page)])
    cw = W - lm - rm
    story = [P(f"PONUDA br. {o['no']}", 17, True, accent), Spacer(1, 5 * mm)]

    # kupac | podaci ponude
    cust = [P("PONUDA ZA", 8, True, grey), P(o["cust_name"], 11, True)]
    if o.get("cust_address"):
        cust.append(P(o["cust_address"], 9.5))
    if o.get("cust_oib"):
        cust.append(P(f"OIB: {o['cust_oib']}", 9.5))
    info = [("Datum i vrijeme izdavanja", f"{_d(o['issue_date'])} {o.get('issue_time') or ''}".strip()),
            ("Datum isporuke", _d(o.get("delivery_date"))), ("Mjesto isporuke", o.get("delivery_place") or ""),
            ("Ponuda vrijedi do", _d(o.get("valid_until"))),
            ("Rok plaćanja", _d(o.get("payment_due"))), ("Način plaćanja", o.get("payment_method") or ""),
            ("Operater", o.get("operator") or "")]
    inf = Table([[P(a, 8.5, col=grey), P(b, 9.5, True)] for a, b in info if b],
                colWidths=[0.46 * (cw * 0.5), 0.54 * (cw * 0.5)])
    inf.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                             ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 1)]))
    box = Table([[cust, inf]], colWidths=[cw * 0.5, cw * 0.5])
    box.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOX", (0, 0), (0, 0), 0.8, line),
                             ("LEFTPADDING", (0, 0), (0, 0), 8), ("RIGHTPADDING", (0, 0), (0, 0), 8),
                             ("TOPPADDING", (0, 0), (0, 0), 6), ("BOTTOMPADDING", (0, 0), (0, 0), 8),
                             ("LEFTPADDING", (1, 0), (1, 0), 14)]))
    story += [box, Spacer(1, 7 * mm)]

    # stavke (veleprodaja: cijene bez PDV-a; u bazi su uvijek cijene s PDV-om)
    net = (o.get("price_mode") or "gross") == "net"

    def up(ln):
        r = float(ln.get("vat") or 0)
        return float(ln["price"]) / (1 + r / 100) if net and r else float(ln["price"])
    head = [P(t, 8.5, True, colors.white, al) for t, al in
            (("R.br.", 1), ("Proizvod / usluga", 0), ("Jed.", 1), ("Količina", 2),
             ("Cijena € bez PDV" if net else "Cijena €", 2), ("Iznos € bez PDV" if net else "Iznos €", 2))]
    rows = [head]
    for n, ln in enumerate(o["lines"], 1):
        name = [P(ln["name"], 9.5, True)]
        if ln.get("descr"):
            name.append(P(ln["descr"], 8, col=grey))
        rows.append([P(f"{n}.", 9.5, align=1), name, P(ln["unit"], 9.5, align=1), P(_q(ln["qty"]), 9.5, align=2),
                     P(_m(up(ln)), 9.5, align=2), P(_m(ln["qty"] * up(ln)), 9.5, True, align=2)])
    tw = [0.07, 0.44, 0.1, 0.11, 0.13, 0.15]
    t = Table(rows, colWidths=[w * cw for w in tw], repeatRows=1)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), accent), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                           ("LINEBELOW", (0, 1), (-1, -1), 0.5, line), ("TOPPADDING", (0, 0), (-1, -1), 4),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(t)

    total, by = totals(o["lines"])
    trows = []
    for r in sorted(by):
        base, vat = by[r]
        if r:
            trows.append([P(f"Osnovica (PDV {_q(r)} %)", 9, col=grey, align=2), P(_m(base), 9, align=2)])
            trows.append([P(f"PDV {_q(r)} %", 9, col=grey, align=2), P(_m(vat), 9, align=2)])
    trows.append([P("UKUPNO ZA PLATITI (EUR)", 11, True, align=2), P(_m(total) + " €", 12, True, align=2)])
    tt = Table(trows, colWidths=[cw * 0.72, cw * 0.28])
    tt.setStyle(TableStyle([("LINEABOVE", (0, -1), (-1, -1), 1.2, accent), ("TOPPADDING", (0, 0), (-1, -1), 2),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, -1), (-1, -1), 6),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
    story += [Spacer(1, 3 * mm), KeepTogether(tt), Spacer(1, 6 * mm)]

    if (g("offer_hub3") or "1") == "1" and total > 0:
        try:
            hd = hub3_data(db, o, total)
            bc = hub3_flowable(hd)
            info_rows = [("Primatelj", hd["recipient"]), ("IBAN", hd["iban"]), ("Iznos", _m(total) + " €"),
                         ("Model i poziv na broj", f"{hd['model']} {hd['ref']}"), ("Opis plaćanja", hd["desc"])]
            it = Table([[P(a, 8, col=grey), P(b, 9, True)] for a, b in info_rows], colWidths=[cw * 0.2, cw * 0.38])
            it.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 1), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
            right = [P("Plaćanje skeniranjem 2D koda (HUB 3)", 9.5, True), Spacer(1, 1.5 * mm), it,
                     Spacer(1, 1.5 * mm), P("Skenirajte kod u mobilnoj aplikaciji banke (Skeniraj i plati / "
                                            "Plaćanje uplatnicom) – podaci se upišu sami.", 7.5, col=grey)]
            box = Table([[bc, right]], colWidths=[62 * mm, cw - 62 * mm])
            box.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BOX", (0, 0), (-1, -1), 0.8, line),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 6),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
            story += [KeepTogether(box), Spacer(1, 5 * mm)]
        except ValueError as e:
            story += [P(f"2D kod za plaćanje nije izrađen: {e}", 8.5, col=colors.HexColor("#B42318")), Spacer(1, 3 * mm)]
    if o.get("payment_desc"):
        story += [P("Opis plaćanja", 8.5, True, grey), P(o["payment_desc"], 9.5), Spacer(1, 3 * mm)]
    if o.get("note"):
        story += [P("Napomena", 8.5, True, grey), P(o["note"], 9.5), Spacer(1, 3 * mm)]
    story.append(P("Cijene su izražene u eurima (€) bez PDV-a; PDV je obračunat u zbroju." if net else
                   "Sve cijene su izražene u eurima (€) i uključuju PDV.", 8.5, col=grey))
    sign = Table([[P("Ponudu izradio:", 8.5, col=grey), ""], [P(o.get("operator") or "", 9.5, True), ""]],
                 colWidths=[cw * 0.45, cw * 0.55])
    sign.setStyle(TableStyle([("LINEBELOW", (0, 1), (0, 1), 0.6, line), ("TOPPADDING", (0, 0), (-1, -1), 1),
                              ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [Spacer(1, 12 * mm), KeepTogether(sign)]
    doc.build(story)
    return path
