"""
app_factory.py — application factory.

create_app() builds the Flask app and Socket.IO server, wires the
application-logic layer (KataGo engine + Circuit Breaker + AnalysisService),
registers the HTTP blueprints and the Socket.IO handlers, and returns
(app, socketio).  No work happens at import time and there are no module-level
globals — everything is created inside the factory.
"""

import os
import logging
from typing import Callable, Optional

from flask import Flask, jsonify
from flask_socketio import SocketIO
from werkzeug.exceptions import RequestEntityTooLarge

from events import Events
from circuit_breaker import CircuitBreaker
from exceptions import EngineQueryError
from engine_lifecycle import create_engine
from analysis_service import AnalysisService
from sockets import register_socket_handlers
from routes.pages import pages_bp
from routes.recognition import recognition_bp
from routes.practice import practice_bp
from config import PRACTICE_PROGRESS_PATH
from practice_progress import PracticeProgressStore

logger = logging.getLogger(__name__)

# Circuit Breaker tuning: 3 consecutive engine failures → OPEN; then retry.
CB_THRESHOLD = int(os.environ.get("CB_THRESHOLD", "3"))
CB_RESET_TIMEOUT = float(os.environ.get("CB_RESET_TIMEOUT", "30"))
MAX_SCREENSHOT_BYTES = int(os.environ.get("MAX_SCREENSHOT_BYTES", str(16 * 1024 * 1024)))


def _load_recognition_backend():
    """Load the optional vision stack without making it a core dependency."""
    enabled = os.environ.get("KATAGO_VISION_ENABLED", "auto").strip().lower()
    if enabled in {"0", "false", "no", "off", "disabled"}:
        return None, None, False, "disabled"
    try:
        from vision_recognizer import (
            is_available,
            recognize_board_image,
            warm_up_recognizer,
        )
    except (ImportError, OSError) as exc:
        logger.info("Screenshot recognition unavailable: %s", exc)
        return None, None, False, "dependencies_missing"
    if not is_available():
        return recognize_board_image, warm_up_recognizer, False, "models_missing"
    return recognize_board_image, warm_up_recognizer, True, None

def create_app(
    *,
    engine=None,
    recognizer: Optional[Callable] = None,
    recognizer_available: Optional[bool] = None,
    practice_progress_path: Optional[str] = None,
    socketio_async_mode: str = "threading",
):
    """
    Build and wire the local application.  Returns ``(app, socketio)``.

    The optional dependencies make the factory cheap to exercise in tests and
    allow another local capture source to reuse the same recognition endpoint.
    Authentication and user persistence are intentionally absent: this build
    is a single-user application bound to the owner's machine.
    """
    static_folder = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
    )
    app = Flask(__name__, static_folder=static_folder, static_url_path="")
    app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "katago-web-secret-key")
    # Recognition is local but still reachable by any browser page on the same
    # machine. Bound multipart parsing before model code ever sees the upload.
    app.config["MAX_CONTENT_LENGTH"] = MAX_SCREENSHOT_BYTES

    @app.errorhandler(RequestEntityTooLarge)
    def screenshot_too_large(_exc):
        limit_mb = MAX_SCREENSHOT_BYTES // (1024 * 1024)
        return jsonify({
            "error": f"Screenshot is too large (maximum {limit_mb} MB)"
        }), 413
    socketio = SocketIO(
        app,
        async_mode=socketio_async_mode,
    )

    # ── Application-logic layer: engine + circuit breaker + service ──────────
    if engine is None:
        engine = create_engine()

    def on_cb_state_change(old_state, new_state):
        """Broadcast circuit breaker state changes to all connected clients."""
        socketio.emit(Events.CIRCUIT_STATUS, {
            "state": new_state.value,
            "old":   old_state.value,
        })

    breaker = CircuitBreaker(
        threshold=CB_THRESHOLD,
        reset_timeout=CB_RESET_TIMEOUT,
        on_state_change=on_cb_state_change,
        excluded_exceptions=(EngineQueryError,),
    )
    service = AnalysisService(engine, breaker)

    # Expose shared objects to blueprints (accessed via current_app.extensions).
    app.extensions["analysis_service"] = service
    app.extensions["engine"] = engine
    backend, warmup, backend_available, unavailable_reason = _load_recognition_backend()
    app.extensions["board_recognizer"] = recognizer or backend
    app.extensions["board_recognizer_warmup"] = warmup
    app.extensions["board_recognizer_available"] = (
        backend_available if recognizer_available is None else bool(recognizer_available)
    )
    app.extensions["board_recognizer_reason"] = (
        None if app.extensions["board_recognizer_available"] else unavailable_reason
    )
    app.extensions["practice_progress_store"] = PracticeProgressStore(
        practice_progress_path or PRACTICE_PROGRESS_PATH
    )
    # ── HTTP routes ─────────────────────────────────────────────────────────
    app.register_blueprint(pages_bp)
    app.register_blueprint(recognition_bp)
    app.register_blueprint(practice_bp)

    # ── WebSocket handlers ──────────────────────────────────────────────────
    register_socket_handlers(socketio, service)

    return app, socketio
