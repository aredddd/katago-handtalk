"""
Server configuration — all environment-variable-backed settings in one place.
"""

import os

# ── KataGo engine ────────────────────────────────────────────────────────────

KATAGO_PATH: str = os.environ.get(
    "KATAGO_PATH",
    r"C:\katago\katago.exe",
)

MODEL_PATH: str = os.environ.get(
    "KATAGO_MODEL",
    r"C:\katago\kata1-b18c384nbt-s9996604416-d4316597426.bin.gz",
)

CONFIG_PATH: str = os.environ.get(
    "KATAGO_CONFIG",
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config",
        "default_gtp.cfg",
    ),
)

# ── Server ───────────────────────────────────────────────────────────────────

PORT: int = int(os.environ.get("PORT", 5000))

DEFAULT_MAX_VISITS: int = int(os.environ.get("DEFAULT_MAX_VISITS", 3000))
QUICK_MAX_VISITS: int = int(os.environ.get("QUICK_MAX_VISITS", 100))
