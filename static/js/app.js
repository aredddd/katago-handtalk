/**
 * KataGo HandTalk — main application logic
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
        freePlay: "自由推演", playBlack: "执黑", playWhite: "执白", undo: "退一手",
        stepBackHint: "每次退一手，可连续退到起始局面",
        pass: "停一手", analyze: "分析", newGame: "新对局", komi: "贴目",
        analysisOn: "开启分析", analysisOff: "关闭分析",
        analysisOnHint: "显示推荐下一手", analysisOffHint: "停止推荐与候选点",
        analysisDisabled: "AI 分析已关闭", analysisWaiting: "等待分析结果…",
        suggestions: "推荐走法", mainLine: "主要变化", noSuggestions: "无推荐走法",
        suggestPlaceholder: "落子后将显示分析", pvPlaceholder: "点击推荐走法查看变化",
        pvEmpty: "无变化", confirmAction: "请确认", cancel: "取消",
        newGameDialogTitle: "开始新对局？", startNewGame: "开始新对局",
        confirmNewGame: "当前棋局、变化图和分析结果将被清空。",
        runtimeDialogTitle: "重新配置运行资源？", openRuntimeConfig: "继续配置",
        confirmRuntime: "本地服务将重启，当前未保存的推演会被清空。",
        resignDialogTitle: "确认认输？", confirmResignAction: "确认认输",
        confirmResign: "认输后当前对局将结束，但仍可开始新对局。", resigned: "棋认输",
        twoPasses: "双方连续停一手，对局结束",
        recognizing: "AI 正在识别棋盘，请稍候…", recognizeResult: "识别结果",
        recognizeCropHint: "尽量只截棋盘区域，识别会更快、更准。",
        recognizeCheckCount: "建议检查：{count} 处",
        recognizeCheckClear: "未发现明显可疑点",
        uploadFailed: "上传失败", snipThenPaste: "截图完成后，回到页面按 Ctrl+V",
        pasteShortcut: "请先截图，然后回到页面按 Ctrl+V。",
        clipboardNoImage: "剪贴板里没有图片，请先截取棋盘。",
        recognitionTimedOut: "识别超时，正在自动重试",
        recognizeKeyboard: "识别棋盘；使用方向键选择交叉点，按回车切换棋子",
        emptyPoint: "空位", blackStone: "黑子", whiteStone: "白子",
        aiTimedOut: "AI 等待超时，可以安全重试。",
        aiInvalidMove: "AI 返回了无效着法，可以安全重试。",
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
        liveNeedsResync: "检测到多处变化，请重新截图导入校正局面",
        liveUnsupported: "当前浏览器不支持屏幕共享，请使用最新版 Edge 或 Chrome。",
        liveDesktopUnsupported: "当前桌面环境不支持窗口共享，请使用系统截图导入，或在浏览器中打开实时复盘。",
        windowPin: "置顶", windowPinned: "已置顶",
        windowPinTitle: "让窗口保持在最前", windowPinnedTitle: "取消窗口置顶",
    }};
    let availableLangs = ["en", "zh"];  // overwritten by /api/config
    let serverDefaultLang = "en";       // overwritten by /api/config
    let currentLang = "en";             // resolved in bootstrap()
    let appVersion = "";
    let appCapabilities = {
        recognition: { enabled: true, available: true, reason: null },
        live_review: { available: true },
        desktop: { bridge: false, snipping: false, topmost: false },
    };

    async function loadServerConfig() {
        try {
            const cfg = await (await fetch("/api/config")).json();
            if (Array.isArray(cfg.available_languages) && cfg.available_languages.length)
                availableLangs = cfg.available_languages;
            if (cfg.default_language) serverDefaultLang = cfg.default_language;
            if (cfg.version) appVersion = String(cfg.version);
            if (cfg.capabilities && typeof cfg.capabilities === "object")
                appCapabilities = { ...appCapabilities, ...cfg.capabilities };
        } catch (e) {
            console.warn("Could not load /api/config, using defaults", e);
        }
    }

    async function loadLocales() {
        await Promise.all(availableLangs.map(async (lg) => {
            try {
                const loadedLocale = await (await fetch(`locales/${lg}.json`)).json();
                STRINGS[lg] = { ...(STRINGS[lg] || {}), ...loadedLocale };
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
        document.querySelectorAll("[data-title-key]").forEach((el) => {
            el.title = t(el.dataset.titleKey);
        });

        // Live status text (re-apply current status if already set)
        const eng = document.getElementById("engine-status");
        if (eng) {
            if (eng.classList.contains("online") && !document.getElementById("engine-text").textContent.includes("…")) {
                document.getElementById("engine-text").textContent = t("engineReady");
            }
        }
        renderAlwaysOnTopButton();
        renderAnalysisToggle();
        renderConfirmDialog();
        if (recognizedBoard) updateRecognizeUncertainCount();
    }

    function toggleLang() {
        if (availableLangs.length < 2) return;
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
    let desktopAlwaysOnTop = false;
    let desktopTopmostAvailable = false;
    let desktopTopmostSyncing = false;

    // Live review deliberately uses browser screen sharing rather than any
    // game-client integration. Frames are recognized locally by this server.
    let liveReviewStream = null;
    let liveReviewTimer = null;
    let liveReviewBusy = false;
    let liveLastBoard = null;
    let liveReviewStarting = false;
    let liveReviewGeneration = 0;
    let liveVideoFrameSequence = 0;
    let liveReviewAbortController = null;
    let liveResumeBaseline = null;
    const liveReviewTracker = new LiveReviewState.Tracker();
    let confirmDialogResolver = null;
    let confirmDialogTrigger = null;
    let confirmDialogConfig = null;
    let recognizeModalTrigger = null;
    let recognizeKeyboardPoint = null;
    let appToastTimer = null;

    // Monotonic request id. Each requestAnalysis() bumps the counter and tags
    // its emit with reqId; the server echoes it back in the analysis result.
    // handleAnalysisResult() ignores any result whose reqId is not the latest,
    // so a stale response (from a position the user already moved past) is
    // never displayed.
    let _analysisReqSeq      = 0;
    let _latestAnalysisReqId = 0;
    let _aiReqSeq            = 0;
    let _latestAiReqId       = 0;
    let aiRequestTimer = null;
    let failedAiPositionKey = null;

    function currentPositionKey() {
        if (!board) return "";
        return JSON.stringify({
            size: board.size,
            initial: board.initialStones || [],
            initialPlayer: board.initialPlayer,
            moves: board.moves,
            currentPlayer: board.currentPlayer,
            mode: gameMode,
        });
    }

    function hideAiRecovery() {
        failedAiPositionKey = null;
        const recovery = document.getElementById("ai-recovery");
        if (recovery) recovery.hidden = true;
    }

    function showAiRecovery(message) {
        failedAiPositionKey = currentPositionKey();
        const recovery = document.getElementById("ai-recovery");
        const detail = document.getElementById("ai-recovery-detail");
        if (detail) detail.textContent = message || "可以重试，或切回自由推演。";
        if (recovery) recovery.hidden = false;
    }

    function clearAiRequestTimer() {
        if (aiRequestTimer) clearTimeout(aiRequestTimer);
        aiRequestTimer = null;
    }

    function reportDesktopEvent(method, payload) {
        const api = window.pywebview && window.pywebview.api;
        if (!api || typeof api[method] !== "function") return false;
        Promise.resolve(api[method](payload)).catch(() => {});
        return true;
    }

    function applyCapabilities() {
        const languageButton = document.getElementById("btn-lang");
        if (languageButton) languageButton.hidden = availableLangs.length < 2;

        const recognition = appCapabilities.recognition || {};
        const recognitionAvailable = recognition.available !== false;
        const reasonText = recognition.reason === "dependencies_missing"
            ? "截图识别组件尚未安装"
            : recognition.reason === "models_missing"
                ? "截图识别模型尚未配置"
                : "截图识别未启用";
        document.querySelectorAll("#btn-camera, #btn-snipping, #btn-paste")
            .forEach((control) => {
                control.disabled = !recognitionAvailable;
                control.setAttribute("aria-disabled", String(!recognitionAvailable));
                if (!recognitionAvailable) control.title = reasonText;
            });
        const importCopy = document.querySelector("#btn-camera small");
        if (importCopy && !recognitionAvailable) importCopy.textContent = reasonText + "（可选）";

        const liveAvailable = recognitionAvailable &&
            (appCapabilities.live_review || {}).available !== false;
        const liveButton = document.getElementById("btn-live-review");
        if (liveButton) {
            liveButton.disabled = !liveAvailable;
            if (!liveAvailable) liveButton.title = reasonText;
        }
        const liveStatus = document.getElementById("live-review-status");
        if (liveStatus && !liveAvailable) liveStatus.textContent = reasonText;
        document.documentElement.dataset.visionAvailable = String(recognitionAvailable);
        document.documentElement.dataset.appVersion = appVersion;
    }

    function renderAlwaysOnTopButton() {
        const button = document.getElementById("btn-topmost");
        const label = document.getElementById("topmost-label");
        if (!button || !label) return;
        document.documentElement.classList.toggle("desktop-shell", desktopTopmostAvailable);
        button.classList.toggle("is-active", desktopAlwaysOnTop);
        button.setAttribute("aria-pressed", String(desktopAlwaysOnTop));
        label.textContent = t(desktopAlwaysOnTop ? "windowPinned" : "windowPin");
        const title = t(desktopAlwaysOnTop ? "windowPinnedTitle" : "windowPinTitle");
        button.title = title;
        button.setAttribute("aria-label", title);
    }

    async function syncDesktopAlwaysOnTop() {
        if (desktopTopmostSyncing) return false;
        const api = window.pywebview && window.pywebview.api;
        if (!api || typeof api.get_always_on_top !== "function" ||
            typeof api.set_always_on_top !== "function") return false;
        desktopTopmostSyncing = true;
        try {
            desktopAlwaysOnTop = Boolean(await api.get_always_on_top());
            desktopTopmostAvailable = true;
            renderAlwaysOnTopButton();
            return true;
        } catch (error) {
            console.warn("Could not read desktop window preference", error);
            return false;
        } finally {
            desktopTopmostSyncing = false;
        }
    }

    async function toggleDesktopAlwaysOnTop() {
        const button = document.getElementById("btn-topmost");
        const api = window.pywebview && window.pywebview.api;
        if (!button || !api || typeof api.set_always_on_top !== "function") return;
        button.disabled = true;
        try {
            desktopAlwaysOnTop = Boolean(
                await api.set_always_on_top(!desktopAlwaysOnTop)
            );
            desktopTopmostAvailable = true;
        } catch (error) {
            console.warn("Could not change desktop window preference", error);
        } finally {
            button.disabled = false;
            renderAlwaysOnTopButton();
        }
    }

    function reportDesktopReady() {
        return reportDesktopEvent("client_ready", {
            socketId: socket && socket.connected ? socket.id : null,
            screenSharing: Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
            clipboardRead: Boolean(navigator.clipboard && navigator.clipboard.read),
        });
    }

    window.addEventListener("pywebviewready", () => {
        reportDesktopReady();
        syncDesktopAlwaysOnTop();
    });

    function probeDesktopBridge() {
        if (!window.pywebview) return;
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (reportDesktopReady()) {
                syncDesktopAlwaysOnTop();
                clearInterval(timer);
            } else if (attempts >= 20) {
                clearInterval(timer);
            }
        }, 250);
    }

    window.addEventListener("error", (event) => {
        reportDesktopEvent("client_error", {
            message: event.message || "JavaScript error",
            source: event.filename || "",
            line: event.lineno || 0,
            column: event.colno || 0,
            stack: event.error && event.error.stack ? String(event.error.stack) : "",
        });
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        reportDesktopEvent("client_error", {
            message: reason && reason.message ? reason.message : String(reason || "Unhandled promise rejection"),
            stack: reason && reason.stack ? String(reason.stack) : "",
        });
    });

    // ── Init ──────────────────────────────────────────────────────────────────

    window.addEventListener("DOMContentLoaded", async () => {
        // 1. Load server config (default language, available languages),
        //    then the locale dictionaries, before rendering any text.
        await loadServerConfig();
        currentLang = localStorage.getItem("lang") || serverDefaultLang || "zh";
        if (!availableLangs.includes(currentLang)) currentLang = serverDefaultLang || availableLangs[0] || "zh";
        await loadLocales();

        // 2. Initialise the application.
        board = new GoBoard("goboard", 19);
        board.onMove((x, y) => handleUserMove(x, y));
        board.onCandidateHover = (idx) => highlightSuggestion(idx);
        board.onNavigate = (viewIdx, total) => updateNavUI(viewIdx, total);

        applyTranslations();
        setEvaluationUnavailable(t("analysisWaiting"));
        connectSocket();
        bindUI();
        bindRecognition();
        bindLiveReview();
        applyCapabilities();
        probeDesktopBridge();

        setStatus("offline", t("connecting"));
    });

    // ── WebSocket ─────────────────────────────────────────────────────────────

    function connectSocket() {
        socket = io(window.location.origin, {
            transports: ["websocket", "polling"],
        });

        socket.on("connect", () => {
            setStatus("online", t("connected"));
            reportDesktopReady();
            // WebView2 can finish installing the native bridge just after the
            // Socket.IO connection. A short retry records the ready state in
            // that race without affecting ordinary browsers.
            setTimeout(reportDesktopReady, 350);
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
            if (data.kind === "ai" || (!data.kind && isThinking)) {
                clearAiRequestTimer();
                isThinking = false;
                showAiRecovery(data.message || "AI 请求失败");
            }
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
        clearAiRequestTimer();
        _latestAiReqId = ++_aiReqSeq;
        isThinking = false;
        hideAiRecovery();
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

    function stepBackOneMove() {
        if (!board || board.fullMoveHistory.length === 0) return false;

        clearLiveResumeBaseline();
        invalidatePendingAi();
        invalidateAnalysisResults();
        if (socket && socket.connected) socket.emit(EVENTS.CANCEL);

        if (!board.undo()) return false;
        gameOver = false;
        hideGameMessage();
        clearAnalysisPanels();
        updateMoveCount();

        // Stepping back is a review action. Normal turn continuation would
        // make the AI immediately replay the move we just removed.
        if (isAnalysisEnabled()) requestAnalysis();
        else if (socket && socket.connected) setStatus("online", t("engineReady"));
        return true;
    }

    function clearLiveResumeBaseline() {
        liveResumeBaseline = null;
    }

    function handleUserMove(x, y) {
        if (isThinking || gameOver || liveReviewStream || liveReviewStarting) return;
        if (gameMode === "free-play") {
            if (board.tryMove(x, y)) {
                clearLiveResumeBaseline();
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
            clearLiveResumeBaseline();
            invalidateAnalysisResults();
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            requestAiMove();
        }
    }

    function requestAiMove() {
        if (!socket || !socket.connected || gameOver) return;

        hideAiRecovery();
        clearAiRequestTimer();
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
        const requestPosition = currentPositionKey();
        aiRequestTimer = setTimeout(() => {
            if (reqId !== _latestAiReqId || currentPositionKey() !== requestPosition) return;
            invalidatePendingAi();
            if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
            showAiRecovery(t("aiTimedOut"));
            setStatus("offline", "AI 等待超时");
        }, 90000);
    }

    function handleAiMove(data) {
        if (gameOver || liveReviewStream ||
            data.reqId !== _latestAiReqId) return;
        clearAiRequestTimer();
        hideAiRecovery();
        isThinking = false;
        setStatus("online", t("engineReady"));
        invalidateAnalysisResults();

        if (data.move === "pass") {
            recordPass();
            if (isAnalysisEnabled()) updateWinrate(data.winrate, data.scoreLead);
            requestAnalysis();
            return;
        }

        const pos = board.gtpToBoard(data.move);
        if (pos && board.tryMove(pos.x, pos.y)) {
            clearLiveResumeBaseline();
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            if (isAnalysisEnabled()) updateWinrate(data.winrate, data.scoreLead);
            requestAnalysis();
            return;
        }
        showAiRecovery(t("aiInvalidMove"));
        setStatus("offline", t("aiInvalidMove"));
    }

    function requestAnalysis() {
        if (!socket || !socket.connected) return;
        // Analysis and AI move generation share one KataGo single-flight slot.
        // Do not let a manual overlay refresh cancel the AI move that the game
        // is currently waiting for.
        if (isThinking && isAiTurn()) return;
        if (!isAnalysisEnabled()) return;

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
        // Closing analysis is also a display privacy boundary: a result that
        // was already in flight must never paint candidates back onto the board.
        if (!isAnalysisEnabled()) return;
        setStatus("online", t("engineReady"));
        board.setAnalysis(data);
        updateWinrate(data.winrate, data.scoreLead);
        updateSuggestions(data.moves || []);
    }

    // ── UI update ─────────────────────────────────────────────────────────────

    const MODAL_FOCUSABLE_SELECTOR = [
        "button:not([disabled])",
        "[href]",
        "input:not([disabled]):not([type='hidden'])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function modalFocusables(modal) {
        if (!modal) return [];
        return Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((element) => {
            if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
            const style = window.getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" &&
                element.getClientRects().length > 0;
        });
    }

    function trapModalFocus(event, modal) {
        if (event.key !== "Tab") return;
        const focusable = modalFocusables(modal);
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!modal.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function showToast(message, duration = 5200) {
        const toast = document.getElementById("app-toast");
        if (!toast) return;
        clearTimeout(appToastTimer);
        toast.textContent = String(message || "");
        toast.hidden = false;
        appToastTimer = setTimeout(() => {
            toast.hidden = true;
            appToastTimer = null;
        }, duration);
    }

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
            `<p class="placeholder">${isAnalysisEnabled() ? t("suggestPlaceholder") : t("analysisDisabled")}</p>`;
        document.getElementById("pv-display").innerHTML =
            `<p class="placeholder">${isAnalysisEnabled() ? t("pvPlaceholder") : t("analysisDisabled")}</p>`;
        if (resetEvaluation) setEvaluationUnavailable(
            isAnalysisEnabled() ? t("analysisWaiting") : t("analysisDisabled")
        );
    }

    function setEvaluationUnavailable(reason) {
        document.getElementById("winrate-black").textContent = "—";
        document.getElementById("winrate-white").textContent = "—";
        document.getElementById("score-lead").textContent = "—";
        document.getElementById("winrate-bar-black").style.width = "50%";
        const strip = document.getElementById("winrate-strip");
        strip.classList.add("is-disabled");
        strip.title = reason || t("analysisWaiting");
        strip.setAttribute("aria-label", reason || t("analysisWaiting"));
    }

    function isAnalysisEnabled() {
        const setting = document.getElementById("show-analysis");
        return Boolean(setting && setting.checked);
    }

    function renderAnalysisToggle() {
        const button = document.getElementById("btn-analyze");
        if (!button) return;
        const enabled = isAnalysisEnabled();
        button.classList.toggle("active", enabled);
        button.classList.toggle("btn-accent", enabled);
        button.setAttribute("aria-pressed", String(enabled));
        document.getElementById("analysis-toggle-icon").textContent = enabled ? "Ⅱ" : "✦";
        document.getElementById("analysis-toggle-label").textContent =
            t(enabled ? "analysisOff" : "analysisOn");
        document.getElementById("analysis-toggle-hint").textContent =
            t(enabled ? "analysisOffHint" : "analysisOnHint");
    }

    function setAnalysisEnabled(enabled, { request = true } = {}) {
        const setting = document.getElementById("show-analysis");
        if (!setting) return;
        setting.checked = Boolean(enabled);
        if (!board) {
            renderAnalysisToggle();
            return;
        }

        board.showAnalysis = setting.checked;
        if (!setting.checked) {
            invalidateAnalysisResults();
            // Analysis and AI moves share one backend query slot. Never cancel
            // here while the AI is choosing its move.
            const mayCancelAnalysis = socket && socket.connected &&
                !(isThinking && isAiTurn());
            if (mayCancelAnalysis) socket.emit(EVENTS.CANCEL);

            const ownership = document.getElementById("show-ownership");
            ownership.checked = false;
            board.showOwnership = false;
            document.getElementById("btn-position").classList.remove("active");
            document.getElementById("btn-position").setAttribute("aria-pressed", "false");
            board.clearAnalysis();
            clearAnalysisPanels(true);
            if (!isThinking && socket && socket.connected) {
                setStatus("online", t("engineReady"));
            }
        } else {
            board.draw();
            if (request) requestAnalysis();
        }
        renderAnalysisToggle();
    }

    function renderConfirmDialog() {
        const config = confirmDialogConfig || {
            titleKey: "newGameDialogTitle",
            messageKey: "confirmNewGame",
            confirmKey: "startNewGame",
            icon: "＋",
            danger: false,
        };
        const content = document.getElementById("confirm-dialog");
        if (!content) return;
        content.classList.toggle("is-danger", Boolean(config.danger));
        document.getElementById("confirm-icon").textContent = config.icon || "＋";
        document.getElementById("confirm-eyebrow").textContent = t("confirmAction");
        document.getElementById("confirm-title").textContent = t(config.titleKey);
        document.getElementById("confirm-message").textContent = t(config.messageKey);
        document.getElementById("confirm-cancel").textContent = t("cancel");
        document.getElementById("confirm-accept").textContent = t(config.confirmKey);
    }

    function closeConfirmDialog(accepted) {
        const modal = document.getElementById("confirm-modal");
        if (modal) modal.hidden = true;
        const resolve = confirmDialogResolver;
        const trigger = confirmDialogTrigger;
        confirmDialogResolver = null;
        confirmDialogTrigger = null;
        confirmDialogConfig = null;
        if (resolve) resolve(Boolean(accepted));
        if (trigger && typeof trigger.focus === "function") {
            window.setTimeout(() => trigger.focus(), 0);
        }
    }

    function showConfirmDialog(config) {
        if (confirmDialogResolver) closeConfirmDialog(false);
        confirmDialogConfig = config;
        confirmDialogTrigger = document.activeElement;
        renderConfirmDialog();
        const modal = document.getElementById("confirm-modal");
        modal.hidden = false;
        return new Promise((resolve) => {
            confirmDialogResolver = resolve;
            window.requestAnimationFrame(() => {
                if (!modal.hidden && confirmDialogResolver === resolve) {
                    document.getElementById("confirm-cancel").focus();
                }
            });
        });
    }

    function recordPass() {
        clearLiveResumeBaseline();
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
        const strip = document.getElementById("winrate-strip");
        strip.classList.remove("is-disabled");
        strip.removeAttribute("title");
        const wrB = (blackWr * 100).toFixed(1);
        const wrW = ((1 - blackWr) * 100).toFixed(1);
        document.getElementById("winrate-black").textContent = wrB + "%";
        document.getElementById("winrate-white").textContent = wrW + "%";
        document.getElementById("score-lead").textContent =
            (scoreLead >= 0 ? t("black") + "+" : t("white") + "+") +
            Math.abs(scoreLead).toFixed(1);
        document.getElementById("winrate-bar-black").style.width = wrB + "%";
        strip.setAttribute(
            "aria-label",
            `${t("black")} ${wrB}%，${t("white")} ${wrW}%，${
                scoreLead >= 0 ? t("black") : t("white")
            } ${Math.abs(scoreLead).toFixed(1)} 目`,
        );
    }

    function updateMoveCount() {
        updateNavUI(board.viewIndex, board.fullMoveHistory.length);
    }

    function updateNavUI(viewIdx, total) {
        const moveNum = document.getElementById("nav-move-num");
        const moveTotal = document.getElementById("nav-move-total");
        if (moveNum) moveNum.textContent = viewIdx;
        if (moveTotal) moveTotal.textContent = "/ " + total;
        const stepBack = document.getElementById("btn-undo");
        if (stepBack) {
            stepBack.disabled = viewIdx <= 0 || Boolean(liveReviewStream || liveReviewStarting);
        }
        const slider = document.getElementById("nav-slider");
        if (slider) {
            slider.max = total;
            slider.value = viewIdx;
        }
    }

    function updateSuggestions(moves) {
        const list = document.getElementById("suggestions-list");
        list.replaceChildren();
        if (!moves || moves.length === 0) {
            const placeholder = document.createElement("p");
            placeholder.className = "placeholder";
            placeholder.textContent = t("noSuggestions");
            list.appendChild(placeholder);
            return;
        }

        const bestSL = moves[0].scoreLead;
        moves.slice(0, 5).forEach((m, i) => {
            // KataGo values are normalized to Black's perspective. For White
            // to move, a lower black lead is better, so invert the delta.
            const moverDirection = board.currentPlayer === 1 ? 1 : -1;
            const diff    = (m.scoreLead - bestSL) * moverDirection;
            const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
            const sl      = m.scoreLead >= 0 ? `+${m.scoreLead.toFixed(1)}` : m.scoreLead.toFixed(1);
            const label = i === 0 ? `最佳，${m.move}` : `${m.move}，相比最佳${Math.abs(diff).toFixed(1)}目`;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "suggestion-item";
            button.setAttribute("aria-label", label);
            button.dataset.index = String(i);
            const values = [
                ["rank-dot", diffStr], ["move-name", String(m.move)],
                ["score-abs", sl], ["wr", `${(m.winrate * 100).toFixed(1)}%`],
                ["visits-count", formatVisits(m.visits)],
            ];
            values.forEach(([className, value]) => {
                const span = document.createElement("span");
                span.className = className;
                span.textContent = value;
                if (className === "rank-dot") {
                    span.style.background = candidateDotColor(Math.abs(diff));
                }
                button.appendChild(span);
            });
            button.addEventListener("click", () => {
                board.selectedCandidateIdx = (board.selectedCandidateIdx === i) ? -1 : i;
                board.draw();
                highlightSuggestion(board.selectedCandidateIdx);
                showPV(m.pv);
            });
            button.addEventListener("mouseenter", () => { board.hoveredCandidateIdx = i; board.draw(); });
            button.addEventListener("mouseleave", () => { board.hoveredCandidateIdx = -1; board.draw(); });
            list.appendChild(button);
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
        display.replaceChildren();
        if (!pv || pv.length === 0) {
            const placeholder = document.createElement("p");
            placeholder.className = "placeholder";
            placeholder.textContent = t("pvEmpty");
            display.appendChild(placeholder);
            return;
        }
        let isBlack = board.currentPlayer === 1;
        pv.forEach((move, i) => {
            const stoneClass = isBlack ? "black" : "white";
            isBlack = !isBlack;
            const item = document.createElement("span");
            item.className = `pv-move ${stoneClass}`;
            item.textContent = `${i + 1}.${move}`;
            display.appendChild(item);
        });
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
        document.getElementById("btn-topmost").addEventListener(
            "click", toggleDesktopAlwaysOnTop
        );
        document.getElementById("btn-runtime-config").addEventListener("click", async () => {
            const api = window.pywebview && window.pywebview.api;
            if (!api || typeof api.open_runtime_configuration !== "function") return;
            const accepted = await showConfirmDialog({
                titleKey: "runtimeDialogTitle",
                messageKey: "confirmRuntime",
                confirmKey: "openRuntimeConfig",
                icon: "⌁",
                danger: false,
            });
            if (accepted) await api.open_runtime_configuration();
        });

        document.getElementById("btn-retry-ai").addEventListener("click", () => {
            if (failedAiPositionKey && failedAiPositionKey === currentPositionKey() && isAiTurn()) {
                requestAiMove();
            } else {
                hideAiRecovery();
                continueFromCurrentPosition();
            }
        });
        document.getElementById("btn-free-after-error").addEventListener("click", () => {
            invalidatePendingAi();
            gameMode = "free-play";
            document.querySelectorAll(".mode-btn").forEach((button) => {
                const active = button.dataset.mode === gameMode;
                button.classList.toggle("active", active);
                button.setAttribute("aria-pressed", String(active));
            });
            requestAnalysis();
        });

        // Mode buttons
        document.querySelectorAll(".mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                invalidatePendingAi();
                invalidateAnalysisResults();
                gameMode = btn.dataset.mode;
                document.querySelectorAll(".mode-btn").forEach((button) => {
                    const active = button.dataset.mode === gameMode;
                    button.classList.toggle("active", active);
                    button.setAttribute("aria-pressed", String(active));
                });
                continueFromCurrentPosition();
            });
        });

        // Action buttons
        document.getElementById("btn-undo").addEventListener("click", () => {
            stepBackOneMove();
        });

        document.getElementById("btn-pass").addEventListener("click", () => {
            if (isThinking || gameOver) return;
            invalidateAnalysisResults();
            if (recordPass()) continueFromCurrentPosition();
            else requestAnalysis();
        });

        document.getElementById("btn-analyze").addEventListener("click", () => {
            setAnalysisEnabled(!isAnalysisEnabled());
        });

        document.getElementById("btn-position").addEventListener("click", () => {
            if (!isAnalysisEnabled()) setAnalysisEnabled(true, { request: false });
            const ownership = document.getElementById("show-ownership");
            ownership.checked = !ownership.checked;
            board.showOwnership = ownership.checked;
            const positionButton = document.getElementById("btn-position");
            positionButton.classList.toggle("active", ownership.checked);
            positionButton.setAttribute("aria-pressed", String(ownership.checked));
            board.draw();
            requestAnalysis();
        });

        document.getElementById("btn-resign").addEventListener("click", async () => {
            if (gameOver) return;
            const accepted = await showConfirmDialog({
                titleKey: "resignDialogTitle",
                messageKey: "confirmResign",
                confirmKey: "confirmResignAction",
                icon: "⚑",
                danger: true,
            });
            if (!accepted) return;
            clearLiveResumeBaseline();
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

        document.getElementById("btn-new-game").addEventListener("click", async () => {
            const accepted = await showConfirmDialog({
                titleKey: "newGameDialogTitle",
                messageKey: "confirmNewGame",
                confirmKey: "startNewGame",
                icon: "＋",
                danger: false,
            });
            if (accepted) newGame();
        });

        document.getElementById("confirm-cancel").addEventListener(
            "click", () => closeConfirmDialog(false)
        );
        document.getElementById("confirm-accept").addEventListener(
            "click", () => closeConfirmDialog(true)
        );
        document.getElementById("confirm-modal").addEventListener("click", (event) => {
            if (event.target === event.currentTarget) closeConfirmDialog(false);
        });
        document.addEventListener("keydown", (event) => {
            const modal = document.getElementById("confirm-modal");
            if (event.key === "Escape" && !modal.hidden) {
                event.preventDefault();
                closeConfirmDialog(false);
            } else if (!modal.hidden) {
                trapModalFocus(event, modal);
            }
        });

        document.getElementById("board-size").addEventListener("change", newGame);

        document.getElementById("show-analysis").addEventListener("change", (e) => {
            setAnalysisEnabled(e.target.checked);
        });

        document.getElementById("show-ownership").addEventListener("change", (e) => {
            board.showOwnership = e.target.checked; board.draw();
            const positionButton = document.getElementById("btn-position");
            positionButton.classList.toggle("active", e.target.checked);
            positionButton.setAttribute("aria-pressed", String(e.target.checked));
            if (e.target.checked && board.moves.length > 0) requestAnalysis();
        });

        document.getElementById("show-move-number").addEventListener("change", (e) => {
            board.showMoveNumbers = e.target.checked; board.draw();
        });

        let settingsRefreshTimer = null;
        ["komi", "max-visits"].forEach((id) => {
            const control = document.getElementById(id);
            const stored = localStorage.getItem(`setting:${id}`);
            if (stored && Array.from(control.options).some((option) => option.value === stored)) {
                control.value = stored;
            }
            control.addEventListener("change", () => {
                localStorage.setItem(`setting:${id}`, control.value);
                clearTimeout(settingsRefreshTimer);
                settingsRefreshTimer = setTimeout(() => {
                    if (isThinking && isAiTurn()) return;
                    invalidateAnalysisResults();
                    if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
                    clearAnalysisPanels(true);
                    requestAnalysis();
                }, 250);
            });
        });

        document.querySelectorAll(".section-toggle").forEach((toggle) => {
            toggle.addEventListener("click", () => {
                const body = document.getElementById(toggle.dataset.target);
                if (body) {
                    body.classList.toggle("collapsed");
                    toggle.setAttribute("aria-expanded", String(!body.classList.contains("collapsed")));
                    toggle.setAttribute("aria-controls", body.id);
                    const icon = toggle.querySelector(".toggle-icon");
                    if (icon) icon.style.transform = body.classList.contains("collapsed") ? "rotate(-90deg)" : "";
                }
            });
        });
    }

    function newGame() {
        clearLiveResumeBaseline();
        liveReviewTracker.reset();
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
    let recognizedUncertainPoints = new Set();
    let manualRecognitionSeq = 0;
    let manualRecognitionBusy = false;
    let manualRecognitionAbortController = null;
    let recognitionSourcePreviewUrl = "";

    function bindRecognition() {
        const cameraInput = document.getElementById("camera-input");
        const modal       = document.getElementById("recognize-modal");

        document.getElementById("btn-camera").addEventListener("click", () => {
            if (manualRecognitionBusy || (appCapabilities.recognition || {}).available === false) return;
            cameraInput.value = ""; cameraInput.click();
        });

        cameraInput.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) uploadAndRecognize(file);
        });

        document.getElementById("btn-snipping").addEventListener("click", launchSnippingTool);

        document.getElementById("btn-paste").addEventListener("click", importClipboardImage);
        document.addEventListener("paste", (event) => {
            if (liveReviewStream || liveReviewStarting) return;
            const file = imageFromClipboardData(event.clipboardData);
            if (!file) return;
            event.preventDefault();
            uploadAndRecognize(file);
        });

        document.getElementById("modal-close").addEventListener("click",   closeRecognizeModal);
        document.getElementById("btn-recognize-cancel").addEventListener("click", closeRecognizeModal);
        modal.addEventListener("click", (e) => { if (e.target === modal) closeRecognizeModal(); });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && modal.style.display !== "none") {
                event.preventDefault();
                closeRecognizeModal();
            } else if (modal.style.display !== "none") {
                trapModalFocus(event, modal);
            }
        });

        document.getElementById("btn-recognize-retry").addEventListener("click", () => {
            closeRecognizeModal();
            setTimeout(() => { cameraInput.value = ""; cameraInput.click(); }, 200);
        });

        document.getElementById("btn-recognize-confirm").addEventListener("click", () => {
            if (recognizedBoard) {
                loadRecognizedBoard(recognizedBoard, null, false, true);
                closeRecognizeModal();
            }
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

    async function prepareManualRecognitionImage(file) {
        if (!file || !file.type || !file.type.startsWith("image/")) return file;
        let bitmap = null;
        try {
            bitmap = await createImageBitmap(file);
            const maxSide = 1600;
            const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext("2d", { alpha: false });
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve) =>
                canvas.toBlob(resolve, "image/jpeg", 0.90));
            if (!blob) throw new Error("JPEG conversion failed");
            const stem = (file.name || `board-${Date.now()}`).replace(/\.[^.]+$/, "");
            return new File([blob], `${stem}.jpg`, {
                type: "image/jpeg",
                lastModified: file.lastModified || Date.now(),
            });
        } catch (error) {
            // Decoding can fail for an uncommon clipboard format. Sending the
            // original is preferable to making screenshot import unavailable.
            console.warn("Screenshot optimization failed; using original image", error);
            return file;
        } finally {
            if (bitmap && typeof bitmap.close === "function") bitmap.close();
        }
    }

    function setManualRecognitionBusy(busy) {
        manualRecognitionBusy = busy;
        const recognitionAvailable = (appCapabilities.recognition || {}).available !== false;
        document.querySelectorAll("#btn-camera, #btn-snipping, #btn-paste")
            .forEach((control) => { control.disabled = busy || !recognitionAvailable; });
        const liveAvailable = recognitionAvailable &&
            (appCapabilities.live_review || {}).available !== false;
        const liveButton = document.getElementById("btn-live-review");
        if (liveButton) liveButton.disabled = busy || !liveAvailable;
    }

    function setRecognitionSourcePreview(file) {
        if (recognitionSourcePreviewUrl) URL.revokeObjectURL(recognitionSourcePreviewUrl);
        recognitionSourcePreviewUrl = "";
        const preview = document.getElementById("recognize-source-preview");
        if (!preview || !file) return;
        recognitionSourcePreviewUrl = URL.createObjectURL(file);
        preview.src = recognitionSourcePreviewUrl;
        preview.hidden = false;
    }

    async function uploadAndRecognize(file) {
        if (liveReviewStream || liveReviewStarting || manualRecognitionBusy ||
            (appCapabilities.recognition || {}).available === false) return;
        const modal   = document.getElementById("recognize-modal");
        const loading = document.getElementById("recognize-loading");
        const result  = document.getElementById("recognize-result");
        const requestId = ++manualRecognitionSeq;
        const controller = new AbortController();
        manualRecognitionAbortController = controller;
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort("timeout");
        }, 45000);
        setManualRecognitionBusy(true);
        setRecognitionSourcePreview(file);
        document.getElementById("recognize-error").textContent = "";

        recognizeModalTrigger = document.activeElement;
        modal.style.display  = "flex";
        loading.style.display = "block";
        result.style.display  = "none";
        window.requestAnimationFrame(() => {
            if (modal.style.display !== "none" && requestId === manualRecognitionSeq) {
                document.getElementById("btn-recognize-cancel").focus();
            }
        });

        try {
            const optimizedFile = await prepareManualRecognitionImage(file);
            const data = await recognizeImage(optimizedFile, { signal: controller.signal });
            if (requestId !== manualRecognitionSeq) return;
            loading.style.display = "none";
            showRecognizeResult(data);
        } catch (err) {
            if (requestId !== manualRecognitionSeq) return;
            if (err.name === "AbortError" && !timedOut) return;
            loading.style.display = "none";
            document.getElementById("recognize-error").textContent =
                timedOut ? "识别超时，请缩小截图后重试。" : t("uploadFailed") + ": " + err.message;
            loading.style.display = "block";
        } finally {
            clearTimeout(timeoutId);
            if (requestId === manualRecognitionSeq) {
                manualRecognitionAbortController = null;
                setManualRecognitionBusy(false);
            }
        }
    }

    function showRecognizeResult(data) {
        const result = document.getElementById("recognize-result");
        result.style.display = "flex";
        recognizedBoard = data.board;
        recognizedUncertainPoints = collectUncertainPoints(data);

        const conf = Math.round(Number(data.confidence) * 100);
        document.getElementById("recognize-confidence").textContent =
            `🧠 CNN | ${conf}%`;
        document.getElementById("recognize-auto-status").textContent =
            t("recognizeResult");
        updateRecognizeUncertainCount();

        initRecognizeCanvas();
        drawRecognizeCanvas(recognizedBoard);
        window.requestAnimationFrame(() => {
            const canvas = document.getElementById("recognize-board-canvas");
            if (canvas && document.getElementById("recognize-modal").style.display !== "none") {
                canvas.focus();
            }
        });
    }

    function collectUncertainPoints(data) {
        const boardData = Array.isArray(data.board) ? data.board : [];
        const points = new Set();
        const addPoint = (row, col) => {
            row = Number(row); col = Number(col);
            if (Number.isInteger(row) && Number.isInteger(col) &&
                row >= 0 && row < boardData.length &&
                col >= 0 && col < (boardData[row] || []).length) {
                points.add(`${row},${col}`);
            }
        };
        for (const point of (Array.isArray(data.uncertain_points) ? data.uncertain_points : [])) {
            if (Array.isArray(point)) addPoint(point[0], point[1]);
            else if (point && typeof point === "object")
                addPoint(point.row ?? point.y, point.col ?? point.x);
        }
        for (let row = 0; row < boardData.length; row++) {
            for (let col = 0; col < boardData[row].length; col++) {
                const confidence = Number(data.cell_confidence?.[row]?.[col]);
                const margin = Number(data.cell_margin?.[row]?.[col]);
                if ((Number.isFinite(confidence) && confidence < 0.75) ||
                    (Number.isFinite(margin) && margin < 0.20)) addPoint(row, col);
            }
        }
        return points;
    }

    function updateRecognizeUncertainCount() {
        const count = document.getElementById("recognize-uncertain-count");
        if (!count) return;
        count.textContent = recognizedUncertainPoints.size
            ? t("recognizeCheckCount").replace("{count}", recognizedUncertainPoints.size)
            : t("recognizeCheckClear");
        count.classList.toggle("has-uncertain", recognizedUncertainPoints.size > 0);
    }

    let _recognizeCanvasSize = 0;

    function updateRecognizeCanvasAria() {
        const canvas = document.getElementById("recognize-board-canvas");
        if (!canvas || !recognizedBoard || !recognizeKeyboardPoint) return;
        const { row, col } = recognizeKeyboardPoint;
        const coordinate = "ABCDEFGHJKLMNOPQRST"[col] + (recognizedBoard.length - row);
        const value = recognizedBoard[row][col];
        const valueLabel = t(["emptyPoint", "blackStone", "whiteStone"][value] || "emptyPoint");
        canvas.setAttribute(
            "aria-label",
            `${t("recognizeKeyboard")}；${coordinate}：${valueLabel}`,
        );
    }

    function cycleRecognizedPoint(row, col) {
        if (!recognizedBoard || row < 0 || col < 0 ||
            row >= recognizedBoard.length || col >= recognizedBoard.length) return;
        recognizedBoard[row][col] = (recognizedBoard[row][col] + 1) % 3;
        recognizedUncertainPoints.delete(`${row},${col}`);
        recognizeKeyboardPoint = { row, col };
        updateRecognizeUncertainCount();
        updateRecognizeCanvasAria();
        drawRecognizeCanvas(recognizedBoard);
    }

    function initRecognizeCanvas() {
        const canvas  = document.getElementById("recognize-board-canvas");
        const parentW = canvas.parentElement.clientWidth || 380;
        _recognizeCanvasSize = Math.min(parentW - 10, 420);
        canvas.width = canvas.height = _recognizeCanvasSize;
        canvas.style.width = canvas.style.height = _recognizeCanvasSize + "px";
        const middle = Math.floor(recognizedBoard.length / 2);
        recognizeKeyboardPoint = { row: middle, col: middle };
        updateRecognizeCanvasAria();

        if (canvas._recognizeClickHandler) {
            canvas.removeEventListener("click", canvas._recognizeClickHandler);
            canvas.removeEventListener("keydown", canvas._recognizeKeyHandler);
            canvas.removeEventListener("focus", canvas._recognizeFocusHandler);
            canvas.removeEventListener("blur", canvas._recognizeBlurHandler);
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
                cycleRecognizedPoint(row, col);
            }
        };
        canvas._recognizeKeyHandler = (event) => {
            if (!recognizedBoard) return;
            const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const point = recognizeKeyboardPoint || { row: 0, col: 0 };
            if (event.key === "Enter" || event.key === " ") {
                cycleRecognizedPoint(point.row, point.col);
                return;
            }
            const delta = {
                ArrowLeft: [0, -1], ArrowRight: [0, 1],
                ArrowUp: [-1, 0], ArrowDown: [1, 0],
            }[event.key];
            recognizeKeyboardPoint = {
                row: Math.max(0, Math.min(recognizedBoard.length - 1, point.row + delta[0])),
                col: Math.max(0, Math.min(recognizedBoard.length - 1, point.col + delta[1])),
            };
            updateRecognizeCanvasAria();
            drawRecognizeCanvas(recognizedBoard);
        };
        canvas._recognizeFocusHandler = () => {
            updateRecognizeCanvasAria();
            if (recognizedBoard) drawRecognizeCanvas(recognizedBoard);
        };
        canvas._recognizeBlurHandler = () => {
            if (recognizedBoard) drawRecognizeCanvas(recognizedBoard);
        };
        canvas.addEventListener("click", canvas._recognizeClickHandler);
        canvas.addEventListener("keydown", canvas._recognizeKeyHandler);
        canvas.addEventListener("focus", canvas._recognizeFocusHandler);
        canvas.addEventListener("blur", canvas._recognizeBlurHandler);
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

        ctx.strokeStyle = "#ff9500";
        ctx.lineWidth = Math.max(2, cellSize * 0.10);
        for (const key of recognizedUncertainPoints) {
            const [row, col] = key.split(",").map(Number);
            const px = padding + col * cellSize, py = padding + row * cellSize;
            ctx.beginPath();
            ctx.arc(px, py, cellSize * 0.52, 0, Math.PI * 2);
            ctx.stroke();
        }

        if (document.activeElement === canvas && recognizeKeyboardPoint) {
            const { row, col } = recognizeKeyboardPoint;
            const px = padding + col * cellSize, py = padding + row * cellSize;
            ctx.save();
            ctx.strokeStyle = "#007aff";
            ctx.lineWidth = Math.max(2, cellSize * 0.11);
            ctx.setLineDash([Math.max(3, cellSize * 0.22), Math.max(2, cellSize * 0.12)]);
            ctx.beginPath();
            ctx.arc(px, py, cellSize * 0.58, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    function loadRecognizedBoard(
        boardData,
        nextPlayerOverride = null,
        analyzeOnly = false,
        trustForLive = false,
    ) {
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
        document.getElementById("live-next-player").value = String(nextPlayer);
        if (trustForLive) {
            liveResumeBaseline = {
                board: LiveReviewState.cloneBoard(boardData),
                nextPlayer,
            };
        }
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
            if (!liveReviewStream) {
                if (liveResumeBaseline) liveResumeBaseline.nextPlayer = nextPlayer;
                return;
            }
            if (!liveLastBoard || nextPlayer === board.currentPlayer) return;
            // A board image cannot reveal a pass. Changing this selector while
            // live records one explicit pass and preserves the variation.
            invalidateAnalysisResults();
            board.passMove();
            clearAnalysisPanels();
            board.draw();
            updateMoveCount();
            requestAnalysis();
            liveReviewTracker.commit(liveLastBoard);
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

    function desktopApi() {
        return window.pywebview && window.pywebview.api ? window.pywebview.api : null;
    }

    function isDesktopShell() {
        return Boolean(window.pywebview);
    }

    async function launchSnippingTool() {
        const api = desktopApi();
        if (api && typeof api.open_snipping_tool === "function") {
            try {
                const launched = await api.open_snipping_tool();
                if (launched !== false) {
                    setStatus("online", t("snipThenPaste"));
                    return;
                }
            } catch (err) {
                console.warn("Native Snipping Tool launch failed; using the Windows protocol", err);
            }
        }

        // Browser fallback. The Windows capture protocol copies the result to
        // the clipboard, ready for Ctrl+V or the paste button.
        const launcher = document.createElement("a");
        launcher.href = "ms-screenclip://capture/image?rectangle&enabledModes=SnippingAllModes&user-agent=KataGoWeb";
        launcher.click();
        setStatus("online", t("snipThenPaste"));
    }

    function base64ImageToFile(value, fallbackMime = "image/png") {
        if (typeof value !== "string" || !value.trim()) return null;
        let encoded = value.trim();
        let mimeType = fallbackMime;
        const dataUrl = encoded.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
        if (dataUrl) {
            mimeType = dataUrl[1] || mimeType;
            encoded = dataUrl[3];
            if (!dataUrl[2]) {
                const decoded = decodeURIComponent(encoded);
                return new File(
                    [new TextEncoder().encode(decoded)],
                    `clipboard-${Date.now()}.png`,
                    { type: mimeType },
                );
            }
        }
        try {
            const binary = atob(encoded.replace(/\s/g, ""));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const extension = mimeType.split("/")[1] || "png";
            return new File(
                [bytes],
                `clipboard-${Date.now()}.${extension}`,
                { type: mimeType },
            );
        } catch (err) {
            console.warn("Native clipboard returned an invalid image", err);
            return null;
        }
    }

    function nativeClipboardPayloadToFile(payload) {
        if (!payload) return null;
        if (payload instanceof Blob) {
            const mimeType = payload.type || "image/png";
            const extension = mimeType.split("/")[1] || "png";
            return new File([payload], `clipboard-${Date.now()}.${extension}`, { type: mimeType });
        }
        if (typeof payload === "string") return base64ImageToFile(payload);
        if (typeof payload !== "object") return null;

        const mimeType = payload.mimeType || payload.mime_type || "image/png";
        const value = payload.dataUrl || payload.data_url || payload.base64 || payload.data;
        return base64ImageToFile(value, mimeType);
    }

    async function importNativeClipboardImage() {
        const api = desktopApi();
        if (!api) return null;
        const reader = api.read_clipboard_image || api.get_clipboard_image;
        if (typeof reader !== "function") return null;
        try {
            const file = nativeClipboardPayloadToFile(await reader.call(api));
            if (!file) return false;
            await uploadAndRecognize(file);
            return true;
        } catch (err) {
            console.warn("Native clipboard image read failed", err);
            return null;
        }
    }

    async function importClipboardImage() {
        if (liveReviewStream || liveReviewStarting) return;
        let clipboardWasReadable = false;
        if (navigator.clipboard && navigator.clipboard.read) {
            try {
                const clipboardItems = await navigator.clipboard.read();
                clipboardWasReadable = true;
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
            } catch (err) {
                if (err.name !== "NotAllowedError") console.warn("Clipboard image read failed", err);
            }
        }
        const nativeResult = await importNativeClipboardImage();
        if (nativeResult === true) return;
        showToast(t(clipboardWasReadable || nativeResult === false ? "clipboardNoImage" : "pasteShortcut"));
    }

    async function startLiveReview() {
        if ((appCapabilities.recognition || {}).available === false) {
            setLiveReviewState(false, "截图识别未配置");
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            const message = t(isDesktopShell() ? "liveDesktopUnsupported" : "liveUnsupported");
            setLiveReviewState(false, message);
            showToast(message, 7000);
            return;
        }
        closeRecognizeModal();
        const generation = ++liveReviewGeneration;
        liveReviewStarting = true;
        setLiveReviewState(true, t("liveStarting"));
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 2, max: 2 } },
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
                const active = button.dataset.mode === "free-play";
                button.classList.toggle("active", active);
                button.setAttribute("aria-pressed", String(active));
            });
            liveReviewStream = stream;
            const video = document.getElementById("live-review-video");
            video.srcObject = liveReviewStream;
            await video.play();
            if (generation !== liveReviewGeneration) return;
            const resumeBaseline = liveResumeBaseline;
            liveLastBoard = resumeBaseline
                ? LiveReviewState.cloneBoard(resumeBaseline.board)
                : null;
            liveResumeBaseline = null;
            if (resumeBaseline && resumeBaseline.nextPlayer !== board.currentPlayer) {
                board.passMove();
                clearAnalysisPanels();
                board.draw();
                updateMoveCount();
            }
            gameOver = false;
            hideGameMessage();
            liveReviewTracker.reset(liveLastBoard);
            if (liveLastBoard) requestAnalysis();
            liveReviewStream.getVideoTracks()[0].addEventListener("ended", stopLiveReview);
            scheduleLiveFrame(250);
        } catch (err) {
            if (generation !== liveReviewGeneration) return;
            stopLiveReview();
            if (err.name !== "NotAllowedError") {
                const unsupported = isDesktopShell() &&
                    ["NotSupportedError", "NotFoundError", "SecurityError"].includes(err.name);
                setLiveReviewState(false, unsupported
                    ? t("liveDesktopUnsupported")
                    : `${t("liveError")}: ${err.message}`);
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
        if (liveLastBoard) {
            liveResumeBaseline = {
                board: LiveReviewState.cloneBoard(liveLastBoard),
                nextPlayer: board.currentPlayer,
            };
        }
        liveLastBoard = null;
        liveReviewTracker.reset();
        if (wasActive) {
            invalidateAnalysisResults();
            if (socket && socket.connected) socket.emit(EVENTS.CANCEL);
            setStatus("online", t("engineReady"));
            requestAnalysis();
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
            "#btn-pass, #btn-resign, #btn-new-game"
        ).forEach((control) => { control.disabled = active; });
        const stepBack = document.getElementById("btn-undo");
        if (stepBack) stepBack.disabled = active || !board || board.viewIndex <= 0;
    }

    function scheduleLiveFrame(delay = 350) {
        if (!liveReviewStream) return;
        liveReviewTimer = setTimeout(captureLiveFrame, delay);
    }

    async function waitForNextLiveVideoFrame(video) {
        if (typeof video.requestVideoFrameCallback !== "function") return undefined;
        return new Promise((resolve) => {
            let callbackId = null;
            let settled = false;
            const finish = (frameId) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(frameId);
            };
            const timeoutId = setTimeout(() => {
                if (callbackId !== null &&
                    typeof video.cancelVideoFrameCallback === "function") {
                    video.cancelVideoFrameCallback(callbackId);
                }
                finish(null);
            }, 1200);
            callbackId = video.requestVideoFrameCallback((_time, metadata) => {
                const presentedFrames = Number(metadata?.presentedFrames);
                const mediaTime = Number(metadata?.mediaTime);
                finish(Number.isFinite(presentedFrames)
                    ? `frame-${presentedFrames}`
                    : (Number.isFinite(mediaTime)
                        ? `time-${mediaTime}`
                        : `callback-${++liveVideoFrameSequence}`));
            });
        });
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
        let nextFrameDelay = 350;
        let recognitionTimeoutId = null;
        let recognitionTimedOut = false;
        try {
            const frameId = await waitForNextLiveVideoFrame(video);
            if (generation !== liveReviewGeneration || !liveReviewStream) return;
            if (frameId === null) {
                liveReviewTracker.rejectFrame("video-frame-timeout");
                setLiveReviewState(true, t("liveWaiting"));
                return;
            }
            // Downscale large desktop captures; the detector internally works at
            // 1024 px, so sending a 4K frame only wastes transfer and decode time.
            const maxSide = 1600;
            const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.90));
            if (!blob) throw new Error("frame capture failed");
            if (generation !== liveReviewGeneration || !liveReviewStream) return;

            setLiveReviewState(true, t("liveRecognizing"));
            const controller = new AbortController();
            liveReviewAbortController = controller;
            recognitionTimeoutId = setTimeout(() => {
                recognitionTimedOut = true;
                controller.abort("timeout");
            }, 30000);
            const data = await recognizeImage(blob, { signal: controller.signal });
            clearTimeout(recognitionTimeoutId);
            recognitionTimeoutId = null;
            if (generation !== liveReviewGeneration || !liveReviewStream) return;

            const sourceConfidence = Number(data.source_confidence ?? data.confidence) || 0;
            const rectifiedConfidence = Number(
                data.rectified_confidence ?? data.confidence
            ) || 0;
            // Full-window captures in this UI commonly score 0.60-0.65 on the
            // original frame even when the geometrically checked second pass is
            // exact.  Keep obviously unsafe historical cases (<0.55) out while
            // allowing those real desktop layouts through.
            if (sourceConfidence < 0.55 || rectifiedConfidence < 0.70) {
                liveReviewTracker.rejectFrame("low-corner-confidence");
                setLiveReviewState(true,
                    `${t("liveLowConfidence")} · ${Math.round(sourceConfidence * 100)}%`);
                return;
            }

            // Never combine low-confidence points with an older board. Each
            // candidate is one complete, freshly recognized model result.
            if (!liveChangedPointsAreReliable(data, liveLastBoard)) {
                liveReviewTracker.rejectFrame("uncertain-changed-point");
                setLiveReviewState(true, t("liveLowConfidence"));
                return;
            }

            const current = LiveReviewState.cloneBoard(data.board);
            const decision = liveReviewTracker.observe(current, { frameId });
            if (decision.reason === "unchanged") {
                setLiveReviewState(true, t("liveWaiting"));
                return;
            }
            if (decision.reason === "move-rejected") {
                setLiveReviewState(true, t(decision.statusKey || "liveIllegalChange"));
                return;
            }
            if (decision.effect === "none") {
                nextFrameDelay = 100;
                const progress = decision.required
                    ? ` · ${decision.streak}/${decision.required}`
                    : "";
                setLiveReviewState(true, `${t("liveVerifying")}${progress}`);
                return;
            }

            const sync = applyLiveDecision(decision, current);
            if (!sync.accepted) {
                nextFrameDelay = 100;
                setLiveReviewState(true, t(sync.statusKey));
                return;
            }
            liveLastBoard = LiveReviewState.cloneBoard(current);
            liveReviewTracker.commit(current);
            document.getElementById("live-next-player").value = String(board.currentPlayer);
            const statusKey = sync.statusKey || "liveSynced";
            setLiveReviewState(true,
                `${t(statusKey)} · ${Math.round(sourceConfidence * 100)}%`);
        } catch (err) {
            if (generation !== liveReviewGeneration) return;
            if (err.name === "AbortError" && !recognitionTimedOut) return;
            liveReviewTracker.rejectFrame(recognitionTimedOut
                ? "recognition-timeout"
                : "recognition-error");
            nextFrameDelay = 1600;
            setLiveReviewState(true, recognitionTimedOut
                ? t("recognitionTimedOut")
                : `${t("liveRetrying")}: ${err.message}`);
        } finally {
            if (recognitionTimeoutId) clearTimeout(recognitionTimeoutId);
            if (generation === liveReviewGeneration) {
                liveReviewAbortController = null;
                liveReviewBusy = false;
                scheduleLiveFrame(nextFrameDelay);
            }
        }
    }

    function liveChangedPointsAreReliable(data, previous) {
        const current = data.board;
        if (!LiveReviewState.isSquareBoard(current)) return false;
        if (!previous) {
            const stoneConfidence = Number(data.stone_confidence);
            return Number.isFinite(stoneConfidence) && stoneConfidence >= 0.70;
        }
        if (!LiveReviewState.isSquareBoard(previous) || previous.length !== current.length) {
            return false;
        }
        for (let row = 0; row < current.length; row++) {
            for (let col = 0; col < current[row].length; col++) {
                if (current[row][col] === previous[row][col]) continue;
                const confidence = Number(data.cell_confidence?.[row]?.[col]);
                const margin = Number(data.cell_margin?.[row]?.[col]);
                if (!Number.isFinite(confidence) || confidence < 0.75 ||
                    !Number.isFinite(margin) || margin < 0.20) return false;
            }
        }
        return true;
    }

    function applyLiveDecision(decision, current) {
        const selectedPlayer = parseInt(document.getElementById("live-next-player").value) || 1;
        if (decision.effect === "anchor") {
            loadRecognizedBoard(current, selectedPlayer, true);
            return { accepted: true, statusKey: "liveSynced" };
        }
        if (decision.effect === "global-resync") {
            loadRecognizedBoard(current, selectedPlayer, true);
            return { accepted: true, statusKey: "liveRelocated" };
        }
        const transition = decision.transition;
        if (!transition) return { accepted: false, statusKey: "liveNeedsResync" };
        if (board.currentPlayer !== transition.color) {
            liveReviewTracker.markMoveRejected("liveTurnMismatch");
            return { accepted: false, statusKey: "liveTurnMismatch" };
        }
        const preview = board.previewMove(transition.x, transition.y);
        if (!preview || !LiveReviewState.boardsEqual(preview.board, current)) {
            liveReviewTracker.markMoveRejected("liveIllegalChange");
            return { accepted: false, statusKey: "liveIllegalChange" };
        }
        if (!board.tryMove(transition.x, transition.y)) {
            liveReviewTracker.markMoveRejected("liveIllegalChange");
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
        const modal = document.getElementById("recognize-modal");
        const wasOpen = modal.style.display !== "none";
        const trigger = recognizeModalTrigger;
        recognizeModalTrigger = null;
        if (manualRecognitionAbortController) manualRecognitionAbortController.abort("closed");
        manualRecognitionAbortController = null;
        manualRecognitionSeq++;
        setManualRecognitionBusy(false);
        recognizedUncertainPoints.clear();
        if (recognitionSourcePreviewUrl) URL.revokeObjectURL(recognitionSourcePreviewUrl);
        recognitionSourcePreviewUrl = "";
        const preview = document.getElementById("recognize-source-preview");
        if (preview) {
            preview.removeAttribute("src");
            preview.hidden = true;
        }
        modal.style.display = "none";
        if (wasOpen && trigger && typeof trigger.focus === "function") {
            window.setTimeout(() => trigger.focus(), 0);
        }
    }

})();
