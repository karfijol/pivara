"""Provjera zaliha (FIFO inventura): iz svih primki, kuhanja i ostalih izlaza ponovno izračuna koliko je ostalo na
svakom LOT-u i (nakon potvrde) to upiše u stupac „Preostalo”. Evidencija utroška po šaržama (sljedivost) se ne mijenja."""
import datetime as dt

EPS = 1e-6
MT = "INVENTURA FIFO"            # vrsta kretanja koju upisuje ova provjera (ne ulazi u sljedeći izračun)
SKIP = {"PRIMKA", "KUHANJE", "POVRAT", MT}


def r4(x):
    return round(float(x or 0) + 0.0, 4)


def _brewed(db):
    return db.q("""SELECT b.id, b.batch_no, b.recipe_id, b.volume_l, b.brew_date, r.name AS recipe
                   FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                   WHERE COALESCE(b.status,'Planirano')<>'Planirano' AND b.brew_date IS NOT NULL
                   ORDER BY b.brew_date, b.id""")


def _recipe_needs(db, b, cache):
    key = (b["recipe_id"], b["volume_l"])
    if key not in cache:
        try:
            cache[key] = {ln["item_id"]: r4(ln["need"]) for ln in db.scaled_needs(b["recipe_id"], b["volume_l"])} if b["recipe_id"] else {}
        except Exception:  # noqa: BLE001
            cache[key] = {}
    return cache[key]


def calc(db, mode="evidence"):
    """mode='evidence': utrošak kuhanja kakav je evidentiran pri kuhanju (s ručnim ispravcima i alfa korekcijom);
    šarže bez evidencije računaju se po recepturi. mode='recipe': sve šarže po recepturi × volumen."""
    items = {i["id"]: i for i in db.q("SELECT id, name, unit, category FROM items")}
    lots = db.q("SELECT id, item_id, lot_no, qty_received, qty_left, received_date FROM lots ORDER BY received_date, id")
    by_item = {}
    for l in lots:
        by_item.setdefault(l["item_id"], []).append(dict(l))
    # izlazi po artiklu: (datum, količina, opis)
    out_ev, out_rc, out_other = {}, {}, {}
    cons = {}
    for c in db.q("SELECT batch_id, item_id, SUM(qty) AS q FROM batch_consumption GROUP BY batch_id, item_id"):
        cons.setdefault(c["batch_id"], {})[c["item_id"]] = r4(c["q"])
    cache = {}
    no_rec = []
    for b in _brewed(db):
        rc = _recipe_needs(db, b, cache)
        ev = cons.get(b["id"])
        if not ev:
            no_rec.append(b["batch_no"])
        for iid, q in rc.items():
            out_rc.setdefault(iid, []).append((b["brew_date"], q, b["batch_no"]))
        use = rc if (mode == "recipe" or not ev) else ev
        for iid, q in use.items():
            out_ev.setdefault(iid, []).append((b["brew_date"], q, b["batch_no"]))
    for m in db.q("SELECT item_id, ts, qty, type, ref FROM movements ORDER BY ts, id"):
        if (m["type"] or "").upper() in SKIP:
            continue
        out_other.setdefault(m["item_id"], []).append((m["ts"][:10], -r4(m["qty"]), f"{m['type']} {m['ref'] or ''}".strip()))

    rows, lot_rows = [], []
    for iid in sorted(set(by_item) | set(out_ev) | set(out_other), key=lambda i: (items.get(i, {}).get("name") or "").lower()):
        it = items.get(iid)
        if not it:
            continue
        ls = by_item.get(iid, [])
        for l in ls:
            l["calc"] = 0.0
        events = [(l["received_date"][:10], 0, l["qty_received"], l) for l in ls]
        events += [(d or "0000", 1, q, desc) for d, q, desc in out_ev.get(iid, []) + out_other.get(iid, [])]
        events.sort(key=lambda e: (e[0], e[1]))
        short, early = 0.0, []
        for d, kind, q, ref in events:
            if kind == 0:
                ref["calc"] = r4(ref["calc"] + q)
                continue
            if q < 0:  # ulaz preko korekcije / povrata: vraća se na najnoviji LOT do tog datuma
                tgt = [l for l in ls if l["received_date"][:10] <= d] or ls
                if tgt:
                    tgt[-1]["calc"] = r4(tgt[-1]["calc"] - q)
                continue
            rem = q
            for l in ls:  # FIFO: najstariji LOT primljen do datuma izlaza
                if rem <= EPS:
                    break
                if l["received_date"][:10] > d or l["calc"] <= EPS:
                    continue
                take = min(rem, l["calc"])
                l["calc"] = r4(l["calc"] - take)
                rem = r4(rem - take)
            if rem > EPS:  # izlaz prije upisane primke (primka upisana kasnije): uzima s idućih LOT-ova
                for l in ls:
                    if rem <= EPS:
                        break
                    if l["calc"] <= EPS:
                        continue
                    take = min(rem, l["calc"])
                    l["calc"] = r4(l["calc"] - take)
                    rem = r4(rem - take)
                if q - rem > EPS:
                    early.append(ref)
            short = r4(short + max(rem, 0))
        received = r4(sum(l["qty_received"] for l in ls))
        brew_ev = r4(sum(q for _d, q, _r in out_ev.get(iid, [])))
        brew_rc = r4(sum(q for _d, q, _r in out_rc.get(iid, [])))
        other = r4(sum(q for _d, q, _r in out_other.get(iid, [])))
        cur = r4(sum(l["qty_left"] for l in ls))
        new = r4(sum(l["calc"] for l in ls))
        changed = [l for l in ls if abs(l["calc"] - l["qty_left"]) > 0.0005]
        rows.append({"item_id": iid, "name": it["name"], "unit": it["unit"], "category": it["category"], "received": received,
                     "brew": brew_ev, "brew_recipe": brew_rc, "other": other, "calc": new, "current": cur,
                     "diff": r4(new - cur), "short": short, "lots_changed": len(changed), "n_lots": len(ls)})
        for l in ls:
            lot_rows.append({"lot_id": l["id"], "item_id": iid, "name": it["name"], "unit": it["unit"], "lot_no": l["lot_no"],
                             "received_date": l["received_date"], "received": l["qty_received"], "current": r4(l["qty_left"]),
                             "calc": l["calc"], "diff": r4(l["calc"] - l["qty_left"])})
    return {"mode": mode, "items": rows, "lots": lot_rows, "batches": len(_brewed(db)), "no_record": no_rec}


def apply(db, item_ids, mode="evidence", note=None):
    """Upisuje izračunato stanje na LOT-ove označenih artikala (s kretanjem „INVENTURA FIFO” za svaku promjenu)."""
    res = calc(db, mode)
    want = set(item_ids or [])
    ts = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    n_lots, n_items = 0, set()
    with db.con:
        for l in res["lots"]:
            if l["item_id"] not in want or abs(l["diff"]) <= 0.0005:
                continue
            db.con.execute("UPDATE lots SET qty_left=? WHERE id=?", (max(l["calc"], 0), l["lot_id"]))
            db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                           (ts, l["item_id"], l["lot_id"], l["diff"], MT, l["lot_no"],
                            note or ("Provjera zaliha po FIFO – " + ("po recepturama" if mode == "recipe" else "po evidenciji kuhanja"))))
            n_lots += 1
            n_items.add(l["item_id"])
    return {"lots": n_lots, "items": len(n_items)}
