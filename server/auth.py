"""
auth.py — Proxy pattern: authentication layer for WebSocket handlers.

Components
----------
- SQLite user store  : persistent username / bcrypt-hashed-password table
- JWT helpers        : create and decode tokens (24-hour lifetime)
- require_auth       : the Proxy decorator — intercepts every call to a
                       protected Socket.IO handler, verifies the JWT in
                       the event payload, and rejects unauthenticated
                       requests before they reach the real handler

Design note
-----------
require_auth is the Proxy (GoF Structural).  It presents the same
function signature as the wrapped handler, adds authentication logic,
and forwards the call only when the caller is authorised — exactly the
Proxy pattern's "same interface, added control" intent.
"""

import os
import sqlite3
import logging
from datetime import datetime, timedelta, timezone
from functools import wraps

import bcrypt
import jwt
from flask_socketio import emit

from events import Events

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

_JWT_SECRET: str = os.environ.get("JWT_SECRET", "katago-web-jwt-secret-change-in-prod")
_TOKEN_EXPIRY_HOURS: int = 24
_DB_PATH: str = os.path.join(os.path.dirname(__file__), "users.db")

# ── Database ──────────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create the users table if it does not exist."""
    with sqlite3.connect(_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL
            )
        """)
        conn.commit()
    logger.info("Auth DB initialised")


def register_user(username: str, password: str) -> tuple:
    """
    Register a new user.  Returns (success: bool, message: str).

    Passwords are hashed with bcrypt before storage; the plaintext is
    never written to disk.
    """
    if not username or not password:
        return False, "Username and password are required"
    if len(username) < 3:
        return False, "Username must be at least 3 characters"
    if len(password) < 6:
        return False, "Password must be at least 6 characters"

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    try:
        with sqlite3.connect(_DB_PATH) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username.strip(), pw_hash),
            )
            conn.commit()
        logger.info(f"Registered new user: {username}")
        return True, "Registration successful"
    except sqlite3.IntegrityError:
        return False, "Username already taken"


def verify_user(username: str, password: str) -> bool:
    """Return True if the credentials are correct."""
    with sqlite3.connect(_DB_PATH) as conn:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE username = ?",
            (username.strip(),),
        ).fetchone()
    if not row:
        return False
    return bcrypt.checkpw(password.encode(), row[0].encode())

# ── JWT ───────────────────────────────────────────────────────────────────────

def create_token(username: str) -> str:
    """Return a signed JWT for username, valid for _TOKEN_EXPIRY_HOURS."""
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> str | None:
    """
    Decode and verify a JWT.  Returns the username (subject) on success,
    None if the token is missing, expired, or tampered with.
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, _JWT_SECRET, algorithms=["HS256"])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None

# ── Proxy decorator ───────────────────────────────────────────────────────────

def require_auth(f):
    """
    Proxy decorator for Socket.IO event handlers.

    Intercepts every call, extracts the "token" field from the event
    payload, and forwards to the real handler only when the token is
    valid.  Invalid / missing tokens are rejected with a 401 error event
    and the underlying function is never called.

    Usage::

        @socketio.on(Events.ANALYZE)
        @require_auth
        def handle_analyze(data):
            # only reached when authenticated
            ...

    The client must include {"token": "<jwt>", ...rest of payload...}
    in every protected event.
    """
    @wraps(f)
    def wrapper(data, *args, **kwargs):
        token = data.get("token") if isinstance(data, dict) else None
        username = decode_token(token)
        if not username:
            emit(Events.ERROR, {
                "message": "Unauthorized — please sign in",
                "code": 401,
            })
            return
        # Strip the token from data before passing to the real handler
        # so handlers don't have to know about auth internals.
        clean_data = {k: v for k, v in data.items() if k != "token"}
        return f(clean_data, *args, **kwargs)
    return wrapper
