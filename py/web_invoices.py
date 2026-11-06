"""Računi dobavljača: učitavanje računa (PDF, e-račun XML ili fotografija), prijedlog primke, primka robe
(LOT-ovi s cijenom i brojem računa, narudžbenica, HACCP zapisnik o prijemu) i evidencija plaćanja.

Čitanje PDF-a radi bez vanjskih servisa (pypdf u pregledniku): iz teksta se traže OIB, broj i datumi računa,
IBAN, iznos i stavke. Program pamti koja stavka dobavljača je koji artikl i koliko je to u jedinici artikla
(npr. "Pilsner slad 25 kg" × 1 kom = 25 kg), pa je svaki sljedeći račun istog dobavljača brži.
"""
import datetime as dt
import json
import os
import re
import unicodedata

OUT = "/out"


# ------------------------------------------------------------------ tablice
def ensure(db):
    db.con.executescript("""
    CREATE TABLE IF NOT EXISTS supplier_invoices(
        id INTEGER PRIMARY KEY, supplier_id INTEGER, inv_no TEXT, inv_date TEXT, recv_date TEXT, due_date TEXT,
        total REAL, iban TEXT, pay_model TEXT, pay_ref TEXT, file_path TEXT, file_name TEXT, file_type TEXT,
        paid_date TEXT, note TEXT, lines TEXT, created TEXT, created_by TEXT);
    CREATE TABLE IF NOT EXISTS invoice_item_map(
        supplier_id INTEGER, key TEXT, item_id INTEGER, factor REAL DEFAULT 1, skip INTEGER DEFAULT 0,
        PRIMARY KEY(supplier_id, key));
    """)
    cols = {r["name"] for r in db.q("PRAGMA table_info(lots)")}
    if "invoice_id" not in cols:
        db.con.execute("ALTER TABLE lots ADD COLUMN invoice_id INTEGER")
    if "invoice_no" not in cols:
        db.con.execute("ALTER TABLE lots ADD COLUMN invoice_no TEXT")
    db.con.commit()


# ------------------------------------------------------------------ pomoćno
def _norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9/]+", " ", s).strip()


def _key(name):
    """Ključ stavke dobavljača za pamćenje (bez brojeva redaka i višestrukih razmaka)."""
    return _norm(name)[:80]


DATE_RE = re.compile(r"\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})\b\.?")


def _date(s):
    m = DATE_RE.search(s or "")
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def _dates(s):
    out = []
    for m in DATE_RE.finditer(s or ""):
        v = _date(m.group(0))
        if v:
            out.append(v)
    return out


class Num:
    """Brojevi na računu: hrvatski zapis (1.234,56) ili engleski (1,234.56) – odluči se za cijeli dokument."""
    RE = re.compile(r"(?<![\w.,])-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d+)?(?![\w])|(?<![\w.,])-?\d+(?:[.,]\d+)?(?![\w])")

    def __init__(self, text):
        hr = len(re.findall(r"\d,\d{2}\b", text))
        en = len(re.findall(r"\d\.\d{2}\b(?!\.\d)", text)) - len(DATE_RE.findall(text))
        self.hr = hr >= en

    def val(self, s):
        s = s.strip().replace(" ", "").replace(" ", "")
        if self.hr:
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
        try:
            return float(s)
        except ValueError:
            return None

    def all(self, s):
        out = []
        for m in self.RE.finditer(s):
            v = self.val(m.group(0))
            if v is not None:
                out.append((v, m.start(), m.end()))
        return out


UNITS = {"kg": "kg", "kilogram": "kg", "g": "g", "gr": "g", "l": "l", "lit": "l", "litra": "l", "ml": "ml",
         "kom": "kom", "kom.": "kom", "komad": "kom", "kos": "kom", "pc": "kom", "pcs": "kom", "kut": "kom",
         "pak": "kom", "pkt": "kom", "vreća": "kom", "vreca": "kom", "vr": "kom", "boca": "kom", "kanta": "kom",
         "set": "kom", "ko": "kom", "kos.": "kom", "pak.": "kom", "h87": "kom", "kgm": "kg", "grm": "g", "ltr": "l", "mlt": "ml", "c62": "kom"}
SKIP_WORDS = ("kontrolna", "šifra kupca", "izradio", "preuzeo", "terminal", "iznos:", "rabat:", "već plaćeno", "ostaje za", "mobile", "email", "trr", "swift", "vat id", "kraj računa",
              "ukupno", "osnovica", "porez", "pdv ", "pdv:", "za platiti", "za uplatu", "rekapitulacija", "sveukupno",
              "iznos bez", "iznos pdv", "total", "subtotal", "popust na", "zaokruž", "napomena", "stranica", "uplatiti",
              "jir", "zki", "iban", "poziv na broj", "dospijeć", "datum", "oib", "tel", "e-mail", "www", "račun br")
OUR_UNIT = {"kg": ("kg", 1), "g": ("kg", 0.001), "l": ("l", 1), "ml": ("l", 0.001)}


def _unit_factor(inv_unit, item_unit, name):
    """Koliko jedinica artikla je jedna jedinica s računa. Vraća (faktor, siguran?)."""
    iu = UNITS.get((inv_unit or "").lower().strip("."), (inv_unit or "").lower())
    au = (item_unit or "").lower().strip()
    if iu == au:
        return 1.0, True
    conv = {("g", "kg"): 0.001, ("kg", "g"): 1000, ("ml", "l"): 0.001, ("l", "ml"): 1000}
    if (iu, au) in conv:
        return conv[(iu, au)], True
    if iu in ("kom", "") and au in ("kg", "g", "l", "ml"):
        # pakiranje u nazivu: "Pilsner 25 kg", "Saaz T90 100g", "Philly Sour 500 g", "pire 3 kg"
        m = re.findall(r"(\d+(?:[.,]\d+)?)\s*(kg|g|gr|l|ml)\b", (name or "").lower())
        if m:
            q, u = m[-1]
            q = float(q.replace(",", "."))
            u = {"gr": "g"}.get(u, u)
            if (u, au) in conv:
                return q * conv[(u, au)], True
            if u == au:
                return q, True
    return 1.0, False


# ------------------------------------------------------------------ čitanje računa
def parse_file(db, path, kind=None):
    """Pročitaj račun -> {header, lines, kind, text}. kind: pdf | xml | image."""
    ensure(db)
    ext = os.path.splitext(path)[1].lower()
    kind = kind or ("pdf" if ext == ".pdf" else "xml" if ext == ".xml" else "image")
    if kind == "xml":
        with open(path, "rb") as f:
            res = parse_ubl(f.read())
        res["kind"] = "xml"
        return res
    if kind != "pdf":
        return {"kind": "image", "header": {}, "lines": [], "text": ""}
    import pypdf
    reader = pypdf.PdfReader(path)
    # e-račun s priloženim XML-om (UBL) – najpouzdanije
    try:
        for name, datas in (reader.attachments or {}).items():
            if name.lower().endswith(".xml"):
                res = parse_ubl(datas[0])
                if res["lines"] or res["header"].get("inv_no"):
                    res["kind"] = "pdf+xml"
                    return res
    except Exception:  # noqa: BLE001
        pass
    pages = []
    for p in reader.pages[:6]:
        try:
            pages.append(p.extract_text(extraction_mode="layout") or "")
        except Exception:  # noqa: BLE001
            pages.append(p.extract_text() or "")
    text = "\n".join(pages)
    res = parse_text(db, text)
    res["kind"] = "pdf"
    if not text.strip():
        res["scan"] = True  # skenirani PDF (slika) – nema teksta
    return res


def parse_text(db, text):
    num = Num(text)
    lines = [ln.rstrip() for ln in text.splitlines()]
    flat = "\n".join(re.sub(r"\s{2,}", "  ", ln.strip()) for ln in lines)
    low = flat.lower()
    g = db.get_setting
    our_oib = re.sub(r"\D", "", g("company_oib") or "")
    our_iban = re.sub(r"\s", "", (g("dn_iban") or "") + " " + (g("offer_iban") or "")).upper()
    hdr = {}
    # OIB dobavljača: prvi OIB koji nije naš; strani dobavljač: PDV ID (npr. SI70701873)
    for m in re.finditer(r"(?<!\d)(\d{11})(?!\d)", flat):
        if m.group(1) != our_oib:
            hdr["oib"] = m.group(1)
            break
    if not hdr.get("oib"):
        for m in re.finditer(r"(?:VAT\s*(?:ID|No\.?|number)|PDV\s*ID(?:\s*broj)?|ID\s*za\s*DDV|ID\s*za\s*PDV|UID)\s*[:.]?\s*([A-Z]{2}\s?[0-9A-Z]{8,12})", flat, re.I):
            v = re.sub(r"\s", "", m.group(1)).upper()
            if our_oib not in v:
                hdr["oib"] = v
                break
    # broj računa
    for pat in [r"fiskalni\s+br(?:oj)?\.?\s*ra[čc]una\s*[:.]?\s*(\d[\d/\-]*\d)",
                r"(?:ra[čc]un|r-1|r1|faktura|invoice)[^\n]{0,25}?(?:br(?:oj)?\.?|no\.?|#|:)\s*[:.]?\s*([A-Z0-9][\w\-/\.]*\d[\w\-/]*)",
                r"broj\s+ra[čc]una\s*[:.]?\s*([A-Z0-9][\w\-/\.]*)",
                r"\b(?:br\.|broj)\s*[:.]?\s*(\d[\w\-/]*\d)"]:
        m = re.search(pat, flat, re.I)
        if m:
            v = m.group(1).strip(".")
            if not DATE_RE.fullmatch(v) and v != hdr.get("oib"):
                hdr["inv_no"] = v
                break
    # datumi
    def after(labels):
        for lab in labels:
            m = re.search(lab + r"[^\n\d]{0,40}(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4})", flat, re.I)
            if m:
                return _date(m.group(1))
        return None
    hdr["inv_date"] = after([r"datum\s+(?:i\s+vrijeme\s+)?(?:ra[čc]una|izdavanja|izdano|isporuke)", r"datum\s+dokumenta",
                             r"\bdatum\b", r"\bizdano\b"]) or (_dates(flat) or [None])[0]
    due = after([r"dospije[ćc]", r"rok\s+pla[ćc]anja", r"valuta\s+pla[ćc]anja", r"datum\s+pla[ćc]anja", r"\bvaluta\b"])
    if not due:
        m = re.search(r"(?:rok\s+pla[ćc]anja|pla[ćc]anje\s+u\s+roku|valuta)[^\n\d]{0,20}(\d{1,3})\s*dan", flat, re.I)
        if m and hdr.get("inv_date"):
            due = (dt.date.fromisoformat(hdr["inv_date"]) + dt.timedelta(days=int(m.group(1)))).isoformat()
    hdr["due_date"] = due
    # IBAN (nije naš)
    from web_offers import iban_ok
    for m in re.finditer(r"\b([A-Z]{2}\d{2}(?:\s?[0-9A-Z]{1,4}){3,8})\b", flat):
        iban = re.sub(r"\s", "", m.group(1))
        if iban not in our_iban and iban_ok(iban):
            hdr["iban"] = iban
            break
    m = re.search(r"poziv\s+na\s+broj[^\n:]*:\s*(?:([A-Z]{2})?(\d{2})\s+)?([0-9][0-9\-]{0,21})", flat, re.I)
    if m:
        cc = m.group(1) or ((hdr.get("iban") or "HR")[:2])
        hdr["pay_model"] = f"{cc}{m.group(2) or '00'}"
        hdr["pay_ref"] = m.group(3).strip("-")
    # već plaćeno (kartica, gotovina, "ostaje za uplatu 0,00")
    if re.search(r"(ostaje\s+za\s+uplatu|preostalo\s+za\s+uplatu)\D{0,15}0[,.]00\b|credit\s+card|kartic[ae]m?\b|gotovin|pla[ćc]eno\s+karticom|na[čc]in\s+pla[ćc]anja[^\n]{0,15}(kartic|gotovin)", flat, re.I):
        hdr["paid"] = True
    # ukupan iznos
    for lab in [r"za\s+platiti", r"(?<!ostaje )za\s+uplatu", r"ukupno\s+za\s+pla[ćc]anje", r"iznos\s+s\s+pdv", r"sveukupno", r"ukupan\s+iznos",
                r"ukupno\s+(?:eur|€)", r"iznos\s+ra[čc]una", r"ukupno\s+s\s+pdv", r"\bukupno\b", r"\btotal\b"]:
        best = None
        for m in re.finditer(lab + r"[^\n]*", flat, re.I):
            if re.search(r"komada|te[žz]|ambala|koli[čc]ina|ostaje", m.group(0), re.I):
                continue
            ns = [v for v, _, _ in num.all(m.group(0)) if v > 0 and not (v.is_integer() and 1990 < v < 2100)]
            if ns:
                best = ns[-1]
        if best:
            hdr["total"] = round(best, 2)
            break
    # dobavljač: poznati po OIB-u ili nazivu, inače redak s "d.o.o." / "obrt" na vrhu
    hdr["supplier_name"] = None
    ours = _norm(g("dn_company") or "")
    for ln in lines[:30]:
        t = ln.strip()
        for part in re.split(r"\s{3,}", t):
            if re.search(r"\b(d\.\s?o\.\s?o|j\.\s?d\.\s?o\.\s?o|d\.\s?d|obrt|gmbh|s\.r\.o|kft|ltd)\b\.?", part, re.I):
                if ours and _norm(part).startswith(ours[:8]):
                    continue
                hdr["supplier_name"] = part.strip(" ,;:")
                break
        if hdr["supplier_name"]:
            break
    # stavke
    out = []
    for i, ln in enumerate(lines):
        it = _parse_line(ln, num)
        if not it:
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        for src in (ln, nxt):
            m = re.search(r"\b(?:lot|šarža|sarza|batch)\s*(?:br\.?|no\.?)?\s*[:#]\s*([A-Z0-9][\w\-/\. ]{2,40})", src, re.I) \
                or re.search(r"\b(?:lot)\s+([A-Z0-9][\w\-/\.]{2,})", src)
            if m and not it.get("lot_no") and (src is ln or not _parse_line(src, num)):
                it["lot_no"] = re.split(r"\s{2,}", m.group(1).strip())[0].strip(" .")
            m = re.search(r"(?:rok|exp|bbd|mhd|upotrijebiti\s+do|best\s+before)[^\d]{0,15}(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}[./]\d{4})", src, re.I)
            if m and not it.get("expiry"):
                v = m.group(1)
                it["expiry"] = _date(v) if v.count(".") + v.count("/") == 2 else _month_end(v)
        out.append(it)
    return {"header": hdr, "lines": out, "text": flat[:6000]}


def _month_end(v):
    m = re.match(r"(\d{1,2})[./](\d{4})", v)
    if not m:
        return None
    y, mo = int(m.group(2)), int(m.group(1))
    if not 1 <= mo <= 12:
        return None
    d = dt.date(y + (mo == 12), mo % 12 + 1, 1) - dt.timedelta(days=1)
    return d.isoformat()


def _tok(t, num):
    """Jedan stupac/riječ iza naziva: ('num', v, postotak?, decimala) | ('unit', u) | ('numunit', v, u) | None."""
    t = t.strip().replace("€", "").replace("EUR", "").replace("eur", "").strip()
    if not t:
        return None
    w = t.lower().strip(".")
    if w in UNITS or t.lower() in UNITS:
        return ("unit", UNITS.get(t.lower(), UNITS.get(w)))
    m = re.fullmatch(r"(-?[\d.,]+)\s*(%?)", t)
    if m and re.search(r"\d", m.group(1)):
        v = num.val(m.group(1))
        sep = "," if num.hr else "."
        dec = len(m.group(1).split(sep)[1]) if sep in m.group(1) else 0
        return ("num", v, bool(m.group(2)), dec) if v is not None else None
    m = re.fullmatch(r"(-?[\d.,]+)\s*([A-Za-zčćšž]{1,6}\.?)", t)
    if m and (m.group(2).lower() in UNITS or m.group(2).lower().strip(".") in UNITS):
        v = num.val(m.group(1))
        u = UNITS.get(m.group(2).lower(), UNITS.get(m.group(2).lower().strip(".")))
        return ("numunit", v, u) if v is not None else None
    return None


LETTERS = r"[A-Za-zČčĆćŠšŽžĐđ]"
LOT_IN_NAME = re.compile(r"[-\s]+([A-Z]{0,3}\d{2,4}-\d{6,}(?:-\d{1,3})?)-?\s*$")


def _parse_line(ln, num):
    s = ln.strip()
    if not s or not re.search(LETTERS + "{3,}", s):
        return None
    low = s.lower()
    if any(w in low for w in SKIP_WORDS) or "@" in s or "www." in low:
        return None
    s2 = re.sub(r"^\d{1,3}[.)]?\s+", "", s)  # redni broj
    cols = [c for c in re.split(r"\s{3,}|\t", s2.strip()) if c.strip()]
    rest_words = None
    if len(cols) >= 3:
        # stupci (PDF s tablicom): naziv je prvi stupac sa slovima; šifra/EAN ispred njega se preskače
        ni = None
        for k, c in enumerate(cols):
            if re.search(LETTERS + "{3,}", c) and _tok(c, num) is None and not (" " not in c and re.search(r"\d{4,}", c) and not re.search(r"[a-zčćšž]{3,}", c)):
                ni = k
                break
        # šifra kao zaseban stupac bez razmaka (npr. "CRYST", "WEY-PIL25") ispred pravog naziva
        if ni is not None and " " not in cols[ni].strip() and ni + 1 < len(cols) and re.search(LETTERS + "{3,}", cols[ni + 1]) \
                and _tok(cols[ni + 1], num) is None and (" " in cols[ni + 1].strip() or cols[ni].isupper()):
            ni += 1
        if ni is not None:
            name_words = cols[ni].split()
            rest_words = " ".join(cols[ni + 1:]).split()
            if len(name_words) > 1 and (re.fullmatch(r"\d{5,}", name_words[0]) or ("-" in name_words[0] and re.search(r"\d", name_words[0])
                                                                                    and not re.search(r"[a-zčćšž]{3,}", name_words[0]))):
                name_words = name_words[1:]  # EAN / šifra
    if rest_words is None:
        # bez stupaca: s kraja skupljaj brojeve i jedinice, ostalo je naziv
        words = s2.split()
        i = len(words)
        while i > 0 and (_tok(words[i - 1], num) is not None or words[i - 1] in ("%", "€", "EUR", "x", "*", "-")):
            i -= 1
        name_words, rest_words = words[:i], words[i:]
        if len(name_words) > 1 and re.search(r"\d", name_words[0]) and not re.search(r"[a-zčćšž]{3,}", name_words[0]):
            name_words = name_words[1:]  # šifra artikla
    name = " ".join(name_words).replace("®", "").replace("™", "").strip(" -:;,")
    name = re.sub(r"\s{2,}", " ", name)
    lot = None
    m = LOT_IN_NAME.search(name)
    if m:
        lot, name = m.group(1), name[:m.start()].strip(" -")
    if len(name) < 3 or not re.search(LETTERS + "{3,}", name):
        return None
    toks = []
    for w in rest_words:
        if w == "%" and toks and toks[-1][0] == "num":
            toks[-1] = ("num", toks[-1][1], True, toks[-1][3])
            continue
        t = _tok(w, num)
        if t is None:
            continue  # npr. oznaka PDV-a "A", "-"
        if t[0] == "numunit":
            toks.append(("num", t[1], False, 0))
            toks.append(("unit", t[2]))
        else:
            toks.append(t)
    nums = [(k, t) for k, t in enumerate(toks) if t[0] == "num"]
    if len(nums) < 2:
        return None
    unit_after = {k: (toks[k + 1][1] if k + 1 < len(toks) and toks[k + 1][0] == "unit" else None) for k, _ in nums}
    unit_before = {k: (toks[k - 1][1] if k > 0 and toks[k - 1][0] == "unit" else None) for k, _ in nums}
    pos = [(k, t[1], t[2], t[3]) for k, t in nums]
    pcts = [v for k, v, pct, d in pos if pct and 0 < v < 100]
    # traži količinu q, cijenu p (i rabat r) tako da q·p·(1−r) = neki iznos A desno od njih (bez PDV-a ili s PDV-om)
    best = None
    for ai, (ak, A, apct, _) in enumerate(pos):
        if A <= 0 or apct:
            continue
        left = [(k, v, d) for k, v, pct, d in pos[:ai] if v > 0 and not pct]
        for qk, q, qd in left:
            for pk, p, pd in left:
                if pk == qk:
                    continue
                rabs = pcts + [v for k2, v, d2 in left if k2 not in (qk, pk) and 0 < v < 100 and k2 > max(qk, pk)]
                for r in [0.0] + rabs:
                    base = q * p * (1 - r / 100)
                    for vat in (0, 25, 13, 5):
                        if base and abs(base * (1 + vat / 100) - A) <= max(0.02, A * 0.006):
                            # bolje: iznos bez PDV-a, veći iznos, količina uz jedinicu, cijena s više decimala
                            score = (vat == 0, round(A, 2), pd >= qd,
                                     2 if unit_after.get(qk) else (1 if unit_before.get(qk) else 0), -qk)
                            if not best or score > best[0]:
                                best = (score, qk, q, p, r, base)
                            break
    if best:
        _, qk, q, p, r, net = best
    else:
        if not any(t[0] == "unit" for t in toks):
            return None  # bez jedinice i bez računice količina × cijena – nije stavka (adresa, šifra kupca…)
        withu = [(k, v) for k, v, pct, d in pos[:-1] if unit_after.get(k) and v > 0]
        cand = withu[-1] if withu else next(((k, v) for k, v, pct, d in pos[:-1] if v > 0 and not pct), None)
        if not cand:
            return None
        qk, q = cand
        r, net = 0.0, pos[-1][1]
        if net <= 0:
            return None
    unit = unit_after.get(qk) or unit_before.get(qk) or ""
    if not unit:
        us = [t[1] for t in toks if t[0] == "unit"]
        unit = us[0] if len(us) == 1 else ""
    out = {"name": name, "qty": round(q, 4), "unit": unit, "amount": round(net, 2),
           "unit_price": round(net / q, 4) if q else 0, "discount": r or 0, "raw": s[:200]}
    if lot:
        out["lot_no"] = lot
    return out


def parse_ubl(data):
    """E-račun (UBL 2.1 / EN 16931, hrvatski e-račun) -> zaglavlje i stavke."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(data if isinstance(data, (bytes, bytearray)) else str(data).encode())

    def local(t):
        return t.split("}")[-1]

    def find(el, *path):
        cur = [el]
        for p in path:
            nxt = []
            for c in cur:
                nxt += [x for x in list(c) if local(x.tag) == p]
            cur = nxt
            if not cur:
                return None
        return cur[0]

    def txt(el, *path):
        e = find(el, *path)
        return e.text.strip() if e is not None and e.text else None

    def fl(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    sup = find(root, "AccountingSupplierParty", "Party")
    hdr = {"inv_no": txt(root, "ID"), "inv_date": txt(root, "IssueDate"),
           "due_date": txt(root, "DueDate") or txt(root, "PaymentMeans", "PaymentDueDate") or txt(root, "PaymentTerms", "PaymentDueDate"),
           "total": fl(txt(root, "LegalMonetaryTotal", "PayableAmount"))}
    if sup is not None:
        hdr["supplier_name"] = (txt(sup, "PartyLegalEntity", "RegistrationName") or txt(sup, "PartyName", "Name"))
        oib = txt(sup, "PartyTaxScheme", "CompanyID") or txt(sup, "PartyLegalEntity", "CompanyID") or txt(sup, "EndpointID") or ""
        m = re.search(r"\d{11}", oib)
        hdr["oib"] = m.group(0) if m else None
        hdr["address"] = " ".join(x for x in [txt(sup, "PostalAddress", "StreetName"), txt(sup, "PostalAddress", "PostalZone"),
                                               txt(sup, "PostalAddress", "CityName")] if x) or None
    pm = find(root, "PaymentMeans")
    if pm is not None:
        hdr["iban"] = txt(pm, "PayeeFinancialAccount", "ID")
        pid = txt(pm, "PaymentID") or ""
        m = re.match(r"(HR\d{2})\s*(.*)", pid)
        hdr["pay_model"], hdr["pay_ref"] = (m.group(1), m.group(2)) if m else ("HR00" if pid else None, pid or None)
    lines = []
    for el in root.iter():
        if local(el.tag) not in ("InvoiceLine", "CreditNoteLine"):
            continue
        q_el = find(el, "InvoicedQuantity")
        if q_el is None:
            q_el = find(el, "CreditedQuantity")
        qty = fl(q_el.text) if q_el is not None else None
        ucode = (q_el.get("unitCode") if q_el is not None else "") or ""
        amount = fl(txt(el, "LineExtensionAmount")) or 0
        name = txt(el, "Item", "Name") or txt(el, "Item", "Description") or ""
        lot = None
        for ip in el.iter():
            if local(ip.tag) == "AdditionalItemProperty":
                n = (txt(ip, "Name") or "").lower()
                if "lot" in n or "šarž" in n or "batch" in n:
                    lot = txt(ip, "Value")
        if not qty:
            continue
        lines.append({"name": name, "qty": qty, "unit": UNITS.get(ucode.lower(), ucode.lower()), "amount": round(amount, 2),
                      "unit_price": round(amount / qty, 4) if qty else 0, "discount": 0, "lot_no": lot, "raw": name})
    return {"header": hdr, "lines": lines, "text": ""}


# ------------------------------------------------------------------ prijedlog primke
SUP_STOP = {"d", "o", "doo", "dd", "jdoo", "obrt", "hrvatska", "croatia", "zagreb", "gmbh", "ltd", "s", "r", "sro", "kft", "the", "i", "and"}
# riječi koje ne razlikuju artikle (proizvođač, vrsta, pakiranje)
ITEM_STOP = {"weyermann", "castle", "chateau", "simpsons", "simpson", "crisp", "bestmalz", "best", "dingemans", "briess", "muntons",
             "fermentis", "lallemand", "lalbrew", "mangrove", "jacks", "white", "labs", "wyeast", "usa", "us", "cz", "de", "uk", "nz", "si",
             "malt", "slad", "type", "typ", "hmelj", "hops", "hop", "pellets", "pelete", "pellet", "t90", "t45", "kvasac", "yeast", "dry",
             "suhi", "za", "of", "kg", "g", "kom", "pak", "vreca", "bag", "ebc", "1kg", "25kg", "500g", "100g", "pire"}
ALIAS_PAIRS = {"pale ale": "pale", "wheat": "wheat", "maris otter": "maris otter", "višnja": "visnja", "visnja": "visnja"}


def _match_item(name, items):
    """Artikl za naziv s računa: najveći udio značajnih riječi artikla koje se nalaze u nazivu (bez proizvođača i vrste)."""
    from web_costs import ALIASES, _norm as cnorm
    n = _norm(name)
    for k, v in ALIASES.items():  # npr. "s-04" -> "SafAle S-04"
        if re.search(r"(?<![a-z0-9])" + re.escape(_norm(k)) + r"(?![a-z0-9])", n):
            hit = [i for i in items if cnorm(i["name"]) == cnorm(v)]
            if hit and len(_norm(k)) >= 4:
                return hit[0]["id"]
    toks = {t for t in re.sub(r"\b\d+(?:[.,]\d+)?\s*(kg|g|gr|l|ml|kom)\b", " ", n).split() if t not in ITEM_STOP and len(t) > 1}
    if not toks:
        return None
    best, bs, tie = None, 0.0, False
    for it in items:
        it_t = {t for t in _norm(it["name"]).split() if t not in ITEM_STOP and len(t) > 1}
        if not it_t:
            continue
        ov = len(toks & it_t)
        if not ov or ov / len(it_t) < 0.75:
            continue
        sc = ov / len(it_t) + ov / len(toks) * 0.5
        if sc > bs + 1e-9:
            best, bs, tie = it["id"], sc, False
        elif abs(sc - bs) < 1e-9:
            tie = True
    return None if tie or bs < 0.75 else best


def prepare(db, parsed, supplier_id=None):
    """Dopuni pročitani račun: dobavljač, artikl za svaku stavku, količina u jedinici artikla, rok, narudžbenica."""
    ensure(db)
    from web_costs import match_item
    hdr = dict(parsed.get("header") or {})
    sups = db.q("SELECT * FROM suppliers")
    idn = lambda v: re.sub(r"[^0-9A-Z]", "", str(v or "").upper())
    if not supplier_id and hdr.get("oib"):
        supplier_id = next((s["id"] for s in sups if s.get("oib") and idn(s["oib"]) in (idn(hdr["oib"]), idn(hdr["oib"])[2:])), None)
    if not supplier_id:
        # naziv: sve značajne riječi naziva dobavljača (bez "d.o.o.", "Hrvatska"…) nalaze se na vrhu računa
        words = set(_norm((hdr.get("supplier_name") or "") + " " + (parsed.get("text") or "")[:2500]).split())
        best = None
        for s in sups:
            toks = [t for t in _norm(s["name"]).split() if t not in SUP_STOP and len(t) > 1]
            if toks and all(t in words for t in toks) and len("".join(toks)) >= 4:
                if not best or len(toks) > best[1]:
                    best = (s["id"], len(toks))
        supplier_id = best[0] if best else None
    hdr["supplier_id"] = supplier_id
    if supplier_id and hdr.get("inv_no"):
        dup = db.one("SELECT id, recv_date FROM supplier_invoices WHERE supplier_id=? AND inv_no=?", (supplier_id, hdr["inv_no"]))
        hdr["duplicate"] = dup
    items = db.q("SELECT id, name, category, unit, supplier_id FROM items WHERE COALESCE(active,1)=1")
    by_id = {i["id"]: i for i in items}
    maps = {r["key"]: r for r in db.q("SELECT * FROM invoice_item_map WHERE supplier_id=?", (supplier_id or 0,))}
    out = []
    for ln in parsed.get("lines") or []:
        k = _key(ln["name"])
        m = maps.get(k)
        r = dict(ln)
        r["key"] = k
        if m:
            r["item_id"] = None if m["skip"] else m["item_id"]
            r["skip"] = bool(m["skip"])
            r["factor"] = m["factor"] or 1
            r["sure"] = True
            r["learned"] = True
        else:
            iid = _match_item(ln["name"], items)
            r["item_id"] = iid
            r["skip"] = False
            f, sure = _unit_factor(ln.get("unit"), by_id[iid]["unit"] if iid else "", ln["name"]) if iid else (1.0, False)
            r["factor"], r["sure"] = f, bool(iid) and sure
            r["learned"] = False
        if not r["item_id"] and not m and re.search(SERVICE_RE, ln["name"], re.I):
            r["skip"] = True  # dostava, prijevoz, naknade – ne ide na skladište
        if r["item_id"]:
            r.update(_item_defaults(db, r["item_id"], hdr.get("recv_date")))
        out.append(r)
    pos = []
    if supplier_id:
        for p in db.q("""SELECT * FROM purchase_orders WHERE supplier_id=? AND status NOT IN ('Zaprimljeno','Otkazano','Nacrt')
                         ORDER BY order_date DESC""", (supplier_id,)):
            pl = db.q("SELECT item_id, qty, qty_received FROM po_lines WHERE po_id=?", (p["id"],))
            want = {x["item_id"] for x in pl if x["qty_received"] < x["qty"] - 1e-6}
            have = {x["item_id"] for x in out if x.get("item_id")}
            pos.append({"id": p["id"], "po_no": p["po_no"], "date": p["order_date"], "match": len(want & have)})
        pos.sort(key=lambda x: -x["match"])
    return {"header": hdr, "lines": out, "pos": pos, "kind": parsed.get("kind"), "scan": parsed.get("scan", False)}


def _item_defaults(db, item_id, recv=None):
    """Rok trajanja prema zadnjoj primci istog artikla (isti broj dana od primitka)."""
    recv = recv or dt.date.today().isoformat()
    l = db.one("""SELECT received_date, expiry_date FROM lots WHERE item_id=? AND expiry_date IS NOT NULL AND expiry_date<>''
                  ORDER BY received_date DESC, id DESC LIMIT 1""", (item_id,))
    out = {}
    if l:
        try:
            days = (dt.date.fromisoformat(l["expiry_date"][:10]) - dt.date.fromisoformat(l["received_date"][:10])).days
            if days > 0:
                out["expiry"] = (dt.date.fromisoformat(recv[:10]) + dt.timedelta(days=days)).isoformat()
                out["expiry_guess"] = True
        except ValueError:
            pass
    return out


def item_defaults(db, item_id, recv=None):
    return _item_defaults(db, item_id, recv)


# ------------------------------------------------------------------ spremanje: primka + račun
SERVICE_RE = r"\b(dostava|shipping|freight|delivery|prijevoz|transport|po[šs]tarina|otprema|naknada|usluga|manipulativ|ambala[žz]a\s+povratna|kaucija|depozit|zaokru)"
RAW_CATS = ("slad", "žitar", "zitar", "jecam", "ječam")


def save_invoice(db, data, lines, opts=None):
    """data: zaglavlje (supplier_id ili new_supplier, inv_no, inv_date, recv_date, due_date, total, iban, pay_model,
    pay_ref, note, file_name, file_type); lines: [{name, key, item_id, skip, qty, unit, factor, stock_qty, amount,
    lot_no, expiry}]; opts: {po_id, haccp, inspector, remember}. Vraća {id, lot_ids, file_path}."""
    ensure(db)
    opts = opts or {}
    sid = data.get("supplier_id")
    ns = data.get("new_supplier")
    if not sid and ns and (ns.get("name") or "").strip():
        sid = db.con.execute("INSERT INTO suppliers(name, oib, address) VALUES(?,?,?)",
                             (ns["name"].strip(), ns.get("oib"), ns.get("address"))).lastrowid
    if not sid:
        raise ValueError("Odaberite dobavljača.")
    sup = db.one("SELECT * FROM suppliers WHERE id=?", (sid,))
    if data.get("oib") and not sup.get("oib"):
        db.con.execute("UPDATE suppliers SET oib=? WHERE id=?", (data["oib"], sid))
    inv_no = (data.get("inv_no") or "").strip()
    if not inv_no:
        raise ValueError("Upišite broj računa.")
    recv = data.get("recv_date") or dt.date.today().isoformat()
    if db.val("SELECT COUNT(*) FROM supplier_invoices WHERE supplier_id=? AND inv_no=? AND id<>?",
              (sid, inv_no, data.get("id") or 0)):
        raise ValueError(f"Račun {inv_no} dobavljača {sup['name']} već je upisan.")
    stock = [l for l in lines if l.get("item_id") and not l.get("skip") and float(l.get("stock_qty") or 0) > 0]
    for l in lines:
        if not l.get("skip") and not l.get("item_id") and float(l.get("qty") or 0) > 0:
            raise ValueError(f"Stavka „{l.get('name')}”: odaberite artikl ili označite „ne ide na skladište”.")
    year = (data.get("inv_date") or recv)[:4]
    ext = {"pdf": "pdf", "xml": "xml", "pdf+xml": "pdf", "image": "pdf"}.get(data.get("file_type") or "", "pdf")
    fpath = None
    if data.get("file_type"):
        safe = re.sub(r"[^A-Za-z0-9]+", "-", _norm(sup["name"]))[:30].strip("-")
        fpath = f"racuni/{year}/{recv}_{safe}_{re.sub(r'[^A-Za-z0-9]+', '-', inv_no).strip('-')}.{ext}"
    who = None
    try:
        import webapi
        who = webapi.USER or None
    except Exception:  # noqa: BLE001
        pass
    cur = db.con.execute(
        """INSERT INTO supplier_invoices(supplier_id, inv_no, inv_date, recv_date, due_date, total, iban, pay_model, pay_ref,
           file_path, file_name, file_type, note, lines, created, created_by, paid_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (sid, inv_no, data.get("inv_date"), recv, data.get("due_date"), data.get("total"),
         re.sub(r"\s", "", data.get("iban") or "").upper() or None, data.get("pay_model"), data.get("pay_ref"),
         fpath, data.get("file_name"), data.get("file_type"), data.get("note"),
         json.dumps([{k: l.get(k) for k in ("name", "qty", "unit", "amount", "item_id", "stock_qty", "skip")} for l in lines],
                    ensure_ascii=False), dt.datetime.now().strftime("%Y-%m-%d %H:%M"), who, data.get("paid_date")))
    inv_id = cur.lastrowid
    po_id = opts.get("po_id")
    po = db.one("SELECT * FROM purchase_orders WHERE id=?", (po_id,)) if po_id else None
    lot_ids = []
    for l in stock:
        q = round(float(l["stock_qty"]), 4)
        price = round(float(l.get("amount") or 0) / q, 4) if q else 0
        lid = db.receive_lot(l["item_id"], q, (l.get("lot_no") or "").strip() or None, recv, l.get("expiry") or None,
                             sid, price, po_id if po else None, note=f"Račun {inv_no}",
                             ref=(po["po_no"] if po else f"R {inv_no}"), commit=False)
        db.con.execute("UPDATE lots SET invoice_no=?, invoice_id=? WHERE id=?", (inv_no, inv_id, lid))
        if l.get("alpha"):
            try:
                db.con.execute("UPDATE lots SET alpha=? WHERE id=?", (float(l["alpha"]), lid))
            except (ValueError, TypeError):
                pass
        if price > 0:
            db.con.execute("UPDATE items SET price=?, supplier_id=COALESCE(supplier_id, ?) WHERE id=?", (price, sid, l["item_id"]))
        lot_ids.append(lid)
        if po:
            left = q
            for pl in db.q("SELECT * FROM po_lines WHERE po_id=? AND item_id=? AND qty_received < qty", (po_id, l["item_id"])):
                take = min(left, pl["qty"] - pl["qty_received"])
                if take > 0:
                    db.con.execute("UPDATE po_lines SET qty_received=ROUND(qty_received+?,4) WHERE id=?", (take, pl["id"]))
                    left -= take
    if po:
        left = db.val("SELECT COUNT(*) FROM po_lines WHERE po_id=? AND qty_received < qty - 0.0001", (po_id,))
        db.con.execute("UPDATE purchase_orders SET status=? WHERE id=?", ("Djelomično" if left else "Zaprimljeno", po_id))
    # zapamti stavke dobavljača za sljedeći račun
    if opts.get("remember", True):
        for l in lines:
            l["key"] = _key(l.get("key") or l.get("name"))
            if not l["key"]:
                continue
            f = None
            if l.get("item_id") and float(l.get("qty") or 0) > 0 and float(l.get("stock_qty") or 0) > 0:
                f = round(float(l["stock_qty"]) / float(l["qty"]), 6)
            if l.get("skip") or l.get("item_id"):
                db.con.execute("""INSERT INTO invoice_item_map(supplier_id, key, item_id, factor, skip) VALUES(?,?,?,?,?)
                                  ON CONFLICT(supplier_id, key) DO UPDATE SET item_id=excluded.item_id,
                                  factor=excluded.factor, skip=excluded.skip""",
                               (sid, l["key"], l.get("item_id"), f or 1, 1 if l.get("skip") else 0))
    # HACCP zapisnik o prijemu (roba pregledana i ispravna)
    n_rec = 0
    if opts.get("haccp") and lot_ids:
        import haccp_db as H
        for lid in lot_ids:
            lot = db.one("""SELECT l.*, i.name AS item_name, i.unit, i.category, i.is_chemical FROM lots l
                            JOIN items i ON i.id=l.item_id WHERE l.id=?""", (lid,))
            if lot["is_chemical"]:
                continue
            cat = (lot["category"] or "").lower()
            pack = cat.startswith("ambala")
            checks = {c: "DA" for c in H.RECEIPT_CHECKS_ALL}
            if any(cat.startswith(x) for x in RAW_CATS):
                checks.update({c: "DA" for c in H.RECEIPT_CHECKS_RAW})
            if pack:
                checks.update({c: "DA" for c in H.RECEIPT_CHECKS_PACK})
            from db import hr
            db.save_record("receipts", {
                "date": recv, "doc_no": f"Račun {inv_no}", "supplier": sup["name"], "material": lot["item_name"],
                "mat_type": "Ambalaža" if pack else "Sirovina", "quantity": f"{hr(lot['qty_received'])} {lot['unit']}",
                "lot_no": lot["lot_no"], "lot_id": lid, "docs": ["Račun / dostavnica"], "checks": checks,
                "decision": "PRIHVAĆENO", "inspector": opts.get("inspector") or db.get_setting("default_operator") or who,
                "qm_date": recv})
            n_rec += 1
    db.con.commit()
    return {"id": inv_id, "lot_ids": lot_ids, "file_path": fpath, "receipts": n_rec}


# ------------------------------------------------------------------ popis, plaćanje, brisanje
def invoices(db, year=None, supplier_id=None):
    ensure(db)
    sql = """SELECT v.*, s.name AS supplier, (SELECT COUNT(*) FROM lots l WHERE l.invoice_id=v.id) AS n_lots
             FROM supplier_invoices v LEFT JOIN suppliers s ON s.id=v.supplier_id WHERE 1=1"""
    args = []
    if year:
        sql += " AND substr(COALESCE(v.inv_date, v.recv_date),1,4)=?"
        args.append(str(year))
    if supplier_id:
        sql += " AND v.supplier_id=?"
        args.append(supplier_id)
    rows = db.q(sql + " ORDER BY COALESCE(v.recv_date, v.inv_date) DESC, v.id DESC", args)
    today = dt.date.today().isoformat()
    for r in rows:
        r["status"] = "Plaćeno" if r["paid_date"] else ("Dospjelo" if r["due_date"] and r["due_date"] < today else "Neplaćeno")
    return rows


def invoice(db, id):
    ensure(db)
    r = db.one("""SELECT v.*, s.name AS supplier, s.oib AS supplier_oib, s.address AS supplier_address FROM supplier_invoices v
                  LEFT JOIN suppliers s ON s.id=v.supplier_id WHERE v.id=?""", (id,))
    if not r:
        raise ValueError("Račun ne postoji.")
    try:
        r["lines"] = json.loads(r["lines"] or "[]")
    except ValueError:
        r["lines"] = []
    r["lots"] = db.q("""SELECT l.id, l.lot_no, l.qty_received, l.qty_left, l.unit_price, l.expiry_date, i.name, i.unit
                        FROM lots l JOIN items i ON i.id=l.item_id WHERE l.invoice_id=? ORDER BY l.id""", (id,))
    return r


def years(db):
    ensure(db)
    ys = [r["y"] for r in db.q("""SELECT DISTINCT substr(COALESCE(inv_date, recv_date),1,4) AS y FROM supplier_invoices
                                  WHERE y IS NOT NULL ORDER BY y DESC""")]
    y = str(dt.date.today().year)
    return ys if y in ys else [y] + ys


def update_invoice(db, id, data):
    """Ispravak zaglavlja (broj, datumi, iznos, plaćanje, napomena) – stavke i LOT-ovi se ne mijenjaju."""
    ensure(db)
    keys = [k for k in ("inv_no", "inv_date", "due_date", "total", "iban", "pay_model", "pay_ref", "note", "paid_date") if k in data]
    if not keys:
        return False
    db.con.execute(f"UPDATE supplier_invoices SET {','.join(k + '=?' for k in keys)} WHERE id=?", [data[k] for k in keys] + [id])
    if "inv_no" in data:
        db.con.execute("UPDATE lots SET invoice_no=? WHERE invoice_id=?", (data["inv_no"], id))
    db.con.commit()
    return True


def set_paid(db, ids, date=None):
    ensure(db)
    for i in ids if isinstance(ids, list) else [ids]:
        db.con.execute("UPDATE supplier_invoices SET paid_date=? WHERE id=?", (date, i))
    db.con.commit()
    return True


def set_file(db, id, path, name, ftype):
    db.con.execute("UPDATE supplier_invoices SET file_path=?, file_name=?, file_type=? WHERE id=?", (path, name, ftype, id))
    db.con.commit()
    return True


def delete_invoice(db, id, with_lots=False):
    """Briše račun iz evidencije. with_lots: poništi i primku (samo ako ništa od robe još nije potrošeno)."""
    ensure(db)
    r = invoice(db, id)
    if with_lots:
        used = [l for l in r["lots"] if abs((l["qty_left"] or 0) - (l["qty_received"] or 0)) > 1e-6]
        if used:
            raise ValueError("Dio robe s ovog računa već je potrošen (" + ", ".join(l["lot_no"] for l in used[:5]) +
                             ") – primka se ne može poništiti. Obrišite samo račun ili ispravite zalihu.")
        for l in r["lots"]:
            db.con.execute("DELETE FROM movements WHERE lot_id=?", (l["id"],))
            db.con.execute("DELETE FROM receipts WHERE lot_id=?", (l["id"],))
            db.con.execute("DELETE FROM lots WHERE id=?", (l["id"],))
    else:
        db.con.execute("UPDATE lots SET invoice_id=NULL WHERE invoice_id=?", (id,))
    db.con.execute("DELETE FROM supplier_invoices WHERE id=?", (id,))
    db.con.commit()
    return r.get("file_path")


def due_summary(db, days=5):
    """Za nadzornu ploču: neplaćeni računi kojima je rok prošao ili ističe za `days` dana."""
    ensure(db)
    lim = (dt.date.today() + dt.timedelta(days=days)).isoformat()
    rows = db.q("""SELECT v.id, v.inv_no, v.due_date, v.total, s.name AS supplier FROM supplier_invoices v
                   LEFT JOIN suppliers s ON s.id=v.supplier_id
                   WHERE v.paid_date IS NULL AND v.due_date IS NOT NULL AND v.due_date<=? ORDER BY v.due_date""", (lim,))
    return rows


def pay_code(db, id):
    """HUB 3 2D kod za plaćanje računa mobilnim bankarstvom (PNG kao data URL) + podaci za ručni upis."""
    import base64
    import io
    from web_offers import iban_ok, _cut, HUB3_REF_OK
    r = invoice(db, id)
    iban = re.sub(r"\s", "", r.get("iban") or "").upper()
    if not iban_ok(iban):
        raise ValueError("Na računu nema ispravnog IBAN-a dobavljača – upišite ga (✎ Uredi račun).")
    total = float(r.get("total") or 0)
    if total <= 0:
        raise ValueError("Upišite iznos računa (✎ Uredi račun).")
    g = db.get_setting
    model = (r.get("pay_model") or "HR00").upper().replace(" ", "")
    ref = (r.get("pay_ref") or "").strip() or (r["inv_no"] if model == "HR99" else r["inv_no"])
    if model == "HR99":
        ref = ""
    ref = _cut(ref, 22)
    if not HUB3_REF_OK.match(ref):
        ref = re.sub(r"[^0-9\-]", "-", ref)
    payer_addr = g("dn_address") or ""
    st, pl = (payer_addr.split(",", 1) + [""])[:2]
    addr = (r.get("supplier_address") or "")
    rs, rp = (addr.split(",", 1) + [""])[:2]
    fields = ["HRVHUB30", "EUR", f"{int(round(total * 100)):015d}", _cut(g("dn_company"), 30), _cut(st, 27), _cut(pl, 27),
              _cut(r.get("supplier"), 25), _cut(rs, 25), _cut(rp, 27), iban, model, ref, "",
              _cut(f"Račun {r['inv_no']}", 35)]
    info = {"iban": iban, "model": model, "ref": ref, "amount": total, "recipient": r.get("supplier"), "desc": f"Račun {r['inv_no']}"}
    if not iban.startswith("HR"):
        # inozemni račun (npr. SI): HUB 3 barkod je samo za plaćanja u Hrvatskoj – podaci za SEPA nalog
        info.update({"png": None, "foreign": True, "ref": (r.get("pay_ref") or r["inv_no"]), "model": r.get("pay_model") or ""})
        return info
    text = "".join(f + "\n" for f in fields)
    from pdf417gen import encode, render_image
    img = render_image(encode(text, columns=9, security_level=4, encoding="utf-8"), scale=3, ratio=3, padding=10)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return {"png": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), "iban": iban, "model": model,
            "ref": ref, "amount": total, "recipient": r.get("supplier"), "desc": f"Račun {r['inv_no']}"}


# ------------------------------------------------------------------ za knjigovođu: računi mjeseca
def month_list(db, month):
    ensure(db)
    return db.q("""SELECT v.*, s.name AS supplier, s.oib AS supplier_oib FROM supplier_invoices v
                   LEFT JOIN suppliers s ON s.id=v.supplier_id
                   WHERE substr(COALESCE(v.inv_date, v.recv_date),1,7)=? ORDER BY COALESCE(v.inv_date, v.recv_date), v.id""",
                (month,))


def month_zip(db, month, files):
    """files: [[putanja u /tmp, ime u ZIP-u]] – datoteke računa koje je preglednik preuzeo s GitHuba.
    ZIP sadrži račune i popis (Excel)."""
    import zipfile
    import openpyxl
    from openpyxl.styles import Font
    rows = month_list(db, month)
    os.makedirs(OUT, exist_ok=True)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Računi " + month
    hdr = ["Datum računa", "Dobavljač", "OIB", "Broj računa", "Iznos €", "Dospijeće", "Plaćeno", "Primljeno", "Datoteka"]
    ws.append(hdr)
    for c in ws[1]:
        c.font = Font(bold=True)
    fmt = lambda d: (".".join(reversed(d[:10].split("-"))) + ".") if d else ""
    for r in rows:
        ws.append([fmt(r["inv_date"]), r["supplier"], r["supplier_oib"], r["inv_no"], r["total"], fmt(r["due_date"]),
                   fmt(r["paid_date"]), fmt(r["recv_date"]), (r["file_path"] or "").split("/")[-1]])
    for col, w in zip("ABCDEFGHI", (13, 30, 14, 18, 12, 12, 12, 12, 40)):
        ws.column_dimensions[col].width = w
    xp = os.path.join(OUT, f"Popis_racuna_{month}.xlsx")
    wb.save(xp)
    zp = os.path.join(OUT, f"Racuni_dobavljaca_{month}.zip")
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(xp, os.path.basename(xp))
        for p, name in files or []:
            if os.path.exists(p):
                z.write(p, name)
    return zp


def line_for_item(db, name, inv_unit, item_id, recv=None):
    """Kad se stavci ručno odabere artikl: pretvorba jedinica i prijedlog roka trajanja."""
    it = db.one("SELECT unit FROM items WHERE id=?", (item_id,))
    if not it:
        return {"factor": 1, "sure": False}
    f, sure = _unit_factor(inv_unit, it["unit"], name)
    out = {"factor": f, "sure": sure, "item_unit": it["unit"]}
    out.update(_item_defaults(db, item_id, recv))
    return out


def images_to_pdf(paths, out_name="racun.pdf"):
    """Fotografije stranica računa -> jedan PDF (za evidenciju)."""
    from PIL import Image
    imgs = []
    for p in paths:
        im = Image.open(p)
        im = im.convert("RGB")
        imgs.append(im)
    if not imgs:
        raise ValueError("Nema slika.")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, out_name)
    imgs[0].save(path, "PDF", resolution=150, save_all=True, append_images=imgs[1:])
    return path
