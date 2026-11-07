"""Jedinice mjere: kg, g, L, ml, kom, pakiranje.

Zaliha svakog artikla vodi se u njegovoj OSNOVNOJ jedinici (items.unit). U recepturi, primci i izdavanju količina se
može upisati i u drugoj jedinici; program je preračuna u osnovnu:
  * kg <-> g, L <-> ml – uvijek;
  * kom   – 1 kom = items.piece_qty osnovnih jedinica (npr. 1 vrećica kvasca = 0,0115 kg);
  * pak   – 1 pakiranje = items.reorder_qty osnovnih jedinica (polje „Pakiranje / min. narudžba”).
"""
MASS = {"kg": 1000.0, "g": 1.0}
VOL = {"l": 1000.0, "ml": 1.0}
ALL = ["kg", "g", "L", "ml", "kom", "pak"]
LABEL = {"pak": "pakiranje"}


def ensure(db):
    if "piece_qty" not in {r["name"] for r in db.q("PRAGMA table_info(items)")}:
        db.con.execute("ALTER TABLE items ADD COLUMN piece_qty REAL")
    if "qty_unit" not in {r["name"] for r in db.q("PRAGMA table_info(recipe_items)")}:
        db.con.execute("ALTER TABLE recipe_items ADD COLUMN qty_unit TEXT")
    db.con.commit()


def _n(u):
    u = (u or "").strip().lower()
    return {"pakiranje": "pak", "pakiranja": "pak", "komad": "kom", "kos": "kom", "lit": "l", "litra": "l"}.get(u, u)


def factor(item, unit):
    """Koliko osnovnih jedinica artikla je 1 `unit`; None = nije moguće preračunati."""
    base, u = _n(item.get("unit")), _n(unit)
    if not u or u == base:
        return 1.0
    if u in MASS and base in MASS:
        return MASS[u] / MASS[base]
    if u in VOL and base in VOL:
        return VOL[u] / VOL[base]
    if u == "kom" and (item.get("piece_qty") or 0) > 0:
        return float(item["piece_qty"])
    if u == "pak" and (item.get("reorder_qty") or 0) > 0:
        return float(item["reorder_qty"])
    if base == "kom" and (item.get("piece_qty") or 0) > 0 and u in ("pak",):
        return None
    return None


def units_for(item):
    """Jedinice u kojima se artikl može upisivati (osnovna prva)."""
    base = item.get("unit") or "kg"
    out = [base]
    for u in ALL:
        if _n(u) != _n(base) and factor(item, u) is not None and u not in out:
            out.append(u)
    return out


def all_units(db):
    ensure(db)
    return {str(i["id"]): units_for(i) for i in db.q("SELECT id, unit, piece_qty, reorder_qty FROM items")}


def to_base(db, item_id, qty, unit, price=None):
    """(količina u osnovnoj jedinici, cijena po osnovnoj jedinici) – ValueError ako jedinica nije moguća."""
    ensure(db)
    it = db.one("SELECT * FROM items WHERE id=?", (item_id,))
    if not it:
        raise ValueError("Artikl ne postoji.")
    f = factor(it, unit)
    if f is None:
        u = LABEL.get(_n(unit), unit)
        hint = "upišite u artiklu koliko je 1 pakiranje (polje „Pakiranje”)" if _n(unit) == "pak" else \
            "upišite u artiklu koliko je 1 kom (polje „1 kom =”)" if _n(unit) == "kom" else "odaberite drugu jedinicu"
        raise ValueError(f"{it['name']}: količina u jedinici „{u}” ne može se preračunati u {it['unit']} – {hint}.")
    q = round(float(qty or 0) * f, 6)
    p = round(float(price) / f, 6) if price not in (None, "") and f else price
    return q, p


def receive(db, item_id, qty, unit, lot_no=None, received=None, expiry=None, supplier_id=None, unit_price=0, note=None):
    """Ručna primka: količina u odabranoj jedinici (pretvara se u osnovnu jedinicu artikla); cijena je po osnovnoj jedinici."""
    q, _p = to_base(db, item_id, qty, unit)
    return db.receive_lot(item_id, q, lot_no, received, expiry, supplier_id, unit_price or 0, None, note)


def issue(db, item_id, qty, unit, mtype="IZDAVANJE", ref="", note=""):
    q, _p = to_base(db, item_id, qty, unit)
    return db.issue_fifo(item_id, q, mtype, ref, note)


# promjena osnovne jedinice artikla: kg <-> g i L <-> ml preračunavaju se sve količine; ostalo samo bez povijesti
_QTY = [("lots", "qty_received", "item_id"), ("lots", "qty_left", "item_id"), ("movements", "qty", "item_id"),
        ("batch_consumption", "qty", "item_id"), ("po_lines", "qty", "item_id"), ("po_lines", "qty_received", "item_id")]
_PRICE = [("lots", "unit_price", "item_id"), ("po_lines", "unit_price", "item_id")]


def change_unit_check(db, item_id, new_unit):
    it = db.one("SELECT * FROM items WHERE id=?", (item_id,))
    if not it or _n(it["unit"]) == _n(new_unit):
        return {"ok": True, "convert": None}
    hist = db.val("SELECT COUNT(*) FROM lots WHERE item_id=?", (item_id,)) or 0
    a, b = _n(it["unit"]), _n(new_unit)
    if (a in MASS and b in MASS) or (a in VOL and b in VOL):
        f = (MASS.get(a) or VOL.get(a)) / (MASS.get(b) or VOL.get(b))
        return {"ok": True, "convert": f, "hist": hist, "from": it["unit"], "to": new_unit}
    if hist:
        return {"ok": False, "hist": hist, "from": it["unit"], "to": new_unit}
    return {"ok": True, "convert": None}


def change_unit(db, item_id, new_unit):
    """Preračun svih količina artikla (kg <-> g, L <-> ml) u novu osnovnu jedinicu."""
    chk = change_unit_check(db, item_id, new_unit)
    if not chk["ok"]:
        raise ValueError(f"Artikl već ima primke u jedinici {chk['from']} – {chk['from']} se ne može pretvoriti u {chk['to']}. "
                         "Zaliha ostaje u osnovnoj jedinici; u primci i recepturi možete upisivati i u drugoj jedinici.")
    f = chk.get("convert")
    with db.con:
        if f:
            for t, col, key in _QTY:
                try:
                    db.con.execute(f"UPDATE {t} SET {col}=ROUND({col}*?,6) WHERE {key}=?", (f, item_id))
                except Exception:  # noqa: BLE001
                    pass
            for t, col, key in _PRICE:
                try:
                    db.con.execute(f"UPDATE {t} SET {col}=ROUND({col}/?,6) WHERE {key}=?", (f, item_id))
                except Exception:  # noqa: BLE001
                    pass
            db.con.execute("UPDATE recipe_items SET qty=ROUND(qty*?,6) WHERE item_id=? AND (qty_unit IS NULL OR qty_unit='')", (f, item_id))
            db.con.execute("""UPDATE items SET min_stock=ROUND(COALESCE(min_stock,0)*?,6), reorder_qty=ROUND(COALESCE(reorder_qty,0)*?,6),
                              piece_qty=CASE WHEN piece_qty IS NULL THEN NULL ELSE ROUND(piece_qty*?,6) END,
                              price=ROUND(COALESCE(price,0)/?,6) WHERE id=?""", (f, f, f, f, item_id))
            try:
                db.con.execute("UPDATE invoice_item_map SET factor=ROUND(factor*?,6) WHERE item_id=?", (f, item_id))
            except Exception:  # noqa: BLE001
                pass
        db.con.execute("UPDATE items SET unit=? WHERE id=?", (new_unit, item_id))
    return {"converted": bool(f), "factor": f}
