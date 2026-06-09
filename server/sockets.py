"""
sockets.py — Socket.IO event handlers (the transport/presentation layer).

This module owns everything WebSocket-specific: connection lifecycle, the
single-flight coordination per client (sid), translating engine exceptions to
error events, and emitting results.  The actual analysis is delegated to the
injected AnalysisService (the RealSubject).  The require_auth Proxy guards the
protected handlers.
"""

import logging

from flask import request
from flask_socketio import emit

from events import Events
from config import DEFAULT_MAX_VISITS, QUICK_MAX_VISITS
from exceptions import (
    EngineNotRunningError, EngineTimeoutError, EngineQueryError,
    AuthenticationError,
)
from circuit_breaker import CircuitOpenError
from auth import require_auth
from analysis_service import AnalysisParams

logger = logging.getLogger(__name__)

# Engine-side failures that the analysis handlers translate into error events.
_ENGINE_ERRORS = (
    CircuitOpenError, EngineNotRunningError, EngineTimeoutError, EngineQueryError,
)

PLAY_AI_DEFAULT_VISITS = 800


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


def register_socket_handlers(socketio, service) -> None:
    """Register all Socket.IO handlers against *socketio*, using *service*."""

    # Latest in-flight analysis query id per connected client (sid).
    # Enables single-flight: a new request terminates the previous one and any
    # superseded result is discarded.  Kept in this closure (process-local).
    active_query: dict = {}

    @socketio.on_error_default
    def on_socket_error(exc):
        """Catch exceptions propagating out of handlers (e.g. AuthenticationError)."""
        if isinstance(exc, AuthenticationError):
            emit(Events.ERROR, {"message": str(exc), "code": 401})
        else:
            logger.error(f"Unhandled Socket.IO error: {exc}")
            emit(Events.ERROR, {"message": "Internal server error"})

    @socketio.on("connect")
    def on_connect():
        logger.info(f"Client connected: {request.sid}")
        emit(Events.STATUS, {"running": service.is_ready()})
        emit(Events.CIRCUIT_STATUS, service.circuit_status())

    @socketio.on("disconnect")
    def on_disconnect():
        logger.info(f"Client disconnected: {request.sid}")
        active_query.pop(request.sid, None)

    def _run_analysis(data: dict, default_visits: int) -> None:
        """Shared logic for analyze / quick_analyze with single-flight."""
        if not service.is_ready():
            emit(Events.ERROR, {"message": "Engine is not running"})
            return

        sid    = request.sid
        req_id = data.get("reqId")

        # Abort the previous in-flight analysis for this client.
        prev_id = active_query.get(sid)
        if prev_id:
            service.terminate(prev_id)

        query_id = f"{sid}:{req_id}"
        active_query[sid] = query_id

        params = AnalysisParams.from_request(data, default_visits)
        logger.info(f"Analysis: {len(params.moves)} moves, visits={params.max_visits}")

        try:
            result = service.analyze(params, query_id=query_id)
        except _ENGINE_ERRORS as exc:
            # Only surface the error if this is still the client's latest request.
            if active_query.get(sid) == query_id:
                active_query.pop(sid, None)
                logger.warning(f"Analysis failed: {exc}")
                _emit_engine_error(exc)
            return

        # Discard silently if a newer request has superseded this one.
        if active_query.get(sid) != query_id:
            return
        active_query.pop(sid, None)

        result["reqId"] = req_id
        emit(Events.ANALYSIS, result)

    @socketio.on(Events.ANALYZE)
    @require_auth
    def on_analyze(data):
        """Full analysis (Proxy: require_auth verifies the JWT first)."""
        _run_analysis(data, DEFAULT_MAX_VISITS)

    @socketio.on(Events.QUICK_ANALYZE)
    @require_auth
    def on_quick_analyze(data):
        """Fast analysis with fewer visits (Proxy-guarded)."""
        _run_analysis(data, QUICK_MAX_VISITS)

    @socketio.on(Events.PLAY_AI)
    @require_auth
    def on_play_ai(data):
        """AI move request (Proxy-guarded)."""
        if not service.is_ready():
            emit(Events.ERROR, {"message": "Engine is not running"})
            return

        params = AnalysisParams.from_request(data, PLAY_AI_DEFAULT_VISITS)
        try:
            move = service.best_move(params)
        except _ENGINE_ERRORS as exc:
            logger.warning(f"play_ai failed: {exc}")
            _emit_engine_error(exc)
            return

        if move:
            emit(Events.AI_MOVE, move)
        else:
            emit(Events.ERROR, {"message": "AI could not generate a move"})
