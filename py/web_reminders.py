"""Podsjetnici: rokovi koje korisnik sam upisuje (npr. liječnički pregled, umjeravanje vage, registracija vozila,
osiguranje, licenca, certifikat). Obavijest mjesec dana prije, tjedan dana prije i na dan isteka; nakon isteka
podsjetnik se obnovi na novi datum (povijest se čuva)."""
import datetime as dt

REPEATS = [[0, "Bez ponavljanja"], [1, "Svaki mjesec"], [3, "Svaka 3 mjeseca"], [6, "Svakih 6 mjeseci"],
           [12, "Svake godine"], [24, "Svake 2 godine"], [36, "Svake 3 godine"], [60, "Svakih 5 godina"]]


def ensure(db):
    db.con.executescript("""
    CREATE TABLE IF NOT EXISTS reminders(
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, person TEXT, due_date TEXT NOT NULL, repeat_months INTEGER DEFAULT 0,
        note TEXT, active INTEGER DEFAULT 1, created TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS reminder_log(
        id INTEGER PRIMARY KEY, reminder_id INTEGER, ts TEXT, user TEXT, old_due TEXT, new_due TEXT, note TEXT);
    """)
    db.con.commit()


def _user():
    try:
        import webapi
        return webapi.USER or None
    except Exception:  # noqa: BLE001
        return None


def add_months(iso, months):
    d = dt.date.fromisoformat(iso[:10])
    m = d.month - 1 + int(months)
    y, m = d.year + m // 12, m % 12 + 1
    last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).day
    return dt.date(y, m, min(d.day, last)).isoformat()


def stage(days):
    """Faza obavijesti prema broju dana do isteka: None (još daleko), 'month', 'week', 'today', 'late'."""
    if days < 0:
        return "late"
    if days == 0:
        return "today"
    if days <= 7:
        return "week"
    if days <= 30:
        return "month"
    return None


def message(r, days):
    t = r["title"] + (f" ({r['person']})" if r.get("person") else "")
    d = ".".join(reversed(r["due_date"][:10].split("-"))) + "."
    if days < 0:
        n = -days
        return f"{t} – isteklo je prije {n} {'dan' if n % 10 == 1 and n % 100 != 11 else 'dana'} ({d}). Obnovite podsjetnik na novi termin."
    if days == 0:
        return f"{t} – ističe DANAS ({d})."
    if days == 1:
        return f"{t} – ističe sutra ({d})."
    if days == 7:
        return f"{t} – ističe za tjedan dana ({d})."
    if days == 30:
        return f"{t} – ističe za mjesec dana ({d})."
    return f"{t} – ističe za {days} dana ({d})."


def reminders(db, include_inactive=False):
    ensure(db)
    today = dt.date.today()
    rows = db.q("SELECT * FROM reminders" + ("" if include_inactive else " WHERE COALESCE(active,1)=1") + " ORDER BY due_date, title")
    rep = dict((k, v) for k, v in REPEATS)
    for r in rows:
        days = (dt.date.fromisoformat(r["due_date"][:10]) - today).days
        r["days"] = days
        r["stage"] = stage(days)
        r["repeat"] = rep.get(int(r.get("repeat_months") or 0), f"svakih {r.get('repeat_months')} mj.")
        r["message"] = message(r, days)
        r["n_renew"] = db.val("SELECT COUNT(*) FROM reminder_log WHERE reminder_id=? AND old_due IS NOT NULL", (r["id"],)) or 0
    return rows


def due(db):
    """Za nadzornu ploču i obavijesti: sve što ističe u idućih 30 dana ili je već isteklo."""
    return [r for r in reminders(db) if r["stage"]]


def save_reminder(db, data, id=None):
    ensure(db)
    title = (data.get("title") or "").strip()
    if not title:
        raise ValueError("Upišite naziv podsjetnika.")
    if not data.get("due_date"):
        raise ValueError("Odaberite datum isteka.")
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    vals = (title, (data.get("person") or "").strip() or None, data["due_date"][:10], int(data.get("repeat_months") or 0),
            (data.get("note") or "").strip() or None)
    if id:
        old = db.one("SELECT due_date FROM reminders WHERE id=?", (id,))
        db.con.execute("UPDATE reminders SET title=?, person=?, due_date=?, repeat_months=?, note=?, updated=? WHERE id=?",
                       vals + (now, id))
        if old and old["due_date"] != vals[2]:
            db.con.execute("INSERT INTO reminder_log(reminder_id, ts, user, old_due, new_due, note) VALUES(?,?,?,?,?,?)",
                           (id, now, _user(), old["due_date"], vals[2], "promjena datuma"))
    else:
        id = db.con.execute("INSERT INTO reminders(title, person, due_date, repeat_months, note, active, created, updated) "
                            "VALUES(?,?,?,?,?,1,?,?)", vals + (now, now)).lastrowid
        db.con.execute("INSERT INTO reminder_log(reminder_id, ts, user, old_due, new_due, note) VALUES(?,?,?,?,?,?)",
                       (id, now, _user(), None, vals[2], "upisano"))
    db.con.commit()
    return id


def next_date(db, id):
    """Prijedlog novog datuma pri obnovi: datum isteka + ponavljanje (bez ponavljanja: + 1 godina)."""
    r = db.one("SELECT * FROM reminders WHERE id=?", (id,))
    months = int(r.get("repeat_months") or 0) or 12
    nd = add_months(r["due_date"], months)
    today = dt.date.today().isoformat()
    while nd <= today:  # davno istekao: prvi termin nakon današnjeg
        nd = add_months(nd, months)
    return nd


def renew(db, id, new_due, note=None):
    ensure(db)
    r = db.one("SELECT * FROM reminders WHERE id=?", (id,))
    if not r:
        raise ValueError("Podsjetnik ne postoji.")
    if not new_due:
        raise ValueError("Odaberite novi datum.")
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    db.con.execute("UPDATE reminders SET due_date=?, active=1, updated=? WHERE id=?", (new_due[:10], now, id))
    db.con.execute("INSERT INTO reminder_log(reminder_id, ts, user, old_due, new_due, note) VALUES(?,?,?,?,?,?)",
                   (id, now, _user(), r["due_date"], new_due[:10], (note or "").strip() or "obnovljeno"))
    db.con.commit()
    return True


def history(db, id):
    ensure(db)
    return db.q("SELECT * FROM reminder_log WHERE reminder_id=? ORDER BY id DESC", (id,))


def delete_reminder(db, id):
    ensure(db)
    db.con.execute("DELETE FROM reminder_log WHERE reminder_id=?", (id,))
    db.con.execute("DELETE FROM reminders WHERE id=?", (id,))
    db.con.commit()
    return True


def people(db):
    """Prijedlozi za polje „Odnosi se na”: zaposlenici, oprema i već upisani."""
    ensure(db)
    out = []
    for sql in ("SELECT name FROM employees ORDER BY name", "SELECT name FROM equipment WHERE COALESCE(active,1)=1 ORDER BY name",
                "SELECT DISTINCT person AS name FROM reminders WHERE person IS NOT NULL ORDER BY person"):
        try:
            out += [r["name"] for r in db.q(sql) if r["name"]]
        except Exception:  # noqa: BLE001
            pass
    seen = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def consts():
    return {"repeats": REPEATS}
