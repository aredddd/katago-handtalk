"""
recognition.py — board recognition from a photo via the noword CNN model.

Routes:
  POST /api/recognize   upload an image, return the recognized board
"""

import logging
from urllib.parse import urlsplit

from flask import Blueprint, current_app, request, jsonify

from noword_recognizer import board_to_initial_stones

logger = logging.getLogger(__name__)
recognition_bp = Blueprint("recognition", __name__)


@recognition_bp.route("/api/recognize", methods=["POST"])
def api_recognize():
    """Recognize one uploaded board frame and return an analysis-ready position."""
    origin = request.headers.get("Origin")
    if origin:
        parsed = urlsplit(origin)
        local_names = {"127.0.0.1", "localhost", "::1"}
        if (parsed.hostname not in local_names or
                parsed.netloc.lower() != request.host.lower()):
            return jsonify({"error": "Cross-origin recognition is not allowed"}), 403

    try:
        board_size = int(request.form.get("boardSize", 19))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid boardSize"}), 400
    if board_size != 19:
        return jsonify({"error": "Screenshot recognition currently supports 19x19 only"}), 400

    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    image_bytes = request.files["image"].read()
    if not image_bytes:
        return jsonify({"error": "Uploaded image is empty"}), 400

    if not current_app.extensions["board_recognizer_available"]:
        return jsonify({"error": "Board recognition model not found"}), 500

    logger.info("Running noword CNN board recognition")
    recognizer = current_app.extensions["board_recognizer"]
    try:
        result = recognizer(image_bytes, board_size)
    except Exception as exc:
        logger.exception("Board recognition failed")
        return jsonify({"error": f"Board recognition failed: {exc}"}), 422

    if not isinstance(result, dict):
        logger.error("Board recognizer returned a non-object result")
        return jsonify({"error": "Board recognition returned an invalid result"}), 500

    # Keep the matrix used by the existing preview/correction UI and also
    # expose exactly the fields accepted by AnalysisParams/KataGo.  This makes
    # the endpoint reusable for screenshots, camera snapshots, or periodic
    # HTTP uploads without duplicating coordinate conversion in every client.
    board = result.get("board")
    if board and not result.get("error"):
        try:
            result.setdefault("boardSize", len(board))
            result.setdefault("initialStones", board_to_initial_stones(board))
        except (TypeError, ValueError) as exc:
            logger.error("Board recognizer returned an invalid matrix: %s", exc)
            return jsonify({"error": f"Invalid recognized board: {exc}"}), 422

    return jsonify(result)
