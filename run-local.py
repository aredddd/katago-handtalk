"""Local-only entry point for the portable beginner build.

This wrapper intentionally lives outside ``server``: the upstream server code
remains untouched while this branch always binds to the loopback interface and
opens the UI after the engine is ready.
"""

from __future__ import annotations

import os
import sys
import logging
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SERVER_DIR = ROOT / "server"
HOST = "127.0.0.1"

sys.path.insert(0, str(SERVER_DIR))
os.chdir(ROOT)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

from app_factory import create_app  # noqa: E402
from config import KATAGO_PATH, MODEL_PATH, PORT  # noqa: E402
from engine_lifecycle import start_engine  # noqa: E402
from noword_recognizer import NOWORD_AVAILABLE  # noqa: E402


def _open_browser_when_ready(url: str) -> None:
    """Poll the loopback URL and open it once, after Flask is accepting HTTP."""
    if os.environ.get("KATAGO_WEB_NO_BROWSER", "").lower() in {"1", "true", "yes"}:
        return
    for _ in range(120):
        try:
            with urllib.request.urlopen(url, timeout=1):
                webbrowser.open(url)
                return
        except Exception:
            time.sleep(0.5)


def main() -> int:
    url = f"http://{HOST}:{PORT}"
    app, socketio = create_app()
    engine = app.extensions["engine"]

    print("=" * 62)
    print("  KataGo Web · 新手本地版")
    print("=" * 62)
    print(f"  地址   : {url}（仅本机可访问）")
    print(f"  KataGo : {KATAGO_PATH}")
    print(f"  模型   : {MODEL_PATH}")
    print(f"  截图识别: {'可用' if NOWORD_AVAILABLE else '模型缺失'}")
    print("  退出   : 在此窗口按 Ctrl+C")
    print("=" * 62, flush=True)

    if not start_engine(engine):
        print("\nKataGo 启动失败，请运行 setup-local.ps1 检查配置。", file=sys.stderr)
        return 1

    threading.Thread(
        target=_open_browser_when_ready,
        args=(url,),
        daemon=True,
        name="open-local-browser",
    ).start()

    try:
        socketio.run(
            app,
            host=HOST,
            port=PORT,
            debug=False,
            use_reloader=False,
        )
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
