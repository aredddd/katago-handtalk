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
from exceptions import (
    EngineNotRunningError, EngineTimeoutError, EngineQueryError,
    AuthenticationError,
)
from user_store import (
    init_db, register_user, verify_user, delete_user, list_users,
    change_password, get_setting, set_setting, get_user_is_admin,
)
from auth import create_token, decode_token, require_auth, require_admin
from circuit_breaker import CircuitBreakerBase, CircuitBreaker, CircuitOpenError

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

# Tracks the latest in-flight analysis query id per connected client (sid).
# When a client sends a new analysis request, the previous one is terminated
# and any result that comes back for a superseded query is discarded.
_active_query: dict = {}


def _on_cb_state_change(old_state, new_state) -> None:
    """Broadcast circuit breaker state changes to all connected clients."""
    socketio.emit(Events.CIRCUIT_STATUS, {
        "state":    new_state.value,
        "old":      old_state.value,
    })


# Shared Circuit Breaker instance — protects all engine calls.
# threshold=3  : 3 consecutive failures → OPEN
# reset_timeout=30 : wait 30 s before HALF_OPEN trial
cb: CircuitBreakerBase = CircuitBreaker(
    threshold=3,
    reset_timeout=30,
    on_state_change=_on_cb_state_change,
)


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
        "running":        engine.is_running() if engine else False,
        "katago_path":    KATAGO_PATH,
        "model_path":     MODEL_PATH,
        "circuit_breaker": cb.get_status(),
    })


@app.route("/api/circuit-status")
def api_circuit_status():
    """Current circuit breaker state (for polling / debug)."""
    return jsonify(cb.get_status())


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
    """Map an engine exception to a user-facing Socket.IO error event."""
    if isinstance(exc, CircuitOpenError):
        emit(Events.ERROR, {"message": str(exc), "circuit_open": True})
    elif isinstance(exc, EngineNotRunningError):
        emit(Events.ERROR, {"message": "Engine is not running"})
    elif isinstance(exc, EngineTimeoutError):
        emit(Events.ERROR, {"message": "Engine timed out — try again"})
    elif isinstance(exc, EngineQueryError):
        emit(Events.ERROR, {"message": f"Engine error: {exc}"})
    else:
        emit(Events.ERROR, {"message": f"Unexpected error: {exc}"})


def _protected_engine_call(operation) -> dict | None:
    """
    Execute *operation* through the circuit breaker and return the result.

    On any engine failure, emits an error event and returns None so the
    caller just checks `if result is None: return`.
    """
    try:
        return cb.call(operation)
    except (CircuitOpenError, EngineNotRunningError,
            EngineTimeoutError, EngineQueryError) as exc:
        logger.warning(f"Engine call failed: {exc}")
        _emit_engine_error(exc)
        return None


def _run_analysis(data: dict, default_max_visits: int) -> None:
    """
    Shared logic for the analyze and quick_analyze handlers.

    Single-flight per client: if a new analysis request arrives while a
    previous one is still running, the old query is terminated and its
    (stale) result is discarded — only the latest position is reported.
    """
    if not engine or not engine.is_running():
        emit(Events.ERROR, {"message": "Engine is not running"})
        return

    sid    = request.sid
    req_id = data.get("reqId")

    # Abort the previous in-flight analysis for this client so KataGo can
    # devote its full search budget to the new position immediately.
    prev_id = _active_query.get(sid)
    if prev_id:
        engine.terminate(prev_id)

    query_id = f"{sid}:{req_id}"
    _active_query[sid] = query_id

    moves          = data.get("moves", [])
    board_size     = data.get("boardSize", 19)
    komi           = data.get("komi", 7.5)
    max_visits     = data.get("maxVisits", default_max_visits)
    include_own    = data.get("includeOwnership", False)
    initial_stones = data.get("initialStones", None)
    initial_player = data.get("initialPlayer", None)

    logger.info(f"Analysis: {len(moves)} moves, visits={max_visits}")

    try:
        result = cb.call(lambda: engine.analyze_position(
            moves=moves, board_size=board_size, komi=komi,
            max_visits=max_visits, include_ownership=include_own,
            initial_stones=initial_stones, initial_player=initial_player,
            query_id=query_id,
        ))
    except (CircuitOpenError, EngineNotRunningError,
            EngineTimeoutError, EngineQueryError) as exc:
        # Only surface the error if this is still the client's latest request.
        if _active_query.get(sid) == query_id:
            _active_query.pop(sid, None)
            logger.warning(f"Analysis failed: {exc}")
            _emit_engine_error(exc)
        return

    # Discard silently if a newer request has superseded this one.
    if _active_query.get(sid) != query_id:
        return
    _active_query.pop(sid, None)

    result["reqId"] = req_id
    emit(Events.ANALYSIS, result)


# ── WebSocket event handlers ──────────────────────────────────────────────────

@socketio.on_error_default
def handle_socketio_error(exc):
    """
    Default Socket.IO error handler — catches exceptions that propagate
    out of event handlers (notably AuthenticationError from require_auth).
    """
    if isinstance(exc, AuthenticationError):
        emit(Events.ERROR, {"message": str(exc), "code": 401})
    else:
        logger.error(f"Unhandled Socket.IO error: {exc}")
        emit(Events.ERROR, {"message": "Internal server error"})


@socketio.on("connect")
def handle_connect():
    logger.info(f"Client connected: {request.sid}")
    emit(Events.STATUS, {"running": engine.is_running() if engine else False})
    emit(Events.CIRCUIT_STATUS, cb.get_status())


@socketio.on("disconnect")
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    _active_query.pop(request.sid, None)


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

    result = _protected_engine_call(lambda: engine.analyze_position(
        moves=moves, board_size=board_size, komi=komi,
        max_visits=max_visits,
        initial_stones=initial_stones, initial_player=initial_player,
    ))
    if result is None:
        return

    if result.get("moves"):
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
