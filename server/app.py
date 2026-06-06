"""
KataGo Web Server — Flask + Socket.IO backend.
"""

import os
import sys
import logging
from typing import Optional

from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS

from katago_facade import KataGoFacade
from katago_engine import KataGoEngine
from noword_recognizer import recognize_board_noword, NOWORD_AVAILABLE
from config import (
    KATAGO_PATH, MODEL_PATH, CONFIG_PATH,
    PORT, DEFAULT_MAX_VISITS, QUICK_MAX_VISITS,
)
from events import Events
from exceptions import EngineNotRunningError, EngineTimeoutError, EngineQueryError

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Flask / Socket.IO setup ───────────────────────────────────────────────────

app = Flask(
    __name__,
    static_folder=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
    ),
    static_url_path="",
)
app.config["SECRET_KEY"] = "katago-web-secret-key"
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# Declared as KataGoFacade so the rest of the module depends on the
# interface, not the concrete KataGoEngine class.
engine: Optional[KataGoFacade] = None


def init_engine() -> bool:
    """Instantiate and start the KataGo engine.  Returns True on success."""
    global engine
    engine = KataGoEngine(KATAGO_PATH, MODEL_PATH, CONFIG_PATH)

    if not os.path.isfile(KATAGO_PATH):
        logger.error(f"KataGo executable not found: {KATAGO_PATH}")
        logger.error("Run setup.ps1 or download KataGo manually.")
        return False

    if not os.path.isfile(MODEL_PATH):
        logger.error(f"KataGo model not found: {MODEL_PATH}")
        logger.error("Run setup.ps1 or download the model weights manually.")
        return False

    if engine.start():
        logger.info("KataGo engine started successfully")
        return True

    logger.error("KataGo engine failed to start")
    return False


# ── HTTP routes ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "running":     engine.is_running() if engine else False,
        "katago_path": KATAGO_PATH,
        "model_path":  MODEL_PATH,
    })


@app.route("/api/recognize", methods=["POST"])
def api_recognize():
    """Board recognition via the noword CNN model."""
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    image_bytes = request.files["image"].read()
    board_size  = int(request.form.get("boardSize", 19))

    if not NOWORD_AVAILABLE:
        return jsonify({"error": "Board recognition model not found — "
                                 "check models/image2sgf/"}), 500

    logger.info("Running noword CNN board recognition")
    return jsonify(recognize_board_noword(image_bytes, board_size))


# ── WebSocket helpers ─────────────────────────────────────────────────────────

def _emit_engine_error(exc: Exception) -> None:
    """Map a KataGoError subclass to a user-facing Socket.IO error event."""
    if isinstance(exc, EngineNotRunningError):
        msg = "Engine is not running"
    elif isinstance(exc, EngineTimeoutError):
        msg = "Engine timed out — try again"
    elif isinstance(exc, EngineQueryError):
        msg = f"Engine error: {exc}"
    else:
        msg = f"Unexpected error: {exc}"
    emit(Events.ERROR, {"message": msg})


def _run_analysis(data: dict, default_max_visits: int) -> None:
    """Shared logic for the analyze and quick_analyze Socket.IO handlers."""
    if not engine or not engine.is_running():
        emit(Events.ERROR, {"message": "Engine is not running"})
        return

    moves          = data.get("moves", [])
    board_size     = data.get("boardSize", 19)
    komi           = data.get("komi", 7.5)
    max_visits     = data.get("maxVisits", default_max_visits)
    include_own    = data.get("includeOwnership", False)
    initial_stones = data.get("initialStones", None)
    initial_player = data.get("initialPlayer", None)

    logger.info(f"Analysis request: {len(moves)} moves, "
                f"initialStones={len(initial_stones) if initial_stones else 0}, "
                f"initialPlayer={initial_player}, visits={max_visits}")

    try:
        result = engine.analyze_position(
            moves=moves,
            board_size=board_size,
            komi=komi,
            max_visits=max_visits,
            include_ownership=include_own,
            initial_stones=initial_stones,
            initial_player=initial_player,
        )
        emit(Events.ANALYSIS, result)
    except (EngineNotRunningError, EngineTimeoutError, EngineQueryError) as exc:
        logger.warning(f"Analysis failed: {exc}")
        _emit_engine_error(exc)


# ── WebSocket event handlers ──────────────────────────────────────────────────

@socketio.on("connect")
def handle_connect():
    logger.info(f"Client connected: {request.sid}")
    emit(Events.STATUS, {"running": engine.is_running() if engine else False})


@socketio.on("disconnect")
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")


@socketio.on(Events.ANALYZE)
def handle_analyze(data):
    """Full analysis — data: {moves, boardSize, komi, maxVisits, includeOwnership,
    initialStones, initialPlayer}"""
    _run_analysis(data, DEFAULT_MAX_VISITS)


@socketio.on(Events.QUICK_ANALYZE)
def handle_quick_analyze(data):
    """Fast analysis with fewer visits (default QUICK_MAX_VISITS)."""
    _run_analysis(data, QUICK_MAX_VISITS)


@socketio.on(Events.PLAY_AI)
def handle_play_ai(data):
    """Ask the AI for the next move — data: {moves, boardSize, komi, maxVisits,
    initialStones, initialPlayer}"""
    if not engine or not engine.is_running():
        emit(Events.ERROR, {"message": "Engine is not running"})
        return

    moves          = data.get("moves", [])
    board_size     = data.get("boardSize", 19)
    komi           = data.get("komi", 7.5)
    max_visits     = data.get("maxVisits", 800)
    initial_stones = data.get("initialStones", None)
    initial_player = data.get("initialPlayer", None)

    try:
        result = engine.analyze_position(
            moves=moves,
            board_size=board_size,
            komi=komi,
            max_visits=max_visits,
            initial_stones=initial_stones,
            initial_player=initial_player,
        )
    except (EngineNotRunningError, EngineTimeoutError, EngineQueryError) as exc:
        logger.warning(f"play_ai failed: {exc}")
        _emit_engine_error(exc)
        return

    if result and result.get("moves"):
        best_move      = result["moves"][0]
        current_player = result["currentPlayer"]
        emit(Events.AI_MOVE, {
            "move":      best_move["move"],
            "color":     current_player,
            "winrate":   best_move["winrate"],
            "scoreLead": best_move["scoreLead"],
            "visits":    best_move["visits"],
            "pv":        best_move["pv"],
        })
    else:
        emit(Events.ERROR, {"message": "AI could not generate a move"})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  KataGo Web Server")
    print("=" * 60)
    print(f"  KataGo : {KATAGO_PATH}")
    print(f"  Model  : {MODEL_PATH}")
    print(f"  Config : {CONFIG_PATH}")
    print(f"  Port   : {PORT}")
    print(f"  Vision : {'noword CNN available' if NOWORD_AVAILABLE else 'model not found'}")
    print("=" * 60)

    if init_engine():
        print(f"\n  Server running at http://localhost:{PORT}\n")
        socketio.run(app, host="0.0.0.0", port=PORT, debug=False)
    else:
        print("\n  Engine failed to start — check configuration paths.")
        print("  Run setup.ps1 for automatic setup.")
        sys.exit(1)
