/**
 * KataGo Web — main application logic
 * WebSocket, beginner game logic, screen review, and i18n
 */

(function () {
    "use strict";

    // ── WebSocket event name constants ────────────────────────────────────────
    const EVENTS = {
        ANALYZE:        "analyze",
        PLAY_AI:        "play_ai",
        CANCEL:         "cancel",
        ANALYSIS:       "analysis",
        AI_MOVE:        "ai_move",
        STATUS:         "status",
        ERROR:          "error",
        CIRCUIT_STATUS: "circuit_status",
    };

    // ── i18n ─────────────────────────────────────────────────────────────────
    // Translation dictionaries are loaded at startup from static/locales/<lang>.json.
    // The default language and the list of available languages come from the server
    // (GET /api/config, driven by config.ini); a user's explicit choice in
    // localStorage takes precedence.
    // Built-in Chinese fallback keeps the local UI readable even while the
    // server or locale files are still loading (or when index.html is previewed).
    const STRINGS = { zh: {
        connecting: "连接中…", connected: "已连接", disconnected: "连接已断开",
        engineReady: "引擎就绪", engineOffline: "引擎未运行", analyzing: "分析中…",
        aiThinking: "AI 思考中…", boardLoaded: "棋盘已加载", black: "黑", white: "白",
        freePlay: "自由推演", playBlack: "执黑", playWhite: "执白", undo: "悔棋",
        pass: "停一手", analyze: "分析", newGame: "新对局", komi: "贴目",
        suggestions: "推荐走法", mainLine: "主要变化", noSuggestions: "无推荐走法",
        suggestPlaceholder: "落子后将显示分析", pvPlaceholder: "点击推荐走法查看变化",
        pvEmpty: "无变化", confirmNewGame: "确定要开始新对局吗？",
        confirmResign: "确定要认输并结束当前对局吗？", resigned: "棋认输",
        twoPasses: "双方连续停一手，对局结束",
        recognizing: "AI 正在识别棋盘，请稍候…", recognizeResult: "识别结果",
        uploadFailed: "上传失败", snipThenPaste: "截图完成后，回到页面按 Ctrl+V",
        pasteShortcut: "请先截图，然后回到页面按 Ctrl+V。",
        clipboardNoImage: "剪贴板里没有图片，请先截取棋盘。",
        circuitOpen: "引擎暂时不可用",
        circuitHalfOpen: "引擎恢复中…", circuitClosed: "引擎恢复正常",
        liveStart: "开始实时复盘", liveStop: "停止实时复盘", liveIdle: "未共享窗口",
        liveStarting: "正在连接共享画面…", liveRecognizing: "正在识别新局面…",
        liveSynced: "局面已同步", liveWaiting: "等待局面变化",
        liveVerifying: "正在确认局面变化…", liveLowConfidence: "画面不够清晰，等待重试",
        liveRetrying: "识别失败，稍后重试", liveError: "实时复盘出错",
        liveTurnMismatch: "检测到落子方与当前手数不一致，请先校正轮到谁",
        liveIllegalChange: "检测到的变化无法按围棋规则复现，正在重新确认",
        liveRelocated: "检测到多手变化，已按当前画面重新同步",
        liveUnsupported: "当前浏览器不支持屏幕共享，请使用最新版 Edge 或 Chrome。",
    }};
    let availableLangs = ["en", "zh"];  // overwritten by /api/config
    let serverDefaultLang = "en";       // overwritten by /api/config
    let currentLang = "en";             // resolved in bootstrap()

    async function loadServerConfig() {
        try {
            const cfg = await (await fetch("/api/config")).json();
            if (Array.isArray(cfg.available_languages) && cfg.available_languages.length)
                availableLangs = cfg.available_languages;
            if (cfg.default_language) serverDefaultLang = cfg.default_language;
        } catch (e) {
            console.warn("Could not load /api/config, using defaults", e);
        }
    }

    async function loadLocales() {
        await Promise.all(availableLangs.map(async (lg) => {
            try {
                STRINGS[lg] = await (await fetch(`locales/${lg}.json`)).json();
            } catch (e) {
                console.warn(`Could not load locale '${lg}'`, e);
                STRINGS[lg] = STRINGS[lg] || {};
            }
        }));
    }

    function t(key) {
        return (STRINGS[currentLang] || {})[key] ||
            (STRINGS[serverDefaultLang] || {})[key] ||
            (STRINGS.zh || {})[key] || key;
    }

    function applyTranslations() {
        document.getElementById("html-root").lang = currentLang === "zh" ? "zh-CN" : "en";

        // Elements with class="i18n" and data-key
        document.querySelectorAll(".i18n[data-key]").forEach((el) => {
            el.textContent = t(el.dataset.key);
        });

        // Live status text (re-apply current status if already set)
        const eng = document.getElementById("engine-status");
        if (eng) {
            if (eng.classList.contains("online") && !document.getElementById("engine-text").textContent.includes("…")) {
                document.getElementById("engine-text").textContent = t("engineReady");
            }
        }
    }

    function toggleLang() {
        // Cycle to the next available language.
        const i = availableLangs.indexOf(currentLang);
        currentLang = availableLangs[(i + 1) % availableLangs.length];
        localStorage.setItem("lang", currentLang);
        applyTranslations();
    }

    // ── App state ─────────────────────────────────────────────────────────────

    let socket = null;
    let board  = null;
    let gameMode     = "free-play";
    let isThinking   = false;
    let gameOver = false;

    // Live review deliberately uses browser screen sharing rather than any
    // game-client integration. Frames are recognized locally by this server.
    let liveReviewStream = null;
    let liveReviewTimer = null;
    let liveReviewBusy = false;
    let liveLastBoard = null;
    let liveReviewStarting = false;
    let liveReviewGeneration = 0;
    let liveReviewAbortController = null;
    let livePendingSignature = "";
    let livePendingCount = 0;

    // Monotonic request id. Each requestAnalysis() bumps the counter and tags
    // its emit with reqId; the server echoes it back in the analysis result.
    // handleAnalysisResult() ignores any result whose reqId is not the latest,
    // so a stale response (from a position the user already moved past) is
    // never displayed.
    let _analysisReqSeq      = 0;
    let _latestAnalysisReqId = 0;
    let _aiReqSeq            = 0;
    let _latestAiReqId       = 0;

    // ── Init ──────────────────────────────────────────────────────────────────

    window.addEventListener("DOMContentLoaded", async () => {
        // 1. Load server config (default language, available languages),
        //    then the locale dictionaries, before rendering any text.
        await loadServerConfig();
        currentLang = localStorage.getItem("lang") || serverDefaultLang || "en";
        await loadLocales();

        // 2. Initialise the application.
        board = new GoBoard("goboard", 19);
        board.onMove((x, y) => handleUserMove(x, y));
        board.onCandidateHover = (idx) => highlightSuggestion(idx);
        board.onNavigate = (viewIdx, total) => updateNavUI(viewIdx, total);

        applyTranslations();
        connectSocket();
        bindUI();
        bindRecognition();
        bindLiveReview();

        setStatus("offline", t("connecting"));
    });

    // ── WebSocket ─────────────────────────────────────────────────────────────

    function connectSocket() {
        socket = io(window.location.origin, {
            transports: ["websocket", "polling"],
        });

        socket.on("connect", () => {
            setStatus("online", t("connected"));
        });

        socket.on("disconnect", () => {
            invalidatePendingAi();
            setStatus("offline", t("disconnected"));
        });

        socket.on(EVENTS.STATUS, (data) => {
            if (data.running) {
                setStatus("online", t("engineReady"));
                continueFromCurrentPosition();
            } else {
                setStatus("offline", t("engineOffline"));
            }
        });

        socket.on(EVENTS.ANALYSIS, (data) => {
            handleAnalysisResult(data);
        });

        socket.on(EVENTS.AI_MOVE, (data) => {
            handleAiMove(data);
        });

        socket.on(EVENTS.ERROR, (data) => {
            if (data.kind === "analysis" && data.reqId !== _latestAnalysisReqId) return;
            if (data.kind === "ai" && data.reqId !== _latestAiReqId) return;
            if (!data.kind || data.kind === "ai") isThinking = false;
            // circuit_open flag means the CB emitted this — already handled
            // by circuit_status, so just update status text
            setStatus("offline", data.message || "Error");
        });

        socket.on(EVENTS.CIRCUIT_STATUS, (data) => {
            _updateCircuitStatus(data);
        });
    }

    // ── Game logic ────────────────────────────────────────────────────────────

    function invalidatePendingAi() {
        _latestAiReqId = ++_aiReqSeq;
        isThinking = false;
    }

    function invalidateAnalysisResults() {
        _latestAnalysisReqId = ++_analysisReqSeq;
    }

    function isAiTurn() {
        return (gameMode === "play-black" && board.currentPlayer === 2) ||
               (gameMode === "play-white" && board.currentPlayer === 1);
    }

    function continueFromCurrentPosition() {
        if (liveReviewStream) {
            requestAnalysis();
            return;
        }
        if (isAiTurn()) requestAiMove();
        else requestAnalysis();
    }

    function handleUserMove(x, y) {
        if (isThinking || gameOver || liveReviewStream || liveReviewStarting) return;
        if (gameMode === "free-play") {
            if (board.tryMove(x, y)) {
                invalidateAnalysisResults();
                clearAnalysisPanels();
                board.draw();
                updateMoveCount();
                requestAnalysis();
            }
            return;
        }

        if (gameMode === "play-black" && board.currentPlayer !== 1) return;
        if (gameMode === "play-white" && board.currentPlayer !== 2) return;

        if (board.tryMove(x, y)) {
            invalidateAnalysisResults();
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            requestAiMove();
        }
    }

    function requestAiMove() {
        if (!socket || !socket.connected || gameOver) return;

        const reqId = ++_aiReqSeq;
        _latestAiReqId = reqId;
        isThinking = true;
        setStatus("loading", t("aiThinking"));

        const data = {
            reqId:     reqId,
            moves:     board.moves,
            boardSize: board.size,
            komi:      getKomi(),
            maxVisits: getMaxVisits(),
        };
        if (board.initialStones) data.initialStones = board.initialStones;
        data.initialPlayer = board.initialPlayer === 1 ? "B" : "W";
        socket.emit(EVENTS.PLAY_AI, data);
    }

    function handleAiMove(data) {
        if (gameOver || liveReviewStream ||
            data.reqId !== _latestAiReqId) return;
        isThinking = false;
        setStatus("online", t("engineReady"));
        invalidateAnalysisResults();

        if (data.move === "pass") {
            recordPass();
            updateWinrate(data.winrate, data.scoreLead);
            requestAnalysis();
            return;
        }

        const pos = board.gtpToBoard(data.move);
        if (pos && board.tryMove(pos.x, pos.y)) {
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            updateWinrate(data.winrate, data.scoreLead);
            requestAnalysis();
        }
    }

    function requestAnalysis() {
        if (!socket || !socket.connected) return;
        // Analysis and AI move generation share one KataGo single-flight slot.
        // Do not let a manual overlay refresh cancel the AI move that the game
        // is currently waiting for.
        if (isThinking && isAiTurn()) return;
        if (!document.getElementById("show-analysis").checked) return;

        const reqId = ++_analysisReqSeq;
        _latestAnalysisReqId = reqId;
        setStatus("loading", t("analyzing"));

        const data = {
            reqId:            reqId,
            moves:            board.moves,
            boardSize:        board.size,
            komi:             getKomi(),
            maxVisits:        getMaxVisits(),
            includeOwnership: document.getElementById("show-ownership").checked,
        };
        if (board.initialStones) data.initialStones = board.initialStones;
        data.initialPlayer = board.initialPlayer === 1 ? "B" : "W";
        socket.emit(EVENTS.ANALYZE, data);
    }

    function handleAnalysisResult(data) {
        // Ignore stale results: only the latest request's reqId is accepted.
        // The server already discards superseded queries, but this guards
        // against any out-of-order delivery on the client side too.
        if (data.reqId !== undefined && data.reqId !== _latestAnalysisReqId) {
            return;
        }
        setStatus("online", t("engineReady"));
        board.setAnalysis(data);
        updateWinrate(data.winrate, data.scoreLead);
        updateSuggestions(data.moves || []);
    }

    // ── UI update ─────────────────────────────────────────────────────────────

    function setStatus(state, text) {
        document.getElementById("engine-status").className = "status-dot " + state;
        document.getElementById("engine-text").textContent = text;
    }

    function showGameMessage(text) {
        const message = document.getElementById("game-message");
        if (!message) return;
        message.textContent = text;
        message.hidden = false;
    }

    function hideGameMessage() {
        const message = document.getElementById("game-message");
        if (message) message.hidden = true;
    }

    function clearAnalysisPanels(resetEvaluation = false) {
        document.getElementById("suggestions-list").innerHTML =
            `<p class="placeholder">${t("suggestPlaceholder")}</p>`;
        document.getElementById("pv-display").innerHTML =
            `<p class="placeholder">${t("pvPlaceholder")}</p>`;
        if (resetEvaluation) updateWinrate(0.5, 0);
    }

    function recordPass() {
        clearAnalysisPanels();
        board.passMove();
        board.draw();
        updateMoveCount();
        const history = board.fullMoveHistory;
        if (history.length >= 2 &&
            history[history.length - 1][1] === "pass" &&
            history[history.length - 2][1] === "pass") {
            gameOver = true;
            showGameMessage(t("twoPasses"));
            return false;
        }
        return true;
    }

    function _updateCircuitStatus(data) {
        const state = data.state; // "CLOSED" | "OPEN" | "HALF_OPEN"
        if (state === "OPEN") {
            const retryIn = data.retry_in > 0 ? ` (${data.retry_in}s)` : "";
            setStatus("offline", t("circuitOpen") + retryIn);
        } else if (state === "HALF_OPEN") {
            setStatus("loading", t("circuitHalfOpen"));
        } else if (state === "CLOSED" && data.old && data.old !== "CLOSED") {
            // Only show recovery message on actual OPEN→CLOSED transition
            setStatus("online", t("circuitClosed"));
            setTimeout(() => setStatus("online", t("engineReady")), 3000);
        }
    }

    function updateWinrate(blackWr, scoreLead) {
        const wrB = (blackWr * 100).toFixed(1);
        const wrW = ((1 - blackWr) * 100).toFixed(1);
        document.getElementById("winrate-black").textContent = wrB + "%";
        document.getElementById("winrate-white").textContent = wrW + "%";
        document.getElementById("score-lead").textContent =
            (scoreLead >= 0 ? t("black") + "+" : t("white") + "+") +
            Math.abs(scoreLead).toFixed(1);
        document.getElementById("winrate-bar-black").style.width = wrB + "%";
    }

    function updateMoveCount() {
        updateNavUI(board.viewIndex, board.fullMoveHistory.length);
    }

    function updateNavUI(viewIdx, total) {
        const moveNum = document.getElementById("nav-move-num");
        const moveTotal = document.getElementById("nav-move-total");
        if (moveNum) moveNum.textContent = viewIdx;
        if (moveTotal) moveTotal.textContent = "/ " + total;
        const slider = document.getElementById("nav-slider");
        if (slider) {
            slider.max = total;
            slider.value = viewIdx;
        }
    }

    function updateSuggestions(moves) {
        const list = document.getElementById("suggestions-list");
        if (!moves || moves.length === 0) {
            list.innerHTML = `<p class="placeholder">${t("noSuggestions")}</p>`;
            return;
        }

        const bestSL = moves[0].scoreLead;
        list.innerHTML = moves.slice(0, 5).map((m, i) => {
            // KataGo values are normalized to Black's perspective. For White
            // to move, a lower black lead is better, so invert the delta.
            const moverDirection = board.currentPlayer === 1 ? 1 : -1;
            const diff    = (m.scoreLead - bestSL) * moverDirection;
            const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
            const sl      = m.scoreLead >= 0 ? `+${m.scoreLead.toFixed(1)}` : m.scoreLead.toFixed(1);
            return `
            <div class="suggestion-item" data-pv='${JSON.stringify(m.pv)}' data-index="${i}">
                <span class="rank-dot" style="background:${candidateDotColor(Math.abs(diff))}">${diffStr}</span>
                <span class="move-name">${m.move}</span>
                <span class="score-abs">${sl}</span>
                <span class="wr">${(m.winrate * 100).toFixed(1)}%</span>
                <span class="visits-count">${formatVisits(m.visits)}</span>
            </div>`;
        }).join("");

        list.querySelectorAll(".suggestion-item").forEach((el) => {
            const idx = parseInt(el.dataset.index);
            el.addEventListener("click", () => {
                board.selectedCandidateIdx = (board.selectedCandidateIdx === idx) ? -1 : idx;
                board.draw();
                highlightSuggestion(board.selectedCandidateIdx);
                showPV(JSON.parse(el.dataset.pv));
            });
            el.addEventListener("mouseenter", () => { board.hoveredCandidateIdx = idx; board.draw(); });
            el.addEventListener("mouseleave", () => { board.hoveredCandidateIdx = -1; board.draw(); });
        });
    }

    function highlightSuggestion(activeIdx) {
        document.querySelectorAll(".suggestion-item").forEach((el) => {
            el.classList.toggle("active", parseInt(el.dataset.index) === activeIdx);
        });
        if (activeIdx >= 0 && board.analysisData && board.analysisData.moves) {
            const m = board.analysisData.moves[activeIdx];
            if (m) showPV(m.pv);
        }
    }

    function showPV(pv) {
        const display = document.getElementById("pv-display");
        if (!pv || pv.length === 0) {
            display.innerHTML = `<p class="placeholder">${t("pvEmpty")}</p>`;
            return;
        }
        let isBlack = board.currentPlayer === 1;
        display.innerHTML = pv.map((move, i) => {
            const cls = isBlack ? "black" : "white";
            isBlack = !isBlack;
            return `<span class="pv-move ${cls}">${i + 1}.${move}</span>`;
        }).join(" ");
    }

    function formatVisits(v) {
        if (v >= 1000) return (v / 1000).toFixed(1) + "k";
        return String(v);
    }

    function candidateDotColor(scoreDiff) {
        const t2 = Math.min(scoreDiff / 5.0, 1.0);
        let h, s, l;
        if      (t2 < 0.25) { h = 120 - t2 * 4 * 60; s = 65; l = 42; }
        else if (t2 < 0.5)  { h = 60 - (t2-0.25)*4*30; s = 75; l = 47; }
        else if (t2 < 0.75) { h = 30 - (t2-0.5)*4*30;  s = 70; l = 45; }
        else                { h = 360 - (t2-0.75)*4*60; s = 70; l = 38; }
        return `hsl(${h},${s}%,${l}%)`;
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    function getKomi()      { return parseFloat(document.getElementById("komi").value); }
    function getMaxVisits() { return parseInt(document.getElementById("max-visits").value); }
    function getBoardSize() { return parseInt(document.getElementById("board-size").value); }

    // ── UI bindings ───────────────────────────────────────────────────────────

    function bindUI() {
        // Language toggle
        document.getElementById("btn-lang").addEventListener("click", toggleLang);

        // Mode buttons
        document.querySelectorAll(".mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                invalidatePendingAi();
                invalidateAnalysisResults();
                document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                gameMode = btn.dataset.mode;
                continueFromCurrentPosition();
            });
        });

        // Action buttons
        document.getElementById("btn-undo").addEventListener("click", () => {
            invalidatePendingAi();
            invalidateAnalysisResults();
            gameOver = false;
            hideGameMessage();
            if (gameMode === "play-black" || gameMode === "play-white") {
                board.undo(); board.undo();
            } else {
                board.undo();
            }
            updateMoveCount();
            clearAnalysisPanels();
            continueFromCurrentPosition();
        });

        document.getElementById("btn-pass").addEventListener("click", () => {
            if (isThinking || gameOver) return;
            invalidateAnalysisResults();
            if (recordPass()) continueFromCurrentPosition();
            else requestAnalysis();
        });

        document.getElementById("btn-analyze").addEventListener("click", requestAnalysis);

        document.getElementById("btn-position").addEventListener("click", () => {
            const ownership = document.getElementById("show-ownership");
            ownership.checked = !ownership.checked;
            board.showOwnership = ownership.checked;
            document.getElementById("btn-position").classList.toggle("active", ownership.checked);
            board.draw();
            requestAnalysis();
        });

        document.getElementById("btn-resign").addEventListener("click", () => {
            if (gameOver || !confirm(t("confirmResign"))) return;
            invalidatePendingAi();
            invalidateAnalysisResults();
            if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
            gameOver = true;
            const resigningColor = gameMode === "play-black" ? 1 :
                gameMode === "play-white" ? 2 : board.currentPlayer;
            const player = resigningColor === 1 ? t("black") : t("white");
            showGameMessage(`${player}${t("resigned")}`);
            setStatus("online", `${player}${t("resigned")}`);
        });

        document.getElementById("btn-new-game").addEventListener("click", () => {
            if (confirm(t("confirmNewGame"))) newGame();
        });

        document.getElementById("board-size").addEventListener("change", newGame);

        document.getElementById("show-analysis").addEventListener("change", (e) => {
            board.showAnalysis = e.target.checked; board.draw();
            if (e.target.checked && board.moves.length > 0) requestAnalysis();
        });

        document.getElementById("show-ownership").addEventListener("change", (e) => {
            board.showOwnership = e.target.checked; board.draw();
            if (e.target.checked && board.moves.length > 0) requestAnalysis();
        });

        document.getElementById("show-move-number").addEventListener("change", (e) => {
            board.showMoveNumbers = e.target.checked; board.draw();
        });

        document.querySelectorAll(".section-toggle").forEach((toggle) => {
            toggle.addEventListener("click", () => {
                const body = document.getElementById(toggle.dataset.target);
                if (body) {
                    body.classList.toggle("collapsed");
                    const icon = toggle.querySelector(".toggle-icon");
                    if (icon) icon.style.transform = body.classList.contains("collapsed") ? "rotate(-90deg)" : "";
                }
            });
        });
    }

    function newGame() {
        invalidatePendingAi();
        invalidateAnalysisResults();
        isThinking = false;
        gameOver = false;
        hideGameMessage();
        board.resetBoard(getBoardSize());
        updateMoveCount();
        clearAnalysisPanels(true);
        setStatus("online", t("engineReady"));
        continueFromCurrentPosition();
    }

    // ── Board recognition ─────────────────────────────────────────────────────

    let recognizedBoard = null;
    let manualRecognitionSeq = 0;
    let manualRecognitionController = null;

    function bindRecognition() {
        const cameraInput = document.getElementById("camera-input");
        const modal       = document.getElementById("recognize-modal");

        document.getElementById("btn-camera").addEventListener("click", () => {
            cameraInput.value = ""; cameraInput.click();
        });

        cameraInput.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) uploadAndRecognize(file);
        });

        document.getElementById("btn-snipping").addEventListener("click", () => {
            // Windows 11 Snipping Tool protocol. The capture is copied to the
            // clipboard; returning here and pressing Ctrl+V imports it locally.
            const launcher = document.createElement("a");
            launcher.href = "ms-screenclip://capture/image?rectangle&enabledModes=SnippingAllModes&user-agent=KataGoWeb";
            launcher.click();
            setStatus("online", t("snipThenPaste"));
        });

        document.getElementById("btn-paste").addEventListener("click", importClipboardImage);
        document.addEventListener("paste", (event) => {
            if (liveReviewStream || liveReviewStarting) return;
            const file = imageFromClipboardData(event.clipboardData);
            if (!file) return;
            event.preventDefault();
            uploadAndRecognize(file);
        });

        document.getElementById("modal-close").addEventListener("click",   closeRecognizeModal);
        modal.addEventListener("click", (e) => { if (e.target === modal) closeRecognizeModal(); });

        document.getElementById("btn-recognize-retry").addEventListener("click", () => {
            closeRecognizeModal();
            setTimeout(() => { cameraInput.value = ""; cameraInput.click(); }, 200);
        });

        document.getElementById("btn-recognize-confirm").addEventListener("click", () => {
            if (recognizedBoard) { loadRecognizedBoard(recognizedBoard); closeRecognizeModal(); }
        });
    }

    async function recognizeImage(file, { signal } = {}) {
        const fd = new FormData();
        fd.append("image", file, file.name || "board-frame.jpg");
        fd.append("boardSize", getBoardSize());
        fd.append("sid", socket ? socket.id : "default");
        const response = await fetch("/api/recognize", {
            method: "POST",
            body: fd,
            signal,
        });
        const raw = await response.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (_err) {
            data = { error: raw || `HTTP ${response.status}` };
        }
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    }

    async function uploadAndRecognize(file) {
        if (liveReviewStream || liveReviewStarting) return;
        const modal   = document.getElementById("recognize-modal");
        const loading = document.getElementById("recognize-loading");
        const result  = document.getElementById("recognize-result");
        const requestId = ++manualRecognitionSeq;
        if (manualRecognitionController) manualRecognitionController.abort();
        const controller = new AbortController();
        manualRecognitionController = controller;

        modal.style.display  = "flex";
        loading.style.display = "block";
        result.style.display  = "none";

        try {
            const data = await recognizeImage(file, { signal: controller.signal });
            if (requestId !== manualRecognitionSeq) return;
            loading.style.display = "none";
            showRecognizeResult(data);
        } catch (err) {
            if (err.name === "AbortError" || requestId !== manualRecognitionSeq) return;
            loading.style.display = "none";
            alert(t("uploadFailed") + ": " + err.message);
            modal.style.display = "none";
        } finally {
            if (requestId === manualRecognitionSeq) manualRecognitionController = null;
        }
    }

    function showRecognizeResult(data) {
        const result = document.getElementById("recognize-result");
        result.style.display = "block";
        recognizedBoard = data.board;

        const conf = Math.round(data.confidence * 100);
        document.getElementById("recognize-confidence").textContent =
            `🧠 CNN | ${conf}%`;
        document.getElementById("recognize-auto-status").textContent =
            t("recognizeResult");

        initRecognizeCanvas();
        drawRecognizeCanvas(recognizedBoard);
    }

    let _recognizeCanvasSize = 0;

    function initRecognizeCanvas() {
        const canvas  = document.getElementById("recognize-board-canvas");
        const parentW = canvas.parentElement.clientWidth || 380;
        _recognizeCanvasSize = Math.min(parentW - 10, 420);
        canvas.width = canvas.height = _recognizeCanvasSize;
        canvas.style.width = canvas.style.height = _recognizeCanvasSize + "px";

        if (canvas._recognizeClickHandler) {
            canvas.removeEventListener("click", canvas._recognizeClickHandler);
        }
        canvas._recognizeClickHandler = (e) => {
            if (!recognizedBoard) return;
            const size      = recognizedBoard.length;
            const padding   = _recognizeCanvasSize * 0.05;
            const cellSize  = (_recognizeCanvasSize - 2 * padding) / (size - 1);
            const rect      = canvas.getBoundingClientRect();
            const mx        = (e.clientX - rect.left) / rect.width * _recognizeCanvasSize;
            const my        = (e.clientY - rect.top)  / rect.height * _recognizeCanvasSize;
            const col       = Math.round((mx - padding) / cellSize);
            const row       = Math.round((my - padding) / cellSize);
            if (row >= 0 && row < size && col >= 0 && col < size) {
                recognizedBoard[row][col] = (recognizedBoard[row][col] + 1) % 3;
                drawRecognizeCanvas(recognizedBoard);
            }
        };
        canvas.addEventListener("click", canvas._recognizeClickHandler);
    }

    function drawRecognizeCanvas(boardData) {
        const canvas    = document.getElementById("recognize-board-canvas");
        const ctx       = canvas.getContext("2d");
        const size      = boardData.length;
        const cs        = _recognizeCanvasSize;
        const padding   = cs * 0.05;
        const cellSize  = (cs - 2 * padding) / (size - 1);

        ctx.fillStyle = "#dcb35c";
        ctx.fillRect(0, 0, cs, cs);

        ctx.strokeStyle = "#2a2000"; ctx.lineWidth = 0.8;
        for (let i = 0; i < size; i++) {
            const x = padding + i * cellSize, y = padding + i * cellSize;
            ctx.beginPath(); ctx.moveTo(x, padding); ctx.lineTo(x, padding + (size-1)*cellSize); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(padding + (size-1)*cellSize, y); ctx.stroke();
        }

        const SP = { 19:[[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]],
                     13:[[3,3],[3,9],[6,6],[9,3],[9,9]],
                      9:[[2,2],[2,6],[4,4],[6,2],[6,6]] };
        ctx.fillStyle = "#2a2000";
        for (const [sx, sy] of (SP[size] || [])) {
            ctx.beginPath(); ctx.arc(padding+sx*cellSize, padding+sy*cellSize, cellSize*0.12, 0, Math.PI*2); ctx.fill();
        }

        const r = cellSize * 0.43;
        for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
                const val = boardData[row][col];
                if (val === 0) continue;
                const px = padding + col * cellSize, py = padding + row * cellSize;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2);
                ctx.fillStyle = val === 1 ? "#111" : "#eee"; ctx.fill();
                ctx.strokeStyle = val === 1 ? "#000" : "#aaa"; ctx.lineWidth = 0.8; ctx.stroke();
                if (val === 2) {
                    ctx.beginPath(); ctx.arc(px - r*0.25, py - r*0.25, r*0.25, 0, Math.PI*2);
                    ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fill();
                }
            }
        }
    }

    function loadRecognizedBoard(boardData, nextPlayerOverride = null, analyzeOnly = false) {
        const size       = boardData.length;
        const nextPlayer = nextPlayerOverride ||
            parseInt(document.getElementById("recognize-next-player").value);

        invalidatePendingAi();
        invalidateAnalysisResults();
        gameOver = false;
        hideGameMessage();
        board.resetBoard(size);
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++)
                board.board[y][x] = boardData[y][x];
        board.currentPlayer = nextPlayer;
        board.setInitialStonesFromBoard();
        document.getElementById("board-size").value = String(size);
        clearAnalysisPanels(true);
        board.draw(); updateMoveCount();
        setStatus("online", t("boardLoaded"));
        if (analyzeOnly) requestAnalysis();
        else continueFromCurrentPosition();
    }

    // ── Near-real-time screen review ─────────────────────────────────────────

    function bindLiveReview() {
        const button = document.getElementById("btn-live-review");
        if (!button) return;
        button.addEventListener("click", () => {
            if (liveReviewStream || liveReviewStarting) stopLiveReview();
            else startLiveReview();
        });
        document.getElementById("live-next-player").addEventListener("change", (event) => {
            const nextPlayer = parseInt(event.target.value);
            if (!liveLastBoard || nextPlayer === board.currentPlayer) return;
            // A board image cannot reveal a pass. Changing this selector while
            // live records one explicit pass and preserves the variation.
            invalidateAnalysisResults();
            board.passMove();
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            requestAnalysis();
            livePendingSignature = "";
            livePendingCount = 0;
        });
    }

    function imageFromClipboardData(clipboardData) {
        if (!clipboardData || !clipboardData.items) return null;
        for (const item of clipboardData.items) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
                return item.getAsFile();
            }
        }
        return null;
    }

    async function importClipboardImage() {
        if (liveReviewStream || liveReviewStarting) return;
        if (!navigator.clipboard || !navigator.clipboard.read) {
            alert(t("pasteShortcut"));
            return;
        }
        try {
            const clipboardItems = await navigator.clipboard.read();
            for (const item of clipboardItems) {
                const imageType = item.types.find((type) => type.startsWith("image/"));
                if (!imageType) continue;
                const blob = await item.getType(imageType);
                const extension = imageType.split("/")[1] || "png";
                const file = new File(
                    [blob],
                    `clipboard-${Date.now()}.${extension}`,
                    { type: imageType },
                );
                await uploadAndRecognize(file);
                return;
            }
            alert(t("clipboardNoImage"));
        } catch (err) {
            if (err.name !== "NotAllowedError") console.warn("Clipboard image read failed", err);
            alert(t("pasteShortcut"));
        }
    }

    async function startLiveReview() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            alert(t("liveUnsupported"));
            return;
        }
        closeRecognizeModal();
        const generation = ++liveReviewGeneration;
        liveReviewStarting = true;
        setLiveReviewState(true, t("liveStarting"));
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 1, max: 2 } },
                audio: false,
            });
            if (generation !== liveReviewGeneration) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            invalidatePendingAi();
            invalidateAnalysisResults();
            if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
            gameMode = "free-play";
            document.querySelectorAll(".mode-btn").forEach((button) => {
                button.classList.toggle("active", button.dataset.mode === "free-play");
            });
            liveReviewStream = stream;
            const video = document.getElementById("live-review-video");
            video.srcObject = liveReviewStream;
            await video.play();
            if (generation !== liveReviewGeneration) return;
            liveLastBoard = null;
            livePendingSignature = "";
            livePendingCount = 0;
            liveReviewStream.getVideoTracks()[0].addEventListener("ended", stopLiveReview);
            scheduleLiveFrame(250);
        } catch (err) {
            if (generation !== liveReviewGeneration) return;
            stopLiveReview();
            if (err.name !== "NotAllowedError") {
                setLiveReviewState(false, `${t("liveError")}: ${err.message}`);
            }
        } finally {
            if (generation === liveReviewGeneration) liveReviewStarting = false;
        }
    }

    function stopLiveReview() {
        const wasActive = Boolean(liveReviewStream);
        liveReviewGeneration++;
        liveReviewStarting = false;
        if (liveReviewTimer) clearTimeout(liveReviewTimer);
        liveReviewTimer = null;
        if (liveReviewAbortController) liveReviewAbortController.abort();
        liveReviewAbortController = null;
        if (liveReviewStream) {
            liveReviewStream.getTracks().forEach((track) => track.stop());
        }
        liveReviewStream = null;
        liveReviewBusy = false;
        liveLastBoard = null;
        livePendingSignature = "";
        livePendingCount = 0;
        if (wasActive) {
            invalidateAnalysisResults();
            if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
        }
        const video = document.getElementById("live-review-video");
        if (video) video.srcObject = null;
        setLiveReviewState(false, t("liveIdle"));
    }

    function setLiveReviewState(active, text) {
        const button = document.getElementById("btn-live-review");
        const status = document.getElementById("live-review-status");
        if (button) {
            button.classList.toggle("active", active);
            const label = button.querySelector(".i18n");
            if (label) label.textContent = t(active ? "liveStop" : "liveStart");
        }
        if (status) {
            status.textContent = text;
            status.classList.toggle("active", active);
        }
        document.querySelectorAll(
            ".mode-btn, #btn-camera, #btn-snipping, #btn-paste, " +
            "#btn-undo, #btn-pass, #btn-resign, #btn-new-game"
        ).forEach((control) => { control.disabled = active; });
    }

    function scheduleLiveFrame(delay = 3000) {
        if (!liveReviewStream) return;
        liveReviewTimer = setTimeout(captureLiveFrame, delay);
    }

    async function captureLiveFrame() {
        if (!liveReviewStream || liveReviewBusy) return;
        const generation = liveReviewGeneration;
        const video = document.getElementById("live-review-video");
        const canvas = document.getElementById("live-review-canvas");
        if (!video || !canvas || !video.videoWidth) {
            scheduleLiveFrame(500);
            return;
        }

        liveReviewBusy = true;
        let nextFrameDelay = 3000;
        try {
            // Downscale large desktop captures; the detector internally works at
            // 1024 px, so sending a 4K frame only wastes transfer and decode time.
            const maxSide = 1600;
            const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
            if (!blob) throw new Error("frame capture failed");
            if (generation !== liveReviewGeneration || !liveReviewStream) return;

            setLiveReviewState(true, t("liveRecognizing"));
            const controller = new AbortController();
            liveReviewAbortController = controller;
            const data = await recognizeImage(blob, { signal: controller.signal });
            if (generation !== liveReviewGeneration || !liveReviewStream) return;

            const confidence = Number(data.confidence) || 0;
            if (confidence < 0.6) {
                nextFrameDelay = 1200;
                setLiveReviewState(true,
                    `${t("liveLowConfidence")} · ${Math.round(confidence * 100)}%`);
                return;
            }

            const signature = JSON.stringify(data.board);
            const previousSignature = liveLastBoard ? JSON.stringify(liveLastBoard) : "";
            if (signature === previousSignature) {
                livePendingSignature = "";
                livePendingCount = 0;
                setLiveReviewState(true, t("liveWaiting"));
                return;
            }

            // Corner confidence does not measure stone classification quality.
            // Require every changed position to be identical in two consecutive
            // recognitions before it can alter the review tree.
            if (signature === livePendingSignature) livePendingCount++;
            else {
                livePendingSignature = signature;
                livePendingCount = 1;
            }
            if (livePendingCount < 2) {
                nextFrameDelay = 800;
                setLiveReviewState(true, t("liveVerifying"));
                return;
            }

            const sync = applyLivePosition(data.board);
            if (!sync.accepted) {
                nextFrameDelay = 1200;
                setLiveReviewState(true, t(sync.statusKey));
                return;
            }
            liveLastBoard = cloneBoard(data.board);
            livePendingSignature = "";
            livePendingCount = 0;
            document.getElementById("live-next-player").value = String(board.currentPlayer);
            const statusKey = sync.statusKey || "liveSynced";
            setLiveReviewState(true,
                `${t(statusKey)} · ${Math.round(confidence * 100)}%`);
        } catch (err) {
            if (err.name !== "AbortError" && generation === liveReviewGeneration) {
                nextFrameDelay = 2000;
                setLiveReviewState(true, `${t("liveRetrying")}: ${err.message}`);
            }
        } finally {
            if (generation === liveReviewGeneration) {
                liveReviewAbortController = null;
                liveReviewBusy = false;
                scheduleLiveFrame(nextFrameDelay);
            }
        }
    }

    function cloneBoard(source) {
        return source.map((row) => row.slice());
    }

    function boardsEqual(left, right) {
        if (!left || !right || left.length !== right.length) return false;
        return left.every((row, y) =>
            row.length === right[y].length && row.every((stone, x) => stone === right[y][x])
        );
    }

    function findLiveMoveTransition(previous, current) {
        if (!previous || !current || previous.length !== current.length) return null;
        let added = null;
        const removed = [];
        for (let y = 0; y < current.length; y++) {
            if (!Array.isArray(previous[y]) || !Array.isArray(current[y]) ||
                previous[y].length !== current[y].length) return null;
            for (let x = 0; x < current.length; x++) {
                const before = previous[y][x];
                const after = current[y][x];
                if (before === after) continue;
                if (before === 0 && (after === 1 || after === 2)) {
                    if (added) return null;
                    added = { x, y, color: after };
                }
                else if (before !== 0 && after === 0) removed.push(before);
                else return null;
            }
        }
        if (!added || removed.some((color) => color === added.color)) return null;
        return added;
    }

    function applyLivePosition(current) {
        const selectedPlayer = parseInt(document.getElementById("live-next-player").value) || 1;
        if (!liveLastBoard) {
            loadRecognizedBoard(current, selectedPlayer, true);
            return { accepted: true, statusKey: "liveSynced" };
        }

        const transition = findLiveMoveTransition(liveLastBoard, current);
        if (!transition) {
            // Multiple moves may happen while the shared window is hidden or
            // recognition is busy. Re-anchor deliberately to the user's side-to-
            // move selector instead of guessing from unreliable stone counts.
            loadRecognizedBoard(current, selectedPlayer, true);
            return { accepted: true, statusKey: "liveRelocated" };
        }
        if (board.currentPlayer !== transition.color) {
            return { accepted: false, statusKey: "liveTurnMismatch" };
        }
        if (!board.tryMove(transition.x, transition.y)) {
            return { accepted: false, statusKey: "liveIllegalChange" };
        }
        if (!boardsEqual(board.board, current)) {
            board.undo();
            return { accepted: false, statusKey: "liveIllegalChange" };
        }

        invalidateAnalysisResults();
        clearAnalysisPanels();
        board.draw();
        updateMoveCount();
        requestAnalysis();
        return { accepted: true, statusKey: "liveSynced" };
    }

    function closeRecognizeModal() {
        manualRecognitionSeq++;
        if (manualRecognitionController) manualRecognitionController.abort();
        manualRecognitionController = null;
        document.getElementById("recognize-modal").style.display = "none";
    }

})();
