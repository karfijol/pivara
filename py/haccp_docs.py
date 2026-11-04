"""Izrada HACCP dokumenata za ispis (PDF / Word) iz podataka u bazi – prema predlošcima pivovare."""
import os

from docgen import Doc, render
from haccp_db import (CIP_TYPES, CIP_EQUIPMENT, RECEIPT_DOCS, RECEIPT_CHECKS_ALL, RECEIPT_CHECKS_RAW,
                      RECEIPT_CHECKS_PACK, DOC_NAMES)

BLANK_ROWS = 3  # prazni retci na kraju evidencija za ručni upis


def d2(iso):
    if not iso:
        return ""
    y, m, d = str(iso)[:10].split("-")
    return f"{d}.{m}.{y}."


def n(x, dec=3, strip=True):
    if x is None or x == "":
        return ""
    s = f"{float(x):.{dec}f}"
    if strip and "." in s:
        s = s.rstrip("0").rstrip(".")
    return s.replace(".", ",")


def period_txt(d_from, d_to):
    if d_from and d_to:
        return f"Razdoblje: {d2(d_from)} – {d2(d_to)}"
    if d_from:
        return f"Razdoblje: od {d2(d_from)}"
    if d_to:
        return f"Razdoblje: do {d2(d_to)}"
    return "Razdoblje: cijela povijest (svi zapisi)"


def new_doc(db, key, logo, landscape, name=""):
    """Naziv datoteke = šifra i naslov dokumenta (kao u zaglavlju) + što je u njemu (razdoblje, datum zapisa…).
    Isti dokument uvijek dobiva isti naziv, pa nova izrada prepiše staru datoteku u istoj mapi."""
    m = dict(db.doc_meta(key))
    m["vdate"] = d2(m.get("vdate")) if m.get("vdate") and "-" in str(m.get("vdate")) else (m.get("vdate") or "")
    title = " ".join(str(m.get("title") or "").split())
    name = " ".join(str(name or "").split())
    return Doc(m, db.get_setting("company") or db.get_setting("brewery_name"), logo, landscape,
               f"{m['code']} {title}" + (f" – {name}" if name else ""))


def meta_line(db, doc, extra=None):
    items = [("Tvrtka", doc.company), ("Verzija", doc.meta["version"]), ("Datum", doc.meta["vdate"]),
             ("Odobrila", db.get_setting("approved_by"))]
    doc.add("meta", items + (extra or []))


def blanks(cols, k=BLANK_ROWS):
    return [[""] * cols for _ in range(k)]


def out_dir(base, key):
    return os.path.join(base, "HACCP", DOC_NAMES[key])


def _pname(d_from, d_to):
    """Dio naziva datoteke za razdoblje: prazno = cijela povijest."""
    if d_from and d_to:
        return d2(d_from) if d_from == d_to else f"{d2(d_from)}–{d2(d_to)}"
    if d_from:
        return f"od {d2(d_from)}"
    if d_to:
        return f"do {d2(d_to)}"
    return ""


# ------------------------------------------------------------------ evidencije (tablice za razdoblje)
def doc_ferm(db, d_from, d_to, logo):
    doc = new_doc(db, "ferm", logo, True, _pname(d_from, d_to))
    meta_line(db, doc)
    doc.add("note", period_txt(d_from, d_to))
    rows = []
    for b in db.brewed_batches(d_from, d_to, desc=False):
        rows.append([b["batch_no"], (b["tank"] or "").replace("Fermentor ", ""), d2(b.get("ferm_start") or b["brew_date"]),
                     n(b.get("ferm_temp"), 1), d2(b.get("ferm_end")), n(b.get("fg_sg"), 3, False), n(b.get("abv"), 1),
                     b.get("ferm_by") or ""])
    doc.add("table", ["LOT piva", "Tank br.", "Datum početka fermentacije", "Temperatura (°C)",
                      "Datum završetka fermentacije", "Finalna gustoća", "Količina etanola (%)", "Odgovorna osoba"],
            rows + blanks(8), [0.15, 0.08, 0.14, 0.11, 0.14, 0.11, 0.12, 0.15], {"size": 9})
    doc.add("note", "LOT piva postavljen u evidenciji utroška sirovina.")
    return doc


def _amount(r, cat):
    if r.get("display") and not r["qty"]:
        return r["display"]
    q, u = r["qty"], (r["unit"] or "").lower()
    if cat == "Slad":
        return n(q / 1000 if u == "g" else q, 2) if u in ("kg", "g") else f"{n(q)} {r['unit']}"
    if cat in ("Hmelj", "Kvasac"):
        if u == "kg":
            return n(q * 1000, 1)
        if u == "g":
            return n(q, 1)
        return f"{n(q)} {r['unit']}"
    return f"{n(q)} {r['unit']}"


def doc_brew(db, d_from, d_to, logo):
    doc = new_doc(db, "brew", logo, True, _pname(d_from, d_to))
    meta_line(db, doc)
    doc.add("note", period_txt(d_from, d_to))
    head = ["LOT piva", "Datum kuhanja", "Recept / stil", "Slad", "kg", "LOT", "Hmelj", "g", "LOT", "Kvasac", "g",
            "LOT", "Ostali dodaci", "kol.", "LOT", "Vol. sladovine (L)", "OG (g/cm³)", "pH", "Kuhao"]
    rows, merge = [], []
    for b in db.brewed_batches(d_from, d_to, desc=False):
        g = db.batch_consumption_by_cat(b["id"])
        k = max(1, *(len(v) for v in g.values()))
        start = len(rows)
        for i in range(k):
            r = [""] * len(head)
            if i == 0:
                r[0:3] = [b["batch_no"], d2(b["brew_date"]), b["recipe"] or ""]
                r[15:19] = [n(b.get("wort_l") or b["volume_l"], 1), n(b.get("og_sg"), 3, False), n(b.get("ph"), 2),
                            b.get("brewer") or ""]
            for col, cat in ((3, "Slad"), (6, "Hmelj"), (9, "Kvasac"), (12, "Ostalo")):
                if i < len(g[cat]):
                    c = g[cat][i]
                    r[col:col + 3] = [c["name"], _amount(c, cat), c["lot_no"]]
            rows.append(r)
        merge.append((start, len(rows) - 1))
    w = [0.075, 0.062, 0.055, 0.07, 0.03, 0.07, 0.06, 0.035, 0.07, 0.065, 0.03, 0.06, 0.06, 0.035, 0.06,
         0.042, 0.035, 0.026, 0.055]
    doc.add("table", head, rows + blanks(len(head)), w,
            {"size": 6.5, "merge": merge, "merge_cols": [0, 1, 2, 15, 16, 17, 18],
             "align": {4: "R", 7: "R", 10: "R", 15: "R", 16: "R", 17: "R"}})
    doc.add("note", "Slad u kg, hmelj i kvasac u g (ako se vode u kg/g). LOT piva: DDMMGGGG + oznaka piva + redni broj.")
    return doc


def doc_pack(db, d_from, d_to, logo):
    doc = new_doc(db, "pack", logo, True, _pname(d_from, d_to))
    meta_line(db, doc)
    doc.add("note", period_txt(d_from, d_to))
    rows = []
    for p in db.packaging_rows(d_from, d_to):
        shelf = (f"{p['shelf_months']} mjeseci" if p.get("shelf_months") else "") + \
                (f" (do {d2(p['best_before'])})" if p.get("best_before") else "")
        rows.append([d2(p["date"]), p.get("batch_no") or p.get("lot") or "", p.get("pack_type") or "",
                     p.get("pack_lot") or "", str(p.get("units") or ""), n(p.get("unit_l"), 2),
                     n((p.get("total_l") or 0) / 100, 2), shelf.strip(), p.get("operator") or ""])
    doc.add("table", ["Datum pakiranja", "LOT piva", "Tip ambalaže", "LOT ambalaže", "Kom.", "Pakirana količina (L/kom)",
                      "Ukupna količina (hL)", "Rok trajanja", "Operater"],
            rows + blanks(9), [0.1, 0.12, 0.08, 0.17, 0.05, 0.1, 0.1, 0.15, 0.13], {"size": 9, "align": {4: "R", 5: "R", 6: "R"}})
    doc.add("note", "LOT piva postavljen u evidenciji utroška sirovina.")
    return doc


def doc_ccp(db, d_from, d_to, logo):
    doc = new_doc(db, "ccp", logo, True, _pname(d_from, d_to))
    meta_line(db, doc)
    doc.add("note", period_txt(d_from, d_to))
    rows = []
    for c in db.ccp_rows(d_from, d_to):
        rows.append([d2(c["date"]), c.get("batch_no") or c.get("lot") or "", c.get("start_time") or "",
                     c.get("end_time") or "", n(c.get("temp"), 1), str(c.get("minutes") or ""),
                     "DA" if c.get("limit_ok") else "NE", c.get("result") or "", c.get("corrective") or "/",
                     c.get("operator") or ""])
    doc.add("table", ["Datum", "Broj serije / Lota", "Vrijeme početka kuhanja", "Vrijeme završetka kuhanja",
                      "Temperatura kuhanja (°C)", "Vrijeme kuhanja (min)", "Granica ≥ 100 °C", "Rezultat (OK/NE)",
                      "Korektivna radnja (ako postoji)", "Potpis operatera / Napomena"],
            rows + blanks(10, 2), [0.08, 0.11, 0.08, 0.08, 0.09, 0.08, 0.08, 0.08, 0.17, 0.15], {"size": 8.5})
    doc.add("pb", "CCP1")
    doc.add("p", "Ukoliko je temperatura tijekom kuhanja izmjerena kao manja od dozvoljene (100 °C) – produžava se vrijeme kuhanja.")
    doc.add("pb", "Učestalost kontrole")
    doc.add("p", "Evidentira se svaka serija koja se kuha (jedan zapis po lotu ili ukoliko je potrebno više unosa). "
                 "Operater upisuje parametre kuhanja nakon završetka ciklusa.")
    doc.add("pb", "Korektivna radnja")
    doc.add("p", "Ako je izmjerena temperatura tijekom kuhanja < 100 °C, seriju duže kuhati do dobivanja željenog "
                 "rezultata, obavijestiti voditelja HACCP tima. Rezultat i radnju zabilježiti u stupcu Korektivna radnja.")
    doc.add("pb", "Verifikacija")
    doc.add("p", "Mjesečna verifikacija voditelja s umjerenim termometrom.")
    doc.add("sign", [("Verificirao (voditelj)", db.get_setting("haccp_lead")), ("Datum verifikacije", "")])
    return doc


def _equipment_doc(db, key, eq, kind, d_from, d_to, logo):
    parts = ([] if key == "mill" else [eq["name"]]) + ([_pname(d_from, d_to)] if _pname(d_from, d_to) else [])
    doc = new_doc(db, key, logo, False, " ".join(parts))
    doc.add("title", doc.meta["title"])
    meta_line(db, doc, [("Šifra zapisa", doc.meta["code"].replace("HACCP-", ""))])
    doc.add("note", period_txt(d_from, d_to))
    doc.add("table", ["Podatak", "Vrijednost"], [
        ["Naziv opreme", eq["name"]], ["Broj/kod uređaja", eq.get("code") or ""],
        ["Oznaka i tip uređaja", eq.get("model") or ""], ["Proizvođač", eq.get("manufacturer") or ""],
        ["Datum proizvodnje", d2(eq.get("mfg_date"))]] +
        ([["Kapacitet", f"{n(eq['capacity_l'])} L"]] if eq.get("capacity_l") else []), [0.35, 0.65], {"size": 9.5})
    doc.add("space", 4)
    checks = db.eq_checks(eq["id"], kind, d_from, d_to)
    rows = [[d2(c["date"]), c.get("note") or "", c.get("operator") or "", c.get("batch_no") or ""] for c in checks]
    label = "Datum pregleda" if kind == "kontrola" else "Datum održavanja"
    doc.add("table", [label, "Napomena", "Operater", "Šarža"], rows + blanks(4, 5), [0.18, 0.5, 0.18, 0.14], {"size": 9.5})
    doc.add("h", "ODOBRENJE")
    last = checks[-1] if checks else {}
    doc.add("sign", [("Operater (potpis)", last.get("operator") or db.get_setting("default_operator")),
                     ("Voditelj proizvodnje (potpis)", db.get_setting("prod_lead")),
                     ("Datum pregleda", d2(last.get("date")))])
    return doc


def doc_mill(db, d_from, d_to, logo):
    m = db.mill()
    if not m:
        raise ValueError("Nije upisan mlin u opremi (kategorija 'Mlin').")
    return _equipment_doc(db, "mill", m, "kontrola", d_from, d_to, logo)


def doc_maint(db, equipment_id, d_from, d_to, logo):
    eq = db.one("SELECT * FROM equipment WHERE id=?", (equipment_id,))
    return _equipment_doc(db, "maint", eq, "odrzavanje", d_from, d_to, logo)


# ------------------------------------------------------------------ zapisnici (jedan zapis = jedan dokument)
def doc_receipt(db, rec_id, logo):
    r = db.record("receipts", rec_id)
    doc = new_doc(db, "receipt", logo, False, f"{d2(r.get('date'))} {r.get('material') or ''} LOT {r.get('lot_no') or '-'} (#{rec_id})")
    doc.add("title", doc.meta["title"])
    meta_line(db, doc)
    doc.add("h", "1. Osnovni podaci")
    doc.add("kv", [("Datum prijema", d2(r.get("date"))), ("Otpremnica/račun", r.get("doc_no") or ""),
                   ("Dobavljač", r.get("supplier") or ""),
                   ("Naziv materijala / opis", f"{r.get('material') or ''} ({(r.get('mat_type') or '').lower()})"),
                   ("Količina", r.get("quantity") or ""), ("LOT dobavljača", r.get("lot_no") or "")])
    doc.add("note", "Shema internog LOT-a kad dobavljač ne označava LOT: INT-GGMMDD-nn.")
    docs = r.get("docs") or []
    doc.add("h", "2. Dokumentacija dobavljača")
    doc.add("checks", [(d, d in docs) for d in RECEIPT_DOCS] +
            [(f"Ostalo: {r.get('docs_other') or '__________________'}", bool(r.get("docs_other")))], 2)
    checks = r.get("checks") or {}
    doc.add("h", "3. Vizualna i tehnička kontrola")

    def tbl(title, items, applies=True):
        doc.add("pb", title)
        rows = []
        for it in items:
            v = checks.get(it, "") if applies else ""
            rows.append([it, "☒" if v == "DA" else "☐", "☒" if v == "NE" else "☐", "" if applies else "n/p"])
        doc.add("table", ["Element kontrole", "DA", "NE", "Napomena"], rows, [0.58, 0.08, 0.08, 0.26], {"size": 9})

    raw = (r.get("mat_type") or "Sirovina") == "Sirovina"
    tbl("3.1 Za sve materijale", RECEIPT_CHECKS_ALL)
    tbl("3.2 Dodatni parametri za SIROVINU (slad)", RECEIPT_CHECKS_RAW, raw)
    tbl("3.3 Dodatni parametri za AMBALAŽU", RECEIPT_CHECKS_PACK, not raw)
    doc.add("h", "4. Opis eventualnih odstupanja")
    doc.add("p", r.get("deviations") or "—")
    doc.add("h", "5. Odluka o prijemu")
    ok = (r.get("decision") or "PRIHVAĆENO") == "PRIHVAĆENO"
    doc.add("checks", [("PRIHVAĆENO", ok), ("NEPRIHVATLJIVO – izolirati i obavijestiti QM", not ok)])
    doc.add("note", "Ako neprihvatljivo → ispuniti Zapis o nesukladnosti.")
    doc.add("h", "6. Potpisi")
    doc.add("sign", [("Pregled izvršio", r.get("inspector")), ("QM provjera", r.get("qm")), ("Datum", d2(r.get("qm_date")))])
    return doc


def doc_cip(db, rec_id, logo):
    c = db.record("cips", rec_id)
    ferm = db.val("SELECT name FROM equipment WHERE id=?", (c["fermentor_id"],)) if c.get("fermentor_id") else ""
    doc = new_doc(db, "cip", logo, False, f"{d2(c.get('date'))} {(c.get('start_time') or '').replace(':', '.')} {ferm or c.get('cip_type') or ''} (#{rec_id})")
    doc.add("title", doc.meta["title"])
    meta_line(db, doc, [("Šifra zapisa", doc.meta["code"].replace("HACCP-", ""))])
    doc.add("h", "1. IDENTIFIKACIJA")
    doc.add("p", "Vrsta CIP-a:")
    doc.add("checks", [(t, c.get("cip_type") == t) for t in CIP_TYPES], 2)
    doc.add("p", f"Broj proizvodne šarže (ako je primjenjivo): {c.get('batch_no') or '__________________'}")
    doc.add("h", "2. OPREMA")
    eq = c.get("equipment") or []
    items = []
    for e in CIP_EQUIPMENT:
        label = e
        if e == "Fermentor":
            label = f"Fermentor (oznaka: {ferm or '______'})"
        elif e == "Kegovi":
            label = f"Kegovi ({c.get('keg_codes') or '______'})"
        elif e == "Ostalo":
            label = f"Ostalo: {c.get('other_eq') or '__________________'}"
        items.append((label, e in eq or (e == "Ostalo" and bool(c.get("other_eq")))))
    doc.add("checks", items, 2)
    doc.add("h", "3. PODACI O CIKLUSU")
    doc.add("kv", [("Datum CIP-a", d2(c.get("date"))), ("Vrijeme početka", c.get("start_time") or ""),
                   ("Vrijeme završetka", c.get("end_time") or ""), ("Operater", c.get("operator") or "")])
    doc.add("p", "Oprema ostaje zatvorena do početka proizvodnje:")
    doc.add("checks", [("DA", bool(c.get("closed"))), ("NE", not c.get("closed"))], True)
    doc.add("h", f"4. ALKALNO PRANJE ({c.get('alk_agent') or ''})")
    doc.add("kv", [("Koncentracija (%)", n(c.get("alk_conc"), 2)), ("Temperatura (°C)", n(c.get("alk_temp"), 1)),
                   ("Vrijeme cirkulacije (min)", n(c.get("alk_time"), 0))])
    doc.add("checks", [("Zadovoljava", bool(c.get("alk_ok"))), ("Ne zadovoljava", not c.get("alk_ok"))], True)
    if c.get("alk_corr"):
        doc.add("p", f"Korektivna radnja: {c['alk_corr']}")
    doc.add("h", "5. ISPIRANJE")
    doc.add("checks", [("OPREMA SPREMNA ZA PROIZVODNJU", bool(c.get("rinse_ready"))),
                       ("Potrebno dodatno ispiranje", not c.get("rinse_ready"))])
    if c.get("rinse_note"):
        doc.add("p", f"Dodatno ispiranje: {c['rinse_note']}")
    doc.add("h", f"6. DEZINFEKCIJA ({c.get('dis_agent') or ''})")
    doc.add("kv", [("Koncentracija (%)", n(c.get("dis_conc"), 2)), ("Vrijeme kontakta (min)", n(c.get("dis_time"), 0))])
    doc.add("checks", [("Završeno prema proceduri", bool(c.get("dis_done")))])
    doc.add("h", "7. VERIFIKACIJA")
    doc.add("checks", [("Vizualna kontrola", bool(c.get("ver_visual")))])
    doc.add("kv", [("Datum verifikacije", d2(c.get("ver_date"))), ("Proveo", c.get("ver_by") or ""),
                   ("Rezultat", c.get("ver_result") or "")])
    doc.add("h", "8. KOREKTIVNE RADNJE (ako ih je bilo)")
    doc.add("p", c.get("corrective") or "—")
    doc.add("h", "9. ODOBRENJE")
    doc.add("sign", [("Operater (potpis)", c.get("op_sign") or c.get("operator")),
                     ("Voditelj proizvodnje (potpis)", c.get("manager_sign") or db.get_setting("prod_lead")),
                     ("Datum pregleda", d2(c.get("review_date") or c.get("date")))])
    doc.add("note", "Oprema se ne smije koristiti za proizvodnju bez potvrde spremnosti sukladno ovom zapisniku.")
    return doc


def doc_pest(db, rec_id, logo):
    p = db.record("pests", rec_id)
    doc = new_doc(db, "pest", logo, False, f"{d2(p.get('date'))} {p.get('pest') or ''} (#{rec_id})")
    doc.add("title", doc.meta["title"])
    meta_line(db, doc, [("Šifra zapisa", doc.meta["code"].replace("HACCP-", ""))])
    doc.add("h", "1. PODACI O POJAVI")
    doc.add("kv", [("Datum i vrijeme", f"{d2(p.get('date'))} {p.get('time') or ''}"),
                   ("Vrsta štetnika / količina", p.get("pest") or ""), ("Prostorija", p.get("room") or ""),
                   ("Korektivne mjere", p.get("measures") or "")])
    doc.add("h", "2. KOREKTIVNE RADNJE")
    doc.add("kv", [("Korektivne radnje", p.get("corrective") or ""), ("Datum provođenja", d2(p.get("corrective_date")))])
    doc.add("h", "3. VERIFIKACIJA KONTROLE")
    doc.add("checks", [("Vizualna kontrola", bool(p.get("ver_visual")))])
    doc.add("kv", [("Datum verifikacije", d2(p.get("ver_date"))), ("Proveo", p.get("ver_by") or ""),
                   ("Rezultat", p.get("ver_result") or "")])
    doc.add("h", "4. ODOBRENJE")
    doc.add("sign", [("Operater (potpis)", p.get("operator")), ("Voditelj proizvodnje (potpis)", p.get("manager")),
                     ("Datum pregleda", d2(p.get("review_date")))])
    return doc


def doc_training(db, rec_id, logo):
    t = db.record("trainings", rec_id)
    doc = new_doc(db, "training", logo, False, f"{d2(t.get('date'))} {(t.get('topic') or '')[:40]} (#{rec_id})")
    doc.add("title", f"{doc.meta['code'].replace('HACCP-', '')} – {doc.meta['title']}")
    meta_line(db, doc)
    doc.add("kv", [("Tema edukacije", t.get("topic") or ""), ("Cilj edukacije", t.get("goal") or ""),
                   ("Datum i vrijeme", f"{d2(t.get('date'))} {t.get('time') or ''}"),
                   ("Trajanje", f"{n(t.get('duration_h'), 1)} h" if t.get("duration_h") else ""),
                   ("Mjesto održavanja", t.get("place") or ""), ("Predavač / Organizator", t.get("lecturer") or "")])
    doc.add("h", "SADRŽAJ EDUKACIJE (kratki opis)")
    doc.add("p", t.get("content") or "")
    doc.add("h", "REZULTATI PROVJERE ZNANJA (ako primjenjivo)")
    meth = t.get("test_methods") or []
    doc.add("checks", [(x, x in meth) for x in ("Usmeno", "Pismeno", "Praktično")] +
            [(f"Rezultat: {t.get('test_result') or '✔ / ✖'}", bool(t.get("test_result")))], True)
    doc.add("h", "EVIDENCIJA SUDIONIKA")
    parts = t.get("participants") or []
    rows = [[p.get("name", ""), p.get("role", ""), "", p.get("note", "")] for p in parts]
    doc.add("table", ["Ime i prezime", "Funkcija", "Potpis", "Napomena (nova obuka / obnova)"],
            rows + blanks(4, max(2, 6 - len(rows))), [0.28, 0.24, 0.22, 0.26], {"size": 9.5})
    doc.add("note", "Potpisom potvrđujem da sam prisustvovao/la edukaciji i razumijem svoje odgovornosti vezane uz "
                    "sigurnost hrane i kvalitetu proizvoda.")
    doc.add("sign", [("Izradio", t.get("made_by")), ("Pregledao", t.get("reviewed_by")), ("Datum", d2(t.get("made_date")))])
    return doc


PERIOD_DOCS = {"ferm": doc_ferm, "brew": doc_brew, "pack": doc_pack, "ccp": doc_ccp, "mill": doc_mill}
RECORD_DOCS = {"receipt": doc_receipt, "cip": doc_cip, "pest": doc_pest, "training": doc_training}


def make(db, key, base_dir, fmt="PDF", logo=None, d_from=None, d_to=None, rec_id=None, equipment_id=None):
    if key == "maint":
        doc = doc_maint(db, equipment_id, d_from, d_to, logo)
    elif key in PERIOD_DOCS:
        doc = PERIOD_DOCS[key](db, d_from, d_to, logo)
    else:
        doc = RECORD_DOCS[key](db, rec_id, logo)
    return render(doc, out_dir(base_dir, key), fmt)


EXPORT_MODES = {"all": "Cijela povijest", "range": "Razdoblje od–do", "last": "Zadnji unos"}


def _last_date(db, key, equipment_id=None):
    """Datum zadnjeg unosa u evidenciji (za način 'Zadnji unos')."""
    if key in ("brew", "ferm"):
        return db.val("SELECT MAX(brew_date) FROM batches WHERE status<>'Planirano'")
    if key == "pack":
        return db.val("SELECT MAX(date) FROM packaging")
    if key == "ccp":
        return db.val("SELECT MAX(date) FROM ccp_boil")
    if key == "mill":
        m = db.mill()
        return db.val("SELECT MAX(date) FROM eq_checks WHERE equipment_id=? AND kind='kontrola'", (m["id"],)) if m else None
    if key == "maint":
        return db.val("SELECT MAX(date) FROM eq_checks WHERE equipment_id=? AND kind='odrzavanje'", (equipment_id,))
    return None


def make_all(db, target_dir, fmts=("PDF",), logo=None, d_from=None, d_to=None, progress=None, mode=None):
    """Svi HACCP dokumenti u stalnu strukturu mapa: target_dir/HACCP/<evidencija>/<šifra naslov – sadržaj>.
    mode: 'all' = cijela povijest u svakom dokumentu, 'range' = razdoblje od–do, 'last' = samo zadnji unos.
    Isti dokument uvijek ima isti naziv datoteke, pa se kod ponovne izrade prepisuje (nove se dodaju).
    Vraća (mapa, popis datoteka, popis grešaka)."""
    mode = mode or ("range" if (d_from or d_to) else "all")
    if mode != "range":
        d_from = d_to = None
    root = os.path.join(target_dir, "HACCP")
    jobs = []  # (ključ, izrada, dodatak nazivu za 'zadnji unos')

    def period(key, build_fn, eq_id=None, label=""):
        if mode == "last":
            last = _last_date(db, key, eq_id)
            if last:
                jobs.append((key, lambda: build_fn(last, last), f"{label} zadnji unos {d2(last)}".strip()))
        else:
            jobs.append((key, lambda: build_fn(d_from, d_to), None))

    for key in ("brew", "ccp", "ferm", "pack", "mill"):
        if key == "mill" and not db.mill():
            continue
        period(key, lambda a, b, k=key: PERIOD_DOCS[k](db, a, b, logo))
    for e in db.equipment():
        if e["category"] != "Mlin" and db.eq_checks(e["id"], "odrzavanje", d_from, d_to):
            period("maint", lambda a, b, eid=e["id"]: doc_maint(db, eid, a, b, logo), e["id"], e["name"])

    def records(key, rows, build_fn):
        rows = list(rows)
        if mode == "last":
            rows = sorted(rows, key=lambda r: (r.get("date") or "", r["id"]))[-1:]
        for r in rows:
            jobs.append((key, lambda i=r["id"]: build_fn(db, i, logo), None))

    records("receipt", db.receipts(d_from, d_to), doc_receipt)
    records("cip", db.cips(d_from, d_to), doc_cip)
    records("pest", db.pests(d_from, d_to), doc_pest)
    records("training", [t for t in db.trainings() if (not d_from or (t["date"] or "") >= d_from)
                         and (not d_to or (t["date"] or "") <= d_to)], doc_training)
    files, errors = [], []
    total = len(jobs) * len(fmts)
    n = 0
    for key, build, suffix in jobs:
        for fmt in fmts:
            n += 1
            if progress:
                progress(n, total)
            try:
                doc = build()
                if suffix:
                    m = db.doc_meta(key)
                    doc.filename = f"{m['code']} {' '.join(str(m.get('title') or '').split())} – {suffix}"
                files.append(render(doc, os.path.join(root, DOC_NAMES[key]), fmt))
            except Exception as e:  # pragma: no cover
                errors.append(f"{DOC_NAMES[key]}: {e}")
    return root, files, errors


def find_google_drive():
    """Pokuša pronaći mapu Google Drive for desktop (npr. G:\\Moj disk) na Windowsima."""
    cands = []
    for letter in "GHIJKLMNOPQRSTUVWXYZDEF":
        for name in ("Moj disk", "My Drive"):
            cands.append(f"{letter}:\\{name}")
    home = os.path.expanduser("~")
    cands += [os.path.join(home, "Google Drive", "Moj disk"), os.path.join(home, "Google Drive", "My Drive"),
              os.path.join(home, "Google Drive"), os.path.join(home, "My Drive")]
    for c in cands:
        try:
            if os.path.isdir(c):
                return c
        except OSError:
            pass
    return None
