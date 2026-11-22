"""Kušanja: najave grupa koje dolaze na kušanje piva (datum, vrijeme, grupa, broj osoba, kontakt, vrsta, cijena, status).
Svaka najava se šalje u Google kalendar (gcal_id = ID događaja); gcal_dirty = čeka slanje (izmjena bez veze s Googleom)."""
import datetime as dt

STATUSES = ["Najavljeno", "Potvrđeno", "Održano", "Otkazano"]
PACKAGES = ["Kušanje piva", "Kušanje + obilazak pivovare", "Kušanje + hrana", "Privatna zabava"]
LANGUAGES = ["Hrvatski", "Engleski", "Njemački", "Talijanski", "Mađarski"]
SOURCES = ["Telefon", "E-mail", "Web stranica", "Društvene mreže", "Agencija", "Preporuka", "Osobno"]
SPACES = ["Pivnica", "Terasa", "Pivovara (obilazak)"]
PAY_METHODS = ["Gotovina", "Kartica", "Transakcijski račun"]
PAY_STATUS = ["Nije plaćeno", "Plaćen predujam", "Plaćeno"]
NEW_COLS = [("language", "TEXT"), ("source", "TEXT"), ("space", "TEXT"), ("staff", "TEXT"), ("company", "TEXT"),
            ("company_oib", "TEXT"), ("company_address", "TEXT"), ("pay_method", "TEXT"), ("pay_status", "TEXT"),
            ("no_alcohol", "INTEGER")]


def ensure(db):
    db.con.execute("""CREATE TABLE IF NOT EXISTS bookings(
        id INTEGER PRIMARY KEY, date TEXT NOT NULL, time TEXT, duration_min INTEGER DEFAULT 120, group_name TEXT NOT NULL,
        people INTEGER, contact TEXT, phone TEXT, email TEXT, package TEXT, price_pp REAL, deposit REAL,
        status TEXT DEFAULT 'Najavljeno', note TEXT, gcal_id TEXT, gcal_dirty INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0,
        created TEXT, updated TEXT, created_by TEXT)""")
    have = {r["name"] for r in db.q("PRAGMA table_info(bookings)")}
    for c, t in NEW_COLS:
        if c not in have:
            db.con.execute(f"ALTER TABLE bookings ADD COLUMN {c} {t}")
    db.con.commit()


def _now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def _user():
    try:
        import webapi
        return webapi.USER or None
    except Exception:  # noqa: BLE001
        return None


def consts(db):
    ensure(db)
    def used(col, base):
        vals = [r[col] for r in db.q(f"SELECT DISTINCT {col} FROM bookings WHERE {col} IS NOT NULL AND {col}<>'' ORDER BY {col}")]
        return list(dict.fromkeys(base + vals))
    staff = []
    try:
        staff = [e["name"] for e in db.employees()]
    except Exception:  # noqa: BLE001
        pass
    return {"statuses": STATUSES, "packages": used("package", PACKAGES), "languages": used("language", LANGUAGES),
            "sources": used("source", SOURCES), "spaces": used("space", SPACES), "staff": used("staff", staff),
            "pay_methods": used("pay_method", PAY_METHODS), "pay_status": PAY_STATUS,
            "capacity": int(float(db.get_setting("booking_capacity") or 0) or 0)}


def bookings(db, past=False):
    ensure(db)
    today = dt.date.today().isoformat()
    sql = "SELECT * FROM bookings WHERE COALESCE(deleted,0)=0"
    args = []
    if not past:
        sql += " AND date>=?"
        args.append(today)
    rows = db.q(sql + (" ORDER BY date, time" if not past else " ORDER BY date DESC, time DESC"), args)
    for r in rows:
        r["total"] = round((r.get("people") or 0) * (r.get("price_pp") or 0), 2)
        r["days"] = (dt.date.fromisoformat(r["date"]) - dt.date.today()).days
    return rows


def booking(db, id):
    ensure(db)
    return db.one("SELECT * FROM bookings WHERE id=?", (id,))


def save(db, data, id=None):
    ensure(db)
    name = (data.get("group_name") or "").strip()
    if not name:
        raise ValueError("Upišite naziv grupe.")
    if not data.get("date"):
        raise ValueError("Odaberite datum.")
    tm = (data.get("time") or "").strip() or None
    if tm and not (len(tm) == 5 and tm[2] == ":"):
        raise ValueError("Vrijeme upišite kao SS:MM, npr. 18:00.")
    st = data.get("status") or "Najavljeno"
    if st not in STATUSES:
        st = "Najavljeno"

    def n(k, f=float):
        v = data.get(k)
        return f(v) if v not in (None, "") else None
    vals = {"date": data["date"][:10], "time": tm, "duration_min": n("duration_min", int) or 120, "group_name": name,
            "people": n("people", int), "contact": (data.get("contact") or "").strip() or None,
            "phone": (data.get("phone") or "").strip() or None, "email": (data.get("email") or "").strip() or None,
            "package": (data.get("package") or "").strip() or None, "price_pp": n("price_pp"), "deposit": n("deposit"),
            "status": st, "note": (data.get("note") or "").strip() or None, "gcal_dirty": 1, "updated": _now()}
    for k in ("language", "source", "space", "staff", "company", "company_address", "pay_method", "pay_status"):
        vals[k] = (str(data.get(k) or "")).strip() or None
    oib = (str(data.get("company_oib") or "")).strip().upper().removeprefix("HR")
    if oib and not (oib.isdigit() and len(oib) == 11):
        raise ValueError("OIB mora imati točno 11 znamenki.")
    vals["company_oib"] = oib or None
    vals["no_alcohol"] = n("no_alcohol", int)
    if vals["no_alcohol"] and vals["people"] and vals["no_alcohol"] > vals["people"]:
        raise ValueError("Broj gostiju bez alkohola ne može biti veći od broja osoba.")
    if id:
        db._upsert("bookings", vals, id)
    else:
        vals.update(created=_now(), created_by=_user())
        id = db._upsert("bookings", vals)
    return id


def set_status(db, id, status):
    ensure(db)
    if status not in STATUSES:
        raise ValueError("Nepoznat status.")
    db.x("UPDATE bookings SET status=?, gcal_dirty=1, updated=? WHERE id=?", (status, _now(), id))
    return True


def delete(db, id):
    """Najava koja je u kalendaru se samo označi (događaj se briše pri sljedećem slanju), ostale se brišu odmah."""
    ensure(db)
    b = booking(db, id)
    if not b:
        return False
    if b.get("gcal_id"):
        db.x("UPDATE bookings SET deleted=1, gcal_dirty=1, updated=? WHERE id=?", (_now(), id))
    else:
        db.x("DELETE FROM bookings WHERE id=?", (id,))
    return True


def pending(db):
    """Najave koje treba poslati u Google kalendar (nove, izmijenjene, otkazane, obrisane)."""
    ensure(db)
    return db.q("SELECT * FROM bookings WHERE COALESCE(gcal_dirty,0)=1 ORDER BY date, time")


def mark_synced(db, id, gcal_id=None, remove=False):
    ensure(db)
    if remove:
        db.x("DELETE FROM bookings WHERE id=? AND COALESCE(deleted,0)=1", (id,))
        db.x("UPDATE bookings SET gcal_id=NULL, gcal_dirty=0 WHERE id=?", (id,))
    else:
        db.x("UPDATE bookings SET gcal_id=?, gcal_dirty=0 WHERE id=?", (gcal_id, id))
    return True


def reset_calendar(db):
    """Promijenjen kalendar: sve najave se ponovno šalju (kao nove)."""
    ensure(db)
    db.x("DELETE FROM bookings WHERE COALESCE(deleted,0)=1")
    db.x("UPDATE bookings SET gcal_id=NULL, gcal_dirty=1")
    return True


def upcoming(db, days=7):
    """Za nadzornu ploču: kušanja danas i u sljedećih N dana (bez otkazanih)."""
    ensure(db)
    t0 = dt.date.today()
    lim = (t0 + dt.timedelta(days=days)).isoformat()
    rows = db.q("""SELECT * FROM bookings WHERE COALESCE(deleted,0)=0 AND status NOT IN ('Otkazano','Održano')
                   AND date>=? AND date<=? ORDER BY date, time""", (t0.isoformat(), lim))
    for r in rows:
        r["days"] = (dt.date.fromisoformat(r["date"]) - t0).days
    return rows


def month_summary(db, year=None):
    """Broj kušanja, osoba i prihod po mjesecu (održana i potvrđena)."""
    ensure(db)
    y = str(year or dt.date.today().year)
    return db.q("""SELECT substr(date,1,7) AS month, COUNT(*) AS n, COALESCE(SUM(people),0) AS people,
                   ROUND(COALESCE(SUM(people*price_pp),0),2) AS total FROM bookings
                   WHERE COALESCE(deleted,0)=0 AND status IN ('Potvrđeno','Održano') AND substr(date,1,4)=?
                   GROUP BY substr(date,1,7) ORDER BY month""", (y,))


def _mins(t):
    try:
        h, m = map(int, (t or "").split(":"))
        return h * 60 + m
    except ValueError:
        return None


def conflicts(db, data, id=None):
    """Rezervacije koje se vremenski preklapaju s ovom (isti dan; isti prostor ili prostor nije upisan) i kapacitet.
    Vraća {overlap: [...], people: ukupno osoba u isto vrijeme (s ovom), capacity, over}."""
    ensure(db)
    date = (data.get("date") or "")[:10]
    if not date:
        return {"overlap": [], "people": 0, "capacity": 0, "over": False}
    t0 = _mins(data.get("time"))
    dur = int(float(data.get("duration_min") or 120))
    space = (str(data.get("space") or "")).strip()
    out = []
    for b in db.q("""SELECT * FROM bookings WHERE date=? AND COALESCE(deleted,0)=0 AND status<>'Otkazano' AND id<>?""",
                  (date, id or 0)):
        if space and b.get("space") and b["space"] != space:
            continue
        b0 = _mins(b.get("time"))
        if t0 is not None and b0 is not None:
            if not (t0 < b0 + (b.get("duration_min") or 120) and b0 < t0 + dur):
                continue
        out.append({"id": b["id"], "group_name": b["group_name"], "time": b.get("time") or "", "people": b.get("people") or 0,
                    "space": b.get("space") or "", "duration_min": b.get("duration_min") or 120})
    cap = int(float(db.get_setting("booking_capacity") or 0) or 0)
    ppl = sum(o["people"] for o in out) + int(float(data.get("people") or 0))
    return {"overlap": out, "people": ppl, "capacity": cap, "over": bool(cap and ppl > cap)}
