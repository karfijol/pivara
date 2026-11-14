"""Kušanja: najave grupa koje dolaze na kušanje piva (datum, vrijeme, grupa, broj osoba, kontakt, vrsta, cijena, status).
Svaka najava se šalje u Google kalendar (gcal_id = ID događaja); gcal_dirty = čeka slanje (izmjena bez veze s Googleom)."""
import datetime as dt

STATUSES = ["Najavljeno", "Potvrđeno", "Održano", "Otkazano"]
PACKAGES = ["Kušanje piva", "Kušanje + obilazak pivovare", "Kušanje + hrana", "Privatna zabava"]


def ensure(db):
    db.con.execute("""CREATE TABLE IF NOT EXISTS bookings(
        id INTEGER PRIMARY KEY, date TEXT NOT NULL, time TEXT, duration_min INTEGER DEFAULT 120, group_name TEXT NOT NULL,
        people INTEGER, contact TEXT, phone TEXT, email TEXT, package TEXT, price_pp REAL, deposit REAL,
        status TEXT DEFAULT 'Najavljeno', note TEXT, gcal_id TEXT, gcal_dirty INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0,
        created TEXT, updated TEXT, created_by TEXT)""")
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
    pk = [r["package"] for r in db.q("SELECT DISTINCT package FROM bookings WHERE package IS NOT NULL AND package<>'' ORDER BY package")]
    return {"statuses": STATUSES, "packages": list(dict.fromkeys(PACKAGES + pk))}


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
