"""
demo_circuit_breaker.py — standalone, GPU-free demonstration of the Circuit
Breaker pattern (server/circuit_breaker.py).

It drives the REAL CircuitBreaker class with a controllable "flaky" engine and
prints a timestamped log of every call and every state transition, walking the
full lifecycle:

    CLOSED  → (threshold failures) → OPEN
    OPEN    → calls FAIL FAST in ~0 ms, WITHOUT invoking the engine
    OPEN    → (after reset_timeout) → HALF_OPEN (one trial call)
    HALF_OPEN (still failing) → OPEN
    HALF_OPEN (recovered)     → CLOSED

No Flask, no Socket.IO, no KataGo, no GPU — run it anywhere:

    python server/demo_circuit_breaker.py
"""

import os
import sys
import time
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from circuit_breaker import CircuitBreaker, CircuitOpenError  # noqa: E402

# Silence the breaker's own logger so the demo prints only its ordered,
# formatted output (the state transitions are shown by on_state_change below).
logging.getLogger("circuit_breaker").setLevel(logging.CRITICAL)

# Short timings so the whole demo finishes in ~15 s.
THRESHOLD     = 3       # consecutive failures before tripping to OPEN
RESET_TIMEOUT = 3.0     # seconds in OPEN before a HALF_OPEN trial is allowed
OP_LATENCY    = 0.25    # simulated engine compute time for each *real* call

_t0 = time.monotonic()


def _clock() -> str:
    return f"[{time.monotonic() - _t0:5.1f}s]"


class FlakyEngine:
    """
    Stand-in for the KataGo engine. `healthy` is flipped by the script to
    simulate the engine failing and later recovering. `calls` counts real
    invocations so we can prove that OPEN-state calls never reach the engine.
    """

    def __init__(self):
        self.healthy = True
        self.calls = 0

    def analyze(self):
        self.calls += 1
        time.sleep(OP_LATENCY)            # a real call costs time...
        if not self.healthy:
            raise RuntimeError("engine returned an error")
        return "winrate=53.2% (fake)"


def on_state_change(old, new):
    print(f"{_clock()}  -------- STATE: {old.value} -> {new.value} --------")


def attempt(cb, engine, label):
    """Make one call through the breaker and print what happened."""
    before = engine.calls
    t = time.monotonic()
    try:
        cb.call(engine.analyze)
        ms = (time.monotonic() - t) * 1000
        invoked = "engine invoked" if engine.calls > before else "engine NOT invoked"
        print(f"{_clock()}  {label:<22} OK         {ms:6.1f} ms  ({invoked})  state={cb.state.value}")
    except CircuitOpenError as e:
        ms = (time.monotonic() - t) * 1000
        print(f"{_clock()}  {label:<22} FAIL-FAST  {ms:6.1f} ms  (engine NOT invoked)  state={cb.state.value}  <- {e}")
    except Exception as e:
        ms = (time.monotonic() - t) * 1000
        print(f"{_clock()}  {label:<22} FAILED     {ms:6.1f} ms  (engine invoked)      state={cb.state.value}  <- {e}")


def banner(text):
    print(f"\n{_clock()}  ==== {text} ====")


def main():
    print(f"Circuit Breaker demo - threshold={THRESHOLD}, "
          f"reset_timeout={RESET_TIMEOUT:.0f}s, op_latency={OP_LATENCY * 1000:.0f} ms\n")

    engine = FlakyEngine()
    cb = CircuitBreaker(threshold=THRESHOLD, reset_timeout=RESET_TIMEOUT,
                        on_state_change=on_state_change)

    banner("1) Engine healthy - calls pass through (CLOSED)")
    for i in range(2):
        attempt(cb, engine, f"healthy call {i + 1}")

    banner("2) Engine fails - failures accumulate, breaker trips to OPEN")
    engine.healthy = False
    for i in range(THRESHOLD):
        attempt(cb, engine, f"failing call {i + 1}")

    banner("3) OPEN - every call fails fast in ~0 ms, engine never touched")
    for i in range(3):
        attempt(cb, engine, f"blocked call {i + 1}")
        time.sleep(0.3)

    banner(f"4) Wait {RESET_TIMEOUT:.0f}s -> next call is the HALF_OPEN trial (still broken -> re-OPEN)")
    time.sleep(RESET_TIMEOUT + 0.2)
    attempt(cb, engine, "trial (still broken)")
    attempt(cb, engine, "blocked again")

    banner("5) Engine recovers; after the timeout the trial succeeds -> CLOSED")
    engine.healthy = True
    time.sleep(RESET_TIMEOUT + 0.2)
    attempt(cb, engine, "trial (recovered)")
    attempt(cb, engine, "healthy again")

    print(f"\n{_clock()}  Final status: {cb.get_status()}")
    print(f"{_clock()}  Total real engine invocations: {engine.calls} "
          f"- OPEN-state calls were short-circuited (fail-fast).")


if __name__ == "__main__":
    main()
