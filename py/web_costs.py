"""Cijene sirovina i mjesečni izvještaj za knjigovođu: što je kuhano, koje su sirovine utrošene i po kojoj cijeni.

- Uvoz cijena iz Excel tablice "Matematika piva" (listovi Jecam, Hmelj, Kvasac, Ostalo: račun + količina + cijena
  po artiklu) -> nabavna cijena LOT-ova u programu (i broj računa uz LOT).
- Izvještaj za razdoblje (mjesec): PDF, Word ili Excel.
"""
import os
import re
import datetime as dt
import unicodedata

from webutil import d2ui, fq, money

PRICE_SHEETS = ["Jecam", "Ječam", "Hmelj", "Kvasac", "Ostalo"]

# naziv u Excelu -> naziv artikla u programu (ako se razlikuje)
ALIASES = {
    "pale ale": "Pale Malt", "wheat": "Wheat Malt", "maris otter": "Pale Ale Maris Otter",
    "roasted": "Roasted Barley", "flaked": "Flaked Barley", "carafa": "Carafa Special Type 1",
    "east kent golding": "East Kent Goldings", "cascade us": "Cascade", "s-04": "SafAle S-04",
    "w34/70": "Saflager W34/70", "us-05": "SafAle US-05", "wildbrew philly sour": "Lallemand Wild Brew Philly Sour",
    "protafloc tablete": "Protaloc Tablets", "malina": "Pire malina", "visnja": "Pire višnja", "višnja": "Pire višnja",
    "candy sugar": "Candy Sugar",
}


def _norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9/]+", " ", s).strip()


def ensure(db):
    cols = {r["name"] for r in db.q("PRAGMA table_info(lots)")}
    if "invoice_no" not in cols:
        db.con.execute("ALTER TABLE lots ADD COLUMN invoice_no TEXT")
        db.con.commit()


def match_item(db, name, items=None):
    items = items or db.q("SELECT id, name, category, unit FROM items WHERE COALESCE(active,1)=1")
    n = _norm(name)
    target = ALIASES.get(n) or ALIASES.get(str(name).strip().lower())
    by = {_norm(i["name"]): i for i in items}
    if target and _norm(target) in by:
        return by[_norm(target)]["id"]
    if n in by:
        return by[n]["id"]
    # sadrži / sadržan
    cands = [i for k, i in by.items() if n and (n in k or k in n)]
    if len(cands) == 1:
        return cands[0]["id"]
    toks = set(n.split())
    best, score = None, 0
    for k, i in by.items():
        s = len(toks & set(k.split()))
        if s > score:
            best, score = i, s
    return best["id"] if best and score else None


# ------------------------------------------------------------------ uvoz cijena iz Excela
def read_price_sheets(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    out = []
    for ws in wb.worksheets:
        if _norm(ws.title) not in [_norm(x) for x in PRICE_SHEETS]:
            continue
        hdr = [c.value for c in ws[1]]
        cols = [(i, str(h).strip()) for i, h in enumerate(hdr) if h and i > 0]
        for r in ws.iter_rows(min_row=3, values_only=True):
            inv = r[0]
            if inv is None or str(inv).strip().upper().startswith("UKUPNO"):
                continue
            for i, name in cols:
                q = r[i] if i < len(r) else None
                p = r[i + 1] if i + 1 < len(r) else None
                try:
                    q, p = float(q or 0), float(p or 0)
                except (TypeError, ValueError):
                    continue
                if q > 0 and p > 0:
                    out.append({"sheet": ws.title, "invoice": str(inv).strip(), "name": name, "qty": q, "price": p})
    return out


def price_preview(db, path, mapping=None):
    """Pregled prije uvoza: za svaku stavku računa artikl u programu i LOT-ovi kojima će se upisati cijena."""
    ensure(db)
    rows = read_price_sheets(path)
    items = db.q("SELECT id, name, category, unit FROM items")
    names = {i["id"]: i["name"] for i in items}
    mapping = {k: v for k, v in (mapping or {}).items()}
    for r in rows:
        if r["name"] not in mapping:
            mapping[r["name"]] = match_item(db, r["name"], items)
        r["item_id"] = mapping.get(r["name"])
        r["item"] = names.get(r["item_id"], "")
    lots = db.q("SELECT l.id, l.item_id, l.qty_received, l.received_date, l.unit_price, l.lot_no, l.note FROM lots l")
    by_item_date = {}
    for l in lots:
        by_item_date.setdefault((l["item_id"], l["received_date"]), []).append(l)
    # račun -> datum primitka: datum s najviše stavki iste količine
    invoices = {}
    for r in rows:
        invoices.setdefault(r["invoice"], []).append(r)
    used = set()
    for inv, rs in invoices.items():
        score = {}
        for r in rs:
            for (iid, d), ls in by_item_date.items():
                if iid == r["item_id"] and abs(sum(l["qty_received"] for l in ls) - r["qty"]) < 0.011:
                    score[d] = score.get(d, 0) + 1
        best = max(score, key=lambda d: (score[d], d)) if score else None
        for r in rs:
            r["date"] = best
            ls = by_item_date.get((r["item_id"], best), []) if best else []
            if not (ls and abs(sum(l["qty_received"] for l in ls) - r["qty"]) < 0.011):
                # traži bilo koji LOT tog artikla s istom količinom
                ls = []
                for (iid, d), cand in sorted(by_item_date.items(), key=lambda x: x[0][1] or ""):
                    if iid == r["item_id"] and abs(sum(l["qty_received"] for l in cand) - r["qty"]) < 0.011 \
                            and not any(l["id"] in used for l in cand):
                        ls, r["date"] = cand, d
                        break
            ls = [l for l in ls if l["id"] not in used]
            for l in ls:
                used.add(l["id"])
            r["lot_ids"] = [l["id"] for l in ls]
            r["lots"] = ", ".join(l["lot_no"] for l in ls)
            r["status"] = ("ok" if ls else "nema LOT-a") if r["item_id"] else "nepoznat artikl"
    return {"rows": rows, "mapping": mapping, "items": [[i["name"], i["id"]] for i in sorted(items, key=lambda x: x["name"])]}


def import_prices(db, path, mapping=None):
    pv = price_preview(db, path, mapping)
    return apply_prices(db, pv["rows"])


def apply_prices(db, rows):
    """Upis cijena iz pregleda (samo podaci, bez datoteke – može se ponoviti kod spajanja s drugim uređajem)."""
    ensure(db)
    n = 0
    latest = {}
    for r in rows:
        if not r["item_id"]:
            continue
        for lid in r["lot_ids"]:
            db.con.execute("UPDATE lots SET unit_price=?, invoice_no=? WHERE id=?", (r["price"], r["invoice"], lid))
            n += 1
        d = r.get("date") or ""
        if r["item_id"] not in latest or d >= latest[r["item_id"]][0]:
            latest[r["item_id"]] = (d, r["price"])
    for iid, (_, p) in latest.items():
        db.con.execute("UPDATE items SET price=? WHERE id=?", (p, iid))
    # LOT-ovi bez cijene (npr. nastali kod uvoza utroška) -> zadnja cijena artikla, označeno kao procjena
    est = db.q("""SELECT l.id, i.price FROM lots l JOIN items i ON i.id=l.item_id
                  WHERE COALESCE(l.unit_price,0)=0 AND COALESCE(i.price,0)>0""")
    for l in est:
        db.con.execute("UPDATE lots SET unit_price=?, invoice_no=COALESCE(invoice_no,'procjena') WHERE id=?",
                       (l["price"], l["id"]))
    db.con.commit()
    return {"lots": n, "items": len(latest), "estimated": len(est),
            "missing": [r for r in rows if r.get("status") != "ok"]}


# ------------------------------------------------------------------ izvještaj
def _litres(db, b):
    pk = b.get("packaged_l") or db.val("SELECT COALESCE(SUM(total_l),0) FROM packaging WHERE batch_id=?", (b["id"],)) or 0
    return pk, (b.get("wort_l") or b.get("volume_l") or 0)


def report_data(db, d_from, d_to):
    ensure(db)
    batches = db.q("""SELECT b.*, r.name AS recipe FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                      WHERE b.status<>'Planirano' AND b.brew_date BETWEEN ? AND ? ORDER BY b.brew_date, b.id""",
                   (d_from, d_to))
    brews, mats = [], {}
    tot_cost = tot_pack = tot_brew = 0.0
    missing_price = 0
    for b in batches:
        lines = db.q("""SELECT c.qty, i.id AS item_id, i.name, i.unit, i.category, l.lot_no, l.unit_price, l.invoice_no,
                               l.note, i.price AS item_price, s.name AS supplier
                        FROM batch_consumption c JOIN items i ON i.id=c.item_id JOIN lots l ON l.id=c.lot_id
                        LEFT JOIN suppliers s ON s.id=l.supplier_id
                        WHERE c.batch_id=? ORDER BY CASE i.category WHEN 'Slad' THEN 1 WHEN 'Hmelj' THEN 2
                        WHEN 'Kvasac' THEN 3 ELSE 4 END, i.name""", (b["id"],))
        out = []
        cost = 0.0
        for ln in lines:
            price = ln["unit_price"] or ln["item_price"] or 0
            est = not ln["unit_price"] or ln["invoice_no"] == "procjena"
            if not price:
                missing_price += 1
            val = ln["qty"] * price
            cost += val
            inv = ln["invoice_no"] if ln["invoice_no"] and ln["invoice_no"] != "procjena" else ""
            out.append({"name": ln["name"], "category": ln["category"], "unit": ln["unit"], "lot": ln["lot_no"],
                        "qty": ln["qty"], "price": price, "value": val, "invoice": inv, "estimated": est,
                        "supplier": ln["supplier"] or ""})
            m = mats.setdefault(ln["item_id"], {"name": ln["name"], "category": ln["category"], "unit": ln["unit"],
                                                "qty": 0.0, "value": 0.0, "invoices": set()})
            m["qty"] += ln["qty"]
            m["value"] += val
            if inv:
                m["invoices"].add(inv)
        pack, brewed = _litres(db, b)
        litres = pack or brewed
        brews.append({"id": b["id"], "date": b["brew_date"], "lot": b["batch_no"], "beer": b["recipe"] or "",
                      "brewed_l": brewed, "packaged_l": pack, "litres": litres, "cost": cost,
                      "per_l": cost / litres if litres else 0, "lines": out})
        tot_cost += cost
        tot_pack += pack
        tot_brew += brewed
    materials = sorted(mats.values(), key=lambda m: ({"Slad": 1, "Hmelj": 2, "Kvasac": 3}.get(m["category"], 4), m["name"]))
    for m in materials:
        m["avg"] = m["value"] / m["qty"] if m["qty"] else 0
        m["invoices"] = ", ".join(sorted(m["invoices"]))
    litres = sum(b["litres"] for b in brews)
    extra = float(db.get_setting("extra_cost_l") or 0)
    return {"from": d_from, "to": d_to, "brews": brews, "materials": materials, "total_cost": tot_cost,
            "total_litres": litres, "packaged_l": tot_pack, "brewed_l": tot_brew,
            "per_l": tot_cost / litres if litres else 0, "missing_price": missing_price, "extra_cost_l": extra,
            "company": db.get_setting("dn_company") or db.get_setting("company"), "oib": db.get_setting("company_oib")}


def _period_name(d_from, d_to):
    a, b = dt.date.fromisoformat(d_from), dt.date.fromisoformat(d_to)
    months = ["siječanj", "veljača", "ožujak", "travanj", "svibanj", "lipanj", "srpanj", "kolovoz", "rujan",
              "listopad", "studeni", "prosinac"]
    if a.day == 1 and a.year == b.year and a.month == b.month and (b + dt.timedelta(days=1)).day == 1:
        return f"{months[a.month - 1]} {a.year}."
    return f"{d2ui(d_from)} – {d2ui(d_to)}"


def _n(x, d=3):
    return fq(x, d)


def report_doc(db, d_from, d_to, fmt="PDF", app=None):
    from docgen import Doc, render
    r = report_data(db, d_from, d_to)
    per = _period_name(d_from, d_to)
    m = {"code": f"TRO-{d_from[:7]}", "title": "TROŠAK SIROVINA – KUHANJA", "version": "1", "vdate": d2ui(dt.date.today().isoformat())}
    doc = Doc(m, r["company"] or "", app.logo_path() if app else None, False, f"Troskovi kuhanja {d_from[:7]}")
    doc.add("title", f"Izvještaj o kuhanjima i utrošku sirovina – {per}")
    doc.add("kv", [("Tvrtka", f"{r['company'] or ''}" + (f", OIB {r['oib']}" if r["oib"] else "")), ("Razdoblje", per),
                   ("Broj kuhanja", str(len(r["brews"]))), ("Litara piva", f"{_n(r['total_litres'], 1)} L"),
                   ("Ukupni trošak sirovina (bez PDV-a)", money(r["total_cost"])),
                   ("Prosječno po litri (bez PDV-a)", f"{fq(r['per_l'], 4)} €/L")])
    doc.add("h", "1. Kuhanja u razdoblju")
    doc.add("table", ["Datum", "LOT piva", "Pivo", "Skuhano L", "Pakirano L", "Sirovine €", "€/L"],
            [[d2ui(b["date"]), b["lot"], b["beer"], _n(b["brewed_l"], 1), _n(b["packaged_l"], 1) if b["packaged_l"] else "—",
              fq(b["cost"], 2), fq(b["per_l"], 4)] for b in r["brews"]] +
            [["", "UKUPNO", "", _n(r["brewed_l"], 1), _n(r["packaged_l"], 1), fq(r["total_cost"], 2), fq(r["per_l"], 4)]],
            [0.12, 0.16, 0.2, 0.12, 0.12, 0.14, 0.14], {"size": 9, "align": {3: "R", 4: "R", 5: "R", 6: "R"}})
    doc.add("h", "2. Utrošene sirovine (zbirno)")
    doc.add("table", ["Sirovina", "Vrsta", "Količina", "Jed.", "Prosj. cijena €", "Iznos € (bez PDV)", "Računi"],
            [[x["name"], x["category"] or "", _n(x["qty"]), x["unit"], fq(x["avg"], 3), fq(x["value"], 2), x["invoices"]]
             for x in r["materials"]] + [["UKUPNO", "", "", "", "", fq(r["total_cost"], 2), ""]],
            [0.22, 0.1, 0.1, 0.06, 0.13, 0.15, 0.24], {"size": 8.5, "align": {2: "R", 4: "R", 5: "R"}})
    doc.add("h", "3. Sirovine po kuhanju")
    for b in r["brews"]:
        doc.add("pb", f"{d2ui(b['date'])} · {b['beer']} · LOT {b['lot']} · {_n(b['litres'], 1)} L")
        doc.add("table", ["Sastojak", "LOT sirovine", "Utrošeno", "Jed.", "Cijena €/jed.", "Iznos €", "Račun"],
                [[x["name"], x["lot"], _n(x["qty"]), x["unit"], fq(x["price"], 3) + (" *" if x["estimated"] else ""),
                  fq(x["value"], 2), x["invoice"]] for x in b["lines"]] +
                [["UKUPNO", "", "", "", "", fq(b["cost"], 2), f"{fq(b['per_l'], 4)} €/L"]],
                [0.22, 0.2, 0.1, 0.06, 0.13, 0.12, 0.17], {"size": 8.5, "align": {2: "R", 4: "R", 5: "R"}})
    notes = ["Cijene su nabavne cijene bez PDV-a prema računima dobavljača (cijena LOT-a sirovine). "
             "* = procijenjena cijena (zadnja poznata cijena artikla, LOT bez računa)."]
    if r["missing_price"]:
        notes.append(f"Upozorenje: {r['missing_price']} stavki nema cijenu (računa se kao 0 €).")
    if r["extra_cost_l"]:
        notes.append(f"Ostali troškovi (ambalaža, energija, rad) nisu uključeni; u postavkama: {fq(r['extra_cost_l'], 3)} €/L.")
    doc.add("note", " ".join(notes))
    return render(doc, "/out/izvjestaji", fmt)


def report_xlsx(db, d_from, d_to, app=None):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    r = report_data(db, d_from, d_to)
    per = _period_name(d_from, d_to)
    wb = openpyxl.Workbook()
    head = Font(bold=True)
    fill = PatternFill("solid", fgColor="EFE7D6")

    def sheet(ws, title_row, header, rows, widths, money_cols=(), num_cols=()):
        ws.append([title_row])
        ws["A1"].font = Font(bold=True, size=13)
        ws.append([])
        ws.append(header)
        for c in ws[3]:
            c.font, c.fill = head, fill
        for row in rows:
            ws.append(row)
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        for row in ws.iter_rows(min_row=4):
            for c in row:
                if c.column in money_cols and isinstance(c.value, (int, float)):
                    c.number_format = '#,##0.00'
                elif c.column in num_cols and isinstance(c.value, (int, float)):
                    c.number_format = '#,##0.000'
        ws.freeze_panes = "A4"

    ws = wb.active
    ws.title = "Kuhanja"
    rows = [[b["date"] and dt.date.fromisoformat(b["date"]), b["lot"], b["beer"], b["brewed_l"], b["packaged_l"] or None,
             round(b["cost"], 2), round(b["per_l"], 4)] for b in r["brews"]]
    rows.append([None, "UKUPNO", None, r["brewed_l"], r["packaged_l"], round(r["total_cost"], 2), round(r["per_l"], 4)])
    sheet(ws, f"Kuhanja – {per} – {r['company'] or ''}", ["Datum", "LOT piva", "Pivo", "Skuhano (L)", "Pakirano (L)",
          "Trošak sirovina € (bez PDV)", "€/L (bez PDV)"], rows, [12, 16, 18, 12, 12, 22, 14], money_cols=(6,), num_cols=(7,))
    for row in ws.iter_rows(min_row=4, max_col=1):
        for c in row:
            if c.value:
                c.number_format = "DD.MM.YYYY."
    ws[f"B{ws.max_row}"].font = head

    ws2 = wb.create_sheet("Sirovine")
    rows = [[x["name"], x["category"], round(x["qty"], 4), x["unit"], round(x["avg"], 4), round(x["value"], 2), x["invoices"]]
            for x in r["materials"]]
    rows.append(["UKUPNO", None, None, None, None, round(r["total_cost"], 2), None])
    sheet(ws2, f"Utrošene sirovine – {per}", ["Sirovina", "Vrsta", "Količina", "Jed.", "Prosječna cijena € (bez PDV)",
          "Iznos € (bez PDV)", "Računi"], rows, [26, 11, 11, 7, 24, 18, 30], money_cols=(6,), num_cols=(3, 5))

    ws3 = wb.create_sheet("Po kuhanju")
    rows = []
    for b in r["brews"]:
        first = True
        for x in b["lines"]:
            rows.append([dt.date.fromisoformat(b["date"]) if first else None, b["lot"] if first else None,
                         b["beer"] if first else None, b["litres"] if first else None, x["name"], x["lot"],
                         round(x["qty"], 4), x["unit"], round(x["price"], 4), round(x["value"], 4), x["invoice"],
                         "procjena" if x["estimated"] else None, None])
            first = False
        rows.append([None, None, None, None, None, None, None, None, None, round(b["cost"], 4), None, None, round(b["per_l"], 4)])
    sheet(ws3, f"Sirovine po kuhanju – {per}", ["Datum", "LOT piva", "Pivo", "Litara", "Sastojak", "LOT sirovine",
          "Utrošeno", "Jed.", "Cijena €/jed.", "Ukupna cijena €", "Račun", "Napomena", "Cijena po litri €"],
          rows, [12, 16, 14, 8, 24, 20, 10, 6, 12, 14, 14, 10, 15], money_cols=(10,), num_cols=(7, 9, 13))
    for row in ws3.iter_rows(min_row=4, max_col=1):
        for c in row:
            if c.value:
                c.number_format = "DD.MM.YYYY."
    os.makedirs("/out/izvjestaji", exist_ok=True)
    path = f"/out/izvjestaji/Troskovi_kuhanja_{d_from}_{d_to}.xlsx"
    wb.save(path)
    return path


def months_with_brews(db):
    return [r["m"] for r in db.q("""SELECT DISTINCT substr(brew_date,1,7) AS m FROM batches
                                    WHERE status<>'Planirano' AND brew_date IS NOT NULL ORDER BY m DESC""")]
