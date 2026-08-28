"""Backend contract tests for the single-user local build."""

import io
import threading
import time

import pytest
import socketio as socketio_client
from werkzeug.serving import make_server

from app_factory import create_app
from analysis_service import AnalysisParams
from board_sizes import InvalidBoardSizeError, SUPPORTED_BOARD_SIZES
from events import Events


class FakeEngine:
    """Small in-memory KataGo façade used by Socket.IO tests."""

    def __init__(self):
        self.calls = []
        self.terminated = []

    def is_running(self):
        return True

    def terminate(self, query_id):
        self.terminated.append(query_id)

    def analyze_position(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "currentPlayer": "W",
            "winrate": 0.61,
            "scoreLead": 2.5,
            "visits": kwargs["max_visits"],
            "moves": [
                {
                    "move": "Q16",
                    "winrate": 0.61,
                    "scoreLead": 2.5,
                    "visits": kwargs["max_visits"],
                    "pv": ["Q16", "D4"],
                }
            ],
        }


@pytest.fixture
def local_app():
    engine = FakeEngine()

    def fake_recognizer(image_bytes, board_size):
        assert image_bytes == b"fake-image"
        assert board_size == 19
        board = [[0] * 19 for _ in range(19)]
        board[0][0] = 1
        board[18][18] = 2
        return {
            "board": board,
            "confidence": 0.98,
            "method": "mock",
        }

    app, socketio = create_app(
        engine=engine,
        recognizer=fake_recognizer,
        recognizer_available=True,
        socketio_async_mode="threading",
    )
    app.config.update(TESTING=True)
    return app, socketio, engine


def test_analysis_socket_needs_no_token(local_app):
    app, socketio, engine = local_app
    client = socketio.test_client(app)
    assert client.is_connected()

    # Deliberately omit the former JWT token field.
    client.emit(Events.ANALYZE, {
        "reqId": "position-1",
        "boardSize": 19,
        "komi": 7.5,
        "maxVisits": 64,
        "initialStones": [["B", "D16"], ["W", "Q4"]],
        "initialPlayer": "B",
        "includeOwnership": True,
    })

    packets = client.get_received()
    analysis = next(packet for packet in packets if packet["name"] == Events.ANALYSIS)
    payload = analysis["args"][0]
    assert payload["reqId"] == "position-1"
    assert payload["moves"][0]["move"] == "Q16"
    assert not any(packet["name"] == Events.ERROR for packet in packets)

    assert len(engine.calls) == 1
    call = engine.calls[0]
    assert call["max_visits"] == 64
    assert call["initial_stones"] == [["B", "D16"], ["W", "Q4"]]
    assert call["initial_player"] == "B"
    assert call["include_ownership"] is True
    assert call["query_id"].endswith(":position-1")
    client.disconnect()


@pytest.mark.parametrize("board_size", SUPPORTED_BOARD_SIZES)
def test_analysis_socket_passes_supported_board_sizes_to_katago(
    local_app, board_size
):
    app, socketio, engine = local_app
    client = socketio.test_client(app)

    client.emit(Events.ANALYZE, {
        "reqId": f"board-{board_size}",
        "boardSize": board_size,
        "maxVisits": 8,
    })

    packets = client.get_received()
    assert any(packet["name"] == Events.ANALYSIS for packet in packets)
    assert engine.calls[-1]["board_size"] == board_size
    client.disconnect()


@pytest.mark.parametrize(
    "board_size",
    [True, False, "19", 19.0, None, 8, 10, 20, -1],
)
def test_analysis_params_strictly_rejects_invalid_board_sizes(board_size):
    with pytest.raises(InvalidBoardSizeError, match="9, 13, 19"):
        AnalysisParams.from_request({"boardSize": board_size}, 32)


@pytest.mark.parametrize("event", [Events.ANALYZE, Events.PLAY_AI])
@pytest.mark.parametrize("board_size", [True, "9", 9.0, 8, 20])
def test_socket_rejects_invalid_board_size_without_calling_engine(
    local_app, event, board_size
):
    app, socketio, engine = local_app
    client = socketio.test_client(app)

    client.emit(event, {
        "reqId": "bad-board",
        "boardSize": board_size,
        "maxVisits": 8,
    })

    errors = [
        packet["args"][0]
        for packet in client.get_received()
        if packet["name"] == Events.ERROR
    ]
    assert errors == [{
        "message": "Invalid boardSize: expected one of 9, 13, 19",
        "code": "invalid_board_size",
        "field": "boardSize",
        "supported": [9, 13, 19],
        "reqId": "bad-board",
        "kind": "analysis" if event == Events.ANALYZE else "ai",
    }]
    assert engine.calls == []
    client.disconnect()


def test_ai_move_echoes_request_id_and_empty_root_player(local_app):
    app, socketio, engine = local_app
    client = socketio.test_client(app)

    client.emit(Events.PLAY_AI, {
        "reqId": "ai-position-7",
        "moves": [],
        "boardSize": 19,
        "komi": 7.5,
        "maxVisits": 16,
        "initialPlayer": "W",
    })

    packets = client.get_received()
    move = next(packet for packet in packets if packet["name"] == Events.AI_MOVE)
    assert move["args"][0]["reqId"] == "ai-position-7"
    assert move["args"][0]["move"] == "Q16"
    assert engine.calls[-1]["initial_stones"] is None
    assert engine.calls[-1]["initial_player"] == "W"
    client.disconnect()


def test_recognition_route_returns_analysis_ready_position(local_app):
    app, _, _ = local_app
    response = app.test_client().post(
        "/api/recognize",
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["boardSize"] == 19
    assert payload["initialStones"] == [["B", "A19"], ["W", "T1"]]
    assert payload["confidence"] == 0.98
    assert len(payload["board"]) == 19


def test_auth_and_admin_routes_are_not_registered(local_app):
    app, _, _ = local_app
    registered_rules = {rule.rule for rule in app.url_map.iter_rules()}

    # Flask's root static-file rule can turn an unmatched POST into 405, so
    # inspect the route table directly instead of relying on response codes.
    assert "/api/login" not in registered_rules
    assert "/api/register" not in registered_rules
    assert "/api/admin/users" not in registered_rules
    assert "/admin" not in registered_rules


def test_status_exposes_stable_desktop_service_marker(local_app):
    app, _, _ = local_app

    response = app.test_client().get("/api/status")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["app"] == "katago-web-beginner"
    assert payload["api_version"] == 1
    assert payload["version"] == "0.2.0-dev.1"
    assert "session_token" in payload
    assert payload["running"] is True


def test_config_reports_optional_recognition_as_a_capability():
    app, _ = create_app(
        engine=FakeEngine(),
        recognizer=lambda *_args: {},
        recognizer_available=False,
    )
    app.config.update(TESTING=True)
    client = app.test_client()

    config = client.get("/api/config").get_json()
    assert config["version"] == "0.2.0-dev.1"
    assert config["supported_board_sizes"] == [9, 13, 19]
    assert config["capabilities"]["engine"]["supported_board_sizes"] == [9, 13, 19]
    assert config["capabilities"]["recognition"]["available"] is False
    assert config["capabilities"]["recognition"]["supported_board_sizes"] == [19]
    assert config["capabilities"]["live_review"]["available"] is False
    assert config["capabilities"]["live_review"]["supported_board_sizes"] == [19]

    unavailable = client.post(
        "/api/recognize",
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )
    assert unavailable.status_code == 503
    assert unavailable.get_json()["reason"] in {
        "disabled", "dependencies_missing", "models_missing", "unavailable"
    }


def test_recognition_rejects_missing_or_invalid_upload(local_app):
    app, _, _ = local_app
    client = app.test_client()

    assert client.post("/api/recognize", data={}).status_code == 400
    response = client.post(
        "/api/recognize",
        data={
            "boardSize": "nineteen",
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert response.get_json()["error"] == "Invalid boardSize"


def test_recognition_queue_is_bounded_to_one_in_flight_request():
    entered = threading.Event()
    release = threading.Event()

    def blocking_recognizer(_image, _size):
        entered.set()
        release.wait(timeout=5)
        return {"board": [[0] * 19 for _ in range(19)]}

    app, _ = create_app(
        engine=FakeEngine(),
        recognizer=blocking_recognizer,
        recognizer_available=True,
    )
    app.config.update(TESTING=True)
    first_response = []

    def run_first():
        first_response.append(app.test_client().post(
            "/api/recognize",
            data={
                "boardSize": "19",
                "image": (io.BytesIO(b"first"), "first.png"),
            },
            content_type="multipart/form-data",
        ))

    worker = threading.Thread(target=run_first)
    worker.start()
    assert entered.wait(timeout=2)
    busy = app.test_client().post(
        "/api/recognize",
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"second"), "second.png"),
        },
        content_type="multipart/form-data",
    )
    assert busy.status_code == 409
    assert busy.get_json()["reason"] == "busy"
    release.set()
    worker.join(timeout=5)
    assert first_response[0].status_code == 200


@pytest.mark.parametrize("board_size", ["9", "13", "0", "100000"])
def test_recognition_rejects_unsupported_sizes_before_inference(board_size):
    def must_not_run(*_args):
        raise AssertionError("recognizer must not run for unsupported board sizes")

    app, _ = create_app(
        engine=FakeEngine(),
        recognizer=must_not_run,
        recognizer_available=True,
    )
    app.config.update(TESTING=True)
    response = app.test_client().post(
        "/api/recognize",
        data={
            "boardSize": board_size,
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert "19x19" in response.get_json()["error"]


def test_recognition_rejects_wrong_sized_matrix_and_overrides_metadata():
    def wrong_size(_image, _size):
        return {"board": [[0] * 13 for _ in range(13)], "boardSize": 13}

    app, _ = create_app(
        engine=FakeEngine(),
        recognizer=wrong_size,
        recognizer_available=True,
    )
    app.config.update(TESTING=True)
    response = app.test_client().post(
        "/api/recognize",
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 422
    assert "exactly 19x19" in response.get_json()["error"]


def test_recognition_upload_limit_and_cross_origin_guard(local_app):
    app, _, _ = local_app
    client = app.test_client()

    oversized = client.post(
        "/api/recognize",
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"x" * (17 * 1024 * 1024)), "huge.png"),
        },
        content_type="multipart/form-data",
    )
    assert oversized.status_code == 413
    assert oversized.is_json
    assert "16 MB" in oversized.get_json()["error"]

    cross_origin = client.post(
        "/api/recognize",
        headers={"Origin": "https://malicious.example"},
        data={
            "boardSize": "19",
            "image": (io.BytesIO(b"fake-image"), "board.png"),
        },
        content_type="multipart/form-data",
    )
    assert cross_origin.status_code == 403


@pytest.mark.parametrize("transport", ["polling", "websocket"])
def test_live_socketio_transports(local_app, transport):
    """Threading mode supports both browser transport paths on a real port."""
    app, _, _ = local_app
    server = make_server("127.0.0.1", 0, app, threaded=True)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    result_ready = threading.Event()
    result = {}
    client = socketio_client.Client(logger=False, engineio_logger=False)

    @client.on(Events.ANALYSIS)
    def on_analysis(payload):
        result.update(payload)
        result_ready.set()

    try:
        client.connect(
            f"http://127.0.0.1:{server.server_port}",
            transports=[transport],
            wait_timeout=5,
        )
        assert client.transport() == transport
        client.emit(Events.ANALYZE, {"reqId": transport, "maxVisits": 8})
        assert result_ready.wait(5), f"No analysis event over {transport}"
        assert result["reqId"] == transport
        assert result["moves"][0]["move"] == "Q16"
    finally:
        if client.connected:
            client.disconnect()
        server.shutdown()
        server_thread.join(timeout=5)


def test_new_ai_request_cancels_and_suppresses_stale_analysis():
    class BlockingEngine(FakeEngine):
        def __init__(self):
            super().__init__()
            self.analysis_started = threading.Event()
            self.analysis_released = threading.Event()

        def terminate(self, query_id):
            super().terminate(query_id)
            if ":analysis:" in query_id:
                self.analysis_released.set()

        def analyze_position(self, **kwargs):
            query_id = kwargs["query_id"]
            if ":analysis:" in query_id:
                self.analysis_started.set()
                self.analysis_released.wait(timeout=5)
            return super().analyze_position(**kwargs)

    engine = BlockingEngine()
    app, _ = create_app(
        engine=engine,
        recognizer=lambda *_args: {},
        recognizer_available=False,
        socketio_async_mode="threading",
    )
    server = make_server("127.0.0.1", 0, app, threaded=True)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    ai_ready = threading.Event()
    received_analysis = []
    received_ai = []
    client = socketio_client.Client(logger=False, engineio_logger=False)
    client.on(Events.ANALYSIS, lambda payload: received_analysis.append(payload))

    def on_ai(payload):
        received_ai.append(payload)
        ai_ready.set()

    client.on(Events.AI_MOVE, on_ai)
    try:
        client.connect(f"http://127.0.0.1:{server.server_port}", wait_timeout=5)
        client.emit(Events.ANALYZE, {"reqId": "old", "maxVisits": 8})
        assert engine.analysis_started.wait(2)
        client.emit(Events.PLAY_AI, {"reqId": "new", "maxVisits": 8})
        assert ai_ready.wait(5)
        time.sleep(0.1)

        assert received_analysis == []
        assert [payload["reqId"] for payload in received_ai] == ["new"]
        assert any(":analysis:old" in query_id for query_id in engine.terminated)
        assert any(":ai:new" in call["query_id"] for call in engine.calls)
    finally:
        if client.connected:
            client.disconnect()
        server.shutdown()
        server_thread.join(timeout=5)


def test_practice_progress_is_saved_and_loaded_locally(local_app, tmp_path):
    app, _socketio, _engine = local_app
    app.extensions["practice_progress_store"].path = (
        tmp_path / "practice-progress.json"
    )
    client = app.test_client()
    record = {
        "attempts": 2,
        "successes": 1,
        "streak": 1,
        "lapses": 1,
        "hints_used": 2,
        "solved": True,
        "last_result": "success",
        "due_at": "2026-08-29T00:00:00.000Z",
        "updated_at": "2026-08-28T00:00:00.000Z",
    }

    saved = client.put("/api/practice-progress/liberty-01", json=record)
    assert saved.status_code == 200
    assert saved.get_json() == {"problem_id": "liberty-01", "record": record}

    loaded = client.get("/api/practice-progress")
    assert loaded.status_code == 200
    assert loaded.get_json() == {
        "schema": 1,
        "records": {"liberty-01": record},
    }
    assert (tmp_path / "practice-progress.json").is_file()


@pytest.mark.parametrize(
    ("problem_id", "record"),
    [
        ("../escape", {"attempts": 1}),
        ("liberty-01", {"attempts": True}),
        ("liberty-01", {"solved": "yes"}),
        ("liberty-01", {"unexpected": 1}),
        ("liberty-01", {"attempts": 1}),
        ("liberty-01", None),
    ],
)
def test_practice_progress_rejects_invalid_records(
    local_app, tmp_path, problem_id, record
):
    app, _socketio, _engine = local_app
    app.extensions["practice_progress_store"].path = (
        tmp_path / "practice-progress.json"
    )
    response = app.test_client().put(
        f"/api/practice-progress/{problem_id}", json=record
    )
    assert response.status_code in {400, 404, 405}
    if response.status_code == 400:
        assert response.get_json()["code"] == "invalid_practice_progress"


def test_practice_progress_refuses_cross_origin_writes(local_app, tmp_path):
    app, _socketio, _engine = local_app
    app.extensions["practice_progress_store"].path = (
        tmp_path / "practice-progress.json"
    )
    response = app.test_client().put(
        "/api/practice-progress/liberty-01",
        json={},
        headers={"Origin": "https://example.test"},
    )
    assert response.status_code == 403
    assert not (tmp_path / "practice-progress.json").exists()


def test_corrupt_practice_progress_is_never_overwritten(local_app, tmp_path):
    app, _socketio, _engine = local_app
    path = tmp_path / "practice-progress.json"
    path.write_text("{broken", encoding="utf-8")
    app.extensions["practice_progress_store"].path = path
    client = app.test_client()

    loaded = client.get("/api/practice-progress")
    assert loaded.status_code == 409
    assert loaded.get_json()["code"] == "practice_progress_unreadable"

    complete_record = {
        "attempts": 1,
        "successes": 1,
        "streak": 1,
        "lapses": 0,
        "hints_used": 0,
        "solved": True,
        "last_result": "success",
        "due_at": "2026-08-29T00:00:00.000Z",
        "updated_at": "2026-08-28T00:00:00.000Z",
    }
    saved = client.put(
        "/api/practice-progress/liberty-01", json=complete_record
    )
    assert saved.status_code == 409
    assert path.read_text(encoding="utf-8") == "{broken"
