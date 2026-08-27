import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../static/js/goboard.js", import.meta.url), "utf8");

function makeBoard() {
  const gradient = { addColorStop() {} };
  const context2d = new Proxy({}, {
    get(target, key) {
      if (!(key in target)) {
        target[key] = key === "createLinearGradient" || key === "createRadialGradient"
          ? () => gradient
          : () => {};
      }
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  const canvas = {
    width: 700,
    height: 700,
    style: {},
    parentElement: { clientWidth: 700 },
    getContext: () => context2d,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 700 }),
  };
  const elements = {
    goboard: canvas,
    header: { offsetHeight: 52 },
    "board-area": { clientWidth: 760 },
  };
  const sandbox = {
    console,
    document: { getElementById: (id) => elements[id] || null },
    window: {
      innerWidth: 1280,
      innerHeight: 900,
      devicePixelRatio: 1,
      addEventListener() {},
    },
    Audio: class {
      addEventListener() {}
      play() { return Promise.resolve(); }
    },
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const GoBoard = vm.runInContext("GoBoard", sandbox);
  return new GoBoard("goboard", 19);
}

test("undo preserves an imported middle-game root and its next player", () => {
  const board = makeBoard();
  board.board[3][3] = 1;
  board.board[15][15] = 2;
  board.currentPlayer = 2;
  board.setInitialStonesFromBoard();

  assert.equal(board.initialPlayer, 2);
  assert.equal(board.tryMove(9, 9), true);
  assert.equal(board.currentPlayer, 1);
  assert.equal(board.undo(), true);

  assert.equal(board.board[3][3], 1);
  assert.equal(board.board[15][15], 2);
  assert.equal(board.board[9][9], 0);
  assert.equal(board.currentPlayer, 2);
  assert.equal(board.moves.length, 0);
});

test("undo steps back one move at a time until the local root", () => {
  const board = makeBoard();

  assert.equal(board.tryMove(3, 3), true);   // black
  board.passMove();                         // white
  assert.equal(board.tryMove(15, 15), true); // black
  assert.equal(board.fullMoveHistory.length, 3);

  assert.equal(board.undo(), true);
  assert.equal(board.fullMoveHistory.length, 2);
  assert.equal(board.moves.length, 2);
  assert.equal(board.currentPlayer, 1);
  assert.equal(board.board[15][15], 0);

  assert.equal(board.undo(), true);
  assert.equal(board.fullMoveHistory.length, 1);
  assert.equal(board.moves.length, 1);
  assert.equal(board.currentPlayer, 2);

  assert.equal(board.undo(), true);
  assert.equal(board.fullMoveHistory.length, 0);
  assert.equal(board.moves.length, 0);
  assert.equal(board.currentPlayer, 1);
  assert.equal(board.board[3][3], 0);
  assert.equal(board.positionHistory.length, 1);

  assert.equal(board.undo(), false);
  assert.equal(board.fullMoveHistory.length, 0);
});

test("navigation replays imported-position moves using their stored colors", () => {
  const board = makeBoard();
  board.board[3][3] = 1;
  board.currentPlayer = 2;
  board.setInitialStonesFromBoard();

  assert.equal(board.tryMove(10, 10), true); // white
  assert.equal(board.tryMove(11, 10), true); // black
  board.navigateTo(1);

  assert.equal(board.board[3][3], 1);
  assert.equal(board.board[10][10], 2);
  assert.equal(board.board[10][11], 0);
  assert.equal(board.currentPlayer, 1);
});

test("immediate ko recapture is rejected locally", () => {
  const board = makeBoard();
  for (const [x, y] of [[0, 1], [2, 1], [1, 0]]) board.board[y][x] = 1;
  for (const [x, y] of [[1, 1], [0, 2], [2, 2], [1, 3]]) board.board[y][x] = 2;
  board.currentPlayer = 1;
  board.setInitialStonesFromBoard();

  assert.equal(board.tryMove(1, 2), true, "black should capture the ko stone");
  assert.equal(board.board[1][1], 0);
  assert.equal(board.currentPlayer, 2);
  assert.equal(board.tryMove(1, 1), false, "white cannot immediately recapture");
  assert.equal(board.board[2][1], 1);
  assert.equal(board.currentPlayer, 2);
});

test("previewing a move validates the result without mutating board history", () => {
  const board = makeBoard();
  board.board[1][1] = 2;
  board.board[0][1] = 1;
  board.board[1][0] = 1;
  board.board[2][1] = 1;
  board.currentPlayer = 1;
  board.setInitialStonesFromBoard();
  const originalHash = board._boardHash();

  const preview = board.previewMove(2, 1);

  assert.ok(preview);
  assert.equal(preview.board[1][1], 0, "the surrounded white stone is captured in preview");
  assert.equal(board._boardHash(), originalHash, "the visible board remains unchanged");
  assert.equal(board.fullMoveHistory.length, 0);
  assert.equal(board.currentPlayer, 1);
});

test("passing clears stale candidates, ownership, and pending moves", () => {
  const board = makeBoard();
  board.analysisData = { moves: [{ move: "D4" }] };
  board.ownershipData = Array(361).fill(0.5);
  board.pendingMovePos = { x: 3, y: 3 };

  board.passMove();

  assert.equal(board.analysisData, null);
  assert.equal(board.ownershipData, null);
  assert.equal(board.pendingMovePos, null);
  assert.equal(board.moves[0][0], "B");
  assert.equal(board.moves[0][1], "pass");
});

test("undo keeps white to play at an imported empty root", () => {
  const board = makeBoard();
  board.currentPlayer = 2;
  board.setInitialStonesFromBoard();

  assert.equal(board.initialStones, null);
  assert.equal(board.initialPlayer, 2);
  assert.equal(board.tryMove(3, 3), true);
  assert.equal(board.undo(), true);
  assert.equal(board.currentPlayer, 2);
  assert.equal(board.board[3][3], 0);
});

test("candidate loss is negative when white is choosing a move", () => {
  const board = makeBoard();
  const labels = [];
  board.currentPlayer = 2;
  board.ctx.fillText = (value) => labels.push(String(value));

  board._drawCandidateText(
    100, 100, 20,
    { scoreLead: 1, visits: 80 },
    0,
    false,
  );

  assert.equal(labels[0], "-1.0");
});

test("a pass in the principal variation still flips the stone color", () => {
  const board = makeBoard();
  const fills = [];
  board.currentPlayer = 1;
  board.ctx.fill = () => fills.push(board.ctx.fillStyle);

  board._drawPVLine({ pv: ["pass", "D4", "Q16"] });

  assert.equal(fills[0], "#e8e8e8", "move 2 after Black passes must be White");
  assert.equal(fills[1], "#222", "move 3 must switch back to Black");
});

test("closing analysis clears candidates, ownership, and selection state", () => {
  const board = makeBoard();
  board.analysisData = { moves: [{ move: "D4" }] };
  board.ownershipData = Array(361).fill(0.25);
  board.hoveredCandidateIdx = 2;
  board.selectedCandidateIdx = 1;

  board.clearAnalysis();

  assert.equal(board.analysisData, null);
  assert.equal(board.ownershipData, null);
  assert.equal(board.hoveredCandidateIdx, -1);
  assert.equal(board.selectedCandidateIdx, -1);
});
