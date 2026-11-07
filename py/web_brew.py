"""Receptura u dvije razine: KUHANJE (varionica, npr. 125 L) i FERMENTOR (npr. 2 kuhanja = 250 L).

* recipes.brew_size_l   – volumen jednog kuhanja; recipes.brews – broj kuhanja po fermentoru;
  recipes.batch_size_l  = brew_size_l × brews (ciljni volumen u fermentoru).
* recipe_items.stage    – 'brew' (količina po kuhanju) ili 'ferm' (količina za cijeli fermentor: kvasac, dry hop…);
  recipe_items.add_min  – VRIJEME (kao BeerSmith): za kuhanje = koliko minuta se dodatak kuha (90 od 90 = na početku,
                          10 = 10 min prije kraja, 0 = na kraju); za fermentor (dry hop) = dan nakon kuhanja.
  Svaki dodatak hmelja je zaseban redak recepture (isti hmelj može biti više puta s različitim vremenom).
* recipes.mash_steps    – koraci ukomljavanja [{name, temp, min}], lauter_min, whirl_min, ciljne vrijednosti.
* batches = jedan fermentor = jedan LOT piva; batches.brews = planirani broj kuhanja;
  batch_brews = pojedina kuhanja (datum, volumen sladovine, OG, pH, CCP…);
  batch_consumption.brew_no – 1..n = kuhanje, 0 = fermentor (kvasac, dry hop).
"""
import json

EPS = 1e-6


def r4(x):
    return round(float(x or 0) + 0.0, 4)


def ensure(db):
    c = db.con
    def cols(t):
        return {r["name"] for r in db.q(f"PRAGMA table_info({t})")}
    for col, typ in (("brew_size_l", "REAL"), ("brews", "INTEGER DEFAULT 1"), ("mash_steps", "TEXT"), ("lauter_min", "INTEGER"),
                     ("whirl_min", "INTEGER"), ("target_og", "REAL"), ("target_fg", "REAL"), ("target_ferm_temp", "REAL"),
                     ("cool_temp", "REAL")):
        if col not in cols("recipes"):
            c.execute(f"ALTER TABLE recipes ADD COLUMN {col} {typ}")
    for col, typ in (("stage", "TEXT DEFAULT 'brew'"), ("add_min", "INTEGER"), ("alpha_adj", "INTEGER")):
        if col not in cols("recipe_items"):
            c.execute(f"ALTER TABLE recipe_items ADD COLUMN {col} {typ}")
    for col, typ in (("brews", "INTEGER"), ("ferm_done", "INTEGER")):
        if col not in cols("batches"):
            c.execute(f"ALTER TABLE batches ADD COLUMN {col} {typ}")
    if "brew_no" not in cols("batch_consumption"):
        c.execute("ALTER TABLE batch_consumption ADD COLUMN brew_no INTEGER")
    try:
        if "brew_no" not in cols("ccp_boil"):
            c.execute("ALTER TABLE ccp_boil ADD COLUMN brew_no INTEGER")
    except Exception:  # noqa: BLE001
        pass
    c.execute("""CREATE TABLE IF NOT EXISTS batch_brews(
        id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE, n INTEGER NOT NULL,
        brew_date TEXT, volume_l REAL, wort_l REAL, og_sg REAL, ph REAL, brewer TEXT, boil_start TEXT, boil_end TEXT,
        boil_min INTEGER, boil_temp REAL, done INTEGER DEFAULT 0, note TEXT, UNIQUE(batch_id, n))""")
    if db.val("SELECT value FROM settings WHERE key='brew2_migrated'") != "1":
        _migrate(db)
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('brew2_migrated','1')")
    if db.val("SELECT value FROM settings WHERE key='brew3_migrated'") != "1":
        _migrate_times(db)
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('brew3_migrated','1')")
    c.commit()


def _split_schedule(rows, items_dry):
    """Raspored hmelja (dijelovi ukupne količine artikla) -> dijelovi po fazi (kuhanje / fermentor)."""
    out = []
    for x in rows:
        iid = x.get("item_id")
        fd = items_dry.get(iid, 0)
        y = dict(x)
        if (x.get("stage") or "boil") == "dry":
            y["frac"] = round(float(x.get("frac") or 0) / fd, 4) if fd > EPS else float(x.get("frac") or 0)
        else:
            y["frac"] = round(float(x.get("frac") or 0) / (1 - fd), 4) if 1 - fd > EPS else float(x.get("frac") or 0)
        out.append(y)
    return out


def _dry_fracs(rows):
    d = {}
    for x in rows:
        if (x.get("stage") or "boil") == "dry":
            d[x.get("item_id")] = d.get(x.get("item_id"), 0) + float(x.get("frac") or 0)
    return {k: min(v, 1.0) for k, v in d.items()}


def _migrate(db):
    """Jednokratno: postojeće recepture = 1 kuhanje po fermentoru (isti ukupni utrošak); kvasac i dry hop -> fermentor."""
    c = db.con
    for r in db.q("SELECT * FROM recipes"):
        c.execute("UPDATE recipes SET brew_size_l=COALESCE(brew_size_l, batch_size_l), brews=COALESCE(brews,1) WHERE id=?", (r["id"],))
        c.execute("""UPDATE recipe_items SET stage='ferm' WHERE recipe_id=? AND item_id IN
                     (SELECT id FROM items WHERE category='Kvasac')""", (r["id"],))
        try:
            rows = json.loads(r.get("hop_schedule") or "[]") or []
        except ValueError:
            rows = []
        fd = _dry_fracs(rows)
        for iid, f in fd.items():
            for ln in db.q("SELECT * FROM recipe_items WHERE recipe_id=? AND item_id=? AND COALESCE(stage,'brew')='brew'", (r["id"], iid)):
                if f >= 1 - EPS:
                    c.execute("UPDATE recipe_items SET stage='ferm' WHERE id=?", (ln["id"],))
                elif f > EPS:
                    c.execute("UPDATE recipe_items SET qty=? WHERE id=?", (r4(ln["qty"] * (1 - f)), ln["id"]))
                    c.execute("INSERT INTO recipe_items(recipe_id,item_id,qty,stage) VALUES(?,?,?,'ferm')",
                              (r["id"], iid, r4(ln["qty"] * f)))
        if rows:
            c.execute("UPDATE recipes SET hop_schedule=? WHERE id=?", (json.dumps(_split_schedule(rows, fd)), r["id"]))
    for b in db.q("SELECT id, hop_schedule FROM batches WHERE hop_schedule IS NOT NULL AND hop_schedule<>''"):
        try:
            rows = json.loads(b["hop_schedule"]) or []
        except ValueError:
            continue
        c.execute("UPDATE batches SET hop_schedule=? WHERE id=?", (json.dumps(_split_schedule(rows, _dry_fracs(rows))), b["id"]))
    c.execute("UPDATE batches SET brews=1 WHERE brews IS NULL")
    c.execute("UPDATE batches SET ferm_done=1 WHERE status<>'Planirano' AND ferm_done IS NULL")


def _migrate_times(db):
    """2.38: raspored hmelja recepture -> zasebni retci recepture s vremenom kuhanja (BeerSmith);
    „minuta od početka” -> „vrijeme kuhanja” (koliko minuta se kuha) i za raspored pojedine šarže."""
    c = db.con
    for r in db.q("SELECT * FROM recipes"):
        boil = int(r.get("boil_min") or 60)
        try:
            rows = json.loads(r.get("hop_schedule") or "[]") or []
        except ValueError:
            rows = []
        hops = db.q("""SELECT ri.* FROM recipe_items ri JOIN items i ON i.id=ri.item_id
                       WHERE ri.recipe_id=? AND i.category='Hmelj'""", (r["id"],))
        for ln in hops:
            stg = "dry" if ln.get("stage") == "ferm" else "boil"
            mine = [x for x in rows if x.get("item_id") == ln["item_id"] and (x.get("stage") or "boil") == stg]
            if not mine:
                if stg == "boil":
                    c.execute("UPDATE recipe_items SET add_min=? WHERE id=?", (boil, ln["id"]))  # zadano: od početka kuhanja
                continue
            c.execute("DELETE FROM recipe_items WHERE id=?", (ln["id"],))
            left = 1.0
            for x in mine:
                f = float(x.get("frac") or 0)
                left -= f
                t = max(0, min(boil, boil - int(x.get("min") or 0))) if stg == "boil" else None
                c.execute("INSERT INTO recipe_items(recipe_id,item_id,qty,stage,add_min) VALUES(?,?,?,?,?)",
                          (r["id"], ln["item_id"], r4(ln["qty"] * f), ln.get("stage") or "brew", t))
            if left > 0.001:
                c.execute("INSERT INTO recipe_items(recipe_id,item_id,qty,stage,add_min) VALUES(?,?,?,?,?)",
                          (r["id"], ln["item_id"], r4(ln["qty"] * left), ln.get("stage") or "brew", boil if stg == "boil" else None))
        # ostali dodaci (npr. Whirlfloc) upisani kao minuta od početka -> vrijeme kuhanja
        c.execute("""UPDATE recipe_items SET add_min=MAX(0, ?-add_min) WHERE recipe_id=? AND add_min IS NOT NULL
                     AND COALESCE(stage,'brew')='brew' AND item_id NOT IN (SELECT id FROM items WHERE category='Hmelj')""",
                  (boil, r["id"]))
        c.execute("UPDATE recipes SET hop_schedule=NULL WHERE id=?", (r["id"],))
    for b in db.q("""SELECT b.id, b.hop_schedule, b.boil_min, r.boil_min AS rboil FROM batches b LEFT JOIN recipes r ON r.id=b.recipe_id
                     WHERE b.hop_schedule IS NOT NULL AND b.hop_schedule<>''"""):
        try:
            rows = json.loads(b["hop_schedule"]) or []
        except ValueError:
            continue
        boil = int(b.get("boil_min") or b.get("rboil") or 60)
        for x in rows:
            if (x.get("stage") or "boil") == "boil":
                x["min"] = max(0, min(boil, boil - int(x.get("min") or 0)))
        c.execute("UPDATE batches SET hop_schedule=? WHERE id=?", (json.dumps(rows), b["id"]))


# ------------------------------------------------------------------ recepture
def sizes(db, recipe_id):
    """(volumen kuhanja, broj kuhanja, volumen fermentora) recepture."""
    r = db.recipe(recipe_id) or {}
    fs = float(r.get("batch_size_l") or 0) or 1
    bs = float(r.get("brew_size_l") or 0) or fs
    n = int(r.get("brews") or 1) or 1
    return bs, n, fs


def stage_needs(db, recipe_id, stage, volume):
    """Količine jedne faze: 'brew' za kuhanje volumena `volume`, 'ferm' za fermentor volumena `volume` (zbroj po artiklu)."""
    if not recipe_id:
        return []
    bs, _n, fs = sizes(db, recipe_id)
    base = bs if stage == "brew" else fs
    out = {}
    for ln in db.recipe_lines(recipe_id):
        if (ln.get("stage") or "brew") != stage:
            continue
        need = r4(ln["qty"] * (volume or base) / base)
        if ln["item_id"] in out:
            out[ln["item_id"]]["need"] = r4(out[ln["item_id"]]["need"] + need)
        else:
            out[ln["item_id"]] = dict(ln, need=need, stage=stage)
    return list(out.values())


def batch_info(db, b):
    """Kuhanja šarže: planirano n, gotovo, volumen jednog kuhanja, je li kvasac/dry hop (fermentor) već skinut."""
    if isinstance(b, int):
        b = db.batch(b)
    n = int(b.get("brews") or 0) or (sizes(db, b["recipe_id"])[1] if b.get("recipe_id") else 1)
    rows = db.q("SELECT * FROM batch_brews WHERE batch_id=? ORDER BY n", (b["id"],))
    done = [x for x in rows if x.get("done")]
    if b["status"] != "Planirano" and not rows:  # šarža skuhana prije 2.37: sve gotovo
        return {"n": n, "done": n, "brews": [], "ferm_done": True, "brew_vol": (b.get("volume_l") or 0) / n, "legacy": True}
    return {"n": n, "done": len(done), "brews": rows, "ferm_done": bool(b.get("ferm_done")),
            "brew_vol": (b.get("volume_l") or 0) / n, "legacy": False}


def batch_needs(db, b):
    """Stvarno potrebno po recepturi za šaržu (skuhana kuhanja + fermentor ako je napunjen) – za inventuru."""
    if isinstance(b, int):
        b = db.batch(b)
    if not b.get("recipe_id"):
        return {}
    bi = batch_info(db, b)
    if bi["legacy"]:
        brew_vol_total, ferm = b.get("volume_l") or 0, True
    else:
        brew_vol_total = sum((x.get("volume_l") or bi["brew_vol"]) for x in bi["brews"] if x.get("done"))
        ferm = bi["ferm_done"]
    out = {}
    done = [x for x in bi["brews"] if x.get("done")]
    if not bi["legacy"] and len(done) > 1:
        # više kuhanja: korekcija gorčine za svako kuhanje prema alfi LOT-ova utrošenih u tom kuhanju
        for x in done:
            part = {}
            for ln in stage_needs(db, b["recipe_id"], "brew", x.get("volume_l") or bi["brew_vol"]):
                part[ln["item_id"]] = r4(part.get(ln["item_id"], 0) + ln["need"])
            for iid, q in _alpha(db, b, part, x["n"]).items():
                out[iid] = r4(out.get(iid, 0) + q)
    else:
        for ln in stage_needs(db, b["recipe_id"], "brew", brew_vol_total) if brew_vol_total else []:
            out[ln["item_id"]] = r4(out.get(ln["item_id"], 0) + ln["need"])
        out = _alpha(db, b, out)  # hmelj za gorčinu prema alfi utrošenih LOT-ova
    if ferm:
        for ln in stage_needs(db, b["recipe_id"], "ferm", b.get("volume_l") or 0):
            out[ln["item_id"]] = r4(out.get(ln["item_id"], 0) + ln["need"])
    return out


def _alpha(db, b, needs, brew_no=None):
    """Korekcija gorčine prema alfa kiselinama (samo hmelj s uključenom korekcijom)."""
    if not needs:
        return needs
    try:
        import web_more
        return web_more.alpha_factor_needs(db, b, needs, brew_no=brew_no)
    except Exception:  # noqa: BLE001
        return needs


def remaining_needs(db, b):
    """Što šarža još treba (za „Što naručiti”): preostala kuhanja i fermentor."""
    bi = batch_info(db, b)
    if b["status"] == "Planirano":
        left_brews = bi["n"]
    else:
        left_brews = max(bi["n"] - bi["done"], 0)
    out = {}
    if left_brews:
        for ln in stage_needs(db, b["recipe_id"], "brew", bi["brew_vol"] * left_brews):
            out[ln["item_id"]] = r4(out.get(ln["item_id"], 0) + ln["need"])
        out = _alpha(db, b, out)
    if not bi["ferm_done"] or b["status"] == "Planirano":
        for ln in stage_needs(db, b["recipe_id"], "ferm", b.get("volume_l") or 0):
            out[ln["item_id"]] = r4(out.get(ln["item_id"], 0) + ln["need"])
    return out


def mash_steps(r):
    try:
        st = json.loads((r or {}).get("mash_steps") or "[]") or []
    except ValueError:
        st = []
    return [{"name": s.get("name") or "Ukomljavanje", "temp": s.get("temp"), "min": int(s.get("min") or 0)} for s in st if s]


def recipe_extra(db, recipe_id):
    """Podaci za uređivanje recepture: koraci ukomljavanja i ostalo."""
    r = db.recipe(recipe_id) or {}
    return {"mash_steps": mash_steps(r)}


def save_recipe_extra(db, recipe_id, mash):
    clean = []
    for s in mash or []:
        nm = (s.get("name") or "").strip()
        mn = int(float(str(s.get("min") or 0).replace(",", ".")) or 0)
        tp = s.get("temp")
        tp = float(str(tp).replace(",", ".")) if tp not in (None, "") else None
        if nm or mn:
            clean.append({"name": nm or "Ukomljavanje", "temp": tp, "min": mn})
    db.x("UPDATE recipes SET mash_steps=? WHERE id=?", (json.dumps(clean), recipe_id))
    return True


def batch_brews(db, batch_id):
    b = db.batch(batch_id)
    return {"info": batch_info(db, b), "brews": db.q("SELECT * FROM batch_brews WHERE batch_id=? ORDER BY n", (batch_id,))}


def hop_ids(db):
    """Artikli kategorije Hmelj (za stupac α korekcije u recepturi)."""
    return [r["id"] for r in db.q("SELECT id FROM items WHERE category='Hmelj'")]
