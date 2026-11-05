"""Most između web sučelja (JavaScript) i postojeće logike programa (Python u pregledniku, Pyodide).

JavaScript poziva call("db.items", "[]") ili call("modul.funkcija", "[...]").
- "db.<metoda>"      -> metoda baze (DB) s argumentima
- "<modul>.<funkcija>" -> funkcija modula; prvi argument joj je uvijek baza (db), a ako
                        ima parametar 'app', dobiva i objekt s putanjama do loga.
Rezultat je JSON: {"ok": true, "result": ..., "changed": true/false} ili {"ok": false, "error": "..."}.
"""
import os
import json
import inspect
import importlib
import datetime as dt
import traceback

from db import DB

DB_ = None
USER = ""
DATA = os.path.join(os.path.expanduser("~"), "Documents", "PivovaraSkladiste")
OUT = "/out"


class App:
    """Zamjena za glavni prozor desktop programa (samo ono što koriste ispisi)."""

    def logo_path(self):
        p = os.path.join(DATA, "logo.png")
        return p if os.path.exists(p) else None

    def app_logo_path(self, fallback=True):
        p = os.path.join(DATA, "logo_app.png")
        return p if os.path.exists(p) else (self.logo_path() if fallback else None)

    def toast(self, *a, **k):
        pass


APP = App()


def set_user(name):
    """Ime prijavljenog korisnika / radnika na uređaju – upisuje se u povijest promjena."""
    global USER
    USER = name or ""
    return True


def open_db(path):
    global DB_
    if DB_ is not None:
        try:
            DB_.con.close()
        except Exception:  # noqa: BLE001
            pass
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    DB_ = DB(path)
    try:
        import web_kegs
        web_kegs.ensure(DB_)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    try:
        import web_offers
        web_offers.ensure(DB_)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    try:
        import web_more
        web_more.ensure(DB_)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    try:
        import web_costs
        web_costs.ensure(DB_)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    return True


def close_db():
    global DB_
    if DB_ is not None:
        DB_.con.commit()
        DB_.con.close()
        DB_ = None


def flush():
    if DB_ is not None:
        DB_.con.commit()
        try:  # sažmi bazu kad se nakupi puno praznog prostora (manja datoteka = brže spremanje na GitHub)
            free = DB_.con.execute("PRAGMA freelist_count").fetchone()[0]
            pages = DB_.con.execute("PRAGMA page_count").fetchone()[0]
            if free > 64 and free > pages * 0.2:
                DB_.con.execute("VACUUM")
        except Exception:  # noqa: BLE001
            pass


def _default(o):
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    if isinstance(o, (set, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return None
    return str(o)


def call(name, args_json="[]", kwargs_json="{}"):
    try:
        args = json.loads(args_json or "[]")
        kwargs = json.loads(kwargs_json or "{}")
        before = DB_.con.total_changes if DB_ is not None else 0
        if name.startswith("db."):
            fn = getattr(DB_, name[3:])
            res = fn(*args, **kwargs)
        else:
            mod, f = name.rsplit(".", 1)
            fn = getattr(importlib.import_module(mod), f)
            try:
                params = inspect.signature(fn).parameters
            except (TypeError, ValueError):
                params = {}
            if "app" in params and "app" not in kwargs:
                kwargs["app"] = APP
            res = fn(DB_, *args, **kwargs) if params and list(params)[0] == "db" else fn(*args, **kwargs)
        changed = DB_ is not None and DB_.con.total_changes != before
        if changed:
            try:
                import web_more
                web_more.log_change(DB_, USER, name, args, kwargs)
            except Exception:  # noqa: BLE001
                pass
            DB_.con.commit()
        return json.dumps({"ok": True, "result": res, "changed": changed}, default=_default)
    except Exception as e:  # noqa: BLE001
        changed = False
        try:
            if DB_ is not None:
                changed = DB_.con.total_changes != before
                DB_.con.commit()
        except Exception:  # noqa: BLE001
            pass
        return json.dumps({"ok": False, "error": str(e) or type(e).__name__, "type": type(e).__name__,
                           "trace": traceback.format_exc()[-2000:], "changed": changed})
