"""
KataGo Web Server
Flask + SocketIO 后端，提供 WebSocket API 连接 KataGo
"""

import os
import sys
import json
import logging
from flask import Flask, render_template, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS

from katago_engine import KataGoEngine
from noword_recognizer import recognize_board_noword, NOWORD_AVAILABLE
from config import (
    KATAGO_PATH, MODEL_PATH, CONFIG_PATH,
    PORT, DEFAULT_MAX_VISITS, QUICK_MAX_VISITS,
)
from events import Events

# ============== 初始化 ==============
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

# Flask 应用
app = Flask(
    __name__,
    static_folder=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"),
    static_url_path=""
)
app.config["SECRET_KEY"] = "katago-web-secret-key"
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# KataGo 引擎
engine = None


def init_engine():
    """初始化 KataGo 引擎"""
    global engine
    engine = KataGoEngine(KATAGO_PATH, MODEL_PATH, CONFIG_PATH)

    if not os.path.isfile(KATAGO_PATH):
        logger.error(f"KataGo 可执行文件不存在: {KATAGO_PATH}")
        logger.error("请先运行 setup.ps1 或手动下载 KataGo")
        return False

    if not os.path.isfile(MODEL_PATH):
        logger.error(f"KataGo 模型文件不存在: {MODEL_PATH}")
        logger.error("请先运行 setup.ps1 或手动下载模型权重")
        return False

    if engine.start():
        logger.info("KataGo 引擎启动成功！")
        return True
    else:
        logger.error("KataGo 引擎启动失败")
        return False


# ============== HTTP 路由 ==============

@app.route("/")
def index():
    """主页"""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/status")
def status():
    """引擎状态"""
    return jsonify({
        "running": engine.is_running() if engine else False,
        "katago_path": KATAGO_PATH,
        "model_path": MODEL_PATH,
    })


@app.route("/api/recognize", methods=["POST"])
def api_recognize():
    """上传图片识别棋盘（noword CNN）"""
    if "image" not in request.files:
        return jsonify({"error": "没有上传图片"}), 400

    file = request.files["image"]
    image_bytes = file.read()
    board_size = int(request.form.get("boardSize", 19))

    if not NOWORD_AVAILABLE:
        return jsonify({"error": "棋盘识别模型未找到，请检查 models/image2sgf/ 目录"}), 500

    logger.info("使用 noword CNN 识别棋盘")
    result = recognize_board_noword(image_bytes, board_size)
    return jsonify(result)





# ============== WebSocket 事件 ==============

@socketio.on("connect")
def handle_connect():
    """客户端连接"""
    logger.info(f"客户端连接: {request.sid}")
    emit(Events.STATUS, {"running": engine.is_running() if engine else False})


@socketio.on("disconnect")
def handle_disconnect():
    """客户端断开"""
    logger.info(f"客户端断开: {request.sid}")


def _run_analysis(data, default_max_visits):
    """Shared analysis logic used by both analyze and quick_analyze handlers."""
    if not engine or not engine.is_running():
        emit(Events.ERROR, {"message": "KataGo 引擎未运行"})
        return

    moves          = data.get("moves", [])
    board_size     = data.get("boardSize", 19)
    komi           = data.get("komi", 7.5)
    max_visits     = data.get("maxVisits", default_max_visits)
    include_ownership = data.get("includeOwnership", False)
    initial_stones = data.get("initialStones", None)
    initial_player = data.get("initialPlayer", None)

    logger.info(f"\u5206\u6790\u8bf7\u6c42: {len(moves)} \u6b65\u68cb, "
                f"initialStones={len(initial_stones) if initial_stones else 0}, "
                f"initialPlayer={initial_player}, "
                f"visits={max_visits}")

    result = engine.analyze_position(
        moves=moves,
        board_size=board_size,
        komi=komi,
        max_visits=max_visits,
        include_ownership=include_ownership,
        initial_stones=initial_stones,
        initial_player=initial_player,
    )

    if result:
        emit(Events.ANALYSIS, result)
    else:
        emit(Events.ERROR, {"message": "分析失败"})


@socketio.on(Events.ANALYZE)
def handle_analyze(data):
    """处理分析请求 — data: {moves, boardSize, komi, maxVisits, includeOwnership, initialStones, initialPlayer}"""
    _run_analysis(data, DEFAULT_MAX_VISITS)


@socketio.on(Events.QUICK_ANALYZE)
def handle_quick_analyze(data):
    """快速分析 — 较少搜索次数（默认 QUICK_MAX_VISITS）"""
    _run_analysis(data, QUICK_MAX_VISITS)


@socketio.on(Events.PLAY_AI)
def handle_play_ai(data):
    """让 AI 下一步棋 — data: {moves, boardSize, komi, maxVisits, initialStones, initialPlayer}"""
    if not engine or not engine.is_running():
        emit(Events.ERROR, {"message": "KataGo 引擎未运行"})
        return

    moves          = data.get("moves", [])
    board_size     = data.get("boardSize", 19)
    komi           = data.get("komi", 7.5)
    max_visits     = data.get("maxVisits", 800)
    initial_stones = data.get("initialStones", None)
    initial_player = data.get("initialPlayer", None)

    result = engine.analyze_position(
        moves=moves,
        board_size=board_size,
        komi=komi,
        max_visits=max_visits,
        initial_stones=initial_stones,
        initial_player=initial_player,
    )

    if result and result["moves"]:
        best_move      = result["moves"][0]
        current_player = result["currentPlayer"]
        emit(Events.AI_MOVE, {
            "move":      best_move["move"],
            "color":     current_player,
            "winrate":   best_move["winrate"],
            "scoreLead": best_move["scoreLead"],
            "visits":    best_move["visits"],
            "pv":        best_move["pv"],
        })
    else:
        emit(Events.ERROR, {"message": "AI 无法生成走法"})


# ============== 启动 ==============

if __name__ == "__main__":
    print("=" * 60)
    print("  KataGo Web Server")
    print("=" * 60)
    print(f"  KataGo:  {KATAGO_PATH}")
    print(f"  Model:   {MODEL_PATH}")
    print(f"  Config:  {CONFIG_PATH}")
    print(f"  Port:    {PORT}")
    print(f"  识别:    {'✅ noword CNN 可用' if NOWORD_AVAILABLE else '❌ 模型未找到'}")
    print("=" * 60)

    if init_engine():
        print(f"\n  服务器已启动！")
        print(f"  本机访问: http://localhost:{PORT}")
        print(f"  局域网访问: http://<你的IP>:{PORT}")
        print(f"  手机访问请确保在同一网络下\n")
        socketio.run(app, host="0.0.0.0", port=PORT, debug=False)
    else:
        print("\n  引擎启动失败，请检查配置路径")
        print("  运行 setup.ps1 进行自动安装配置")
        sys.exit(1)
