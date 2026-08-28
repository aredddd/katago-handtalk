/**
 * PracticeState - dependency-free SGF problem parsing and practice state.
 *
 * This deliberately implements the small FF[4] subset used by HandTalk's
 * life-and-death exercises. It is safe to load directly in a browser and can
 * also be required from Node for tests and content tooling.
 */
(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }
    if (root) root.PracticeState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
    const DAY_MS = 24 * 60 * 60 * 1000;
    const DEFAULT_INTERVALS = Object.freeze({
        wrong: 10 * 60 * 1000,
        revealed: 6 * 60 * 60 * 1000,
        hinted: DAY_MS,
        clean: Object.freeze([DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS]),
    });

    class SgfSyntaxError extends SyntaxError {
        constructor(message, offset) {
            super(`${message} (at character ${offset})`);
            this.name = "SgfSyntaxError";
            this.offset = offset;
        }
    }

    function assertInteger(value, label) {
        if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
    }

    function dimensionsOf(size) {
        if (Number.isInteger(size)) return { width: size, height: size };
        if (size && Number.isInteger(size.width) && Number.isInteger(size.height)) {
            return { width: size.width, height: size.height };
        }
        if (size && size.dimensions) return dimensionsOf(size.dimensions);
        throw new TypeError("Board size must be an integer or {width, height}");
    }

    function parseDimensions(rawValue) {
        const value = String(rawValue == null ? "19" : rawValue).trim();
        const match = /^(\d+)(?::(\d+))?$/.exec(value);
        if (!match) throw new TypeError(`Invalid SZ value: ${value}`);
        const width = Number(match[1]);
        const height = Number(match[2] || match[1]);
        if (width < 2 || width > 52 || height < 2 || height > 52) {
            throw new RangeError("SGF board dimensions must be between 2 and 52");
        }
        return { width, height };
    }

    function sgfAxisToNumber(character) {
        const code = character.charCodeAt(0);
        if (code >= 97 && code <= 122) return code - 97;
        if (code >= 65 && code <= 90) return code - 65 + 26;
        return -1;
    }

    function numberToSgfAxis(value) {
        assertInteger(value, "SGF axis");
        if (value >= 0 && value < 26) return String.fromCharCode(97 + value);
        if (value >= 26 && value < 52) return String.fromCharCode(65 + value - 26);
        throw new RangeError("SGF coordinates support axes from 0 to 51");
    }

    /** Convert an FF[4] point such as "cd" into top-left-origin board coordinates. */
    function sgfToPoint(value, size = 19) {
        const dimensions = dimensionsOf(size);
        if (value === "" || value == null) return null; // A move with [] is pass.
        const coordinate = String(value).trim();
        if (coordinate.length !== 2) throw new TypeError(`Invalid SGF point: ${coordinate}`);
        const x = sgfAxisToNumber(coordinate[0]);
        const y = sgfAxisToNumber(coordinate[1]);
        if (x < 0 || y < 0 || x >= dimensions.width || y >= dimensions.height) {
            throw new RangeError(`SGF point ${coordinate} is outside the board`);
        }
        return { x, y };
    }

    /** Convert top-left-origin board coordinates to an FF[4] point. */
    function pointToSgf(point, size = 19) {
        if (point == null || String(point).toLowerCase() === "pass") return "";
        const dimensions = dimensionsOf(size);
        const normalized = Array.isArray(point)
            ? { x: Number(point[0]), y: Number(point[1]) }
            : { x: Number(point.x), y: Number(point.y) };
        assertInteger(normalized.x, "Point x");
        assertInteger(normalized.y, "Point y");
        if (normalized.x < 0 || normalized.y < 0 ||
            normalized.x >= dimensions.width || normalized.y >= dimensions.height) {
            throw new RangeError("Point is outside the board");
        }
        return numberToSgfAxis(normalized.x) + numberToSgfAxis(normalized.y);
    }

    function pointToGtp(point, size = 19) {
        if (point == null) return "pass";
        const dimensions = dimensionsOf(size);
        const normalized = sgfToPoint(pointToSgf(point, dimensions), dimensions);
        if (normalized.x >= GTP_COLUMNS.length) {
            throw new RangeError("GTP conversion supports boards up to 25 columns");
        }
        return GTP_COLUMNS[normalized.x] + String(dimensions.height - normalized.y);
    }

    function gtpToPoint(value, size = 19) {
        const dimensions = dimensionsOf(size);
        const coordinate = String(value == null ? "" : value).trim();
        if (!coordinate || coordinate.toLowerCase() === "pass") return null;
        const match = /^([A-Za-z])(\d+)$/.exec(coordinate);
        if (!match) throw new TypeError(`Invalid GTP point: ${coordinate}`);
        const x = GTP_COLUMNS.indexOf(match[1].toUpperCase());
        const row = Number(match[2]);
        const y = dimensions.height - row;
        if (x < 0 || x >= dimensions.width || y < 0 || y >= dimensions.height) {
            throw new RangeError(`GTP point ${coordinate} is outside the board`);
        }
        return { x, y };
    }

    function clonePoint(point) {
        return point == null ? null : { x: point.x, y: point.y };
    }

    function pointsEqual(left, right) {
        if (left == null || right == null) return left == null && right == null;
        return left.x === right.x && left.y === right.y;
    }

    function cloneMatrix(matrix) {
        return matrix.map((row) => row.slice());
    }

    function emptyMatrix(size) {
        const dimensions = dimensionsOf(size);
        return Array.from({ length: dimensions.height }, () =>
            Array(dimensions.width).fill(0)
        );
    }

    function expandPointValue(value, size) {
        const raw = String(value);
        const separator = raw.indexOf(":");
        if (separator < 0) return [sgfToPoint(raw, size)];
        if (raw.indexOf(":", separator + 1) >= 0) {
            throw new TypeError(`Invalid compressed point range: ${raw}`);
        }
        const start = sgfToPoint(raw.slice(0, separator), size);
        const end = sgfToPoint(raw.slice(separator + 1), size);
        if (!start || !end) throw new TypeError("Setup ranges cannot contain pass points");
        const points = [];
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) points.push({ x, y });
        }
        return points;
    }

    function propertyValues(nodeOrProperties, name) {
        const properties = nodeOrProperties && nodeOrProperties.properties
            ? nodeOrProperties.properties
            : nodeOrProperties;
        if (!properties) return [];
        return properties[String(name).toUpperCase()] || [];
    }

    /** Build the 0/1/2 board matrix from root AB/AW setup properties. */
    function createInitialMatrix(rootOrProblem, explicitSize) {
        if (rootOrProblem && Array.isArray(rootOrProblem.initialBoard) && explicitSize == null) {
            return cloneMatrix(rootOrProblem.initialBoard);
        }
        const root = rootOrProblem && rootOrProblem.root ? rootOrProblem.root : rootOrProblem;
        const size = explicitSize || (rootOrProblem && (rootOrProblem.dimensions || rootOrProblem.size)) || 19;
        const result = emptyMatrix(size);
        for (const [property, color] of [["AB", 1], ["AW", 2]]) {
            for (const value of propertyValues(root, property)) {
                for (const point of expandPointValue(value, size)) {
                    if (!point) throw new TypeError(`${property} cannot contain a pass point`);
                    if (result[point.y][point.x] && result[point.y][point.x] !== color) {
                        throw new TypeError(`Root setup overlaps at ${pointToSgf(point, size)}`);
                    }
                    result[point.y][point.x] = color;
                }
            }
        }
        return result;
    }

    function parseRawSgf(source) {
        if (typeof source !== "string") throw new TypeError("SGF source must be a string");
        let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
        let nextNodeId = 0;

        function fail(message) {
            throw new SgfSyntaxError(message, index);
        }

        function skipSpace() {
            while (index < source.length && /\s/.test(source[index])) index++;
        }

        function expect(character) {
            skipSpace();
            if (source[index] !== character) fail(`Expected '${character}'`);
            index++;
        }

        function readValue() {
            if (source[index] !== "[") fail("Expected property value");
            index++;
            let value = "";
            while (index < source.length) {
                const character = source[index++];
                if (character === "]") return value;
                if (character !== "\\") {
                    if (character === "\r") {
                        if (source[index] === "\n") index++;
                        value += "\n";
                    } else {
                        value += character;
                    }
                    continue;
                }
                if (index >= source.length) fail("Unterminated escape sequence");
                const escaped = source[index++];
                if (escaped === "\r") {
                    if (source[index] === "\n") index++;
                } else if (escaped !== "\n") {
                    value += escaped;
                }
            }
            fail("Unterminated property value");
        }

        function readNode() {
            expect(";");
            const properties = Object.create(null);
            while (true) {
                skipSpace();
                const start = index;
                while (index < source.length && /[A-Za-z]/.test(source[index])) index++;
                if (index === start) break;
                const identifier = source.slice(start, index).toUpperCase();
                skipSpace();
                if (source[index] !== "[") fail(`Property ${identifier} has no value`);
                const values = [];
                while (true) {
                    skipSpace();
                    if (source[index] !== "[") break;
                    values.push(readValue());
                }
                if (!properties[identifier]) properties[identifier] = [];
                properties[identifier].push(...values);
            }
            return {
                id: nextNodeId++,
                properties,
                parent: null,
                children: [],
                move: null,
                comment: "",
                quality: null,
                terminal: null,
                terminalCode: null,
            };
        }

        function parseTree() {
            expect("(");
            skipSpace();
            if (source[index] !== ";") fail("A game tree must contain at least one node");
            let first = null;
            let last = null;
            while (true) {
                skipSpace();
                if (source[index] !== ";") break;
                const node = readNode();
                if (!first) first = node;
                if (last) {
                    last.children.push(node);
                    node.parent = last;
                }
                last = node;
            }
            while (true) {
                skipSpace();
                if (source[index] !== "(") break;
                const variation = parseTree();
                last.children.push(variation);
                variation.parent = last;
            }
            expect(")");
            return first;
        }

        skipSpace();
        if (source[index] !== "(") fail("Expected an SGF game tree");
        const rootNode = parseTree();
        skipSpace();
        if (index !== source.length) {
            if (source[index] === "(") fail("A practice file must contain exactly one game tree");
            fail("Unexpected content after game tree");
        }
        return rootNode;
    }

    function firstProperty(node, name, fallback = null) {
        const values = propertyValues(node, name);
        return values.length ? values[0] : fallback;
    }

    function parseAnnotation(value) {
        if (value == null) return false;
        const number = Number(String(value).trim());
        return Number.isFinite(number) ? number > 0 : String(value).trim() !== "";
    }

    function annotateTree(root, dimensions) {
        const nodes = [];
        const visit = (node) => {
            nodes.push(node);
            const black = propertyValues(node, "B");
            const white = propertyValues(node, "W");
            if (black.length && white.length) {
                throw new TypeError(`SGF node ${node.id} contains both B and W moves`);
            }
            const values = black.length ? black : white;
            if (values.length > 1) throw new TypeError(`SGF node ${node.id} has multiple moves`);
            if (values.length) {
                const color = black.length ? "B" : "W";
                const point = sgfToPoint(values[0], dimensions);
                node.move = Object.freeze({
                    color,
                    point: point ? Object.freeze(point) : null,
                    sgf: values[0],
                    isPass: point == null,
                });
            }
            node.comment = firstProperty(node, "C", "");
            const hasGood = parseAnnotation(firstProperty(node, "TE"));
            const hasBad = parseAnnotation(firstProperty(node, "BM"));
            if (hasGood && hasBad) throw new TypeError(`SGF node ${node.id} is both TE and BM`);
            node.quality = hasGood ? "good" : (hasBad ? "bad" : null);
            const outcome = firstProperty(node, "HO");
            if (outcome != null && String(outcome).trim() !== "") {
                const code = String(outcome).trim().toUpperCase();
                const terminalNames = { S: "success", F: "failure", C: "complete" };
                if (!terminalNames[code]) {
                    throw new TypeError(`Unsupported HO value '${outcome}' in SGF node ${node.id}`);
                }
                node.terminalCode = code;
                node.terminal = terminalNames[code];
            }
            for (const child of node.children) visit(child);
        };
        visit(root);
        return nodes;
    }

    /** Parse the focused HandTalk FF[4] exercise format. */
    function parseSgf(source) {
        const root = parseRawSgf(source);
        const dimensions = parseDimensions(firstProperty(root, "SZ", "19"));
        const game = firstProperty(root, "GM");
        if (game != null && String(game).trim() !== "1") {
            throw new TypeError("Practice SGF must describe Go (GM[1])");
        }
        if (propertyValues(root, "B").length || propertyValues(root, "W").length) {
            throw new TypeError("The practice root must be a setup node, not a move");
        }
        const initialPlayer = String(firstProperty(root, "PL", "B")).trim().toUpperCase();
        if (initialPlayer !== "B" && initialPlayer !== "W") {
            throw new TypeError("Root PL must be B or W");
        }
        const nodes = annotateTree(root, dimensions);
        const initialBoard = createInitialMatrix(root, dimensions);
        const initialStones = [];
        for (let y = 0; y < dimensions.height; y++) {
            for (let x = 0; x < dimensions.width; x++) {
                const value = initialBoard[y][x];
                if (value) {
                    initialStones.push(Object.freeze({
                        color: value === 1 ? "B" : "W",
                        point: Object.freeze({ x, y }),
                        sgf: pointToSgf({ x, y }, dimensions),
                        gtp: dimensions.width <= GTP_COLUMNS.length
                            ? pointToGtp({ x, y }, dimensions)
                            : null,
                    }));
                }
            }
        }
        const publicSize = dimensions.width === dimensions.height
            ? dimensions.width
            : Object.freeze({ ...dimensions });
        return {
            format: "HandTalk-Practice-SGF-1",
            size: publicSize,
            dimensions: Object.freeze({ ...dimensions }),
            initialPlayer,
            solverColor: initialPlayer,
            comment: root.comment,
            root,
            nodes,
            initialBoard,
            initialStones,
        };
    }

    function colorNumber(color) {
        return color === "B" ? 1 : 2;
    }

    function oppositeColor(color) {
        return color === "B" ? "W" : "B";
    }

    function groupAt(board, x, y) {
        const color = board[y][x];
        const stones = [];
        const liberties = new Set();
        const visited = new Set();
        const stack = [{ x, y }];
        while (stack.length) {
            const point = stack.pop();
            const key = `${point.x},${point.y}`;
            if (visited.has(key)) continue;
            visited.add(key);
            stones.push(point);
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const nx = point.x + dx;
                const ny = point.y + dy;
                if (ny < 0 || ny >= board.length || nx < 0 || nx >= board[0].length) continue;
                if (board[ny][nx] === 0) liberties.add(`${nx},${ny}`);
                else if (board[ny][nx] === color && !visited.has(`${nx},${ny}`)) {
                    stack.push({ x: nx, y: ny });
                }
            }
        }
        return { stones, liberties: liberties.size };
    }

    /** Apply one SGF move to a cloned board, including captures. */
    function applyMoveToBoard(sourceBoard, move) {
        const board = cloneMatrix(sourceBoard);
        if (!move || move.point == null) return board;
        const { x, y } = move.point;
        if (!board[y] || board[y][x] == null) throw new RangeError("Move is outside the board");
        if (board[y][x] !== 0) throw new Error("Move is on an occupied point");
        const ownColor = colorNumber(move.color);
        const enemyColor = ownColor === 1 ? 2 : 1;
        board[y][x] = ownColor;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (!board[ny] || board[ny][nx] !== enemyColor) continue;
            const enemy = groupAt(board, nx, ny);
            if (enemy.liberties === 0) {
                for (const stone of enemy.stones) board[stone.y][stone.x] = 0;
            }
        }
        if (groupAt(board, x, y).liberties === 0) throw new Error("Move is suicide");
        return board;
    }

    function cloneMove(move) {
        return move ? {
            color: move.color,
            point: clonePoint(move.point),
            sgf: move.sgf,
            isPass: move.isPass,
        } : null;
    }

    function normalizeUserPoint(value, dimensions) {
        if (value == null || String(value).toLowerCase() === "pass") return null;
        if (typeof value === "string") {
            const text = value.trim();
            if (!text || text.toLowerCase() === "pass") return null;
            if (/^[a-zA-Z]{2}$/.test(text)) return sgfToPoint(text, dimensions);
            return gtpToPoint(text, dimensions);
        }
        return sgfToPoint(pointToSgf(value, dimensions), dimensions);
    }

    function summarizeChild(child) {
        return {
            nodeId: child.id,
            move: cloneMove(child.move),
            quality: child.quality,
            terminal: child.terminal,
            terminalCode: child.terminalCode,
            comment: child.comment,
        };
    }

    function scriptRank(node) {
        if (node.quality === "bad") return 100;
        if (node.quality === "good") return 0;
        if (node.terminalCode === "S") return 1;
        if (node.terminalCode === "F") return 90;
        return 10;
    }

    // A scripted opponent should choose the strongest resistance. Terminal F
    // means the solver is refuted, while terminal S means the solver succeeds;
    // treating both alike would make the outcome depend on SGF branch order.
    function scriptedResponseRank(node) {
        if (node.terminalCode === "F") return 0;
        if (node.quality === "good") return 1;
        if (node.terminalCode === "C") return 10;
        if (node.quality === "bad") return 100;
        if (node.terminalCode === "S") return 90;
        return 20;
    }

    function hintEntry(hints, type) {
        if (!Array.isArray(hints)) return null;
        return hints.find((hint) => hint && hint.type === type) || null;
    }

    function normalizedHintCoordinates(value) {
        if (Array.isArray(value)) return value.map(String);
        if (value == null || value === "") return [];
        return [String(value)];
    }

    class Session {
        constructor(problemOrSource, metadata = {}) {
            this.problem = typeof problemOrSource === "string"
                ? parseSgf(problemOrSource)
                : problemOrSource;
            if (!this.problem || !this.problem.root || !this.problem.dimensions) {
                throw new TypeError("Session requires parsed practice SGF or SGF source");
            }
            this.metadata = metadata || {};
            this.solverColor = String(
                this.metadata.player || this.metadata.solverColor || this.problem.solverColor
            ).toUpperCase();
            if (this.solverColor !== "B" && this.solverColor !== "W") {
                throw new TypeError("Practice solver color must be B or W");
            }
            this.retryCount = 0;
            this.totalMistakes = 0;
            this.maxHintLevel = 0;
            this.answerViewedEver = false;
            this.reset();
        }

        reset() {
            this.currentNode = this.problem.root;
            this.board = cloneMatrix(this.problem.initialBoard);
            this.path = [];
            this.nextColor = this.problem.initialPlayer;
            this.status = "active";
            this.terminalCode = null;
            this.attemptMistakes = 0;
            this.hintLevel = 0;
            this.answerViewed = false;
            this.lastComment = this.problem.root.comment || "";
            this._pendingUserMistake = false;
            this._settleScripted();
            return this.snapshot();
        }

        retry() {
            this.retryCount++;
            return this.reset();
        }

        isTerminal() {
            return this.status === "success" || this.status === "failure" ||
                this.status === "complete";
        }

        _childrenFor(color) {
            return this.currentNode.children.filter((child) =>
                child.move && child.move.color === color
            );
        }

        availableMoves() {
            if (this.isTerminal() || this.nextColor !== this.solverColor) return [];
            return this._childrenFor(this.solverColor).map(summarizeChild);
        }

        peekMove(value) {
            if (this.isTerminal() || this.nextColor !== this.solverColor) {
                return { known: false, accepted: false, reason: "not-awaiting-user" };
            }
            const point = normalizeUserPoint(value, this.problem.dimensions);
            const child = this._childrenFor(this.solverColor).find((candidate) =>
                pointsEqual(candidate.move.point, point)
            );
            return child
                ? { known: true, accepted: true, ...summarizeChild(child) }
                : { known: false, accepted: false, reason: "unknown-move", point: clonePoint(point) };
        }

        peek(value) {
            return this.peekMove(value);
        }

        _setTerminal(status, code = null) {
            this.status = status;
            this.terminalCode = code || ({ success: "S", failure: "F", complete: "C" }[status] || null);
        }

        _advance(child, actor) {
            this.board = applyMoveToBoard(this.board, child.move);
            this.currentNode = child;
            this.nextColor = oppositeColor(child.move.color);
            if (child.comment) this.lastComment = child.comment;
            const entry = {
                actor,
                nodeId: child.id,
                move: cloneMove(child.move),
                quality: child.quality,
                comment: child.comment,
                terminal: child.terminal,
                terminalCode: child.terminalCode,
            };
            this.path.push(entry);
            if (child.terminal) this._setTerminal(child.terminal, child.terminalCode);
            return entry;
        }

        _finishLeaf() {
            if (this.isTerminal()) return;
            if (this._pendingUserMistake || this.currentNode.quality === "bad") {
                this._setTerminal("failure", "F");
            } else if (this.currentNode.quality === "good") {
                this._setTerminal("success", "S");
            } else {
                this._setTerminal("complete", "C");
            }
        }

        _settleScripted() {
            const automaticMoves = [];
            while (!this.isTerminal() && this.nextColor !== this.solverColor) {
                const candidates = this._childrenFor(this.nextColor);
                if (!candidates.length) {
                    this._finishLeaf();
                    break;
                }
                const chosen = candidates
                    .map((node, order) => ({ node, order, rank: scriptedResponseRank(node) }))
                    .sort((left, right) => left.rank - right.rank || left.order - right.order)[0].node;
                automaticMoves.push(this._advance(chosen, "script"));
            }
            if (!this.isTerminal() && this._pendingUserMistake &&
                this.nextColor === this.solverColor) {
                this._setTerminal("failure", "F");
            } else if (!this.isTerminal() && this.currentNode.children.length === 0) {
                this._finishLeaf();
            }
            return automaticMoves;
        }

        playUserMove(value) {
            if (this.isTerminal()) {
                return {
                    accepted: false,
                    known: false,
                    reason: "terminal",
                    status: this.status,
                    snapshot: this.snapshot(),
                };
            }
            if (this.nextColor !== this.solverColor) this._settleScripted();
            const preview = this.peekMove(value);
            if (!preview.known) {
                this.status = "unknown";
                this.attemptMistakes++;
                this.totalMistakes++;
                return {
                    ...preview,
                    status: this.status,
                    automaticMoves: [],
                    snapshot: this.snapshot(),
                };
            }
            const child = this.currentNode.children.find((candidate) => candidate.id === preview.nodeId);
            this.status = "active";
            if (child.quality === "bad") {
                this._pendingUserMistake = true;
                this.attemptMistakes++;
                this.totalMistakes++;
            }
            const userMove = this._advance(child, "user");
            const automaticMoves = this._settleScripted();
            if (!this.isTerminal() && this.nextColor === this.solverColor) {
                this.hintLevel = 0;
                this.answerViewed = false;
            }
            return {
                accepted: true,
                known: true,
                status: this.status,
                move: userMove,
                automaticMoves,
                terminalCode: this.terminalCode,
                snapshot: this.snapshot(),
            };
        }

        _preferredUserChildren() {
            const candidates = this._childrenFor(this.solverColor);
            const nonBad = candidates.filter((node) => node.quality !== "bad" && node.terminalCode !== "F");
            const pool = nonBad.length ? nonBad : candidates;
            return pool.slice().sort((left, right) => scriptRank(left) - scriptRank(right));
        }

        getHint(level) {
            const requestedLevel = Number(level);
            if (![1, 2, 3].includes(requestedLevel)) {
                throw new RangeError("Hint level must be 1, 2, or 3");
            }
            if (this.isTerminal()) return null;
            this.hintLevel = Math.max(this.hintLevel, requestedLevel);
            this.maxHintLevel = Math.max(this.maxHintLevel, requestedLevel);
            if (requestedLevel === 3) {
                this.answerViewed = true;
                this.answerViewedEver = true;
            }

            const hints = this.metadata.hints || this.problem.hints || [];
            const types = ["text", "region", "answer"];
            const type = types[requestedLevel - 1];
            // Manifest hints describe the root position. On a multi-step
            // problem, later hints must be derived from the current branches
            // so an already-played root answer is never highlighted again.
            const supplied = this.currentNode === this.problem.root
                ? hintEntry(hints, type)
                : null;
            if (supplied) {
                if (type === "text") {
                    return { level: requestedLevel, type, value: String(supplied.value || "") };
                }
                const value = normalizedHintCoordinates(supplied.value);
                const points = value.map((coordinate) => sgfToPoint(coordinate, this.problem.dimensions));
                return { level: requestedLevel, type, value, points: points.map(clonePoint) };
            }

            const preferred = this._preferredUserChildren();
            if (type === "text") {
                return {
                    level: requestedLevel,
                    type,
                    value: this.metadata.derivedHint || this.currentNode.comment ||
                        this.problem.comment || "寻找对方最难应对的一手。",
                };
            }
            const values = preferred
                .filter((node) => node.move && node.move.point)
                .map((node) => pointToSgf(node.move.point, this.problem.dimensions));
            if (!values.length) return null;
            if (type === "answer") values.splice(1);
            return {
                level: requestedLevel,
                type,
                value: values,
                points: values.map((coordinate) => sgfToPoint(coordinate, this.problem.dimensions)),
            };
        }

        revealAnswer() {
            return this.getHint(3);
        }

        attemptResult() {
            return {
                status: this.status,
                correct: (this.status === "success" || this.status === "complete") &&
                    this.totalMistakes === 0,
                mistakes: this.totalMistakes,
                hintLevel: this.maxHintLevel,
                hintsUsed: this.maxHintLevel,
                answerViewed: this.answerViewedEver,
            };
        }

        snapshot() {
            return {
                status: this.status,
                terminalCode: this.terminalCode,
                solverColor: this.solverColor,
                nextColor: this.nextColor,
                currentNodeId: this.currentNode.id,
                board: cloneMatrix(this.board),
                path: this.path.map((entry) => ({ ...entry, move: cloneMove(entry.move) })),
                comment: this.lastComment,
                mistakes: this.attemptMistakes,
                totalMistakes: this.totalMistakes,
                retryCount: this.retryCount,
                hintLevel: this.hintLevel,
                maxHintLevel: this.maxHintLevel,
                answerViewed: this.answerViewed,
                answerViewedEver: this.answerViewedEver,
            };
        }
    }

    function intervalOptions(options) {
        const source = options || {};
        const clean = Array.isArray(source.clean) && source.clean.length
            ? source.clean.map(Number)
            : DEFAULT_INTERVALS.clean.slice();
        return {
            wrong: Number.isFinite(source.wrong) ? Number(source.wrong) : DEFAULT_INTERVALS.wrong,
            revealed: Number.isFinite(source.revealed) ? Number(source.revealed) : DEFAULT_INTERVALS.revealed,
            hinted: Number.isFinite(source.hinted) ? Number(source.hinted) : DEFAULT_INTERVALS.hinted,
            clean,
        };
    }

    /**
     * Pick the next problem without letting a failed, not-yet-due review hide
     * unseen material. Due reviews come first, then unseen problems, then the
     * scheduled problem with the earliest due time.
     */
    function chooseProblemIndex(problems = [], progress = {}, now = Date.now()) {
        if (!Array.isArray(problems) || problems.length === 0) return -1;
        const timestamp = now instanceof Date ? now.getTime() : Number(now);
        if (!Number.isFinite(timestamp)) throw new TypeError("Review time must be a Date or timestamp");
        const records = progress && typeof progress === "object" ? progress : {};
        const dueTime = (problem) => {
            const raw = records[problem && problem.id]?.due_at;
            const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
            return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
        };

        const due = problems.findIndex((problem) =>
            records[problem && problem.id] && dueTime(problem) <= timestamp
        );
        if (due >= 0) return due;

        const unseen = problems.findIndex((problem) => !records[problem && problem.id]);
        if (unseen >= 0) return unseen;

        let earliestIndex = 0;
        let earliestTime = dueTime(problems[0]);
        for (let index = 1; index < problems.length; index++) {
            const candidate = dueTime(problems[index]);
            if (candidate < earliestTime) {
                earliestIndex = index;
                earliestTime = candidate;
            }
        }
        return earliestIndex;
    }

    /**
     * Pure spaced-review reducer. Earlier mistakes dominate answer viewing,
     * answer viewing dominates hints, and only a clean solve grows a streak.
     */
    function scheduleProgress(previous = {}, attempt = {}, now = Date.now(), options = {}) {
        const timestamp = now instanceof Date ? now.getTime() : Number(now);
        if (!Number.isFinite(timestamp)) throw new TypeError("Review time must be a Date or timestamp");
        const intervals = intervalOptions(options);
        const prior = previous || {};
        const mistakes = Number(attempt.mistakes || 0);
        const explicitSuccess = attempt.correct === true ||
            attempt.status === "success" || attempt.status === "complete";
        const explicitFailure = attempt.correct === false ||
            attempt.status === "failure" || attempt.status === "unknown";
        if (!explicitSuccess && !explicitFailure && mistakes <= 0) {
            throw new TypeError("Practice result must explicitly succeed or fail");
        }
        let grade;
        let intervalMs;
        let streak;
        let lapses = Number(prior.lapses || 0);

        if (explicitFailure || mistakes > 0) {
            grade = "wrong";
            intervalMs = intervals.wrong;
            streak = 0;
            lapses++;
        } else if (attempt.answerViewed || Number(attempt.hintLevel || attempt.hintsUsed || 0) >= 3) {
            grade = "revealed";
            intervalMs = intervals.revealed;
            streak = 0;
        } else if (Number(attempt.hintLevel || attempt.hintsUsed || 0) > 0) {
            grade = "hinted";
            intervalMs = intervals.hinted;
            streak = 0;
        } else {
            grade = "clean";
            streak = Math.max(0, Number(prior.streak || 0)) + 1;
            intervalMs = intervals.clean[Math.min(streak - 1, intervals.clean.length - 1)];
        }
        if (!Number.isFinite(intervalMs) || intervalMs < 0) {
            throw new RangeError("Review intervals must be non-negative numbers");
        }
        return {
            attempts: Math.max(0, Number(prior.attempts || 0)) + 1,
            streak,
            lapses,
            grade,
            intervalMs,
            lastReviewedAt: timestamp,
            dueAt: timestamp + intervalMs,
        };
    }

    const api = {
        SgfSyntaxError,
        parseSgf,
        parseSGF: parseSgf,
        Session,
        PracticeSession: Session,
        createSession: (problemOrSource, metadata) => new Session(problemOrSource, metadata),
        sgfToPoint,
        pointToSgf,
        pointToGtp,
        gtpToPoint,
        createInitialMatrix,
        expandPointValue,
        applyMoveToBoard,
        cloneMatrix,
        chooseProblemIndex,
        scheduleProgress,
        scheduleReview: scheduleProgress,
        DEFAULT_INTERVALS,
    };
    return Object.freeze(api);
});
