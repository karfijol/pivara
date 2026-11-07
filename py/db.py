"""
Podatkovni sloj za skladište mikro pivovare (SQLite).
Sva poslovna logika (FIFO, LOT-ovi, kuhanje, narudžbenice, kegovi...) je ovdje,
GUI (app.py) samo poziva ove metode.
"""
import sqlite3
import re
import unicodedata
import datetime as dt
import math


EPS = 1e-6

CATEGORIES = ["Slad", "Hmelj", "Kvasac", "Dodaci", "Ambalaža", "Kemikalija", "Ostalo"]
UNITS = ["kg", "g", "L", "ml", "kom", "pak"]
BATCH_STATUS = ["Planirano", "Fermentacija", "Odležavanje", "Pakirano", "Završeno"]
PO_STATUS = ["Nacrt", "Poslano", "Djelomično", "Zaprimljeno", "Otkazano"]
PO_OPEN = ("Nacrt", "Poslano", "Djelomično")
KEG_STATUS = ["Čist", "Pun", "Kod kupca", "Prljav", "Servis", "Otpisan"]
# akcija -> (dopušteni početni statusi, novi status)
KEG_ACTIONS = {
    "Napuni": (["Čist"], "Pun"),
    "Isporuči": (["Pun"], "Kod kupca"),
    "Vrati": (["Kod kupca"], "Prljav"),
    "Istočeno (pivnica)": (["Pun"], "Prljav"),
    "Očisti": (["Prljav", "Servis", "Čist"], "Čist"),
    "Na servis": (KEG_STATUS[:-1], "Servis"),
    "Otpiši": (KEG_STATUS[:-1], "Otpisan"),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS suppliers(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, oib TEXT, contact TEXT, phone TEXT,
    email TEXT, address TEXT, lead_days INTEGER DEFAULT 7, note TEXT);

CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, category TEXT, unit TEXT DEFAULT 'kg',
    min_stock REAL DEFAULT 0, reorder_qty REAL DEFAULT 0,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    price REAL DEFAULT 0, is_chemical INTEGER DEFAULT 0,
    hazard TEXT, storage TEXT, shelf_after_open_days INTEGER DEFAULT 0, sds_path TEXT,
    note TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS lots(
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
    lot_no TEXT NOT NULL, qty_received REAL NOT NULL, qty_left REAL NOT NULL,
    received_date TEXT NOT NULL, expiry_date TEXT, opened_date TEXT,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    unit_price REAL DEFAULT 0, po_id INTEGER, note TEXT);

CREATE TABLE IF NOT EXISTS movements(
    id INTEGER PRIMARY KEY, ts TEXT NOT NULL, item_id INTEGER NOT NULL, lot_id INTEGER,
    qty REAL NOT NULL, type TEXT NOT NULL, ref TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS recipes(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, style TEXT, batch_size_l REAL NOT NULL DEFAULT 500,
    note TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS recipe_items(
    id INTEGER PRIMARY KEY, recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL);

CREATE TABLE IF NOT EXISTS batches(
    id INTEGER PRIMARY KEY, batch_no TEXT NOT NULL UNIQUE, recipe_id INTEGER REFERENCES recipes(id),
    brew_date TEXT, volume_l REAL, status TEXT DEFAULT 'Planirano',
    og REAL, fg REAL, tank TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS batch_consumption(
    id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL, lot_id INTEGER NOT NULL, qty REAL NOT NULL);

CREATE TABLE IF NOT EXISTS purchase_orders(
    id INTEGER PRIMARY KEY, po_no TEXT NOT NULL UNIQUE,
    supplier_id INTEGER REFERENCES suppliers(id), order_date TEXT, expected_date TEXT,
    status TEXT DEFAULT 'Nacrt', note TEXT);

CREATE TABLE IF NOT EXISTS po_lines(
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL,
    qty_received REAL DEFAULT 0, unit_price REAL DEFAULT 0);

CREATE TABLE IF NOT EXISTS kegs(
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, size_l REAL DEFAULT 18, keg_type TEXT,
    status TEXT DEFAULT 'Čist', batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    customer TEXT, status_date TEXT, filled_date TEXT, note TEXT, fill_l REAL);

CREATE TABLE IF NOT EXISTS keg_log(
    id INTEGER PRIMARY KEY, keg_id INTEGER NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
    ts TEXT, action TEXT, status TEXT, batch_id INTEGER, customer TEXT, note TEXT);

CREATE VIEW IF NOT EXISTS v_lots AS
SELECT l.*, i.name AS item_name, i.code AS item_code, i.unit, i.category, i.is_chemical, i.hazard,
       CASE WHEN l.opened_date IS NOT NULL AND COALESCE(i.shelf_after_open_days,0) > 0
            THEN MIN(COALESCE(l.expiry_date,'9999-12-31'),
                     date(l.opened_date, '+' || i.shelf_after_open_days || ' days'))
            ELSE l.expiry_date END AS eff_expiry
FROM lots l JOIN items i ON i.id = l.item_id;
"""

DEFAULT_SETTINGS = {
    "brewery_name": "Moja Mikro Pivovara",
    "warn_days": "30",
    "batch_prefix": "B",
    "po_prefix": "NAR",
    "appearance": "Dark",
    "batch_scheme": "haccp",
    "company": "Moja pivovara d.o.o.",
    "approved_by": "Ana Anić",
    "haccp_lead": "Ivo Ivić",
    "haccp_doc_operator": "",
    "haccp_brew_operator": "",
    "prod_lead": "Ivo Ivić",
    "default_operator": "Ivo Ivić",
    "shelf_months": "6",
    "doc_format": "PDF",
    "logo_path": "",
}


def today():
    return dt.date.today().isoformat()


def now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def hr(x):
    return f"{float(x):g}".replace(".", ",")


def r4(x):
    return round(float(x) + 0.0, 4)


class ShortageError(Exception):
    def __init__(self, shortages):
        self.shortages = shortages
        txt = "\n".join(f"• {s['name']}: nedostaje {hr(s['missing'])} {s['unit']}" for s in shortages)
        super().__init__("Nema dovoljno sirovina na zalihi:\n" + txt)


from haccp_db import HaccpMixin  # noqa: E402
from extras_db import ExtrasMixin  # noqa: E402


class DB(HaccpMixin, ExtrasMixin):
    def __init__(self, path):
        self.path = path
        self.con = sqlite3.connect(path)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys=ON")
        self.con.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            self.con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
        self.con.commit()
        self._migrate()
        self._migrate_extras()

    # ---------- osnovno ----------
    def q(self, sql, args=()):
        return [dict(r) for r in self.con.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        r = self.con.execute(sql, args).fetchone()
        return dict(r) if r else None

    def val(self, sql, args=()):
        r = self.con.execute(sql, args).fetchone()
        return r[0] if r else None

    def x(self, sql, args=()):
        cur = self.con.execute(sql, args)
        self.con.commit()
        return cur.lastrowid

    def _upsert(self, table, data, id=None):
        keys = list(data)
        if id:
            self.x(f"UPDATE {table} SET {','.join(k + '=?' for k in keys)} WHERE id=?",
                   [data[k] for k in keys] + [id])
            return id
        return self.x(f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' * len(keys))})",
                      [data[k] for k in keys])

    def get_setting(self, key):
        return self.val("SELECT value FROM settings WHERE key=?", (key,)) or DEFAULT_SETTINGS.get(key, "")

    def set_setting(self, key, value):
        self.x("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, str(value)))

    def warn_date(self):
        try:
            days = int(self.get_setting("warn_days"))
        except ValueError:
            days = 30
        return (dt.date.today() + dt.timedelta(days=days)).isoformat()

    def backup(self, dest):
        self.con.commit()
        b = sqlite3.connect(dest)
        with b:
            self.con.backup(b)
        b.close()

    def is_empty(self):
        return not self.val("SELECT COUNT(*) FROM items")

    # ---------- dobavljači ----------
    def suppliers(self):
        return self.q("SELECT * FROM suppliers ORDER BY name")

    def save_supplier(self, data, id=None):
        return self._upsert("suppliers", data, id)

    def delete_supplier(self, id):
        if self.val("SELECT COUNT(*) FROM purchase_orders WHERE supplier_id=?", (id,)):
            raise ValueError("Dobavljač ima narudžbenice i ne može se obrisati.")
        self.x("DELETE FROM suppliers WHERE id=?", (id,))

    # ---------- artikli ----------
    def items(self, chemicals=None, active=True):
        sql = """SELECT i.*, s.name AS supplier_name,
                   COALESCE((SELECT SUM(qty_left) FROM v_lots v WHERE v.item_id=i.id AND v.qty_left>0
                             AND (v.eff_expiry IS NULL OR v.eff_expiry>=?)),0) AS stock,
                   COALESCE((SELECT SUM(qty_left) FROM v_lots v WHERE v.item_id=i.id AND v.qty_left>0
                             AND v.eff_expiry<?),0) AS expired,
                   (SELECT COUNT(*) FROM lots l WHERE l.item_id=i.id AND l.qty_left>0) AS lot_count
                 FROM items i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE 1=1"""
        args = [today(), today()]
        if active:
            sql += " AND i.active=1"
        if chemicals is not None:
            sql += " AND i.is_chemical=?"
            args.append(1 if chemicals else 0)
        return self.q(sql + " ORDER BY i.category, i.name", args)

    def item(self, id):
        return self.one("SELECT * FROM items WHERE id=?", (id,))

    def save_item(self, data, id=None):
        return self._upsert("items", data, id)

    def delete_item(self, id):
        used = self.val("SELECT COUNT(*) FROM lots WHERE item_id=?", (id,)) or \
            self.val("SELECT COUNT(*) FROM recipe_items WHERE item_id=?", (id,))
        if used:
            self.x("UPDATE items SET active=0 WHERE id=?", (id,))
            return "deaktiviran"
        self.x("DELETE FROM items WHERE id=?", (id,))
        return "obrisan"

    def stock(self, item_id):
        return self.val("""SELECT COALESCE(SUM(qty_left),0) FROM v_lots WHERE item_id=? AND qty_left>0
                           AND (eff_expiry IS NULL OR eff_expiry>=?)""", (item_id, today()))

    # ---------- LOT-ovi ----------
    def lots(self, active_only=True, item_id=None, chemicals=None):
        sql = "SELECT v.*, s.name AS supplier_name FROM v_lots v LEFT JOIN suppliers s ON s.id=v.supplier_id WHERE 1=1"
        args = []
        if active_only:
            sql += " AND v.qty_left>?"
            args.append(EPS)
        if item_id:
            sql += " AND v.item_id=?"
            args.append(item_id)
        if chemicals is not None:
            sql += " AND v.is_chemical=?"
            args.append(1 if chemicals else 0)
        return self.q(sql + " ORDER BY v.item_name, v.received_date, v.id", args)

    def lot(self, id):
        return self.one("SELECT * FROM v_lots WHERE id=?", (id,))

    def receive_lot(self, item_id, qty, lot_no=None, received=None, expiry=None, supplier_id=None,
                    unit_price=0, po_id=None, note=None, ref=None, commit=True):
        qty = r4(qty)
        if qty <= 0:
            raise ValueError("Količina mora biti veća od 0.")
        received = received or today()
        if not lot_no:
            n = (self.val("SELECT COUNT(*) FROM lots WHERE received_date=?", (received,)) or 0) + 1
            lot_no = f"INT-{received.replace('-', '')[2:]}-{n:02d}"
        if supplier_id is None:
            supplier_id = self.val("SELECT supplier_id FROM items WHERE id=?", (item_id,))
        cur = self.con.execute(
            """INSERT INTO lots(item_id,lot_no,qty_received,qty_left,received_date,expiry_date,
               supplier_id,unit_price,po_id,note) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (item_id, lot_no, qty, qty, received, expiry, supplier_id, unit_price or 0, po_id, note))
        lot_id = cur.lastrowid
        self.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                         (received + dt.datetime.now().strftime(" %H:%M"), item_id, lot_id, qty, "PRIMKA",
                          ref or lot_no, note))
        if commit:
            self.con.commit()
        return lot_id

    def open_lot(self, lot_id, date=None):
        self.x("UPDATE lots SET opened_date=? WHERE id=?", (date or today(), lot_id))

    def adjust_lot(self, lot_id, new_qty, note="", mtype="KOREKCIJA"):
        lot = self.lot(lot_id)
        new_qty = r4(new_qty)
        if new_qty < 0:
            raise ValueError("Količina ne može biti negativna.")
        diff = r4(new_qty - lot["qty_left"])
        if abs(diff) < EPS:
            return
        with self.con:
            self.con.execute("UPDATE lots SET qty_left=? WHERE id=?", (new_qty, lot_id))
            self.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                             (now(), lot["item_id"], lot_id, diff, mtype, lot["lot_no"], note))

    def allocate_fifo(self, item_id, qty, allow_expired=False):
        """Vraća (lista (lot_id, lot_no, količina), nedostaje). FIFO = najstariji primitak prvi."""
        sql = "SELECT * FROM v_lots WHERE item_id=? AND qty_left>?"
        args = [item_id, EPS]
        if not allow_expired:
            sql += " AND (eff_expiry IS NULL OR eff_expiry>=?)"
            args.append(today())
        rem = r4(qty)
        alloc = []
        for l in self.q(sql + " ORDER BY received_date, id", args):
            if rem <= EPS:
                break
            take = r4(min(rem, l["qty_left"]))
            alloc.append((l["id"], l["lot_no"], take))
            rem = r4(rem - take)
        return alloc, max(rem, 0)

    def _consume(self, alloc, item_id, mtype, ref, note=None, batch_id=None, brew_no=None):
        for lot_id, _lot_no, take in alloc:
            self.con.execute("UPDATE lots SET qty_left=ROUND(qty_left-?,4) WHERE id=?", (take, lot_id))
            self.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                             (now(), item_id, lot_id, -take, mtype, ref, note))
            if batch_id and brew_no is not None:
                self.con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty,brew_no) VALUES(?,?,?,?,?)",
                                 (batch_id, item_id, lot_id, take, brew_no))
            elif batch_id:
                self.con.execute("INSERT INTO batch_consumption(batch_id,item_id,lot_id,qty) VALUES(?,?,?,?)",
                                 (batch_id, item_id, lot_id, take))

    def issue_fifo(self, item_id, qty, mtype="IZDAVANJE", ref="", note=""):
        alloc, missing = self.allocate_fifo(item_id, qty)
        if missing > EPS:
            it = self.item(item_id)
            raise ShortageError([{"name": it["name"], "missing": missing, "unit": it["unit"]}])
        with self.con:
            self._consume(alloc, item_id, mtype, ref, note)
        return alloc

    def movements(self, item_id=None, limit=1000):
        sql = """SELECT m.*, i.name AS item_name, i.unit, l.lot_no FROM movements m
                 JOIN items i ON i.id=m.item_id LEFT JOIN lots l ON l.id=m.lot_id"""
        args = []
        if item_id:
            sql += " WHERE m.item_id=?"
            args.append(item_id)
        return self.q(sql + " ORDER BY m.ts DESC, m.id DESC LIMIT ?", args + [limit])

    def lot_trace(self, lot_id):
        """Sljedivost: u kojim je šaržama LOT korišten."""
        return self.q("""SELECT b.batch_no, b.brew_date, b.status, r.name AS recipe, c.qty
                         FROM batch_consumption c JOIN batches b ON b.id=c.batch_id
                         LEFT JOIN recipes r ON r.id=b.recipe_id WHERE c.lot_id=? ORDER BY b.brew_date""",
                      (lot_id,))

    # ---------- recepture ----------
    def recipes(self):
        return self.q("""SELECT r.*, (SELECT COUNT(*) FROM recipe_items ri WHERE ri.recipe_id=r.id) AS n_items,
                         (SELECT COUNT(*) FROM batches b WHERE b.recipe_id=r.id) AS n_batches
                         FROM recipes r WHERE r.active=1 ORDER BY r.name""")

    def recipe(self, id):
        return self.one("SELECT * FROM recipes WHERE id=?", (id,))

    def recipe_lines(self, recipe_id):
        """Retci recepture; qty = količina u OSNOVNOJ jedinici artikla (zaliha), qty_in/qty_unit = kako je upisano."""
        rows = self.q("""SELECT ri.*, i.name, i.unit, i.category, i.piece_qty, i.reorder_qty FROM recipe_items ri
                         JOIN items i ON i.id=ri.item_id WHERE ri.recipe_id=?
                         ORDER BY COALESCE(ri.stage,'brew')='ferm', i.category, i.name, COALESCE(ri.add_min,-1) DESC""", (recipe_id,))
        import web_units
        for r in rows:
            r["qty_in"] = r["qty"]
            u = r.get("qty_unit") or r["unit"]
            r["qty_unit"] = u
            f = web_units.factor(r, u)
            r["qty"] = r4(r["qty"] * (f if f is not None else 1))
        return rows

    def save_recipe(self, data, lines, id=None):
        data = dict(data)
        if data.get("brew_size_l"):  # fermentor = volumen kuhanja × broj kuhanja
            data["brews"] = max(1, int(data.get("brews") or 1))
            data["batch_size_l"] = round(float(data["brew_size_l"]) * data["brews"], 2)
        with self.con:
            if id:
                keys = list(data)
                self.con.execute(f"UPDATE recipes SET {','.join(k + '=?' for k in keys)} WHERE id=?",
                                 [data[k] for k in keys] + [id])
                self.con.execute("DELETE FROM recipe_items WHERE recipe_id=?", (id,))
            else:
                keys = list(data)
                id = self.con.execute(f"INSERT INTO recipes({','.join(keys)}) VALUES({','.join('?' * len(keys))})",
                                      [data[k] for k in keys]).lastrowid
            cols = {r["name"] for r in self.q("PRAGMA table_info(recipe_items)")}
            import web_units
            for ln in lines:
                if "stage" in cols:
                    am = ln.get("add_min")
                    u = ln.get("qty_unit") or None
                    it = self.one("SELECT * FROM items WHERE id=?", (ln["item_id"],)) or {}
                    if u and web_units._n(u) == web_units._n(it.get("unit")):
                        u = None
                    if u and web_units.factor(it, u) is None:
                        raise ValueError(f"{it.get('name')}: jedinica „{web_units.LABEL.get(web_units._n(u), u)}” ne može se preračunati u "
                                         f"{it.get('unit')} – u Sirovinama upišite koliko je 1 kom / 1 pakiranje.")
                    aa = ln.get("alpha_adj")
                    aa = None if aa in (None, "") or ln.get("stage") == "ferm" else (1 if aa else 0)
                    self.con.execute("INSERT INTO recipe_items(recipe_id,item_id,qty,stage,add_min,qty_unit,alpha_adj) VALUES(?,?,?,?,?,?,?)",
                                     (id, ln["item_id"], ln["qty"], "ferm" if ln.get("stage") == "ferm" else "brew",
                                      int(am) if am not in (None, "") else None, u, aa))
                else:
                    self.con.execute("INSERT INTO recipe_items(recipe_id,item_id,qty) VALUES(?,?,?)",
                                     (id, ln["item_id"], ln["qty"]))
        return id

    def delete_recipe(self, id):
        if self.val("SELECT COUNT(*) FROM batches WHERE recipe_id=?", (id,)):
            self.x("UPDATE recipes SET active=0 WHERE id=?", (id,))
        else:
            self.x("DELETE FROM recipes WHERE id=?", (id,))

    def scaled_needs(self, recipe_id, volume):
        """Ukupno potrebno za fermentor volumena `volume`: sastojci po kuhanju × (volumen / volumen kuhanja)
        + sastojci za fermentor × (volumen / volumen fermentora); zbroj po artiklu."""
        r = self.recipe(recipe_id)
        fs = r["batch_size_l"] or 1
        bs = r.get("brew_size_l") or fs
        vol = volume or fs
        out = {}
        for ln in self.recipe_lines(recipe_id):
            f = vol / (fs if ln.get("stage") == "ferm" else bs)
            need = r4(ln["qty"] * f)
            if ln["item_id"] in out:
                out[ln["item_id"]]["need"] = r4(out[ln["item_id"]]["need"] + need)
            else:
                out[ln["item_id"]] = dict(ln, need=need)
        return list(out.values())

    # ---------- šarže ----------
    def batches(self):
        return self.q("""SELECT b.*, r.name AS recipe, r.style,
                         (SELECT COUNT(*) FROM kegs k WHERE k.batch_id=b.id AND k.status IN ('Pun','Kod kupca')) AS kegs_out,
                         (SELECT SUM(p.total_l) FROM packaging p WHERE p.batch_id=b.id) AS packed_sum,
                         (SELECT COUNT(*) FROM batch_brews bb WHERE bb.batch_id=b.id AND bb.done=1) AS brews_done_n,
                         (SELECT COUNT(*) FROM batch_brews bb WHERE bb.batch_id=b.id) AS brews_rows
                         FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                         ORDER BY COALESCE(b.brew_date,'9999') DESC, b.id DESC""")

    def batch(self, id):
        return self.one("""SELECT b.*, r.name AS recipe,
                           (SELECT SUM(p.total_l) FROM packaging p WHERE p.batch_id=b.id) AS packed_sum
                           FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id WHERE b.id=?""", (id,))

    def recipe_code(self, recipe_id):
        r = self.recipe(recipe_id) if recipe_id else None
        if not r:
            return "XX"
        if r.get("code"):
            return r["code"].strip().upper()
        name = unicodedata.normalize("NFKD", r["name"]).encode("ascii", "ignore").decode().upper()
        words = [w for w in re.split(r"[^A-Z0-9]+", name) if w]
        if len(words) >= 2:
            return words[0][0] + words[1][0]
        return (words[0][:2] if words else "XX")

    def next_batch_no(self, date=None, recipe_id=None):
        date = date or today()
        if self.get_setting("batch_scheme") == "haccp":
            code = self.recipe_code(recipe_id)
            pat = re.compile(r"^\d{8}" + re.escape(code) + r"(\d+)$")
            n = max([int(m.group(1)) for b in self.q("SELECT batch_no FROM batches")
                     for m in [pat.match(b["batch_no"])] if m] or [0]) + 1
            y, mo, d = date.split("-")
            while True:
                no = f"{d}{mo}{y}{code}{n}"
                if not self.val("SELECT 1 FROM batches WHERE batch_no=?", (no,)):
                    return no
                n += 1
        yy = date[2:4]
        prefix = f"{self.get_setting('batch_prefix')}{yy}-"
        n = self.val("SELECT COUNT(*) FROM batches WHERE batch_no LIKE ?", (prefix + "%",)) or 0
        while True:
            n += 1
            no = f"{prefix}{n:03d}"
            if not self.val("SELECT 1 FROM batches WHERE batch_no=?", (no,)):
                return no

    def preview_brew(self, recipe_id, volume):
        out = []
        for ln in self.scaled_needs(recipe_id, volume):
            alloc, missing = self.allocate_fifo(ln["item_id"], ln["need"])
            out.append({"item_id": ln["item_id"], "name": ln["name"], "unit": ln["unit"], "need": ln["need"],
                        "available": self.stock(ln["item_id"]), "alloc": alloc, "missing": missing})
        return out

    def create_batch(self, recipe_id, volume, date=None, planned=False, batch_no=None, tank=None, note=None, brews=None):
        date = date or today()
        if not planned:
            prev = self.preview_brew(recipe_id, volume)
            short = [p for p in prev if p["missing"] > EPS]
            if short:
                raise ShortageError(short)
        batch_no = batch_no or self.next_batch_no(date, recipe_id)
        bid = self.x("""INSERT INTO batches(batch_no,recipe_id,brew_date,volume_l,status,tank,note)
                        VALUES(?,?,?,?,?,?,?)""", (batch_no, recipe_id, date, volume, "Planirano", tank, note))
        try:
            r = self.recipe(recipe_id) or {}
            self.x("UPDATE batches SET brews=? WHERE id=?", (brews or int(r.get("brews") or 1), bid))
        except sqlite3.OperationalError:
            pass
        if not planned:
            for _ in range(max(1, brews or int((self.recipe(recipe_id) or {}).get("brews") or 1))):
                self.brew_batch(bid, date)
        return bid

    def brew_batch(self, batch_id, date=None, brew_vol=None, last=None):
        """Jedno kuhanje (FIFO skidanje sirovina). Šarža = fermentor s n kuhanja: svako kuhanje skida sastojke
        „po kuhanju”; zadnje kuhanje (ili last=True) skida i sastojke za fermentor (kvasac, dry hop). Vraća broj kuhanja."""
        import web_brew
        b = self.batch(batch_id)
        bi = web_brew.batch_info(self, b)
        if b["status"] != "Planirano" and bi["done"] >= bi["n"]:
            raise ValueError("Šarža je već skuhana (sva kuhanja).")
        k = bi["done"] + 1
        vol_k = float(brew_vol or bi["brew_vol"] or b["volume_l"] or 0)
        is_last = (k >= bi["n"]) if last is None else bool(last)
        prev = [dict(p, stage="brew") for p in web_brew.stage_needs(self, b["recipe_id"], "brew", vol_k)]
        try:  # hmelj za gorčinu prema alfa kiselinama LOT-a
            import web_more
            for p in prev:
                p["alloc"], p["missing"] = self.allocate_fifo(p["item_id"], p["need"])
            prev = web_more.alpha_adjust_needs(self, batch_id, prev)
        except ImportError:
            pass
        if is_last:
            done_vol = sum((x.get("volume_l") or bi["brew_vol"]) for x in bi["brews"] if x.get("done")) + vol_k
            ferm_vol = b["volume_l"] if k >= bi["n"] else done_vol
            prev += [dict(p, stage="ferm") for p in web_brew.stage_needs(self, b["recipe_id"], "ferm", ferm_vol)]
        # nestašica: zbroj po artiklu (isti hmelj može biti i u kuhanju i za dry hop)
        tot = {}
        for p in prev:
            tot[p["item_id"]] = (p["name"], p["unit"], r4(tot.get(p["item_id"], (0, 0, 0))[2] + p["need"]))
        short = []
        for iid, (nm, un, q) in tot.items():
            _al, miss = self.allocate_fifo(iid, q)
            if miss > EPS:
                short.append({"item_id": iid, "name": nm, "unit": un, "need": q, "missing": miss})
        if short:
            raise ShortageError(short)
        date = date or b["brew_date"] or today()
        no = b["batch_no"]
        first = b["status"] == "Planirano"
        if first and self.get_setting("batch_scheme") == "haccp" and b["brew_date"] and date != b["brew_date"]:
            planned_prefix = "".join(reversed(b["brew_date"].split("-")))
            if no.startswith(planned_prefix):  # automatski LOT s planiranim datumom -> stvarni datum kuhanja
                no = self.next_batch_no(date, b["recipe_id"])
        with self.con:
            for p in prev:
                if p["need"] <= EPS:
                    continue
                alloc, _m = self.allocate_fifo(p["item_id"], p["need"])
                self._consume(alloc, p["item_id"], "KUHANJE", no, batch_id=batch_id,
                              brew_no=0 if p["stage"] == "ferm" else k)
            if first:
                self.con.execute("UPDATE batches SET status='Fermentacija', brew_date=?, batch_no=?, ferm_done=0 WHERE id=?",
                                 (date, no, batch_id))
            self.con.execute("""INSERT INTO batch_brews(batch_id,n,brew_date,volume_l,done) VALUES(?,?,?,?,1)
                                ON CONFLICT(batch_id,n) DO UPDATE SET brew_date=excluded.brew_date, volume_l=excluded.volume_l, done=1""",
                             (batch_id, k, date, vol_k))
            if is_last:
                upd = "UPDATE batches SET ferm_done=1, brews=?" + (", volume_l=?" if k < bi["n"] else "") + " WHERE id=?"
                self.con.execute(upd, (k, ferm_vol, batch_id) if k < bi["n"] else (k, batch_id))
        return k

    def undo_brew(self, batch_id):
        b = self.batch(batch_id)
        if self.val("SELECT COUNT(*) FROM kegs WHERE batch_id=?", (batch_id,)) or \
                self.val("SELECT COUNT(*) FROM keg_log WHERE batch_id=?", (batch_id,)):
            raise ValueError("Šarža je već punjena u kegove – storno nije moguć.")
        with self.con:
            for c in self.q("SELECT * FROM batch_consumption WHERE batch_id=?", (batch_id,)):
                self.con.execute("UPDATE lots SET qty_left=ROUND(qty_left+?,4) WHERE id=?", (c["qty"], c["lot_id"]))
                self.con.execute("INSERT INTO movements(ts,item_id,lot_id,qty,type,ref,note) VALUES(?,?,?,?,?,?,?)",
                                 (now(), c["item_id"], c["lot_id"], c["qty"], "STORNO", b["batch_no"],
                                  "Storno kuhanja"))
            self.con.execute("DELETE FROM batch_consumption WHERE batch_id=?", (batch_id,))
            self.con.execute("UPDATE batches SET status='Planirano' WHERE id=?", (batch_id,))
            try:
                self.con.execute("DELETE FROM batch_brews WHERE batch_id=?", (batch_id,))
                self.con.execute("UPDATE batches SET ferm_done=0 WHERE id=?", (batch_id,))
            except sqlite3.OperationalError:
                pass

    def delete_batch(self, batch_id):
        b = self.batch(batch_id)
        if b["status"] != "Planirano":
            raise ValueError("Može se obrisati samo planirana šarža (napravite najprije storno kuhanja).")
        self.x("DELETE FROM batches WHERE id=?", (batch_id,))

    def update_batch(self, batch_id, data):
        data = dict(data)
        old = self.one("SELECT batch_no FROM batches WHERE id=?", (batch_id,)) or {}
        new_no = (data.get("batch_no") or "").strip() if "batch_no" in data else None
        if new_no is not None:
            if not new_no:
                raise ValueError("LOT piva ne može biti prazan.")
            if self.val("SELECT 1 FROM batches WHERE batch_no=? AND id<>?", (new_no, batch_id)):
                raise ValueError(f"LOT piva {new_no} već postoji.")
            data["batch_no"] = new_no
        self._upsert("batches", data, batch_id)
        if new_no and old.get("batch_no") and new_no != old["batch_no"]:
            # promjena LOT-a: isti LOT u evidenciji pakiranja, CCP kontroli i trošarinama
            for t in ("packaging", "ccp_boil"):
                self.x(f"UPDATE {t} SET lot=? WHERE batch_id=?", (new_no, batch_id))
            try:
                self.x("UPDATE cips SET batch_no=? WHERE batch_id=?", (new_no, batch_id))
            except Exception:  # noqa: BLE001
                pass

    def batch_consumption(self, batch_id):
        return self.q("""SELECT c.*, i.name, i.unit, l.lot_no, l.expiry_date, s.name AS supplier_name
                         FROM batch_consumption c JOIN items i ON i.id=c.item_id JOIN lots l ON l.id=c.lot_id
                         LEFT JOIN suppliers s ON s.id=l.supplier_id WHERE c.batch_id=? ORDER BY i.name""",
                      (batch_id,))

    # ---------- narudžbenice ----------
    def pos(self):
        return self.q("""SELECT p.*, s.name AS supplier_name,
                         (SELECT COALESCE(SUM(qty*unit_price),0) FROM po_lines WHERE po_id=p.id) AS total,
                         (SELECT COUNT(*) FROM po_lines WHERE po_id=p.id) AS n_lines
                         FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id
                         ORDER BY p.order_date DESC, p.id DESC""")

    def po(self, id):
        return self.one("""SELECT p.*, s.name AS supplier_name, s.address, s.oib, s.email, s.phone, s.contact
                           FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?""", (id,))

    def po_lines(self, po_id):
        return self.q("""SELECT pl.*, i.name, i.unit, i.code FROM po_lines pl JOIN items i ON i.id=pl.item_id
                         WHERE pl.po_id=? ORDER BY pl.id""", (po_id,))

    def next_po_no(self):
        prefix = f"{self.get_setting('po_prefix')}-{today()[:4]}-"
        n = self.val("SELECT COUNT(*) FROM purchase_orders WHERE po_no LIKE ?", (prefix + "%",)) or 0
        while True:
            n += 1
            no = f"{prefix}{n:03d}"
            if not self.val("SELECT 1 FROM purchase_orders WHERE po_no=?", (no,)):
                return no

    def save_po(self, data, lines, id=None):
        with self.con:
            keys = list(data)
            if id:
                self.con.execute(f"UPDATE purchase_orders SET {','.join(k + '=?' for k in keys)} WHERE id=?",
                                 [data[k] for k in keys] + [id])
                self.con.execute("DELETE FROM po_lines WHERE po_id=?", (id,))
            else:
                data = dict(data)
                data.setdefault("po_no", self.next_po_no())
                data.setdefault("order_date", today())
                keys = list(data)
                id = self.con.execute(
                    f"INSERT INTO purchase_orders({','.join(keys)}) VALUES({','.join('?' * len(keys))})",
                    [data[k] for k in keys]).lastrowid
            for ln in lines:
                self.con.execute("INSERT INTO po_lines(po_id,item_id,qty,qty_received,unit_price) VALUES(?,?,?,?,?)",
                                 (id, ln["item_id"], ln["qty"], ln.get("qty_received", 0), ln.get("unit_price", 0)))
        return id

    def set_po_status(self, id, status):
        self.x("UPDATE purchase_orders SET status=? WHERE id=?", (status, id))

    def receive_po(self, po_id, receipts, date=None):
        """receipts: lista dict(line_id, qty, lot_no, expiry)."""
        p = self.po(po_id)
        lot_ids = []
        with self.con:
            for rc in receipts:
                if rc["qty"] <= EPS:
                    continue
                ln = self.one("SELECT * FROM po_lines WHERE id=?", (rc["line_id"],))
                lot_ids.append(self.receive_lot(ln["item_id"], rc["qty"], rc.get("lot_no"), date, rc.get("expiry"),
                                 p["supplier_id"], ln["unit_price"], po_id, ref=p["po_no"], commit=False))
                self.con.execute("UPDATE po_lines SET qty_received=ROUND(qty_received+?,4) WHERE id=?",
                                 (rc["qty"], ln["id"]))
            left = self.val("SELECT COUNT(*) FROM po_lines WHERE po_id=? AND qty_received < qty - ?", (po_id, EPS))
            self.con.execute("UPDATE purchase_orders SET status=? WHERE id=?",
                             ("Djelomično" if left else "Zaprimljeno", po_id))
        return lot_ids

    def delete_po(self, id):
        if self.val("SELECT COUNT(*) FROM po_lines WHERE po_id=? AND qty_received>0", (id,)):
            raise ValueError("Narudžbenica je (djelomično) zaprimljena – može se samo otkazati.")
        self.x("DELETE FROM purchase_orders WHERE id=?", (id,))

    # ---------- izvještaj: što naručiti ----------
    def reorder_report(self, only_needed=True):
        on_order = {r["item_id"]: r["q"] for r in self.q(
            f"""SELECT pl.item_id, SUM(pl.qty-pl.qty_received) AS q FROM po_lines pl
                JOIN purchase_orders p ON p.id=pl.po_id WHERE p.status IN ({','.join('?' * len(PO_OPEN))})
                GROUP BY pl.item_id""", PO_OPEN)}
        planned = {}
        import web_brew
        for b in self.q("SELECT * FROM batches WHERE status='Planirano' OR (status='Fermentacija' AND COALESCE(ferm_done,1)=0)"):
            if not b.get("recipe_id"):
                continue
            for iid, q in web_brew.remaining_needs(self, b).items():  # planirane + preostala kuhanja u tijeku
                planned[iid] = planned.get(iid, 0) + q
        out = []
        for it in self.items():
            stock = it["stock"]
            oo = r4(on_order.get(it["id"], 0))
            pn = r4(planned.get(it["id"], 0))
            projected = r4(stock + oo - pn)
            need = r4(it["min_stock"] - projected)
            suggest = 0.0
            if need > EPS or (pn > 0 and projected < 0):
                need = max(need, -projected)
                rq = it["reorder_qty"] or 0
                suggest = r4(math.ceil(need / rq - 1e-9) * rq) if rq > 0 else r4(need)
            if only_needed and suggest <= EPS:
                continue
            out.append({"item_id": it["id"], "code": it["code"], "name": it["name"], "unit": it["unit"],
                        "category": it["category"], "supplier_id": it["supplier_id"],
                        "supplier_name": it["supplier_name"], "stock": stock, "expired": it["expired"],
                        "on_order": oo, "planned": pn, "min_stock": it["min_stock"], "projected": projected,
                        "suggest": suggest, "price": it["price"] or 0})
        return out

    def create_pos_from_report(self, rows):
        by_sup = {}
        for r in rows:
            if r["suggest"] > EPS and r["supplier_id"]:
                by_sup.setdefault(r["supplier_id"], []).append(r)
        ids = []
        for sid, rs in by_sup.items():
            lead = self.val("SELECT lead_days FROM suppliers WHERE id=?", (sid,)) or 7
            exp = (dt.date.today() + dt.timedelta(days=int(lead))).isoformat()
            ids.append(self.save_po({"supplier_id": sid, "expected_date": exp, "status": "Nacrt",
                                     "note": "Automatski iz izvještaja 'Što trebam naručiti'"},
                                    [{"item_id": r["item_id"], "qty": r["suggest"], "unit_price": r["price"]}
                                     for r in rs]))
        return ids

    # ---------- kegovi ----------
    def kegs(self):
        return self.q("""SELECT k.*, b.batch_no, r.name AS beer FROM kegs k
                         LEFT JOIN batches b ON b.id=k.batch_id LEFT JOIN recipes r ON r.id=b.recipe_id
                         ORDER BY k.code""")

    def save_keg(self, data, id=None):
        if not id:
            data = dict(data)
            data.setdefault("status", "Čist")
            data.setdefault("status_date", today())
        kid = self._upsert("kegs", data, id)
        if not id:
            self.x("INSERT INTO keg_log(keg_id,ts,action,status,note) VALUES(?,?,?,?,?)",
                   (kid, now(), "Unos", data["status"], "Novi keg"))
        return kid

    # osnovna veličina kega i količina piva u punom kegu (Postavke; 18 L keg, 17 L piva)
    def keg_size_default(self):
        try:
            return float(str(self.get_setting("keg_size_l") or 18).replace(",", "."))
        except ValueError:
            return 18.0

    def keg_fill_default(self):
        try:
            return float(str(self.get_setting("keg_fill_l") or 17).replace(",", "."))
        except ValueError:
            return 17.0

    def keg_default_fill(self, k):
        """Koliko piva ide u keg kod punjenja ako se ne upiše ručno (17 L, ali ne više od volumena kega)."""
        full = self.keg_fill_default()
        size = k.get("size_l") if isinstance(k, dict) else None
        return min(full, size) if size else full

    def keg_ship_error(self, k):
        """Razlog zašto se keg ne smije izdati kupcu (None = smije). Izdaju se samo puni kegovi s 17 L piva."""
        if k["status"] != "Pun":
            return f"Keg {k['code']} nije pun (status '{k['status']}')."
        full = self.keg_fill_default()
        fill = k.get("fill_l")
        if fill is not None and fill + 1e-9 < full:
            return (f"Keg {k['code']} ima samo {hr(round(fill, 2))} L piva – kupcu se smiju izdati samo kegovi "
                    f"s {hr(full)} L. Takav keg istočite u pivnici ili ga nadopunite.")
        return None

    def keg_action(self, keg_id, action, batch_id=None, customer=None, date=None, note=None, force=False, fill_l=None):
        k = self.one("SELECT * FROM kegs WHERE id=?", (keg_id,))
        allowed, new = KEG_ACTIONS[action]
        if k["status"] not in allowed and not force:
            raise ValueError(f"Keg {k['code']} je u statusu '{k['status']}' – akcija '{action}' nije dopuštena.")
        date = date or today()
        upd = {"status": new, "status_date": date}
        if action == "Napuni":
            if not batch_id:
                raise ValueError("Odaberite šaržu.")
            fill = self.keg_default_fill(k) if fill_l in (None, "") else float(fill_l)
            if fill <= 0:
                raise ValueError(f"Keg {k['code']}: upišite količinu piva veću od 0 L.")
            if k.get("size_l") and fill > k["size_l"] + 1e-9:
                raise ValueError(f"Keg {k['code']}: {hr(fill)} L je više od volumena kega ({hr(k['size_l'])} L).")
            upd.update(batch_id=batch_id, filled_date=date, customer=None, fill_l=round(fill, 2))
            note = f"{hr(round(fill, 2))} L" + (f" · {note}" if note else "")
        elif action == "Isporuči":
            err = self.keg_ship_error({**k, "status": "Pun"} if force else k)
            if err:  # manje od 17 L piva: ne izdaje se ni uz potvrdu
                raise ValueError(err)
            upd["customer"] = customer
        elif action in ("Vrati", "Istočeno (pivnica)"):
            # prazan keg: bez kupca, šarže i piva (sve ostaje zapisano u povijesti kega – sljedivost)
            upd.update(fill_l=None, customer=None, batch_id=None, filled_date=None)
        elif action in ("Očisti", "Otpiši", "Na servis"):
            upd.update(batch_id=None, customer=None, filled_date=None, fill_l=None)
        with self.con:
            keys = list(upd)
            self.con.execute(f"UPDATE kegs SET {','.join(k_ + '=?' for k_ in keys)} WHERE id=?",
                             [upd[k_] for k_ in keys] + [keg_id])
            self.con.execute("INSERT INTO keg_log(keg_id,ts,action,status,batch_id,customer,note) VALUES(?,?,?,?,?,?,?)",
                             (keg_id, date + dt.datetime.now().strftime(" %H:%M"), action, new,
                              batch_id or k["batch_id"], customer or k["customer"], note))

    def keg_log(self, keg_id):
        return self.q("""SELECT g.*, b.batch_no FROM keg_log g LEFT JOIN batches b ON b.id=g.batch_id
                         WHERE g.keg_id=? ORDER BY g.ts DESC, g.id DESC""", (keg_id,))

    def keg_summary(self):
        d = {s: 0 for s in KEG_STATUS}
        for r in self.q("SELECT status, COUNT(*) AS n FROM kegs GROUP BY status"):
            d[r["status"]] = r["n"]
        return d

    def customers(self):
        return [r["customer"] for r in self.q(
            "SELECT DISTINCT customer FROM keg_log WHERE customer IS NOT NULL AND customer<>'' ORDER BY customer")]

    # ---------- nadzorna ploča ----------
    def dashboard(self):
        t, w = today(), self.warn_date()
        items = self.items()
        low = [i for i in items if i["min_stock"] and i["stock"] < i["min_stock"]]
        lots = self.lots()
        expired = [l for l in lots if l["eff_expiry"] and l["eff_expiry"] < t]
        expiring = [l for l in lots if l["eff_expiry"] and t <= l["eff_expiry"] <= w]
        batches = self.batches()
        alerts = []

        def add(key, typ, sev, text, rec, desc, date=None, **ref):
            alerts.append({"key": key, "type": typ, "sev": sev, "text": text, "rec": rec, "desc": desc,
                           "date": date, "ref": ref})

        for l in expired:
            add(f"exp:{l['id']}", "Istekao rok", "bad", f"{l['item_name']} · LOT {l['lot_no']} · {hr(l['qty_left'])} {l['unit']}",
                l["lot_no"], f"{l['item_name']} · na zalihi {hr(l['qty_left'])} {l['unit']}", l["eff_expiry"],
                lot_id=l["id"])
        for l in expiring:
            add(f"soon:{l['id']}", "Rok ističe", "warn", f"{l['item_name']} · LOT {l['lot_no']} · {hr(l['qty_left'])} {l['unit']}",
                l["lot_no"], f"{l['item_name']} · na zalihi {hr(l['qty_left'])} {l['unit']}", l["eff_expiry"],
                lot_id=l["id"])
        for i in low:
            add(f"low:{i['id']}", "Ispod minimuma", "warn",
                f"{i['name']} · zaliha {hr(i['stock'])} / min {hr(i['min_stock'])} {i['unit']}", i["name"],
                f"zaliha {hr(i['stock'])} {i['unit']} · minimum {hr(i['min_stock'])} {i['unit']}", None, item_id=i["id"])
        for p in self.q("""SELECT p.*, s.name AS supplier_name FROM purchase_orders p
                           LEFT JOIN suppliers s ON s.id=p.supplier_id
                           WHERE p.status IN ('Poslano','Djelomično') AND p.expected_date < ?""", (t,)):
            add(f"late:{p['id']}", "Kasni isporuka", "warn", f"{p['po_no']} · {p['supplier_name']}", p["po_no"],
                f"{p['supplier_name']} · očekivano {p['expected_date'][8:10]}.{p['expected_date'][5:7]}.", p["expected_date"],
                po_id=p["id"])
        rem = self.excise_reminder()
        if rem:
            add(f"excise:{rem[0]}", "Trošarine MI-PI", "bad", rem[1], rem[0], rem[1], None, period=rem[0])
        return {
            "low": len(low), "expired": len(expired), "expiring": len(expiring),
            "active_batches": sum(1 for b in batches if b["status"] in ("Fermentacija", "Odležavanje")),
            "planned": sum(1 for b in batches if b["status"] == "Planirano"),
            "open_pos": self.val(f"SELECT COUNT(*) FROM purchase_orders WHERE status IN ({','.join('?' * len(PO_OPEN))})", PO_OPEN),
            "kegs": self.keg_summary(),
            "stock_value": self.val("SELECT COALESCE(SUM(qty_left*unit_price),0) FROM lots WHERE qty_left>0"),
            "alerts": alerts,
            "recent_batches": batches[:8],
        }

    # ---------- demo podaci ----------
    def seed_demo(self):
        d = lambda days: (dt.date.today() + dt.timedelta(days=days)).isoformat()
        S = {}
        for name, lead, contact, email in [
            ("Slad Trade d.o.o.", 5, "Marko Horvat", "narudzbe@sladtrade.hr"),
            ("Hmeljar j.d.o.o.", 7, "Ana Kovač", "info@hmeljar.hr"),
            ("Kvasac Lab", 4, "Ivana Babić", "prodaja@kvasaclab.hr"),
            ("ProClean Kemija d.o.o.", 3, "Tomislav Novak", "orders@proclean.hr"),
            ("Ambalaža Plus", 10, "Petra Jurić", "prodaja@ambalazaplus.hr"),
        ]:
            S[name] = self.save_supplier({"name": name, "lead_days": lead, "contact": contact, "email": email,
                                          "phone": "+385 1 234 5678", "address": "Zagreb"})
        I = {}
        items = [
            ("SL-PIL", "Pilsner slad", "Slad", "kg", 300, 250, "Slad Trade d.o.o.", 0.95, 0),
            ("SL-PAL", "Pale Ale slad", "Slad", "kg", 200, 250, "Slad Trade d.o.o.", 1.05, 0),
            ("SL-MUN", "Munich slad", "Slad", "kg", 50, 25, "Slad Trade d.o.o.", 1.15, 0),
            ("SL-CRY", "Caramel 60 slad", "Slad", "kg", 25, 25, "Slad Trade d.o.o.", 1.40, 0),
            ("HM-SAA", "Hmelj Saaz (pelete)", "Hmelj", "kg", 3, 5, "Hmeljar j.d.o.o.", 24.0, 0),
            ("HM-CAS", "Hmelj Cascade (pelete)", "Hmelj", "kg", 3, 5, "Hmeljar j.d.o.o.", 22.0, 0),
            ("HM-CIT", "Hmelj Citra (pelete)", "Hmelj", "kg", 2, 5, "Hmeljar j.d.o.o.", 38.0, 0),
            ("KV-W34", "Kvasac W-34/70", "Kvasac", "pak", 4, 10, "Kvasac Lab", 9.5, 0),
            ("KV-US5", "Kvasac US-05", "Kvasac", "pak", 4, 10, "Kvasac Lab", 7.8, 0),
            ("AM-CEP", "Krunski čepovi 26 mm", "Ambalaža", "kom", 2000, 5000, "Ambalaža Plus", 0.02, 0),
        ]
        for code, name, cat, unit, mn, rq, sup, price, ch in items:
            I[code] = self.save_item({"code": code, "name": name, "category": cat, "unit": unit, "min_stock": mn,
                                      "reorder_qty": rq, "supplier_id": S[sup], "price": price, "is_chemical": ch})
        chems = [
            ("KE-PAA", "Peroctena kiselina 15% (dezinfekcija)", "L", 10, 20, 6.5, "H242, H302, H314, H335", 90),
            ("KE-NAOH", "Natrijeva lužina 30% (CIP)", "L", 20, 25, 2.8, "H290, H314", 0),
            ("KE-KIS", "Kiselinsko sredstvo (fosforna/dušična)", "L", 10, 20, 4.2, "H290, H314", 0),
        ]
        for code, name, unit, mn, rq, price, hz, sh in chems:
            I[code] = self.save_item({"code": code, "name": name, "category": "Kemikalija", "unit": unit,
                                      "min_stock": mn, "reorder_qty": rq, "supplier_id": S["ProClean Kemija d.o.o."],
                                      "price": price, "is_chemical": 1, "hazard": hz, "shelf_after_open_days": sh,
                                      "storage": "Hladno, suho, odvojeno od kiselina/lužina; KZO obavezna"})
        lots = [
            ("SL-PIL", "WM2406-118", 500, -60, 300), ("SL-PIL", "WM2409-033", 500, -20, 340),
            ("SL-PAL", "WM2407-201", 400, -40, 320), ("SL-MUN", "WM2405-090", 50, -70, 260),
            ("SL-CRY", "WM2405-121", 25, -70, 260), ("HM-SAA", "SAA-24-071", 5, -90, 500),
            ("HM-CAS", "CAS-24-112", 5, -50, 520), ("HM-CIT", "CIT-24-018", 3, -30, 540),
            ("KV-W34", "FW34-4401", 10, -25, 200), ("KV-US5", "FUS5-4419", 6, -15, 25),
            ("AM-CEP", "CEP-2405", 10000, -80, None),
            ("KE-PAA", "PAA-2403-11", 20, -120, 12), ("KE-PAA", "PAA-2409-02", 20, -10, 300),
            ("KE-NAOH", "NAOH-2404", 25, -100, 600), ("KE-KIS", "KIS-2312", 10, -200, -5),
        ]
        for code, lot, q, rec, exp in lots:
            self.receive_lot(I[code], q, lot, d(rec), d(exp) if exp is not None else None,
                             unit_price=self.item(I[code])["price"])
        self.open_lot(self.val("SELECT id FROM lots WHERE lot_no='PAA-2403-11'"), d(-75))
        r1 = self.save_recipe({"name": "Pilsner", "code": "PI", "style": "Češki pils", "batch_size_l": 290},
                              [{"item_id": I["SL-PIL"], "qty": 56}, {"item_id": I["SL-MUN"], "qty": 3},
                               {"item_id": I["HM-SAA"], "qty": 1.24}, {"item_id": I["KV-W34"], "qty": 2}])
        r2 = self.save_recipe({"name": "American Pale Ale", "code": "PA", "style": "APA", "batch_size_l": 290},
                              [{"item_id": I["SL-PAL"], "qty": 54}, {"item_id": I["SL-CRY"], "qty": 1.5},
                               {"item_id": I["HM-CAS"], "qty": 0.6}, {"item_id": I["HM-CIT"], "qty": 0.5},
                               {"item_id": I["KV-US5"], "qty": 1}])
        self.create_batch(r1, 290, d(-35), note="Demo šarža")
        b2 = self.create_batch(r2, 290, d(-14))
        self.create_batch(r1, 290, d(5), planned=True, note="Planirana šarža")
        b1 = self.val("SELECT id FROM batches ORDER BY id LIMIT 1")
        self.update_batch(b1, {"status": "Pakirano"})
        for n in range(1, 13):
            self.save_keg({"code": f"K30-{n:03d}", "size_l": 30, "keg_type": "Euro KeyKeg"})
        for n in range(1, 9):
            self.save_keg({"code": f"K20-{n:03d}", "size_l": 20, "keg_type": "Euro KeyKeg"})
        kegs = self.q("SELECT id FROM kegs ORDER BY id")
        for k in kegs[:8]:
            self.keg_action(k["id"], "Napuni", batch_id=b1, date=d(-3))
        for k in kegs[:5]:
            self.keg_action(k["id"], "Isporuči", customer=["Pub Lavica", "Bistro Kantun", "Pub Lavica",
                                                             "Hotel Adria", "Bistro Kantun"][k["id"] % 5], date=d(-2))
        self.keg_action(kegs[0]["id"], "Vrati", date=d(-1))
        self.keg_action(kegs[19]["id"], "Na servis", note="Curi ventil")
        self.save_po({"supplier_id": S["Hmeljar j.d.o.o."], "expected_date": d(3), "status": "Poslano",
                      "note": "Demo narudžba"},
                     [{"item_id": I["HM-SAA"], "qty": 5, "unit_price": 24.0}])
        self.seed_haccp_demo()
        self.seed_extras_demo()
