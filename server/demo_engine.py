"""
demo_engine.py — DEMO-ONLY fault-injecting engine.

A stand-in for the real KataGo engine, used **only** when the environment
variable CB_DEMO_FAULT_INJECTION is set (see app_factory). It lets a presenter
toggle engine failures live (via /api/demo/engine-fault) to demonstrate the
Circuit Breaker on the real web UI, with no GPU and no KataGo process.

  - fault OFF : returns a plausible (fake) analysis so the board still "works".
  - fault ON  : every analysis raises EngineQueryError, which the Circuit
                Breaker counts and — after the failure threshold — trips to
                OPEN (fail-fast), broadcasting the state change to all clients.

It implements the KataGoFacade interface, so the rest of the application is
unchanged. Never enabled in production.
"""

import time
import math
import logging

from katago_facade import KataGoFacade
from exceptions import EngineQueryError

logger = logging.getLogger(__name__)

# Pool of points used as fake candidate moves (filtered against stones already
# on the board so we never suggest an occupied point).
_FAKE_POOL = ["Q16", "D4", "Q4", "D16", "Q10", "C10", "R10", "K10", "K16", "K4"]


class FaultInjectingEngine(KataGoFacade):
    """Demo-only KataGoFacade that can be forced to fail on demand."""

    demo_mode = True  # tells start_engine() to skip the real KataGo startup

    def __init__(self, latency: float = 0.4):
        self._fault = False
        self._latency = latency

    # ── live toggle ──────────────────────────────────────────────────────────
    @property
    def fault(self) -> bool:
        return self._fault

    def set_fault(self, on: bool) -> None:
        self._fault = bool(on)
        logger.warning(f"[DEMO] engine fault injection {'ON' if self._fault else 'OFF'}")

    # ── KataGoFacade interface ───────────────────────────────────────────────
    def start(self) -> bool:
        logger.warning("[DEMO] FaultInjectingEngine active — no real KataGo process")
        return True

    def stop(self) -> None:
        pass

    def is_running(self) -> bool:
        return True

    def terminate(self, query_id: str = None) -> None:
        pass

    def analyze_position(self, moves=None, board_size=19, komi=7.5,
                         max_visits=3000, include_ownership=False,
                         initial_stones=None, initial_player=None,
                         query_id=None) -> dict:
        if self._fault:
            raise EngineQueryError("Injected fault (demo mode) — engine forced to fail")
        time.sleep(self._latency)  # pretend to compute
        return self._fake_result(moves or [], max_visits)

    # ── fake analysis ────────────────────────────────────────────────────────
    def _fake_result(self, moves, max_visits) -> dict:
        n = len(moves)
        current = "W" if n % 2 else "B"
        winrate = min(max(0.5 + 0.05 * math.sin(n / 1.5), 0.02), 0.98)
        occupied = {self._vertex(m) for m in moves}
        candidates = []
        for i, v in enumerate([p for p in _FAKE_POOL if p not in occupied][:5]):
            candidates.append({
                "move":      v,
                "visits":    max(1, max_visits - i * 7),
                "winrate":   round(min(max(winrate - i * 0.01, 0.02), 0.98), 4),
                "scoreLead": round(2.0 - i * 0.5, 2),
                "order":     i,
                "pv":        [v],
                "prior":     round(max(0.3 - i * 0.05, 0.0), 3),
            })
        return {
            "currentPlayer": current,
            "winrate":       round(winrate, 4),
            "scoreLead":     round(2.0 * math.sin(n / 2.0), 2),
            "visits":        max_visits,
            "moves":         candidates,
        }

    @staticmethod
    def _vertex(move):
        """Best-effort GTP vertex from a move entry like ['B', 'D4'] or 'D4'."""
        if isinstance(move, (list, tuple)):
            return move[-1] if move else None
        return move
