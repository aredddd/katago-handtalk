"""
auth_routes.py — account creation and sign-in.

Routes:
  POST /api/register   create an account, return a JWT
  POST /api/login      verify credentials, return a JWT
"""

from flask import Blueprint, request, jsonify

from user_store import register_user, verify_user, get_user_is_admin
from auth import create_token

auth_bp = Blueprint("auth", __name__)


def _token_response(username: str, status: int = 200):
    return jsonify({
        "token":    create_token(username),
        "username": username,
        "is_admin": get_user_is_admin(username),
    }), status


@auth_bp.route("/api/register", methods=["POST"])
def api_register():
    """Create a new user account."""
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")
    ok, msg = register_user(username, password)
    if ok:
        return _token_response(username, 201)
    return jsonify({"error": msg}), 400


@auth_bp.route("/api/login", methods=["POST"])
def api_login():
    """Authenticate and return a JWT."""
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")
    if verify_user(username, password):
        return _token_response(username)
    return jsonify({"error": "Invalid username or password"}), 401
