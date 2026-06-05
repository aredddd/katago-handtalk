/**
 * KataGo Web App - 主应用逻辑
 * 连接 WebSocket、管理游戏模式、处理 UI 交互
 */

(function () {
    "use strict";

    // ============== 状态 ==============
    let socket = null;
    let board = null;
    let gameMode = "free-play"; // free-play | play-black | play-white | ai-vs-ai
    let isThinking = false;
    let aiVsAiInterval = null;

    // ============== 初始化 ==============
    window.addEventListener("DOMContentLoaded", () => {
        // 初始化棋盘
        board = new GoBoard("goboard", 19);

        // 落子回调
        board.onMove((x, y) => {
            handleUserMove(x, y);
        });

        // 候选走法 hover/选中回调
        board.onCandidateHover = (idx) => {
            highlightSuggestion(idx);
        };

        // 导航回调：更新滑块和手数显示
        board.onNavigate = (viewIdx, total) => {
            updateNavUI(viewIdx, total);
        };

        // 连接服务器
        connectSocket();

        // 绑定 UI
        bindUI();

        // 绑定导航
        bindNavigation();

        console.log("KataGo Web 已初始化");
    });

    // ============== WebSocket ==============
    function connectSocket() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = io(window.location.origin, {
            transports: ["websocket", "polling"],
        });

        socket.on("connect", () => {
            console.log("已连接到服务器");
            setStatus("online", "已连接");
        });

        socket.on("disconnect", () => {
            console.log("断开连接");
            setStatus("offline", "已断开");
        });

        socket.on("status", (data) => {
            if (data.running) {
                setStatus("online", "引擎就绪");
                // 引擎就绪后自动分析当前局面（包括空棋盘开局）
                requestAnalysis();
            } else {
                setStatus("offline", "引擎未运行");
            }
        });

        socket.on("analysis", (data) => {
            handleAnalysisResult(data);
        });

        socket.on("ai_move", (data) => {
            handleAiMove(data);
        });

        socket.on("error", (data) => {
            console.error("服务器错误:", data.message);
            setStatus("offline", data.message);
            isThinking = false;
        });
    }

    // ============== 游戏逻辑 ==============

    function handleUserMove(x, y) {
        if (isThinking) return;
        if (gameMode === "ai-vs-ai") return;

        // 允许从历史位置分支：tryMove 会自动截断后续历史

        // 自由摆谱模式（KaTrain 默认）：黑白交替落子 + 自动分析
        if (gameMode === "free-play") {
            if (board.tryMove(x, y)) {
                board.draw();
                updateMoveCount();
                requestAnalysis();
            }
            return;
        }

        // 对弈模式：检查是否轮到玩家
        if (gameMode === "play-black" && board.currentPlayer !== 1) return;
        if (gameMode === "play-white" && board.currentPlayer !== 2) return;

        if (board.tryMove(x, y)) {
            board.draw();
            updateMoveCount();

            // 让 AI 下一步
            requestAiMove();
        }
    }

    function requestAiMove() {
        if (!socket || !socket.connected) return;
        isThinking = true;
        setStatus("loading", "AI 思考中...");

        const aiData = {
            moves: board.moves,
            boardSize: board.size,
            komi: getKomi(),
            maxVisits: getMaxVisits(),
        };
        if (board.initialStones) {
            aiData.initialStones = board.initialStones;
            aiData.initialPlayer = board.currentPlayer === 1 ? "B" : "W";
        }
        socket.emit("play_ai", aiData);
    }

    function handleAiMove(data) {
        isThinking = false;
        setStatus("online", "引擎就绪");

        if (data.move === "pass") {
            board.passMove();
            board.draw();
            updateMoveCount();
            return;
        }

        const pos = board.gtpToBoard(data.move);
        if (pos && board.tryMove(pos.x, pos.y)) {
            board.draw();
            updateMoveCount();

            // 更新胜率
            updateWinrate(data.winrate, data.scoreLead);

            // AI 对弈模式：继续
            if (gameMode === "ai-vs-ai") {
                setTimeout(() => requestAiMove(), 300);
            } else {
                // 人机模式：分析当前局面
                requestAnalysis();
            }
        }
    }

    function requestAnalysis() {
        if (!socket || !socket.connected) return;
        if (!document.getElementById("show-analysis").checked) return;

        setStatus("loading", "分析中...");

        const analyzeData = {
            moves: board.moves,
            boardSize: board.size,
            komi: getKomi(),
            maxVisits: getMaxVisits(),
            includeOwnership: document.getElementById("show-ownership").checked,
        };
        if (board.initialStones) {
            analyzeData.initialStones = board.initialStones;
            analyzeData.initialPlayer = board.currentPlayer === 1 ? "B" : "W";
        }
        socket.emit("analyze", analyzeData);
    }

    function handleAnalysisResult(data) {
        setStatus("online", "引擎就绪");

        // 更新棋盘分析显示
        board.setAnalysis(data);

        // 更新胜率
        updateWinrate(data.winrate, data.scoreLead);

        // 更新推荐走法列表
        updateSuggestions(data.moves || []);
    }

    // ============== UI 更新 ==============

    function setStatus(state, text) {
        const dot = document.getElementById("engine-status");
        const txt = document.getElementById("engine-text");
        dot.className = "status-dot " + state;
        txt.textContent = text;
    }

    function updateWinrate(blackWr, scoreLead) {
        const wrBlack = (blackWr * 100).toFixed(1);
        const wrWhite = ((1 - blackWr) * 100).toFixed(1);

        document.getElementById("winrate-black").textContent = wrBlack + "%";
        document.getElementById("winrate-white").textContent = wrWhite + "%";
        document.getElementById("score-lead").textContent =
            (scoreLead >= 0 ? "黑+" : "白+") + Math.abs(scoreLead).toFixed(1);

        document.getElementById("winrate-bar-black").style.width = wrBlack + "%";
    }

    function updateMoveCount() {
        // 由 onNavigate 回调统一处理
        updateNavUI(board.viewIndex, board.fullMoveHistory.length);
    }

    /** 更新导航条 UI */
    function updateNavUI(viewIdx, total) {
        document.getElementById("nav-move-num").textContent = viewIdx;
        document.getElementById("nav-move-total").textContent = "/ " + total;
        const slider = document.getElementById("nav-slider");
        slider.max = total;
        slider.value = viewIdx;
    }

    function updateSuggestions(moves) {
        const list = document.getElementById("suggestions-list");
        if (!moves || moves.length === 0) {
            list.innerHTML = '<p class="placeholder">无推荐走法</p>';
            return;
        }

        const bestSL = moves[0].scoreLead;

        list.innerHTML = moves
            .slice(0, 10)
            .map((m, i) => {
                const scoreDiff = Math.abs(m.scoreLead - bestSL);
                const diffStr = (m.scoreLead - bestSL) >= 0
                    ? `+${(m.scoreLead - bestSL).toFixed(1)}`
                    : (m.scoreLead - bestSL).toFixed(1);
                const sl = m.scoreLead >= 0 ? `+${m.scoreLead.toFixed(1)}` : m.scoreLead.toFixed(1);
                const dotColor = candidateDotColor(scoreDiff);
                return `
                <div class="suggestion-item" data-pv='${JSON.stringify(m.pv)}' data-index="${i}">
                    <span class="rank-dot" style="background:${dotColor}">${diffStr}</span>
                    <span class="move-name">${m.move}</span>
                    <span class="score-abs">${sl}</span>
                    <span class="wr">${(m.winrate * 100).toFixed(1)}%</span>
                    <span class="visits-count">${formatVisits(m.visits)}</span>
                </div>`;
            })
            .join("");

        // 绑定点击/hover事件：高亮 + 显示变化
        list.querySelectorAll(".suggestion-item").forEach((el) => {
            const idx = parseInt(el.dataset.index);

            el.addEventListener("click", () => {
                // 选中候选 -> 棋盘上画 PV
                board.selectedCandidateIdx = (board.selectedCandidateIdx === idx) ? -1 : idx;
                board.draw();
                highlightSuggestion(board.selectedCandidateIdx);
                const pv = JSON.parse(el.dataset.pv);
                showPV(pv);
            });

            el.addEventListener("mouseenter", () => {
                board.hoveredCandidateIdx = idx;
                board.draw();
            });

            el.addEventListener("mouseleave", () => {
                board.hoveredCandidateIdx = -1;
                board.draw();
            });
        });
    }

    /** 高亮面板中的候选项 */
    function highlightSuggestion(activeIdx) {
        const items = document.querySelectorAll(".suggestion-item");
        items.forEach((el) => {
            const idx = parseInt(el.dataset.index);
            el.classList.toggle("active", idx === activeIdx);
        });
        // 自动显示选中候选的 PV
        if (activeIdx >= 0 && board.analysisData && board.analysisData.moves) {
            const m = board.analysisData.moves[activeIdx];
            if (m) showPV(m.pv);
        }
    }

    function showPV(pv) {
        const display = document.getElementById("pv-display");
        if (!pv || pv.length === 0) {
            display.innerHTML = '<p class="placeholder">无变化</p>';
            return;
        }

        // 确定起始颜色
        let isBlack = board.currentPlayer === 1;
        display.innerHTML = pv
            .map((move, i) => {
                const cls = isBlack ? "black" : "white";
                isBlack = !isBlack;
                return `<span class="pv-move ${cls}">${i + 1}.${move}</span>`;
            })
            .join(" ");
    }

    function formatVisits(v) {
        if (v >= 10000) return (v / 1000).toFixed(1) + "k";
        if (v >= 1000) return (v / 1000).toFixed(1) + "k";
        return String(v);
    }

    /** KaTrain 风格面板圆点颜色：绿→黄→橙→红→紫 */
    function candidateDotColor(scoreDiff) {
        const t = Math.min(scoreDiff / 5.0, 1.0);
        let h, s, l;
        if (t < 0.25) {
            h = 120 - t * 4 * 60;
            s = 65; l = 42;
        } else if (t < 0.5) {
            h = 60 - (t - 0.25) * 4 * 30;
            s = 75; l = 47;
        } else if (t < 0.75) {
            h = 30 - (t - 0.5) * 4 * 30;
            s = 70; l = 45;
        } else {
            h = 360 - (t - 0.75) * 4 * 60;
            s = 70; l = 38;
        }
        return `hsl(${h}, ${s}%, ${l}%)`;
    }

    // ============== 设置读取 ==============

    function getKomi() {
        return parseFloat(document.getElementById("komi").value);
    }

    function getMaxVisits() {
        return parseInt(document.getElementById("max-visits").value);
    }

    function getBoardSize() {
        return parseInt(document.getElementById("board-size").value);
    }

    // ============== UI 绑定 ==============

    function bindUI() {
        // 模式按钮
        document.querySelectorAll(".mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                gameMode = btn.dataset.mode;

                // 停止 AI 对弈
                if (gameMode !== "ai-vs-ai") {
                    clearInterval(aiVsAiInterval);
                    isThinking = false;
                }

                // AI 对弈模式：开始
                if (gameMode === "ai-vs-ai") {
                    requestAiMove();
                }

                // 执白模式且黑先 → AI先下
                if (gameMode === "play-white" && board.currentPlayer === 1) {
                    requestAiMove();
                }

                // 切到摆谱模式时自动分析当前局面
                if (gameMode === "free-play" && board.moves.length > 0) {
                    requestAnalysis();
                }
            });
        });

        // 悔棋
        document.getElementById("btn-undo").addEventListener("click", () => {
            if (isThinking) return;
            if (gameMode === "play-black" || gameMode === "play-white") {
                // 对弈模式悔两步（自己和AI各一步）
                board.undo();
                board.undo();
            } else {
                board.undo();
            }
            updateMoveCount();
            if (gameMode === "free-play" && board.moves.length > 0) {
                requestAnalysis();
            }
        });

        // 虚手
        document.getElementById("btn-pass").addEventListener("click", () => {
            if (isThinking) return;
            board.passMove();
            board.draw();
            updateMoveCount();

            if (gameMode === "play-black" || gameMode === "play-white") {
                requestAiMove();
            } else if (gameMode === "free-play") {
                requestAnalysis();
            }
        });

        // 分析
        document.getElementById("btn-analyze").addEventListener("click", () => {
            requestAnalysis();
        });

        // 新对局
        document.getElementById("btn-new-game").addEventListener("click", () => {
            if (confirm("确定要开始新对局吗？")) {
                newGame();
            }
        });

        // 棋盘大小改变
        document.getElementById("board-size").addEventListener("change", () => {
            newGame();
        });

        // 显示选项
        document.getElementById("show-analysis").addEventListener("change", (e) => {
            board.showAnalysis = e.target.checked;
            board.draw();
            if (e.target.checked && board.moves.length > 0) {
                requestAnalysis();
            }
        });

        document.getElementById("show-ownership").addEventListener("change", (e) => {
            board.showOwnership = e.target.checked;
            board.draw();
            if (e.target.checked && board.moves.length > 0) {
                requestAnalysis();
            }
        });

        document.getElementById("show-move-number").addEventListener("change", (e) => {
            board.showMoveNumbers = e.target.checked;
            board.draw();
        });

        // 设置区折叠
        document.querySelectorAll(".section-toggle").forEach((toggle) => {
            toggle.addEventListener("click", () => {
                const targetId = toggle.dataset.target;
                const body = document.getElementById(targetId);
                if (body) {
                    body.classList.toggle("collapsed");
                    const icon = toggle.querySelector(".toggle-icon");
                    if (icon) icon.style.transform = body.classList.contains("collapsed") ? "rotate(-90deg)" : "";
                }
            });
        });
    }

    // ============== 导航绑定 ==============

    function bindNavigation() {
        // 导航按钮
        document.getElementById("nav-start").addEventListener("click", () => {
            board.navigateToStart();
            onNavigated();
        });
        document.getElementById("nav-back10").addEventListener("click", () => {
            board.navigateBack(10);
            onNavigated();
        });
        document.getElementById("nav-back1").addEventListener("click", () => {
            board.navigateBack(1);
            onNavigated();
        });
        document.getElementById("nav-forward1").addEventListener("click", () => {
            board.navigateForward(1);
            onNavigated();
        });
        document.getElementById("nav-forward10").addEventListener("click", () => {
            board.navigateForward(10);
            onNavigated();
        });
        document.getElementById("nav-end").addEventListener("click", () => {
            board.navigateToEnd();
            onNavigated();
        });

        // 滑块
        const slider = document.getElementById("nav-slider");
        slider.addEventListener("input", () => {
            board.navigateTo(parseInt(slider.value));
            onNavigated();
        });

        // 键盘快捷键
        document.addEventListener("keydown", (e) => {
            // 不拦截输入框中的按键
            if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

            switch (e.key) {
                case "ArrowLeft":
                    e.preventDefault();
                    board.navigateBack(e.shiftKey ? 10 : 1);
                    onNavigated();
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    board.navigateForward(e.shiftKey ? 10 : 1);
                    onNavigated();
                    break;
                case "Home":
                    e.preventDefault();
                    board.navigateToStart();
                    onNavigated();
                    break;
                case "End":
                    e.preventDefault();
                    board.navigateToEnd();
                    onNavigated();
                    break;
            }
        });
    }

    /** 导航后触发分析 */
    function onNavigated() {
        if (document.getElementById("show-analysis").checked && board.moves.length > 0) {
            requestAnalysis();
        }
    }

    function newGame() {
        isThinking = false;
        clearInterval(aiVsAiInterval);
        board.resetBoard(getBoardSize());
        updateMoveCount();
        updateWinrate(0.5, 0);
        document.getElementById("suggestions-list").innerHTML =
            '<p class="placeholder">落子后将显示分析</p>';
        document.getElementById("pv-display").innerHTML =
            '<p class="placeholder">点击推荐走法查看变化</p>';
        setStatus("online", "引擎就绪");

        // 执白模式：AI先下
        if (gameMode === "play-white") {
            requestAiMove();
        }
    }

    // ============== 拍照识别棋盘 ==============

    /** 识别结果缓存 */
    let recognizedBoard = null;

    function bindRecognition() {
        const cameraInput = document.getElementById("camera-input");
        const modal = document.getElementById("recognize-modal");

        // 📷 拍照识别按钮
        document.getElementById("btn-camera").addEventListener("click", () => {
            // 触发文件选择/拍照
            cameraInput.value = "";
            cameraInput.click();
        });

        // 选择图片后上传
        cameraInput.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (!file) return;
            uploadAndRecognize(file);
        });

        // 关闭弹窗
        document.getElementById("modal-close").addEventListener("click", closeRecognizeModal);

        // 点击遮罩关闭
        modal.addEventListener("click", (e) => {
            if (e.target === modal) closeRecognizeModal();
        });

        // 重新拍照
        document.getElementById("btn-recognize-retry").addEventListener("click", () => {
            closeRecognizeModal();
            setTimeout(() => {
                cameraInput.value = "";
                cameraInput.click();
            }, 200);
        });

        // 确认加载到棋盘
        document.getElementById("btn-recognize-confirm").addEventListener("click", () => {
            if (recognizedBoard) {
                loadRecognizedBoard(recognizedBoard);
                closeRecognizeModal();
            }
        });
    }

    function uploadAndRecognize(file) {
        const modal = document.getElementById("recognize-modal");
        const loading = document.getElementById("recognize-loading");
        const result = document.getElementById("recognize-result");

        // 显示弹窗 & 加载状态
        modal.style.display = "flex";
        loading.style.display = "block";
        result.style.display = "none";

        const formData = new FormData();
        formData.append("image", file);
        formData.append("boardSize", getBoardSize());
        formData.append("sid", socket ? socket.id : "default");

        fetch("/api/recognize", {
            method: "POST",
            body: formData,
        })
            .then((res) => res.json())
            .then((data) => {
                loading.style.display = "none";
                if (data.error) {
                    alert("识别失败: " + data.error);
                    closeRecognizeModal();
                    return;
                }
                showRecognizeResult(data);
            })
            .catch((err) => {
                loading.style.display = "none";
                alert("上传失败: " + err.message);
                closeRecognizeModal();
            });
    }

    function showRecognizeResult(data) {
        const result = document.getElementById("recognize-result");
        result.style.display = "block";

        recognizedBoard = data.board;

        // 显示信息
        const conf = Math.round(data.confidence * 100);
        const methodMap = {
            "noword-cnn": "🧠 CNN 深度学习",
        };
        const method = methodMap[data.method] || "📐 未知";
        document.getElementById("recognize-confidence").textContent =
            `${method} | 置信度: ${conf}%`;
        document.getElementById("recognize-auto-status").textContent =
            "✅ 专用围棋 CNN 识别（点击棋子可修正）";

        // 初始化 canvas 尺寸和事件（每次新识别重新计算一次尺寸）
        initRecognizeCanvas();
        drawRecognizeCanvas(recognizedBoard);
    }

    /** 识别预览 canvas 的固定尺寸（首次初始化后不变，防止缩小 bug） */
    let _recognizeCanvasSize = 0;

    /** 初始化识别预览 canvas 的尺寸和交互事件（仅调用一次） */
    function initRecognizeCanvas() {
        const canvas = document.getElementById("recognize-board-canvas");

        // 计算一次尺寸并锁定，后续重绘不再重新计算
        const parentW = canvas.parentElement.clientWidth || 380;
        _recognizeCanvasSize = Math.min(parentW - 10, 420);
        canvas.width = _recognizeCanvasSize;
        canvas.height = _recognizeCanvasSize;
        canvas.style.width = _recognizeCanvasSize + "px";
        canvas.style.height = _recognizeCanvasSize + "px";

        // 移除旧的事件监听（如有）
        if (canvas._recognizeClickHandler) {
            canvas.removeEventListener("click", canvas._recognizeClickHandler);
        }

        // 使用 click 事件（兼容桌面和移动端），不拦截浏览器手势
        // 用 offsetX/offsetY 获取元素内坐标，对浏览器缩放免疫
        canvas._recognizeClickHandler = (e) => {
            if (!recognizedBoard) return;
            const size = recognizedBoard.length;
            const canvasSize = _recognizeCanvasSize;
            const padding = canvasSize * 0.05;
            const cellSize = (canvasSize - 2 * padding) / (size - 1);

            // offsetX/offsetY 是相对于元素的 CSS 坐标
            // 但浏览器缩放时 offsetX 会按缩放比例变化，需要归一化
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / rect.width * canvasSize;
            const my = (e.clientY - rect.top) / rect.height * canvasSize;

            const col = Math.round((mx - padding) / cellSize);
            const row = Math.round((my - padding) / cellSize);
            if (row >= 0 && row < size && col >= 0 && col < size) {
                // 循环切换: 空→黑→白→空
                recognizedBoard[row][col] = (recognizedBoard[row][col] + 1) % 3;
                drawRecognizeCanvas(recognizedBoard);
            }
        };
        canvas.addEventListener("click", canvas._recognizeClickHandler);
    }

    /** 在识别结果的 canvas 上画棋盘（纯绘制，不重新计算尺寸） */
    function drawRecognizeCanvas(boardData) {
        const canvas = document.getElementById("recognize-board-canvas");
        const ctx = canvas.getContext("2d");
        const size = boardData.length;
        const canvasSize = _recognizeCanvasSize;

        const padding = canvasSize * 0.05;
        const cellSize = (canvasSize - 2 * padding) / (size - 1);

        // 棋盘底色
        ctx.fillStyle = "#dcb35c";
        ctx.fillRect(0, 0, canvasSize, canvasSize);

        // 网格
        ctx.strokeStyle = "#2a2000";
        ctx.lineWidth = 0.8;
        for (let i = 0; i < size; i++) {
            const x = padding + i * cellSize;
            const y = padding + i * cellSize;
            ctx.beginPath();
            ctx.moveTo(x, padding);
            ctx.lineTo(x, padding + (size - 1) * cellSize);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(padding + (size - 1) * cellSize, y);
            ctx.stroke();
        }

        // 星位
        const starPoints19 = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
        const starPoints13 = [[3,3],[3,9],[6,6],[9,3],[9,9]];
        const starPoints9 = [[2,2],[2,6],[4,4],[6,2],[6,6]];
        const stars = size === 19 ? starPoints19 : size === 13 ? starPoints13 : starPoints9;
        ctx.fillStyle = "#2a2000";
        for (const [sx, sy] of stars) {
            ctx.beginPath();
            ctx.arc(padding + sx * cellSize, padding + sy * cellSize, cellSize * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }

        // 棋子
        const r = cellSize * 0.43;
        for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
                const val = boardData[row][col];
                if (val === 0) continue;
                const px = padding + col * cellSize;
                const py = padding + row * cellSize;

                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fillStyle = val === 1 ? "#111" : "#eee";
                ctx.fill();
                ctx.strokeStyle = val === 1 ? "#000" : "#aaa";
                ctx.lineWidth = 0.8;
                ctx.stroke();

                // 白子加个高光
                if (val === 2) {
                    ctx.beginPath();
                    ctx.arc(px - r * 0.25, py - r * 0.25, r * 0.25, 0, Math.PI * 2);
                    ctx.fillStyle = "rgba(255,255,255,0.5)";
                    ctx.fill();
                }
            }
        }
    }

    /** 将识别结果加载到主棋盘 */
    function loadRecognizedBoard(boardData) {
        const size = boardData.length;
        const nextPlayer = parseInt(document.getElementById("recognize-next-player").value);

        // 重置棋盘
        board.resetBoard(size);

        // 直接设置棋盘状态
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                board.board[y][x] = boardData[y][x];
            }
        }
        board.currentPlayer = nextPlayer;

        // 生成 initialStones 供 KataGo 分析
        board.setInitialStonesFromBoard();

        // 同步 UI 的棋盘大小选择
        document.getElementById("board-size").value = String(size);

        board.draw();
        updateMoveCount();

        // 自动分析
        if (document.getElementById("show-analysis").checked) {
            requestAnalysis();
        }

        setStatus("online", "棋盘已加载 - 识别结果");
    }

    function closeRecognizeModal() {
        document.getElementById("recognize-modal").style.display = "none";
    }

    // 初始化时绑定识别事件
    // (在 DOMContentLoaded 之后追加)
    window.addEventListener("DOMContentLoaded", () => {
        bindRecognition();
    });
})();
