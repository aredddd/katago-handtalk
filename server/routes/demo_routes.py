"""
demo_routes.py — DEMO-ONLY endpoints.

Registered by app_factory **only** when CB_DEMO_FAULT_INJECTION is set. They let
a presenter toggle engine failures live to demonstrate the Circuit Breaker on
the web UI. Because the whole feature is gated behind a non-production flag, the
toggle is intentionally unauthenticated for a frictionless live demo. Never
enabled in production.

  GET  /api/demo/engine-fault          -> {"fault": bool}
  POST /api/demo/engine-fault {on}     -> set/toggle fault, returns {"fault": bool}
"""

from flask import Blueprint, current_app, request, jsonify

demo_bp = Blueprint("demo", __name__)


def _engine():
    return current_app.extensions.get("engine")


@demo_bp.route("/api/demo/engine-fault", methods=["GET"])
def get_fault():
    eng = _engine()
    return jsonify({"fault": bool(getattr(eng, "fault", False))})


@demo_bp.route("/api/demo/engine-fault", methods=["POST"])
def set_fault():
    eng = _engine()
    if not hasattr(eng, "set_fault"):
        return jsonify({"error": "demo engine not active"}), 400
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on", not eng.fault))  # toggle when 'on' is omitted
    eng.set_fault(on)
    return jsonify({"fault": eng.fault})
