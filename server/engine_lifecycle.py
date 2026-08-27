"""
Engine lifecycle helpers.

Separates *creating* the KataGo engine (cheap, no subprocess) from *starting*
it (slow — spawns KataGo and waits for readiness). The factory creates the
engine so the rest of the app can hold a reference; the entry point starts it.
"""

import os
import logging
import threading
import time

from katago_engine import KataGoEngine
from config import KATAGO_PATH, MODEL_PATH, CONFIG_PATH, KATAGO_MAX_WAIT, KATAGO_WORK_DIR

logger = logging.getLogger(__name__)


def create_engine() -> KataGoEngine:
    """Instantiate the engine wrapper (does not start the subprocess)."""
    return KataGoEngine(
        KATAGO_PATH,
        MODEL_PATH,
        CONFIG_PATH,
        max_wait=KATAGO_MAX_WAIT,
        working_dir=KATAGO_WORK_DIR,
    )


def start_engine(engine: KataGoEngine) -> bool:
    """
    Verify the executable/model exist and start the KataGo subprocess.
    Returns True on success.
    """
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


def monitor_engine(
    engine: KataGoEngine,
    notify,
    stop_event,
    *,
    poll_interval: float = 1.0,
    initial_backoff: float = 2.0,
    max_backoff: float = 30.0,
    stable_window: float = 60.0,
    starter=None,
    lifecycle_lock=None,
) -> None:
    """Restart an unexpectedly exited KataGo process in the background.

    The monitor is intentionally single-threaded and reuses the existing
    engine wrapper.  ``stop_event`` is checked immediately before a restart so
    normal application shutdown cannot resurrect the engine.  Failed restart
    attempts use bounded exponential backoff.
    """
    start = starter or start_engine
    lock = lifecycle_lock or threading.Lock()
    backoff = max(0.0, initial_backoff)
    stable_since = time.monotonic()

    def safe_notify(running: bool) -> None:
        try:
            notify(running)
        except Exception:
            # A transient Socket.IO broadcast failure must not permanently
            # disable process recovery.
            logger.exception("Could not broadcast KataGo status")

    while not stop_event.wait(max(0.0, poll_interval)):
        if engine.is_running():
            if time.monotonic() - stable_since >= max(0.0, stable_window):
                backoff = max(0.0, initial_backoff)
            continue

        logger.warning("KataGo is unavailable; attempting automatic restart")
        safe_notify(False)
        if stop_event.is_set():
            return

        # A repeatedly crashing process backs off until it has stayed healthy
        # for ``stable_window`` seconds.  The first recovery remains quick.
        uptime = time.monotonic() - stable_since
        delay = backoff if uptime < max(0.0, stable_window) else 0.0
        if delay and stop_event.wait(delay):
            return

        with lock:
            if stop_event.is_set():
                return
            if engine.is_running():
                stable_since = time.monotonic()
                continue
            # Stop first even when poll() says the old process exited.  This
            # clears pending response queues before self.process is replaced.
            engine.stop()
            restarted = start(engine)
            if stop_event.is_set():
                engine.stop()
                return

        if restarted:
            logger.info("KataGo automatic restart succeeded")
            safe_notify(True)
            stable_since = time.monotonic()
            backoff = min(
                max_backoff,
                max(initial_backoff, backoff * 2 or 1.0),
            )
            continue

        backoff = min(max_backoff, max(initial_backoff, backoff * 2 or 1.0))
        logger.error("KataGo automatic restart failed; retrying in %.1f seconds", backoff)
