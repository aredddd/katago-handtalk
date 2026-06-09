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

from flask import Flask
from flask_socketio import SocketIO
from flask_cors import CORS

from events import Events
from circuit_breaker import CircuitBreaker
from user_store import init_db
from engine_lifecycle import create_engine
from analysis_service import AnalysisService
from sockets import register_socket_handlers
from routes.pages import pages_bp
from routes.auth_routes import auth_bp
from routes.admin_routes import admin_bp
from routes.recognition import recognition_bp

logger = logging.getLogger(__name__)

# Circuit Breaker tuning: 3 consecutive failures → OPEN; 30 s before HALF_OPEN.
# Overridable via env so a demo can use a short timeout (e.g. CB_RESET_TIMEOUT=8).
CB_THRESHOLD = int(os.environ.get("CB_THRESHOLD", "3"))
CB_RESET_TIMEOUT = float(os.environ.get("CB_RESET_TIMEOUT", "30"))

# Demo-only fault injection (see demo_engine.py / routes/demo_routes.py).
# When enabled, the real KataGo engine is replaced by a FaultInjectingEngine
# whose failures can be toggled live to demonstrate the Circuit Breaker.
DEMO_FAULT_INJECTION = os.environ.get("CB_DEMO_FAULT_INJECTION", "").lower() in (
    "1", "true", "yes", "on",
)


def create_app():
    """Build and wire the application.  Returns (app, socketio)."""
    init_db()  # ensure the users table + built-in admin account exist

    static_folder = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
    )
    app = Flask(__name__, static_folder=static_folder, static_url_path="")
    app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "katago-web-secret-key")
    CORS(app)
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

    # ── Application-logic layer: engine + circuit breaker + service ──────────
    if DEMO_FAULT_INJECTION:
        from demo_engine import FaultInjectingEngine
        engine = FaultInjectingEngine()
        logger.warning("CB_DEMO_FAULT_INJECTION enabled — using FaultInjectingEngine (demo only)")
    else:
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
    )
    service = AnalysisService(engine, breaker)

    # Expose shared objects to blueprints (accessed via current_app.extensions).
    app.extensions["analysis_service"] = service
    app.extensions["engine"] = engine
    app.config["DEMO_FAULT_INJECTION"] = DEMO_FAULT_INJECTION

    # ── HTTP routes ─────────────────────────────────────────────────────────
    app.register_blueprint(pages_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(recognition_bp)
    if DEMO_FAULT_INJECTION:
        from routes.demo_routes import demo_bp
        app.register_blueprint(demo_bp)

    # ── WebSocket handlers ──────────────────────────────────────────────────
    register_socket_handlers(socketio, service)

    return app, socketio
