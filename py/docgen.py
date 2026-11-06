"""
Generator dokumenata za ispis (PDF preko reportlab, Word preko python-docx).
Dokument se opisuje jednom (klasa Doc s blokovima), a dva renderera ga crtaju u PDF i DOCX.

Blokovi:
  ("title", tekst)                       naslov u tijelu dokumenta
  ("meta", [(oznaka, vrijednost), ...])  Tvrtka / Verzija / Datum / Odobrila – u jednom retku
  ("h", tekst)                           naslov odjeljka
  ("p", tekst) / ("pb", tekst)           odlomak / podebljani odlomak
  ("note", tekst)                        sitna napomena
  ("kv", [(oznaka, vrijednost), ...])    polja "Oznaka: vrijednost"
  ("checks", [(tekst, True/False), ...], inline)   kućice ☒/☐
  ("table", zaglavlje, retci, širine(udjeli), opcije)  opcije: size, merge=[(r0, r1)], merge_cols=[...], align={col:'R'}
  ("sign", [(oznaka, vrijednost), ...])  potpisi
  ("space", mm)
"""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, KeepTogether

CHECK_ON, CHECK_OFF = "☒", "☐"
HEAD_BG = colors.HexColor("#EFE7D6")
GRID = colors.HexColor("#555555")


class Doc:
    def __init__(self, meta, company, logo=None, landscape_=False, filename="dokument"):
        self.meta = meta            # dict code, title, version, vdate (vdate već formatiran)
        self.company = company
        self.logo = logo if logo and os.path.exists(logo) else None
        self.landscape = landscape_
        self.filename = filename
        self.blocks = []

    def add(self, *block):
        self.blocks.append(block)
        return self


# ================================================================== PDF
_FONTS = None


def _register_fonts():
    global _FONTS
    if _FONTS:
        return _FONTS
    win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    cands = [
        (os.path.join(win, "arial.ttf"), os.path.join(win, "arialbd.ttf")),
        (os.path.join(win, "segoeui.ttf"), os.path.join(win, "segoeuib.ttf")),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
         "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
        ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ]
    body = bold = "Helvetica"
    for reg, bd in cands:
        if os.path.exists(reg) and os.path.exists(bd):
            pdfmetrics.registerFont(TTFont("Body", reg))
            pdfmetrics.registerFont(TTFont("Body-Bold", bd))
            body, bold = "Body", "Body-Bold"
            break
    sym = None
    for p in (os.path.join(win, "seguisym.ttf"), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            pdfmetrics.registerFont(TTFont("Sym", p))
            sym = "Sym"
            break
    _FONTS = (body, bold, sym)
    return _FONTS


SYMBOLS = (CHECK_ON, CHECK_OFF, "✔", "✖")


def _esc(t):
    s = (str(t if t is not None else "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") \
        .replace("\n", "<br/>")
    sym = _FONTS[2] if _FONTS else None
    for ch in SYMBOLS:
        if ch in s:
            s = s.replace(ch, f'<font name="{sym}">{ch}</font>' if sym else {CHECK_ON: "[X]", CHECK_OFF: "[ ]"}.get(ch, ch))
    return s


def _box(on, sym):
    if sym:
        return f'<font name="{sym}">{CHECK_ON if on else CHECK_OFF}</font>'
    return "[X]" if on else "[&nbsp;&nbsp;]"


def render_pdf(doc, path):
    body, bold, sym = _register_fonts()
    page = landscape(A4) if doc.landscape else A4
    W, H = page
    margin = 14 * mm
    head_h = 24 * mm
    st = {
        "p": ParagraphStyle("p", fontName=body, fontSize=9.5, leading=12.5, spaceAfter=3),
        "pb": ParagraphStyle("pb", fontName=bold, fontSize=9.5, leading=12.5, spaceAfter=3),
        "note": ParagraphStyle("note", fontName=body, fontSize=8, leading=10, textColor=colors.HexColor("#444444")),
        "h": ParagraphStyle("h", fontName=bold, fontSize=10.5, leading=14, spaceBefore=7, spaceAfter=3),
        "title": ParagraphStyle("title", fontName=bold, fontSize=13, leading=17, alignment=TA_CENTER, spaceAfter=6),
        "cell": ParagraphStyle("cell", fontName=body, fontSize=8.5, leading=10.5),
        "cellb": ParagraphStyle("cellb", fontName=bold, fontSize=8.5, leading=10.5),
        "hd": ParagraphStyle("hd", fontName=body, fontSize=8.5, leading=11),
        "hdt": ParagraphStyle("hdt", fontName=bold, fontSize=11, leading=14, alignment=TA_CENTER),
    }
    m = doc.meta
    usable = W - 2 * margin

    def header_table(page_no, total):
        logo_cell = []
        if doc.logo:
            try:
                img = Image(doc.logo)
                ratio = img.imageWidth / float(img.imageHeight)
                h = 15 * mm
                w = min(h * ratio, 45 * mm)
                img.drawWidth, img.drawHeight = w, w / ratio
                logo_cell.append(img)
            except Exception:
                pass
        logo_cell.append(Paragraph(f"<b>{_esc(doc.company)}</b>", st["hd"]))
        mid = [Paragraph("Naziv dokumenta:", st["hd"]), Paragraph(_esc(m["title"]), st["hdt"])]
        right = Paragraph(f"Šifra: <b>{_esc(m['code'])}</b><br/>Verzija: {_esc(m['version'])}&nbsp;&nbsp;&nbsp;"
                          f"Datum: {_esc(m['vdate'])}<br/>Stranica: {page_no} od {total}", st["hd"])
        t = Table([[logo_cell, mid, right]], colWidths=[usable * 0.24, usable * 0.48, usable * 0.28],
                  rowHeights=[head_h - 4 * mm])
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.7, GRID), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                               ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]))
        return t

    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._saved = []

        def showPage(self):
            self._saved.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved)
            for n, state in enumerate(self._saved, 1):
                self.__dict__.update(state)
                t = header_table(n, total)
                w, h = t.wrapOn(self, usable, head_h)
                t.drawOn(self, margin, H - margin - h)
                self.setFont(body, 7)
                self.setFillColor(colors.HexColor("#777777"))
                self.drawRightString(W - margin, 8 * mm, f"{doc.company} · {m['code']} · ispisano iz programa Pivovara · Skladište")
                super().showPage()
            super().save()

    story = []
    for b in doc.blocks:
        kind = b[0]
        if kind == "title":
            story.append(Paragraph(_esc(b[1]), st["title"]))
        elif kind in ("p", "pb", "note", "h"):
            story.append(Paragraph(_esc(b[1]), st[kind]))
        elif kind == "space":
            story.append(Spacer(1, b[1] * mm))
        elif kind == "meta":
            txt = "&nbsp;&nbsp;&nbsp;&nbsp;".join(f"{_esc(k)}: <b>{_esc(v)}</b>" for k, v in b[1])
            story.append(Paragraph(txt, st["p"]))
        elif kind == "kv":
            rows = [[Paragraph(_esc(k) + ":", st["cellb"]), Paragraph(_esc(v), st["cell"])] for k, v in b[1]]
            t = Table(rows, colWidths=[usable * 0.30, usable * 0.70])
            t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (1, 0), (1, -1), 0.3, colors.grey),
                                   ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
            story.append(t)
        elif kind == "checks":
            items, inline = b[1], (b[2] if len(b) > 2 else False)
            if inline == 2:
                half = (len(items) + 1) // 2
                cells = [[Paragraph(f"{_box(a[1], sym)} {_esc(a[0])}", st["p"]),
                          Paragraph(f"{_box(c[1], sym)} {_esc(c[0])}", st["p"]) if c else ""]
                         for a, c in zip(items[:half], items[half:] + [None])]
                t = Table(cells, colWidths=[usable / 2] * 2)
                t.setStyle(TableStyle([("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                                       ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
                story.append(t)
            elif inline:
                story.append(Paragraph("&nbsp;&nbsp;&nbsp;&nbsp;".join(f"{_box(on, sym)} {_esc(t)}" for t, on in items), st["p"]))
            else:
                for t, on in items:
                    story.append(Paragraph(f"{_box(on, sym)} {_esc(t)}", st["p"]))
        elif kind == "table":
            head, rows, widths = b[1], b[2], b[3]
            opt = b[4] if len(b) > 4 else {}
            size = opt.get("size", 8.5)
            cs = ParagraphStyle("c", parent=st["cell"], fontSize=size, leading=size + 2)
            hs = ParagraphStyle("hh", parent=st["cellb"], fontSize=size, leading=size + 2)
            right = opt.get("align", {})
            data = [[Paragraph(_esc(h), hs) for h in head]]
            for r in rows:
                data.append([Paragraph(("<para align='right'>" if right.get(i) == "R" else "") + _esc(c) +
                                       ("</para>" if right.get(i) == "R" else ""), cs) for i, c in enumerate(r)])
            t = Table(data, colWidths=[usable * w for w in widths], repeatRows=1)
            style = [("GRID", (0, 0), (-1, -1), 0.5, GRID), ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
                     ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                     ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5), ("LEFTPADDING", (0, 0), (-1, -1), 3),
                     ("RIGHTPADDING", (0, 0), (-1, -1), 3)]
            for r0, r1 in opt.get("merge", []):
                if r1 > r0:
                    for c in opt.get("merge_cols", []):
                        style.append(("SPAN", (c, r0 + 1), (c, r1 + 1)))
                style.append(("LINEABOVE", (0, r0 + 1), (-1, r0 + 1), 1.2, GRID))
            t.setStyle(TableStyle(style))
            story.append(t)
        elif kind == "sign":
            cells = [[Paragraph(f"{_esc(k)}:<br/><br/><b>{_esc(v)}</b><br/>_____________________", st["p"])
                      for k, v in b[1]]]
            t = Table(cells, colWidths=[usable / len(b[1])] * len(b[1]))
            t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
            story.append(KeepTogether([Spacer(1, 4 * mm), t]))
    pdf = SimpleDocTemplate(path, pagesize=page, leftMargin=margin, rightMargin=margin,
                            topMargin=margin + head_h + 2 * mm, bottomMargin=14 * mm,
                            title=m["title"], author=doc.company)
    pdf.build(story, canvasmaker=NumberedCanvas)
    return path


# ================================================================== DOCX
def render_docx(doc, path):
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor

    d = Document()
    stl = d.styles["Normal"]
    stl.font.name = "Arial"
    stl.font.size = Pt(9.5)
    stl.element.rPr.rFonts.set(qn("w:eastAsia"), "Arial")
    stl.paragraph_format.space_after = Pt(2)
    sec = d.sections[0]
    if doc.landscape:
        sec.orientation = WD_ORIENT.LANDSCAPE
        sec.page_width, sec.page_height = Mm(297), Mm(210)
    else:
        sec.page_width, sec.page_height = Mm(210), Mm(297)
    for side in ("left_margin", "right_margin", "bottom_margin"):
        setattr(sec, side, Mm(14))
    sec.top_margin, sec.header_distance = Mm(12), Mm(8)
    usable = (297 if doc.landscape else 210) - 28
    m = doc.meta

    def shade(cell, hexcolor="EFE7D6"):
        tcPr = cell._tc.get_or_add_tcPr()
        sh = OxmlElement("w:shd")
        sh.set(qn("w:val"), "clear")
        sh.set(qn("w:color"), "auto")
        sh.set(qn("w:fill"), hexcolor)
        tcPr.append(sh)

    def field(par, code):
        r = par.add_run()
        for tag, attr in (("w:fldChar", "begin"), ("w:instrText", code), ("w:fldChar", "end")):
            el = OxmlElement(tag)
            if tag == "w:fldChar":
                el.set(qn("w:fldCharType"), attr)
            else:
                el.set(qn("xml:space"), "preserve")
                el.text = attr
            r._r.append(el)
        return r

    def set_widths(table, widths_mm):
        table.autofit = False
        for row in table.rows:
            for i, c in enumerate(row.cells):
                if i < len(widths_mm):
                    c.width = Mm(widths_mm[i])

    def para(container, text="", bold=False, size=None, align=None, after=None):
        p = container.add_paragraph()
        lines = str(text if text is not None else "").split("\n")
        for i, ln in enumerate(lines):
            run = p.add_run(ln)
            run.bold = bold
            if size:
                run.font.size = Pt(size)
            if i < len(lines) - 1:
                run.add_break()
        if align == "C":
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif align == "R":
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        if after is not None:
            p.paragraph_format.space_after = Pt(after)
        return p

    def cell_text(cell, text, bold=False, size=8.5, align=None):
        cell.text = ""
        p = cell.paragraphs[0]
        lines = str(text if text is not None else "").split("\n")
        for i, ln in enumerate(lines):
            r = p.add_run(ln)
            r.bold = bold
            r.font.size = Pt(size)
            if i < len(lines) - 1:
                r.add_break()
        p.paragraph_format.space_after = Pt(0)
        if align == "R":
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        elif align == "C":
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # zaglavlje
    ht = sec.header.add_table(rows=1, cols=3, width=Mm(usable))
    ht.style = "Table Grid"
    ht.alignment = WD_TABLE_ALIGNMENT.CENTER
    c0, c1, c2 = ht.rows[0].cells
    c0.text = ""
    if doc.logo:
        try:
            c0.paragraphs[0].add_run().add_picture(doc.logo, height=Mm(13))
        except Exception:
            pass
        p = c0.add_paragraph()
    else:
        p = c0.paragraphs[0]
    r = p.add_run(doc.company)
    r.bold = True
    r.font.size = Pt(9)
    cell_text(c1, "Naziv dokumenta:", size=8.5)
    p = c1.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(m["title"])
    r.bold = True
    r.font.size = Pt(11)
    cell_text(c2, f"Šifra: {m['code']}\nVerzija: {m['version']}    Datum: {m['vdate']}", size=8.5)
    p = c2.add_paragraph()
    p.add_run("Stranica: ").font.size = Pt(8.5)
    field(p, "PAGE").font.size = Pt(8.5)
    p.add_run(" od ").font.size = Pt(8.5)
    field(p, "NUMPAGES").font.size = Pt(8.5)
    set_widths(ht, [usable * 0.24, usable * 0.48, usable * 0.28])
    sec.header.paragraphs[0].text = ""
    first = d.paragraphs[0] if d.paragraphs else d.add_paragraph()
    first.paragraph_format.space_after = Pt(4)

    for b in doc.blocks:
        kind = b[0]
        if kind == "title":
            para(d, b[1], bold=True, size=13, align="C", after=6)
        elif kind == "h":
            p = para(d, b[1], bold=True, size=10.5)
            p.paragraph_format.space_before = Pt(7)
        elif kind == "p":
            para(d, b[1])
        elif kind == "pb":
            para(d, b[1], bold=True)
        elif kind == "note":
            p = para(d, b[1], size=8)
            for r in p.runs:
                r.font.color.rgb = RGBColor(0x44, 0x44, 0x44)
        elif kind == "space":
            para(d, "", size=4)
        elif kind == "meta":
            p = d.add_paragraph()
            for i, (k, v) in enumerate(b[1]):
                p.add_run(("     " if i else "") + f"{k}: ")
                p.add_run(str(v or "")).bold = True
        elif kind == "kv":
            t = d.add_table(rows=0, cols=2)
            for k, v in b[1]:
                row = t.add_row().cells
                cell_text(row[0], f"{k}:", bold=True, size=9.5)
                cell_text(row[1], v, size=9.5)
            set_widths(t, [usable * 0.30, usable * 0.70])
        elif kind == "checks":
            items, inline = b[1], (b[2] if len(b) > 2 else False)
            if inline == 2:
                half = (len(items) + 1) // 2
                t = d.add_table(rows=half, cols=2)
                for i, (txt, on) in enumerate(items):
                    cell = t.cell(i % half, i // half)
                    cell.text = ""
                    r = cell.paragraphs[0].add_run(CHECK_ON if on else CHECK_OFF)
                    r.font.name = "Segoe UI Symbol"
                    cell.paragraphs[0].add_run(" " + txt)
                set_widths(t, [usable / 2] * 2)
            elif inline:
                p = d.add_paragraph()
                for i, (t, on) in enumerate(items):
                    r = p.add_run(("     " if i else "") + (CHECK_ON if on else CHECK_OFF))
                    r.font.name = "Segoe UI Symbol"
                    p.add_run(" " + t)
            else:
                for t, on in items:
                    p = d.add_paragraph()
                    r = p.add_run(CHECK_ON if on else CHECK_OFF)
                    r.font.name = "Segoe UI Symbol"
                    p.add_run(" " + t)
                    p.paragraph_format.space_after = Pt(0)
        elif kind == "table":
            head, rows, widths = b[1], b[2], b[3]
            opt = b[4] if len(b) > 4 else {}
            size = opt.get("size", 8.5)
            right = opt.get("align", {})
            t = d.add_table(rows=1 + len(rows), cols=len(head))
            t.style = "Table Grid"
            for i, h in enumerate(head):
                cell_text(t.rows[0].cells[i], h, bold=True, size=size)
                shade(t.rows[0].cells[i])
            trPr = t.rows[0]._tr.get_or_add_trPr()
            th = OxmlElement("w:tblHeader")
            th.set(qn("w:val"), "true")
            trPr.append(th)
            for ri, r in enumerate(rows, 1):
                for ci, c in enumerate(r):
                    cell_text(t.rows[ri].cells[ci], c, size=size, align=right.get(ci))
            for r0, r1 in opt.get("merge", []):
                if r1 > r0:
                    for c in opt.get("merge_cols", []):
                        a = t.cell(r0 + 1, c)
                        keep = a.text
                        merged = a.merge(t.cell(r1 + 1, c))
                        cell_text(merged, keep, size=size, align=right.get(c))
            set_widths(t, [usable * w for w in widths])
        elif kind == "sign":
            t = d.add_table(rows=1, cols=len(b[1]))
            for i, (k, v) in enumerate(b[1]):
                cell_text(t.rows[0].cells[i], f"{k}:\n\n{v or ''}\n_____________________", size=9.5)
            para(d, "")
    d.core_properties.title = m["title"]
    d.core_properties.author = doc.company
    d.save(path)
    return path


# ================================================================== Excel (tablični dokumenti, npr. evidencija kuhanja)
def _xl_num(v):
    """'25,00' / '1.234,5' -> broj; ostalo ostaje tekst."""
    import re
    t = str(v if v is not None else "").strip()
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})*(,\d+)?|-?\d+(,\d+)?", t):
        try:
            return float(t.replace(".", "").replace(",", ".")), (len(t.split(",")[1]) if "," in t else 0)
        except ValueError:
            pass
    return None, 0


def render_xlsx(doc, path):
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    wb = openpyxl.Workbook()
    ws = wb.active
    m = doc.meta
    ws.title = (m.get("code") or "Evidencija")[:31]
    thin = Side(style="thin", color="BFBFBF")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill("solid", fgColor="EDEAE3")
    r = 1
    ws.cell(r, 1, m.get("title") or "").font = Font(bold=True, size=14)
    r += 1
    ws.cell(r, 1, doc.company or "").font = Font(size=10)
    r += 1
    ws.cell(r, 1, f"Šifra: {m.get('code', '')} · Verzija: {m.get('version', '')} · Datum: {m.get('vdate', '')}").font = Font(size=9, color="666666")
    r += 2
    widths = {}
    for b in doc.blocks:
        kind = b[0]
        if kind in ("title", "h", "pb"):
            ws.cell(r, 1, b[1]).font = Font(bold=True, size=12 if kind != "pb" else 11)
            r += 1
        elif kind in ("p", "note"):
            ws.cell(r, 1, b[1]).font = Font(size=9 if kind == "note" else 10, italic=kind == "note")
            r += 1
        elif kind in ("meta", "kv", "sign"):
            for k, v in b[1]:
                ws.cell(r, 1, f"{k}:").font = Font(bold=True, size=10)
                ws.cell(r, 2, v or "")
                r += 1
            r += 1
        elif kind == "table":
            head, rows = b[1], b[2]
            share = b[3] if len(b) > 3 else None
            opts = b[4] if len(b) > 4 and isinstance(b[4], dict) else {}
            rows = [x for x in rows if any(str(c or "").strip() for c in x)]  # bez praznih redaka za ručni upis
            top = r
            for j, t in enumerate(head, 1):
                c = ws.cell(r, j, t)
                c.font = Font(bold=True, size=10)
                c.fill = head_fill
                c.border = border
                c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
            r += 1
            for row in rows:
                al = opts.get("align") or {}
                for j, v in enumerate(row, 1):
                    # brojevi samo u brojčanim stupcima (desno poravnanje) ili s decimalnim zarezom – LOT ostaje tekst
                    num, dec = _xl_num(v) if (al.get(j - 1) == "R" or "," in str(v or "")) else (None, 0)
                    c = ws.cell(r, j, num if num is not None else (v if v not in (None, "") else None))
                    c.border = border
                    c.alignment = Alignment(vertical="top", wrap_text=True)
                    if num is not None:
                        c.number_format = "#,##0" + ("." + "0" * dec if dec else "")
                    widths[j] = max(widths.get(j, 0), min(40, len(str(v or "")) + 2))
                r += 1
            # spojene ćelije (npr. LOT piva kroz sve retke sirovina)
            orig = [x for x in b[2]]
            idx, k = {}, 0
            for i, x in enumerate(orig):
                if any(str(c or "").strip() for c in x):
                    idx[i] = k
                    k += 1
            for r0, r1 in opts.get("merge", []):
                if r0 in idx and r1 in idx and idx[r1] > idx[r0]:
                    for col in opts.get("merge_cols", []):
                        a, z = top + 1 + idx[r0], top + 1 + idx[r1]
                        ws.merge_cells(start_row=a, start_column=col + 1, end_row=z, end_column=col + 1)
            for j, t in enumerate(head, 1):
                widths[j] = max(widths.get(j, 0), min(18, len(str(t)) + 2), 8)
            ws.freeze_panes = ws.cell(top + 1, 1)
            r += 1
    for j, w in widths.items():
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.page_setup.orientation = "landscape" if doc.landscape else "portrait"
    ws.page_setup.fitToWidth = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToHeight = 0
    wb.save(path)
    return path


def render(doc, folder, fmt="PDF"):
    os.makedirs(folder, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_ .–(),#" else "_" for ch in doc.filename).strip(" .")
    safe = safe[:150].rstrip(" .")
    F = fmt.upper()
    ext = ".xlsx" if F in ("EXCEL", "XLSX", "XLS") else ".docx" if F.startswith("W") or F == "DOCX" else ".pdf"
    path = os.path.join(folder, safe + ext)
    n = 2
    while os.path.exists(path):
        try:
            os.remove(path)  # prepiši stari ispis ako nije otvoren
            break
        except OSError:
            path = os.path.join(folder, f"{safe} ({n}){ext}")
            n += 1
    if ext == ".xlsx":
        return render_xlsx(doc, path)
    return render_docx(doc, path) if ext == ".docx" else render_pdf(doc, path)


if __name__ == "__main__":  # brzi test
    dd = Doc({"code": "TEST-1", "title": "PROBNI DOKUMENT ČĆŽŠĐ", "version": "1", "vdate": "13.03.2026."},
             "Moja pivovara d.o.o.", landscape_=len(sys.argv) > 1)
    dd.add("title", "PROBNI DOKUMENT").add("meta", [("Tvrtka", "Moja pivovara d.o.o."), ("Verzija", "1")])
    dd.add("checks", [("DA", True), ("NE", False)], True)
    dd.add("table", ["A", "B", "C"], [["1", "2", "3"], ["", "x", "y"]], [0.2, 0.4, 0.4], {"merge": [(0, 1)], "merge_cols": [0]})
    dd.add("sign", [("Operater", "Ivo Ivić"), ("Voditelj", "Marko Marić")])
    print(render(dd, "/tmp", "PDF"), render(dd, "/tmp", "DOCX"))
