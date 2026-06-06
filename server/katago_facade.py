"""
KataGoFacade — abstract interface for the KataGo analysis engine.

Defines the public contract that the rest of the application depends on.
Concrete implementations (KataGoEngine) hide the subprocess lifecycle,
stdin/stdout pipe protocol, threading, and JSON serialisation behind
this simple four-method surface.
"""

from abc import ABC, abstractmethod
from typing import Optional


class KataGoFacade(ABC):
    """
    Façade (GoF Structural) — simplifies access to the KataGo subsystem.

    The application layer (app.py) depends only on this interface, not on
    the concrete KataGoEngine class.  This decouples the routing/WebSocket
    layer from subprocess management details and makes the engine
    substitutable (e.g. a mock for testing, a remote engine over HTTP).
    """

    @abstractmethod
    def start(self) -> bool:
        """
        Start the KataGo process and wait until it is ready to accept queries.

        Returns:
            True if the engine started and passed the readiness check,
            False otherwise.
        """

    @abstractmethod
    def stop(self) -> None:
        """Gracefully stop the KataGo process."""

    @abstractmethod
    def analyze_position(
        self,
        moves: list,
        board_size: int = 19,
        komi: float = 7.5,
        max_visits: int = 3000,
        include_ownership: bool = False,
        initial_stones: Optional[list] = None,
        initial_player: Optional[str] = None,
    ) -> dict:
        """
        Analyse a Go position and return ranked candidate moves.

        Args:
            moves:             Move history as [["B", "D4"], ["W", "Q16"], ...].
            board_size:        Board side length (typically 19).
            komi:              Komi value.
            max_visits:        Maximum MCTS visits for this query.
            include_ownership: Whether to include per-intersection ownership.
            initial_stones:    Stones to place before the move history.
            initial_player:    Player to move first ("B" or "W").

        Returns:
            Dict with keys: currentPlayer, winrate, scoreLead, visits,
            moves (list of candidate dicts), ownership (optional).

        Raises:
            EngineNotRunningError: The process is not alive.
            EngineTimeoutError:    No response within the timeout window.
            EngineQueryError:      KataGo returned an error in its response.
        """

    @abstractmethod
    def is_running(self) -> bool:
        """Return True if the engine process is alive and ready."""
