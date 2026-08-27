from __future__ import annotations

import threading

from engine_lifecycle import monitor_engine


class _Engine:
    def __init__(self, running=False):
        self.running = running
        self.stop_calls = 0

    def is_running(self):
        return self.running

    def stop(self):
        self.running = False
        self.stop_calls += 1


class _RecordingEvent:
    def __init__(self):
        self.signaled = False
        self.waits = []

    def is_set(self):
        return self.signaled

    def set(self):
        self.signaled = True

    def wait(self, timeout):
        self.waits.append(timeout)
        return self.signaled


def test_watchdog_restarts_engine_and_broadcasts_recovery():
    engine = _Engine()
    stop = threading.Event()
    states = []

    def notify(running):
        states.append(running)
        if running:
            stop.set()

    def starter(target):
        target.running = True
        return True

    monitor_engine(
        engine,
        notify,
        stop,
        poll_interval=0,
        initial_backoff=0,
        starter=starter,
    )

    assert states == [False, True]
    assert engine.running is True


def test_watchdog_backs_out_cleanly_when_restart_fails_during_shutdown():
    engine = _Engine()
    stop = threading.Event()
    states = []
    starts = []

    def starter(_target):
        starts.append(True)
        stop.set()
        return False

    monitor_engine(
        engine,
        states.append,
        stop,
        poll_interval=0,
        initial_backoff=0.01,
        starter=starter,
    )

    assert starts == [True]
    assert states == [False]
    assert engine.running is False


def test_watchdog_stops_engine_if_shutdown_arrives_during_restart():
    engine = _Engine()
    stop = threading.Event()
    states = []

    def starter(target):
        target.running = True
        stop.set()
        return True

    monitor_engine(
        engine,
        states.append,
        stop,
        poll_interval=0,
        initial_backoff=0,
        starter=starter,
    )

    assert states == [False]
    assert engine.running is False
    assert engine.stop_calls == 2  # stale process cleanup + shutdown cleanup


def test_failed_restarts_use_one_exponential_delay_per_attempt():
    engine = _Engine()
    stop = _RecordingEvent()
    starts = []

    def starter(_target):
        starts.append(True)
        if len(starts) == 2:
            stop.set()
        return False

    monitor_engine(
        engine,
        lambda _running: None,
        stop,
        poll_interval=0,
        initial_backoff=1,
        max_backoff=8,
        stable_window=60,
        starter=starter,
    )

    assert len(starts) == 2
    assert stop.waits == [0, 1, 0, 2]
