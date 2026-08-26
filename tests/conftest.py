"""Test bootstrap for the repository's flat ``server`` module layout."""

import sys
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
