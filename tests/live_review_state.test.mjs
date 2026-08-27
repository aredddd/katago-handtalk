import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../static/js/live-review-state.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const { Tracker, cloneBoard, findMoveTransition } = context.LiveReviewState;

function emptyBoard(size = 5) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function withStone(sourceBoard, x, y, color) {
  const result = cloneBoard(sourceBoard);
  result[y][x] = color;
  return result;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("an initial live position anchors only after three identical full frames", () => {
  const tracker = new Tracker();
  const position = withStone(emptyBoard(), 2, 2, 1);

  assert.equal(tracker.observe(position, { now: 0 }).effect, "none");
  assert.equal(tracker.observe(position, { now: 400 }).effect, "none");
  const decision = tracker.observe(position, { now: 800 });

  assert.equal(decision.effect, "anchor");
  assert.equal(decision.streak, 3);
  assert.deepEqual(plain(decision.board), plain(position));
});

test("a legal one-move-shaped result needs two frames and emits only once", () => {
  const base = emptyBoard();
  const next = withStone(base, 1, 3, 1);
  const tracker = new Tracker();
  tracker.reset(base);

  assert.equal(tracker.observe(next, { now: 0 }).effect, "none");
  const decision = tracker.observe(next, { now: 450 });
  assert.equal(decision.effect, "apply-move");
  assert.deepEqual(plain(decision.transition), { x: 1, y: 3, color: 1 });
  assert.equal(tracker.observe(next, { now: 500 }).effect, "none");

  tracker.commit(next);
  assert.equal(tracker.observe(next, { now: 600 }).reason, "unchanged");
});

test("a multi-point jump becomes one global resync after four stable frames", () => {
  const base = emptyBoard();
  const jumped = withStone(withStone(base, 0, 0, 1), 4, 4, 2);
  const tracker = new Tracker();
  tracker.reset(base);

  for (let frame = 0; frame < 3; frame++) {
    const decision = tracker.observe(jumped, { now: frame * 500 });
    assert.equal(decision.effect, "none");
    assert.equal(decision.streak, frame + 1);
  }
  assert.equal(tracker.observe(jumped, { now: 1500 }).effect, "global-resync");
  assert.equal(tracker.observe(jumped, { now: 2000 }).effect, "none");
});

test("different, unsafe, and late frames interrupt the consecutive-frame count", () => {
  const base = emptyBoard();
  const positionA = withStone(withStone(base, 0, 0, 1), 1, 1, 2);
  const positionB = withStone(withStone(base, 2, 2, 1), 3, 3, 2);
  const tracker = new Tracker({
    maxFrameGapMs: 300,
    anchorMinMs: 0,
    moveMinMs: 0,
    resyncMinMs: 0,
  });
  tracker.reset(base);

  tracker.observe(positionA, { now: 0 });
  tracker.observe(positionA, { now: 100 });
  assert.equal(tracker.observe(positionB, { now: 200 }).streak, 1);
  assert.equal(tracker.observe(positionA, { now: 300 }).streak, 1);
  assert.equal(tracker.observe(positionA, { now: 700 }).streak, 1);
  assert.equal(tracker.observe(positionA, { now: 750, safe: false }).streak, 0);
  assert.equal(tracker.observe(positionA, { now: 800 }).streak, 1);
});

test("a rejected single move stays blocked until the caller corrects the turn", () => {
  const base = emptyBoard();
  const candidate = withStone(base, 3, 2, 1);
  const tracker = new Tracker();
  tracker.reset(base);

  tracker.observe(candidate, { now: 0 });
  assert.equal(tracker.observe(candidate, { now: 500 }).effect, "apply-move");
  tracker.markMoveRejected("liveTurnMismatch");

  const third = tracker.observe(candidate, { now: 1000 });
  assert.equal(third.effect, "none");
  assert.equal(third.kind, "rejected");
  assert.equal(third.reason, "move-rejected");
  assert.equal(third.statusKey, "liveTurnMismatch");
  assert.equal(third.streak, 3);
  for (let frame = 3; frame < 10; frame++) {
    assert.equal(tracker.observe(candidate, { now: frame * 500 }).effect, "none");
  }

  tracker.commit(base);
  assert.equal(tracker.observe(candidate, { now: 5000 }).kind, "move");
});

test("re-running recognition for the same video frame does not add evidence", () => {
  const base = emptyBoard();
  const candidate = withStone(base, 2, 2, 1);
  const tracker = new Tracker({ moveMinMs: 0 });
  tracker.reset(base);

  const first = tracker.observe(candidate, { now: 0, frameId: "frame-7" });
  assert.equal(first.streak, 1);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const repeated = tracker.observe(candidate, {
      now: attempt * 100,
      frameId: "frame-7",
    });
    assert.equal(repeated.reason, "duplicate-video-frame");
    assert.equal(repeated.streak, 1);
  }
  assert.equal(
    tracker.observe(candidate, { now: 1100, frameId: "frame-8" }).effect,
    "apply-move",
  );
});

test("move-shape detection accepts opponent captures but rejects own-stone removals", () => {
  const previous = emptyBoard();
  previous[1][1] = 2;

  const capture = cloneBoard(previous);
  capture[2][1] = 1;
  capture[1][1] = 0;
  assert.deepEqual(plain(findMoveTransition(previous, capture)), {
    x: 1,
    y: 2,
    color: 1,
  });

  const impossible = cloneBoard(previous);
  impossible[0][0] = 2;
  impossible[1][1] = 0;
  assert.equal(findMoveTransition(previous, impossible), null);
});

test("tracker snapshots and commits do not retain mutable caller arrays", () => {
  const board = withStone(emptyBoard(), 0, 0, 1);
  const tracker = new Tracker();
  tracker.commit(board);
  board[0][0] = 2;

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.committedBoard[0][0], 1);
  snapshot.committedBoard[0][0] = 0;
  assert.equal(tracker.snapshot().committedBoard[0][0], 1);
});
