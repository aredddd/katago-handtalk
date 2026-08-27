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


def test_marker_variants_are_aggregated_before_choosing_stone_colour():
    probabilities = np.array([
        # No individual empty label wins, but the two empty variants do.
        [0.30, 0.29, 0.40, 0.00, 0.01, 0.00],
        # White marker/no-marker probabilities form the strongest colour.
        [0.01, 0.01, 0.20, 0.19, 0.31, 0.28],
    ], dtype=np.float32)

    colours = recognizer._aggregate_marker_probabilities(probabilities)

    assert colours.shape == (2, 3)
    assert colours.argmax(axis=1).tolist() == [0, 2]
    assert colours[0].tolist() == pytest.approx([0.59, 0.40, 0.01])


def test_warm_up_runs_representative_inference_only_once(monkeypatch):
    complete = threading.Event()
    calls = []
    monkeypatch.setattr(recognizer, "NOWORD_AVAILABLE", True)
    monkeypatch.setattr(recognizer, "_warmup_complete", complete)
    monkeypatch.setattr(recognizer, "_load_models", lambda: ("board", "stone"))
    monkeypatch.setattr(
        recognizer,
        "_run_warmup_inference",
        lambda board, stone: calls.append((board, stone)),
    )

    assert recognizer.warm_up_recognizer() is True
    assert recognizer.warm_up_recognizer() is True
    assert calls == [("board", "stone")]


def test_wide_image_padding_uses_neutral_background_without_shrinking_content():
    source = Image.new("RGB", (1000, 500), (24, 96, 180))

    expanded, x_offset, y_offset = recognizer.expand_image(source)

    assert expanded.size == (1000, 1000)
    assert (x_offset, y_offset) == (0, 250)
    assert expanded.getpixel((0, 0)) == (128, 128, 128)


def test_second_pass_must_remain_close_to_rectified_grid():
    box_pos = recognizer.NpBoxPosition(width=recognizer.DEFAULT_IMAGE_SIZE, size=19)
    expected = np.array([
        [*box_pos[18][0][:2], 0, 0],
        [*box_pos[18][18][:2], 0, 0],
        [*box_pos[0][0][:2], 0, 0],
        [*box_pos[0][18][:2], 0, 0],
    ], dtype=np.float32)

    assert recognizer._second_pass_geometry_is_plausible(expected)
    expected[0, 0] += box_pos.grid_size * 2
    assert not recognizer._second_pass_geometry_is_plausible(expected)


def test_second_pass_never_overwrites_source_confidence(monkeypatch):
    monkeypatch.setattr(recognizer, "_load_models", lambda: (object(), object()))
    corrected = Image.new("RGB", (1024, 1024), "white")
    box_pos = recognizer.NpBoxPosition(width=recognizer.DEFAULT_IMAGE_SIZE, size=19)
    plausible_boxes = np.array([
        [*box_pos[18][0][:2], 0, 0],
        [*box_pos[18][18][:2], 0, 0],
        [*box_pos[0][0][:2], 0, 0],
        [*box_pos[0][18][:2], 0, 0],
    ], dtype=np.float32)
    passes = iter([
        (corrected, plausible_boxes, [0.50, 0.60, 0.70, 0.80]),
        (corrected, plausible_boxes, [0.95, 0.95, 0.95, 0.95]),
    ])
    monkeypatch.setattr(
        recognizer,
        "perspective_correct",
        lambda *_args, **_kwargs: next(passes),
    )
    monkeypatch.setattr(
        recognizer,
        "classify_stones",
        lambda *_args: (
            np.zeros((19, 19), dtype=np.int64),
            np.ones((19, 19), dtype=np.float32),
            np.ones((19, 19), dtype=np.float32),
        ),
    )
    encoded = io.BytesIO()
    Image.new("RGB", (1200, 800), "white").save(encoded, format="PNG")

    result = recognizer.recognize_board_noword(encoded.getvalue(), 19)

    assert result["source_confidence"] == 0.50
    assert result["confidence"] == 0.50
    assert result["rectified_confidence"] == 0.95
    assert result["corners_score"] == [0.50, 0.60, 0.70, 0.80]
