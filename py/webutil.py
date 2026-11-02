"""Pomoćne funkcije bez grafičkog sučelja (web verzija)."""
import os
import re
import datetime as dt

from db import EPS, today  # noqa: F401

def data_dir():
    base = os.path.join(os.path.expanduser("~"), "Documents", "PivovaraSkladiste")
    os.makedirs(base, exist_ok=True)
    return base


# ------------------------------------------------------------------ pomoćne funkcije
def d2ui(iso):
    if not iso:
        return ""
    try:
        y, m, d = iso[:10].split("-")
        return f"{d}.{m}.{y}."
    except ValueError:
        return iso


def ui2d(s):
    s = (s or "").strip().rstrip(".")
    if not s:
        return None
    for f in ("%d.%m.%Y", "%Y-%m-%d", "%d.%m.%y", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(s, f).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"Neispravan datum: '{s}' (koristite DD.MM.GGGG.)")


def num(s):
    s = str(s if s is not None else "").strip().replace(" ", "")
    if not s:
        return 0.0
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    return float(s)


def fq(x, dec=3):
    """Format broja na hrvatski način (1.234,5)."""
    if x is None or x == "":
        return ""
    s = f"{float(x):,.{dec}f}"
    if dec:
        s = s.rstrip("0").rstrip(".")
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def money(x):
    return f"{float(x or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " €"


def fin(x):
    """Broj za polje za unos (bez separatora tisućica)."""
    if x is None or x == "":
        return ""
    return f"{float(x):.4f}".rstrip("0").rstrip(".").replace(".", ",")


def days_left(iso):
    if not iso:
        return None
    return (dt.date.fromisoformat(iso) - dt.date.today()).days


_DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})\.?$")


def sort_key(v):
    v = str(v)
    m = _DATE_RE.match(v)
    if m:
        return (0, f"{m.group(3)}{m.group(2)}{m.group(1)}")
    try:
        return (1, float(v.replace(" €", "").split(" ")[0].replace(".", "").replace(",", ".")))
    except ValueError:
        return (2, v.lower())


