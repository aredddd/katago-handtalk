"""
noword/image2sgf CNN board recognizer.
Based on https://github.com/noword/image2sgf

Uses two pre-trained PyTorch models:
  - board.pth: FCOS ResNet50 FPN, detects the four board corners
  - stone.pth: EfficientNet B3, classifies each intersection (6 classes)

Stone classification label bits:
  bit 0:   marker present (digit / letter / geometric shape)
  bit 1-2: 00 = empty, 01 = black, 10 = white
  -> color = label >> 1: 0 = empty, 1 = black, 2 = white
"""

import os
import io
import time
import logging
import threading
import numpy as np
from PIL import Image
from collections import namedtuple

logger = logging.getLogger(__name__)

# ============== Constants ==============
DEFAULT_IMAGE_SIZE = 1024
MAX_INPUT_PIXELS = 40_000_000
MAX_DETECTION_SIDE = 1600
MODELS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models", "image2sgf"
)
BOARD_PTH = os.path.join(MODELS_DIR, "board.pth")
STONE_PTH = os.path.join(MODELS_DIR, "stone.pth")

# Lazy-loaded PyTorch
_torch = None
_torchvision = None
_cv2 = None
_board_model = None
_stone_model = None
_device = None
_model_load_lock = threading.Lock()
_inference_lock = threading.Lock()

Point = namedtuple('Point', ['x', 'y'])
GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"


def board_to_initial_stones(board):
    """
    Convert a top-to-bottom ``0/1/2`` board matrix to KataGo initial stones.

    The returned ``[["B", "D16"], ...]`` value can be copied directly into
    an ``analyze`` Socket.IO request as ``initialStones``.
    The side to move is deliberately not inferred from a still image.
    """
    size = len(board)
    if size < 1 or size > len(GTP_COLUMNS):
        raise ValueError(f"Unsupported board size: {size}")
    if any(not isinstance(row, (list, tuple)) or len(row) != size for row in board):
        raise ValueError("Board must be a square matrix")

    stones = []
    for row_index, row in enumerate(board):
        for column_index, value in enumerate(row):
            if value not in (0, 1, 2):
                raise ValueError(f"Invalid board value at ({row_index}, {column_index})")
            if value:
                color = "B" if value == 1 else "W"
                coordinate = f"{GTP_COLUMNS[column_index]}{size - row_index}"
                stones.append([color, coordinate])
    return stones


def _ensure_torch():
    """Lazy-import torch/torchvision to avoid slow startup."""
    global _torch, _torchvision
    if _torch is None:
        import torch
        import torchvision
        _torch = torch
        _torchvision = torchvision
    return _torch, _torchvision


def _ensure_cv2():
    """Lazy-import OpenCV so mocked recognition tests stay lightweight."""
    global _cv2
    if _cv2 is None:
        import cv2
        _cv2 = cv2
    return _cv2


def _get_device():
    """Return the compute device (CUDA if available)."""
    global _device
    if _device is None:
        torch, _ = _ensure_torch()
        if torch.cuda.is_available():
            _device = torch.device('cuda')
            logger.info(f"noword CNN using CUDA: {torch.cuda.get_device_name(0)}")
        else:
            _device = torch.device('cpu')
            logger.info("noword CNN using CPU")
    return _device


def _load_models():
    """Load the board + stone models (only on first call)."""
    global _board_model, _stone_model
    if _board_model is not None and _stone_model is not None:
        return _board_model, _stone_model
    with _model_load_lock:
        if _board_model is not None and _stone_model is not None:
            return _board_model, _stone_model

        torch, torchvision = _ensure_torch()
        device = _get_device()
        t0 = time.time()
        board_model = None
        stone_model = None

        # Build into local variables. Globals become visible only after both
        # models are fully loaded, moved to the device, and in eval mode.
        if os.path.exists(BOARD_PTH):
            board_model = torchvision.models.detection.fcos_resnet50_fpn(
                num_classes=4 + 1,
                detections_per_img=8,
                score_thresh=0.05,
                weights_backbone=None
            )
            state = torch.load(BOARD_PTH, map_location='cpu', weights_only=True)
            board_model.load_state_dict(state)
            board_model.to(device)
            board_model.eval()
            logger.info(f"board.pth loaded ({time.time() - t0:.1f}s)")
        else:
            logger.warning(f"board.pth not found: {BOARD_PTH}")

        t1 = time.time()
        if os.path.exists(STONE_PTH):
            stone_model = torchvision.models.efficientnet_b3(num_classes=6)
            state = torch.load(STONE_PTH, map_location='cpu', weights_only=True)
            stone_model.load_state_dict(state)
            stone_model.to(device)
            stone_model.eval()
            logger.info(f"stone.pth loaded ({time.time() - t1:.1f}s)")
        else:
            logger.warning(f"stone.pth not found: {STONE_PTH}")

        _board_model = board_model
        _stone_model = stone_model
        logger.info(f"noword models loaded in {time.time() - t0:.1f}s")
        return _board_model, _stone_model


# ============== Geometry helpers ==============

class GridPosition:
    """Board grid position calculation (port of noword/image2sgf)."""

    def __init__(self, width, size=19, board_rate=0.8):
        self.width = width
        self.size = size
        self.board_rate = board_rate

        margin = width * (1 - board_rate) / 2
        self.grid_size = width * board_rate / (size - 1)
        self.half_grid_size = self.grid_size / 2

        # _grid_pos[row][col] = Point(x, y)
        # row 0 = bottom, row 18 = top (board coordinate system)
        self._grid_pos = []
        for row in range(size):
            row_pos = []
            for col in range(size):
                x = int(margin + col * self.grid_size)
                y = int(width - margin - row * self.grid_size)
                row_pos.append(Point(x, y))
            self._grid_pos.append(row_pos)

    def __getitem__(self, index):
        return self._grid_pos[index]


class BoxPosition(GridPosition):
    """Compute a bounding box for each intersection, on top of GridPosition."""

    def __init__(self, width, size=19, board_rate=0.8):
        super().__init__(width, size, board_rate)
        self._boxes = []
        for row in self._grid_pos:
            self._boxes.append([
                [
                    max(x - self.half_grid_size, 0),
                    max(y - self.half_grid_size, 0),
                    min(x + self.half_grid_size, width),
                    min(y + self.half_grid_size, width)
                ]
                for x, y in row
            ])

    def __getitem__(self, index):
        return self._boxes[index]


class NpBoxPosition(BoxPosition):
    """numpy version of BoxPosition."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._boxes = np.array(self._boxes)


# ============== Core functions ==============

def expand_image(pil_image):
    """Pad the image to a square (centered, grey background)."""
    w, h = pil_image.size
    size = max(w, h)
    new_image = Image.new('RGB', (size, size), (128, 128, 128))
    x_offset = (size - w) // 2
    y_offset = (size - h) // 2
    new_image.paste(pil_image, (x_offset, y_offset))
    return new_image, x_offset, y_offset


def detect_board_corners(board_model, image, expand=True):
    """
    Detect the four board corners with the FCOS model.
    Returns: (boxes[4,4], scores[4]) — the four corner bboxes and confidences.
    """
    torch, torchvision = _ensure_torch()
    device = _get_device()

    if isinstance(image, str):
        image = Image.open(image).convert('RGB')
    if image.mode != 'RGB':
        image = image.convert('RGB')

    if expand:
        img, x_offset, y_offset = expand_image(image)
    else:
        img = image
        x_offset = y_offset = 0

    T = _torchvision.transforms
    with torch.no_grad():
        tensor = T.ToTensor()(img).unsqueeze(0).to(device)
        target = board_model(tensor)[0]

    nms = torchvision.ops.nms(target['boxes'], target['scores'], 0.1)
    _boxes = target['boxes'].detach()[nms].cpu()
    _labels = target['labels'].detach()[nms].cpu()
    _scores = target['scores'].detach()[nms].cpu()

    if len(set(_labels.tolist())) < 4:
        raise ValueError(f"Only {len(set(_labels.tolist()))} corner(s) detected, need 4")

    boxes = np.zeros((4, 4))
    scores = [0] * 4
    for i, box in enumerate(_boxes):
        label = int(_labels[i]) - 1
        if 0 <= label < 4 and np.count_nonzero(boxes[label]) == 0:
            boxes[label] = box.numpy()
            scores[label] = float(_scores[i])

    if np.any(np.all(boxes == 0, axis=1)):
        raise ValueError("Could not detect all 4 corners")

    boxes[:, ::2] -= x_offset
    boxes[:, 1::2] -= y_offset

    return boxes, scores


def perspective_correct(board_model, img, expand=True):
    """
    Detect the corners and apply a perspective transform, producing a
    1024x1024 rectified board image.
    Returns: (corrected_image, boxes, scores)
    """
    cv2 = _ensure_cv2()
    boxes, scores = detect_board_corners(board_model, img, expand)
    box_pos = NpBoxPosition(width=DEFAULT_IMAGE_SIZE, size=19)

    startpoints = boxes[:, :2].tolist()
    endpoints = [
        box_pos[18][0][:2].tolist(),  # top left
        box_pos[18][18][:2].tolist(),  # top right
        box_pos[0][0][:2].tolist(),    # bottom left
        box_pos[0][18][:2].tolist()    # bottom right
    ]

    transform = cv2.getPerspectiveTransform(
        np.array(startpoints, np.float32),
        np.array(endpoints, np.float32)
    )
    _img = cv2.warpPerspective(
        np.array(img), transform,
        (DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_SIZE)
    )

    return Image.fromarray(_img), boxes, scores


def classify_stones(stone_model, corrected_image):
    """
    Split the rectified 1024x1024 image into a 19x19 grid and classify each
    cell with EfficientNet B3.
    Returns: results[19][19], each value = label (color = label >> 1).
    """
    torch, _ = _ensure_torch()
    device = _get_device()
    T = _torchvision.transforms

    box_pos = NpBoxPosition(width=DEFAULT_IMAGE_SIZE, size=19)
    img_tensor = T.ToTensor()(corrected_image)

    grid_h = int(box_pos.grid_size)
    imgs = torch.empty((19 * 19, 3, grid_h, grid_h))

    for y in range(19):
        for x in range(19):
            x0, y0, x1, y1 = box_pos[y][x].astype(int)
            tile = img_tensor[:, y0:y1, x0:x1]
            # Edge case: the tile may not be exactly grid_h x grid_h
            if tile.shape[1] != grid_h or tile.shape[2] != grid_h:
                tile = torch.nn.functional.interpolate(
                    tile.unsqueeze(0), size=(grid_h, grid_h),
                    mode='bilinear', align_corners=False
                ).squeeze(0)
            imgs[x + y * 19] = tile

    with torch.no_grad():
        imgs = imgs.to(device)
        results = stone_model(imgs).argmax(1).cpu()

    return results.reshape(19, 19)


# ============== Main entry point ==============

def recognize_board_noword(image_bytes, board_size=19):
    """Serialize GPU inference and reject unsupported sizes without allocating."""
    if board_size != 19:
        raise ValueError("noword CNN currently supports 19x19 boards only")
    with _inference_lock:
        return _recognize_board_noword_locked(image_bytes)


def _recognize_board_noword_locked(image_bytes):
    """
    Recognize a board with the noword/image2sgf CNN models.

    Args:
        image_bytes: raw image bytes
    Returns:
        dict: {
            "board": [[0,1,2,...], ...],  # 19x19, 0=empty 1=black 2=white
            "confidence": float,
            "method": "noword-cnn",
            "corners_score": [float, ...],
            "time": float
        }
    """
    t0 = time.time()

    try:
        board_model, stone_model = _load_models()
    except Exception as e:
        logger.error(f"Model loading failed: {e}")
        return {
            "board": [[0] * 19 for _ in range(19)],
            "confidence": 0,
            "method": "noword-cnn",
            "error": f"Model loading failed: {str(e)}"
        }

    if board_model is None or stone_model is None:
        return {
            "board": [[0] * 19 for _ in range(19)],
            "confidence": 0,
            "method": "noword-cnn",
            "error": "Model files missing (board.pth and stone.pth required)"
        }

    # Decode only within a hard pixel budget, then normalize the detector input
    # so a 4K/phone screenshot cannot turn into a multi-gigabyte GPU tensor.
    source_image = Image.open(io.BytesIO(image_bytes))
    width, height = source_image.size
    if width < 1 or height < 1 or width * height > MAX_INPUT_PIXELS:
        raise ValueError(
            f"Image dimensions are unsupported ({width}x{height}); "
            f"maximum is {MAX_INPUT_PIXELS:,} pixels"
        )
    source_image.thumbnail(
        (MAX_DETECTION_SIDE, MAX_DETECTION_SIDE),
        Image.Resampling.LANCZOS,
    )
    pil_image = source_image.convert('RGB')

    # Step 1: corner detection + perspective correction
    try:
        corrected, boxes, scores = perspective_correct(board_model, pil_image, expand=True)
    except Exception as e1:
        logger.warning(f"Detection with padding failed ({e1}); retrying without padding...")
        try:
            corrected, boxes, scores = perspective_correct(board_model, pil_image, expand=False)
        except Exception as e2:
            logger.error(f"Board corner detection failed: {e2}")
            return {
                "board": [[0] * 19 for _ in range(19)],
                "confidence": 0,
                "method": "noword-cnn",
                "error": f"Could not detect board corners: {str(e2)}"
            }

    corner_conf = min(scores)
    logger.info(f"Corner detection confidence: {[f'{s:.2f}' for s in scores]}")

    # If corner confidence is low, try a second pass
    if corner_conf < 0.7:
        try:
            corrected2, boxes2, scores2 = perspective_correct(board_model, corrected, expand=True)
            if sum(scores2) > sum(scores):
                corrected = corrected2
                scores = scores2
                logger.info(f"Second-pass improvement: {[f'{s:.2f}' for s in scores2]}")
        except Exception:
            pass  # keep the first-pass result if the second pass fails

    # Step 2: classify each intersection
    board_raw = classify_stones(stone_model, corrected)

    # Convert to the standard format.
    # board_raw = results.reshape(19, 19), results[y][x]
    #   where y is box_pos' row axis (y=0 bottom, y=18 top)
    #         x is box_pos' col axis (x=0 left, x=18 right)
    # Our format: board[row][col], row 0 = top
    # -> board[r][c] = results[18-r][c] >> 1
    board = []
    for y in range(18, -1, -1):  # y=18 (top) -> y=0 (bottom)
        row = []
        for x in range(19):
            color = int(board_raw[y][x]) >> 1  # results[y][x] maps to box_pos[y][x]
            row.append(color)
        board.append(row)

    elapsed = time.time() - t0
    # The weakest corner is the limiting factor for perspective correction.
    # An average could hide one badly detected corner.
    confidence = min(scores)

    # Stats
    black_count = sum(1 for row in board for c in row if c == 1)
    white_count = sum(1 for row in board for c in row if c == 2)
    logger.info(f"noword CNN done: {black_count} black, {white_count} white, "
                f"confidence {confidence:.2f}, {elapsed:.1f}s")

    return {
        "board": board,
        "boardSize": 19,
        "initialStones": board_to_initial_stones(board),
        "confidence": round(confidence, 3),
        "method": "noword-cnn",
        "corners_score": [round(s, 3) for s in scores],
        "time": round(elapsed, 2),
        "stats": {
            "black": black_count,
            "white": white_count,
            "empty": 361 - black_count - white_count
        }
    }


# ============== Availability check ==============

def is_available():
    """Return True if the noword CNN recognizer is available."""
    return os.path.exists(BOARD_PTH) and os.path.exists(STONE_PTH)


NOWORD_AVAILABLE = is_available()

if NOWORD_AVAILABLE:
    logger.info("noword CNN recognizer: available (board.pth + stone.pth)")
else:
    missing = []
    if not os.path.exists(BOARD_PTH):
        missing.append("board.pth")
    if not os.path.exists(STONE_PTH):
        missing.append("stone.pth")
    logger.info(f"noword CNN recognizer: unavailable, missing {', '.join(missing)}")
