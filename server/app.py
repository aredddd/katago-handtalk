"""
app.py — entry point for the KataGo Web server.

The application is assembled by app_factory.create_app(); this module only
configures logging, builds the app, and (when run directly) starts the KataGo
engine and the server.
"""

import sys
import logging

from app_factory import create_app
from engine_lifecycle import start_engine
from config import KATAGO_PATH, MODEL_PATH, PORT
from noword_recognizer import NOWORD_AVAILABLE

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# Built at import time so WSGI servers / tests can `from app import app`.
app, socketio = create_app()


if __name__ == "__main__":
    print("=" * 60)
    print("  KataGo Web Server")
    print("=" * 60)
    print(f"  KataGo : {KATAGO_PATH}")
    print(f"  Model  : {MODEL_PATH}")
    print(f"  Port   : {PORT}")
    print(f"  Vision : {'noword CNN available' if NOWORD_AVAILABLE else 'model not found'}")
    print("=" * 60)

    engine = app.extensions["engine"]
    if start_engine(engine):
        print(f"\n  Server running at http://localhost:{PORT}\n")
        socketio.run(app, host="0.0.0.0", port=PORT, debug=False)
    else:
        print("\n  Engine failed to start — check configuration paths.")
        sys.exit(1)
