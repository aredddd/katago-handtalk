"""
WebSocket event name constants shared across all server-side handlers.

Keeping event names in one place prevents silent bugs caused by
mismatched string literals between emit() and on() calls.
"""


class Events:
    # ── Client → Server ──────────────────────────────────────────────
    ANALYZE         = "analyze"
    PLAY_AI         = "play_ai"
    CANCEL          = "cancel"

    # ── Server → Client ──────────────────────────────────────────────
    ANALYSIS        = "analysis"
    AI_MOVE         = "ai_move"
    STATUS          = "status"
    ERROR           = "error"
    CIRCUIT_STATUS  = "circuit_status"   # circuit breaker state change
