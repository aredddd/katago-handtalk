/**
 * GoBoard — Go board rendering and interaction engine.
 * Supports Canvas drawing, touch input and analysis visualization.
 */
class GoBoard {
    constructor(canvasId, size = 19) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext("2d");
        this.size = size;

        // Board data: 0=empty, 1=black, 2=white
        this.board = this.createEmptyBoard();
        this.moves = [];            // moves in the current view (slice of fullMoveHistory)
        this.fullMoveHistory = [];   // full move history [["B","D4"], ...]
        this.viewIndex = 0;          // current view position (0=empty board, max=latest)
        this.lastMove = null;        // last move position {x, y}
        this.onNavigate = null;      // navigation callback (viewIndex, totalMoves)

        // Display
        this.cellSize = 0;
        this.padding = 0;
        this.boardOriginX = 0;
        this.boardOriginY = 0;

        // Analysis data
        this.analysisData = null;
        this.showAnalysis = true;
        this.showOwnership = false;
        this.showMoveNumbers = false;
        this.ownershipData = null;
        this.hoveredCandidateIdx = -1; // index of the candidate move under the mouse
        this.selectedCandidateIdx = -1; // clicked/selected candidate (mobile)
        this.onCandidateHover = null; // callback
        this.practiceOverlay = null; // { region: [{x,y}], answer: [{x,y}] }

        // Interaction
        this.hoverPos = null;
        this.keyboardPos = null;
        this._keyboardFocused = false;
        this._baseAriaLabel = typeof this.canvas.getAttribute === "function"
            ? (this.canvas.getAttribute("aria-label") || "Go board")
            : "Go board";
        this.pendingMovePos = null;  // mobile two-step confirmation: preview position of the first tap
        this.currentPlayer = 1; // 1=black, 2=white
        this.initialStones = null; // recognized/placed initial stones [["B","D4"], ...]
        this.initialPlayer = 1; // player to move before moves[] on an imported position
        this.positionHistory = [this._boardHash()]; // root + each local move
        this.onMoveCallback = null;
        // Keep this in sync with the single stacked-layout breakpoint in
        // style.css. Board sizing itself is container-driven, so changing
        // browser chrome or crossing a breakpoint can never stretch the
        // canvas or make it jump because of a second, JS-only threshold.
        this.isMobile = window.innerWidth <= 840;
        this._resizeFrame = null;
        this._resizeObserver = null;

        this._touchMovedSignificantly = false; // distinguish a drag from a tap

        // Preload sounds (avoid requesting them from the server on every move)
        this._stoneSounds = [];
        this._captureSound = null;
        this._preloadSounds();

        // Init
        this._initSize();
        this._bindEvents();
        this.draw();

        // Resize from the space the layout actually gives the board. This
        // catches sidebar changes, viewport changes, and desktop WebView2
        // resizes without maintaining a second set of guessed dimensions.
        this._handleResize = () => this._scheduleResize();
        window.addEventListener("resize", this._handleResize);
        if (typeof ResizeObserver === "function") {
            this._resizeObserver = new ResizeObserver(this._handleResize);
            this._resizeObserver.observe(this.canvas.parentElement);
        }
    }

    createEmptyBoard() {
        return Array.from({ length: this.size }, () => new Array(this.size).fill(0));
    }

    _boardHash(position = this.board) {
        return position.map((row) => row.join("")).join("");
    }

    resetBoard(newSize) {
        if (newSize) this.size = newSize;
        this.board = this.createEmptyBoard();
        this.moves = [];
        this.fullMoveHistory = [];
        this.viewIndex = 0;
        this.lastMove = null;
        this.currentPlayer = 1;
        this.analysisData = null;
        this.ownershipData = null;
        this.initialStones = null;
        this.initialPlayer = 1;
        this.positionHistory = [this._boardHash()];
        this.pendingMovePos = null;
        this.practiceOverlay = null;
        this.hoverPos = null;
        this.keyboardPos = null;
        if (typeof this.canvas.setAttribute === "function") {
            this.canvas.setAttribute("aria-label", this._baseAriaLabel);
        }
        this._initSize();
        this.draw();
        this._fireNavigate();
    }

    _initSize() {
        const container = this.canvas.parentElement;
        const rect = typeof container.getBoundingClientRect === "function"
            ? container.getBoundingClientRect()
            : { width: 0, height: 0 };
        const availableWidth = Number(container.clientWidth) || Number(rect.width) || 1;
        // In the stacked layout CSS gives board-container an aspect ratio. The
        // final width is a safe fallback for the very first layout pass and for
        // lightweight test DOMs that do not expose clientHeight.
        const availableHeight = Number(container.clientHeight) ||
            Number(rect.height) || availableWidth;
        const boardPixels = Math.max(
            1,
            Math.floor(Math.min(availableWidth, availableHeight)),
        );

        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = boardPixels * dpr;
        this.canvas.height = boardPixels * dpr;
        this.canvas.style.width = boardPixels + "px";
        this.canvas.style.height = boardPixels + "px";
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.padding = boardPixels * 0.055;
        this.cellSize = (boardPixels - 2 * this.padding) / (this.size - 1);
        this.boardOriginX = this.padding;
        this.boardOriginY = this.padding;
    }

    _scheduleResize() {
        this.isMobile = window.innerWidth <= 840;
        if (this._resizeFrame !== null) return;
        const resize = () => {
            this._resizeFrame = null;
            this._initSize();
            this.draw();
        };
        if (typeof window.requestAnimationFrame === "function") {
            this._resizeFrame = window.requestAnimationFrame(resize);
        } else {
            // Test DOMs and older embedded engines may not expose rAF.
            this._resizeFrame = 0;
            resize();
        }
    }

    // ============== Coordinate conversion ==============

    /** Convert touch/mouse screen coords to canvas logical coords (normalized, zoom-safe). */
    _screenToCanvas(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        return {
            cx: (clientX - rect.left) / rect.width * w,
            cy: (clientY - rect.top) / rect.height * h,
        };
    }

    /** Board coords -> pixel coords */
    boardToPixel(x, y) {
        return {
            px: this.boardOriginX + x * this.cellSize,
            py: this.boardOriginY + y * this.cellSize,
        };
    }

    /** Pixel coords -> board coords (with snapping) */
    pixelToBoard(px, py) {
        const x = Math.round((px - this.boardOriginX) / this.cellSize);
        const y = Math.round((py - this.boardOriginY) / this.cellSize);
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
            return { x, y };
        }
        return null;
    }

    /** Build and store initialStones from the current board state. */
    setInitialStonesFromBoard() {
        const stones = [];
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                const v = this.board[y][x];
                if (v === 1) stones.push(["B", this.boardToGtp(x, y)]);
                else if (v === 2) stones.push(["W", this.boardToGtp(x, y)]);
            }
        }
        this.initialStones = stones.length > 0 ? stones : null;
        this.initialPlayer = this.currentPlayer;
        this.positionHistory = [this._boardHash()];
    }

    /** Board coords -> KataGo coords (e.g. "D4") */
    boardToGtp(x, y) {
        // GTP: columns A-T (skip I), rows bottom-up 1-19
        const col = "ABCDEFGHJKLMNOPQRST"[x];
        const row = this.size - y;
        return col + row;
    }

    /** KataGo coords -> board coords */
    gtpToBoard(gtp) {
        if (!gtp || gtp.toLowerCase() === "pass") return null;
        const col = gtp[0].toUpperCase();
        const row = parseInt(gtp.substring(1));
        const x = "ABCDEFGHJKLMNOPQRST".indexOf(col);
        const y = this.size - row;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
        return { x, y };
    }

    // ============== Go rules ==============

    /** Get the liberties of the group at a position. */
    _getGroup(board, x, y) {
        const color = board[y][x];
        if (color === 0) return { stones: [], liberties: 0 };

        const visited = new Set();
        const stones = [];
        let liberties = 0;
        const libSet = new Set();
        const stack = [{ x, y }];

        while (stack.length > 0) {
            const { x: cx, y: cy } = stack.pop();
            const key = cy * this.size + cx;
            if (visited.has(key)) continue;
            visited.add(key);

            if (board[cy][cx] === color) {
                stones.push({ x: cx, y: cy });
                // Check the four directions
                for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
                    const nkey = ny * this.size + nx;
                    if (visited.has(nkey)) continue;
                    if (board[ny][nx] === 0) {
                        if (!libSet.has(nkey)) {
                            libSet.add(nkey);
                            liberties++;
                        }
                    } else if (board[ny][nx] === color) {
                        stack.push({ x: nx, y: ny });
                    }
                }
            }
        }
        return { stones, liberties };
    }

    /** Compute a legal move without changing history, UI, sounds, or analysis. */
    previewMove(x, y) {
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) return null;
        if (this.board[y][x] !== 0) return null;
        const color = this.currentPlayer;
        const opponent = color === 1 ? 2 : 1;
        const tempBoard = this.board.map(r => [...r]);
        tempBoard[y][x] = color;

        const captured = [];
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
            if (tempBoard[ny][nx] === opponent) {
                const group = this._getGroup(tempBoard, nx, ny);
                if (group.liberties === 0) {
                    for (const s of group.stones) {
                        tempBoard[s.y][s.x] = 0;
                        captured.push({ x: s.x, y: s.y });
                    }
                }
            }
        }

        // Check for suicide
        const selfGroup = this._getGroup(tempBoard, x, y);
        if (selfGroup.liberties === 0) return null;

        // Positional superko (Chinese rules): a move may not recreate any
        // board already seen in this local variation.
        const nextHash = this._boardHash(tempBoard);
        if (this.positionHistory.slice(0, this.viewIndex + 1).includes(nextHash)) return null;

        return { board: tempBoard, captured, nextHash, color, opponent };
    }

    /** Display or clear teaching hints without mixing them with AI candidates. */
    setPracticeOverlay(overlay = null) {
        if (!overlay) {
            this.practiceOverlay = null;
        } else {
            const normalize = (points) => (Array.isArray(points) ? points : [])
                .filter((point) => point && Number.isInteger(point.x) && Number.isInteger(point.y))
                .filter((point) => point.x >= 0 && point.y >= 0 && point.x < this.size && point.y < this.size)
                .map((point) => ({ x: point.x, y: point.y }));
            this.practiceOverlay = {
                region: normalize(overlay.region),
                answer: normalize(overlay.answer),
            };
        }
        this.draw();
    }

    /** Try to play at (x, y); return whether it succeeded. */
    tryMove(x, y, { silent = false } = {}) {
        const preview = this.previewMove(x, y);
        if (!preview) return false;
        const { board: tempBoard, captured, nextHash, color, opponent } = preview;

        // Move played — play a sound (capture sound if stones were captured, else stone sound)
        if (!silent) {
            if (captured.length > 0) {
                this._playCaptureSound();
            } else {
                this._playStoneSound();
            }
        }
        this.board = tempBoard;
        const colorStr = color === 1 ? "B" : "W";
        const gtpCoord = this.boardToGtp(x, y);

        // If playing in the middle of history, truncate the rest
        if (this.viewIndex < this.fullMoveHistory.length) {
            this.fullMoveHistory = this.fullMoveHistory.slice(0, this.viewIndex);
            this.positionHistory = this.positionHistory.slice(0, this.viewIndex + 1);
        }
        this.fullMoveHistory.push([colorStr, gtpCoord]);
        this.viewIndex = this.fullMoveHistory.length;
        this.moves = this.fullMoveHistory.slice();
        this.positionHistory.push(nextHash);

        this.lastMove = { x, y };
        this.currentPlayer = opponent;

        // Clear stale analysis data and pending confirmation
        this.analysisData = null;
        this.ownershipData = null;
        this.pendingMovePos = null;
        this._fireNavigate();

        return true;
    }

    /** pass */
    passMove() {
        const colorStr = this.currentPlayer === 1 ? "B" : "W";
        if (this.viewIndex < this.fullMoveHistory.length) {
            this.fullMoveHistory = this.fullMoveHistory.slice(0, this.viewIndex);
            this.positionHistory = this.positionHistory.slice(0, this.viewIndex + 1);
        }
        this.fullMoveHistory.push([colorStr, "pass"]);
        this.viewIndex = this.fullMoveHistory.length;
        this.moves = this.fullMoveHistory.slice();
        this.positionHistory.push(this._boardHash());
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
        this.lastMove = null;
        this.analysisData = null;
        this.ownershipData = null;
        this.pendingMovePos = null;
        this._fireNavigate();
    }

    /** Undo — remove the last move from history. */
    undo() {
        if (this.fullMoveHistory.length === 0) return false;
        this.fullMoveHistory.pop();
        this.viewIndex = this.fullMoveHistory.length;
        this._rebuildToView();
        return true;
    }

    // ============== Game navigation (KaTrain style) ==============

    /** Jump to a given move number. */
    navigateTo(idx) {
        idx = Math.max(0, Math.min(idx, this.fullMoveHistory.length));
        if (idx === this.viewIndex) return;
        this.viewIndex = idx;
        this._rebuildToView();
    }

    /** Go back n moves. */
    navigateBack(n = 1) {
        this.navigateTo(this.viewIndex - n);
    }

    /** Go forward n moves. */
    navigateForward(n = 1) {
        this.navigateTo(this.viewIndex + n);
    }

    /** Jump to the start. */
    navigateToStart() {
        this.navigateTo(0);
    }

    /** Jump to the latest move. */
    navigateToEnd() {
        this.navigateTo(this.fullMoveHistory.length);
    }

    /** Whether we are at the latest move. */
    isAtEnd() {
        return this.viewIndex === this.fullMoveHistory.length;
    }

    /** Replay from the start up to viewIndex. */
    _rebuildToView() {
        const target = this.fullMoveHistory.slice(0, this.viewIndex);
        this.board = this.createEmptyBoard();
        this.moves = [];
        // initialPlayer also matters for an imported empty board (for example,
        // after Black passed). It is therefore independent of initialStones.
        this.currentPlayer = this.initialPlayer;
        this.lastMove = null;

        // A screenshot-imported position is the immutable root of the local
        // move history. Undo/navigation must return to that position instead
        // of rebuilding from an empty board.
        if (this.initialStones) {
            for (const [color, gtp] of this.initialStones) {
                const pos = this.gtpToBoard(gtp);
                if (pos) this.board[pos.y][pos.x] = color === "B" ? 1 : 2;
            }
        }
        this.positionHistory = [this._boardHash()];

        for (const [color, gtp] of target) {
            if (gtp === "pass") {
                // Inline pass to avoid mutating fullMoveHistory
                this.moves.push([color, "pass"]);
                this.currentPlayer = color === "B" ? 2 : 1;
                this.lastMove = null;
                this.positionHistory.push(this._boardHash());
            } else {
                const pos = this.gtpToBoard(gtp);
                if (pos) {
                    // Inline the tryMove core logic, without mutating fullMoveHistory
                    this._replayMove(pos.x, pos.y, color);
                }
            }
        }
        this.analysisData = null;
        this.ownershipData = null;
        this.draw();
        this._fireNavigate();
    }

    /** Replay a single move (without mutating fullMoveHistory). */
    _replayMove(x, y, colorString = null) {
        if (this.board[y][x] !== 0) return;
        const color = colorString ? (colorString === "B" ? 1 : 2) : this.currentPlayer;
        const opponent = color === 1 ? 2 : 1;
        this.board[y][x] = color;

        // Captures
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
            if (this.board[ny][nx] === opponent) {
                const group = this._getGroup(this.board, nx, ny);
                if (group.liberties === 0) {
                    for (const s of group.stones) this.board[s.y][s.x] = 0;
                }
            }
        }

        const colorStr = color === 1 ? "B" : "W";
        this.moves.push([colorStr, this.boardToGtp(x, y)]);
        this.positionHistory.push(this._boardHash());
        this.lastMove = { x, y };
        this.currentPlayer = opponent;
    }

    /** Fire the navigation callback. */
    _fireNavigate() {
        if (this.onNavigate) {
            this.onNavigate(this.viewIndex, this.fullMoveHistory.length);
        }
    }

    // ============== Drawing ==============

    draw() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;

        // Reset transform, clear the whole canvas
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        this._drawBoardBackground(w, h);
        this._drawGrid();
        this._drawStarPoints();
        this._drawCoordinates();

        if (this.showOwnership && this.ownershipData) {
            this._drawOwnership();
        }

        this._drawStones();

        if (this.practiceOverlay) {
            this._drawPracticeOverlay();
        }

        if (this.showAnalysis && this.analysisData) {
            this._drawAnalysis();
        }

        if (this.hoverPos && this.board[this.hoverPos.y][this.hoverPos.x] === 0) {
            this._drawHover();
        }

        if (this.keyboardPos) {
            this._drawKeyboardCursor();
        }

        // Mobile two-step confirmation preview
        if (this.pendingMovePos && this.board[this.pendingMovePos.y][this.pendingMovePos.x] === 0) {
            this._drawPendingMove();
        }

        if (this.lastMove) {
            this._drawLastMoveMarker();
        }

        if (this.showMoveNumbers) {
            this._drawMoveNumbers();
        }
    }

    _drawBoardBackground(w, h) {
        const ctx = this.ctx;
        // Wood-grain background
        ctx.fillStyle = "#dcb35c";
        ctx.fillRect(0, 0, w, h);

        // Add a wood-grain texture
        ctx.fillStyle = "rgba(0,0,0,0.03)";
        for (let i = 0; i < h; i += 3) {
            ctx.fillRect(0, i, w, 1);
        }
    }

    _drawGrid() {
        const ctx = this.ctx;
        ctx.strokeStyle = "#2a2000";
        ctx.lineWidth = 1;

        for (let i = 0; i < this.size; i++) {
            const p1 = this.boardToPixel(i, 0);
            const p2 = this.boardToPixel(i, this.size - 1);
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();

            const p3 = this.boardToPixel(0, i);
            const p4 = this.boardToPixel(this.size - 1, i);
            ctx.beginPath();
            ctx.moveTo(p3.px, p3.py);
            ctx.lineTo(p4.px, p4.py);
            ctx.stroke();
        }
    }

    _drawStarPoints() {
        const ctx = this.ctx;
        let starPoints = [];

        if (this.size === 19) {
            starPoints = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
        } else if (this.size === 13) {
            starPoints = [[3,3],[3,9],[6,6],[9,3],[9,9]];
        } else if (this.size === 9) {
            starPoints = [[2,2],[2,6],[4,4],[6,2],[6,6]];
        }

        ctx.fillStyle = "#2a2000";
        for (const [x, y] of starPoints) {
            const { px, py } = this.boardToPixel(x, y);
            ctx.beginPath();
            ctx.arc(px, py, this.cellSize * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawCoordinates() {
        const ctx = this.ctx;
        ctx.fillStyle = "#5a4800";
        ctx.font = `${Math.max(9, this.cellSize * 0.32)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const letters = "ABCDEFGHJKLMNOPQRST";
        const offset = this.cellSize * 0.7;

        for (let i = 0; i < this.size; i++) {
            // Top/bottom column labels
            const { px } = this.boardToPixel(i, 0);
            ctx.fillText(letters[i], px, this.boardOriginY - offset);

            // Left/right row labels
            const { py } = this.boardToPixel(0, i);
            ctx.fillText(String(this.size - i), this.boardOriginX - offset, py);
        }
    }

    _drawStones() {
        const ctx = this.ctx;
        const r = this.cellSize * 0.46;

        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                if (this.board[y][x] === 0) continue;
                const { px, py } = this.boardToPixel(x, y);
                const isBlack = this.board[y][x] === 1;

                // Shadow
                ctx.fillStyle = "rgba(0,0,0,0.3)";
                ctx.beginPath();
                ctx.arc(px + 1.5, py + 1.5, r, 0, Math.PI * 2);
                ctx.fill();

                // Stone
                if (isBlack) {
                    const gradient = ctx.createRadialGradient(px - r*0.3, py - r*0.3, r*0.1, px, py, r);
                    gradient.addColorStop(0, "#555");
                    gradient.addColorStop(1, "#111");
                    ctx.fillStyle = gradient;
                } else {
                    const gradient = ctx.createRadialGradient(px - r*0.3, py - r*0.3, r*0.1, px, py, r);
                    gradient.addColorStop(0, "#fff");
                    gradient.addColorStop(1, "#ccc");
                    ctx.fillStyle = gradient;
                }

                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = isBlack ? "#000" : "#999";
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
        }
    }

    _drawLastMoveMarker() {
        const ctx = this.ctx;
        const { x, y } = this.lastMove;
        const { px, py } = this.boardToPixel(x, y);
        const r = this.cellSize * 0.15;
        const isBlack = this.board[y][x] === 1;

        ctx.fillStyle = isBlack ? "#fff" : "#000";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawHover() {
        const ctx = this.ctx;
        const { x, y } = this.hoverPos;
        const { px, py } = this.boardToPixel(x, y);
        const r = this.cellSize * 0.44;
        const isBlack = this.currentPlayer === 1;

        ctx.globalAlpha = 0.4;
        ctx.fillStyle = isBlack ? "#222" : "#eee";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    _drawPracticeOverlay() {
        const overlay = this.practiceOverlay || {};
        const region = Array.isArray(overlay.region) ? overlay.region : [];
        const answer = Array.isArray(overlay.answer) ? overlay.answer : [];
        const ctx = this.ctx;

        ctx.save();
        for (const point of region) {
            const { px, py } = this.boardToPixel(point.x, point.y);
            ctx.beginPath();
            ctx.arc(px, py, Math.max(6, this.cellSize * 0.56), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0, 122, 255, 0.10)";
            ctx.fill();
            ctx.lineWidth = Math.max(2, this.cellSize * 0.08);
            ctx.strokeStyle = "rgba(0, 92, 190, 0.72)";
            ctx.setLineDash([Math.max(3, this.cellSize * 0.2), Math.max(2, this.cellSize * 0.12)]);
            ctx.stroke();
        }

        ctx.setLineDash([]);
        for (const point of answer) {
            if (this.board[point.y][point.x] !== 0) continue;
            const { px, py } = this.boardToPixel(point.x, point.y);
            ctx.beginPath();
            ctx.arc(px, py, Math.max(5, this.cellSize * 0.34), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0, 122, 255, 0.72)";
            ctx.fill();
            ctx.lineWidth = Math.max(1.5, this.cellSize * 0.055);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawKeyboardCursor() {
        const ctx = this.ctx;
        const { x, y } = this.keyboardPos;
        const { px, py } = this.boardToPixel(x, y);
        ctx.save();
        ctx.strokeStyle = "#007aff";
        ctx.lineWidth = Math.max(2, this.cellSize * 0.10);
        ctx.setLineDash([
            Math.max(3, this.cellSize * 0.22),
            Math.max(2, this.cellSize * 0.12),
        ]);
        ctx.beginPath();
        ctx.arc(px, py, this.cellSize * 0.57, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    _updateKeyboardAria() {
        if (typeof this.canvas.setAttribute !== "function" || !this.keyboardPos) return;
        const { x, y } = this.keyboardPos;
        const value = this.board[y][x];
        const pointState = value === 1 ? "black stone" : value === 2 ? "white stone" : "empty";
        this.canvas.setAttribute(
            "aria-label",
            `${this._baseAriaLabel}; ${this.boardToGtp(x, y)}; ${pointState}`,
        );
    }

    /** Mobile two-step confirmation: draw the semi-transparent pending stone + glowing outline. */
    _drawPendingMove() {
        const ctx = this.ctx;
        const { x, y } = this.pendingMovePos;
        const { px, py } = this.boardToPixel(x, y);
        const r = this.cellSize * 0.44;
        const isBlack = this.currentPlayer === 1;

        // Semi-transparent stone (more opaque than hover)
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = isBlack ? "#222" : "#e8e8e8";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Cyan outline, hinting "tap again to confirm"
        ctx.strokeStyle = "rgba(0, 220, 255, 0.85)";
        ctx.lineWidth = Math.max(2, this.cellSize * 0.07);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    _drawAnalysis() {
        if (!this.analysisData || !this.analysisData.moves) return;
        const ctx = this.ctx;
        const candidates = this.analysisData.moves.slice(0, 15);
        if (candidates.length === 0) return;

        const maxVisits = candidates[0].visits || 1;
        const bestSL = candidates[0].scoreLead;
        const cs = this.cellSize;
        const isMobile = this.isMobile;

        // Draw each candidate circle (back to front, best on top)
        for (let i = candidates.length - 1; i >= 0; i--) {
            const mi = candidates[i];
            const pos = this.gtpToBoard(mi.move);
            if (!pos || this.board[pos.y][pos.x] !== 0) continue;

            const { px, py } = this.boardToPixel(pos.x, pos.y);

            // Circle size: uniform max size, distinguished only by color
            const r = cs * 0.46;

            // KaTrain color: based on the score-lead gap to the best move, green to purple
            const scoreDiff = Math.abs(mi.scoreLead - bestSL);
            const color = this._candidateColor(scoreDiff, i);

            // Shadow
            ctx.fillStyle = "rgba(0,0,0,0.25)";
            ctx.beginPath();
            ctx.arc(px + 1, py + 1, r, 0, Math.PI * 2);
            ctx.fill();

            // Circle fill
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();

            // Best move: cyan outline (KaTrain style)
            if (i === 0) {
                ctx.strokeStyle = "rgba(0, 220, 255, 0.9)";
                ctx.lineWidth = Math.max(2, cs * 0.06);
                ctx.stroke();
            }

            // Hover highlight outline
            const isActive = (i === this.hoveredCandidateIdx);
            if (isActive && i !== 0) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = Math.max(1.5, cs * 0.04);
                ctx.stroke();
            }

            // === Text: score diff + visits (KaTrain style) ===
            this._drawCandidateText(px, py, r, mi, bestSL, isMobile);
        }
    }

    /** KaTrain color: green -> yellow -> orange -> red -> purple */
    _candidateColor(scoreDiff, index) {
        // scoreDiff = absolute score-lead gap to the best move.
        // Map to the 0~1 range: diff=0 -> 0, diff>=5 -> 1
        const t = Math.min(scoreDiff / 5.0, 1.0);

        // KaTrain gradient: green(120) -> yellow(60) -> orange(30) -> red(0) -> purple(300)
        let h, s, l;
        if (t < 0.25) {
            // green -> yellow-green
            h = 120 - t * 4 * 60;  // 120 -> 60
            s = 70 + t * 4 * 10;   // 70 -> 80
            l = 42 + t * 4 * 5;    // 42 -> 47
        } else if (t < 0.5) {
            // yellow-green -> orange
            const t2 = (t - 0.25) * 4;
            h = 60 - t2 * 30;      // 60 -> 30
            s = 80;
            l = 47 + t2 * 3;       // 47 -> 50
        } else if (t < 0.75) {
            // orange -> red
            const t3 = (t - 0.5) * 4;
            h = 30 - t3 * 30;      // 30 -> 0
            s = 75;
            l = 48 - t3 * 5;       // 48 -> 43
        } else {
            // red -> purple
            const t4 = (t - 0.75) * 4;
            h = 360 - t4 * 60;     // 360(=0) -> 300
            s = 65 + t4 * 10;      // 65 -> 75
            l = 40 - t4 * 5;       // 40 -> 35
        }

        return `hsla(${h}, ${s}%, ${l}%, 0.82)`;
    }

    /** Draw the in-circle text for a candidate: score diff + visits (KaTrain style). */
    _drawCandidateText(px, py, r, mi, bestSL, isMobile) {
        const ctx = this.ctx;
        const moverDirection = this.currentPlayer === 1 ? 1 : -1;
        const scoreDiff = (mi.scoreLead - bestSL) * moverDirection;
        const diffStr = scoreDiff >= 0 ? `+${scoreDiff.toFixed(1)}` : scoreDiff.toFixed(1);
        const visits = mi.visits;
        const visitStr = visits >= 10000 ? (visits / 1000).toFixed(1) + "k" :
                         visits >= 1000 ? (visits / 1000).toFixed(1) + "k" :
                         String(visits);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";

        if (isMobile) {
            // Mobile: show only the score diff
            const fontSize = Math.max(8, r * 0.65);
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillText(diffStr, px, py);
        } else {
            // Desktop: score diff on top, visits below
            const f1 = Math.max(8, r * 0.58);
            const f2 = Math.max(6, r * 0.40);
            const gap = f1 * 0.32;

            ctx.font = `bold ${f1}px sans-serif`;
            ctx.fillText(diffStr, px, py - gap);

            ctx.font = `${f2}px sans-serif`;
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.fillText(visitStr, px, py + gap + f2 * 0.15);
        }
    }

    /** Show the best-move score in the top-right corner (KaTrain-like). */
    _drawBestMoveOverlay() {
        if (!this.analysisData || !this.analysisData.moves || this.analysisData.moves.length === 0) return;
        const best = this.analysisData.moves[0];
        const ctx = this.ctx;
        const w = this.canvas.width / (window.devicePixelRatio || 1);
        const cs = this.cellSize;

        const sl = best.scoreLead;
        const slStr = sl >= 0 ? `+${sl.toFixed(1)}` : sl.toFixed(1);
        const visitStr = best.visits >= 1000 ? (best.visits / 1000).toFixed(1) + "k" : String(best.visits);
        const text = `${slStr}`;
        const subText = visitStr;

        const fontSize = Math.max(11, cs * 0.48);
        const subFontSize = Math.max(8, cs * 0.32);
        const px = w - 8;
        const py = 14;

        // Background
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        const boxW = fontSize * 3.5;
        const boxH = fontSize + subFontSize + 8;
        const bx = px - boxW;
        const by = py - 4;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(bx, by, boxW + 4, boxH, 6);
        } else {
            ctx.rect(bx, by, boxW + 4, boxH);
        }
        ctx.fill();

        // Main score
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = sl >= 0 ? "#6f6" : "#f88";
        ctx.fillText(text, px, py);

        // Visits
        ctx.font = `${subFontSize}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(subText, px, py + fontSize + 2);
    }

    /** Draw the PV line (KaTrain-like: semi-transparent stones + connector). */
    _drawPVLine(candidate) {
        if (!candidate.pv || candidate.pv.length < 1) return;
        const ctx = this.ctx;
        const cs = this.cellSize;
        const isMobile = this.isMobile;
        const maxPV = isMobile ? 5 : 10;
        const pv = candidate.pv.slice(0, maxPV);

        // Determine the starting color
        let isBlack = this.currentPlayer === 1;
        const points = [];

        for (let i = 0; i < pv.length; i++) {
            const pos = this.gtpToBoard(pv[i]);
            if (pos) {
                const { px, py } = this.boardToPixel(pos.x, pos.y);
                points.push({ px, py, isBlack, num: i + 1 });
            }
            // A pass still consumes a turn even though it has no board point.
            isBlack = !isBlack;
        }

        if (points.length < 1) return;

        // Draw the connector
        ctx.strokeStyle = "rgba(255, 200, 0, 0.5)";
        ctx.lineWidth = Math.max(1.5, cs * 0.05);
        ctx.setLineDash([cs * 0.1, cs * 0.08]);
        ctx.beginPath();
        ctx.moveTo(points[0].px, points[0].py);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].px, points[i].py);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw semi-transparent stones + numbers. Skip move #1 only when it
        // actually has a point; if the candidate is pass, move #2 must render.
        for (const p of points) {
            if (p.num === 1) continue;
            const r = cs * 0.38;

            ctx.globalAlpha = 0.55;
            // Stone
            if (p.isBlack) {
                ctx.fillStyle = "#222";
            } else {
                ctx.fillStyle = "#e8e8e8";
            }
            ctx.beginPath();
            ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
            ctx.fill();

            // Outline
            ctx.strokeStyle = p.isBlack ? "#000" : "#aaa";
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.globalAlpha = 1.0;

            // Number
            const fontSize = Math.max(8, r * 0.75);
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = p.isBlack ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.85)";
            ctx.fillText(String(p.num), p.px, p.py);
        }
    }

    _drawOwnership() {
        if (!this.ownershipData) return;
        const ctx = this.ctx;

        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                const idx = y * this.size + x;
                const val = this.ownershipData[idx]; // -1 (white) to +1 (black)
                if (Math.abs(val) < 0.1) continue;

                const { px, py } = this.boardToPixel(x, y);
                const halfCell = this.cellSize * 0.5;

                if (val > 0) {
                    ctx.fillStyle = `rgba(0, 0, 0, ${Math.abs(val) * 0.3})`;
                } else {
                    ctx.fillStyle = `rgba(255, 255, 255, ${Math.abs(val) * 0.3})`;
                }
                ctx.fillRect(px - halfCell, py - halfCell, this.cellSize, this.cellSize);
            }
        }
    }

    _drawMoveNumbers() {
        const ctx = this.ctx;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Replay the history to determine each position's number
        const numberMap = {};
        for (let i = 0; i < this.moves.length; i++) {
            const [color, gtp] = this.moves[i];
            if (gtp === "pass") continue;
            const pos = this.gtpToBoard(gtp);
            if (pos) {
                numberMap[`${pos.x},${pos.y}`] = i + 1;
            }
        }

        for (const [key, num] of Object.entries(numberMap)) {
            const [x, y] = key.split(",").map(Number);
            if (this.board[y][x] === 0) continue; // already captured

            const { px, py } = this.boardToPixel(x, y);
            const isBlack = this.board[y][x] === 1;

            ctx.fillStyle = isBlack ? "#fff" : "#000";
            ctx.font = `${Math.max(8, this.cellSize * 0.3)}px sans-serif`;
            ctx.fillText(String(num), px, py);
        }
    }

    // ============== Event handling ==============

    _bindEvents() {
        // Mouse/touch move -> preview + candidate hover
        this.canvas.addEventListener("mousemove", (e) => {
            const { cx, cy } = this._screenToCanvas(e.clientX, e.clientY);
            const pos = this.pixelToBoard(cx, cy);
            if (this.keyboardPos && typeof this.canvas.setAttribute === "function") {
                this.canvas.setAttribute("aria-label", this._baseAriaLabel);
            }
            this.keyboardPos = null;
            this.hoverPos = pos;

            // Detect whether hovering over a candidate move
            const oldIdx = this.hoveredCandidateIdx;
            this.hoveredCandidateIdx = this._hitTestCandidate(cx, cy);
            if (this.hoveredCandidateIdx !== oldIdx && this.onCandidateHover) {
                this.onCandidateHover(this.hoveredCandidateIdx);
            }
            this.canvas.style.cursor = this.hoveredCandidateIdx >= 0 ? "pointer" : "default";

            this.draw();
        });

        this.canvas.addEventListener("mouseleave", () => {
            this.hoverPos = this.keyboardPos ? { ...this.keyboardPos } : null;
            if (this.hoveredCandidateIdx >= 0) {
                this.hoveredCandidateIdx = -1;
                if (this.onCandidateHover) this.onCandidateHover(-1);
            }
            this.draw();
        });

        // Click -> play (clicking a candidate position plays there directly, KaTrain style)
        this.canvas.addEventListener("click", (e) => {
            const { cx, cy } = this._screenToCanvas(e.clientX, e.clientY);

            // If clicking on a candidate move, play directly at that position
            const hitIdx = this._hitTestCandidate(cx, cy);
            if (hitIdx >= 0 && this.analysisData && this.analysisData.moves) {
                const mi = this.analysisData.moves[hitIdx];
                const pos = this.gtpToBoard(mi.move);
                if (pos && this.onMoveCallback) {
                    this.onMoveCallback(pos.x, pos.y);
                }
                return;
            }

            const pos = this.pixelToBoard(cx, cy);
            if (pos && this.onMoveCallback) {
                this.onMoveCallback(pos.x, pos.y);
            }
        });

        // Keyboard users can move a visible cursor and place a stone without
        // relying on a mouse or touch screen.
        this.canvas.addEventListener("focus", () => {
            this._keyboardFocused = true;
            const middle = Math.floor(this.size / 2);
            this.keyboardPos = this.lastMove
                ? { ...this.lastMove }
                : { x: middle, y: middle };
            this.hoverPos = { ...this.keyboardPos };
            this._updateKeyboardAria();
            this.draw();
        });

        this.canvas.addEventListener("blur", () => {
            this._keyboardFocused = false;
            this.keyboardPos = null;
            this.hoverPos = null;
            if (typeof this.canvas.setAttribute === "function") {
                this.canvas.setAttribute("aria-label", this._baseAriaLabel);
            }
            this.draw();
        });

        this.canvas.addEventListener("keydown", (event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const supported = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "];
            if (!supported.includes(event.key)) return;
            event.preventDefault();
            const middle = Math.floor(this.size / 2);
            if (!this.keyboardPos) {
                this.keyboardPos = { x: middle, y: middle };
                this.hoverPos = { ...this.keyboardPos };
                this._updateKeyboardAria();
                this.draw();
                // After a pointer interaction, the first Enter/Space reveals
                // the keyboard cursor instead of placing an invisible move.
                if (event.key === "Enter" || event.key === " ") return;
            }
            const point = this.keyboardPos;
            if (event.key === "Enter" || event.key === " ") {
                if (this.board[point.y][point.x] === 0 && this.onMoveCallback) {
                    this.onMoveCallback(point.x, point.y);
                    this._updateKeyboardAria();
                    this.draw();
                }
                return;
            }
            const delta = {
                ArrowLeft: [-1, 0], ArrowRight: [1, 0],
                ArrowUp: [0, -1], ArrowDown: [0, 1],
            }[event.key];
            this.keyboardPos = {
                x: Math.max(0, Math.min(this.size - 1, point.x + delta[0])),
                y: Math.max(0, Math.min(this.size - 1, point.y + delta[1])),
            };
            this.hoverPos = { ...this.keyboardPos };
            this._updateKeyboardAria();
            this.draw();
        });

        // ============== Touch gestures (two-step confirmation) ==============
        // Zoom is handled by the browser's native pinch gesture; here we only
        // handle single-finger taps to play.

        let singleTouchStart = null;

        this.canvas.addEventListener("touchstart", (e) => {
            if (e.touches.length === 1) {
                this._touchMovedSignificantly = false;
                singleTouchStart = {
                    x: e.touches[0].clientX,
                    y: e.touches[0].clientY,
                };
            }
        }, { passive: true });

        this.canvas.addEventListener("touchmove", (e) => {
            if (e.touches.length === 1 && singleTouchStart) {
                const dx = e.touches[0].clientX - singleTouchStart.x;
                const dy = e.touches[0].clientY - singleTouchStart.y;
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                    this._touchMovedSignificantly = true;
                }
            }
        }, { passive: true });

        this.canvas.addEventListener("touchend", (e) => {
            // If the finger moved significantly (scroll/zoom), don't treat it as a tap
            if (this._touchMovedSignificantly) {
                this._touchMovedSignificantly = false;
                return;
            }

            // Ignore after a multi-touch gesture ends
            if (e.changedTouches.length !== 1 || e.touches.length > 0) return;

            e.preventDefault();
            const touch = e.changedTouches[0];
            const { cx, cy } = this._screenToCanvas(touch.clientX, touch.clientY);

            // Candidate moves: also go through the two-step confirmation flow
            const hitIdx = this._hitTestCandidate(cx, cy);
            let pos;
            if (hitIdx >= 0 && this.analysisData && this.analysisData.moves) {
                const mi = this.analysisData.moves[hitIdx];
                pos = this.gtpToBoard(mi.move);
            } else {
                pos = this.pixelToBoard(cx, cy);
            }

            if (!pos) return;
            if (this.board[pos.y][pos.x] !== 0) return;

            // If there is already a pending position equal to this one -> confirm the move
            if (this.pendingMovePos &&
                this.pendingMovePos.x === pos.x &&
                this.pendingMovePos.y === pos.y) {
                this.pendingMovePos = null;
                if (this.onMoveCallback) {
                    this.onMoveCallback(pos.x, pos.y);
                }
                return;
            }

            // Otherwise set it as the new pending position
            this.pendingMovePos = { x: pos.x, y: pos.y };
            this.draw();
        }, { passive: false });
    }

    /** Preload all sound files into memory. */
    _preloadSounds() {
        try {
            for (let i = 1; i <= 5; i++) {
                const audio = new Audio(`/sounds/stone${i}.wav`);
                audio.volume = 0.8;
                audio.preload = 'auto';
                this._stoneSounds.push(audio);
            }
            this._captureSound = new Audio('/sounds/capturing.wav');
            this._captureSound.volume = 0.7;
            this._captureSound.preload = 'auto';
        } catch (e) {
            console.warn('Sound preload failed:', e);
        }
    }

    /** Play the stone-placement sound (KaTrain real recordings). */
    _playStoneSound() {
        try {
            const idx = Math.floor(Math.random() * 5); // 0~4
            const audio = this._stoneSounds[idx];
            if (audio) {
                audio.currentTime = 0;
                audio.play().catch(() => {});
            }
        } catch (e) {}
    }

    /** Play the capture sound. */
    _playCaptureSound() {
        try {
            if (this._captureSound) {
                this._captureSound.currentTime = 0;
                this._captureSound.play().catch(() => {});
            }
        } catch (e) {}
    }

    /** Hit test: whether a pixel coordinate is inside a candidate circle. */
    _hitTestCandidate(cx, cy) {
        if (!this.analysisData || !this.analysisData.moves) return -1;
        const candidates = this.analysisData.moves.slice(0, 15);
        const maxVisits = candidates[0] ? candidates[0].visits || 1 : 1;
        const cs = this.cellSize;

        for (let i = 0; i < candidates.length; i++) {
            const mi = candidates[i];
            const pos = this.gtpToBoard(mi.move);
            if (!pos || this.board[pos.y][pos.x] !== 0) continue;

            const { px, py } = this.boardToPixel(pos.x, pos.y);
            const r = cs * 0.46;

            const dx = cx - px, dy = cy - py;
            if (dx * dx + dy * dy <= r * r) return i;
        }
        return -1;
    }

    // ============== Public API ==============

    setAnalysis(data) {
        this.analysisData = data;
        this.hoveredCandidateIdx = -1;
        this.selectedCandidateIdx = -1;
        if (data && data.ownership) {
            this.ownershipData = data.ownership;
        }
        this.draw();
    }

    clearAnalysis() {
        this.analysisData = null;
        this.ownershipData = null;
        this.hoveredCandidateIdx = -1;
        this.selectedCandidateIdx = -1;
        this.draw();
    }

    onMove(callback) {
        this.onMoveCallback = callback;
    }
}
