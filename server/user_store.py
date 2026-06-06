"""
user_store.py — SQLite persistence layer for users and settings.

Responsibility: database schema, user CRUD, settings key/value store.
No knowledge of HTTP, WebSocket, JWT, or design patterns — pure data access.
"""

import os
import sqlite3
import logging

import bcrypt

logger = logging.getLogger(__name__)

_DB_PATH: str = os.path.join(os.path.dirname(__file__), "users.db")

# ── Schema ────────────────────────────────────────────────────────────────────

def init_db() -> None:
    """
    Create or migrate the database schema.  Safe to call on every startup.

    - Creates tables if they don't exist.
    - Adds is_admin column to pre-existing users tables (migration).
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
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_open', '1')"
        )
        conn.commit()

    _ensure_admin()
    logger.info("User store ready")


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
            conn.execute("UPDATE users SET is_admin = 1 WHERE username = 'admin'")
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

# ── User CRUD ─────────────────────────────────────────────────────────────────

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
    """Delete a user.  Returns (success, message).  Admin account is protected."""
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
    """Return all users as a list of dicts (id, username, is_admin)."""
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


def get_user_record(username: str) -> dict | None:
    """Return {id, username, is_admin} for a user, or None if not found."""
    with sqlite3.connect(_DB_PATH) as conn:
        row = conn.execute(
            "SELECT id, username, is_admin FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    return {"id": row[0], "username": row[1], "is_admin": bool(row[2])} if row else None


def get_user_is_admin(username: str) -> bool:
    """Return True if the user exists and has admin privileges."""
    record = get_user_record(username)
    return bool(record and record["is_admin"])
