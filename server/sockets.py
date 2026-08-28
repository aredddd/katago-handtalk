"""
sockets.py — Socket.IO event handlers (the transport/presentation layer).

This module owns everything WebSocket-specific: connection lifecycle, the
single-flight coordination per client (sid), translating engine exceptions to
error events, and emitting results.  The actual analysis is delegated to the
injected AnalysisService.  This local build intentionally accepts requests
without authentication.
"""

import logging
import itertools
import threading

from flask import request
from flask_socketio import emit

from events import Events
from config import DEFAULT_MAX_VISITS
from exceptions import (
    EngineNotRunningError, EngineTimeoutError, EngineQueryError,
)
from circuit_breaker import CircuitOpenError
from analysis_service import AnalysisParams
from board_sizes import InvalidBoardSizeError, SUPPORTED_BOARD_SIZES

logger = logging.getLogger(__name__)

# Engine-side failures that the analysis handlers translate into error events.
_ENGINE_ERRORS = (
    CircuitOpenError, EngineNotRunningError, EngineTimeoutError, EngineQueryError,
)

PLAY_AI_DEFAULT_VISITS = 800


def _emit_request_error(exc: Exception, *, req_id=None, kind=None) -> None:
    """Emit a stable, machine-readable error for an invalid client payload."""
    if isinstance(exc, InvalidBoardSizeError):
        payload = {
            "message": str(exc),
            "code": exc.code,
            "field": exc.field,
            "supported": list(SUPPORTED_BOARD_SIZES),
        }
    else:
        payload = {
            "message": "Invalid request payload: expected an object",
            "code": "invalid_request",
        }
    payload.update({"reqId": req_id, "kind": kind})
    emit(Events.ERROR, payload)


def _emit_engine_error(exc: Exception, *, req_id=None, kind=None) -> None:
    """Map an engine exception to a user-facing Socket.IO error event."""
    if isinstance(exc, CircuitOpenError):
        payload = {"message": str(exc), "circuit_open": True}
    elif isinstance(exc, EngineNotRunningError):
        payload = {"message": "Engine is not running"}
    elif isinstance(exc, EngineTimeoutError):
        payload = {"message": "Engine timed out — try again"}
    elif isinstance(exc, EngineQueryError):
        payload = {"message": f"Engine error: {exc}"}
    else:
        payload = {"message": f"Unexpected error: {exc}"}
    payload.update({"reqId": req_id, "kind": kind})
    emit(Events.ERROR, payload)


def register_socket_handlers(socketio, service) -> None:
    """Register all Socket.IO handlers against *socketio*, using *service*."""

    # Latest in-flight analysis query id per connected client (sid).
    # Enables single-flight: a new request terminates the previous one and any
    # superseded result is discarded.  Kept in this closure (process-local).
    active_query: dict = {}
    active_query_lock = threading.Lock()
    query_sequence = itertools.count(1)

    @socketio.on_error_default
    def on_socket_error(exc):
        """Translate unexpected handler failures to a stable client event."""
        logger.error(f"Unhandled Socket.IO error: {exc}")
        emit(Events.ERROR, {"message": "Internal server error"})

    @socketio.on("connect")
    def on_connect():
        logger.info(f"Client connected: {request.sid}")
        emit(Events.STATUS, {"running": service.is_ready()})
        emit(Events.CIRCUIT_STATUS, service.circuit_status())

    @socketio.on("disconnect")
    def on_disconnect(reason=None):
        logger.info("Client disconnected: %s (%s)", request.sid, reason or "client")
        with active_query_lock:
            query_id = active_query.pop(request.sid, None)
        if query_id:
            service.terminate(query_id)

    def _begin_query(sid, kind, req_id):
        """Replace any analysis/AI work already running for this client."""
        with active_query_lock:
            previous = active_query.get(sid)
            query_id = f"{sid}:{next(query_sequence)}:{kind}:{req_id}"
            active_query[sid] = query_id
        if previous:
            service.terminate(previous)
        return query_id

    def _emit_if_active(sid, query_id, event, payload):
        """Atomically verify latest-query ownership, emit, and clear it."""
        with active_query_lock:
            if active_query.get(sid) != query_id:
                return False
            emit(event, payload)
            active_query.pop(sid, None)
            return True

    def _emit_error_if_active(sid, query_id, exc, *, req_id, kind):
        with active_query_lock:
            if active_query.get(sid) != query_id:
                return False
            _emit_engine_error(exc, req_id=req_id, kind=kind)
            active_query.pop(sid, None)
            return True

    @socketio.on(Events.CANCEL)
    def on_cancel():
        with active_query_lock:
            query_id = active_query.pop(request.sid, None)
        if query_id:
            service.terminate(query_id)

    def _run_analysis(data: dict, default_visits: int) -> None:
        """Run one analysis request with per-client single-flight semantics."""
        req_id = data.get("reqId") if isinstance(data, dict) else None
        try:
            params = AnalysisParams.from_request(data, default_visits)
        except (InvalidBoardSizeError, TypeError) as exc:
            _emit_request_error(exc, req_id=req_id, kind="analysis")
            return

        if not service.is_ready():
            _emit_engine_error(EngineNotRunningError(), req_id=req_id, kind="analysis")
            return

        sid    = request.sid
        query_id = _begin_query(sid, "analysis", req_id)

        logger.info(f"Analysis: {len(params.moves)} moves, visits={params.max_visits}")

        try:
            result = service.analyze(params, query_id=query_id)
        except _ENGINE_ERRORS as exc:
            # Only surface the error if this is still the client's latest request.
            if _emit_error_if_active(
                sid, query_id, exc, req_id=req_id, kind="analysis"
            ):
                logger.warning(f"Analysis failed: {exc}")
            return

        result["reqId"] = req_id
        _emit_if_active(sid, query_id, Events.ANALYSIS, result)

    @socketio.on(Events.ANALYZE)
    def on_analyze(data):
        """Full local analysis."""
        _run_analysis(data, DEFAULT_MAX_VISITS)

    @socketio.on(Events.PLAY_AI)
    def on_play_ai(data):
        """Local AI move request."""
        req_id = data.get("reqId") if isinstance(data, dict) else None
        try:
            params = AnalysisParams.from_request(data, PLAY_AI_DEFAULT_VISITS)
        except (InvalidBoardSizeError, TypeError) as exc:
            _emit_request_error(exc, req_id=req_id, kind="ai")
            return

        if not service.is_ready():
            _emit_engine_error(EngineNotRunningError(), req_id=req_id, kind="ai")
            return

        sid = request.sid
        query_id = _begin_query(sid, "ai", req_id)
        try:
            move = service.best_move(params, query_id=query_id)
        except _ENGINE_ERRORS as exc:
            if _emit_error_if_active(
                sid, query_id, exc, req_id=req_id, kind="ai"
            ):
                logger.warning(f"play_ai failed: {exc}")
            return

        if move:
            move["reqId"] = req_id
            _emit_if_active(sid, query_id, Events.AI_MOVE, move)
        else:
            _emit_if_active(sid, query_id, Events.ERROR, {
                "message": "AI could not generate a move",
                "reqId": req_id,
                "kind": "ai",
            })
