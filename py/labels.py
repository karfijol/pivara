"""Naljepnice i zastavice za kegove (zajednički kod; web verzija). Izvučeno iz extras_ui.py."""
import os
import datetime as dt

from webutil import data_dir, d2ui, fq  # noqa: F401


class _MB:
    @staticmethod
    def askyesno(*a, **k):
        return True


messagebox = _MB()


def keg_label_data(db, kid):
    from haccp_db import add_months
    k = db.one("""SELECT k.*, b.batch_no, b.abv AS batch_abv, b.recipe_id, r.name AS beer, r.style, r.allergens,
                  r.label_ingredients FROM kegs k
                  LEFT JOIN batches b ON b.id=k.batch_id LEFT JOIN recipes r ON r.id=b.recipe_id WHERE k.id=?""", (kid,))
    k["abv"] = db.beer_abv({"recipe_id": k.get("recipe_id"), "abv": k.get("batch_abv")}) if k.get("batch_id") else None
    k["color"] = db.beer_color(k.get("recipe_id"), k.get("beer"))
    k["ingredients"], k["allergen_txt"] = db.label_texts(k.get("recipe_id"), k.get("allergens"), k.get("label_ingredients"))
    best = None
    if k.get("batch_id"):
        p = db.one("SELECT * FROM packaging WHERE batch_id=? AND date=? ORDER BY id DESC LIMIT 1",
                   (k["batch_id"], k.get("filled_date"))) if k.get("filled_date") else None
        best = (p or {}).get("best_before")
    if not best and k.get("filled_date"):
        best = add_months(k["filled_date"], int(db.get_setting("shelf_months") or 6))
    k["best"] = best
    # neto količina = piva u kegu (17 L ili ručno upisano kod punjenja), ne volumen kega
    k["net_l"] = k.get("fill_l") or db.keg_default_fill(k)
    return k


# ------------------------------------------------------------------ piktogrami (dobrovoljni)
def _ring(c, cx, cy, r, slash=True):
    c.setStrokeColorRGB(0.80, 0.07, 0.07)
    c.setLineWidth(r * 0.16)
    c.circle(cx, cy, r, stroke=1, fill=0)
    if slash:
        d = r * 0.7071
        c.line(cx - d, cy + d, cx + d, cy - d)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(1)


def picto_18(c, cx, cy, r, font):
    c.setFillColorRGB(0, 0, 0)
    size = r * 0.78
    c.setFont(font, size)
    c.drawCentredString(cx, cy - size * 0.36, "18+")
    _ring(c, cx, cy, r, slash=False)


def picto_pregnant(c, cx, cy, r):
    """Silueta trudnice u profilu s čašom, prekrižena."""
    c.saveState()
    c.setFillColorRGB(0, 0, 0)
    u = r / 8.2
    cy -= 0.3 * u
    c.circle(cx - 0.6 * u, cy + 5.2 * u, 1.35 * u, stroke=0, fill=1)          # glava
    p = c.beginPath()                                                         # tijelo s trbuhom
    p.moveTo(cx - 1.3 * u, cy + 3.7 * u)
    p.lineTo(cx + 0.2 * u, cy + 3.7 * u)
    p.curveTo(cx + 0.6 * u, cy + 2.2 * u, cx + 3.4 * u, cy + 1.2 * u, cx + 2.6 * u, cy - 1.6 * u)
    p.curveTo(cx + 2.2 * u, cy - 2.8 * u, cx + 0.8 * u, cy - 2.8 * u, cx + 0.4 * u, cy - 2.9 * u)
    p.lineTo(cx + 0.5 * u, cy - 6.6 * u)
    p.lineTo(cx - 0.6 * u, cy - 6.6 * u)
    p.lineTo(cx - 0.9 * u, cy - 2.9 * u)
    p.lineTo(cx - 1.9 * u, cy - 2.9 * u)
    p.curveTo(cx - 2.1 * u, cy - 0.5 * u, cx - 2.0 * u, cy + 2.0 * u, cx - 1.3 * u, cy + 3.7 * u)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setLineWidth(0.9 * u)                                                   # ruka s čašom
    c.setStrokeColorRGB(0, 0, 0)
    c.line(cx - 0.8 * u, cy + 2.6 * u, cx - 3.0 * u, cy + 0.6 * u)
    c.line(cx - 3.0 * u, cy + 0.6 * u, cx - 3.6 * u, cy + 2.6 * u)
    g = c.beginPath()                                                         # čaša
    g.moveTo(cx - 4.9 * u, cy + 4.6 * u)
    g.lineTo(cx - 2.9 * u, cy + 4.6 * u)
    g.lineTo(cx - 3.3 * u, cy + 1.9 * u)
    g.lineTo(cx - 4.5 * u, cy + 1.9 * u)
    g.close()
    c.drawPath(g, stroke=0, fill=1)
    c.restoreState()
    _ring(c, cx, cy, r)


def picto_drive(c, cx, cy, r):
    """Automobil, prekrižen (ne vozi pod utjecajem alkohola)."""
    c.saveState()
    c.setFillColorRGB(0, 0, 0)
    u = r / 10.0
    p = c.beginPath()
    p.moveTo(cx - 6.2 * u, cy - 2.2 * u)
    p.lineTo(cx - 6.2 * u, cy + 0.4 * u)
    p.lineTo(cx - 4.6 * u, cy + 1.0 * u)
    p.lineTo(cx - 2.8 * u, cy + 3.6 * u)
    p.lineTo(cx + 2.6 * u, cy + 3.6 * u)
    p.lineTo(cx + 4.4 * u, cy + 1.0 * u)
    p.lineTo(cx + 6.2 * u, cy + 0.5 * u)
    p.lineTo(cx + 6.2 * u, cy - 2.2 * u)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)                                                # prozori
    c.rect(cx - 2.3 * u, cy + 1.2 * u, 2.0 * u, 1.8 * u, stroke=0, fill=1)
    c.rect(cx + 0.3 * u, cy + 1.2 * u, 2.0 * u, 1.8 * u, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.setStrokeColorRGB(1, 1, 1)
    c.setLineWidth(0.5 * u)
    for wx in (-3.6, 3.6):                                                    # kotači
        c.circle(cx + wx * u, cy - 2.3 * u, 1.5 * u, stroke=1, fill=1)
    c.restoreState()
    _ring(c, cx, cy, r)


def _rich_words(text):
    """Riječi VELIKIM slovima (alergeni) podebljano."""
    out = []
    for w in text.split(" "):
        core = w.strip(",.()").replace("Č", "C").replace("Ć", "C").replace("Š", "S").replace("Ž", "Z").replace("Đ", "D")
        out.append((w, len(core) > 1 and core.isupper()))
    return out


BL_DATE, BL_MONTH, BL_TEXT = "____.____.________.", "____.________.", "________________"


def recipe_label_data(db, recipe_id, size_l=None):
    """Podaci za naljepnicu bez kega/šarže (pivo iz recepture; datum, rok, LOT i keg ostaju prazni)."""
    r = db.one("SELECT * FROM recipes WHERE id=?", (recipe_id,))
    k = {"code": None, "size_l": size_l, "batch_id": None, "batch_no": None, "filled_date": None, "best": None,
         "recipe_id": recipe_id, "beer": r["name"], "style": r.get("style"), "allergens": r.get("allergens"),
         "label_ingredients": r.get("label_ingredients")}
    k["abv"] = db.beer_abv({"recipe_id": recipe_id, "abv": None})
    k["color"] = db.beer_color(recipe_id, r["name"])
    k["ingredients"], k["allergen_txt"] = db.label_texts(recipe_id, r.get("allergens"), r.get("label_ingredients"))
    return k


def apply_blanks(data, opts):
    """Polja koja se upisuju ručno (olovkom) ostaju prazna."""
    opts = opts or {}
    for k in data:
        if opts.get("blank_lot"):
            k["batch_no"] = None
        if opts.get("blank_keg"):
            k["code"] = None
        if opts.get("blank_dates"):
            k["filled_date"] = None
            k["best"] = None
    return data


def check_missing(data, parent, opts, title):
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
    if missing and parent is not None:
        return messagebox.askyesno(title, "Nedostaju obvezni podaci:\n\n" + "\n".join(missing[:12])
                                   + ("\n…" if len(missing) > 12 else "")
                                   + "\n\nIspisati ipak (prazna polja ostaju za ručni upis)?", parent=parent)
    return True


def keg_labels_pdf(db, app, keg_ids, parent=None, data=None, opts=None):
    """Naljepnice za kegove (8 po A4, 105 × 74 mm) s obveznim podacima prema Uredbi (EU) 1169/2011."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.graphics.barcode import qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    from docgen import _register_fonts
    data = apply_blanks(data if data is not None else [keg_label_data(db, kid) for kid in keg_ids], opts)
    if not check_missing(data, parent, opts, "Naljepnice – nedostaju podaci"):
        return None
    body, bold, _ = _register_fonts()
    folder = os.path.join(data_dir(), "naljepnice")
    os.makedirs(folder, exist_ok=True)
    stamp = dt.datetime.now().strftime('%Y%m%d_%H%M%S')
    path, n = os.path.join(folder, f"naljepnice_{stamp}.pdf"), 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(folder, f"naljepnice_{stamp}_{n}.pdf")
    c = rl.Canvas(path, pagesize=A4)
    c.setTitle("Naljepnice za kegove")
    W, H = A4
    lw, lh = 105 * mm, 74.25 * mm
    logo = app.logo_path() if app else None
    S = {k: db.get_setting(k) or "" for k in ("label_brand", "label_producer", "label_address", "label_storage",
                                               "label_food_name", "label_show_style", "label_qr",
                                               "label_show_ingredients", "label_pictograms")}
    use_qr = S["label_qr"] not in ("0", "")
    use_pic = S["label_pictograms"] not in ("0", "")
    use_ingr = S["label_show_ingredients"] not in ("0", "")
    blank = "________"

    def fit(text, font, size, width, min_size=7.5):
        while size > min_size and stringWidth(text, font, size) > width:
            size -= 0.25
        return size

    def pair(x, y, label, value, width, size=9):
        """'Oznaka: vrijednost' – oznaka obično, vrijednost podebljano; smanji font ako ne stane."""
        lab = label + ": "
        total = stringWidth(lab, body, size) + stringWidth(value, bold, size)
        while size > 7.5 and total > width:
            size -= 0.25
            total = stringWidth(lab, body, size) + stringWidth(value, bold, size)
        c.setFont(body, size)
        c.drawString(x, y, lab)
        c.setFont(bold, size)
        c.drawString(x + stringWidth(lab, body, size), y, value)

    for n, k in enumerate(data):
        if n and n % 8 == 0:
            c.showPage()
        col, row = n % 2, (n % 8) // 2
        x, y = col * lw, H - (row + 1) * lh
        c.setStrokeColorRGB(0.75, 0.75, 0.75)
        c.setDash(2, 3)
        c.rect(x + 2 * mm, y + 2 * mm, lw - 4 * mm, lh - 4 * mm)
        c.setDash()
        c.setFillColorRGB(0, 0, 0)
        tx = x + 7 * mm
        right = x + lw - 6 * mm
        top = y + lh - 8.5 * mm
        logo_w = 0
        if logo:
            try:
                c.drawImage(logo, right - 26 * mm, y + lh - 21 * mm, 26 * mm, 14 * mm, preserveAspectRatio=True,
                            anchor="ne", mask="auto")
                logo_w = 28 * mm
            except Exception:  # noqa: BLE001
                logo_w = 0
        head_w = right - tx - logo_w
        brand = S["label_brand"].upper()
        c.setFont(bold, fit(brand, bold, 10.5, head_w))
        c.drawString(tx, top, brand)
        name = (k.get("beer") or blank).upper()
        c.setFont(bold, fit(name, bold, 17, head_w, 10))
        c.drawString(tx, top - 7 * mm, name)
        desc = S["label_food_name"] or "Pivo"
        if S["label_show_style"] not in ("0", "") and k.get("style"):
            desc += f" · {k['style']}"
        c.setFont(body, fit(desc, body, 9, head_w))
        c.drawString(tx, top - 11.5 * mm, desc)
        abv = f"{k['abv']:.1f}".replace(".", ",") if k.get("abv") else "____"
        best = k.get("best")
        best_txt = f"{best[5:7]}.{best[:4]}." if best else blank
        size = k.get("net_l") or k.get("size_l")
        net = (f"{size:g}".replace(".", ",") + " L") if size else "____ L"
        if use_pic:  # dobrovoljni piktogrami: 18+, ne za trudnice, ne vozi
            pr = 4.1 * mm
            pcy = top - 18.4 * mm
            for i, fn in enumerate((lambda cx: picto_drive(c, cx, pcy, pr), lambda cx: picto_pregnant(c, cx, pcy, pr),
                                    lambda cx: picto_18(c, cx, pcy, pr, bold))):
                fn(right - pr - i * (2 * pr + 1.6 * mm))
            c.setFillColorRGB(0, 0, 0)
        ingr_rows = []
        if use_ingr and k.get("ingredients"):  # sastojci: alergeni naglašeni (VELIKA slova, podebljano)
            fs = 8.5
            words = [("Sastojci:", False, True)] + [(w, b, False) for w, b in _rich_words(k["ingredients"])]
            row_, wsum, avail = [], 0, right - tx
            for w, b, is_lab in words:
                f = bold if b else body
                ww = stringWidth(w + " ", f, fs)
                if row_ and wsum + ww > avail:
                    ingr_rows.append(row_)
                    row_, wsum = [], 0
                row_.append((w, f))
                wsum += ww
            ingr_rows.append(row_)
        lines = [("Alkohol", f"{abv} % vol."), ("Neto količina", net)]
        lines += [("__ingr", r) for r in ingr_rows] if ingr_rows else [("Sadrži", k.get("allergen_txt") or "")]
        lines += [("Proizvođač", S["label_producer"]), ("Adresa", S["label_address"]),
                  ("Datum punjenja", d2ui(k.get("filled_date")) or BL_DATE),
                  ("Najbolje upotrijebiti do kraja", best_txt),
                  ("LOT", k.get("batch_no") or BL_TEXT)] + ([] if k.get("code") else [("Keg", BL_TEXT)]) + [
                  ("Uvjeti čuvanja", S["label_storage"])]
        qr_size = 17 * mm
        qr_top = y + 5 * mm + qr_size + 4 * mm
        yy = top - 17 * mm
        step = min(4.55 * mm, (yy - (y + 6 * mm)) / max(len(lines) - 1, 1))
        for lab, val in lines:
            width = right - tx - ((qr_size + 2 * mm) if use_qr and k.get("code") and k.get("batch_no") and yy < qr_top else 0)
            if lab == "__ingr":
                xx = tx
                for w, f in val:
                    c.setFont(f, 8.5)
                    c.drawString(xx, yy, w)
                    xx += stringWidth(w + " ", f, 8.5)
            else:
                pair(tx, yy, lab, val, width, 10 if lab in ("Alkohol", "Neto količina") else 9)
            yy -= step
        if not k.get("code") or not k.get("batch_no"):  # ručni upis -> bez QR koda
            pass
        elif use_qr:
            q = qr.QrCodeWidget(f"KEG:{k['code']};LOT:{k.get('batch_no') or ''};PIVO:{k.get('beer') or ''}")
            bx = q.getBounds()
            dwg = Drawing(qr_size, qr_size, transform=[qr_size / (bx[2] - bx[0]), 0, 0, qr_size / (bx[3] - bx[1]), 0, 0])
            dwg.add(q)
            renderPDF.draw(dwg, c, right - qr_size, y + 7 * mm)
            c.setFont(body, 7)
            c.drawCentredString(right - qr_size / 2, y + 4.5 * mm, f"Keg {k['code']}")
    c.save()
    return path



# ================================================================== zastavice 80 × 30 mm (2.9)
FLAG_FORMATS = ["Zastavica 80×30 mm (presavijena) – A4 (8 na listu)",
                "Zastavica 80×30 mm (presavijena) – printer etiketa 160×30 mm",
                "Velika naljepnica 105×74 mm (8 na A4)"]


def _hex(c):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _dark(rgb):
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b < 0.55


def keg_flags_pdf(db, app, keg_ids, parent=None, single=False, data=None, opts=None):
    """Zastavice 80 × 30 mm za poklopac kega; boja prema vrsti piva; svi obvezni podaci (Uredba (EU) 1169/2011)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from docgen import _register_fonts
    data = apply_blanks(data if data is not None else [keg_label_data(db, kid) for kid in keg_ids], opts)
    if not check_missing(data, parent, opts, "Zastavice – nedostaju podaci"):
        return None
    body, bold, _ = _register_fonts()
    folder = os.path.join(data_dir(), "naljepnice")
    os.makedirs(folder, exist_ok=True)
    stamp = dt.datetime.now().strftime('%Y%m%d_%H%M%S')
    path, n = os.path.join(folder, f"zastavice_{stamp}.pdf"), 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(folder, f"zastavice_{stamp}_{n}.pdf")
    FW, FH = 80 * mm, 30 * mm
    if single:
        c = rl.Canvas(path, pagesize=(2 * FW, FH))
    else:
        c = rl.Canvas(path, pagesize=A4)
    c.setTitle("Zastavice za kegove")
    W, H = A4
    rows, gap = 8, 4 * mm
    y0 = H - (H - rows * FH - (rows - 1) * gap) / 2
    S = {k: db.get_setting(k) or "" for k in ("label_brand", "label_producer", "label_address", "label_storage",
                                               "label_food_name", "label_show_style", "label_show_ingredients",
                                               "label_pictograms")}
    use_pic = S["label_pictograms"] not in ("0", "")
    use_ingr = S["label_show_ingredients"] not in ("0", "")
    blank = "______"
    FS = 6.2      # ≥ 1,2 mm visina malog slova (obvezni podaci)

    def fit(text, font, size, width, mn=5.0):
        while size > mn and stringWidth(text, font, size) > width:
            size -= 0.2
        return size

    def wrap_rich(words, width, size):
        """words: [(tekst, font)] -> retci [[(tekst, font)]]"""
        rows_, row_, w = [], [], 0
        for t, f in words:
            ww = stringWidth(t + " ", f, size)
            if row_ and w + ww > width:
                rows_.append(row_)
                row_, w = [], 0
            row_.append((t, f))
            w += ww
        if row_:
            rows_.append(row_)
        return rows_

    def draw_row(x, y, row_, size):
        for t, f in row_:
            c.setFont(f, size)
            c.drawString(x, y, t)
            x += stringWidth(t + " ", f, size)

    def lw(label, value):
        return [(label + ":", body)] + [(w, bold) for w in value.split(" ")]

    def panel(x, y, k, flip):
        rgb = _hex(k.get("color") or "#8A8F98")
        txt = (1, 1, 1) if _dark(rgb) else (0.07, 0.07, 0.07)
        # okvir u boji piva + bijelo polje za sitni tekst
        c.setFillColorRGB(*rgb)
        c.rect(x, y, FW, FH, stroke=0, fill=1)
        bw = 25 * mm
        bx = x + FW - bw if flip else x            # blok u boji (kod druge polovice uz vanjski rub)
        wx = x + 1.2 * mm if flip else x + bw      # bijelo polje
        ww_ = FW - bw - 1.2 * mm
        c.setFillColorRGB(1, 1, 1)
        c.rect(wx, y + 1.2 * mm, ww_, FH - 2.4 * mm, stroke=0, fill=1)
        # lijevi blok u boji: pivovara, naziv, alkohol, neto, piktogrami
        lx, inner = bx + 1.8 * mm, bw - 3.2 * mm
        c.setFillColorRGB(*txt)
        brand = S["label_brand"].upper()
        c.setFont(bold, fit(brand, bold, 5.6, inner, 4.5))
        c.drawString(lx, y + FH - 4.2 * mm, brand)
        name = (k.get("beer") or blank).upper()
        parts = name.split(" ")
        lines_n = [name] if stringWidth(name, bold, 9) <= inner or len(parts) == 1 else \
            [" ".join(parts[:len(parts) // 2]), " ".join(parts[len(parts) // 2:])]
        ny = y + FH - 8.6 * mm
        for ln in lines_n:
            c.setFont(bold, fit(ln, bold, 10.5, inner, 6))
            c.drawString(lx, ny, ln)
            ny -= 3.9 * mm
        desc = S["label_food_name"] or "Pivo"
        if S["label_show_style"] not in ("0", "") and k.get("style"):
            desc += f" · {k['style']}"
        c.setFont(body, fit(desc, body, 5.6, inner, 4.6))
        c.drawString(lx, ny + 0.6 * mm, desc)
        abv = f"{k['abv']:.1f}".replace(".", ",") if k.get("abv") else "___"
        size = k.get("net_l") or k.get("size_l")
        net = (f"{size:g}".replace(".", ",") + " L") if size else blank
        c.setFont(bold, fit(f"{abv} % vol.", bold, 8.5, inner))
        c.drawString(lx, y + 9.6 * mm, f"{abv} % vol.")
        c.setFont(bold, fit(net, bold, 8.5, inner))
        c.drawString(lx, y + 6.4 * mm, net)
        if use_pic:
            pr = 1.75 * mm
            py = y + 3.0 * mm
            for m, fn in enumerate((lambda cx: picto_18(c, cx, py, pr, bold), lambda cx: picto_pregnant(c, cx, py, pr),
                                    lambda cx: picto_drive(c, cx, py, pr))):
                cx = lx + pr + 0.2 * mm + m * (2 * pr + 1.0 * mm)
                c.setFillColorRGB(1, 1, 1)
                c.circle(cx, py, pr, stroke=0, fill=1)
                fn(cx)
            c.setFillColorRGB(*txt)
        # desno: sastojci/alergeni, proizvođač, datumi, LOT, čuvanje
        rx = wx + 1.6 * mm
        rw = FW - bw - 1.2 * mm - 3.0 * mm
        best = k.get("best")
        best_txt = f"{best[5:7]}.{best[:4]}." if best else BL_MONTH
        def build(sz):
            bl = []
            if use_ingr and k.get("ingredients"):
                bl += wrap_rich([("Sastojci:", body)] + [(w, bold if b_ else body) for w, b_ in _rich_words(k["ingredients"])],
                                rw, sz)
            else:
                bl += wrap_rich(lw("Sadrži", k.get("allergen_txt") or ""), rw, sz)
            bl += wrap_rich([("Proizvođač:", body)] + [(w, bold) for w in
                                                       f"{S['label_producer']}, {S['label_address']}".split(" ")], rw, sz)
            bl += wrap_rich(lw("Datum punjenja", d2ui(k.get("filled_date")) or BL_DATE), rw, sz)
            bl += wrap_rich(lw("Najbolje upotrijebiti do kraja", best_txt), rw, sz)
            bl += wrap_rich(lw("LOT", k.get("batch_no") or BL_TEXT), rw, sz)
            if not k.get("code"):
                bl += wrap_rich(lw("Keg", BL_TEXT), rw, sz)
            bl += wrap_rich([(w, body) for w in S["label_storage"].split(" ")], rw, sz)
            return bl

        size_ = FS
        block = build(size_)
        while len(block) * size_ * 1.13 > (FH - 3.4 * mm) and size_ > 5.0:  # smanji ako ne stane
            size_ -= 0.2
            block = build(size_)
        lead = min(size_ * 1.4, (FH - 4.2 * mm) / max(len(block), 1))
        c.setFillColorRGB(0, 0, 0)
        yy = y + FH - 1.2 * mm - 1.0 * mm - size_ * 0.8
        for row_ in block:
            draw_row(rx, yy, row_, size_)
            yy -= lead
        c.setFont(body, 4.2)
        c.setFillColorRGB(0.45, 0.45, 0.45)
        if k.get("code"):
            c.drawRightString(wx + ww_ - 0.8 * mm, y + 1.7 * mm, f"Keg {k['code']}")

    PW = 2 * FW   # traka duple duljine: presavije se po sredini (ljepljive strane zajedno) -> 80 × 30 mm
    for i, k in enumerate(data):
        if single:
            if i:
                c.showPage()
            x, y = 0, 0
        else:
            if i and i % rows == 0:
                c.showPage()
            j = i % rows
            x = (W - PW) / 2
            y = y0 - (j + 1) * FH - j * gap
        panel(x, y, k, False)
        panel(x + FW, y, k, True)
        # linija pregiba (sredina) i oznake
        c.setStrokeColorRGB(0.35, 0.35, 0.35)
        c.setLineWidth(0.3)
        c.setDash(2, 1.5)
        c.line(x + FW, y, x + FW, y + FH)
        c.setDash()
        if not single:  # linija za rezanje i oznaka pregiba izvan trake
            c.setStrokeColorRGB(0.7, 0.7, 0.7)
            c.setLineWidth(0.2)
            c.setDash(1, 2)
            c.rect(x, y, PW, FH, stroke=1, fill=0)
            c.setDash()
            c.setStrokeColorRGB(0.3, 0.3, 0.3)
            c.setLineWidth(0.4)
            c.line(x + FW, y + FH + 0.4 * mm, x + FW, y + FH + 2.0 * mm)
            c.line(x + FW, y - 0.4 * mm, x + FW, y - 2.0 * mm)
    c.save()
    return path



