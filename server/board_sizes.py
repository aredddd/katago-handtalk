"""Shared board-size contracts for analysis and screenshot recognition."""

SUPPORTED_BOARD_SIZES = (9, 13, 19)
RECOGNITION_BOARD_SIZES = (19,)
DEFAULT_BOARD_SIZE = 19


class InvalidBoardSizeError(ValueError):
    """Raised when an analysis request names an unsupported board size."""

    code = "invalid_board_size"
    field = "boardSize"

    def __init__(self):
        supported = ", ".join(str(size) for size in SUPPORTED_BOARD_SIZES)
        super().__init__(f"Invalid boardSize: expected one of {supported}")


def validate_board_size(value) -> int:
    """
    Return *value* as a supported square board size.

    Socket.IO payloads are JSON, so require a real JSON integer here.  In
    particular, ``bool`` must be rejected explicitly because Python otherwise
    treats it as a subclass of ``int``.  Strings and integral floats are also
    rejected rather than silently changing a malformed client request.
    """
    if type(value) is not int or value not in SUPPORTED_BOARD_SIZES:
        raise InvalidBoardSizeError()
    return value
