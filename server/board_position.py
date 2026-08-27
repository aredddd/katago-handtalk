"""Lightweight helpers shared by the optional screenshot recognizer."""

GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"


def board_to_initial_stones(board):
    """Convert a top-to-bottom 0/1/2 matrix to KataGo initial stones."""
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
                stones.append([
                    "B" if value == 1 else "W",
                    f"{GTP_COLUMNS[column_index]}{size - row_index}",
                ])
    return stones
