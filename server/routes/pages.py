"""
pages.py — static pages and system-information endpoints.

Routes:
  GET /                    main UI
  GET /admin               admin panel UI
  GET /api/status          engine + circuit breaker status
  GET /api/circuit-status  circuit breaker state only
  GET /api/config          client-facing config (default / available languages)
"""

from flask import Blueprint, current_app, send_from_directory, jsonify

from config import KATAGO_PATH, MODEL_PATH, DEFAULT_LANGUAGE, AVAILABLE_LANGUAGES

pages_bp = Blueprint("pages", __name__)


def _service():
    return current_app.extensions["analysis_service"]


@pages_bp.route("/")
def index():
    return send_from_directory(current_app.static_folder, "index.html")


@pages_bp.route("/admin")
def admin_page():
    return send_from_directory(current_app.static_folder, "admin.html")


@pages_bp.route("/api/status")
def api_status():
    return jsonify({
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
    return jsonify({
        "default_language":    DEFAULT_LANGUAGE,
        "available_languages": AVAILABLE_LANGUAGES,
        "demo_fault_injection": current_app.config.get("DEMO_FAULT_INJECTION", False),
    })
