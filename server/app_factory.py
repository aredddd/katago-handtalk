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
from noword_recognizer import recognize_board_noword, is_available as recognition_is_available

logger = logging.getLogger(__name__)

# Circuit Breaker tuning: 3 consecutive engine failures → OPEN; then retry.
CB_THRESHOLD = int(os.environ.get("CB_THRESHOLD", "3"))
CB_RESET_TIMEOUT = float(os.environ.get("CB_RESET_TIMEOUT", "30"))
MAX_SCREENSHOT_BYTES = int(os.environ.get("MAX_SCREENSHOT_BYTES", str(16 * 1024 * 1024)))

def create_app(
    *,
    engine=None,
    recognizer: Optional[Callable] = None,
    recognizer_available: Optional[bool] = None,
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
    app.extensions["board_recognizer"] = recognizer or recognize_board_noword
    app.extensions["board_recognizer_available"] = (
        recognition_is_available()
        if recognizer_available is None
        else bool(recognizer_available)
    )
    # ── HTTP routes ─────────────────────────────────────────────────────────
    app.register_blueprint(pages_bp)
    app.register_blueprint(recognition_bp)

    # ── WebSocket handlers ──────────────────────────────────────────────────
    register_socket_handlers(socketio, service)

    return app, socketio
