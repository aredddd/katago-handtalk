"""Optional local CNN recognizer for 19x19 Go-board screenshots.

The two weight files are supplied by the user.  Importing this module never
loads either PyTorch or the models; that work is deferred until warm-up or the
first recognition request.
"""

from __future__ import annotations

import io
import importlib.util
import logging
import os
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from board_position import board_to_initial_stones


logger = logging.getLogger(__name__)

BOARD_SIZE = 19
DEFAULT_IMAGE_SIZE = 1024
GRID_FRACTION = 0.80
MAX_DETECTION_SIDE = 1600
MAX_IMAGE_PIXELS = 40_000_000
STONE_INPUT_SIZE = int(DEFAULT_IMAGE_SIZE * GRID_FRACTION / (BOARD_SIZE - 1))
STONE_BATCH_SIZE = BOARD_SIZE * BOARD_SIZE
SECOND_PASS_SCORE_THRESHOLD = 0.70

_project_root = Path(__file__).resolve().parent.parent
_models_root = _project_root / "models"

_models = None
_device = None
_model_lock = threading.Lock()
_inference_lock = threading.Lock()
_warmup_lock = threading.Lock()
_warmup_complete = threading.Event()


def _model_paths():
    """Return configured model paths, preferring the new directory layout."""
    preferred = _models_root / "vision"
    legacy = _models_root / "image2sgf"
    preferred_pair = (preferred / "board.pth", preferred / "stone.pth")
    legacy_pair = (legacy / "board.pth", legacy / "stone.pth")
    if all(path.is_file() for path in preferred_pair):
        default_pair = preferred_pair
    elif all(path.is_file() for path in legacy_pair):
        default_pair = legacy_pair
    else:
        default_pair = preferred_pair if preferred.is_dir() else legacy_pair

    def configured(name, fallback):
        value = os.environ.get(name)
        if not value:
            return fallback
        path = Path(value).expanduser()
        return path if path.is_absolute() else (_project_root / path)

    return (
        configured("KATAGO_VISION_BOARD_MODEL", default_pair[0]),
        configured("KATAGO_VISION_STONE_MODEL", default_pair[1]),
    )


def _dependencies_available():
    """Check optional modules without importing PyTorch or initializing CUDA."""
    return all(importlib.util.find_spec(name) is not None for name in (
        "cv2", "torch", "torchvision"
    ))


def is_available():
    """Return whether both user weights and the optional runtime are present."""
    board_path, stone_path = _model_paths()
    return board_path.is_file() and stone_path.is_file() and _dependencies_available()


def _checkpoint_state_dict(torch, path, device):
    try:
        checkpoint = torch.load(path, map_location=device, weights_only=True)
    except TypeError:  # PyTorch before weights_only was introduced.
        checkpoint = torch.load(path, map_location=device)
    if isinstance(checkpoint, dict):
        for key in ("state_dict", "model_state_dict", "model"):
            candidate = checkpoint.get(key)
            if isinstance(candidate, dict):
                checkpoint = candidate
                break
    if not isinstance(checkpoint, dict):
        raise ValueError(f"Model checkpoint does not contain a state dict: {path}")
    if checkpoint and all(str(key).startswith("module.") for key in checkpoint):
        checkpoint = {str(key)[7:]: value for key, value in checkpoint.items()}
    return checkpoint


def _load_models():
    """Construct and load the optional models once."""
    global _models, _device
    if _models is not None:
        return _models
    with _model_lock:
        if _models is not None:
            return _models
        board_path, stone_path = _model_paths()
        if not board_path.is_file() or not stone_path.is_file():
            raise RuntimeError("Vision model files board.pth and stone.pth are required")

        import torch
        from torchvision.models import efficientnet_b3
        from torchvision.models.detection import fcos_resnet50_fpn

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        board_model = fcos_resnet50_fpn(
            weights=None,
            weights_backbone=None,
            num_classes=5,
            detections_per_img=8,
            score_thresh=0.05,
        )
        stone_model = efficientnet_b3(weights=None, num_classes=6)
        board_model.load_state_dict(_checkpoint_state_dict(torch, board_path, device))
        stone_model.load_state_dict(_checkpoint_state_dict(torch, stone_path, device))
        board_model.to(device).eval()
        stone_model.to(device).eval()
        _device = device
        _models = (board_model, stone_model)
        logger.info("Local vision models loaded on %s", device)
        return _models


def _run_warmup_inference(board_model, stone_model):
    import torch

    device = _device or next(board_model.parameters()).device
    with torch.inference_mode():
        board_model([torch.zeros((3, 512, 512), dtype=torch.float32, device=device)])
        stone_model(torch.zeros((1, 3, STONE_INPUT_SIZE, STONE_INPUT_SIZE),
                                dtype=torch.float32, device=device))
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def _warm_up_locked():
    if _warmup_complete.is_set():
        return True
    with _warmup_lock:
        if _warmup_complete.is_set():
            return True
        board_model, stone_model = _load_models()
        _run_warmup_inference(board_model, stone_model)
        _warmup_complete.set()
        return True


def warm_up_recognizer():
    """Run one representative inference, at most once after a successful run."""
    if not is_available():
        return False
    try:
        with _inference_lock:
            return _warm_up_locked()
    except Exception:
        logger.exception("Local vision recognizer warm-up failed")
        return False


class NpBoxPosition:
    """Precompute square crop boxes centred on the rectified grid points."""

    def __init__(self, width=DEFAULT_IMAGE_SIZE, size=BOARD_SIZE):
        self.width = float(width)
        self.size = int(size)
        self.margin = self.width * (1.0 - GRID_FRACTION) / 2.0
        self.grid_size = self.width * GRID_FRACTION / (self.size - 1)
        half = self.grid_size / 2.0
        # The published checkpoints were trained against integer pixel-centre
        # crops.  Keep that geometry stable even though the ideal 80% grid
        # spacing is fractional at 1024 px.
        centres = np.asarray([
            int(self.margin + index * self.grid_size)
            for index in range(self.size)
        ], dtype=np.float32)
        self._boxes = np.empty((self.size, self.size, 4), dtype=np.float32)
        for row, y in enumerate(centres):
            for column, x in enumerate(centres):
                self._boxes[row, column] = (x - half, y - half, x + half, y + half)

    def __getitem__(self, index):
        return self._boxes[index]


def expand_image(image):
    """Pad to a square with a neutral background without scaling content."""
    width, height = image.size
    side = max(width, height)
    x_offset = (side - width) // 2
    y_offset = (side - height) // 2
    expanded = Image.new("RGB", (side, side), (128, 128, 128))
    expanded.paste(image, (x_offset, y_offset))
    return expanded, x_offset, y_offset


def _image_tensor(image, device):
    import torch

    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).permute(2, 0, 1).contiguous().to(device)


def _detect_corners(model, image):
    import torch
    from torchvision.ops import nms

    device = _device or next(model.parameters()).device
    with torch.inference_mode():
        output = model([_image_tensor(image, device)])[0]
    keep = nms(output["boxes"], output["scores"], 0.10)
    boxes = output["boxes"].detach()[keep].float().cpu().numpy()
    labels = output["labels"].detach()[keep].cpu().numpy()
    scores = output["scores"].detach()[keep].float().cpu().numpy()

    points = []
    selected_scores = []
    for label in range(1, 5):  # top-left, top-right, bottom-left, bottom-right
        indices = np.flatnonzero(labels == label)
        if not len(indices):
            raise ValueError(f"Board corner {label} was not detected")
        index = int(indices[np.argmax(scores[indices])])
        x1, y1, _x2, _y2 = boxes[index]
        # The compatible corner checkpoints encode the grid intersection at
        # the box origin. Selecting the highest-scoring origin preserves that
        # checkpoint contract while keeping the detector implementation local.
        points.append((x1, y1))
        selected_scores.append(float(scores[index]))
    return np.asarray(points, dtype=np.float32), selected_scores


def perspective_correct(model, image, expand=True):
    """Detect four labelled grid corners and rectify them into a 1024px square."""
    import cv2

    detection_image = image
    x_offset = y_offset = 0
    if expand:
        detection_image, x_offset, y_offset = expand_image(image)
    points, scores = _detect_corners(model, detection_image)
    points[:, 0] -= x_offset
    points[:, 1] -= y_offset
    grid = NpBoxPosition()
    margin = float(int(grid.margin))
    far = float(int(grid.margin + (BOARD_SIZE - 1) * grid.grid_size))
    destination = np.asarray([
        (margin, margin),
        (far, margin),
        (margin, far),
        (far, far),
    ], dtype=np.float32)
    # Labels and destinations share the same TL, TR, BL, BR correspondence.
    transform = cv2.getPerspectiveTransform(points, destination)
    source_array = np.asarray(image, dtype=np.uint8)
    corrected = cv2.warpPerspective(
        source_array,
        transform,
        (DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    return Image.fromarray(corrected, mode="RGB"), points, scores


def _expected_rectified_corners():
    grid = NpBoxPosition()
    margin = float(int(grid.margin))
    far = float(int(grid.margin + (BOARD_SIZE - 1) * grid.grid_size))
    return np.asarray([
        (margin, margin), (far, margin), (margin, far), (far, far)
    ], dtype=np.float32)


def _second_pass_geometry_is_plausible(points):
    points = np.asarray(points, dtype=np.float32)
    if points.ndim != 2 or points.shape[0] != 4 or points.shape[1] < 2:
        return False
    tolerance = DEFAULT_IMAGE_SIZE * GRID_FRACTION / (BOARD_SIZE - 1) * 1.5
    return bool(np.all(np.linalg.norm(points[:, :2] - _expected_rectified_corners(), axis=1)
                       <= tolerance))


def _aggregate_marker_probabilities(probabilities):
    """Sum marker/no-marker variants into empty, black, and white classes."""
    probabilities = np.asarray(probabilities, dtype=np.float32)
    if probabilities.ndim != 2 or probabilities.shape[1] != 6:
        raise ValueError("Stone probabilities must have shape (N, 6)")
    return probabilities.reshape(-1, 3, 2).sum(axis=2)


def classify_stones(model, image):
    """Classify all 361 intersections in top-row-first order."""
    import torch

    box_positions = NpBoxPosition()
    image_array = np.asarray(image, dtype=np.float32) / 255.0
    image_tensor = torch.from_numpy(image_array).permute(2, 0, 1).contiguous()
    tiles = torch.empty(
        (BOARD_SIZE * BOARD_SIZE, 3, STONE_INPUT_SIZE, STONE_INPUT_SIZE),
        dtype=torch.float32,
    )
    for row in range(BOARD_SIZE):
        for column in range(BOARD_SIZE):
            x1, y1, x2, y2 = box_positions[row][column].astype(int)
            tile = image_tensor[:, y1:y2, x1:x2]
            if tile.shape[1:] != (STONE_INPUT_SIZE, STONE_INPUT_SIZE):
                tile = torch.nn.functional.interpolate(
                    tile.unsqueeze(0),
                    size=(STONE_INPUT_SIZE, STONE_INPUT_SIZE),
                    mode="bilinear",
                    align_corners=False,
                ).squeeze(0)
            tiles[row * BOARD_SIZE + column] = tile

    device = _device or next(model.parameters()).device
    probabilities = []
    with torch.inference_mode():
        tiles = tiles.to(device)
        for start in range(0, len(tiles), STONE_BATCH_SIZE):
            logits = model(tiles[start:start + STONE_BATCH_SIZE])
            probabilities.append(torch.softmax(logits, dim=1).detach().float().cpu().numpy())
    colours = _aggregate_marker_probabilities(np.concatenate(probabilities, axis=0))
    order = np.sort(colours, axis=1)
    selected = colours.argmax(axis=1).astype(np.int64)
    confidence = order[:, -1]
    margin = order[:, -1] - order[:, -2]
    return (
        selected.reshape(BOARD_SIZE, BOARD_SIZE),
        confidence.reshape(BOARD_SIZE, BOARD_SIZE),
        margin.reshape(BOARD_SIZE, BOARD_SIZE),
    )


def _decode_image(image_bytes):
    if not isinstance(image_bytes, (bytes, bytearray, memoryview)) or not image_bytes:
        raise ValueError("Image data is empty")
    try:
        with Image.open(io.BytesIO(bytes(image_bytes))) as opened:
            width, height = opened.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError(f"Image exceeds the {MAX_IMAGE_PIXELS:,}-pixel limit")
            opened.load()
            image = ImageOps.exif_transpose(opened).convert("RGB")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Uploaded data is not a supported image") from exc
    if max(image.size) > MAX_DETECTION_SIDE:
        scale = MAX_DETECTION_SIDE / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    return image


def recognize_board_image(image_bytes, board_size=BOARD_SIZE):
    """Recognize a 19x19 board. Calls are serialized for bounded GPU usage."""
    if board_size != BOARD_SIZE:
        raise ValueError("Local vision recognition supports 19x19 boards only")
    with _inference_lock:
        return _recognize_board_image_locked(image_bytes)


def _recognize_board_image_locked(image_bytes):
    started = time.perf_counter()
    board_model, stone_model = _load_models()
    image = _decode_image(image_bytes)
    detection_started = time.perf_counter()
    corrected, source_corners, source_scores = perspective_correct(board_model, image)
    source_confidence = min(source_scores)
    rectified_scores = list(source_scores)

    if source_confidence < SECOND_PASS_SCORE_THRESHOLD:
        try:
            second_corrected, second_corners, second_scores = perspective_correct(
                board_model, corrected, expand=False
            )
            if (_second_pass_geometry_is_plausible(second_corners) and
                    sum(second_scores) > sum(rectified_scores)):
                corrected = second_corrected
                rectified_scores = list(second_scores)
        except (KeyError, ValueError):
            logger.info("Second-pass board geometry was unavailable", exc_info=True)
    detection_seconds = time.perf_counter() - detection_started

    classification_started = time.perf_counter()
    board, cell_confidence, cell_margin = classify_stones(stone_model, corrected)
    classification_seconds = time.perf_counter() - classification_started
    uncertain = []
    for row, column in np.argwhere(
        (cell_confidence < 0.75) | (cell_margin < 0.20)
    ):
        uncertain.append({
            "row": int(row),
            "col": int(column),
            "confidence": round(float(cell_confidence[row, column]), 3),
            "margin": round(float(cell_margin[row, column]), 3),
        })
    black_count = int(np.count_nonzero(board == 1))
    white_count = int(np.count_nonzero(board == 2))
    elapsed = time.perf_counter() - started
    board_list = board.tolist()

    result = {
        "board": board_list,
        "boardSize": BOARD_SIZE,
        "initialStones": board_to_initial_stones(board_list),
        "method": "local-cnn",
        "confidence": round(float(min(source_confidence, np.quantile(cell_confidence, 0.10))), 3),
        "source_confidence": round(float(source_confidence), 3),
        "rectified_confidence": round(float(min(rectified_scores)), 3),
        "stone_confidence": round(float(np.quantile(cell_confidence, 0.10)), 3),
        "corners_score": [round(float(score), 3) for score in source_scores],
        "rectified_corners_score": [round(float(score), 3) for score in rectified_scores],
        "cell_confidence": np.round(cell_confidence.astype(float), 3).tolist(),
        "cell_margin": np.round(cell_margin.astype(float), 3).tolist(),
        "uncertain_points": uncertain,
        "time": float(elapsed),
        "stats": {
            "empty": int(board.size - black_count - white_count),
            "black": black_count,
            "white": white_count,
            "detection_seconds": float(detection_seconds),
            "classification_seconds": float(classification_seconds),
        },
    }
    _warmup_complete.set()
    return result
