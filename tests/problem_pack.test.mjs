import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { test } from "node:test";

const manifestUrl = new URL("../static/problems/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const SGF_COORD = /^[a-i][a-i]$/;
const CHINESE_TEXT = /[\u3400-\u9fff]/;
const require = createRequire(import.meta.url);
const practiceStateUrl = new URL("../static/js/practice-state.js", import.meta.url);
const PracticeState = existsSync(practiceStateUrl)
  ? require("../static/js/practice-state.js")
  : null;

function parseSgf(source) {
  let cursor = 0;

  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] || "")) cursor += 1;
  };

  const parseValue = () => {
    assert.equal(source[cursor], "[", `SGF value expected at offset ${cursor}`);
    cursor += 1;
    let value = "";
    while (cursor < source.length && source[cursor] !== "]") {
      if (source[cursor] === "\\") {
        cursor += 1;
        if (source[cursor] === "\r" && source[cursor + 1] === "\n") cursor += 2;
        else if (source[cursor] === "\r" || source[cursor] === "\n") cursor += 1;
        else if (cursor < source.length) {
          value += source[cursor];
          cursor += 1;
        }
      } else {
        value += source[cursor];
        cursor += 1;
      }
    }
    assert.equal(source[cursor], "]", "unterminated SGF property value");
    cursor += 1;
    return value;
  };

  const parseNode = () => {
    assert.equal(source[cursor], ";", `SGF node expected at offset ${cursor}`);
    cursor += 1;
    const props = {};
    while (cursor < source.length) {
      skipWhitespace();
      const match = /^[A-Za-z]+/.exec(source.slice(cursor));
      if (!match) break;
      const ident = match[0].toUpperCase();
      cursor += match[0].length;
      skipWhitespace();
      assert.equal(source[cursor], "[", `${ident} must have at least one value`);
      const values = [];
      while (source[cursor] === "[") {
        values.push(parseValue());
        skipWhitespace();
      }
      props[ident] = [...(props[ident] || []), ...values];
    }
    return { props };
  };

  const parseTree = () => {
    skipWhitespace();
    assert.equal(source[cursor], "(", `game tree expected at offset ${cursor}`);
    cursor += 1;
    skipWhitespace();
    const sequence = [];
    while (source[cursor] === ";") {
      sequence.push(parseNode());
      skipWhitespace();
    }
    assert.ok(sequence.length > 0, "each SGF game tree needs a node sequence");
    const children = [];
    while (source[cursor] === "(") {
      children.push(parseTree());
      skipWhitespace();
    }
    assert.equal(source[cursor], ")", `game tree must close at offset ${cursor}`);
    cursor += 1;
    return { sequence, children };
  };

  const tree = parseTree();
  skipWhitespace();
  assert.equal(cursor, source.length, "SGF must contain exactly one complete game tree");
  return tree;
}

function leafPaths(tree, prefix = []) {
  const path = [...prefix, ...tree.sequence];
  return tree.children.length
    ? tree.children.flatMap((child) => leafPaths(child, path))
    : [path];
}

function pointToXY(point) {
  assert.match(point, SGF_COORD);
  return [point.charCodeAt(0) - 97, point.charCodeAt(1) - 97];
}

function neighbors(point, size = 9) {
  const [x, y] = pointToXY(point);
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < size && ny < size)
    .map(([nx, ny]) => String.fromCharCode(97 + nx, 97 + ny));
}

function groupAt(board, start) {
  const color = board.get(start);
  assert.ok(color, `no stone at ${start}`);
  const stones = new Set([start]);
  const liberties = new Set();
  const pending = [start];
  while (pending.length) {
    const point = pending.pop();
    for (const neighbor of neighbors(point)) {
      const occupant = board.get(neighbor);
      if (!occupant) liberties.add(neighbor);
      else if (occupant === color && !stones.has(neighbor)) {
        stones.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return { stones, liberties };
}

function playMove(board, color, point) {
  assert.ok(!board.has(point), `${color}[${point}] cannot play on an occupied point`);
  board.set(point, color);
  const opponent = color === "B" ? "W" : "B";
  const checked = new Set();
  for (const neighbor of neighbors(point)) {
    if (board.get(neighbor) !== opponent || checked.has(neighbor)) continue;
    const group = groupAt(board, neighbor);
    for (const stone of group.stones) checked.add(stone);
    if (group.liberties.size === 0) {
      for (const stone of group.stones) board.delete(stone);
    }
  }
  assert.ok(groupAt(board, point).liberties.size > 0, `${color}[${point}] must not be suicide`);
}

function validatePath(root, path) {
  const board = new Map();
  for (const point of root.props.AB) board.set(point, "B");
  for (const point of root.props.AW) board.set(point, "W");
  let expected = root.props.PL[0];
  for (const node of path.slice(1)) {
    const moveColors = ["B", "W"].filter((color) => node.props[color]);
    assert.ok(moveColors.length <= 1, "a node may contain at most one move");
    if (moveColors.length === 0) continue;
    const color = moveColors[0];
    assert.equal(color, expected, `move order must begin with PL[${root.props.PL[0]}] and alternate`);
    assert.equal(node.props[color].length, 1, "a move property needs exactly one coordinate");
    playMove(board, color, node.props[color][0]);
    expected = expected === "B" ? "W" : "B";
  }
}

test("the original beginner pack has complete, unique and reusable metadata", () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.boardSize, 9);
  assert.ok(Array.isArray(manifest.problems));
  assert.ok(manifest.problems.length >= 24, "the first pack should contain at least 24 problems");

  const ids = new Set();
  const files = new Set();
  for (const problem of manifest.problems) {
    assert.match(problem.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(!ids.has(problem.id), `duplicate problem id: ${problem.id}`);
    ids.add(problem.id);

    assert.equal(problem.file, basename(problem.file), "problem files must stay inside static/problems");
    assert.match(problem.file, /^[a-z0-9][a-z0-9-]*\.sgf$/);
    assert.ok(!files.has(problem.file), `duplicate problem file: ${problem.file}`);
    files.add(problem.file);
    assert.ok(existsSync(new URL(problem.file, manifestUrl)), `missing problem file: ${problem.file}`);

    assert.ok(typeof problem.title === "string" && problem.title.length > 0);
    assert.ok(typeof problem.title_en === "string" && problem.title_en.trim().length > 0);
    assert.ok(!CHINESE_TEXT.test(problem.title_en), `${problem.id} English title must not contain Chinese text`);
    assert.ok(typeof problem.level === "string" && problem.level.length > 0);
    assert.ok(Array.isArray(problem.tags) && problem.tags.length > 0);
    assert.ok(problem.tags.every((tag) => typeof tag === "string" && tag.length > 0));
    assert.ok(typeof problem.goal === "string" && CHINESE_TEXT.test(problem.goal));
    assert.ok(typeof problem.goal_en === "string" && problem.goal_en.trim().length > 0);
    assert.ok(!CHINESE_TEXT.test(problem.goal_en), `${problem.id} English goal must not contain Chinese text`);
    assert.equal(problem.author, "KataGo HandTalk contributors");
    assert.equal(problem.source, "original");
    assert.equal(problem.license, "MIT");

    assert.deepEqual(problem.hints.map((hint) => hint.type), ["text", "region", "answer"]);
    assert.ok(typeof problem.hints[0].value === "string" && CHINESE_TEXT.test(problem.hints[0].value));
    for (const hint of problem.hints.slice(1)) {
      assert.ok(Array.isArray(hint.value) && hint.value.length > 0);
      assert.ok(hint.value.every((point) => SGF_COORD.test(point)), `${problem.id} has an invalid hint point`);
    }
    const region = new Set(problem.hints[1].value);
    assert.ok(problem.hints[2].value.every((point) => region.has(point)), `${problem.id} answer must be in hint region`);

    assert.ok(Array.isArray(problem.hints_en));
    assert.equal(problem.hints_en.length, 3, `${problem.id} needs exactly three English hints`);
    assert.deepEqual(problem.hints_en.map((hint) => hint.type), ["text", "region", "answer"]);
    assert.ok(typeof problem.hints_en[0].value === "string" && problem.hints_en[0].value.trim().length > 0);
    assert.ok(!CHINESE_TEXT.test(problem.hints_en[0].value), `${problem.id} English hint must not contain Chinese text`);
    for (const hint of problem.hints_en.slice(1)) {
      assert.ok(Array.isArray(hint.value) && hint.value.length > 0);
      assert.ok(hint.value.every((point) => SGF_COORD.test(point)), `${problem.id} has an invalid English hint point`);
    }
    assert.deepEqual(problem.hints_en[1].value, problem.hints[1].value, `${problem.id} hint regions must match across languages`);
    assert.deepEqual(problem.hints_en[2].value, problem.hints[2].value, `${problem.id} hint answers must match across languages`);
  }
});

test("every SGF is a legal 9x9 exercise with success and failure branches", () => {
  for (const problem of manifest.problems) {
    const source = readFileSync(new URL(problem.file, manifestUrl), "utf8").trim();
    const tree = parseSgf(source);
    const root = tree.sequence[0];

    assert.equal(root.props.GM?.[0], "1", `${problem.id} must be a Go record`);
    assert.equal(root.props.FF?.[0], "4", `${problem.id} must use FF4`);
    assert.equal(root.props.CA?.[0], "UTF-8", `${problem.id} must declare UTF-8`);
    assert.equal(root.props.SZ?.[0], "9", `${problem.id} must use a 9x9 board`);
    assert.ok(["B", "W"].includes(root.props.PL?.[0]), `${problem.id} needs PL`);
    assert.ok(root.props.AB?.length > 0, `${problem.id} needs black setup stones`);
    assert.ok(root.props.AW?.length > 0, `${problem.id} needs white setup stones`);
    assert.ok(CHINESE_TEXT.test(root.props.C?.[0] || ""), `${problem.id} needs a Chinese root comment`);

    const setup = [...root.props.AB, ...root.props.AW];
    assert.ok(setup.every((point) => SGF_COORD.test(point)), `${problem.id} has an invalid setup point`);
    assert.equal(new Set(setup).size, setup.length, `${problem.id} setup stones must not overlap`);
    const initialBoard = new Map([
      ...root.props.AB.map((point) => [point, "B"]),
      ...root.props.AW.map((point) => [point, "W"]),
    ]);
    for (const point of setup) {
      assert.ok(groupAt(initialBoard, point).liberties.size > 0, `${problem.id} starts with a zero-liberty group`);
    }

    const paths = leafPaths(tree);
    assert.ok(paths.length >= 2, `${problem.id} needs at least two variations`);
    const successes = paths.filter((path) => path.at(-1).props.HO?.[0] === "S");
    const failures = paths.filter((path) => path.at(-1).props.HO?.[0] === "F");
    assert.ok(successes.length > 0, `${problem.id} needs a successful path`);
    assert.ok(failures.length > 0, `${problem.id} needs a failure path`);

    for (const path of paths) {
      validatePath(root, path);
      const terminal = path.at(-1);
      assert.ok(CHINESE_TEXT.test(terminal.props.C?.[0] || ""), `${problem.id} terminal needs a Chinese explanation`);
    }

    const successfulMoves = new Set(successes.map((path) => {
      const firstMove = path.slice(1).find((node) => node.props.B || node.props.W);
      assert.ok(firstMove, `${problem.id} success path needs a move`);
      assert.equal(firstMove.props.TE?.[0], "1", `${problem.id} success move needs TE[1]`);
      return firstMove.props[root.props.PL[0]][0];
    }));
    for (const path of failures) {
      const firstMove = path.slice(1).find((node) => node.props.B || node.props.W);
      assert.ok(firstMove, `${problem.id} failure path needs a move`);
      assert.equal(firstMove.props.BM?.[0], "1", `${problem.id} failure move needs BM[1]`);
    }

    const answerMoves = new Set(problem.hints.find((hint) => hint.type === "answer").value);
    assert.deepEqual(successfulMoves, answerMoves, `${problem.id} manifest answer must match its TE success branches`);
  }
});

test("the application parser can load and solve every bundled problem", {
  skip: PracticeState ? false : "practice-state.js is not part of this checkout",
}, () => {
  for (const problem of manifest.problems) {
    const source = readFileSync(new URL(problem.file, manifestUrl), "utf8");
    const parsed = PracticeState.parseSgf(source);
    assert.equal(parsed.size, 9, `${problem.id} parser board size`);
    assert.equal(parsed.initialPlayer, parsed.solverColor, `${problem.id} PL should be the solver`);
    assert.ok(parsed.root.children.length >= 2, `${problem.id} parser variations`);

    const session = new PracticeState.Session(parsed, problem);
    const answer = problem.hints.find((hint) => hint.type === "answer").value[0];
    const result = session.playUserMove(answer);
    assert.equal(result.accepted, true, `${problem.id} answer should be a known legal move`);
    assert.equal(result.status, "success", `${problem.id} answer should reach HO[S]`);
  }
});
