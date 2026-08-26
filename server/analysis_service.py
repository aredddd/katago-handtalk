"""
analysis_service.py — application-logic service for Go analysis.

AnalysisService is the "RealSubject" of the Proxy pattern: the actual service
that the local transport reaches.  It runs analysis through the Circuit
Breaker and the KataGo Façade, and is deliberately **transport-agnostic** — it
returns results or raises engine exceptions, and never touches Flask or
Socket.IO.  The Socket.IO layer (sockets.py) handles sessions, single-flight
coordination and emitting events.
"""

from dataclasses import dataclass, field
from typing import Optional

from katago_facade import KataGoFacade
from circuit_breaker import CircuitBreakerBase


@dataclass
class AnalysisParams:
    """Parameters of an analysis request, parsed from the client payload."""
    moves: list = field(default_factory=list)
    board_size: int = 19
    komi: float = 7.5
    max_visits: int = 3000
    include_ownership: bool = False
    initial_stones: Optional[list] = None
    initial_player: Optional[str] = None

    @classmethod
    def from_request(cls, data: dict, default_max_visits: int) -> "AnalysisParams":
        return cls(
            moves=data.get("moves", []),
            board_size=data.get("boardSize", 19),
            komi=data.get("komi", 7.5),
            max_visits=data.get("maxVisits", default_max_visits),
            include_ownership=data.get("includeOwnership", False),
            initial_stones=data.get("initialStones", None),
            initial_player=data.get("initialPlayer", None),
        )


class AnalysisService:
    """
    Runs Go analysis through the Circuit Breaker and the KataGo Façade.

    Dependencies are injected: the engine (a KataGoFacade) and the circuit
    breaker (a CircuitBreakerBase). This keeps the service testable and free of
    any global state.
    """

    def __init__(self, engine: KataGoFacade, breaker: CircuitBreakerBase):
        self._engine = engine
        self._cb = breaker

    @property
    def engine(self) -> KataGoFacade:
        return self._engine

    def is_ready(self) -> bool:
        """True if the engine is alive and ready to accept queries."""
        return self._engine is not None and self._engine.is_running()

    def circuit_status(self) -> dict:
        """Current circuit breaker state (JSON-serialisable)."""
        return self._cb.get_status()

    def terminate(self, query_id) -> None:
        """Best-effort abort of an in-flight query (used for single-flight)."""
        if self._engine is not None:
            self._engine.terminate(query_id)

    def analyze(self, params: AnalysisParams, query_id=None) -> dict:
        """
        Run a full analysis through the circuit breaker.

        Returns the parsed analysis dict.  Raises CircuitOpenError or an engine
        exception (EngineNotRunningError / EngineTimeoutError / EngineQueryError)
        on failure — the caller is responsible for translating these.
        """
        return self._cb.call(lambda: self._engine.analyze_position(
            moves=params.moves,
            board_size=params.board_size,
            komi=params.komi,
            max_visits=params.max_visits,
            include_ownership=params.include_ownership,
            initial_stones=params.initial_stones,
            initial_player=params.initial_player,
            query_id=query_id,
        ))

    def best_move(self, params: AnalysisParams, query_id=None) -> Optional[dict]:
        """
        Ask the engine for the best move.  Returns a move dict, or None if no
        move is available.  Raises engine exceptions on failure.
        """
        result = self._cb.call(lambda: self._engine.analyze_position(
            moves=params.moves,
            board_size=params.board_size,
            komi=params.komi,
            max_visits=params.max_visits,
            initial_stones=params.initial_stones,
            initial_player=params.initial_player,
            query_id=query_id,
        ))
        if result and result.get("moves"):
            best = result["moves"][0]
            return {
                "move":      best["move"],
                "color":     result["currentPlayer"],
                "winrate":   best["winrate"],
                "scoreLead": best["scoreLead"],
                "visits":    best["visits"],
                "pv":        best["pv"],
            }
        return None
