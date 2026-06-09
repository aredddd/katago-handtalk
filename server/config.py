"""
Server configuration.

Settings are read with the precedence:  environment variable > config.ini > default.

The .ini file (repository root) holds non-secret settings — paths, port, default
language, etc.  Secrets such as the JWT signing key are read from environment
variables only (see auth.py) and are deliberately absent from the .ini file.
"""

import os
import configparser

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_INI_PATH = os.path.join(_ROOT, "config.ini")

_parser = configparser.ConfigParser()
_parser.read(_INI_PATH, encoding="utf-8")


def _get(section: str, key: str, env: str | None, default: str) -> str:
    """Return env var if set, else the .ini value, else the default."""
    if env and os.environ.get(env) is not None:
        return os.environ[env]
    if _parser.has_option(section, key):
        return _parser.get(section, key)
    return default


def _resolve(path: str) -> str:
    """Resolve a possibly-relative path against the repository root."""
    return path if os.path.isabs(path) else os.path.join(_ROOT, path)


# ── KataGo engine ────────────────────────────────────────────────────────────

KATAGO_PATH: str = _get("katago", "katago_path", "KATAGO_PATH", r"C:\katago\katago.exe")
MODEL_PATH:  str = _get("katago", "model_path", "KATAGO_MODEL",
                        r"C:\katago\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz")
CONFIG_PATH: str = _resolve(_get("katago", "config_path", "KATAGO_CONFIG",
                                 os.path.join("config", "default_gtp.cfg")))
# Per-query response timeout (seconds). Default 300 s; lower it (e.g. 5) to make
# a hung-engine Circuit Breaker demo trip quickly. See TP2/demo-circuit-breaker.md.
KATAGO_MAX_WAIT: int = int(_get("katago", "max_wait", "KATAGO_MAX_WAIT", "300"))

# ── Server ───────────────────────────────────────────────────────────────────

PORT: int               = int(_get("server", "port", "PORT", "5000"))
DEFAULT_MAX_VISITS: int = int(_get("server", "default_max_visits", "DEFAULT_MAX_VISITS", "3000"))
QUICK_MAX_VISITS: int   = int(_get("server", "quick_max_visits", "QUICK_MAX_VISITS", "100"))

# ── Internationalisation ──────────────────────────────────────────────────────

DEFAULT_LANGUAGE: str = _get("i18n", "default_language", "DEFAULT_LANGUAGE", "en")
AVAILABLE_LANGUAGES: list = [
    s.strip() for s in _get("i18n", "available_languages", None, "en, zh").split(",") if s.strip()
]
