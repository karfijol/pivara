"""Dodaci (verzija 2.1): planer fermentora, trošak šarže, kupci i otpremnice, trošarine,
sljedivost/povlačenje, mjerenja fermentacije i senzorika."""
import datetime as dt

EXTRAS_SCHEMA = """
CREATE TABLE IF NOT EXISTS customers(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, oib TEXT, address TEXT, contact TEXT, phone TEXT, email TEXT,
    note TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS delivery_notes(
    id INTEGER PRIMARY KEY, no TEXT NOT NULL UNIQUE, date TEXT, customer_id INTEGER REFERENCES customers(id),
    customer TEXT, note TEXT, deposit_per_keg REAL DEFAULT 0, operator TEXT);

CREATE TABLE IF NOT EXISTS delivery_lines(
    id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL, lot TEXT, beer TEXT, pack_type TEXT,
    qty INTEGER, unit_l REAL, keg_codes TEXT);

CREATE TABLE IF NOT EXISTS ferm_readings(
    id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    date TEXT NOT NULL, time TEXT, sg REAL, temp REAL, ph REAL, note TEXT, by TEXT);

CREATE TABLE IF NOT EXISTS dismissed(
    key TEXT PRIMARY KEY, type TEXT, label TEXT, date TEXT);
"""

EXTRA_SETTINGS = {"excise_rate": "5.31", "excise_reduced": "2.65", "small_brewery": "1", "extra_cost_l": "0",
                  "keg_deposit": "0", "dn_prefix": "OTP", "company_oib": "",
                  "company_address": "", "customs_office": "", "excise_no": "",
                  # naljepnice za kegove (2.4)
                  "label_brand": "PIVOVARA", "label_producer": "Moja pivovara d.o.o.",
                  "label_address": "Ulica 1, Mjesto, Hrvatska", "label_allergens": "JEČAM (GLUTEN)",
                  "label_storage": "Čuvati na suhom i hladnom mjestu.", "label_food_name": "Pivo",
                  "label_show_style": "1", "label_qr": "1",
                  # 2.5: sastojci i piktogrami
                  "label_show_ingredients": "1", "label_pictograms": "1",
                  # 2.6: isporučitelj na otpremnici
                  "dn_company": "Moja pivovara d.o.o.", "dn_address": "Ulica 1, Mjesto", "dn_contact": "",
                  "dn_iban": ""}

# alkohol prema službenoj analizi (prijava carini), 2.5 – ključne riječi u nazivu recepture
OFFICIAL_ABV = [(("lager", "pils"), 6.04), (("ipa",), 5.59), (("pale ale",), 5.74), (("stout",), 4.24),
                (("sour",), 4.02)]

# boje zastavica za kegove (2.9)
LABEL_COLORS = {"Žuta": "#F6D23C", "Tirkizna": "#2EC4B6", "Narančasta": "#F28C28", "Smeđa": "#6B3E26",
                "Crvena": "#C8102E", "Zelena": "#3DA35D", "Plava": "#2F6FD0", "Ljubičasta": "#7B4FA0",
                "Ružičasta": "#E86FA8", "Siva": "#8A8F98", "Crna": "#222222"}
LABEL_COLOR_RULES = [(("pils", "lager"), "Žuta"), (("ipa",), "Tirkizna"), (("pale ale", "apa"), "Narančasta"),
                     (("stout", "porter"), "Smeđa"), (("sour",), "Crvena")]

# sastojci za naljepnicu iz stavki recepture
INGR_RULES = [  # (ključne riječi u nazivu artikla, naziv na naljepnici, alergen)
    (("wheat", "pšen", "weizen"), "PŠENIČNI SLAD", "PŠENICA"),
    (("flaked barley", "ječmene pahuljice"), "JEČMENE PAHULJICE", "JEČAM"),
    (("roasted barley", "prženi ječam"), "prženi JEČAM", "JEČAM"),
    (("flaked oat", "oat", "zob"), "ZOBENE PAHULJICE", "ZOB"),
    (("rye", "raž"), "RAŽENI SLAD", "RAŽ"),
    (("spelt", "pir "), "PIROV SLAD", "PIR"),
]
SKIP_INGR = ("protaloc", "whirlfloc", "irish moss", "tablet", "clarity", "kalcij", "calcium", "gips", "gypsum",
             "kiselina", "acid", "sol ", "salt")


class ExtrasMixin:
    def _migrate_extras(self):
        self.con.executescript(EXTRAS_SCHEMA)
        cols = {r["name"] for r in self.q("PRAGMA table_info(batches)")}
        for c, t in [("sensory_score", "REAL"), ("sensory_note", "TEXT"), ("sensory_by", "TEXT"), ("sensory_date", "TEXT")]:
            if c not in cols:
                self.con.execute(f"ALTER TABLE batches ADD COLUMN {c} {t}")
        cols = {r["name"] for r in self.q("PRAGMA table_info(recipes)")}
        if "ferm_days" not in cols:
            self.con.execute("ALTER TABLE recipes ADD COLUMN ferm_days INTEGER DEFAULT 14")
        if "allergens" not in cols:
            self.con.execute("ALTER TABLE recipes ADD COLUMN allergens TEXT")
        if "label_ingredients" not in cols:
            self.con.execute("ALTER TABLE recipes ADD COLUMN label_ingredients TEXT")
        if "official_abv" not in cols:
            self.con.execute("ALTER TABLE recipes ADD COLUMN official_abv REAL")
            self.apply_official_abv(commit=False)
        if "label_color" not in cols:
            self.con.execute("ALTER TABLE recipes ADD COLUMN label_color TEXT")
        for k, v in EXTRA_SETTINGS.items():
            self.con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
        self.con.commit()

    # ---------------------------------------------------------------- trošak šarže
    def batch_cost(self, batch_id):
        """(trošak sirovina €, ukupno €, €/L) – sirovine po nabavnoj cijeni LOT-a + ostali troškovi po litri."""
        raw = self.val("""SELECT COALESCE(SUM(c.qty * COALESCE(NULLIF(l.unit_price,0), i.price, 0)),0)
                          FROM batch_consumption c JOIN lots l ON l.id=c.lot_id JOIN items i ON i.id=c.item_id
                          WHERE c.batch_id=?""", (batch_id,)) or 0
        b = self.batch(batch_id)
        litres = b.get("wort_l") or b.get("volume_l") or 0
        extra = float(self.get_setting("extra_cost_l") or 0) * litres
        total = raw + extra
        return raw, total, (total / litres if litres else 0)

    # ---------------------------------------------------------------- planer fermentora
    def planner(self, d_from, d_to):
        """Trake po fermentorima: (fermentor, šarža, početak, kraj, procijenjeno?, planirano?)."""
        out = []
        for b in self.q("""SELECT b.*, r.name AS recipe, COALESCE(r.ferm_days,14) AS fdays FROM batches b
                           LEFT JOIN recipes r ON r.id=b.recipe_id WHERE b.tank IS NOT NULL AND b.tank<>''"""):
            start = b.get("ferm_start") or b["brew_date"]
            if not start:
                continue
            est = not b.get("ferm_end")
            end = b.get("ferm_end") or (dt.date.fromisoformat(start) + dt.timedelta(days=int(b["fdays"] or 14))).isoformat()
            if end < d_from or start > d_to:
                continue
            out.append({"tank": b["tank"], "batch_id": b["id"], "batch_no": b["batch_no"], "recipe": b["recipe"],
                        "start": start, "end": end, "estimated": est, "planned": b["status"] == "Planirano",
                        "status": b["status"]})
        out.sort(key=lambda x: (x["tank"], x["start"]))
        conflicts = []
        for i, a in enumerate(out):
            for c in out[i + 1:]:
                if c["tank"] == a["tank"] and c["start"] < a["end"]:
                    conflicts.append((a, c))
        return out, conflicts

    def free_from(self, tank):
        """Datum od kojeg je fermentor slobodan (kraj zadnje šarže, stvarni ili procijenjeni)."""
        bars, _ = self.planner("0000-01-01", "9999-12-31")
        ends = [b["end"] for b in bars if b["tank"] == tank]
        return max(ends) if ends else None

    # ---------------------------------------------------------------- kupci i otpremnice
    def customers_list(self):
        rows = self.q("SELECT * FROM customers WHERE active=1 ORDER BY name")
        held = {r["customer"]: r["n"] for r in self.q(
            "SELECT customer, COUNT(*) AS n FROM kegs WHERE status='Kod kupca' GROUP BY customer")}
        for r in rows:
            r["kegs_held"] = held.get(r["name"], 0)
        return rows

    def customer_names(self):
        names = [c["name"] for c in self.q("SELECT name FROM customers WHERE active=1 ORDER BY name")]
        for n in self.customers():
            if n not in names:
                names.append(n)
        return names

    def save_customer(self, data, id=None):
        return self._upsert("customers", data, id)

    def next_dn_no(self):
        prefix = f"{self.get_setting('dn_prefix') or 'OTP'}-{dt.date.today().year}-"
        n = self.val("SELECT COUNT(*) FROM delivery_notes WHERE no LIKE ?", (prefix + "%",)) or 0
        while True:
            n += 1
            no = f"{prefix}{n:03d}"
            if not self.val("SELECT 1 FROM delivery_notes WHERE no=?", (no,)):
                return no

    def delivery_notes(self):
        return self.q("""SELECT d.*, (SELECT COALESCE(SUM(qty),0) FROM delivery_lines WHERE note_id=d.id) AS units,
                         (SELECT COALESCE(SUM(qty*unit_l),0) FROM delivery_lines WHERE note_id=d.id) AS litres,
                         (SELECT COALESCE(SUM(qty),0) FROM delivery_lines WHERE note_id=d.id AND pack_type='Keg') AS kegs
                         FROM delivery_notes d ORDER BY d.date DESC, d.id DESC""")

    def delivery_lines(self, note_id):
        return self.q("SELECT * FROM delivery_lines WHERE note_id=? ORDER BY id", (note_id,))

    def create_delivery(self, customer_id, date, keg_ids, other_lines, note=None, operator=None):
        """Otpremnica: odabrani puni kegovi (automatski 'Isporuči' kupcu) + ostale stavke (boce, limenke)."""
        from haccp_db import compress_codes
        cust = self.one("SELECT * FROM customers WHERE id=?", (customer_id,))
        if not keg_ids and not other_lines:
            raise ValueError("Otpremnica nema stavki.")
        no = self.next_dn_no()
        dep = float(self.get_setting("keg_deposit") or 0)
        nid = self.x("""INSERT INTO delivery_notes(no,date,customer_id,customer,note,deposit_per_keg,operator)
                        VALUES(?,?,?,?,?,?,?)""", (no, date, customer_id, cust["name"], note, dep, operator))
        groups = {}
        for kid in keg_ids:
            k = self.one("SELECT * FROM kegs WHERE id=?", (kid,))
            if k["status"] != "Pun":
                raise ValueError(f"Keg {k['code']} nije pun.")
            groups.setdefault((k["batch_id"], k["size_l"]), []).append(k)
        for (bid, size), ks in groups.items():
            b = self.batch(bid) if bid else None
            self.x("""INSERT INTO delivery_lines(note_id,batch_id,lot,beer,pack_type,qty,unit_l,keg_codes)
                      VALUES(?,?,?,?,?,?,?,?)""", (nid, bid, b["batch_no"] if b else "", b["recipe"] if b else "",
                                                   "Keg", len(ks), size, compress_codes([k["code"] for k in ks])))
            for k in ks:
                self.keg_action(k["id"], "Isporuči", customer=cust["name"], date=date, note=f"Otpremnica {no}")
        for ln in other_lines:
            b = self.batch(ln["batch_id"])
            self.x("""INSERT INTO delivery_lines(note_id,batch_id,lot,beer,pack_type,qty,unit_l)
                      VALUES(?,?,?,?,?,?,?)""", (nid, b["id"], b["batch_no"], b["recipe"], ln["pack_type"],
                                                 int(ln["qty"]), ln["unit_l"]))
        return nid

    def delete_delivery(self, note_id):
        self.x("DELETE FROM delivery_notes WHERE id=?", (note_id,))

    # ---------------------------------------------------------------- trošarine
    def excise_rate(self):
        return float(self.get_setting("excise_reduced" if self.get_setting("small_brewery") == "1" else "excise_rate") or 0)

    def excise_rows(self, d_from, d_to):
        rate = self.excise_rate()
        rows = []
        for p in self.packaging_rows(d_from, d_to):
            b = self.batch(p["batch_id"]) if p.get("batch_id") else None
            hl = (p.get("total_l") or 0) / 100
            abv = self.beer_abv(b)
            rows.append({"id": p["id"], "date": p["date"], "lot": p.get("batch_no") or p.get("lot") or "",
                         "beer": b["recipe"] if b else "", "pack": p.get("pack_type") or "", "hl": hl, "abv": abv,
                         "hl_vol": hl * abv if abv else None, "excise": hl * abv * rate if abv else None})
        return rows, rate

    # ---------------------------------------------------------------- sljedivost / povlačenje
    def recall(self, text):
        """Od LOT-a sirovine ili piva do šarži, pakiranja, kegova i kupaca."""
        text = (text or "").strip()
        out = {"lots": [], "batches": []}
        if not text:
            return out
        like = f"%{text}%"
        lots = self.q("SELECT * FROM v_lots WHERE lot_no LIKE ?", (like,))
        out["lots"] = lots
        bids = {r["batch_id"] for l in lots for r in self.q("SELECT DISTINCT batch_id FROM batch_consumption WHERE lot_id=?", (l["id"],))}
        bids |= {b["id"] for b in self.q("SELECT id FROM batches WHERE batch_no LIKE ?", (like,))}
        for bid in sorted(bids):
            b = self.batch(bid)
            used = [c for c in self.batch_consumption(bid) if not lots or c["lot_id"] in {l["id"] for l in lots}]
            deliveries = self.q("""SELECT d.no, d.date, d.customer, l.pack_type, l.qty, l.unit_l, l.keg_codes
                                   FROM delivery_lines l JOIN delivery_notes d ON d.id=l.note_id WHERE l.batch_id=?
                                   ORDER BY d.date""", (bid,))
            keg_moves = self.q("""SELECT g.ts, g.action, g.customer, k.code FROM keg_log g JOIN kegs k ON k.id=g.keg_id
                                  WHERE g.batch_id=? AND g.action IN ('Isporuči','Napuni') ORDER BY g.ts""", (bid,))
            at_customers = self.q("SELECT code, customer FROM kegs WHERE batch_id=? AND status='Kod kupca'", (bid,))
            full = self.q("SELECT code FROM kegs WHERE batch_id=? AND status='Pun'", (bid,))
            out["batches"].append({"batch": b, "used": used, "packaging": [p for p in self.packaging_rows()
                                                                          if p.get("batch_id") == bid],
                                   "deliveries": deliveries, "keg_moves": keg_moves, "at_customers": at_customers,
                                   "full": full})
        return out

    # ---------------------------------------------------------------- mjerenja fermentacije i senzorika
    def readings(self, batch_id):
        return self.q("SELECT * FROM ferm_readings WHERE batch_id=? ORDER BY date, time, id", (batch_id,))

    def save_reading(self, data, id=None):
        return self._upsert("ferm_readings", data, id)

    def delete_reading(self, id):
        self.x("DELETE FROM ferm_readings WHERE id=?", (id,))

    def seed_extras_demo(self):
        d = lambda days: (dt.date.today() + dt.timedelta(days=days)).isoformat()
        for name, addr in [("Pub Lavica", "Ilica 10, Zagreb"), ("Bistro Kantun", "Riva 3, Split"),
                           ("Hotel Adria", "Obala 1, Rijeka")]:
            self.save_customer({"name": name, "address": addr})
        self.set_setting("keg_deposit", "50")
        pl = self.one("SELECT id FROM batches WHERE status='Planirano' ORDER BY id LIMIT 1")
        if pl:
            self.update_batch(pl["id"], {"tank": "Fermentor 3"})
        self.set_setting("extra_cost_l", "0.35")
        for b in self.brewed_batches():
            if b["status"] == "Fermentacija":
                sg = [1.050, 1.042, 1.030, 1.021, 1.015, 1.012, 1.011]
                for i, g in enumerate(sg):
                    self.save_reading({"batch_id": b["id"], "date": (dt.date.fromisoformat(b["brew_date"])
                                       + dt.timedelta(days=i * 2)).isoformat(), "time": "09:00", "sg": g,
                                       "temp": 19 + (1 if 1 < i < 4 else 0), "by": "Ivo Ivić"})
            else:
                self.update_batch(b["id"], {"sensory_score": 4.5, "sensory_note": "Čisto, bistro, bez off-flavora",
                                            "sensory_by": "Ivo Ivić", "sensory_date": b.get("ferm_end") or d(-5)})

    # ---------------------------------------------------------------- grupno uređivanje i brisanje kegova
    def kegs_bulk_update(self, ids, data, renumber=None):
        """data: polja za promjenu (prazna se ne mijenjaju); renumber=(prefiks, početni broj, broj znamenki)."""
        import datetime as _dt
        kegs = sorted([self.one("SELECT * FROM kegs WHERE id=?", (i,)) for i in ids], key=lambda k: k["code"])
        new_codes = {}
        if renumber:
            prefix, start, digits = renumber
            for n, k in enumerate(kegs):
                new_codes[k["id"]] = f"{prefix}{int(start) + n:0{int(digits)}d}"
            taken = {r["code"] for r in self.q(f"SELECT code FROM kegs WHERE id NOT IN ({','.join('?' * len(ids))})", ids)}
            clash = sorted(set(new_codes.values()) & taken)
            if clash:
                raise ValueError("Oznake već postoje na drugim kegovima: " + ", ".join(clash[:8]))
        ts = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        with self.con:
            for k in kegs:  # privremene oznake da se izbjegne sudar unutar odabira
                if k["id"] in new_codes:
                    self.con.execute("UPDATE kegs SET code=? WHERE id=?", (f"__tmp_{k['id']}", k["id"]))
            for k in kegs:
                upd = {key: v for key, v in data.items() if v not in (None, "")}
                if k["id"] in new_codes:
                    upd["code"] = new_codes[k["id"]]
                if upd.get("status") and upd["status"] != k["status"]:
                    upd["status_date"] = _dt.date.today().isoformat()
                    if upd["status"] in ("Čist", "Otpisan", "Servis"):
                        upd.setdefault("batch_id", None)
                if not upd:
                    continue
                keys = list(upd)
                self.con.execute(f"UPDATE kegs SET {','.join(x + '=?' for x in keys)} WHERE id=?",
                                 [upd[x] for x in keys] + [k["id"]])
                note = ", ".join(f"{x}: {upd[x]}" for x in keys if x not in ("status_date", "batch_id"))
                self.con.execute("INSERT INTO keg_log(keg_id,ts,action,status,note) VALUES(?,?,?,?,?)",
                                 (k["id"], ts, "Izmjena", upd.get("status", k["status"]),
                                  (f"{k['code']} → " if "code" in upd else "") + note))

    def delete_kegs(self, ids):
        with self.con:
            for i in ids:
                self.con.execute("DELETE FROM keg_log WHERE keg_id=?", (i,))
                self.con.execute("DELETE FROM kegs WHERE id=?", (i,))

    # ---------------------------------------------------------------- trošarine – obrazac MI-PI
    ABV_CLASSES = [(0.6, 2.8, "0,6 - 2,8%"), (2.9, 3.9, "2,9 - 3,9 %"), (4.0, 4.9, "4,0 - 4,9 %"),
                   (5.0, 5.9, "5,0 - 5,9 %"), (6.0, 6.9, "6,0 - 6,9 %"), (7.0, 7.9, "7,0 - 7,9 %"),
                   (8.0, 8.9, "8,0 - 8,9 %"), (9.0, 9.9, "9,0 - 9,9 %"), (10.0, 10.9, "10,0 - 10,9 %"),
                   (11.0, 999, "11 % i više")]

    @classmethod
    def abv_class(cls, abv):
        a = round(float(abv or 0), 1)
        for i, (lo, hi, _) in enumerate(cls.ABV_CLASSES):
            if a <= hi + 1e-9:
                return i
        return len(cls.ABV_CLASSES) - 1

    def _ensure_excise_table(self):
        self.con.execute("""CREATE TABLE IF NOT EXISTS excise_entries(
            id INTEGER PRIMARY KEY, period TEXT NOT NULL, packaging_id INTEGER, batch_id INTEGER, date TEXT,
            include INTEGER DEFAULT 1, trade_name TEXT, hl REAL, abv REAL, note TEXT)""")

    @staticmethod
    def period_bounds(period):
        y, m = map(int, period.split("-"))
        start = dt.date(y, m, 1)
        end = (start.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
        return start.isoformat(), end.isoformat()

    def excise_entries(self, period):
        """Stavke za prijavu u mjesecu (YYYY-MM). Pakiranja iz tog mjeseca dodaju se sama (označena za prijavu)."""
        self._ensure_excise_table()
        d_from, d_to = self.period_bounds(period)
        have = {r["packaging_id"] for r in self.q("SELECT packaging_id FROM excise_entries WHERE packaging_id IS NOT NULL")}
        for p in self.packaging_rows(d_from, d_to):
            if p["id"] in have:
                continue
            b = self.batch(p["batch_id"]) if p.get("batch_id") else None
            self.con.execute("""INSERT INTO excise_entries(period,packaging_id,batch_id,date,include,trade_name,hl,abv)
                                VALUES(?,?,?,?,?,?,?,?)""",
                             (period, p["id"], p.get("batch_id"), p["date"], 1,
                              ((b or {}).get("recipe") or "").upper(), round((p.get("total_l") or 0) / 100, 3),
                              round(self.beer_abv(b), 1) if self.beer_abv(b) else None))
        self.con.commit()
        return self.q("""SELECT e.*, b.batch_no FROM excise_entries e LEFT JOIN batches b ON b.id=e.batch_id
                         WHERE e.period=? ORDER BY e.date, e.id""", (period,))

    def save_excise_entry(self, data, id=None):
        self._ensure_excise_table()
        return self._upsert("excise_entries", data, id)

    def delete_excise_entry(self, id):
        self.x("DELETE FROM excise_entries WHERE id=?", (id,))

    def excise_summary(self, period):
        """Specifikacija po pivu i razredima kao u obrascu MI-PI (samo stavke označene za prijavu)."""
        rate = self.excise_rate()
        spec = {}
        for e in self.excise_entries(period):
            if not e["include"] or not e.get("abv"):
                continue
            key = ((e["trade_name"] or "").strip().upper(), round(e["abv"], 1))
            spec[key] = round(spec.get(key, 0) + (e["hl"] or 0), 3)
        rows = []
        for (name, abv), hl in spec.items():
            rows.append({"class": self.abv_class(abv), "name": name, "hl": hl, "abv": abv, "rate": rate,
                         "excise": round(hl * abv * rate + 1e-9, 2)})
        rows.sort(key=lambda r: (r["class"], r["name"]))
        classes = {}
        for r in rows:
            c = classes.setdefault(r["class"], {"hl": 0.0, "excise": 0.0})
            c["hl"] = round(c["hl"] + r["hl"], 3)
            c["excise"] = round(c["excise"] + r["excise"], 2)
        total_hl = round(sum(c["hl"] for c in classes.values()), 3)
        total_ex = round(sum(c["excise"] for c in classes.values()), 2)
        missing = [e for e in self.excise_entries(period) if e["include"] and not e.get("abv")]
        return {"rows": rows, "classes": classes, "total_hl": total_hl, "total_excise": total_ex, "rate": rate,
                "missing": missing}

    def excise_reported(self, period):
        return self.get_setting(f"excise_reported_{period}") if self.val(
            "SELECT 1 FROM settings WHERE key=?", (f"excise_reported_{period}",)) else None

    def set_excise_reported(self, period, date=None):
        if date is None:
            self.x("DELETE FROM settings WHERE key=?", (f"excise_reported_{period}",))
        else:
            self.set_setting(f"excise_reported_{period}", date)

    def excise_reminder(self):
        """Podsjetnik u tekućem mjesecu: pivo istočeno prošli mjesec treba prijaviti (MI-PI)."""
        first = dt.date.today().replace(day=1)
        prev = (first - dt.timedelta(days=1)).strftime("%Y-%m")
        if self.excise_reported(prev):
            return None
        s = self.excise_summary(prev)
        m, y = prev[5:], prev[:4]
        if s["total_hl"] or s["missing"]:
            hl = f"{s['total_hl']:.3f}".replace(".", ",")
            ex = f"{s['total_excise']:.2f}".replace(".", ",")
            return (prev, f"Trošarine: pivo istočeno u {m}/{y} ({hl} hl, {ex} €) treba prijaviti carini obrascem MI-PI.")
        return (prev, f"Trošarine: predajte obrazac MI-PI za {m}/{y} (u programu nema istočenog piva za taj mjesec).")


    # ------------------------------------------------------------ zanemarena upozorenja (2.3)
    def _ensure_dismissed(self):
        self.con.execute("CREATE TABLE IF NOT EXISTS dismissed(key TEXT PRIMARY KEY, type TEXT, label TEXT, date TEXT)")

    def dismissed_keys(self):
        self._ensure_dismissed()
        return {r["key"] for r in self.q("SELECT key FROM dismissed")}

    def is_dismissed(self, item):
        keys = self.dismissed_keys()
        return item["key"] in keys or f"type:{item['type']}" in keys

    def visible(self, items):
        keys = self.dismissed_keys()
        return [i for i in items if i["key"] not in keys and f"type:{i['type']}" not in keys]

    def dismiss(self, items):
        """items: lista upozorenja (dict s key/type/text) ili ('type:<vrsta>', vrsta)."""
        self._ensure_dismissed()
        d = dt.date.today().isoformat()
        for it in items:
            if isinstance(it, tuple):
                key, typ = it
                label = f"Sva upozorenja vrste: {typ}"
            else:
                key, typ, label = it["key"], it["type"], it["text"]
            self.con.execute("INSERT OR REPLACE INTO dismissed(key, type, label, date) VALUES(?,?,?,?)",
                             (key, typ, label, d))
        self.con.commit()

    def undismiss(self, keys):
        self._ensure_dismissed()
        self.con.executemany("DELETE FROM dismissed WHERE key=?", [(k,) for k in keys])
        self.con.commit()

    def dismissed_list(self):
        self._ensure_dismissed()
        return self.q("SELECT * FROM dismissed ORDER BY key LIKE 'type:%' DESC, date DESC, type, label")


    # ------------------------------------------------------------ alkohol i sastojci za naljepnicu (2.5)
    def apply_official_abv(self, commit=True, overwrite=False):
        """Upiše alkohol prema službenoj analizi u recepture prema nazivu (Lager/Pilsner, IPA, Pale Ale, Stout, Sour)."""
        n = 0
        for r in self.q("SELECT id, name, code, official_abv FROM recipes"):
            if r["official_abv"] and not overwrite:
                continue
            name = (r["name"] or "").lower()
            for keys, abv in OFFICIAL_ABV:
                if any(k in name for k in keys) or (keys[0] == "lager" and (r["code"] or "").upper() == "LA"):
                    self.con.execute("UPDATE recipes SET official_abv=? WHERE id=?", (abv, r["id"]))
                    n += 1
                    break
        if commit:
            self.con.commit()
        return n

    def beer_abv(self, batch):
        """Alkohol za naljepnicu i trošarine: službena analiza iz recepture, inače izmjereni alkohol šarže."""
        if not batch:
            return None
        if batch.get("recipe_id"):
            off = self.val("SELECT official_abv FROM recipes WHERE id=?", (batch["recipe_id"],))
            if off:
                return off
        return batch.get("abv")

    def auto_ingredients(self, recipe_id):
        """Sastojci iz recepture, poredani po masi (voda prva); alergeni VELIKIM slovima.
        Vraća (tekst, set alergena)."""
        parts, allergens = {}, set()
        for ln in self.q("""SELECT ri.qty, i.name, i.category, i.unit FROM recipe_items ri JOIN items i ON i.id=ri.item_id
                            WHERE ri.recipe_id=?""", (recipe_id,)):
            nm, cat = (ln["name"] or "").lower(), ln["category"] or ""
            if cat in ("Kemikalija", "Ambalaža") or any(k in nm + " " for k in SKIP_INGR):
                continue
            qty = (ln["qty"] or 0) * (0.001 if (ln["unit"] or "").lower() == "g" else 1)
            label = None
            if cat == "Slad" or "slad" in nm or "malt" in nm:
                label, alg = "JEČMENI SLAD", "JEČAM"
                for keys, lab, a in INGR_RULES:
                    if any(k in nm for k in keys):
                        label, alg = lab, a
                        break
                allergens.add(alg)
            elif cat == "Hmelj":
                label = "hmelj"
            elif cat == "Kvasac":
                label = "kvasac"
            else:
                for keys, lab, a in INGR_RULES:
                    if any(k in nm for k in keys):
                        label = lab
                        allergens.add(a)
                        break
                if not label:
                    if nm.startswith("pire "):
                        label = nm[5:].strip() + " (pire)"
                    elif "sugar" in nm or "šećer" in nm:
                        label = "šećer"
                    elif "lakto" in nm or "lactose" in nm:
                        label, _ = "LAKTOZA (MLIJEKO)", allergens.add("MLIJEKO")
                    else:
                        label = ln["name"].lower()
            parts[label] = parts.get(label, 0) + qty
        if not parts:
            return None, allergens
        order = sorted(parts, key=lambda k: -parts[k])
        return "voda, " + ", ".join(order), allergens

    def label_texts(self, recipe_id, recipe_allergens=None, recipe_ingredients=None):
        """(sastojci ili None, alergeni) za naljepnicu."""
        ingr, algs = (None, set())
        if recipe_id:
            ingr, algs = self.auto_ingredients(recipe_id)
        if recipe_ingredients and recipe_ingredients.strip():
            ingr = recipe_ingredients.strip()
        v = (recipe_allergens or "").strip()
        if not v or v.lower().startswith("sadrži ječmeni slad"):
            if algs:
                cereals = [a for a in ("JEČAM", "PŠENICA", "RAŽ", "ZOB", "PIR") if a in algs]
                v = ", ".join(cereals) + (" (GLUTEN)" if cereals else "")
                if "MLIJEKO" in algs:
                    v += (", " if v else "") + "MLIJEKO"
            else:
                v = self.get_setting("label_allergens") or "JEČAM (GLUTEN)"
        if v.lower().startswith("sadrži"):
            v = v[6:].lstrip(" :")
        ingr = ingr.rstrip(".") + "." if ingr else None
        return ingr, v.upper().rstrip(".") + "."


    def beer_color(self, recipe_id=None, name=None, code=None):
        """Boja zastavice za pivo: iz recepture (naziv boje ili #hex), inače prema vrsti piva."""
        sel = None
        if recipe_id:
            r = self.one("SELECT name, code, label_color FROM recipes WHERE id=?", (recipe_id,))
            if r:
                sel, name, code = r.get("label_color"), r["name"], r["code"]
        if sel:
            sel = sel.strip()
            if sel.startswith("#") and len(sel) == 7:
                return sel
            for k, v in LABEL_COLORS.items():
                if k.lower() == sel.lower():
                    return v
        n = (name or "").lower()
        for keys, col in LABEL_COLOR_RULES:
            if any(k in n for k in keys) or (keys[0] == "pils" and (code or "").upper() == "LA"):
                return LABEL_COLORS[col]
        return LABEL_COLORS["Siva"]
