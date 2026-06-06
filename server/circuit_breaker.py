"""
circuit_breaker.py — Circuit Breaker stability pattern (Nygard, 2018).

Wraps calls to the KataGo engine and prevents cascading failures when
the engine is slow or unresponsive.

States
------
CLOSED   — normal operation; calls pass through; failure count tracked
OPEN     — engine considered failed; calls fail-fast with CircuitOpenError
HALF_OPEN — one trial call allowed; success → CLOSED, failure → OPEN

Transitions
-----------
CLOSED  → OPEN      : failure_count >= threshold
OPEN    → HALF_OPEN : reset_timeout seconds have elapsed
HALF_OPEN → CLOSED  : trial call succeeds
HALF_OPEN → OPEN    : trial call fails
"""

import time
import threading
import logging
from enum import Enum
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class State(Enum):
    CLOSED    = "CLOSED"
    OPEN      = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitOpenError(Exception):
    """Raised when a call is attempted while the circuit breaker is OPEN."""


class CircuitBreaker:
    """
    Circuit Breaker (Nygard stability pattern).

    Parameters
    ----------
    threshold     : number of consecutive failures before opening
    reset_timeout : seconds to wait in OPEN state before trying HALF_OPEN
    on_state_change : optional callback(old: State, new: State) — used
                      to broadcast the new state to connected clients
    """

    def __init__(
        self,
        threshold: int = 3,
        reset_timeout: float = 30.0,
        on_state_change: Optional[Callable] = None,
    ):
        self.threshold      = threshold
        self.reset_timeout  = reset_timeout
        self.on_state_change = on_state_change

        self._state         = State.CLOSED
        self._failure_count = 0
        self._opened_at: Optional[float] = None
        self._lock          = threading.Lock()

    # ── Public interface ──────────────────────────────────────────────────────

    @property
    def state(self) -> State:
        return self._state

    def call(self, operation: Callable):
        """
        Execute *operation* through the circuit breaker.

        Raises
        ------
        CircuitOpenError          — circuit is OPEN (fail-fast)
        Any exception from *operation* — propagated after recording failure
        """
        with self._lock:
            if self._state == State.OPEN:
                elapsed = time.monotonic() - self._opened_at
                if elapsed >= self.reset_timeout:
                    self._transition(State.HALF_OPEN)
                else:
                    remaining = int(self.reset_timeout - elapsed)
                    raise CircuitOpenError(
                        f"Circuit is OPEN — engine unavailable "
                        f"(retry in {remaining}s)"
                    )

        try:
            result = operation()
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise

    def get_status(self) -> dict:
        """Return a status snapshot suitable for JSON serialisation."""
        with self._lock:
            remaining = 0
            if self._state == State.OPEN and self._opened_at:
                remaining = max(
                    0,
                    int(self.reset_timeout - (time.monotonic() - self._opened_at)),
                )
            return {
                "state":         self._state.value,
                "failure_count": self._failure_count,
                "threshold":     self.threshold,
                "reset_timeout": self.reset_timeout,
                "retry_in":      remaining,
            }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _on_success(self) -> None:
        with self._lock:
            if self._state == State.HALF_OPEN:
                self._failure_count = 0
                self._transition(State.CLOSED)
            elif self._state == State.CLOSED:
                self._failure_count = 0

    def _on_failure(self) -> None:
        with self._lock:
            self._failure_count += 1
            if self._state == State.HALF_OPEN:
                self._transition(State.OPEN)
            elif self._state == State.CLOSED:
                if self._failure_count >= self.threshold:
                    self._transition(State.OPEN)

    def _transition(self, new_state: State) -> None:
        """Change state and fire the optional callback (lock already held)."""
        old_state   = self._state
        self._state = new_state
        if new_state == State.OPEN:
            self._opened_at = time.monotonic()
            logger.warning(
                f"Circuit breaker OPENED after {self._failure_count} failures"
            )
        elif new_state == State.CLOSED:
            self._opened_at = None
            logger.info("Circuit breaker CLOSED — engine recovered")
        elif new_state == State.HALF_OPEN:
            logger.info("Circuit breaker HALF-OPEN — sending trial call")

        if self.on_state_change and old_state != new_state:
            try:
                self.on_state_change(old_state, new_state)
            except Exception as e:
                logger.warning(f"on_state_change callback raised: {e}")
