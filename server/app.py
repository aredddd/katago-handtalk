"""
app.py — entry point for the KataGo HandTalk server.

The application is assembled by app_factory.create_app(); this module only
configures logging, builds the app, and (when run directly) starts the KataGo
engine and the server.
"""

import sys
import logging
import threading

from app_factory import create_app
from engine_lifecycle import start_engine
from config import KATAGO_PATH, MODEL_PATH, PORT

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# Built at import time so WSGI servers / tests can `from app import app`.
app, socketio = create_app()


if __name__ == "__main__":
    print("=" * 60)
    print("  KataGo HandTalk Server")
    print("=" * 60)
    print(f"  KataGo : {KATAGO_PATH}")
    print(f"  Model  : {MODEL_PATH}")
    print(f"  Port   : {PORT}")
    vision_available = bool(app.extensions.get("board_recognizer_available"))
    vision_warmup = app.extensions.get("board_recognizer_warmup")
    print(f"  Vision : {'available' if vision_available else 'optional / unavailable'}")
    print("=" * 60)

    engine = app.extensions["engine"]
    if start_engine(engine):
        if vision_available and callable(vision_warmup):
            threading.Thread(
                target=vision_warmup,
                daemon=True,
                name="recognizer-warmup",
            ).start()
        print(f"\n  Server running at http://localhost:{PORT}\n")
        # This edition has no account layer, so never expose it to the LAN by
        # default.  The browser and engine both run on the same machine.
        socketio.run(app, host="127.0.0.1", port=PORT, debug=False)
    else:
        print("\n  Engine failed to start — check configuration paths.")
        sys.exit(1)
