"""Local HTTP API for beginner practice progress."""

import json
from pathlib import Path
from urllib.parse import urlsplit

from flask import Blueprint, current_app, jsonify, request

from practice_progress import InvalidProgress, ProgressStoreUnavailable


practice_bp = Blueprint("practice", __name__)


def _store():
    return current_app.extensions["practice_progress_store"]


def _same_loopback_origin():
    origin = request.headers.get("Origin")
    if not origin:
        return True
    parsed = urlsplit(origin)
    return (
        parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.netloc.lower() == request.host.lower()
    )


def _problem_ids():
    cached = current_app.extensions.get("practice_problem_ids")
    if cached is not None:
        return cached
    manifest_path = Path(current_app.static_folder) / "problems" / "manifest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        identifiers = {
            item["id"]
            for item in payload.get("problems", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        identifiers = set()
    current_app.extensions["practice_problem_ids"] = identifiers
    return identifiers


@practice_bp.get("/api/practice-progress")
def get_practice_progress():
    try:
        return jsonify(_store().load())
    except ProgressStoreUnavailable as exc:
        return jsonify({
            "error": str(exc),
            "code": "practice_progress_unreadable",
        }), 409


@practice_bp.put("/api/practice-progress/<problem_id>")
def put_practice_progress(problem_id: str):
    if not _same_loopback_origin():
        return jsonify({"error": "Cross-origin progress writes are not allowed"}), 403
    if problem_id not in _problem_ids():
        return jsonify({"error": "Unknown practice problem"}), 404
    try:
        record = _store().update(problem_id, request.get_json(silent=True))
    except InvalidProgress as exc:
        return jsonify({"error": str(exc), "code": "invalid_practice_progress"}), 400
    except ProgressStoreUnavailable as exc:
        return jsonify({
            "error": str(exc),
            "code": "practice_progress_unreadable",
        }), 409
    return jsonify({"problem_id": problem_id, "record": record})
