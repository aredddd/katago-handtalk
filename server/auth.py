"""
auth.py — JWT helpers and Proxy decorators.

Responsibility: token creation/verification, access-control decorators.
No SQLite, no bcrypt, no SocketIO — pure auth logic.

Persistence is delegated to user_store.py.

Patterns
--------
Proxy (GoF Structural):
  require_auth  — guards Socket.IO handlers; raises AuthenticationError
                  on invalid JWT so app.py's error handler can emit the
                  401 event (keeping this module free of SocketIO imports)
  require_admin — guards HTTP admin routes; returns 401/403 HTTP responses
"""

import os
import logging
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from flask import request, jsonify

from exceptions import AuthenticationError
from user_store import get_user_record

logger = logging.getLogger(__name__)

_JWT_SECRET: str         = os.environ.get("JWT_SECRET", "katago-web-jwt-secret-change-in-prod")
_TOKEN_EXPIRY_HOURS: int = 24

# ── JWT ───────────────────────────────────────────────────────────────────────

def create_token(username: str) -> str:
    """Return a signed JWT for *username* valid for _TOKEN_EXPIRY_HOURS."""
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> str | None:
    """Verify *token* and return the username (subject), or None on failure."""
    if not token:
        return None
    try:
        return jwt.decode(token, _JWT_SECRET, algorithms=["HS256"]).get("sub")
    except jwt.PyJWTError:
        return None


def _token_from_request() -> str:
    """Extract the Bearer token from the Authorization header."""
    auth = request.headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else ""


def current_username() -> str | None:
    """Return the username from the request's Bearer token, or None."""
    return decode_token(_token_from_request())

# ── Proxy decorators ──────────────────────────────────────────────────────────

def require_auth(f):
    """
    Proxy decorator for Socket.IO event handlers.

    Intercepts every call, verifies the JWT in the event payload, and
    either forwards to the real handler (valid token) or raises
    AuthenticationError (invalid/missing token).

    AuthenticationError is caught by socketio.on_error_default in app.py,
    which emits the 401 error event — this module stays free of SocketIO.
    """
    @wraps(f)
    def wrapper(data, *args, **kwargs):
        token    = data.get("token") if isinstance(data, dict) else None
        username = decode_token(token)
        if not username:
            raise AuthenticationError("Unauthorized — please sign in")
        clean = {k: v for k, v in data.items() if k != "token"}
        return f(clean, *args, **kwargs)
    return wrapper


def require_admin(f):
    """
    Proxy decorator for HTTP admin routes.

    Verifies the Bearer JWT and the is_admin flag.
    Returns 401 if the token is invalid, 403 if the user is not admin.
    HTTP routes return responses directly, so no exception-based flow needed.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        username = decode_token(_token_from_request())
        if not username:
            return jsonify({"error": "Unauthorized"}), 401
        user = get_user_record(username)
        if not user or not user["is_admin"]:
            return jsonify({"error": "Forbidden — admin only"}), 403
        return f(*args, **kwargs)
    return wrapper
