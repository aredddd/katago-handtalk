"""Safety and resource-bound contracts for the single-machine build."""

import io
import threading
import time

import numpy as np
import pytest
from PIL import Image

import noword_recognizer as recognizer
from circuit_breaker import CircuitBreaker, State
from exceptions import EngineQueryError, EngineTimeoutError


def test_query_errors_do_not_open_the_engine_circuit():
    breaker = CircuitBreaker(
        threshold=3,
        excluded_exceptions=(EngineQueryError,),
    )

    for _ in range(3):
        with pytest.raises(EngineQueryError):
            breaker.call(lambda: (_ for _ in ()).throw(EngineQueryError("bad position")))

    assert breaker.state is State.CLOSED
    assert breaker.get_status()["failure_count"] == 0

    for _ in range(3):
        with pytest.raises(EngineTimeoutError):
            breaker.call(lambda: (_ for _ in ()).throw(EngineTimeoutError("slow")))
    assert breaker.state is State.OPEN


def test_query_error_during_half_open_closes_the_responsive_circuit():
    breaker = CircuitBreaker(
        threshold=1,
        reset_timeout=0,
        excluded_exceptions=(EngineQueryError,),
    )
    with pytest.raises(EngineTimeoutError):
        breaker.call(lambda: (_ for _ in ()).throw(EngineTimeoutError("slow")))
    assert breaker.state is State.OPEN

    with pytest.raises(EngineQueryError):
        breaker.call(lambda: (_ for _ in ()).throw(EngineQueryError("bad position")))

    assert breaker.state is State.CLOSED
    assert breaker.call(lambda: "healthy") == "healthy"


def test_recognizer_rejects_unsupported_size_without_allocating():
    with pytest.raises(ValueError, match="19x19"):
        recognizer.recognize_board_noword(b"not-an-image", 100_000)


def test_large_screenshot_is_downscaled_before_detection(monkeypatch):
    seen = {}
    monkeypatch.setattr(recognizer, "_load_models", lambda: (object(), object()))

    def fake_perspective(_model, image, expand=True):
        seen["size"] = image.size
        return Image.new("RGB", (1024, 1024)), None, [0.95, 0.96, 0.97, 0.98]

    monkeypatch.setattr(recognizer, "perspective_correct", fake_perspective)
    monkeypatch.setattr(
        recognizer,
        "classify_stones",
        lambda _model, _image: np.zeros((19, 19), dtype=np.int64),
    )

    source = Image.new("RGB", (4032, 3024), "white")
    encoded = io.BytesIO()
    source.save(encoded, format="JPEG", quality=80)

    result = recognizer.recognize_board_noword(encoded.getvalue(), 19)

    assert max(seen["size"]) == recognizer.MAX_DETECTION_SIDE
    assert result["confidence"] == 0.95


def test_recognition_gpu_work_is_single_flight(monkeypatch):
    active = 0
    peak = 0
    state_lock = threading.Lock()
    release = threading.Event()

    def fake_locked(_image_bytes):
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        release.wait(timeout=2)
        with state_lock:
            active -= 1
        return {"board": [[0] * 19 for _ in range(19)]}

    monkeypatch.setattr(recognizer, "_recognize_board_noword_locked", fake_locked)
    threads = [
        threading.Thread(target=recognizer.recognize_board_noword, args=(b"x", 19))
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    time.sleep(0.05)
    release.set()
    for thread in threads:
        thread.join(timeout=2)

    assert all(not thread.is_alive() for thread in threads)
    assert peak == 1
