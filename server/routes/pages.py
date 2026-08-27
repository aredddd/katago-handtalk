"""
pages.py — static pages and system-information endpoints.

Routes:
  GET /                    main UI
  GET /api/status          engine + circuit breaker status
  GET /api/circuit-status  circuit breaker state only
  GET /api/config          client-facing config (default / available languages)
"""

from flask import Blueprint, current_app, send_from_directory, jsonify

from config import (
    APP_VERSION,
    AVAILABLE_LANGUAGES,
    DEFAULT_LANGUAGE,
    DESKTOP_SESSION_TOKEN,
    KATAGO_PATH,
    MODEL_PATH,
)

pages_bp = Blueprint("pages", __name__)


def _service():
    return current_app.extensions["analysis_service"]


@pages_bp.route("/")
def index():
    return send_from_directory(current_app.static_folder, "index.html")


@pages_bp.route("/api/status")
def api_status():
    return jsonify({
        # Stable marker used by the desktop launcher before it decides whether
        # an existing loopback service can be reused safely.
        "app":             "katago-web-beginner",
        "api_version":     1,
        "version":         APP_VERSION,
        "session_token":   DESKTOP_SESSION_TOKEN,
        "running":         _service().is_ready(),
        "katago_path":     KATAGO_PATH,
        "model_path":      MODEL_PATH,
        "circuit_breaker": _service().circuit_status(),
    })


@pages_bp.route("/api/circuit-status")
def api_circuit_status():
    """Current circuit breaker state (for polling / debug)."""
    return jsonify(_service().circuit_status())


@pages_bp.route("/api/config")
def api_config():
    """Client-facing configuration (default UI language, available languages)."""
    recognition_available = bool(
        current_app.extensions.get("board_recognizer_available")
    )
    recognition_reason = current_app.extensions.get("board_recognizer_reason")
    desktop = bool(DESKTOP_SESSION_TOKEN)
    return jsonify({
        "version":             APP_VERSION,
        "default_language":    DEFAULT_LANGUAGE,
        "available_languages": AVAILABLE_LANGUAGES,
        "capabilities": {
            "engine": {
                "available": _service().is_ready(),
            },
            "recognition": {
                "enabled": recognition_available,
                "available": recognition_available,
                "reason": recognition_reason,
                "configurable": desktop,
            },
            "desktop": {
                "bridge": desktop,
                "snipping": desktop,
                "topmost": desktop,
            },
            "live_review": {
                "available": recognition_available,
            },
        },
    })
