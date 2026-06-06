"""
circuit_breaker.py — Circuit Breaker stability pattern (Nygard, 2018).

Class hierarchy (mirrors the GoF-style diagram used in TP1):

    Client  ──uses──►  CircuitBreakerBase (ABC)
                               ▲ implements
                       CircuitBreaker (concrete)
                               │ delegates (if not OPEN)
                               ▼
                       KataGoFacade / any callable

States
------
CLOSED    — normal operation; calls pass through; failure count tracked
OPEN      — engine considered failed; calls fail-fast with CircuitOpenError
HALF_OPEN — one trial call allowed; success → CLOSED, failure → OPEN

Transitions
-----------
CLOSED    → OPEN      : failure_count >= threshold
OPEN      → HALF_OPEN : _timeout_expired() returns True
HALF_OPEN → CLOSED    : trial call succeeds  / failure count reset
HALF_OPEN → OPEN      : trial call fails

Invariant: in HALF_OPEN exactly ONE trial call is allowed through; any
other call arriving while that probe is in flight fails fast with
CircuitOpenError.  This is enforced even under concurrent (eventlet
green-thread) access via the internal lock.
"""

import time
import threading
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class State(Enum):
    CLOSED    = "CLOSED"
    OPEN      = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitOpenError(Exception):
    """Raised when a call is attempted while the circuit breaker is OPEN."""


# ── Abstract interface (the "CircuitBreaker" box in the class diagram) ─────────

class CircuitBreakerBase(ABC):
    """
    Abstract interface for the Circuit Breaker pattern.

    The rest of the application (app.py) depends on this interface,
    not on the concrete implementation — same decoupling principle as
    KataGoFacade for the engine layer.
    """

    @abstractmethod
    def call(self, operation: Callable):
        """
        Execute *operation* through the circuit breaker.

        Raises CircuitOpenError if the circuit is OPEN (fail-fast).
        Propagates any exception raised by *operation* after recording
        the failure.
        """

    @abstractmethod
    def get_status(self) -> dict:
        """Return a JSON-serialisable status snapshot."""


# ── Concrete implementation ─────────────────────────────────────────────────────

class CircuitBreaker(CircuitBreakerBase):
    """
    Concrete Circuit Breaker implementation.

    Parameters
    ----------
    threshold       : consecutive failures before transitioning to OPEN
    reset_timeout   : seconds to wait in OPEN before allowing a trial (HALF_OPEN)
    on_state_change : optional callback(old: State, new: State) —
                      used to broadcast state changes to connected clients
    """

    def __init__(
        self,
        threshold: int = 3,
        reset_timeout: float = 30.0,
        on_state_change: Optional[Callable] = None,
    ):
        self.threshold       = threshold
        self.reset_timeout   = reset_timeout
        self.on_state_change = on_state_change

        self._state         = State.CLOSED
        self._failure_count = 0
        self._opened_at: Optional[float] = None
        self._lock          = threading.Lock()

    # ── CircuitBreakerBase interface ────────────────────────────────────────────

    def call(self, operation: Callable):
        with self._lock:
            if self._state == State.OPEN:
                if self._timeout_expired():
                    # This call becomes the single trial probe.
                    self._transition(State.HALF_OPEN)
                else:
                    remaining = int(self.reset_timeout -
                                    (time.monotonic() - self._opened_at))
                    raise CircuitOpenError(
                        f"Circuit is OPEN — engine unavailable "
                        f"(retry in {max(0, remaining)}s)"
                    )
            elif self._state == State.HALF_OPEN:
                # A trial probe started by another (concurrent) call is
                # already in flight.  The textbook pattern allows exactly
                # ONE trial call in HALF_OPEN — reject everyone else.
                raise CircuitOpenError(
                    "Circuit is HALF-OPEN — trial call already in progress"
                )

        try:
            result = operation()
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise

    def get_status(self) -> dict:
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

    # ── State property ──────────────────────────────────────────────────────────

    @property
    def state(self) -> State:
        return self._state

    # ── Private helpers (named to match the class diagram) ─────────────────────

    def _timeout_expired(self) -> bool:
        """Return True if reset_timeout has elapsed since the circuit opened."""
        return (self._opened_at is not None and
                time.monotonic() - self._opened_at >= self.reset_timeout)

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
