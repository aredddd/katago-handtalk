/**
 * GoBoard - 围棋棋盘渲染与交互引擎
 * 支持 Canvas 绘制、触摸操作、分析可视化
 */
class GoBoard {
    constructor(canvasId, size = 19) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext("2d");
        this.size = size;

        // 棋盘数据: 0=空, 1=黑, 2=白
        this.board = this.createEmptyBoard();
        this.moves = [];            // 当前视图的棋步 (slice of fullMoveHistory)
        this.fullMoveHistory = [];   // 完整棋步历史 [["B","D4"], ...]
        this.viewIndex = 0;          // 当前浏览位置 (0=空盘, max=最新)
        this.lastMove = null;        // 最后一手位置 {x, y}
        this.onNavigate = null;      // 导航回调 (viewIndex, totalMoves)

        // 显示相关
        this.cellSize = 0;
        this.padding = 0;
        this.boardOriginX = 0;
        this.boardOriginY = 0;

        // 分析数据
        this.analysisData = null;
        this.showAnalysis = true;
        this.showOwnership = false;
        this.showMoveNumbers = false;
        this.ownershipData = null;
        this.hoveredCandidateIdx = -1; // 鼠标悬停的候选走法索引
        this.selectedCandidateIdx = -1; // 点击选中的候选（手机用）
        this.onCandidateHover = null; // 回调函数

        // 交互
        this.hoverPos = null;
        this.pendingMovePos = null;  // 手机端两步确认：第一次点击的预览位置
        this.currentPlayer = 1; // 1=黑, 2=白
        this.initialStones = null; // 识别/摆放的初始棋子 [["B","D4"], ...]
        this.onMoveCallback = null;
        this.isMobile = window.innerWidth <= 768;

        this._touchMovedSignificantly = false; // 区分拖拽和点击

        // 预加载音效（避免每次落子都从服务器请求）
        this._stoneSounds = [];
        this._captureSound = null;
        this._preloadSounds();

        // 初始化
        this._initSize();
        this._bindEvents();
        this.draw();

        // 窗口大小变化时重绘
        window.addEventListener("resize", () => {
            this.isMobile = window.innerWidth <= 768;
            this._initSize();
            this.draw();
        });
    }

    createEmptyBoard() {
        return Array.from({ length: this.size }, () => new Array(this.size).fill(0));
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
        this.pendingMovePos = null;
        this._initSize();
        this.draw();
        this._fireNavigate();
    }

    _initSize() {
        const container = this.canvas.parentElement;
        const isMobile = window.innerWidth <= 768;
        const headerH = document.getElementById('header')?.offsetHeight || 52;
        // 导航条 + 胜率条的高度预估
        const navH = 80; // nav buttons + slider + winrate strip

        let boardPixels;

        if (isMobile) {
            // 手机竖屏：宽度撑满
            boardPixels = window.innerWidth - 12;
        } else {
            // 桌面/大屏：棋盘为正方形，取可用高度和可用宽度中较小值
            // 可用高度 = 视口高度 - header - nav区域 - padding
            const availH = window.innerHeight - headerH - navH - 32;
            // 可用宽度 = board-area 的宽度（flex布局已减去panel宽度和gap）
            const boardArea = document.getElementById('board-area');
            let availW = boardArea ? boardArea.clientWidth : container.clientWidth;
            if (availW < 100) {
                // 容器还没渲染，估算
                const panelW = window.innerWidth >= 2400 ? 460 : (window.innerWidth >= 1600 ? 380 : 320);
                availW = window.innerWidth - panelW - 16 - 32;
            }
            boardPixels = Math.min(availH, availW);
        }

        boardPixels = Math.max(280, Math.floor(boardPixels));

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

    // ============== 坐标转换 ==============

    /** 将触摸/鼠标的屏幕坐标转为 canvas 逻辑坐标（归一化，兼容浏览器缩放） */
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

    /** 棋盘坐标 -> 像素坐标 */
    boardToPixel(x, y) {
        return {
            px: this.boardOriginX + x * this.cellSize,
            py: this.boardOriginY + y * this.cellSize,
        };
    }

    /** 像素坐标 -> 棋盘坐标 (带吸附) */
    pixelToBoard(px, py) {
        const x = Math.round((px - this.boardOriginX) / this.cellSize);
        const y = Math.round((py - this.boardOriginY) / this.cellSize);
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
            return { x, y };
        }
        return null;
    }

    /** 从当前棋盘状态生成 initialStones 并保存 */
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
    }

    /** 棋盘坐标 -> KataGo 坐标 (如 "D4") */
    boardToGtp(x, y) {
        // GTP: 列用 A-T (跳过I), 行从下往上 1-19
        const col = "ABCDEFGHJKLMNOPQRST"[x];
        const row = this.size - y;
        return col + row;
    }

    /** KataGo 坐标 -> 棋盘坐标 */
    gtpToBoard(gtp) {
        if (!gtp || gtp.toLowerCase() === "pass") return null;
        const col = gtp[0].toUpperCase();
        const row = parseInt(gtp.substring(1));
        const x = "ABCDEFGHJKLMNOPQRST".indexOf(col);
        const y = this.size - row;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
        return { x, y };
    }

    // ============== 围棋规则 ==============

    /** 检查一个位置的气 */
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
                // 检查四个方向
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

    /** 尝试在 (x, y) 落子，返回是否成功 */
    tryMove(x, y) {
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) return false;
        if (this.board[y][x] !== 0) return false;

        const color = this.currentPlayer;
        const opponent = color === 1 ? 2 : 1;

        // 临时落子
        const tempBoard = this.board.map(r => [...r]);
        tempBoard[y][x] = color;

        // 检查是否提掉对方的子
        let captured = [];
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

        // 检查自杀手
        const selfGroup = this._getGroup(tempBoard, x, y);
        if (selfGroup.liberties === 0) {
            return false; // 禁着点
        }

        // 落子成功 — 播放音效（有提子时播放提子音，否则播放落子音）
        if (captured.length > 0) {
            this._playCaptureSound();
        } else {
            this._playStoneSound();
        }
        this.board = tempBoard;
        const colorStr = color === 1 ? "B" : "W";
        const gtpCoord = this.boardToGtp(x, y);

        // 如果在历史中间落子，截断后续
        if (this.viewIndex < this.fullMoveHistory.length) {
            this.fullMoveHistory = this.fullMoveHistory.slice(0, this.viewIndex);
        }
        this.fullMoveHistory.push([colorStr, gtpCoord]);
        this.viewIndex = this.fullMoveHistory.length;
        this.moves = this.fullMoveHistory.slice();

        this.lastMove = { x, y };
        this.currentPlayer = opponent;

        // 清除旧分析数据和待确认
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
        }
        this.fullMoveHistory.push([colorStr, "pass"]);
        this.viewIndex = this.fullMoveHistory.length;
        this.moves = this.fullMoveHistory.slice();
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
        this.lastMove = null;
        this._fireNavigate();
    }

    /** 悔棋 - 从历史移除最后一步 */
    undo() {
        if (this.fullMoveHistory.length === 0) return false;
        this.fullMoveHistory.pop();
        this.viewIndex = this.fullMoveHistory.length;
        this._rebuildToView();
        return true;
    }

    // ============== 棋局导航 (KaTrain 风格) ==============

    /** 跳转到指定手数 */
    navigateTo(idx) {
        idx = Math.max(0, Math.min(idx, this.fullMoveHistory.length));
        if (idx === this.viewIndex) return;
        this.viewIndex = idx;
        this._rebuildToView();
    }

    /** 后退 n 步 */
    navigateBack(n = 1) {
        this.navigateTo(this.viewIndex - n);
    }

    /** 前进 n 步 */
    navigateForward(n = 1) {
        this.navigateTo(this.viewIndex + n);
    }

    /** 跳到开头 */
    navigateToStart() {
        this.navigateTo(0);
    }

    /** 跳到最新 */
    navigateToEnd() {
        this.navigateTo(this.fullMoveHistory.length);
    }

    /** 当前是否在最新手 */
    isAtEnd() {
        return this.viewIndex === this.fullMoveHistory.length;
    }

    /** 从头重放到 viewIndex 位置 */
    _rebuildToView() {
        const target = this.fullMoveHistory.slice(0, this.viewIndex);
        this.board = this.createEmptyBoard();
        this.moves = [];
        this.currentPlayer = 1;
        this.lastMove = null;

        for (const [color, gtp] of target) {
            if (gtp === "pass") {
                // 内联 pass 避免触发 fullMoveHistory 修改
                this.moves.push([this.currentPlayer === 1 ? "B" : "W", "pass"]);
                this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
                this.lastMove = null;
            } else {
                const pos = this.gtpToBoard(gtp);
                if (pos) {
                    // 内联 tryMove 核心逻辑，不修改 fullMoveHistory
                    this._replayMove(pos.x, pos.y);
                }
            }
        }
        this.analysisData = null;
        this.ownershipData = null;
        this.draw();
        this._fireNavigate();
    }

    /** 重放单步（不修改 fullMoveHistory） */
    _replayMove(x, y) {
        if (this.board[y][x] !== 0) return;
        const color = this.currentPlayer;
        const opponent = color === 1 ? 2 : 1;
        this.board[y][x] = color;

        // 提子
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
        this.lastMove = { x, y };
        this.currentPlayer = opponent;
    }

    /** 触发导航回调 */
    _fireNavigate() {
        if (this.onNavigate) {
            this.onNavigate(this.viewIndex, this.fullMoveHistory.length);
        }
    }

    // ============== 绘制 ==============

    draw() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;

        // 重置变换，清空全屏
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

        if (this.showAnalysis && this.analysisData) {
            this._drawAnalysis();
        }

        if (this.hoverPos && this.board[this.hoverPos.y][this.hoverPos.x] === 0) {
            this._drawHover();
        }

        // 手机端两步确认预览
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
        // 木纹背景
        ctx.fillStyle = "#dcb35c";
        ctx.fillRect(0, 0, w, h);

        // 添加木纹纹理
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
            // 顶部/底部列标
            const { px } = this.boardToPixel(i, 0);
            ctx.fillText(letters[i], px, this.boardOriginY - offset);

            // 左侧/右侧行标
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

                // 阴影
                ctx.fillStyle = "rgba(0,0,0,0.3)";
                ctx.beginPath();
                ctx.arc(px + 1.5, py + 1.5, r, 0, Math.PI * 2);
                ctx.fill();

                // 棋子
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

    /** 手机端两步确认：画待确认的半透明棋子 + 发光描边 */
    _drawPendingMove() {
        const ctx = this.ctx;
        const { x, y } = this.pendingMovePos;
        const { px, py } = this.boardToPixel(x, y);
        const r = this.cellSize * 0.44;
        const isBlack = this.currentPlayer === 1;

        // 半透明棋子（比 hover 更不透明）
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = isBlack ? "#222" : "#e8e8e8";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // 青色呼吸描边，提示"再点一次确认"
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

        // 画每个候选走法圆圈（从后往前画，best 在最上层）
        for (let i = candidates.length - 1; i >= 0; i--) {
            const mi = candidates[i];
            const pos = this.gtpToBoard(mi.move);
            if (!pos || this.board[pos.y][pos.x] !== 0) continue;

            const { px, py } = this.boardToPixel(pos.x, pos.y);

            // 圆圈大小：统一最大尺寸，仅靠颜色区分
            const r = cs * 0.46;

            // KaTrain 颜色：基于与最优的目差差距，从绿到紫
            const scoreDiff = Math.abs(mi.scoreLead - bestSL);
            const color = this._candidateColor(scoreDiff, i);

            // 阴影
            ctx.fillStyle = "rgba(0,0,0,0.25)";
            ctx.beginPath();
            ctx.arc(px + 1, py + 1, r, 0, Math.PI * 2);
            ctx.fill();

            // 圆圈填充
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();

            // 最优解：青色描边（KaTrain 风格）
            if (i === 0) {
                ctx.strokeStyle = "rgba(0, 220, 255, 0.9)";
                ctx.lineWidth = Math.max(2, cs * 0.06);
                ctx.stroke();
            }

            // hover 高亮描边
            const isActive = (i === this.hoveredCandidateIdx);
            if (isActive && i !== 0) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = Math.max(1.5, cs * 0.04);
                ctx.stroke();
            }

            // === 文字：目差 + 访问量 (KaTrain 风格) ===
            this._drawCandidateText(px, py, r, mi, bestSL, isMobile);
        }
    }

    /** KaTrain 颜色：绿 → 黄 → 橙 → 红 → 紫 */
    _candidateColor(scoreDiff, index) {
        // scoreDiff = 与最优解的目差绝对值
        // 映射到 0~1 范围, diff=0 → 0, diff≥5 → 1
        const t = Math.min(scoreDiff / 5.0, 1.0);

        // KaTrain 渐变: 绿(120°) → 黄(60°) → 橙(30°) → 红(0°) → 紫(300°)
        let h, s, l;
        if (t < 0.25) {
            // 绿 → 黄绿
            h = 120 - t * 4 * 60;  // 120 → 60
            s = 70 + t * 4 * 10;   // 70 → 80
            l = 42 + t * 4 * 5;    // 42 → 47
        } else if (t < 0.5) {
            // 黄绿 → 橙
            const t2 = (t - 0.25) * 4;
            h = 60 - t2 * 30;      // 60 → 30
            s = 80;
            l = 47 + t2 * 3;       // 47 → 50
        } else if (t < 0.75) {
            // 橙 → 红
            const t3 = (t - 0.5) * 4;
            h = 30 - t3 * 30;      // 30 → 0
            s = 75;
            l = 48 - t3 * 5;       // 48 → 43
        } else {
            // 红 → 紫
            const t4 = (t - 0.75) * 4;
            h = 360 - t4 * 60;     // 360(=0) → 300
            s = 65 + t4 * 10;      // 65 → 75
            l = 40 - t4 * 5;       // 40 → 35
        }

        return `hsla(${h}, ${s}%, ${l}%, 0.82)`;
    }

    /** 画候选走法圈内文字：目差 + 访问量 (KaTrain 风格) */
    _drawCandidateText(px, py, r, mi, bestSL, isMobile) {
        const ctx = this.ctx;
        const scoreDiff = mi.scoreLead - bestSL; // 负数=比最优差
        const diffStr = scoreDiff >= 0 ? `+${scoreDiff.toFixed(1)}` : scoreDiff.toFixed(1);
        const visits = mi.visits;
        const visitStr = visits >= 10000 ? (visits / 1000).toFixed(1) + "k" :
                         visits >= 1000 ? (visits / 1000).toFixed(1) + "k" :
                         String(visits);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";

        if (isMobile) {
            // 手机端：只显示目差
            const fontSize = Math.max(8, r * 0.65);
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillText(diffStr, px, py);
        } else {
            // 电脑端：上行目差，下行访问量
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

    /** 棋盘右上角显示最优解分数（类 KaTrain） */
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

        // 背景
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

        // 主分数
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = sl >= 0 ? "#6f6" : "#f88";
        ctx.fillText(text, px, py);

        // 访问量
        ctx.font = `${subFontSize}px sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(subText, px, py + fontSize + 2);
    }

    /** 画 PV 变化线（类 KaTrain：半透明棋子 + 连线） */
    _drawPVLine(candidate) {
        if (!candidate.pv || candidate.pv.length < 1) return;
        const ctx = this.ctx;
        const cs = this.cellSize;
        const isMobile = this.isMobile;
        const maxPV = isMobile ? 5 : 10;
        const pv = candidate.pv.slice(0, maxPV);

        // 确定起始颜色
        let isBlack = this.currentPlayer === 1;
        const points = [];

        for (let i = 0; i < pv.length; i++) {
            const pos = this.gtpToBoard(pv[i]);
            if (!pos) continue;
            const { px, py } = this.boardToPixel(pos.x, pos.y);
            points.push({ px, py, isBlack, num: i + 1 });
            isBlack = !isBlack;
        }

        if (points.length < 1) return;

        // 画连线
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

        // 画半透明棋子 + 编号（跳过第一步，因为它就是候选点自身）
        for (let i = 1; i < points.length; i++) {
            const p = points[i];
            const r = cs * 0.38;

            ctx.globalAlpha = 0.55;
            // 棋子
            if (p.isBlack) {
                ctx.fillStyle = "#222";
            } else {
                ctx.fillStyle = "#e8e8e8";
            }
            ctx.beginPath();
            ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
            ctx.fill();

            // 描边
            ctx.strokeStyle = p.isBlack ? "#000" : "#aaa";
            ctx.lineWidth = 0.8;
            ctx.stroke();
            ctx.globalAlpha = 1.0;

            // 编号
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
                const val = this.ownershipData[idx]; // -1 (白) to +1 (黑)
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

        // 重新按历史记录回放来确定每个位置的编号
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
            if (this.board[y][x] === 0) continue; // 已被提走

            const { px, py } = this.boardToPixel(x, y);
            const isBlack = this.board[y][x] === 1;

            ctx.fillStyle = isBlack ? "#fff" : "#000";
            ctx.font = `${Math.max(8, this.cellSize * 0.3)}px sans-serif`;
            ctx.fillText(String(num), px, py);
        }
    }

    // ============== 事件处理 ==============

    _bindEvents() {
        // 鼠标/触摸移动 -> 预览 + 候选 hover
        this.canvas.addEventListener("mousemove", (e) => {
            const { cx, cy } = this._screenToCanvas(e.clientX, e.clientY);
            const pos = this.pixelToBoard(cx, cy);
            this.hoverPos = pos;

            // 检测是否 hover 在候选走法上
            const oldIdx = this.hoveredCandidateIdx;
            this.hoveredCandidateIdx = this._hitTestCandidate(cx, cy);
            if (this.hoveredCandidateIdx !== oldIdx && this.onCandidateHover) {
                this.onCandidateHover(this.hoveredCandidateIdx);
            }
            this.canvas.style.cursor = this.hoveredCandidateIdx >= 0 ? "pointer" : "default";

            this.draw();
        });

        this.canvas.addEventListener("mouseleave", () => {
            this.hoverPos = null;
            if (this.hoveredCandidateIdx >= 0) {
                this.hoveredCandidateIdx = -1;
                if (this.onCandidateHover) this.onCandidateHover(-1);
            }
            this.draw();
        });

        // 点击 -> 落子（候选走法位置也直接落子，KaTrain 风格）
        this.canvas.addEventListener("click", (e) => {
            const { cx, cy } = this._screenToCanvas(e.clientX, e.clientY);

            // 如果点击在候选走法上，直接落子到该位置
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

        // ============== 触摸手势（两步确认落子） ==============
        // 缩放由浏览器原生二指手势处理，这里只处理单指点击落子

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
            // 如果手指明显移动过（滚动/缩放），不算点击
            if (this._touchMovedSignificantly) {
                this._touchMovedSignificantly = false;
                return;
            }

            // 多指操作结束后不处理
            if (e.changedTouches.length !== 1 || e.touches.length > 0) return;

            e.preventDefault();
            const touch = e.changedTouches[0];
            const { cx, cy } = this._screenToCanvas(touch.clientX, touch.clientY);

            // 候选走法：也走两步确认流程
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

            // 如果已有待确认位置，且与本次相同 → 确认落子
            if (this.pendingMovePos &&
                this.pendingMovePos.x === pos.x &&
                this.pendingMovePos.y === pos.y) {
                this.pendingMovePos = null;
                if (this.onMoveCallback) {
                    this.onMoveCallback(pos.x, pos.y);
                }
                return;
            }

            // 否则设为新的待确认位置
            this.pendingMovePos = { x: pos.x, y: pos.y };
            this.draw();
        }, { passive: false });
    }

    /** 预加载所有音效文件到内存 */
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
            console.warn('音效预加载失败:', e);
        }
    }

    /** 播放围棋落子音效（KaTrain 真实录音） */
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

    /** 播放提子音效 */
    _playCaptureSound() {
        try {
            if (this._captureSound) {
                this._captureSound.currentTime = 0;
                this._captureSound.play().catch(() => {});
            }
        } catch (e) {}
    }

    /** 点击测试：检测像素坐标是否在某个候选走法圆圈内 */
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

    // ============== 公开 API ==============

    setAnalysis(data) {
        this.analysisData = data;
        this.hoveredCandidateIdx = -1;
        this.selectedCandidateIdx = -1;
        if (data && data.ownership) {
            this.ownershipData = data.ownership;
        }
        this.draw();
    }

    onMove(callback) {
        this.onMoveCallback = callback;
    }
}
