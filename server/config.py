"""
Server configuration.

Settings are read with the precedence:  environment variable > config.ini > default.

The .ini file (repository root) holds local settings such as engine paths,
port, default language, and analysis limits.
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

KATAGO_PATH: str = _resolve(
    _get("katago", "katago_path", "KATAGO_PATH", r"C:\katago\katago.exe")
)
MODEL_PATH: str = _resolve(
    _get("katago", "model_path", "KATAGO_MODEL",
         r"C:\katago\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz")
)
CONFIG_PATH: str = _resolve(_get("katago", "config_path", "KATAGO_CONFIG",
                                 os.path.join("config", "default_analysis.cfg")))
KATAGO_WORK_DIR: str = _resolve(
    _get(
        "katago",
        "work_dir",
        "KATAGO_WORK_DIR",
        os.path.join(".runtime", "katago-work"),
    )
)
# Per-query response timeout (seconds).
KATAGO_MAX_WAIT: int = int(_get("katago", "max_wait", "KATAGO_MAX_WAIT", "300"))

# ── Server ───────────────────────────────────────────────────────────────────

PORT: int               = int(_get("server", "port", "PORT", "5000"))
DEFAULT_MAX_VISITS: int = int(_get("server", "default_max_visits", "DEFAULT_MAX_VISITS", "1000"))

# ── Internationalisation ──────────────────────────────────────────────────────

DEFAULT_LANGUAGE: str = _get("i18n", "default_language", "DEFAULT_LANGUAGE", "en")
AVAILABLE_LANGUAGES: list = [
    s.strip() for s in _get("i18n", "available_languages", None, "en, zh").split(",") if s.strip()
]

# A random value supplied only to a desktop-launched server. The desktop shell
# verifies this value before embedding the local page, so an unrelated process
# listening on localhost cannot be mistaken for this application.
DESKTOP_SESSION_TOKEN: str = _get(
    "desktop", "session_token", "KATAGO_HANDTALK_SESSION_TOKEN", ""
)

try:
    with open(os.path.join(_ROOT, "VERSION"), encoding="utf-8") as _version_file:
        APP_VERSION: str = _version_file.read().strip()
except OSError:
    APP_VERSION = "0.0.0-dev"
