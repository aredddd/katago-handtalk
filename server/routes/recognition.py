"""
recognition.py — board recognition from a photo via the noword CNN model.

Routes:
  POST /api/recognize   upload an image, return the recognized board
"""

import logging

from flask import Blueprint, request, jsonify

from noword_recognizer import recognize_board_noword, NOWORD_AVAILABLE

logger = logging.getLogger(__name__)
recognition_bp = Blueprint("recognition", __name__)


@recognition_bp.route("/api/recognize", methods=["POST"])
def api_recognize():
    """Board recognition via the noword CNN model."""
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    image_bytes = request.files["image"].read()
    board_size  = int(request.form.get("boardSize", 19))

    if not NOWORD_AVAILABLE:
        return jsonify({"error": "Board recognition model not found"}), 500

    logger.info("Running noword CNN board recognition")
    return jsonify(recognize_board_noword(image_bytes, board_size))
