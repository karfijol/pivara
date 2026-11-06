"""HACCP dio web sučelja: konstante, ispis dokumenata (PDF/Word), izrada svih dokumenata (ZIP) i upozorenja.
Prijenos ne-grafičkih dijelova iz haccp_ui.py i alerts_ui.py (desktop)."""
import os
import shutil
import zipfile

from haccp_db import (CIP_TYPES, CIP_EQUIPMENT, EQ_CATEGORIES, PACK_TYPES, RECEIPT_DOCS, RECEIPT_CHECKS_ALL,
                      RECEIPT_CHECKS_RAW, RECEIPT_CHECKS_PACK, DOC_NAMES, abv_from_sg as _abv)

OUT = "/out"
_LAST_EXPORT = {}


def consts():
    return {"CIP_TYPES": CIP_TYPES, "CIP_EQUIPMENT": CIP_EQUIPMENT, "EQ_CATEGORIES": EQ_CATEGORIES,
            "PACK_TYPES": PACK_TYPES, "RECEIPT_DOCS": RECEIPT_DOCS, "RECEIPT_CHECKS_ALL": RECEIPT_CHECKS_ALL,
            "RECEIPT_CHECKS_RAW": RECEIPT_CHECKS_RAW, "RECEIPT_CHECKS_PACK": RECEIPT_CHECKS_PACK,
            "DOC_NAMES": DOC_NAMES}


def abv_from_sg(og, fg):
    return _abv(og, fg)


def _fmts(fmt):
    if isinstance(fmt, (list, tuple)):
        return [str(f).upper() for f in fmt]
    f = str(fmt or "PDF").upper()
    if f in ("BOTH", "OBOJE", "PDF I WORD", "PDF+WORD"):
        return ["PDF", "WORD"]
    if f in ("EXCEL", "XLSX", "XLS"):
        return ["EXCEL"]
    return ["WORD" if f.startswith("W") or f == "DOCX" else "PDF"]


def print_doc(db, key, fmt="PDF", d_from=None, d_to=None, rec_id=None, equipment_id=None, app=None):
    """Jedan HACCP dokument (ili isti u PDF i Word obliku) -> putanja (ili lista putanja)."""
    import haccp_docs  # reportlab/python-docx se učitavaju tek za ispis
    logo = app.logo_path() if app is not None else None
    paths = [haccp_docs.make(db, key, OUT, f, logo, d_from or None, d_to or None, rec_id, equipment_id)
             for f in _fmts(fmt)]
    return paths[0] if len(paths) == 1 else paths


def export_all(db, d_from=None, d_to=None, fmt="PDF", mode="all", app=None):
    """Svi HACCP dokumenti za razdoblje -> jedna ZIP datoteka (u pregledniku nema mape Google Diska)."""
    global _LAST_EXPORT
    import haccp_docs
    logo = app.logo_path() if app is not None else None
    base = "/out/HACCP_svi"
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base, exist_ok=True)
    mode = mode or "all"
    if mode == "range" and not (d_from and d_to):
        raise ValueError("Za razdoblje upišite datum od i do.")
    root, files, errors = haccp_docs.make_all(db, base, tuple(_fmts(fmt)), logo, d_from or None, d_to or None,
                                              mode=mode)
    name = "HACCP"
    tag = {"all": "cijela_povijest", "last": "zadnji_unos"}.get(mode) or f"{d_from}_{d_to}"
    zpath = os.path.join("/out", f"HACCP_{tag}.zip")
    if os.path.exists(zpath):
        os.remove(zpath)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, os.path.relpath(f, base))
    _LAST_EXPORT = {"zip": zpath, "n": len(files), "errors": errors, "name": name}
    return zpath


def last_export():
    return _LAST_EXPORT


# ------------------------------------------------------------------ upozorenja (alerts_ui)
def collect(db, group=None):
    """Sva vidljiva upozorenja (ili samo 'stock' / 'haccp')."""
    items = []
    if group in (None, "stock"):
        items += db.visible(db.dashboard()["alerts"])
    if group in (None, "haccp"):
        items += db.haccp_tasks()
    return items


def dismiss_type(db, typ):
    db.dismiss([(f"type:{typ}", typ)])
    return True
