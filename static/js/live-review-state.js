/**
 * Pure temporal state machine for near-real-time board recognition.
 *
 * The vision model still evaluates every frame independently. This tracker
 * only decides when repeated, complete board results are stable enough to be
 * committed to the review tree.
 */
(function (global) {
    "use strict";

    function isSquareBoard(board) {
        return Array.isArray(board) && board.length > 0 && board.every((row) =>
            Array.isArray(row) && row.length === board.length &&
            row.every((point) => point === 0 || point === 1 || point === 2)
        );
    }

    function cloneBoard(board) {
        return board ? board.map((row) => row.slice()) : null;
    }

    function boardsEqual(left, right) {
        if (!isSquareBoard(left) || !isSquareBoard(right) ||
            left.length !== right.length) return false;
        return left.every((row, y) =>
            row.every((stone, x) => stone === right[y][x])
        );
    }

    function boardSignature(board) {
        return board.map((row) => row.join("")).join("/");
    }

    function findMoveTransition(previous, current) {
        if (!isSquareBoard(previous) || !isSquareBoard(current) ||
            previous.length !== current.length) return null;
        let added = null;
        const removed = [];
        for (let y = 0; y < current.length; y++) {
            for (let x = 0; x < current.length; x++) {
                const before = previous[y][x];
                const after = current[y][x];
                if (before === after) continue;
                if (before === 0 && (after === 1 || after === 2)) {
                    if (added) return null;
                    added = { x, y, color: after };
                } else if (before !== 0 && after === 0) {
                    removed.push(before);
                } else {
                    return null;
                }
            }
        }
        if (!added || removed.some((color) => color === added.color)) return null;
        return added;
    }

    class Tracker {
        constructor({
            anchorFrames = 3,
            moveFrames = 2,
            resyncFrames = 4,
            maxFrameGapMs = 3000,
            anchorMinMs = 800,
            moveMinMs = 450,
            resyncMinMs = 1500,
        } = {}) {
            this.anchorFrames = anchorFrames;
            this.moveFrames = moveFrames;
            this.resyncFrames = resyncFrames;
            this.maxFrameGapMs = maxFrameGapMs;
            this.anchorMinMs = anchorMinMs;
            this.moveMinMs = moveMinMs;
            this.resyncMinMs = resyncMinMs;
            this.reset();
        }

        reset(committedBoard = null) {
            this.committedBoard = isSquareBoard(committedBoard)
                ? cloneBoard(committedBoard)
                : null;
            this.rejectedMoveSignature = "";
            this.rejectedMoveStatusKey = "";
            this.lastObservedFrameId = null;
            this.clearCandidate();
        }

        clearCandidate() {
            this.candidateBoard = null;
            this.candidateSignature = "";
            this.candidateKind = "";
            this.candidateStreak = 0;
            this.candidateStartedAt = 0;
            this.candidateLastAt = 0;
            this.candidateTransition = null;
            this.effectEmitted = false;
        }

        rejectFrame(reason = "unsafe-frame") {
            this.clearCandidate();
            return { effect: "none", reason, streak: 0 };
        }

        observe(board, { now = Date.now(), safe = true, frameId = null } = {}) {
            if (!isSquareBoard(board)) return this.rejectFrame("invalid-board");
            if (!safe) return this.rejectFrame("unsafe-frame");
            if (frameId !== null && frameId === this.lastObservedFrameId) {
                return {
                    effect: "none",
                    reason: "duplicate-video-frame",
                    kind: this.candidateKind,
                    streak: this.candidateStreak,
                };
            }
            if (frameId !== null) this.lastObservedFrameId = frameId;
            if (this.committedBoard && boardsEqual(this.committedBoard, board)) {
                this.rejectedMoveSignature = "";
                this.rejectedMoveStatusKey = "";
                this.clearCandidate();
                return { effect: "none", reason: "unchanged", streak: 0 };
            }

            const signature = boardSignature(board);
            const transition = this.committedBoard
                ? findMoveTransition(this.committedBoard, board)
                : null;
            const moveWasRejected = signature === this.rejectedMoveSignature;
            const kind = !this.committedBoard
                ? "anchor"
                : (transition
                    ? (moveWasRejected ? "rejected" : "move")
                    : "resync");
            const continuesCandidate =
                signature === this.candidateSignature &&
                kind === this.candidateKind &&
                now - this.candidateLastAt <= this.maxFrameGapMs;

            if (continuesCandidate) {
                this.candidateStreak++;
                this.candidateLastAt = now;
                this.candidateBoard = cloneBoard(board);
                this.candidateTransition = transition;
            } else {
                if (signature !== this.rejectedMoveSignature) {
                    this.rejectedMoveSignature = "";
                    this.rejectedMoveStatusKey = "";
                }
                this.candidateBoard = cloneBoard(board);
                this.candidateSignature = signature;
                this.candidateKind = kind;
                this.candidateStreak = 1;
                this.candidateStartedAt = now;
                this.candidateLastAt = now;
                this.candidateTransition = transition;
                this.effectEmitted = false;
            }

            if (kind === "rejected") {
                return {
                    effect: "none",
                    reason: "move-rejected",
                    kind,
                    streak: this.candidateStreak,
                    statusKey: this.rejectedMoveStatusKey,
                };
            }

            const threshold = kind === "anchor"
                ? this.anchorFrames
                : (kind === "move" ? this.moveFrames : this.resyncFrames);
            const minimumDuration = kind === "anchor"
                ? this.anchorMinMs
                : (kind === "move" ? this.moveMinMs : this.resyncMinMs);
            const stableForMs = now - this.candidateStartedAt;
            if (this.candidateStreak < threshold || stableForMs < minimumDuration ||
                this.effectEmitted) {
                return {
                    effect: "none",
                    reason: "verifying",
                    kind,
                    streak: this.candidateStreak,
                    required: threshold,
                    stableForMs,
                    minimumDuration,
                };
            }

            this.effectEmitted = true;
            const effect = kind === "anchor"
                ? "anchor"
                : (kind === "move" ? "apply-move" : "global-resync");
            return {
                effect,
                reason: "verified",
                kind,
                streak: this.candidateStreak,
                required: threshold,
                stableForMs,
                minimumDuration,
                board: cloneBoard(this.candidateBoard),
                transition: this.candidateTransition
                    ? { ...this.candidateTransition }
                    : null,
            };
        }

        markMoveRejected(statusKey = "") {
            if (this.candidateKind !== "move" || !this.candidateSignature) return;
            this.rejectedMoveSignature = this.candidateSignature;
            this.rejectedMoveStatusKey = statusKey;
            this.candidateKind = "rejected";
            this.candidateTransition = null;
            this.effectEmitted = true;
        }

        commit(board) {
            if (!isSquareBoard(board)) throw new TypeError("Cannot commit an invalid board");
            this.committedBoard = cloneBoard(board);
            this.rejectedMoveSignature = "";
            this.rejectedMoveStatusKey = "";
            this.clearCandidate();
        }

        snapshot() {
            return {
                committedBoard: cloneBoard(this.committedBoard),
                candidateBoard: cloneBoard(this.candidateBoard),
                candidateKind: this.candidateKind,
                candidateStreak: this.candidateStreak,
                rejectedMoveSignature: this.rejectedMoveSignature,
                rejectedMoveStatusKey: this.rejectedMoveStatusKey,
                lastObservedFrameId: this.lastObservedFrameId,
            };
        }
    }

    global.LiveReviewState = Object.freeze({
        Tracker,
        boardsEqual,
        cloneBoard,
        findMoveTransition,
        isSquareBoard,
    });
})(typeof window !== "undefined" ? window : globalThis);
