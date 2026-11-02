"""Pomoćni ispis za obrazac MI-PI (mjesečno izvješće o trošarini na pivo, mala nezavisna pivovara).
Žuto = upisujete u obrazac, zeleno = obrazac obično izračuna sam (provjerite), sivo = ostaje 0."""
import os
import datetime as dt

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

from docgen import _register_fonts

YELLOW = colors.HexColor("#FFE66B")
GREEN = colors.HexColor("#CDEFC4")
GREY = colors.HexColor("#F1F1F1")
HEAD = colors.HexColor("#E6E6E6")

ROWS = ["Stanje zaliha na dan godine", "Proizvedene količine", "Količine primljene u TS nakon uvoza u RH",
        "Količine primljene u TS iz drugog TS unutar RH/iz pogona oslobođenog korisnika", "Količine primljene iz druge DČ",
        "Višak utvrđen popisom zaliha", "Ukupno ( 1. + 2. + 3. + 4. + 5. + 6.)", "Količine otpremljene iz TS u drugo TS unutar RH",
        "Količine otpremljene iz TS u drugu DČ u sustavu odgode plaćanja trošarine",
        "Količine otpremljene iz TS u treću državu (izvoz)", "Količine oslobođene plaćanja trošarine (čl. 35. st. 1. ZOT-a)",
        "Količine otpremljene iz TS oslobođene plaćanja trošarine (čl. 36 st. 1. toč. 1. i 2. ZOT-a)",
        "Količine oslobođene plaćanja trošarine (čl. 38. st. 1. toč. 1. do 4. ZOT-a)",
        "Količine oslobođene plaćanja trošarine (čl. 38. st. 1. toč. 5. ZOT-a)",
        "Količine oslobođene plaćanja trošarine/otpremljene oslobođenom korisniku (čl. 68. st. 1. toč. 4. do 14. ZOT-a)",
        "Količine piva utrošene za vlastitu proizvodnju u TS*", "Neoporezive količine (8. + … + 16.)",
        "Količine puštene u potrošnju u RH (oporezive količine)", "Stanje zaliha na kraju mjeseca (7. - 17. - 18.)",
        "Obračunata trošarina prilikom puštanja u potrošnju u RH", "Količine uvezene i puštene u slobodni promet u RH",
        "Obračunata trošarina prilikom puštanja u slobodan promet u RH", "UKUPNO OBRAČUNATO**",
        "Količine otpremljene u drugu DČ s plaćenom trošarinom"]
ENTER_ROWS = {2, 18}          # upisujete
CHECK_ROWS = {7, 19, 20, 23}  # obrazac računa – provjerite


def hr3(x):
    return f"{x:,.3f}".replace(",", "X").replace(".", ",").replace("X", ".")


def hr2(x):
    return f"{x:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def make_mipi_pdf(db, period, summary, entries, folder, logo=None):
    from extras_db import ExtrasMixin
    body, bold, sym = _register_fonts()
    os.makedirs(folder, exist_ok=True)
    y, m = period.split("-")
    d_from, d_to = db.period_bounds(period)
    fmt = lambda iso: f"{iso[8:10]}.{iso[5:7]}.{iso[:4]}."
    path = os.path.join(folder, f"MI-PI pomoc {m}-{y}.pdf")
    st = lambda size=9, b=False, al=0: ParagraphStyle("x", fontName=bold if b else body, fontSize=size, leading=size + 2.5,
                                                       alignment=al)
    P = lambda t, size=9, b=False, al=0: Paragraph(str(t), st(size, b, al))
    box = lambda on: f'<font name="{sym}">{"☒" if on else "☐"}</font>' if sym else ("[X]" if on else "[ ]")
    story = []
    classes = summary["classes"]
    labels = [c[2] for c in ExtrasMixin.ABV_CLASSES]

    # ---------------- stranica 1: upute i zaglavlje
    story.append(P(f"POMOĆ ZA POPUNJAVANJE OBRASCA MI-PI – razdoblje {fmt(d_from)} – {fmt(d_to)}", 15, True))
    story.append(Spacer(1, 3 * mm))
    legend = Table([[P("", 9), P("<b>ŽUTO</b> – ovo upisujete u obrazac na portalu Carinske uprave", 10),
                     P("", 9), P("<b>ZELENO</b> – obrazac obično izračuna sam; provjerite da je isto", 10),
                     P("", 9), P("<b>SIVO</b> – ostaje 0", 10)]],
                   colWidths=[8 * mm, 85 * mm, 8 * mm, 85 * mm, 8 * mm, 50 * mm])
    legend.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, 0), YELLOW), ("BACKGROUND", (2, 0), (2, 0), GREEN),
                                ("BACKGROUND", (4, 0), (4, 0), GREY), ("BOX", (0, 0), (0, 0), 0.5, colors.black),
                                ("BOX", (2, 0), (2, 0), 0.5, colors.black), ("BOX", (4, 0), (4, 0), 0.5, colors.black),
                                ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(legend)
    story.append(Spacer(1, 4 * mm))
    head = [[P("Trošarinski obveznik:"), P(db.get_setting("company") or "", 9, True), P("Carinski ured:"),
             P(db.get_setting("customs_office") or "", 9, True)],
            [P("Sjedište:"), P(db.get_setting("company_address") or "", 9, True), P("Obrazac:"), P("MI-PI", 9, True)],
            [P("OIB:"), P(db.get_setting("company_oib") or "", 9, True), P("Razdoblje:"), P(f"{fmt(d_from)} – {fmt(d_to)}", 9, True)],
            [P("Trošarinski broj:"), P(db.get_setting("excise_no") or "", 9, True), P(""), P("")]]
    t = Table(head, colWidths=[40 * mm, 110 * mm, 30 * mm, 80 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (1, 0), (1, 3), GREEN), ("BACKGROUND", (3, 0), (3, 2), GREEN),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 2)]))
    story.append(t)
    story.append(Spacer(1, 4 * mm))
    story.append(P("Vrsta obveznika – na prvoj stranici obrasca označite:", 10, True))
    kinds = [("Proizvođač - Mala nezavisna pivovara (ovlašteni držatelj TS)", False),
             ("Proizvođač izvan sustava odgode iz članka 81. ZOT-a - Mala nezavisna pivovara", True)]
    kt = Table([[P(f"{box(on)}  {txt}", 10, on)] for txt, on in kinds], colWidths=[180 * mm])
    kt.setStyle(TableStyle([("BACKGROUND", (0, 1), (0, 1), YELLOW)]))
    story.append(kt)
    story.append(Spacer(1, 5 * mm))
    steps = [
        "1. Na portalu otvorite novi obrazac MI-PI za razdoblje " + f"{fmt(d_from)} – {fmt(d_to)} i označite vrstu obveznika (žuto gore).",
        "2. U tablici <b>„MI-PI do 5000 hl”</b> upišite žuta polja: red <b>2. Proizvedene količine</b> i red <b>18. Količine puštene u "
        "potrošnju</b>, svaki u stupac razreda alkohola (str. 2 ove pomoći). Tablice za 5001 hl i više ostaju prazne.",
        "3. Provjerite zelena polja (redovi 7, 19, 20 i 23) – moraju biti jednaka iznosima ovdje.",
        "4. U <b>Specifikaciji količina piva puštenih u potrošnju</b> upišite svako pivo u svoj redak: volumni udio (razred), "
        "trgovački naziv, količinu u hl (3 decimale), % vol. (1 decimala), visinu trošarine i obračunatu trošarinu (str. 3).",
        "5. Provjerite tablicu „Ukupno” po razredima i ukupan iznos za plaćanje: "
        f"<b>{hr2(summary['total_excise'])} €</b>.",
        "6. Potvrdite i pošaljite obrazac, a zatim u programu kliknite „Označi kao prijavljeno”."]
    for s_ in steps:
        story.append(P(s_, 10))
        story.append(Spacer(1, 1.5 * mm))
    if summary["missing"]:
        story.append(Spacer(1, 3 * mm))
        story.append(P(f"⚠ {len(summary['missing'])} označenih stavki nema % alkohola i NISU uključene u izračun – "
                       "upišite ih u programu (Trošarine → Uredi).", 10, True))
    story.append(PageBreak())

    # ---------------- stranica 2: tablica MI-PI do 5000 hl (svi razredi + ukupno)
    story.append(P("MI-PI do 5000 hl – vrijednosti za upis (str. 1/2 i 2/2 obrasca spojene u jednu tablicu)", 11, True))
    story.append(Spacer(1, 2 * mm))
    header = [P("Red.<br/>br.", 7, True, 1), P("Količine piva u hl", 7, True)] + [P(l, 7, True, 1) for l in labels] + \
             [P("UKUPNO", 7, True, 1)]
    colnum = [P(""), P("1", 7, False, 1)] + [P(str(i), 7, False, 1) for i in range(2, 13)]
    data = [header, colnum]
    style = [("GRID", (0, 0), (-1, -1), 0.4, colors.black), ("BACKGROUND", (0, 0), (-1, 1), HEAD),
             ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 1.2),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2), ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2)]
    total_hl = summary["total_hl"]
    for r, label in enumerate(ROWS, start=1):
        vals = []
        for ci in range(len(labels)):
            c = classes.get(ci, {"hl": 0, "excise": 0})
            if r in (2, 7, 18):
                v = hr3(c["hl"])
            elif r in (20,):
                v = hr2(c["excise"])
            elif r in (22,):
                v = "0,00"
            elif r == 23:
                v = ""
            else:
                v = "0,000"
            vals.append(v)
        if r in (2, 7, 18):
            tot = hr3(total_hl)
        elif r in (20, 23):
            tot = hr2(summary["total_excise"])
        elif r == 22:
            tot = "0,00"
        else:
            tot = "0,000"
        row_i = len(data)
        data.append([P(f"{r}.", 7, False, 1), P(label, 6.5)] + [P(v, 7, r in ENTER_ROWS | CHECK_ROWS, 2) for v in vals] +
                    [P(tot, 7, True, 2)])
        for ci in range(len(labels) + 1):
            col = 2 + ci
            val = (vals + [tot])[ci]
            nonzero = val not in ("0,000", "0,00", "")
            if r in ENTER_ROWS and nonzero:
                style.append(("BACKGROUND", (col, row_i), (col, row_i), YELLOW))
            elif r in CHECK_ROWS and nonzero:
                style.append(("BACKGROUND", (col, row_i), (col, row_i), GREEN))
            else:
                style.append(("BACKGROUND", (col, row_i), (col, row_i), GREY))
        if r in ENTER_ROWS:
            style.append(("BACKGROUND", (0, row_i), (1, row_i), YELLOW))
        if r == 23:
            style.append(("SPAN", (2, row_i), (11, row_i)))
    t = Table(data, colWidths=[8 * mm, 60 * mm] + [18.2 * mm] * 10 + [21 * mm], repeatRows=2)
    t.setStyle(TableStyle(style))
    story.append(t)
    story.append(P("* Upisuju se količine piva utrošenog kao reprodukcijskog materijala u proizvodnji novog trošarinskog proizvoda. "
                   "** Ukupno obračunata trošarina = stupac 12 red 20 + stupac 12 red 22.", 6.5))
    story.append(PageBreak())

    # ---------------- stranica 3: specifikacija
    m_label = f"{m}/{y}"
    story.append(P(f"Specifikacija količina piva puštenih u potrošnju u RH (oporezive količine) za mjesec {m_label}", 11, True))
    story.append(Spacer(1, 2 * mm))
    sdata = [[P(h, 8, True, 1) for h in ("Red. br.", "Volumni udio", "Trgovački naziv", "Količina hl", "% vol.",
                                          "Visina trošarine", "Obračunata trošarina")],
             [P(x, 7, False, 1) for x in ("", "", "1", "2", "3**", "", "4")]]
    for i, r in enumerate(summary["rows"], 1):
        sdata.append([P(str(i), 9, False, 1), P(labels[r["class"]], 9), P(r["name"], 9, True), P(hr3(r["hl"]), 9, True, 2),
                      P(f"{r['abv']:.1f}".replace(".", ","), 9, True, 2), P(hr2(r["rate"]), 9, True, 2),
                      P(hr2(r["excise"]), 9, True, 2)])
    st_ = [("GRID", (0, 0), (-1, -1), 0.4, colors.black), ("BACKGROUND", (0, 0), (-1, 1), HEAD),
           ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]
    if len(sdata) > 2:
        st_.append(("BACKGROUND", (1, 2), (-1, -1), YELLOW))
    t = Table(sdata, colWidths=[16 * mm, 32 * mm, 55 * mm, 32 * mm, 26 * mm, 32 * mm, 38 * mm])
    t.setStyle(TableStyle(st_))
    story.append(t)
    story.append(P("* Podatke je potrebno iskazati unutar svakog razreda (stupac 2 do 11 obrasca MI-PI). "
                   "** Stupac 3 „% vol.” – volumni udio stvarnog alkohola u 1 hl piva, na jednu decimalu.", 6.5))
    story.append(Spacer(1, 6 * mm))
    udata = [[P("Ukupno", 9, True, 1), "", "", ""],
             [P(h, 8, True, 1) for h in ("Red. br.", "Volumni udio", "Količina hl", "Obračunata trošarina")],
             [P(x, 7, False, 1) for x in ("", "", "2", "4")]]
    for i, ci in enumerate(sorted(classes), 1):
        udata.append([P(str(i), 9, False, 1), P(labels[ci], 9), P(hr3(classes[ci]["hl"]), 9, True, 2),
                      P(hr2(classes[ci]["excise"]), 9, True, 2)])
    udata.append([P(""), P("SVEUKUPNO", 9, True), P(hr3(total_hl), 9, True, 2), P(hr2(summary["total_excise"]), 9, True, 2)])
    t = Table(udata, colWidths=[16 * mm, 40 * mm, 40 * mm, 45 * mm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.black), ("SPAN", (0, 0), (-1, 0)),
                           ("BACKGROUND", (0, 0), (-1, 2), HEAD), ("BACKGROUND", (1, 3), (-1, -2), GREEN),
                           ("BACKGROUND", (0, -1), (-1, -1), YELLOW)]))
    story.append(KeepTogether(t))
    story.append(Spacer(1, 6 * mm))

    # ---------------- popis istočenih piva (za arhivu)
    story.append(P("Istočeno pivo uključeno u prijavu (iz evidencije pakiranja / ručno dodano)", 10, True))
    ldata = [[P(h, 8, True) for h in ("Datum", "LOT piva", "Trgovački naziv", "hl", "% vol", "Uključeno")]]
    for e in entries:
        ldata.append([P(fmt(e["date"]) if e.get("date") else ""), P(e.get("batch_no") or "ručni unos"),
                      P(e.get("trade_name") or ""), P(hr3(e.get("hl") or 0), 9, False, 2),
                      P(f"{e['abv']:.1f}".replace(".", ",") if e.get("abv") else "—", 9, False, 2),
                      P("DA" if e["include"] else "ne")])
    t = Table(ldata, colWidths=[28 * mm, 40 * mm, 60 * mm, 25 * mm, 20 * mm, 25 * mm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), HEAD)]))
    story.append(t)

    def footer(c, d):
        c.saveState()
        c.setFont(body, 7)
        c.drawString(12 * mm, 7 * mm, f"{db.get_setting('company')} · pomoć za MI-PI {m_label} · izrađeno "
                                      f"{dt.datetime.now().strftime('%d.%m.%Y. %H:%M')} · nije službeni obrazac")
        c.drawRightString(landscape(A4)[0] - 12 * mm, 7 * mm, f"{d.page}")
        c.restoreState()

    doc = SimpleDocTemplate(path, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm,
                            bottomMargin=13 * mm, title=f"Pomoć za MI-PI {m_label}")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return path
