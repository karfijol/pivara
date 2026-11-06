"""Pomoćne funkcije za web stranice proizvodnje (recepture, šarže, kegovi, planer, otpremnice, trošarine,
sljedivost, naljepnice). Izrada dokumenata premještena iz extras_ui.py / app.py – bez tkintera.
Funkcije koje izrađuju dokument vraćaju PUTANJU datoteke (JS: await app.doc("web_extras.fn", ...))."""
import os
import datetime as dt

try:
    import webutil  # noqa: F401
except NameError:  # webutil.py koristi 're' bez importa – zaobilazak dok se ne ispravi
    import sys
    import re
    import builtins
    builtins.re = re
    sys.modules.pop("webutil", None)
    import webutil  # noqa: F401

from db import today, BATCH_STATUS, KEG_STATUS, KEG_ACTIONS
from webutil import d2ui, fq, money

OUT = "/out"


# ------------------------------------------------------------------ konstante za JS
def consts():
    import extras_db
    import labels
    return {"BATCH_STATUS": BATCH_STATUS, "KEG_STATUS": KEG_STATUS,
            "KEG_ACTIONS": {k: [list(v[0]), v[1]] for k, v in KEG_ACTIONS.items()},
            "LABEL_COLORS": list(extras_db.LABEL_COLORS), "FLAG_FORMATS": list(labels.FLAG_FORMATS),
            "ABV_CLASSES": [c[2] for c in extras_db.ExtrasMixin.ABV_CLASSES]}


def compress_codes(codes):
    from haccp_db import compress_codes as cc
    return cc(codes)


# ------------------------------------------------------------------ dokumenti (iz extras_ui)
def simple_doc(db, app, title, code, filename, landscape=False):
    from docgen import Doc  # reportlab se učitava tek za ispis
    m = {"code": code, "title": title, "version": "1", "vdate": d2ui(today())}
    return Doc(m, db.get_setting("company") or db.get_setting("brewery_name"), app.logo_path() if app else None,
               landscape, filename)


def _render(doc, folder, fmt):
    from docgen import render
    fmt = (fmt or "PDF").upper()
    if fmt in ("BOTH", "OBOJE"):
        return [render(doc, os.path.join(OUT, folder), "PDF")]
    return render(doc, os.path.join(OUT, folder), fmt)


def print_dn(db, note_id, fmt="PDF", app=None):
    """Otpremnica (extras_ui.SalesPage.print_dn)."""
    i = note_id
    d = db.one("SELECT * FROM delivery_notes WHERE id=?", (i,))
    if not d:
        raise ValueError("Otpremnica ne postoji.")
    c = db.one("SELECT * FROM customers WHERE id=?", (d["customer_id"],)) or {}
    doc = simple_doc(db, app, "OTPREMNICA", d["no"], f"Otpremnica {d['no']}")
    g = db.get_setting
    doc.company = g("dn_company") or doc.company
    doc.add("title", f"OTPREMNICA {d['no']}")
    sup = [g("dn_company") or g("company") or "", g("dn_address") or "", f"OIB: {g('company_oib') or ''}"]
    place = " ".join(x for x in (c.get("postal_code"), c.get("city")) if x)
    addr = ", ".join(x for x in (c.get("address"), place) if x)
    cus = [c.get("name") or d["customer"] or "", addr, f"OIB: {c.get('oib') or ''}"]
    if g("dn_contact") or c.get("phone") or c.get("email"):
        sup.append(g("dn_contact") or "")
        cus.append(" · ".join(x for x in (c.get("phone"), c.get("email")) if x))
    if g("dn_iban"):
        sup.append(f"IBAN: {g('dn_iban')}")
        cus.append("")
    doc.add("table", ["ISPORUČITELJ", "KUPAC"], [[a, b] for a, b in zip(sup, cus)], [0.5, 0.5], {"size": 10})
    doc.add("kv", [("Datum isporuke", d2ui(d["date"])), ("Mjesto isporuke", addr)])
    rows, kegs, litres = [], 0, 0
    for n, ln in enumerate(db.delivery_lines(i), 1):
        rows.append([str(n), ln["beer"] or "", ln["lot"] or "", ln["pack_type"], str(ln["qty"]), fq(ln["unit_l"]),
                     fq(ln["qty"] * ln["unit_l"], 1), ln.get("keg_codes") or ""])
        kegs += ln["qty"] if ln["pack_type"] == "Keg" else 0
        litres += ln["qty"] * ln["unit_l"]
    doc.add("table", ["#", "Pivo", "LOT piva", "Ambalaža", "Kom.", "L/kom", "Ukupno L", "Oznake kegova"], rows,
            [0.05, 0.17, 0.15, 0.13, 0.07, 0.08, 0.1, 0.25], {"size": 9.5, "align": {4: "R", 5: "R", 6: "R"}})
    doc.add("pb", f"Ukupno: {fq(litres, 1)} L" + (f" · kegova {kegs}" if kegs else ""))
    dep = d.get("deposit_per_keg") or 0
    if kegs and dep:
        doc.add("p", f"Povratna ambalaža (kegovi): {kegs} × {money(dep)} = {money(kegs * dep)} depozita.")
    if d.get("note"):
        doc.add("p", f"Napomena: {d['note']}")
    doc.add("sign", [("Izdao", d.get("operator") or ""), ("Preuzeo (ime i potpis)", ""), ("Datum", d2ui(d["date"]))])
    return _render(doc, "otpremnice", fmt)


# ------------------------------------------------------------------ sljedivost i povlačenje
def recall_rows(db, text):
    """Redci tablice sljedivosti (extras_ui.RecallPage.build_rows)."""
    res = db.recall(text)
    rows = []

    def add(lvl, what, detail="", tag=""):
        rows.append({"id": len(rows), "lvl": lvl, "what": what, "detail": detail, "_tag": tag})
    for l in res["lots"]:
        add("Sirovina (LOT)", f"{l['item_name']} · LOT {l['lot_no']}",
            f"primljeno {d2ui(l['received_date'])} · {fq(l['qty_received'])} {l['unit']} · preostalo {fq(l['qty_left'])}", "bold")
    for b in res["batches"]:
        bb = b["batch"]
        add("Šarža", f"{bb['batch_no']} · {bb['recipe']}", f"kuhano {d2ui(bb['brew_date'])} · status {bb['status']}", "bold")
        for c in b["used"]:
            add("   utrošeno", f"{c['name']} LOT {c['lot_no']}", f"{fq(c['qty'])} {c['unit']}")
        for p in b["packaging"]:
            add("   pakirano", f"{d2ui(p['date'])} · {p['pack_type']} {p.get('pack_lot') or ''}",
                f"{p.get('units') or ''} kom · {fq((p.get('total_l') or 0), 1)} L")
        for d in b["deliveries"]:
            add("   isporučeno", f"{d['customer']} · {d['no']}", f"{d2ui(d['date'])} · {d['qty']} × {d['pack_type']} {fq(d['unit_l'])} L "
                + (d.get("keg_codes") or ""), "warn")
        if b["at_customers"]:
            byc = {}
            for k in b["at_customers"]:
                byc.setdefault(k["customer"], []).append(k["code"])
            for cu, codes in byc.items():
                add("   kegovi kod kupca", cu, ", ".join(codes), "bad")
        if b["full"]:
            add("   puni kegovi u pivovari", f"{len(b['full'])} kom", ", ".join(k["code"] for k in b["full"]))
    if (text or "").strip() and not rows:
        add("—", "Ništa nije pronađeno", "Provjerite LOT (dovoljan je i dio broja).")
    return rows


def print_recall(db, text, fmt="PDF", app=None):
    text = (text or "").strip()
    rows = recall_rows(db, text) if text else []
    if not rows:
        raise ValueError("Najprije potražite LOT.")
    doc = simple_doc(db, app, "IZVJEŠĆE O SLJEDIVOSTI / POVLAČENJU", f"SLJ-{today()}",
                     f"Sljedivost {text}", landscape=True)
    doc.add("meta", [("Upit (LOT)", text), ("Datum izvješća", d2ui(today()))])
    doc.add("table", ["Razina", "Što", "Detalj"], [[r["lvl"].strip(), r["what"], r["detail"]] for r in rows],
            [0.18, 0.34, 0.48], {"size": 9.5})
    doc.add("sign", [("Izradio", db.get_setting("haccp_doc_operator") or db.get_setting("default_operator")),
                     ("Voditelj HACCP tima", db.get_setting("haccp_lead"))])
    return _render(doc, "sljedivost", fmt)


# ------------------------------------------------------------------ trošarine
def excise_months(n=18):
    out, d = [], dt.date.today().replace(day=1)
    for _ in range(n):
        out.append([f"{d.month:02d}/{d.year}", d.strftime("%Y-%m")])
        d = (d - dt.timedelta(days=1)).replace(day=1)
    return out


def excise_view(db, period):
    """Podaci za ekran Trošarine (redci, sažetak, prijava, podsjetnik)."""
    from extras_db import ExtrasMixin
    rate = db.excise_rate()
    entries = db.excise_entries(period)
    labels = [c[2] for c in ExtrasMixin.ABV_CLASSES]
    rows = []
    for e in entries:
        abv = e.get("abv")
        ex = round((e["hl"] or 0) * abv * rate, 2) if abv else None
        rows.append({"id": e["id"], "inc": "✓" if e["include"] else "", "date": d2ui(e.get("date")),
                     "lot": e.get("batch_no") or "ručni unos", "name": e.get("trade_name") or "",
                     "hl": fq(e.get("hl"), 3), "abv": f"{abv:.1f}".replace(".", ",") if abv else "NEDOSTAJE",
                     "cls": labels[db.abv_class(abv)] if abv else "", "ex": money(ex) if ex is not None else "",
                     "note": e.get("note") or "",
                     "_tag": ("bad" if e["include"] and not abv else ("" if e["include"] else "muted"))})
    s = db.excise_summary(period)
    cls = "   ".join(f"{labels[c]}: {fq(v['hl'], 3)} hl = {money(v['excise'])}" for c, v in sorted(s["classes"].items()))
    summary = (f"Za prijavu: {fq(s['total_hl'], 3)} hl · TROŠARINA {money(s['total_excise'])} "
               f"(stopa {fq(s['rate'], 2)} €)\n{cls}")
    return {"entries": entries, "rows": rows, "summary": summary, "missing": len(s["missing"]),
            "reported": db.excise_reported(period), "reminder": db.excise_reminder()}


def print_mipi(db, period, app=None):
    import mipi
    s = db.excise_summary(period)
    return mipi.make_mipi_pdf(db, period, s, db.excise_entries(period), os.path.join(OUT, "trosarine"))


# ------------------------------------------------------------------ naljepnice
def _missing(data, opts):
    """Kao labels.check_missing, ali vraća popis (pitanje postavlja JS)."""
    opts = opts or {}
    missing = []
    for k in data:
        need = [("alkohol", k.get("abv"))]
        if not opts.get("blank_lot"):
            need.append(("LOT", k.get("batch_no")))
        if not opts.get("blank_dates"):
            need.append(("datum punjenja", k.get("filled_date")))
        m = [n for n, ok in need if not ok]
        if m:
            missing.append(f"{k.get('code') or k.get('beer') or '?'}: nedostaje {', '.join(m)}")
    return missing


def _keg_data(db, keg_ids, opts):
    import labels
    return labels.apply_blanks([labels.keg_label_data(db, kid) for kid in keg_ids], opts)


def _beer_data(db, beers, copies, size):
    import labels
    data = []
    for r in db.recipes():
        if r["name"] in (beers or []):
            for _ in range(max(1, int(copies or 1))):
                data.append(labels.recipe_label_data(db, r["id"], size))
    return labels.apply_blanks(data, {"blank_lot": True, "blank_keg": True, "blank_dates": True})


def keg_labels_missing(db, keg_ids, opts=None):
    return _missing(_keg_data(db, keg_ids, opts), opts)


def beer_labels_missing(db, beers, copies=1, size=None):
    return _missing(_beer_data(db, beers, copies, size), {"blank_lot": True, "blank_keg": True, "blank_dates": True})


def _labels_pdf(db, app, data, fmt, opts):
    import labels
    fmts = labels.FLAG_FORMATS
    if fmt == fmts[2]:
        return labels.keg_labels_pdf(db, app, [], data=data, opts=opts)
    return labels.keg_flags_pdf(db, app, [], single=fmt == fmts[1], data=data, opts=opts)


def keg_labels(db, keg_ids, fmt, opts=None, app=None):
    """Naljepnice/zastavice za odabrane kegove (app.KegsPage.labels)."""
    opts = opts or {}
    return _labels_pdf(db, app, _keg_data(db, keg_ids, opts), fmt, opts)


def beer_labels(db, beers, copies, size, fmt, app=None):
    """Naljepnice po vrsti piva bez kega (extras_ui.print_beer_labels)."""
    opts = {"blank_lot": True, "blank_keg": True, "blank_dates": True}
    data = _beer_data(db, beers, copies, size)
    if not data:
        raise ValueError("Odaberite barem jedno pivo.")
    return _labels_pdf(db, app, data, fmt, opts)
