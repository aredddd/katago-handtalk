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
from auth import (
    init_db, register_user, verify_user, create_token, require_auth,
    require_admin, delete_user, list_users, change_password,
    get_setting, set_setting, decode_token, get_user_is_admin,
)

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

engine: Optional[KataGoFacade] = None


def init_engine() -> bool:
    """Instantiate and start the KataGo engine.  Returns True on success."""
    global engine
    engine = KataGoEngine(KATAGO_PATH, MODEL_PATH, CONFIG_PATH)

    if not os.path.isfile(KATAGO_PATH):
        logger.error(f"KataGo executable not found: {KATAGO_PATH}")
        return False
    if not os.path.isfile(MODEL_PATH):
        logger.error(f"KataGo model not found: {MODEL_PATH}")
        return False

    if engine.start():
        logger.info("KataGo engine started successfully")
        return True

    logger.error("KataGo engine failed to start")
    return False


# ── HTTP routes — public ──────────────────────────────────────────────────────

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


@app.route("/api/register", methods=["POST"])
def api_register():
    """Create a new user account."""
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")
    ok, msg = register_user(username, password)
    if ok:
        token = create_token(username)
        return jsonify({
            "token":    token,
            "username": username,
            "is_admin": get_user_is_admin(username),
        }), 201
    return jsonify({"error": msg}), 400


@app.route("/api/login", methods=["POST"])
def api_login():
    """Authenticate and return a JWT."""
    body = request.get_json(silent=True) or {}
    username = body.get("username", "").strip()
    password = body.get("password", "")
    if verify_user(username, password):
        token = create_token(username)
        return jsonify({
            "token":    token,
            "username": username,
            "is_admin": get_user_is_admin(username),
        })
    return jsonify({"error": "Invalid username or password"}), 401


# ── HTTP routes — admin panel ─────────────────────────────────────────────────

@app.route("/admin")
def admin_page():
    """Serve the admin panel HTML."""
    return send_from_directory(app.static_folder, "admin.html")


@app.route("/api/admin/users", methods=["GET"])
@require_admin
def api_admin_list_users():
    """List all users."""
    return jsonify({"users": list_users()})


@app.route("/api/admin/users/<username>", methods=["DELETE"])
@require_admin
def api_admin_delete_user(username):
    """Delete a user account."""
    ok, msg = delete_user(username)
    if ok:
        return jsonify({"message": msg})
    return jsonify({"error": msg}), 400


@app.route("/api/admin/settings", methods=["GET"])
@require_admin
def api_admin_get_settings():
    """Return current admin-controlled settings."""
    return jsonify({
        "registration_open": get_setting("registration_open", "1") == "1",
    })


@app.route("/api/admin/settings", methods=["PATCH"])
@require_admin
def api_admin_update_settings():
    """Update admin-controlled settings."""
    body = request.get_json(silent=True) or {}
    if "registration_open" in body:
        set_setting("registration_open", "1" if body["registration_open"] else "0")
        logger.info(f"Registration {'opened' if body['registration_open'] else 'closed'} by admin")
    return jsonify({"message": "Settings updated"})


@app.route("/api/admin/change-password", methods=["POST"])
@require_admin
def api_admin_change_password():
    """Change the admin account password."""
    body     = request.get_json(silent=True) or {}
    old_pw   = body.get("old_password", "")
    new_pw   = body.get("new_password", "")
    username = decode_token(request.headers.get("Authorization", "")[7:])
    ok, msg  = change_password(username, old_pw, new_pw)
    if ok:
        return jsonify({"message": msg})
    return jsonify({"error": msg}), 400


# ── HTTP routes — board recognition ──────────────────────────────────────────

@app.route("/api/recognize", methods=["POST"])
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


# ── WebSocket helpers ─────────────────────────────────────────────────────────

def _emit_engine_error(exc: Exception) -> None:
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
    """Shared logic for the analyze and quick_analyze handlers."""
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

    logger.info(f"Analysis: {len(moves)} moves, visits={max_visits}")

    try:
        result = engine.analyze_position(
            moves=moves, board_size=board_size, komi=komi,
            max_visits=max_visits, include_ownership=include_own,
            initial_stones=initial_stones, initial_player=initial_player,
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
@require_auth
def handle_analyze(data):
    """Full analysis (Proxy: require_auth verifies JWT before reaching here)."""
    _run_analysis(data, DEFAULT_MAX_VISITS)


@socketio.on(Events.QUICK_ANALYZE)
@require_auth
def handle_quick_analyze(data):
    """Fast analysis — fewer visits (Proxy: require_auth guards this handler)."""
    _run_analysis(data, QUICK_MAX_VISITS)


@socketio.on(Events.PLAY_AI)
@require_auth
def handle_play_ai(data):
    """AI move request (Proxy: require_auth guards this handler)."""
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
            moves=moves, board_size=board_size, komi=komi,
            max_visits=max_visits,
            initial_stones=initial_stones, initial_player=initial_player,
        )
    except (EngineNotRunningError, EngineTimeoutError, EngineQueryError) as exc:
        logger.warning(f"play_ai failed: {exc}")
        _emit_engine_error(exc)
        return

    if result and result.get("moves"):
        best_move = result["moves"][0]
        emit(Events.AI_MOVE, {
            "move":      best_move["move"],
            "color":     result["currentPlayer"],
            "winrate":   best_move["winrate"],
            "scoreLead": best_move["scoreLead"],
            "visits":    best_move["visits"],
            "pv":        best_move["pv"],
        })
    else:
        emit(Events.ERROR, {"message": "AI could not generate a move"})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()   # ensure users table exists before accepting requests

    print("=" * 60)
    print("  KataGo Web Server")
    print("=" * 60)
    print(f"  KataGo : {KATAGO_PATH}")
    print(f"  Model  : {MODEL_PATH}")
    print(f"  Port   : {PORT}")
    print(f"  Vision : {'noword CNN available' if NOWORD_AVAILABLE else 'model not found'}")
    print("=" * 60)

    if init_engine():
        print(f"\n  Server running at http://localhost:{PORT}\n")
        socketio.run(app, host="0.0.0.0", port=PORT, debug=False)
    else:
        print("\n  Engine failed to start — check configuration paths.")
        sys.exit(1)
