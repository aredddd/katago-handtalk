"""
Engine lifecycle helpers.

Separates *creating* the KataGo engine (cheap, no subprocess) from *starting*
it (slow — spawns KataGo and waits for readiness). The factory creates the
engine so the rest of the app can hold a reference; the entry point starts it.
"""

import os
import logging

from katago_engine import KataGoEngine
from config import KATAGO_PATH, MODEL_PATH, CONFIG_PATH, KATAGO_MAX_WAIT

logger = logging.getLogger(__name__)


def create_engine() -> KataGoEngine:
    """Instantiate the engine wrapper (does not start the subprocess)."""
    return KataGoEngine(KATAGO_PATH, MODEL_PATH, CONFIG_PATH, max_wait=KATAGO_MAX_WAIT)


def start_engine(engine: KataGoEngine) -> bool:
    """
    Verify the executable/model exist and start the KataGo subprocess.
    Returns True on success.
    """
    # Demo-only fault-injection engine: no real subprocess to start.
    if getattr(engine, "demo_mode", False):
        logger.warning("[DEMO] fault-injection engine — skipping real KataGo startup")
        return engine.start()
    if not os.path.isfile(KATAGO_PATH):
        logger.error(f"KataGo executable not found: {KATAGO_PATH}")
        return False
    if not os.path.isfile(MODEL_PATH):
        logger.error(f"KataGo model not found: {MODEL_PATH}")
        return False
    if engine.start():
        logger.info("KataGo engine started successfully")
        return True
    logger.error("KataGo engine failed to start")
    return False
