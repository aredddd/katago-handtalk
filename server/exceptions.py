"""
Custom exception hierarchy for KataGo engine errors.

Using distinct types lets callers (and future Circuit Breaker logic)
react differently to transient vs permanent failures without parsing
error strings or checking for None returns.
"""


class KataGoError(Exception):
    """Base class for all KataGo-related errors."""


class EngineNotRunningError(KataGoError):
    """Raised when a query is attempted but the KataGo process is not running."""


class EngineTimeoutError(KataGoError):
    """Raised when KataGo does not respond within the configured timeout."""


class EngineQueryError(KataGoError):
    """Raised when KataGo returns a response that contains an error field."""


class AuthenticationError(Exception):
    """
    Raised by require_auth when a Socket.IO request carries an invalid
    or missing JWT token.  Caught by the socketio error handler in app.py,
    which emits the 401 error event — keeping auth.py free of SocketIO imports.
    """
