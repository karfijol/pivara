"""
HACCP dio podatkovnog sloja (verzija 2.0): fermentacija, kuhanje (CCP), pakiranje, prijem robe,
CIP, oprema i mlin, štetnici, edukacija, zaposlenici i metapodaci dokumenata.
Klasa HaccpMixin se miješa u DB (db.py) i koristi njegove metode q/one/val/x.
"""
import json
import datetime as dt

EPS = 1e-6

CIP_TYPES = ["Redovni CIP (nakon proizvodnje)", "CIP prije početka nove šarže", "Korektivni CIP",
             "Nakon održavanja", "CIP kegova prije punjenja"]
CIP_EQUIPMENT = ["Komovnik", "Kotao za kuhanje", "Vrtložnik", "Pločasti izmjenjivač topline", "Fermentor",
                 "Bistrenik", "Cjevovod", "Keg punilica", "Kegovi", "Ostalo"]
EQ_CATEGORIES = ["Mlin", "Varionica", "Fermentor", "Punilica", "Ostalo"]
PACK_TYPES = ["Keg", "Boca", "Limenka", "Ostalo"]

RECEIPT_DOCS = ["Deklaracija o sukladnosti (DoC)", "Specifikacija materijala", "COA", "Račun / dostavnica"]
RECEIPT_CHECKS_ALL = ["Dokumentacija potpuna i ispravna", "Materijal čvrst, čist i neoštećen",
                      "Bez prisutnosti stranih tijela", "Bez mirisa, vlage, plijesni", "Usklađeno s narudžbom",
                      "Usklađeno sa specifikacijom"]
RECEIPT_CHECKS_RAW = ["Vlaga unutar dopuštenih granica", "Boja i čistoća zrna", "Bez živih/ mrtvih štetnika",
                      "Bez lomljenih i nečistoće", "LOT kooperanta jasno označen"]
RECEIPT_CHECKS_PACK = ["Kegovi čisti i bez oštećenja", "Unutrašnjost kegova čista"]

# ključ: (šifra, naslov, verzija, datum verzije) – prema predlošcima pivovare, izmjenjivo u postavkama
DOC_DEFAULTS = {
    "brew": ("HACCP-Z-03", "EVIDENCIJA KUHANJA I UTROŠKA SIROVINA", "1", "2026-03-13"),
    "ferm": ("HACCP-Z-05", "EVIDENCIJA FERMENTACIJE", "1", "2026-03-13"),
    "pack": ("HACCP-Z-06", "EVIDENCIJA PAKIRANJA", "1", "2026-03-13"),
    "ccp": ("HACCP-Z-06", "CCP KONTROLA KUHANJA SLADOVINE – TEMPERATURA (PROCESNI KORAK A9)", "1", "2026-03-18"),
    "receipt": ("HACCP-Z-11", "EVIDENCIJA PRIJEMA MATERIJALA (SIROVINA I AMBALAŽA)", "1", "2026-03-13"),
    "training": ("HACCP-ZAP-HR-01", "EVIDENCIJA O EDUKACIJI", "1", "2026-03-12"),
    "mill": ("HACCP-Z-PRP-01-KOM", "ZAPISNIK O KONTROLI MLINA", "1", "2026-03-12"),
    "maint": ("HACCP-Z-PRP-03-OOP", "ZAPISNIK O ODRŽAVANJU OPREME", "1", "2026-03-12"),
    "pest": ("HACCP-Z-PRP-02-ŠT", "ZAPISNIK O POJAVI ŠTETNIKA", "1", "2026-03-12"),
    "cip": ("HACCP-Z-PRP-01-CIP", "ZAPISNIK O PROVEDBI CIP POSTUPKA", "1", "2026-03-12"),
}
DOC_NAMES = {"brew": "Kuhanje i utrošak sirovina", "ferm": "Fermentacija", "pack": "Pakiranje",
             "ccp": "CCP kuhanje sladovine", "receipt": "Prijem robe i ambalaže", "training": "Edukacija",
             "mill": "Kontrola mlina", "maint": "Održavanje opreme", "pest": "Štetnici", "cip": "CIP postupak"}

HACCP_SCHEMA = """
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS equipment(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, model TEXT, manufacturer TEXT, mfg_date TEXT,
    category TEXT DEFAULT 'Ostalo', capacity_l REAL, interval_days INTEGER DEFAULT 0, note TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS eq_checks(
    id INTEGER PRIMARY KEY, equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, date TEXT NOT NULL, note TEXT, operator TEXT, batch_id INTEGER);

CREATE TABLE IF NOT EXISTS ccp_boil(
    id INTEGER PRIMARY KEY, batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL, lot TEXT, date TEXT,
    start_time TEXT, end_time TEXT, temp REAL, minutes INTEGER, limit_ok INTEGER, result TEXT,
    corrective TEXT, operator TEXT);

CREATE TABLE IF NOT EXISTS packaging(
    id INTEGER PRIMARY KEY, date TEXT, batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL, lot TEXT,
    pack_type TEXT, pack_lot TEXT, units INTEGER, unit_l REAL, total_l REAL, shelf_months INTEGER,
    best_before TEXT, operator TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS receipts(
    id INTEGER PRIMARY KEY, date TEXT, doc_no TEXT, supplier TEXT, material TEXT, mat_type TEXT,
    quantity TEXT, lot_no TEXT, lot_id INTEGER, docs TEXT, docs_other TEXT, checks TEXT, deviations TEXT,
    decision TEXT, inspector TEXT, qm TEXT, qm_date TEXT);

CREATE TABLE IF NOT EXISTS trainings(
    id INTEGER PRIMARY KEY, topic TEXT, goal TEXT, date TEXT, time TEXT, duration_h REAL, place TEXT,
    lecturer TEXT, content TEXT, test_methods TEXT, test_result TEXT, participants TEXT, made_by TEXT,
    reviewed_by TEXT, made_date TEXT);

CREATE TABLE IF NOT EXISTS pests(
    id INTEGER PRIMARY KEY, date TEXT, time TEXT, pest TEXT, room TEXT, measures TEXT, corrective TEXT,
    corrective_date TEXT, ver_visual INTEGER DEFAULT 0, ver_date TEXT, ver_by TEXT, ver_result TEXT,
    operator TEXT, manager TEXT, review_date TEXT);

CREATE TABLE IF NOT EXISTS cips(
    id INTEGER PRIMARY KEY, date TEXT, start_time TEXT, end_time TEXT, cip_type TEXT,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL, batch_no TEXT, equipment TEXT,
    fermentor_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL, keg_codes TEXT, other_eq TEXT, operator TEXT,
    closed INTEGER DEFAULT 1, alk_agent TEXT, alk_conc REAL, alk_temp REAL, alk_time REAL, alk_ok INTEGER DEFAULT 1,
    alk_corr TEXT, rinse_ready INTEGER DEFAULT 1, rinse_note TEXT, dis_agent TEXT, dis_conc REAL, dis_time REAL,
    dis_done INTEGER DEFAULT 1, ver_visual INTEGER DEFAULT 1, ver_date TEXT, ver_by TEXT, ver_result TEXT,
    corrective TEXT, op_sign TEXT, manager_sign TEXT, review_date TEXT);

CREATE TABLE IF NOT EXISTS doc_meta(key TEXT PRIMARY KEY, code TEXT, title TEXT, version TEXT, vdate TEXT);
"""

BATCH_NEW_COLS = [("og_sg", "REAL"), ("fg_sg", "REAL"), ("ph", "REAL"), ("wort_l", "REAL"), ("brewer", "TEXT"),
                  ("ferm_start", "TEXT"), ("ferm_end", "TEXT"), ("ferm_temp", "REAL"), ("abv", "REAL"),
                  ("ferm_by", "TEXT")]


def _today():
    return dt.date.today().isoformat()


def add_months(iso, months):
    d = dt.date.fromisoformat(iso)
    m = d.month - 1 + int(months)
    y, m = d.year + m // 12, m % 12 + 1
    import calendar
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1])).isoformat()


def abv_from_sg(og, fg):
    if og and fg and og > fg:
        return round((og - fg) * 131.25, 1)
    return None


def compress_codes(codes):
    """['K30-001','K30-002','K30-003','K20-005'] -> 'K30-001–K30-003, K20-005'"""
    import re
    parsed = []
    for c in sorted(codes):
        m = re.match(r"^(.*?)(\d+)$", c)
        parsed.append((m.group(1), int(m.group(2)), len(m.group(2)), c) if m else (c, None, 0, c))
    out, run = [], []
    for p in parsed:
        if run and p[1] is not None and run[-1][1] is not None and p[0] == run[-1][0] and p[1] == run[-1][1] + 1:
            run.append(p)
        else:
            if run:
                out.append(run)
            run = [p]
    if run:
        out.append(run)
    return ", ".join(r[0][3] if len(r) == 1 else f"{r[0][3]}–{r[-1][3]}" for r in out)


class HaccpMixin:
    # ------------------------------------------------------------ migracija na 2.0
    def _migrate(self):
        self.con.executescript(HACCP_SCHEMA)
        cols = {r["name"] for r in self.q("PRAGMA table_info(batches)")}
        for c, t in BATCH_NEW_COLS:
            if c not in cols:
                self.con.execute(f"ALTER TABLE batches ADD COLUMN {c} {t}")
        if "display" not in {r["name"] for r in self.q("PRAGMA table_info(batch_consumption)")}:
            self.con.execute("ALTER TABLE batch_consumption ADD COLUMN display TEXT")
        if "code" not in {r["name"] for r in self.q("PRAGMA table_info(recipes)")}:
            self.con.execute("ALTER TABLE recipes ADD COLUMN code TEXT")
        for k, (code, title, ver, vdate) in DOC_DEFAULTS.items():
            self.con.execute("INSERT OR IGNORE INTO doc_meta(key,code,title,version,vdate) VALUES(?,?,?,?,?)",
                             (k, code, title, ver, vdate))
        if not self.val("SELECT COUNT(*) FROM equipment"):
            for e in [
                ("SS Grain Mill", "MLIN-1", "SS Grain Mill", "SS Brewtech", "Mlin", None, 0),
                ("Varionica SS Brewtech 1 BBL", "VAR-1", "1 BBL Brewhouse", "SS Brewtech", "Varionica", 117, 30),
                ("Fermentor 1", "F1", "F300 Unitank", "Brewtools", "Fermentor", 300, 30),
                ("Fermentor 2", "F2", "F300 Unitank", "Brewtools", "Fermentor", 300, 30),
                ("Fermentor 3", "F3", "F300 Unitank", "Brewtools", "Fermentor", 300, 30),
            ]:
                self.con.execute("""INSERT INTO equipment(name,code,model,manufacturer,category,capacity_l,interval_days)
                                    VALUES(?,?,?,?,?,?,?)""", e)
        if not self.val("SELECT COUNT(*) FROM employees"):
            for n, r in [("Ivo Ivić", "Voditelj proizvodnje"), ("Marko Marić", "Operater"),
                         ("Ana Anić", "Voditelj kvalitete")]:
                self.con.execute("INSERT INTO employees(name,role) VALUES(?,?)", (n, r))
        self.con.commit()

    # ------------------------------------------------------------ zajedničko
    def doc_meta(self, key):
        m = self.one("SELECT * FROM doc_meta WHERE key=?", (key,))
        return m or dict(zip(("code", "title", "version", "vdate"), DOC_DEFAULTS[key]), key=key)

    def all_doc_meta(self):
        return self.q("SELECT * FROM doc_meta ORDER BY key")

    def save_doc_meta(self, key, data):
        self._upsert_key("doc_meta", key, data)

    def _upsert_key(self, table, key, data):
        keys = list(data)
        self.x(f"UPDATE {table} SET {','.join(k + '=?' for k in keys)} WHERE key=?", [data[k] for k in keys] + [key])

    def employees(self, active=True):
        return self.q("SELECT * FROM employees" + (" WHERE active=1" if active else "") + " ORDER BY name")

    def employee_names(self):
        return [e["name"] for e in self.employees()]

    def save_employee(self, data, id=None):
        return self._upsert("employees", data, id)

    def delete_employee(self, id):
        self.x("UPDATE employees SET active=0 WHERE id=?", (id,))

    def save_record(self, table, data, id=None):
        data = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v) for k, v in data.items()}
        return self._upsert(table, data, id)

    def delete_record(self, table, id):
        assert table in ("ccp_boil", "packaging", "receipts", "trainings", "pests", "cips", "eq_checks")
        self.x(f"DELETE FROM {table} WHERE id=?", (id,))

    def record(self, table, id):
        r = self.one(f"SELECT * FROM {table} WHERE id=?", (id,))
        if r:
            for k in ("docs", "checks", "test_methods", "participants", "equipment"):
                if k in r and isinstance(r[k], str) and r[k][:1] in "[{":
                    try:
                        r[k] = json.loads(r[k])
                    except ValueError:
                        pass
        return r

    @staticmethod
    def _period(sql, col, d_from, d_to, args):
        if d_from:
            sql += f" AND {col}>=?"
            args.append(d_from)
        if d_to:
            sql += f" AND {col}<=?"
            args.append(d_to)
        return sql

    # ------------------------------------------------------------ fermentacija / kuhanje
    def brewed_batches(self, d_from=None, d_to=None, desc=True):
        sql = """SELECT b.*, r.name AS recipe, r.style FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                 WHERE b.status<>'Planirano'"""
        args = []
        sql = self._period(sql, "b.brew_date", d_from, d_to, args)
        return self.q(sql + f" ORDER BY b.brew_date {'DESC' if desc else 'ASC'}, b.id", args)

    def finish_fermentation(self, batch_id, date=None, fg_sg=None, abv=None, by=None):
        b = self.batch(batch_id)
        upd = {"ferm_end": date or _today()}
        if fg_sg:
            upd["fg_sg"] = fg_sg
        if abv is None:
            abv = abv_from_sg(b.get("og_sg"), fg_sg or b.get("fg_sg"))
        if abv is not None:
            upd["abv"] = abv
        if by:
            upd["ferm_by"] = by
        if b["status"] == "Fermentacija":
            upd["status"] = "Odležavanje"
        if not b.get("ferm_start"):
            upd["ferm_start"] = b["brew_date"]
        self.update_batch(batch_id, upd)

    def batch_consumption_by_cat(self, batch_id):
        rows = self.q("""SELECT c.item_id, c.lot_id, c.qty, c.display, i.name, i.unit, i.category, l.lot_no
                         FROM batch_consumption c JOIN items i ON i.id=c.item_id JOIN lots l ON l.id=c.lot_id
                         WHERE c.batch_id=? ORDER BY i.category, i.name, c.id""", (batch_id,))
        groups = {"Slad": [], "Hmelj": [], "Kvasac": [], "Ostalo": []}
        for r in rows:
            cat = r["category"] if r["category"] in ("Slad", "Hmelj", "Kvasac") else "Ostalo"
            groups[cat].append(r)
        return groups

    def batch_item_totals(self, batch_id):
        return self.q("""SELECT c.item_id, i.name, i.unit, i.category, SUM(c.qty) AS qty, MAX(c.display) AS display,
                         GROUP_CONCAT(l.lot_no, ', ') AS lots
                         FROM batch_consumption c JOIN items i ON i.id=c.item_id JOIN lots l ON l.id=c.lot_id
                         WHERE c.batch_id=? GROUP BY c.item_id ORDER BY i.category, i.name""", (batch_id,))

    def batch_set_item_qty(self, batch_id, item_id, new_total):
        """Ispravak stvarnog utroška: više -> dodatno skidanje FIFO, manje -> povrat u zadnje korištene LOT-ove."""
        from db import ShortageError, r4, now
        b = self.batch(batch_id)
        cur = self.val("SELECT COALESCE(SUM(qty),0) FROM batch_consumption WHERE batch_id=? AND item_id=?",
                       (batch_id, item_id))
        diff = r4(new_total - cur)
        if abs(diff) < EPS:
            return
        if diff > 0:
            alloc, missing = self.allocate_fifo(item_id, diff)
            if missing > EPS:
                it = self.item(item_id)
                raise ShortageError([{"name": it["name"], "missing": missing, "unit": it["unit"]}])
            with self.con:
                self._consume(alloc, item_id, "KUHANJE", b["batch_no"], "Ispravak utroška", batch_id=batch_id)
            return
        back = -diff
        with self.con:
            for c in self.q("SELECT * FROM batch_consumption WHERE batch_id=? AND item_id=? ORDER BY id DESC",
                            (batch_id, item_id)):
                if back <= EPS:
                    break
                take = r4(min(back, c["qty"]))
                self.con.execute("UPDATE lots SET qty_left=ROUND(qty_left+?,4) WHERE id=?", (take, c["lot_id"]))
                if c["qty"] - take <= EPS:
                    self.con.execute("DELETE FROM batch_consumption WHERE id=?", (c["id"],))
                else:
                    self.con.execute("UPDATE batch_consumption SET qty=ROUND(qty-?,4) WHERE id=?", (take, c["id"]))
                self.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                                 (now(), item_id, c["lot_id"], take, "POVRAT", b["batch_no"], "Ispravak utroška"))
                back = r4(back - take)

    # ------------------------------------------------------------ CCP kuhanje sladovine
    def ccp_rows(self, d_from=None, d_to=None, batch_id=None):
        sql = "SELECT c.*, b.batch_no FROM ccp_boil c LEFT JOIN batches b ON b.id=c.batch_id WHERE 1=1"
        args = []
        if batch_id:
            sql += " AND c.batch_id=?"
            args.append(batch_id)
        sql = self._period(sql, "c.date", d_from, d_to, args)
        return self.q(sql + " ORDER BY c.date, c.start_time, c.id", args)

    def save_ccp(self, data, id=None):
        if data.get("batch_id") and not data.get("lot"):
            data["lot"] = self.batch(data["batch_id"])["batch_no"]
        mins = data.get("minutes")
        if not mins and data.get("start_time") and data.get("end_time"):
            h1, m1 = map(int, data["start_time"].split(":"))
            h2, m2 = map(int, data["end_time"].split(":"))
            mins = (h2 * 60 + m2) - (h1 * 60 + m1)
            data["minutes"] = mins if mins > 0 else mins + 1440
        ok = (data.get("temp") or 0) >= 100
        data["limit_ok"] = 1 if ok else 0
        data["result"] = "OK" if ok or data.get("corrective") else "NE"
        return self.save_record("ccp_boil", data, id)

    # ------------------------------------------------------------ pakiranje
    def packaging_rows(self, d_from=None, d_to=None):
        sql = "SELECT p.*, b.batch_no FROM packaging p LEFT JOIN batches b ON b.id=p.batch_id WHERE 1=1"
        args = []
        sql = self._period(sql, "p.date", d_from, d_to, args)
        return self.q(sql + " ORDER BY p.date, p.id", args)

    def save_packaging(self, data, id=None):
        if data.get("batch_id") and not data.get("lot"):
            data["lot"] = self.batch(data["batch_id"])["batch_no"]
        units, unit_l = data.get("units") or 0, data.get("unit_l") or 0
        if units and unit_l and not data.get("total_l"):
            data["total_l"] = round(units * unit_l, 2)
        if data.get("shelf_months") and data.get("date") and not data.get("best_before"):
            data["best_before"] = add_months(data["date"], data["shelf_months"])
        return self.save_record("packaging", data, id)

    def package_from_kegs(self, batch_id, keg_ids, date, operator=None, total_override=None):
        kegs = [self.one("SELECT * FROM kegs WHERE id=?", (k,)) for k in keg_ids]
        by_size = {}
        for k in kegs:
            by_size.setdefault(k["size_l"], []).append(k["code"])
        shelf = int(self.get_setting("shelf_months") or 6)
        ids = []
        full = sum(size * len(codes) for size, codes in by_size.items())
        groups = list(by_size.items())
        for n, (size, codes) in enumerate(groups):
            total = None
            if total_override and n == len(groups) - 1:  # zadnji keg nije pun: razlika ide na zadnju grupu
                total = round(size * len(codes) - (full - total_override), 2)
            ids.append(self.save_packaging({"date": date, "batch_id": batch_id, "pack_type": "Keg",
                                            "pack_lot": compress_codes(codes), "units": len(codes), "unit_l": size,
                                            "total_l": total, "shelf_months": shelf, "operator": operator}))
        return ids

    # ------------------------------------------------------------ prijem robe
    def receipts(self, d_from=None, d_to=None):
        sql = "SELECT * FROM receipts WHERE 1=1"
        args = []
        sql = self._period(sql, "date", d_from, d_to, args)
        return self.q(sql + " ORDER BY date DESC, id DESC", args)

    def lots_without_receipt(self, days=90):
        since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
        return self.q("""SELECT v.*, s.name AS supplier_name FROM v_lots v LEFT JOIN suppliers s ON s.id=v.supplier_id
                         WHERE v.is_chemical=0 AND v.received_date>=?
                         AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.lot_id=v.id)
                         ORDER BY v.received_date DESC""", (since,))

    def receipt_defaults(self, lot_id):
        l = self.lot(lot_id)
        sup = self.val("SELECT name FROM suppliers WHERE id=?", (l["supplier_id"],)) if l["supplier_id"] else ""
        po = self.val("SELECT po_no FROM purchase_orders WHERE id=?", (l["po_id"],)) if l.get("po_id") else ""
        from db import hr
        return {"date": l["received_date"], "doc_no": l.get("note") or po or "", "supplier": sup,
                "material": l["item_name"], "mat_type": "Ambalaža" if l["category"] == "Ambalaža" else "Sirovina",
                "quantity": f"{hr(l['qty_received'])} {l['unit']}", "lot_no": l["lot_no"], "lot_id": lot_id,
                "decision": "PRIHVAĆENO", "qm_date": l["received_date"]}

    # ------------------------------------------------------------ CIP
    def cips(self, d_from=None, d_to=None):
        sql = """SELECT c.*, e.name AS fermentor FROM cips c LEFT JOIN equipment e ON e.id=c.fermentor_id WHERE 1=1"""
        args = []
        sql = self._period(sql, "c.date", d_from, d_to, args)
        return self.q(sql + " ORDER BY c.date DESC, c.start_time DESC, c.id DESC", args)

    def last_cip(self):
        return self.one("SELECT * FROM cips ORDER BY date DESC, id DESC LIMIT 1")

    def fermentors(self):
        return self.q("SELECT * FROM equipment WHERE category='Fermentor' AND active=1 ORDER BY name")

    def fermentor_status(self):
        """Za svaki fermentor: zadnja šarža, stanje i treba li CIP."""
        out = []
        for f in self.fermentors():
            b = self.one("""SELECT * FROM batches WHERE tank=? AND status<>'Planirano'
                            ORDER BY brew_date DESC, id DESC LIMIT 1""", (f["name"],))
            last_cip = self.one("SELECT * FROM cips WHERE fermentor_id=? ORDER BY date DESC, id DESC LIMIT 1", (f["id"],))
            cip_date = last_cip["date"] if last_cip else None
            cip_txt = "{2}.{1}.{0}.".format(*cip_date.split("-")) if cip_date else ""
            if b and not b.get("ferm_end") and b["status"] in ("Fermentacija", "Odležavanje"):
                state, need = f"Zauzet: {b['batch_no']}", False
            elif b and b.get("ferm_end") and (not cip_date or cip_date < b["ferm_end"]):
                state, need = f"CIP nakon fermentacije ({b['batch_no']})", True
            else:
                state, need = "Prazan" + (" · zadnji CIP " + cip_txt if cip_date else ""), False
            out.append({"id": f["id"], "name": f["name"], "state": state, "need_cip": need, "batch": b,
                        "last_cip": cip_date})
        return out

    def cip_ok_before_brew(self, fermentor_name, brew_date, batch_id=None):
        """Postoji li CIP fermentora nakon završetka prethodne šarže u tom tanku (a najkasnije na dan kuhanja)."""
        f = self.one("SELECT * FROM equipment WHERE name=?", (fermentor_name,))
        if not f:
            return True
        prev = self.one("""SELECT * FROM batches WHERE tank=? AND status<>'Planirano' AND brew_date<=? AND id<>?
                           ORDER BY brew_date DESC, id DESC LIMIT 1""", (fermentor_name, brew_date, batch_id or 0))
        since = (prev.get("ferm_end") or prev["brew_date"]) if prev else "0000"
        return bool(self.val("""SELECT 1 FROM cips WHERE fermentor_id=? AND date>=? AND date<=?
                                AND cip_type='CIP prije početka nove šarže'""", (f["id"], since, brew_date)))

    # ------------------------------------------------------------ oprema, mlin, održavanje
    def equipment(self, category=None, active=True):
        sql = """SELECT e.*, (SELECT MAX(date) FROM eq_checks c WHERE c.equipment_id=e.id AND c.kind='odrzavanje') AS last_maint,
                 (SELECT MAX(date) FROM eq_checks c WHERE c.equipment_id=e.id AND c.kind='kontrola') AS last_check
                 FROM equipment e WHERE 1=1"""
        args = []
        if active:
            sql += " AND e.active=1"
        if category:
            sql += " AND e.category=?"
            args.append(category)
        return self.q(sql + " ORDER BY e.category, e.name", args)

    def save_equipment(self, data, id=None):
        return self._upsert("equipment", data, id)

    def eq_checks(self, equipment_id=None, kind=None, d_from=None, d_to=None):
        sql = "SELECT c.*, e.name AS eq_name, b.batch_no FROM eq_checks c JOIN equipment e ON e.id=c.equipment_id LEFT JOIN batches b ON b.id=c.batch_id WHERE 1=1"
        args = []
        if equipment_id:
            sql += " AND c.equipment_id=?"
            args.append(equipment_id)
        if kind:
            sql += " AND c.kind=?"
            args.append(kind)
        sql = self._period(sql, "c.date", d_from, d_to, args)
        return self.q(sql + " ORDER BY c.date, c.id", args)

    def mill(self):
        return self.one("SELECT * FROM equipment WHERE category='Mlin' AND active=1 ORDER BY id LIMIT 1")

    def add_mill_check(self, date, note="Uređaj je u redu", operator=None, batch_id=None):
        m = self.mill()
        if not m:
            return None
        return self.save_record("eq_checks", {"equipment_id": m["id"], "kind": "kontrola", "date": date,
                                              "note": note, "operator": operator, "batch_id": batch_id})

    # ------------------------------------------------------------ štetnici, edukacija
    def pests(self, d_from=None, d_to=None):
        sql = "SELECT * FROM pests WHERE 1=1"
        args = []
        sql = self._period(sql, "date", d_from, d_to, args)
        return self.q(sql + " ORDER BY date DESC, id DESC", args)

    def trainings(self):
        return self.q("SELECT * FROM trainings ORDER BY date DESC, id DESC")

    # ------------------------------------------------------------ HACCP zadaci (nadzorna ploča)
    def haccp_items(self, days=60):
        """Pojedinačni HACCP nedostaci; svaki ima stabilan ključ (za zanemarivanje) i podatke za detalje."""
        from db import hr
        since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
        t = _today()
        out = []

        def add(key, typ, sev, text, rec, desc, date=None, **ref):
            out.append({"key": key, "type": typ, "sev": sev, "text": text, "rec": rec, "desc": desc,
                        "date": date, "ref": ref})

        for f in self.fermentor_status():
            if f["need_cip"]:
                b = f["batch"]
                add(f"cip:{f['id']}:{b['id']}", "CIP", "warn",
                    f"{f['name']}: CIP nakon fermentacije šarže {b['batch_no']}", f["name"],
                    f"CIP nakon fermentacije šarže {b['batch_no']}", b.get("ferm_end"),
                    fermentor_id=f["id"], batch_id=b["id"], batch_no=b["batch_no"])
        mill = self.mill()
        for b in self.brewed_batches(since):
            beer = b.get("recipe") or ""
            ref = dict(batch_id=b["id"], batch_no=b["batch_no"], brew_date=b["brew_date"])
            if not self.val("SELECT 1 FROM ccp_boil WHERE batch_id=?", (b["id"],)):
                add(f"ccp:{b['id']}", "CCP", "bad", f"Nema CCP kontrole kuhanja za {b['batch_no']}",
                    b["batch_no"], f"{beer} · nema CCP kontrole kuhanja", b["brew_date"], **ref)
            if mill and not self.val("SELECT 1 FROM eq_checks WHERE equipment_id=? AND kind='kontrola' AND date=?",
                                     (mill["id"], b["brew_date"])):
                add(f"mlin:{b['id']}", "Mlin", "warn", f"Nema kontrole mlina na dan kuhanja {b['batch_no']}",
                    b["batch_no"], f"{beer} · nema kontrole mlina na dan kuhanja", b["brew_date"], **ref)
            if b["status"] in ("Pakirano", "Završeno") and not b.get("ferm_end"):
                add(f"ferm:{b['id']}", "Fermentacija", "warn", f"Nije upisan završetak fermentacije za {b['batch_no']}",
                    b["batch_no"], f"{beer} · {b['status'].lower()}, nema datuma završetka fermentacije",
                    b["brew_date"], **ref)
            if b["status"] in ("Pakirano", "Završeno") and not self.val("SELECT 1 FROM packaging WHERE batch_id=?",
                                                                         (b["id"],)):
                add(f"pack:{b['id']}", "Pakiranje", "warn", f"Nema evidencije pakiranja za {b['batch_no']}",
                    b["batch_no"], f"{beer} · {b['status'].lower()}, nema evidencije pakiranja", b["brew_date"], **ref)
        for e in self.equipment():
            if e["interval_days"]:
                due = (dt.date.fromisoformat(e["last_maint"]) + dt.timedelta(days=e["interval_days"])).isoformat() \
                    if e["last_maint"] else None
                if not due or due < t:
                    txt = f"istekla {due[8:10]}.{due[5:7]}.{due[:4]}." if due else "nije evidentirana"
                    add(f"odrz:{e['id']}:{due or '-'}", "Održavanje", "warn", f"{e['name']}: redovita kontrola {txt}",
                        e["name"], f"Redovita kontrola {txt} (svakih {e['interval_days']} dana)", due,
                        equipment_id=e["id"])
        for l in self.lots_without_receipt(days):
            add(f"prijem:{l['id']}", "Prijem", "warn", f"{l['item_name']} · LOT {l['lot_no']} bez zapisnika o prijemu",
                l["lot_no"], f"{l['item_name']} · {l.get('supplier_name') or 'nepoznat dobavljač'} · "
                f"{hr(l['qty_received'])} {l['unit']}", l["received_date"], lot_id=l["id"])
        return out

    def haccp_tasks(self, days=60):
        """Vidljivi (nezanemareni) HACCP nedostaci."""
        return self.visible(self.haccp_items(days))

    # ------------------------------------------------------------ podaci za grafove
    def chart_data(self):
        months = []
        d = dt.date.today().replace(day=1)
        for _ in range(12):
            months.append(d.strftime("%Y-%m"))
            d = (d - dt.timedelta(days=1)).replace(day=1)
        months.reverse()
        vol = {r["m"]: r["v"] for r in self.q("""SELECT substr(brew_date,1,7) AS m, SUM(volume_l) AS v FROM batches
                                                 WHERE status<>'Planirano' GROUP BY m""")}
        coverage = []
        for i in self.items():
            if i["min_stock"]:
                coverage.append((i["name"], i["stock"] / i["min_stock"], i["stock"], i["min_stock"], i["unit"]))
        coverage.sort(key=lambda x: x[1])
        value = self.q("""SELECT i.category AS cat, SUM(l.qty_left*l.unit_price) AS v FROM lots l
                          JOIN items i ON i.id=l.item_id WHERE l.qty_left>0 GROUP BY i.category ORDER BY v DESC""")
        return {"production": [(m, vol.get(m, 0) or 0) for m in months], "kegs": self.keg_summary(),
                "coverage": coverage[:7], "value": [(v["cat"] or "Ostalo", v["v"] or 0) for v in value if v["v"]]}

    # ------------------------------------------------------------ demo HACCP podaci
    def seed_haccp_demo(self):
        d = lambda days: (dt.date.today() + dt.timedelta(days=days)).isoformat()
        f1 = self.val("SELECT id FROM equipment WHERE name='Fermentor 1'")
        brewed = self.brewed_batches(desc=False)
        cip_base = {"start_time": "15:00", "end_time": "16:00", "operator": "Ivo Ivić", "closed": 1,
                    "alk_agent": "BIS L 4040", "alk_conc": 2, "alk_temp": 65, "alk_time": 30, "alk_ok": 1,
                    "rinse_ready": 1, "dis_agent": "BIS PER S", "dis_conc": 0.2, "dis_time": 30, "dis_done": 1,
                    "ver_visual": 1, "ver_by": "Ivo Ivić", "ver_result": "Oprema je oprana i dezinficirana",
                    "op_sign": "Ivo Ivić", "manager_sign": "Ivo Ivić"}
        for n, b in enumerate(brewed):
            tank = ["Fermentor 1", "Fermentor 2", "Fermentor 3"][n % 3]
            fid = self.val("SELECT id FROM equipment WHERE name=?", (tank,))
            self.update_batch(b["id"], {"tank": tank, "og_sg": 1.050, "ph": 5.5, "wort_l": b["volume_l"],
                                        "brewer": "Ivo Ivić", "ferm_start": b["brew_date"],
                                        "ferm_temp": 12 if "Pils" in (b["recipe"] or "") else 20, "ferm_by": "Ivo Ivić"})
            prev = (dt.date.fromisoformat(b["brew_date"]) - dt.timedelta(days=1)).isoformat()
            self.save_record("cips", dict(cip_base, date=prev, cip_type="CIP prije početka nove šarže",
                                          equipment=["Fermentor"], fermentor_id=fid, ver_date=prev, review_date=prev))
            self.add_mill_check(b["brew_date"], operator="Marko Marić", batch_id=b["id"])
            self.save_ccp({"batch_id": b["id"], "date": b["brew_date"], "start_time": "10:00", "end_time": "11:00",
                           "temp": 100, "operator": "Ivo Ivić"})
            self.save_ccp({"batch_id": b["id"], "date": b["brew_date"], "start_time": "14:00", "end_time": "15:00",
                           "temp": 100, "operator": "Ivo Ivić"})
        if brewed:
            b0 = brewed[0]
            end = (dt.date.fromisoformat(b0["brew_date"]) + dt.timedelta(days=12)).isoformat()
            self.update_batch(b0["id"], {"ferm_end": end, "fg_sg": 1.012, "abv": abv_from_sg(1.050, 1.012)})
            kegs = [k["id"] for k in self.q("SELECT id FROM kegs WHERE batch_id=?", (b0["id"],))]
            if kegs:
                self.package_from_kegs(b0["id"], kegs, end, "Ivo Ivić")
            self.save_record("cips", dict(cip_base, date=end, cip_type="Redovni CIP (nakon proizvodnje)",
                                          equipment=["Fermentor"], fermentor_id=f1, ver_date=end, review_date=end))
        var = self.val("SELECT id FROM equipment WHERE category='Varionica'")
        for days in (-40, -10):
            for e in self.equipment():
                if e["category"] != "Mlin":
                    self.save_record("eq_checks", {"equipment_id": e["id"], "kind": "odrzavanje", "date": d(days),
                                                   "note": "Uređaj je u ispravnom stanju", "operator": "Marko Marić"})
        self.save_record("cips", dict(cip_base, date=d(-10), cip_type="Nakon održavanja",
                                      equipment=["Kotao za kuhanje", "Vrtložnik", "Pločasti izmjenjivač topline"],
                                      fermentor_id=None, ver_date=d(-10), review_date=d(-10)))
        _ = var
        for lot in self.lots_without_receipt(365)[:4]:
            r = self.receipt_defaults(lot["id"])
            r.update(docs=[RECEIPT_DOCS[3], RECEIPT_DOCS[0]],
                     checks={c: "DA" for c in RECEIPT_CHECKS_ALL + RECEIPT_CHECKS_RAW},
                     inspector="Marko Marić", qm="Marko Marić")
            self.save_record("receipts", r)
        self.save_record("trainings", {"topic": "Osnove HACCP sustava i higijena u pivovari",
                                       "goal": "Upoznati zaposlenike s CCP točkama i higijenskim postupcima",
                                       "date": d(-30), "time": "09:00", "duration_h": 2, "place": "Pivovara",
                                       "lecturer": "Ana Anić", "content": "CCP kuhanje sladovine, CIP postupak, "
                                       "prijem robe, osobna higijena.", "test_methods": ["Usmeno"],
                                       "test_result": "✔", "participants": [
                                           {"name": "Ivo Ivić", "role": "Voditelj proizvodnje", "note": "obnova"},
                                           {"name": "Marko Marić", "role": "Operater", "note": "nova obuka"}],
                                       "made_by": "Ana Anić", "reviewed_by": "Ivo Ivić", "made_date": d(-30)})
        self.save_record("pests", {"date": d(-20), "time": "08:15", "pest": "Miš – tragovi izmeta (1 lokacija)",
                                   "room": "Skladište slada", "measures": "Postavljene dodatne lovke, pregled vreća",
                                   "corrective": "Oštećene vreće uklonjene, pukotina na zidu zatvorena",
                                   "corrective_date": d(-19), "ver_visual": 1, "ver_date": d(-12),
                                   "ver_by": "Ivo Ivić", "ver_result": "Nema novih tragova",
                                   "operator": "Marko Marić", "manager": "Ivo Ivić", "review_date": d(-12)})
