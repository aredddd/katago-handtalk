"""
admin_routes.py — admin panel API (all guarded by the require_admin Proxy).

Routes:
  GET    /api/admin/users             list users
  DELETE /api/admin/users/<username>  delete a user
  GET    /api/admin/settings          read settings
  PATCH  /api/admin/settings          update settings (registration toggle)
  POST   /api/admin/change-password   change the admin password
"""

import logging

from flask import Blueprint, request, jsonify

from auth import require_admin, current_username
from user_store import (
    delete_user, list_users, change_password, get_setting, set_setting,
)

logger = logging.getLogger(__name__)
admin_bp = Blueprint("admin", __name__)


@admin_bp.route("/api/admin/users", methods=["GET"])
@require_admin
def list_users_route():
    return jsonify({"users": list_users()})


@admin_bp.route("/api/admin/users/<username>", methods=["DELETE"])
@require_admin
def delete_user_route(username):
    ok, msg = delete_user(username)
    if ok:
        return jsonify({"message": msg})
    return jsonify({"error": msg}), 400


@admin_bp.route("/api/admin/settings", methods=["GET"])
@require_admin
def get_settings_route():
    return jsonify({
        "registration_open": get_setting("registration_open", "1") == "1",
    })


@admin_bp.route("/api/admin/settings", methods=["PATCH"])
@require_admin
def update_settings_route():
    body = request.get_json(silent=True) or {}
    if "registration_open" in body:
        set_setting("registration_open", "1" if body["registration_open"] else "0")
        logger.info(f"Registration {'opened' if body['registration_open'] else 'closed'} by admin")
    return jsonify({"message": "Settings updated"})


@admin_bp.route("/api/admin/change-password", methods=["POST"])
@require_admin
def change_password_route():
    body   = request.get_json(silent=True) or {}
    old_pw = body.get("old_password", "")
    new_pw = body.get("new_password", "")
    ok, msg = change_password(current_username(), old_pw, new_pw)
    if ok:
        return jsonify({"message": msg})
    return jsonify({"error": msg}), 400
