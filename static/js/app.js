/**
 * KataGo Web — main application logic
 * WebSocket, game logic, auth (Proxy), i18n
 */

(function () {
    "use strict";

    // ── WebSocket event name constants ────────────────────────────────────────
    const EVENTS = {
        ANALYZE:        "analyze",
        QUICK_ANALYZE:  "quick_analyze",
        PLAY_AI:        "play_ai",
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
    const STRINGS = {};                 // { en: {...}, zh: {...} } — filled by loadLocales()
    let availableLangs = ["en", "zh"];  // overwritten by /api/config
    let serverDefaultLang = "en";       // overwritten by /api/config
    let demoFaultInjection = false;     // overwritten by /api/config (demo only)
    let currentLang = "en";             // resolved in bootstrap()

    async function loadServerConfig() {
        try {
            const cfg = await (await fetch("/api/config")).json();
            if (Array.isArray(cfg.available_languages) && cfg.available_languages.length)
                availableLangs = cfg.available_languages;
            if (cfg.default_language) serverDefaultLang = cfg.default_language;
            demoFaultInjection = !!cfg.demo_fault_injection;
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
        const dict = STRINGS[currentLang] || STRINGS[serverDefaultLang] || STRINGS.en || {};
        return dict[key] || key;
    }

    function applyTranslations() {
        document.getElementById("html-root").lang = currentLang === "zh" ? "zh-CN" : "en";

        // Elements with class="i18n" and data-key
        document.querySelectorAll(".i18n[data-key]").forEach((el) => {
            el.textContent = t(el.dataset.key);
        });

        // Auth button label (dynamic — depends on login state)
        _updateAuthArea();

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

    // ── Auth state ────────────────────────────────────────────────────────────

    const TOKEN_KEY    = "jwt_token";
    const USERNAME_KEY = "jwt_username";
    const ADMIN_KEY    = "jwt_is_admin";

    function getToken()    { return localStorage.getItem(TOKEN_KEY); }
    function getUsername() { return localStorage.getItem(USERNAME_KEY); }
    function isAdmin()     { return localStorage.getItem(ADMIN_KEY) === "1"; }

    function saveAuth(token, username, admin) {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USERNAME_KEY, username);
        localStorage.setItem(ADMIN_KEY, admin ? "1" : "0");
        _updateAuthArea();
    }

    function clearAuth() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
        localStorage.removeItem(ADMIN_KEY);
        _updateAuthArea();
    }

    function isLoggedIn() { return !!getToken(); }

    /** Inject the JWT token into a Socket.IO event payload. */
    function withToken(data) {
        const token = getToken();
        if (token) return Object.assign({}, data, { token });
        return data;
    }

    // ── Auth area DOM update ─────────────────────────────────────────────────

    function _updateAuthArea() {
        const area = document.getElementById("auth-area");
        if (!area) return;
        if (isLoggedIn()) {
            const nameEl = isAdmin()
                ? `<a href="/admin" id="auth-username-display" class="auth-username auth-admin-link">${getUsername()} ⚙</a>`
                : `<span id="auth-username-display" class="auth-username">${getUsername()}</span>`;
            area.innerHTML = nameEl +
                `<button id="btn-logout" class="btn-auth btn-auth-out">${t("signOut")}</button>`;
            document.getElementById("btn-logout").addEventListener("click", () => {
                clearAuth();
                showAuthModal(true); // mandatory — cannot use app without login
            });
        } else {
            area.innerHTML = `<button id="btn-show-login" class="btn-auth">${t("signIn")}</button>`;
            document.getElementById("btn-show-login").addEventListener("click", showAuthModal);
        }
    }

    // ── Auth modal ────────────────────────────────────────────────────────────

    let _authMode     = "login"; // "login" | "register"
    let _authRequired = false;   // when true: modal cannot be dismissed

    function showAuthModal(required = true) {
        _authRequired = required;
        _authMode     = "login";
        _renderAuthModal();
        // Hide the close button when login is mandatory
        document.getElementById("auth-modal-close").style.display =
            required ? "none" : "block";
        document.getElementById("auth-modal").style.display = "flex";
        document.getElementById("auth-username-input").value = "";
        document.getElementById("auth-password-input").value = "";
        document.getElementById("auth-error").style.display = "none";
        document.getElementById("auth-username-input").focus();
    }

    function hideAuthModal() {
        if (_authRequired) return; // cannot dismiss a required modal
        document.getElementById("auth-modal").style.display = "none";
    }

    function _renderAuthModal() {
        document.getElementById("tab-login").classList.toggle("active", _authMode === "login");
        document.getElementById("tab-register").classList.toggle("active", _authMode === "register");
        document.getElementById("auth-submit").textContent = t(_authMode === "login" ? "signIn" : "register");
        document.getElementById("auth-password-input").autocomplete =
            _authMode === "login" ? "current-password" : "new-password";
    }

    async function _submitAuth(e) {
        e.preventDefault();
        const username = document.getElementById("auth-username-input").value.trim();
        const password = document.getElementById("auth-password-input").value;
        const errEl    = document.getElementById("auth-error");

        if (!username || !password) return;

        const endpoint = _authMode === "login" ? "/api/login" : "/api/register";
        try {
            const res  = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();
            if (res.ok) {
                saveAuth(data.token, data.username, data.is_admin);
                _authRequired = false; // allow hideAuthModal to proceed
                hideAuthModal();
                // Trigger analysis now that we have a token
                if (board && board.moves !== undefined) {
                    requestAnalysis();
                }
            } else {
                errEl.textContent = data.error || "Error";
                errEl.style.display = "block";
            }
        } catch (err) {
            errEl.textContent = "Network error";
            errEl.style.display = "block";
        }
    }

    // ── App state ─────────────────────────────────────────────────────────────

    let socket = null;
    let board  = null;
    let gameMode     = "free-play";
    let isThinking   = false;
    let aiVsAiInterval = null;

    // Monotonic request id. Each requestAnalysis() bumps the counter and tags
    // its emit with reqId; the server echoes it back in the analysis result.
    // handleAnalysisResult() ignores any result whose reqId is not the latest,
    // so a stale response (from a position the user already moved past) is
    // never displayed.
    let _analysisReqSeq      = 0;
    let _latestAnalysisReqId = 0;

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
        bindNavigation();
        bindAuthModal();
        bindRecognition();

        setStatus("offline", t("connecting"));
        // Show mandatory login modal immediately if not authenticated
        if (!isLoggedIn()) showAuthModal(true);

        // Demo-only: floating button to toggle engine failure (Circuit Breaker demo).
        if (demoFaultInjection) installDemoFaultControl();
    });

    // Demo-only control: a floating button that toggles the fault-injecting
    // engine on the server, so a presenter can trip the Circuit Breaker live.
    // Only installed when /api/config reports demo_fault_injection = true.
    function installDemoFaultControl() {
        let faultOn = false;
        const btn = document.createElement("button");
        btn.id = "demo-fault-btn";
        btn.style.cssText =
            "position:fixed;right:14px;bottom:14px;z-index:9999;padding:9px 15px;" +
            "border:none;border-radius:7px;font:600 13px sans-serif;cursor:pointer;" +
            "color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35)";
        const render = () => {
            btn.textContent = faultOn ? "⚠ DEMO: engine fault ON" : "✓ DEMO: engine healthy";
            btn.style.background = faultOn ? "#c0392b" : "#2e7d32";
        };
        btn.addEventListener("click", async () => {
            try {
                const res = await fetch("/api/demo/engine-fault", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ on: !faultOn }),
                });
                const data = await res.json();
                faultOn = !!data.fault;
                render();
            } catch (e) { console.warn("demo fault toggle failed", e); }
        });
        render();
        document.body.appendChild(btn);
        // Reflect the server's current state on load.
        fetch("/api/demo/engine-fault")
            .then(r => r.json()).then(d => { faultOn = !!d.fault; render(); })
            .catch(() => {});
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────

    function connectSocket() {
        socket = io(window.location.origin, {
            transports: ["websocket", "polling"],
        });

        socket.on("connect", () => {
            setStatus("online", t("connected"));
        });

        socket.on("disconnect", () => {
            setStatus("offline", t("disconnected"));
        });

        socket.on(EVENTS.STATUS, (data) => {
            if (data.running) {
                setStatus("online", t("engineReady"));
                requestAnalysis();
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
            isThinking = false;
            if (data.code === 401) {
                showAuthModal(true);
                return;
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

    function handleUserMove(x, y) {
        if (isThinking) return;
        if (gameMode === "ai-vs-ai") return;

        if (gameMode === "free-play") {
            if (board.tryMove(x, y)) {
                board.draw();
                updateMoveCount();
                requestAnalysis();
            }
            return;
        }

        if (gameMode === "play-black" && board.currentPlayer !== 1) return;
        if (gameMode === "play-white" && board.currentPlayer !== 2) return;

        if (board.tryMove(x, y)) {
            board.draw();
            updateMoveCount();
            requestAiMove();
        }
    }

    function requestAiMove() {
        if (!socket || !socket.connected) return;
        if (!isLoggedIn()) { showAuthModal(); return; }

        isThinking = true;
        setStatus("loading", t("aiThinking"));

        const data = {
            moves:     board.moves,
            boardSize: board.size,
            komi:      getKomi(),
            maxVisits: getMaxVisits(),
        };
        if (board.initialStones) {
            data.initialStones = board.initialStones;
            data.initialPlayer = board.currentPlayer === 1 ? "B" : "W";
        }
        socket.emit(EVENTS.PLAY_AI, withToken(data));
    }

    function handleAiMove(data) {
        isThinking = false;
        setStatus("online", t("engineReady"));

        if (data.move === "pass") {
            board.passMove(); board.draw(); updateMoveCount();
            return;
        }

        const pos = board.gtpToBoard(data.move);
        if (pos && board.tryMove(pos.x, pos.y)) {
            board.draw();
            updateMoveCount();
            updateWinrate(data.winrate, data.scoreLead);
            if (gameMode === "ai-vs-ai") {
                setTimeout(() => requestAiMove(), 300);
            } else {
                requestAnalysis();
            }
        }
    }

    function requestAnalysis() {
        if (!socket || !socket.connected) return;
        if (!document.getElementById("show-analysis").checked) return;
        if (!isLoggedIn()) { showAuthModal(); return; }

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
        if (board.initialStones) {
            data.initialStones = board.initialStones;
            data.initialPlayer = board.currentPlayer === 1 ? "B" : "W";
        }
        socket.emit(EVENTS.ANALYZE, withToken(data));
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
        document.getElementById("nav-move-num").textContent   = viewIdx;
        document.getElementById("nav-move-total").textContent = "/ " + total;
        const slider = document.getElementById("nav-slider");
        slider.max   = total;
        slider.value = viewIdx;
    }

    function updateSuggestions(moves) {
        const list = document.getElementById("suggestions-list");
        if (!moves || moves.length === 0) {
            list.innerHTML = `<p class="placeholder">${t("noSuggestions")}</p>`;
            return;
        }

        const bestSL = moves[0].scoreLead;
        list.innerHTML = moves.slice(0, 10).map((m, i) => {
            const diff    = m.scoreLead - bestSL;
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
                document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                gameMode = btn.dataset.mode;
                if (gameMode !== "ai-vs-ai") { clearInterval(aiVsAiInterval); isThinking = false; }
                if (gameMode === "ai-vs-ai") requestAiMove();
                if (gameMode === "play-white" && board.currentPlayer === 1) requestAiMove();
                if (gameMode === "free-play" && board.moves.length > 0) requestAnalysis();
            });
        });

        // Action buttons
        document.getElementById("btn-undo").addEventListener("click", () => {
            if (isThinking) return;
            if (gameMode === "play-black" || gameMode === "play-white") {
                board.undo(); board.undo();
            } else {
                board.undo();
            }
            updateMoveCount();
            if (gameMode === "free-play" && board.moves.length > 0) requestAnalysis();
        });

        document.getElementById("btn-pass").addEventListener("click", () => {
            if (isThinking) return;
            board.passMove(); board.draw(); updateMoveCount();
            if (gameMode === "play-black" || gameMode === "play-white") requestAiMove();
            else if (gameMode === "free-play") requestAnalysis();
        });

        document.getElementById("btn-analyze").addEventListener("click", requestAnalysis);

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

    function bindAuthModal() {
        // Close button
        document.getElementById("auth-modal-close").addEventListener("click", hideAuthModal);
        // Click outside to close
        document.getElementById("auth-modal").addEventListener("click", (e) => {
            if (e.target.id === "auth-modal") hideAuthModal();
        });
        // Tab switching
        document.getElementById("tab-login").addEventListener("click", () => {
            _authMode = "login"; _renderAuthModal();
            document.getElementById("auth-error").style.display = "none";
        });
        document.getElementById("tab-register").addEventListener("click", () => {
            _authMode = "register"; _renderAuthModal();
            document.getElementById("auth-error").style.display = "none";
        });
        // Form submit
        document.getElementById("auth-form").addEventListener("submit", _submitAuth);
        // ESC key
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hideAuthModal();
        });
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    function bindNavigation() {
        document.getElementById("nav-start").addEventListener("click",     () => { board.navigateToStart();   onNavigated(); });
        document.getElementById("nav-back10").addEventListener("click",    () => { board.navigateBack(10);    onNavigated(); });
        document.getElementById("nav-back1").addEventListener("click",     () => { board.navigateBack(1);     onNavigated(); });
        document.getElementById("nav-forward1").addEventListener("click",  () => { board.navigateForward(1);  onNavigated(); });
        document.getElementById("nav-forward10").addEventListener("click", () => { board.navigateForward(10); onNavigated(); });
        document.getElementById("nav-end").addEventListener("click",       () => { board.navigateToEnd();     onNavigated(); });

        document.getElementById("nav-slider").addEventListener("input", (e) => {
            board.navigateTo(parseInt(e.target.value)); onNavigated();
        });

        document.addEventListener("keydown", (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
            if (document.getElementById("auth-modal").style.display !== "none") return;
            switch (e.key) {
                case "ArrowLeft":  e.preventDefault(); board.navigateBack(e.shiftKey ? 10 : 1);    onNavigated(); break;
                case "ArrowRight": e.preventDefault(); board.navigateForward(e.shiftKey ? 10 : 1); onNavigated(); break;
                case "Home":       e.preventDefault(); board.navigateToStart(); onNavigated(); break;
                case "End":        e.preventDefault(); board.navigateToEnd();   onNavigated(); break;
            }
        });
    }

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
        document.getElementById("suggestions-list").innerHTML = `<p class="placeholder">${t("suggestPlaceholder")}</p>`;
        document.getElementById("pv-display").innerHTML       = `<p class="placeholder">${t("pvPlaceholder")}</p>`;
        setStatus("online", t("engineReady"));
        if (gameMode === "play-white") requestAiMove();
        // Auto-analyse empty board if engine is ready
        requestAnalysis();
    }

    // ── Board recognition ─────────────────────────────────────────────────────

    let recognizedBoard = null;

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

    function uploadAndRecognize(file) {
        const modal   = document.getElementById("recognize-modal");
        const loading = document.getElementById("recognize-loading");
        const result  = document.getElementById("recognize-result");

        modal.style.display  = "flex";
        loading.style.display = "block";
        result.style.display  = "none";

        const fd = new FormData();
        fd.append("image", file);
        fd.append("boardSize", getBoardSize());
        fd.append("sid", socket ? socket.id : "default");

        fetch("/api/recognize", { method: "POST", body: fd })
            .then((r) => r.json())
            .then((data) => {
                loading.style.display = "none";
                if (data.error) { alert(t("recognizeFailed") + ": " + data.error); closeRecognizeModal(); return; }
                showRecognizeResult(data);
            })
            .catch((err) => {
                loading.style.display = "none";
                alert(t("uploadFailed") + ": " + err.message);
                closeRecognizeModal();
            });
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

    function loadRecognizedBoard(boardData) {
        const size       = boardData.length;
        const nextPlayer = parseInt(document.getElementById("recognize-next-player").value);

        board.resetBoard(size);
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++)
                board.board[y][x] = boardData[y][x];
        board.currentPlayer = nextPlayer;
        board.setInitialStonesFromBoard();
        document.getElementById("board-size").value = String(size);
        board.draw(); updateMoveCount();
        if (document.getElementById("show-analysis").checked) requestAnalysis();
        setStatus("online", t("boardLoaded"));
    }

    function closeRecognizeModal() {
        document.getElementById("recognize-modal").style.display = "none";
    }

})();
