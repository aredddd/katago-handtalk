"""KataGo process routing and response normalization contract tests."""

import json
import queue
import threading
import time

import pytest

from exceptions import EngineNotRunningError
from katago_engine import KataGoEngine


def _response(current_player="W"):
    return {
        "rootInfo": {
            "currentPlayer": current_player,
            "winrate": 0.6342,
            "scoreLead": 0.828,
            "visits": 32,
        },
        "moveInfos": [
            {
                "move": "Q16",
                "visits": 20,
                "winrate": 0.635,
                "scoreLead": 0.825,
                "pv": ["Q16", "D4"],
            }
        ],
    }


class _FakeStdin:
    def __init__(self):
        self.writes = []
        self.flushed = threading.Event()

    def write(self, data):
        self.writes.append(data)

    def flush(self):
        self.flushed.set()


class _LineStdout:
    def __init__(self, messages):
        self.lines = [
            (json.dumps(message) + "\n").encode("utf-8")
            for message in messages
        ]

    def readline(self):
        if self.lines:
            return self.lines.pop(0)
        return b""


class _FailingStdout:
    def readline(self):
        raise OSError("reader exploded")


class _FakeProcess:
    def __init__(self, stdout):
        self.stdin = _FakeStdin()
        self.stdout = stdout
        self.stderr = iter(())

    def poll(self):
        return None


def test_black_reporting_config_is_not_inverted_when_white_to_move(tmp_path):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text("reportAnalysisWinratesAs = BLACK\n", encoding="utf-8")
    engine = KataGoEngine("katago", "model", str(cfg))
    engine.query = lambda **kwargs: _response("W")

    result = engine.analyze_position([])

    assert result["currentPlayer"] == "W"
    assert result["winrate"] == 0.6342
    assert result["scoreLead"] == 0.828
    assert result["moves"][0]["winrate"] == 0.635
    assert result["moves"][0]["scoreLead"] == 0.825


def test_side_to_move_reporting_is_normalized_for_root_and_candidates(tmp_path):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text("reportAnalysisWinratesAs = SIDETOMOVE\n", encoding="utf-8")
    engine = KataGoEngine("katago", "model", str(cfg))
    engine.query = lambda **kwargs: _response("W")

    result = engine.analyze_position([])

    assert result["winrate"] == 1 - 0.6342
    assert result["scoreLead"] == -0.828
    assert result["moves"][0]["winrate"] == 1 - 0.635
    assert result["moves"][0]["scoreLead"] == -0.825


@pytest.mark.parametrize(
    ("perspective", "current_player"),
    [("WHITE", "B"), ("SIDETOMOVE", "W")],
)
def test_ownership_is_normalized_to_black_perspective(
    tmp_path, perspective, current_player
):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text(
        f"reportAnalysisWinratesAs = {perspective}\n", encoding="utf-8"
    )
    engine = KataGoEngine("katago", "model", str(cfg))
    response = _response(current_player)
    response["ownership"] = [0.75, -0.25, 0.0]
    engine.query = lambda **kwargs: response

    result = engine.analyze_position([], include_ownership=True)

    assert result["ownership"] == pytest.approx([-0.75, 0.25, 0.0])


def test_black_perspective_ownership_is_unchanged(tmp_path):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text("reportAnalysisWinratesAs = BLACK\n", encoding="utf-8")
    engine = KataGoEngine("katago", "model", str(cfg))
    response = _response("W")
    response["ownership"] = [0.75, -0.25]
    engine.query = lambda **kwargs: response

    result = engine.analyze_position([], include_ownership=True)

    assert result["ownership"] == [0.75, -0.25]


def test_stdout_ignores_warning_and_during_search_responses(tmp_path):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text("", encoding="utf-8")
    final_response = {
        "id": "analysis-1",
        "rootInfo": {"currentPlayer": "B", "winrate": 0.5},
        "moveInfos": [],
    }
    stdout = _LineStdout(
        [
            {"id": "analysis-1", "warning": "temporary warning"},
            {
                "id": "analysis-1",
                "isDuringSearch": True,
                "rootInfo": {"currentPlayer": "B", "winrate": 0.4},
            },
            final_response,
        ]
    )
    process = _FakeProcess(stdout)
    engine = KataGoEngine("katago", "model", str(cfg))
    response_queue = queue.Queue()
    engine.process = process
    engine.running = True
    with engine.response_queues_lock:
        engine.response_queues["analysis-1"] = response_queue

    engine._read_stdout(process)

    # The final result is delivered before the EOF failure sentinel.  If either
    # intermediate message had been routed, it would be first in this queue.
    assert response_queue.get_nowait() == final_response


@pytest.mark.parametrize(
    ("stdout", "expected_message"),
    [
        (_LineStdout([]), "stdout closed unexpectedly"),
        (_FailingStdout(), "reader exploded"),
    ],
)
def test_stdout_failure_wakes_query_without_waiting_for_timeout(
    tmp_path, stdout, expected_message
):
    cfg = tmp_path / "analysis.cfg"
    cfg.write_text("", encoding="utf-8")
    process = _FakeProcess(stdout)
    engine = KataGoEngine("katago", "model", str(cfg), max_wait=30)
    engine.process = process
    engine.running = True
    outcome = {}

    def run_query():
        try:
            engine.query([], query_id="waiting-query")
        except Exception as exc:  # capture the background-thread result
            outcome["error"] = exc

    query_thread = threading.Thread(target=run_query)
    query_thread.start()
    assert process.stdin.flushed.wait(timeout=1)

    started = time.monotonic()
    engine._read_stdout(process)
    query_thread.join(timeout=1)

    assert not query_thread.is_alive()
    assert time.monotonic() - started < 1
    assert isinstance(outcome["error"], EngineNotRunningError)
    assert expected_message in str(outcome["error"])
    assert engine.running is False
    assert engine.ready is False
    with engine.response_queues_lock:
        assert engine.response_queues == {}
