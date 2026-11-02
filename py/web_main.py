"""Pomoćne funkcije za web stranice skladišta i nabave (bez tkintera).

Prenesene iz desktop UI koda (app.py) – samo dio koji radi s podacima/dokumentima.
Datoteke se spremaju u /out/... i funkcije vraćaju putanju (JS: this.app.doc / this.app.py.call).
"""
import os
import html as _html

OUT = "/out"


# ------------------------------------------------------------------ formatiranje (kao ui.py)
def _d2ui(iso):
    if not iso:
        return ""
    try:
        y, m, d = str(iso)[:10].split("-")
        return f"{d}.{m}.{y}."
    except ValueError:
        return str(iso)


def _fq(x, dec=3):
    if x is None or x == "":
        return ""
    s = f"{float(x):,.{dec}f}"
    if dec:
        s = s.rstrip("0").rstrip(".")
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def _money(x):
    return f"{float(x or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " €"


def _e(v):
    return _html.escape(str(v if v is not None else ""))


def _safe(name):
    return "".join(ch if ch.isalnum() or ch in "-_ ." else "_" for ch in str(name)).strip() or "dokument"


# ------------------------------------------------------------------ Narudžbenica – ispis (app.py POPage.print_po)
def po_html(db, po_id):
    """HTML narudžbenice s gumbom 'Ispis / Spremi PDF' (isto kao desktop). Vraća putanju."""
    p, lines = db.po(po_id), db.po_lines(po_id)
    if not p:
        raise ValueError("Narudžbenica ne postoji.")
    brewery = db.get_setting("brewery_name")
    trs = "".join(f"<tr><td>{n}</td><td>{_e(l['code'] or '')}</td><td>{_e(l['name'])}</td><td class=r>{_fq(l['qty'])}</td>"
                  f"<td>{_e(l['unit'])}</td><td class=r>{_fq(l['unit_price'], 4)}</td>"
                  f"<td class=r>{_money(l['qty'] * l['unit_price'])}</td></tr>" for n, l in enumerate(lines, 1))
    total = sum(l["qty"] * l["unit_price"] for l in lines)
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{_e(p['po_no'])}</title><style>
    body{{font-family:Segoe UI,Arial,sans-serif;margin:40px;color:#222}} h1{{margin:0;font-size:26px}}
    .muted{{color:#777}} table{{border-collapse:collapse;width:100%;margin-top:24px}}
    th,td{{border-bottom:1px solid #ddd;padding:8px;text-align:left}} th{{background:#f4f1ea}} .r{{text-align:right}}
    .box{{display:flex;justify-content:space-between;margin-top:24px}} .tot{{font-size:18px;font-weight:bold;text-align:right;margin-top:16px}}
    @media print{{button{{display:none}}}}</style></head><body>
    <button onclick="window.print()" style="float:right;padding:8px 16px">Ispis / Spremi PDF</button>
    <div class=muted>{_e(brewery)}</div><h1>NARUDŽBENICA {_e(p['po_no'])}</h1>
    <div class=box><div><b>Dobavljač:</b><br>{_e(p['supplier_name'] or '')}<br>{_e(p['address'] or '')}<br>
    OIB: {_e(p['oib'] or '—')}<br>{_e(p['contact'] or '')} {_e(p['email'] or '')} {_e(p['phone'] or '')}</div>
    <div><b>Datum:</b> {_d2ui(p['order_date'])}<br><b>Željena isporuka:</b> {_d2ui(p['expected_date']) or '—'}</div></div>
    <table><tr><th>#</th><th>Šifra</th><th>Artikl</th><th class=r>Količina</th><th>Jed.</th><th class=r>Cijena</th><th class=r>Iznos</th></tr>
    {trs}</table><div class=tot>Ukupno (bez PDV-a): {_money(total)}</div>
    <p>Napomena: {_e(p['note'] or '')}</p><p class=muted>Molimo navesti LOT brojeve i rokove trajanja na otpremnici.</p>
    <br><br><p>_________________________<br>Potpis</p></body></html>"""
    folder = os.path.join(OUT, "ispisi")
    os.makedirs(folder, exist_ok=True)
    f = os.path.join(folder, f"{_safe(p['po_no'])}.html")
    with open(f, "w", encoding="utf-8") as fh:
        fh.write(html)
    return f


def po_doc(db, po_id, fmt="PDF", app=None):
    """Narudžbenica kao PDF ili Word (docgen). Vraća putanju."""
    from docgen import Doc, render
    p, lines = db.po(po_id), db.po_lines(po_id)
    if not p:
        raise ValueError("Narudžbenica ne postoji.")
    company = db.get_setting("company") or db.get_setting("brewery_name")
    logo = app.logo_path() if app is not None else None
    doc = Doc({"code": p["po_no"], "title": "NARUDŽBENICA", "version": "1", "vdate": _d2ui(p["order_date"])},
              company, logo, False, filename=f"Narudzbenica {p['po_no']}")
    doc.add("title", f"NARUDŽBENICA {p['po_no']}")
    doc.add("kv", [("Dobavljač", p["supplier_name"] or ""), ("Adresa", p["address"] or ""),
                   ("OIB", p["oib"] or "—"),
                   ("Kontakt", " ".join(x for x in (p["contact"], p["email"], p["phone"]) if x)),
                   ("Datum", _d2ui(p["order_date"])), ("Željena isporuka", _d2ui(p["expected_date"]) or "—")])
    doc.add("space", 3)
    rows = [[str(n), l["code"] or "", l["name"], _fq(l["qty"]), l["unit"], _fq(l["unit_price"], 4),
             _money(l["qty"] * l["unit_price"])] for n, l in enumerate(lines, 1)]
    doc.add("table", ["#", "Šifra", "Artikl", "Količina", "Jed.", "Cijena", "Iznos"], rows,
            [0.05, 0.12, 0.38, 0.12, 0.07, 0.12, 0.14], {"align": {3: "R", 5: "R", 6: "R"}})
    total = sum(l["qty"] * l["unit_price"] for l in lines)
    doc.add("space", 2)
    doc.add("pb", f"Ukupno (bez PDV-a): {_money(total)}")
    doc.add("p", f"Napomena: {p['note'] or ''}")
    doc.add("note", "Molimo navesti LOT brojeve i rokove trajanja na otpremnici.")
    doc.add("sign", [("Potpis", "")])
    return render(doc, os.path.join(OUT, "narudzbenice"), fmt)
