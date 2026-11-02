"""Uvoz povijesnih podataka (povijesni_podaci.json) – nabava, kuhanja s utroškom po LOT-ovima i HACCP evidencije."""
import json
import re
import datetime as dt

from db import r4

DEMO_SUPPLIERS = ("Slad Trade d.o.o.", "Hmeljar j.d.o.o.", "Kvasac Lab", "ProClean Kemija d.o.o.", "Ambalaža Plus")
WIPE_TABLES = ["delivery_lines", "delivery_notes", "ferm_readings", "movements", "batch_consumption", "keg_log", "kegs", "packaging", "ccp_boil", "cips", "receipts",
               "eq_checks", "trainings", "pests", "po_lines", "purchase_orders", "lots", "recipe_items", "batches",
               "recipes", "items", "suppliers", "customers", "dismissed"]


def has_demo(db):
    return bool(db.val(f"SELECT COUNT(*) FROM suppliers WHERE name IN ({','.join('?' * len(DEMO_SUPPLIERS))})",
                       DEMO_SUPPLIERS))


def wipe_data(db):
    """Briše skladišne i HACCP podatke (postavke, zaposlenici, oprema i šifre dokumenata ostaju)."""
    with db.con:
        for t in WIPE_TABLES:
            db.con.execute(f"DELETE FROM {t}")


def _norm(s):
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def import_history(db, path):
    data = json.load(open(path, encoding="utf-8"))
    if db.get_setting("history_imported"):
        raise ValueError(f"Povijesni podaci su već uvezeni ({db.get_setting('history_imported')}).")
    report = [("Napomena", n) for n in data.get("parse_notes", [])]
    note_src = "Uvoz iz evidencije"

    with db.con:
        con = db.con

        # ---- dobavljači i artikli
        sup_ids = {}
        for name in sorted({l["supplier"] for l in data["lots"] if l.get("supplier")}):
            sid = db.val("SELECT id FROM suppliers WHERE lower(name)=lower(?)", (name,))
            if not sid:
                sid = con.execute("INSERT INTO suppliers(name, lead_days) VALUES(?, 7)", (name,)).lastrowid
            sup_ids[name] = sid
        item_ids = {}
        for it in data["items"]:
            iid = db.val("SELECT id FROM items WHERE lower(name)=lower(?)", (it["name"],))
            if not iid:
                sups = [l["supplier"] for l in data["lots"] if l["item"] == it["name"]]
                main = max(set(sups), key=sups.count) if sups else None
                iid = con.execute("INSERT INTO items(name, category, unit, supplier_id) VALUES(?,?,?,?)",
                                  (it["name"], it["category"], it.get("unit") or "kg", sup_ids.get(main))).lastrowid
            item_ids[it["name"]] = iid

        # ---- primke (LOT-ovi)
        for l in data["lots"]:
            db.receive_lot(item_ids[l["item"]], l["qty"], l["lot_no"], l["date"], None, sup_ids.get(l["supplier"]),
                           0, note=f"{note_src} nabave", commit=False)

        def find_lots(item_id, lot_txt, brew_date):
            rows = db.q("SELECT * FROM lots WHERE item_id=? ORDER BY received_date, id", (item_id,))
            n = _norm(lot_txt)
            for test in (lambda r: r["lot_no"] == lot_txt, lambda r: _norm(r["lot_no"]) == n,
                         lambda r: n and (_norm(r["lot_no"]).startswith(n) or n.endswith(_norm(r["lot_no"])))):
                hit = [r for r in rows if test(r)]
                if hit:
                    before = [r for r in hit if r["received_date"] <= brew_date]
                    return before or hit
            return []

        def unknown_lot(item_id, lot_txt, qty, date, batch_no):
            lot_no = lot_txt or f"NEPOZNAT-{batch_no}"
            report.append(("LOT nije u nabavi", f"{batch_no}: {db.item(item_id)['name']} LOT {lot_no} – dodan primitak "
                                                 f"od {qty:g} kg na dan kuhanja (provjerite)"))
            return db.receive_lot(item_id, max(qty, 0.0001), lot_no, date, None, None, 0,
                                  note=f"{note_src} utroška – LOT nije pronađen u nabavi", commit=False)

        # ---- recepture
        rec_ids = {}
        for r in data["recipes"]:
            rid = db.val("SELECT id FROM recipes WHERE lower(name)=lower(?)", (r["name"],))
            if not rid:
                rid = con.execute("INSERT INTO recipes(name, code, batch_size_l, note) VALUES(?,?,?,?)",
                                  (r["name"], r.get("code"), r["batch_size_l"],
                                   "Sastav prema zadnjem kuhanju iz evidencije")).lastrowid
                for ln in r["lines"]:
                    con.execute("INSERT INTO recipe_items(recipe_id,item_id,qty) VALUES(?,?,?)",
                                (rid, item_ids[ln["item"]], ln["qty"]))
            rec_ids[r["name"]] = rid

        # ---- šarže i utrošak po LOT-ovima
        batch_ids = {}
        for b in sorted(data["batches"], key=lambda x: x["brew_date"]):
            if db.val("SELECT 1 FROM batches WHERE batch_no=?", (b["batch_no"],)):
                report.append(("Preskočeno", f"Šarža {b['batch_no']} već postoji"))
                continue
            note = note_src + (f" (u Excelu LOT {b['excel_lot']})" if b.get("excel_lot") != b["batch_no"] else "")
            bid = con.execute("""INSERT INTO batches(batch_no, recipe_id, brew_date, volume_l, status, tank, note, og_sg, ph,
                                 wort_l, brewer, ferm_start, ferm_end, ferm_temp, fg_sg, abv, ferm_by)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (b["batch_no"], rec_ids[b["recipe"]], b["brew_date"], b.get("wort_l") or 290, b["status"],
                               b.get("tank"), note, b.get("og_sg"), b.get("ph"), b.get("wort_l"), b.get("brewer"),
                               b.get("ferm_start"), b.get("ferm_end"), b.get("ferm_temp"), b.get("fg_sg"), b.get("abv"),
                               b.get("ferm_by"))).lastrowid
            batch_ids[b["batch_no"]] = bid
            ts = b["brew_date"] + " 10:00"
            for ln in b["lines"]:
                iid = item_ids[ln["item"]]
                cands = []
                for lt in ln["lots"]:
                    f = find_lots(iid, lt, b["brew_date"])
                    cands += f if f else [db.one("SELECT * FROM lots WHERE id=?", (unknown_lot(
                        iid, lt, ln["qty"] or 0, b["brew_date"], b["batch_no"]),))]
                if not cands:
                    cands = [db.one("SELECT * FROM lots WHERE id=?", (unknown_lot(
                        iid, None, ln["qty"] or 0, b["brew_date"], b["batch_no"]),))]
                if not ln["qty"]:  # npr. "6 kom" – sljedivost bez skidanja zalihe
                    con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty,display) VALUES(?,?,?,?,?)",
                                (bid, iid, cands[0]["id"], 0, ln.get("display")))
                    continue
                rem = r4(ln["qty"])
                for i, lot in enumerate(cands):
                    left = db.val("SELECT qty_left FROM lots WHERE id=?", (lot["id"],))
                    last = i == len(cands) - 1
                    take = rem if last else r4(min(rem, max(left, 0)))
                    if take <= 0:
                        continue
                    if last and take > left + 1e-6 and "nije pronađen" in (lot.get("note") or ""):
                        extra = r4(take - max(left, 0))
                        con.execute("UPDATE lots SET qty_received=ROUND(qty_received+?,4), qty_left=ROUND(qty_left+?,4) "
                                    "WHERE id=?", (extra, extra, lot["id"]))
                        left += extra
                    if last and take > left + 1e-6:
                        report.append(("Više od zaprimljenog", f"{b['batch_no']}: {ln['item']} LOT {lot['lot_no']} – "
                                       f"utrošeno {take:g} kg, na LOT-u je ostalo samo {max(left, 0):g} kg"))
                    con.execute("UPDATE lots SET qty_left=MAX(0, ROUND(qty_left-?,4)) WHERE id=?", (take, lot["id"]))
                    con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty) VALUES(?,?,?,?)",
                                (bid, iid, lot["id"], take))
                    con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                                (ts, iid, lot["id"], -take, "KUHANJE", b["batch_no"], note_src))
                    rem = r4(rem - take)
                    if rem <= 0:
                        break

        def bid_of(lot):
            return batch_ids.get(lot) or db.val("SELECT id FROM batches WHERE batch_no=?", (lot,))

        # ---- HACCP evidencije
        for p in data["packaging"]:
            if not bid_of(p["lot"]):
                report.append(("Pakiranje", f"LOT {p['lot']} nije među šaržama – upisano bez veze"))
            db.save_packaging(dict(p, batch_id=bid_of(p["lot"]), note=note_src))
        for c in data["ccp"]:
            db.save_ccp(dict(c, batch_id=bid_of(c["lot"])))
        mill = db.mill()
        brew_by_date = {b["brew_date"]: batch_ids.get(b["batch_no"]) for b in data["batches"]}
        for m in data["mill"]:
            if mill:
                db.save_record("eq_checks", {"equipment_id": mill["id"], "kind": "kontrola", "date": m["date"],
                                             "note": m["note"], "operator": m["operator"],
                                             "batch_id": brew_by_date.get(m["date"])})
        for m in data["maintenance"]:
            eid = db.val("SELECT id FROM equipment WHERE name=?", (m["equipment"],))
            if eid:
                db.save_record("eq_checks", {"equipment_id": eid, "kind": "odrzavanje", "date": m["date"],
                                             "note": m["note"], "operator": m["operator"]})
        for c in data["cips"]:
            c = dict(c)
            c["fermentor_id"] = db.val("SELECT id FROM equipment WHERE name=?", (c.pop("fermentor", None),))
            db.save_record("cips", c)
        for r in data["receipts"]:
            r = dict(r)
            item = r.pop("item", None)
            r["lot_id"] = db.val("SELECT id FROM lots WHERE lot_no=? AND item_id=?", (r["lot_no"], item_ids.get(item)))
            db.save_record("receipts", r)
        con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('history_imported', ?)",
                    (f"{data.get('source', '')} – uvezeno {dt.date.today().strftime('%d.%m.%Y.')}",))

    summary = {"items": len(item_ids), "lots": len(data["lots"]), "batches": len(batch_ids),
               "packaging": len(data["packaging"]), "ccp": len(data["ccp"]), "mill": len(data["mill"]),
               "maint": len(data["maintenance"])}
    db.apply_official_abv()
    return summary, report
