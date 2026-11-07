"""Inventura: usporedba svih dosadašnjih kuhanja sa svom zaprimljenom robom.

Za svaki artikl program redom po datumu prolazi primke (LOT-ove), kuhanja i ostale izlaze te po FIFO pravilu
(najstariji LOT koji je bio na skladištu na dan kuhanja) ponovno izračuna:
  * utrošak svake šarže po LOT-ovima (sljedivost, HACCP evidencija kuhanja, trošak šarže),
  * preostalu količinu svakog LOT-a (stanje skladišta),
  * kretanja na kartici artikla.
Ništa se ne mijenja dok korisnik ne potvrdi (cijeli popis ili samo označene artikle)."""
import datetime as dt

EPS = 1e-6
TOL = 0.0005
MT_INV = "INVENTURA"                       # usklađenje stanja LOT-a nakon inventure
IGNORE = {"PRIMKA", "KOREKCIJA PRIMKE", "KUHANJE", "POVRAT", "PROMJENA LOT", "INVENTURA", "INVENTURA FIFO"}


def r4(x):
    return round(float(x or 0) + 0.0, 4)


def hr(x):
    return f"{r4(x):g}".replace(".", ",")


def _now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def _brewed(db):
    return db.q("""SELECT b.*, r.name AS recipe
                   FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                   WHERE COALESCE(b.status,'Planirano')<>'Planirano' AND b.brew_date IS NOT NULL
                   ORDER BY b.brew_date, b.id""")


def _recipe_needs(db, b, cache):
    """Potrebno po recepturi za šaržu: skuhana kuhanja (sastojci po kuhanju) + fermentor (kvasac, dry hop) ako je napunjen."""
    if not b["recipe_id"] or not db.val("SELECT COUNT(*) FROM recipes WHERE id=?", (b["recipe_id"],)):
        return {}
    try:
        import web_brew
        return web_brew.batch_needs(db, b)
    except Exception:  # noqa: BLE001
        return {ln["item_id"]: r4(ln["need"]) for ln in db.scaled_needs(b["recipe_id"], b["volume_l"])}


def _take(ls, rem, d, only_before=True):
    """FIFO: skida rem s LOT-ova (najstariji prvi). Vraća (raspodjela [(lot, količina)], ostatak)."""
    alloc = []
    for l in ls:
        if rem <= EPS:
            break
        if l["calc"] <= EPS or (only_before and l["received_date"][:10] > d):
            continue
        t = r4(min(rem, l["calc"]))
        l["calc"] = r4(l["calc"] - t)
        rem = r4(rem - t)
        alloc.append((l, t))
    return alloc, rem


def calc(db, mode="recipe", include_corrections=False):
    """mode='recipe': utrošak svake šarže = receptura × volumen šarže.
    mode='evidence': utrošak kakav je upisan pri kuhanju (s ručnim ispravcima i alfa korekcijom); sastojci kojih u
    evidenciji nema (npr. obrisan LOT) računaju se po recepturi.
    Ručne korekcije količine uzimaju se samo ako su upisane nakon zadnje inventure (ili sve, ako include_corrections)."""
    last_inv = db.get_setting("inventura_last") or ""
    items = {i["id"]: i for i in db.q("SELECT id, name, unit, category FROM items")}
    by_item = {}
    for l in db.q("SELECT id, item_id, lot_no, qty_received, qty_left, received_date FROM lots ORDER BY received_date, id"):
        by_item.setdefault(l["item_id"], []).append(dict(l, calc=0.0))
    lot_by_id = {l["id"]: l for ls in by_item.values() for l in ls}

    # stari utrošak po šaržama
    old = {}
    for c in db.q("""SELECT c.batch_id, c.item_id, c.lot_id, c.qty, l.lot_no FROM batch_consumption c
                     LEFT JOIN lots l ON l.id=c.lot_id ORDER BY c.id"""):
        old.setdefault((c["batch_id"], c["item_id"]), []).append(c)

    events = {}   # item_id -> [(datum, red, vrsta, podaci)]
    batches = _brewed(db)
    cache, no_recipe = {}, []
    for b in batches:
        rc = _recipe_needs(db, b, cache)
        ev = {}
        for (bid, iid), rows in old.items():
            if bid == b["id"]:
                ev[iid] = r4(sum(r["qty"] for r in rows))
        if not rc and not ev:
            no_recipe.append(b["batch_no"])
        if mode == "recipe" and rc:
            need = dict(rc)
        else:
            need = {k: v for k, v in ev.items() if v > EPS}
            for k, v in rc.items():
                if k not in need:
                    need[k] = v
        for iid, q in need.items():
            if q > EPS:
                events.setdefault(iid, []).append((b["brew_date"][:10], 1, "brew", {"batch": b, "qty": q,
                                                                                    "recipe": rc.get(iid, 0), "ev": ev.get(iid, 0)}))
    n_corr_skipped = 0
    for m in db.q("SELECT id, item_id, lot_id, ts, qty, type, ref, note FROM movements ORDER BY ts, id"):
        t = (m["type"] or "").upper()
        if t in IGNORE:
            continue
        d = (m["ts"] or "")[:10]
        if t == "KOREKCIJA" and not include_corrections and (not last_inv or (m["ts"] or "") <= last_inv):
            n_corr_skipped += 1   # ručna korekcija prije zadnje inventure: inventura je zamjenjuje
            continue
        events.setdefault(m["item_id"], []).append((d, 2, t, m))

    res_items, res_lots, res_batches, todo = [], [], [], []
    for iid in sorted(set(by_item) | set(events), key=lambda i: (items.get(i, {}).get("name") or "").lower()):
        it = items.get(iid)
        if not it:
            continue
        ls = by_item.get(iid, [])
        ev_list = [(l["received_date"][:10], 0, "lot", l) for l in ls] + events.get(iid, [])
        ev_list.sort(key=lambda e: (e[0], e[1]))
        short_total, late, bchanges, consumed = 0.0, [], [], 0.0
        for d, _o, kind, x in ev_list:
            if kind == "lot":
                x["calc"] = r4(x["calc"] + x["qty_received"])
            elif kind == "brew":
                b = x["batch"]
                alloc, rem = _take(ls, x["qty"], d)
                if rem > EPS:   # primka upisana s kasnijim datumom: uzmi s kasnijih LOT-ova
                    a2, rem = _take(ls, rem, d, only_before=False)
                    if a2:
                        late.append(f"{b['batch_no']} ({d}): LOT {', '.join(a['lot_no'] for a, _ in a2)} primljen nakon kuhanja")
                    alloc += a2
                consumed = r4(consumed + x["qty"] - max(rem, 0))
                if rem > EPS:
                    short_total = r4(short_total + rem)
                new = {}
                for l, q in alloc:
                    new[l["id"]] = r4(new.get(l["id"], 0) + q)
                oldr = old.get((b["id"], iid), [])
                oldm = {}
                for r in oldr:
                    if r["qty"] > EPS:
                        oldm[r["lot_id"]] = r4(oldm.get(r["lot_id"], 0) + r["qty"])
                same = set(oldm) == set(new) and all(abs(oldm[k] - new[k]) <= TOL for k in new)
                bchanges.append({"batch_id": b["id"], "batch_no": b["batch_no"], "date": d, "recipe": b["recipe"] or "",
                                 "need": x["qty"], "recipe_qty": x["recipe"], "ev_qty": x["ev"], "short": r4(max(rem, 0)),
                                 "old": [{"lot_id": k, "lot_no": (lot_by_id.get(k) or {}).get("lot_no") or "(obrisan)", "qty": v} for k, v in oldm.items()],
                                 "new": [{"lot_id": k, "lot_no": lot_by_id[k]["lot_no"], "qty": v} for k, v in new.items()],
                                 "changed": not same})
            else:  # ostali izlazi / ulazi iz kretanja
                m = x
                lot = lot_by_id.get(m["lot_id"])
                if kind == "OTPIS":
                    if lot and lot["item_id"] == iid:
                        lot["calc"] = 0.0
                elif kind == "KOREKCIJA" or m["qty"] > 0:
                    if lot and lot["item_id"] == iid:
                        lot["calc"] = r4(max(lot["calc"] + m["qty"], 0))
                else:  # izdavanje i sl.: FIFO
                    alloc, rem = _take(ls, -m["qty"], d)
                    if rem > EPS:
                        _a, rem = _take(ls, rem, d, only_before=False)
        received = r4(sum(l["qty_received"] for l in ls))
        cur = r4(sum(l["qty_left"] for l in ls))
        new_stock = r4(sum(l["calc"] for l in ls))
        old_cons = r4(sum(r["qty"] for (bid, i2), rows in old.items() if i2 == iid for r in rows))
        lots_changed = [l for l in ls if abs(l["calc"] - l["qty_left"]) > TOL]
        b_changed = [c for c in bchanges if c["changed"]]
        # šarže sa starom evidencijom za artikl koji po novom izračunu nije utrošen (npr. maknut iz recepture)
        brewed_ids = {c["batch_id"] for c in bchanges}
        for (bid, i2), rows in old.items():
            if i2 == iid and bid not in brewed_ids and any(r["qty"] > EPS for r in rows):
                b = next((x for x in batches if x["id"] == bid), None)
                if b:
                    oldm = {}
                    for r in rows:
                        oldm[r["lot_id"]] = r4(oldm.get(r["lot_id"], 0) + r["qty"])
                    c = {"batch_id": bid, "batch_no": b["batch_no"], "date": b["brew_date"][:10], "recipe": b["recipe"] or "",
                         "need": 0, "recipe_qty": 0, "ev_qty": r4(sum(oldm.values())), "short": 0,
                         "old": [{"lot_id": k, "lot_no": (lot_by_id.get(k) or {}).get("lot_no") or "(obrisan)", "qty": v} for k, v in oldm.items()],
                         "new": [], "changed": True}
                    bchanges.append(c)
                    b_changed.append(c)
        changed = bool(lots_changed or b_changed)
        warn = []
        if short_total > EPS:
            sb = [f"{c['batch_no']} {hr(c['short'])}" for c in bchanges if c["short"] > EPS]
            warn.append(f"nedostaje primka za {hr(short_total)} {it['unit']}")
            todo.append(f"{it['name']}: za kuhanja nedostaje {hr(short_total)} {it['unit']} ({', '.join(sb)}). "
                        "Upišite primku koja nedostaje (Skladište → Primka) i ponovno pokrenite inventuru.")
        if late:
            warn.append("LOT primljen nakon kuhanja")
            todo.append(f"{it['name']}: provjerite datum primitka – " + "; ".join(late[:3]) + (" …" if len(late) > 3 else "")
                        + ". Ako je datum pogrešan, ispravite ga (LOT-ovi → Uredi LOT).")
        if not changed and not warn:
            continue
        res_items.append({"item_id": iid, "name": it["name"], "unit": it["unit"], "category": it["category"],
                          "received": received, "cons_old": old_cons, "cons_new": consumed, "stock_old": cur, "stock_new": new_stock,
                          "n_batches": len(b_changed), "n_lots": len(lots_changed), "short": short_total,
                          "warn": "; ".join(warn), "changed": changed})
        for l in ls:
            res_lots.append({"lot_id": l["id"], "item_id": iid, "lot_no": l["lot_no"], "received_date": l["received_date"],
                             "received": l["qty_received"], "old": r4(l["qty_left"]), "new": l["calc"],
                             "changed": abs(l["calc"] - l["qty_left"]) > TOL})
        for c in bchanges:
            res_batches.append(dict(c, item_id=iid))
    if no_recipe:
        todo.append("Šarže bez recepture i bez evidencije utroška (za njih se ništa ne skida): " + ", ".join(no_recipe)
                    + ". Povežite ih s recepturom ili upišite utrošak (HACCP → Kuhanje i utrošak).")
    return {"mode": mode, "items": res_items, "lots": res_lots, "batches": res_batches, "n_brewed": len(batches),
            "n_items_all": len(items), "todo": todo, "no_recipe": no_recipe, "corr_skipped": n_corr_skipped,
            "last_inv": last_inv}


def apply(db, item_ids, mode="recipe", include_corrections=False):
    """Upisuje rezultat inventure za označene artikle: utrošak šarži po LOT-ovima (sljedivost), kretanja „KUHANJE”
    na kartici artikla i preostalu količinu LOT-ova. Razliku prema ostalim kretanjima usklađuje kretanjem „INVENTURA”."""
    res = calc(db, mode, include_corrections)
    want = {i for i in (item_ids or [])}
    items = [x for x in res["items"] if x["item_id"] in want and x["changed"]]
    ids = {x["item_id"] for x in items}
    ts = _now()
    n_b, n_l = set(), 0
    with db.con:
        for iid in ids:
            # 1) utrošak šarži (sljedivost): stari zapisi za artikl -> novi po FIFO
            display = {r["batch_id"]: (r["display"], r["lot_id"]) for r in db.q(
                "SELECT batch_id, display, lot_id FROM batch_consumption WHERE item_id=? AND display IS NOT NULL AND display<>''", (iid,))}
            bc = [c for c in res["batches"] if c["item_id"] == iid]
            touched = {c["batch_id"] for c in bc}
            for bid in touched:
                db.con.execute("DELETE FROM batch_consumption WHERE batch_id=? AND item_id=?", (bid, iid))
            db.con.execute("DELETE FROM movements WHERE item_id=? AND type IN ('KUHANJE','POVRAT')", (iid,))
            for c in bc:
                disp = display.get(c["batch_id"], (None, None))
                first = True
                for a in c["new"]:
                    db.con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty,display) VALUES(?,?,?,?,?)",
                                   (c["batch_id"], iid, a["lot_id"], a["qty"], disp[0] if first else None))
                    first = False
                    db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                                   (c["date"] + " 12:00", iid, a["lot_id"], -a["qty"], "KUHANJE", c["batch_no"], "Inventura – FIFO"))
                if not c["new"] and disp[0] and disp[1] and db.val("SELECT COUNT(*) FROM lots WHERE id=?", (disp[1],)):
                    db.con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty,display) VALUES(?,?,?,?,?)",
                                   (c["batch_id"], iid, disp[1], 0, disp[0]))
                if c["changed"]:
                    n_b.add(c["batch_id"])
            # 2) stanje LOT-ova + usklađenje kartice artikla
            for l in [x for x in res["lots"] if x["item_id"] == iid]:
                db.con.execute("UPDATE lots SET qty_left=? WHERE id=?", (max(l["new"], 0), l["lot_id"]))
                bal = r4(l["new"] - (db.val("SELECT COALESCE(SUM(qty),0) FROM movements WHERE lot_id=?", (l["lot_id"],)) or 0))
                if abs(bal) > TOL:
                    db.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                                   (ts, iid, l["lot_id"], bal, MT_INV, l["lot_no"], "Usklađenje stanja nakon inventure"))
                if l["changed"]:
                    n_l += 1
    db.set_setting("inventura_last", ts)
    return {"items": len(ids), "batches": len(n_b), "lots": n_l, "todo": res["todo"]}
