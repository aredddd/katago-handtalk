"""
auth.py — authentication and authorisation layer.

Patterns
--------
Proxy (GoF Structural):
  require_auth  — guards Socket.IO handlers (JWT verification)
  require_admin — guards HTTP admin endpoints (JWT + is_admin flag)

Components
----------
- SQLite user store  (users table + settings table)
- bcrypt password hashing
- JWT token creation / verification
- Admin account bootstrap (username: admin / password: admin)
- Registration gate  (settings.registration_open)
- Password change
"""

import os
import sqlite3
import logging
from datetime import datetime, timedelta, timezone
from functools import wraps

import bcrypt
import jwt
from flask import request, jsonify

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

_JWT_SECRET: str         = os.environ.get("JWT_SECRET", "katago-web-jwt-secret-change-in-prod")
_TOKEN_EXPIRY_HOURS: int = 24
_DB_PATH: str            = os.path.join(os.path.dirname(__file__), "users.db")

# ── Database setup ────────────────────────────────────────────────────────────

def init_db() -> None:
    """
    Create or migrate the database schema.

    Safe to call on every startup:
      - Creates tables if they don't exist.
      - Adds is_admin column to existing users tables (migration).
      - Seeds the admin account and default settings.
    """
    with sqlite3.connect(_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                is_admin      INTEGER DEFAULT 0
            )
        """)
        # Migration: add is_admin to pre-existing tables
        try:
            conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # column already exists

        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        # Default settings (INSERT OR IGNORE keeps existing values)
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_open', '1')"
        )
        conn.commit()

    _ensure_admin()
    logger.info("Auth DB ready")


def _ensure_admin() -> None:
    """Create the built-in admin account if it does not exist yet."""
    with sqlite3.connect(_DB_PATH) as conn:
        row = conn.execute(
            "SELECT id FROM users WHERE username = 'admin'"
        ).fetchone()
        if not row:
            pw_hash = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin) VALUES ('admin', ?, 1)",
                (pw_hash,),
            )
            conn.commit()
            logger.info("Created built-in admin account (change the password after first login)")
        else:
            # Ensure the admin flag is set even on migrated databases
            conn.execute(
                "UPDATE users SET is_admin = 1 WHERE username = 'admin'"
            )
            conn.commit()

# ── Settings ──────────────────────────────────────────────────────────────────

def get_setting(key: str, default: str = "") -> str:
    with sqlite3.connect(_DB_PATH) as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
    return row[0] if row else default


def set_setting(key: str, value: str) -> None:
    with sqlite3.connect(_DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()


def is_registration_open() -> bool:
    return get_setting("registration_open", "1") == "1"

# ── User management ───────────────────────────────────────────────────────────

def register_user(username: str, password: str) -> tuple:
    """Register a new user.  Returns (success: bool, message: str)."""
    if not is_registration_open():
        return False, "Registration is currently closed"
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
                "INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 0)",
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


def delete_user(username: str) -> tuple:
    """Delete a user.  Returns (success, message).  Admin cannot be deleted."""
    if username == "admin":
        return False, "The admin account cannot be deleted"
    with sqlite3.connect(_DB_PATH) as conn:
        cur = conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    if cur.rowcount == 0:
        return False, "User not found"
    logger.info(f"Deleted user: {username}")
    return True, "User deleted"


def list_users() -> list:
    """Return a list of user dicts (id, username, is_admin)."""
    with sqlite3.connect(_DB_PATH) as conn:
        rows = conn.execute(
            "SELECT id, username, is_admin FROM users ORDER BY id"
        ).fetchall()
    return [{"id": r[0], "username": r[1], "is_admin": bool(r[2])} for r in rows]


def change_password(username: str, old_password: str, new_password: str) -> tuple:
    """Change a user's password after verifying the old one."""
    if not verify_user(username, old_password):
        return False, "Incorrect current password"
    if len(new_password) < 6:
        return False, "New password must be at least 6 characters"
    pw_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    with sqlite3.connect(_DB_PATH) as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (pw_hash, username),
        )
        conn.commit()
    logger.info(f"Password changed for: {username}")
    return True, "Password changed successfully"

# ── JWT ───────────────────────────────────────────────────────────────────────

def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm="HS256")


def decode_token(token: str):
    """Return username string on success, None on failure."""
    if not token:
        return None
    try:
        return jwt.decode(token, _JWT_SECRET, algorithms=["HS256"]).get("sub")
    except jwt.PyJWTError:
        return None


def _token_from_request() -> str:
    """Extract Bearer token from the Authorization header."""
    auth = request.headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else ""


def get_user_is_admin(username: str) -> bool:
    """Return True if the user exists and has admin privileges."""
    record = _get_user_record(username)
    return bool(record and record["is_admin"])


def _get_user_record(username: str) -> dict | None:
    with sqlite3.connect(_DB_PATH) as conn:
        row = conn.execute(
            "SELECT id, username, is_admin FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    return {"id": row[0], "username": row[1], "is_admin": bool(row[2])} if row else None

# ── Proxy decorators ──────────────────────────────────────────────────────────

def require_auth(f):
    """
    Proxy decorator for Socket.IO handlers — verifies JWT in event payload.

    Rejects with a 401 error event if the token is missing or invalid;
    strips the token from data before forwarding to the real handler.
    """
    from flask_socketio import emit
    from events import Events

    @wraps(f)
    def wrapper(data, *args, **kwargs):
        token    = data.get("token") if isinstance(data, dict) else None
        username = decode_token(token)
        if not username:
            emit(Events.ERROR, {"message": "Unauthorized — please sign in", "code": 401})
            return
        clean = {k: v for k, v in data.items() if k != "token"}
        return f(clean, *args, **kwargs)
    return wrapper


def require_admin(f):
    """
    Proxy decorator for HTTP admin routes — verifies JWT + is_admin flag.

    Returns 401 if the token is missing/invalid, 403 if the user is not admin.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        username = decode_token(_token_from_request())
        if not username:
            return jsonify({"error": "Unauthorized"}), 401
        user = _get_user_record(username)
        if not user or not user["is_admin"]:
            return jsonify({"error": "Forbidden — admin only"}), 403
        return f(*args, **kwargs)
    return wrapper
