import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const PracticeState = require("../static/js/practice-state.js");
const {
  Session,
  applyMoveToBoard,
  chooseProblemIndex,
  createInitialMatrix,
  gtpToPoint,
  parseSgf,
  pointToGtp,
  pointToSgf,
  scheduleProgress,
  sgfToPoint,
} = PracticeState;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const branchingProblem = String.raw`(;GM[1]FF[4]SZ[9]PL[B]
AB[bb][bc][cb]AW[cc][dc]C[Find the vital point.]
(;B[cd]TE[1]C[Good start];W[dd]TE[1]C[Best resistance]
  (;B[de]HO[S]C[Solved]))
(;B[aa]BM[1]C[Too far away];W[ab]HO[F]C[White refutes it]))`;

test("exports the same API to Node and a plain browser global", () => {
  const source = readFileSync(
    new URL("../static/js/practice-state.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof PracticeState.parseSgf, "function");
  assert.equal(typeof context.PracticeState.parseSgf, "function");
  assert.equal(typeof context.PracticeState.Session, "function");
});

test("parses root setup, comments, variations, moves, annotations, and HO outcomes", () => {
  const problem = parseSgf(branchingProblem);

  assert.equal(problem.size, 9);
  assert.equal(problem.initialPlayer, "B");
  assert.equal(problem.comment, "Find the vital point.");
  assert.equal(problem.initialBoard[1][1], 1);
  assert.equal(problem.initialBoard[2][3], 2);
  assert.equal(problem.root.children.length, 2);

  const good = problem.root.children[0];
  const bad = problem.root.children[1];
  assert.deepEqual(plain(good.move.point), { x: 2, y: 3 });
  assert.equal(good.move.color, "B");
  assert.equal(good.quality, "good");
  assert.equal(bad.quality, "bad");
  assert.equal(good.children[0].children[0].terminal, "success");
  assert.equal(good.children[0].children[0].terminalCode, "S");
  assert.equal(bad.children[0].terminal, "failure");
});

test("handles FF4 escaped closing brackets, backslashes, and soft line breaks", () => {
  const problem = parseSgf("(;FF[4]SZ[9]C[a\\]b\\\\c\\\r\nd];B[aa]HO[C]C[line 1\r\nline 2])");
  assert.equal(problem.comment, "a]b\\cd");
  assert.equal(problem.root.children[0].comment, "line 1\nline 2");
  assert.equal(problem.root.children[0].terminal, "complete");
});

test("expands compressed root setup ranges and rejects black-white overlap", () => {
  const problem = parseSgf("(;SZ[9]AB[aa:bb]AW[cc])");
  assert.deepEqual(problem.initialBoard.slice(0, 3).map((row) => row.slice(0, 3)), [
    [1, 1, 0],
    [1, 1, 0],
    [0, 0, 2],
  ]);
  assert.throws(() => parseSgf("(;SZ[9]AB[aa]AW[aa])"), /overlaps/);
  assert.deepEqual(createInitialMatrix(problem), problem.initialBoard);
  assert.notEqual(createInitialMatrix(problem), problem.initialBoard);
});

test("supports square and rectangular SGF, board, and GTP coordinate round trips", () => {
  assert.deepEqual(sgfToPoint("cd", 9), { x: 2, y: 3 });
  assert.equal(pointToSgf({ x: 2, y: 3 }, 9), "cd");
  assert.equal(pointToGtp({ x: 3, y: 5 }, 9), "D4");
  assert.deepEqual(gtpToPoint("D4", 9), { x: 3, y: 5 });
  assert.equal(pointToSgf(null, 9), "");
  assert.equal(pointToGtp(null, 9), "pass");

  const rectangular = parseSgf("(;SZ[9:13]AB[im]PL[W];W[aa]HO[C])");
  assert.deepEqual(plain(rectangular.size), { width: 9, height: 13 });
  assert.equal(rectangular.initialBoard.length, 13);
  assert.equal(rectangular.initialBoard[0].length, 9);
  assert.equal(rectangular.initialBoard[12][8], 1);
});

test("a known user move advances, scripts the reply, and waits for the next user move", () => {
  const session = new Session(branchingProblem);
  const before = session.snapshot();
  const preview = session.peekMove({ x: 2, y: 3 });
  assert.equal(preview.known, true);
  assert.equal(session.snapshot().currentNodeId, before.currentNodeId);

  const result = session.playUserMove("cd");
  assert.equal(result.accepted, true);
  assert.equal(result.status, "active");
  assert.equal(result.automaticMoves.length, 1);
  assert.equal(result.automaticMoves[0].move.sgf, "dd");
  assert.equal(session.snapshot().nextColor, "B");

  const solved = session.playUserMove("D5"); // SGF de on a 9x9 board.
  assert.equal(solved.status, "success");
  assert.equal(solved.terminalCode, "S");
  assert.equal(session.attemptResult().correct, true);
});

test("an unknown move records feedback but does not advance or alter the board", () => {
  const session = new Session(branchingProblem);
  const before = session.snapshot();

  const result = session.playUserMove({ x: 8, y: 8 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unknown-move");
  assert.equal(result.status, "unknown");
  assert.equal(session.snapshot().currentNodeId, before.currentNodeId);
  assert.deepEqual(session.snapshot().board, before.board);

  const known = session.playUserMove("cd");
  assert.equal(known.accepted, true);
  assert.equal(session.attemptResult().mistakes, 1);
});

test("a BM branch plays its scripted refutation and ends in failure; retry is clean", () => {
  const session = new Session(branchingProblem);
  const failed = session.playUserMove("aa");

  assert.equal(failed.status, "failure");
  assert.equal(failed.automaticMoves.length, 1);
  assert.equal(failed.automaticMoves[0].move.sgf, "ab");
  assert.equal(session.playUserMove("cd").reason, "terminal");

  const retried = session.retry();
  assert.equal(retried.status, "active");
  assert.equal(retried.path.length, 0);
  assert.equal(retried.mistakes, 0);
  assert.equal(retried.retryCount, 1);
});

test("scripted opponent chooses a refutation instead of depending on branch order", () => {
  const source = "(;SZ[9]PL[B](;B[aa](;W[ab]HO[S])(;W[ac]HO[F])))";
  const session = new Session(source);
  const result = session.playUserMove("aa");
  assert.equal(result.status, "failure");
  assert.equal(result.automaticMoves[0].move.sgf, "ac");
});

test("uses manifest text/region/answer hints and records hint and reveal usage", () => {
  const session = new Session(branchingProblem, {
    hints: [
      { type: "text", value: "先缩小白棋的眼位。" },
      { type: "region", value: ["bc", "de"] },
      { type: "answer", value: ["cd"] },
    ],
  });

  assert.deepEqual(session.getHint(1), {
    level: 1,
    type: "text",
    value: "先缩小白棋的眼位。",
  });
  assert.deepEqual(plain(session.getHint(2)), {
    level: 2,
    type: "region",
    value: ["bc", "de"],
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
  });
  assert.deepEqual(plain(session.revealAnswer()), {
    level: 3,
    type: "answer",
    value: ["cd"],
    points: [{ x: 2, y: 3 }],
  });
  assert.equal(session.snapshot().hintLevel, 3);
  assert.equal(session.snapshot().answerViewed, true);
});

test("derives all three hints from SGF when manifest hints are absent", () => {
  const session = new Session(branchingProblem);
  assert.equal(session.getHint(1).value, "Find the vital point.");
  assert.deepEqual(session.getHint(2).value, ["cd"]);
  assert.deepEqual(session.getHint(3).value, ["cd"]);
});

test("later-step hints derive from the current node rather than reusing root metadata", () => {
  const session = new Session(branchingProblem, {
    hints: [
      { type: "text", value: "root" },
      { type: "region", value: ["cd"] },
      { type: "answer", value: ["cd"] },
    ],
  });
  session.getHint(3);
  session.playUserMove("cd");
  assert.equal(session.snapshot().hintLevel, 0);
  assert.equal(session.snapshot().answerViewed, false);
  assert.equal(session.attemptResult().hintsUsed, 3);
  assert.equal(session.attemptResult().answerViewed, true);
  assert.deepEqual(session.getHint(3).value, ["de"]);
});

test("mistakes and revealed answers remain part of the same problem across retries", () => {
  const session = new Session(branchingProblem);
  session.revealAnswer();
  session.playUserMove("aa");
  session.retry();
  session.playUserMove("cd");
  session.playUserMove("de");
  assert.equal(session.attemptResult().mistakes, 1);
  assert.equal(session.attemptResult().answerViewed, true);
  assert.equal(session.attemptResult().correct, false);
});

test("board application clones its input and removes captured stones", () => {
  const board = [
    [0, 1, 0],
    [1, 2, 0],
    [0, 1, 0],
  ];
  const result = applyMoveToBoard(board, {
    color: "B",
    point: { x: 2, y: 1 },
  });
  assert.equal(result[1][1], 0);
  assert.equal(result[1][2], 1);
  assert.equal(board[1][1], 2);
  assert.equal(board[1][2], 0);
});

test("schedules wrong, revealed, hinted, and clean attempts without mutating inputs", () => {
  const now = 1_800_000_000_000;
  const previous = { attempts: 4, streak: 2, lapses: 1 };
  const frozenCopy = { ...previous };

  const wrong = scheduleProgress(previous, { status: "failure" }, now);
  const revealed = scheduleProgress(previous, { correct: true, answerViewed: true }, now);
  const skippedReveal = scheduleProgress(
    previous,
    { correct: true, status: "skipped", answerViewed: true },
    now,
  );
  const hinted = scheduleProgress(previous, { correct: true, hintLevel: 1 }, now);
  const clean = scheduleProgress(previous, { correct: true }, now);

  assert.deepEqual(previous, frozenCopy);
  assert.equal(wrong.grade, "wrong");
  assert.equal(wrong.streak, 0);
  assert.equal(wrong.lapses, 2);
  assert.equal(revealed.grade, "revealed");
  assert.equal(skippedReveal.grade, "revealed");
  assert.equal(hinted.grade, "hinted");
  assert.equal(clean.grade, "clean");
  assert.equal(clean.streak, 3);
  assert.ok(wrong.dueAt < revealed.dueAt);
  assert.ok(revealed.dueAt < hinted.dueAt);
  assert.ok(hinted.dueAt < clean.dueAt);
});

test("clean review intervals grow with streak and cap at the configured last step", () => {
  const options = { clean: [100, 200], wrong: 1, revealed: 2, hinted: 3 };
  const first = scheduleProgress({}, { correct: true }, 1_000, options);
  const second = scheduleProgress(first, { correct: true }, 2_000, options);
  const capped = scheduleProgress(second, { correct: true }, 3_000, options);
  assert.equal(first.intervalMs, 100);
  assert.equal(second.intervalMs, 200);
  assert.equal(capped.intervalMs, 200);
  assert.equal(capped.dueAt, 3_200);
});

test("review scheduling rejects an unfinished or ambiguous attempt", () => {
  assert.throws(() => scheduleProgress({}, {}), /explicitly succeed or fail/);
});

test("problem selection does not let a future failed review hide unseen problems", () => {
  const problems = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const now = Date.parse("2026-08-28T10:00:00Z");
  const future = new Date(now + 600_000).toISOString();
  const later = new Date(now + 1_200_000).toISOString();
  const past = new Date(now - 1).toISOString();

  assert.equal(chooseProblemIndex(problems, { a: { due_at: future } }, now), 1);
  assert.equal(chooseProblemIndex(problems, { a: { due_at: past } }, now), 0);
  assert.equal(chooseProblemIndex(problems, {
    a: { due_at: later }, b: { due_at: future }, c: { due_at: later },
  }, now), 1);
});

test("reports malformed focused SGF with useful errors", () => {
  assert.throws(() => parseSgf("(;SZ[9]C[missing close]"), /Expected '\)'/);
  assert.throws(() => parseSgf("(;SZ[9])(;SZ[13])"), /exactly one game tree/);
  assert.throws(() => parseSgf("(;SZ[9];B[zz])"), /outside the board/);
  assert.throws(() => parseSgf("(;SZ[9];B[aa]HO[X])"), /Unsupported HO/);
});
