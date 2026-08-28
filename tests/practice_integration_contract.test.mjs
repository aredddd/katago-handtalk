import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";


const index = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../static/js/app.js", import.meta.url), "utf8");
const board = readFileSync(new URL("../static/js/goboard.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../static/css/style.css", import.meta.url), "utf8");


test("normal play exposes only the supported 9, 13, and 19 board sizes", () => {
  assert.match(index, /data-board-size="9"/);
  assert.match(index, /data-board-size="13"/);
  assert.match(index, /data-board-size="19"/);
  assert.match(index, /data-new-game-size="9"/);
  assert.match(index, /data-new-game-size="13"/);
  assert.match(index, /data-new-game-size="19"/);
  assert.match(app, /supportedBoardSizes = \[9, 13, 19\]/);
  assert.match(app, /recognitionBoardSizes = \[19\]/);
  assert.match(app, /isRecognitionSize\(getBoardSize\(\)\)/);
});


test("practice mode loads local SGF, persists progress, and gates KataGo", () => {
  assert.match(index, /data-mode="practice"/);
  assert.match(index, /id="practice-section"/);
  assert.match(index, /src="js\/practice-state\.js"/);
  assert.match(app, /fetch\("\/problems\/manifest\.json"/);
  assert.match(app, /new PracticeState\.Session\(sgf, localizedPracticeMetadata\(metadata\)\)/);
  assert.match(app, /\/api\/practice-progress\/\$\{encodeURIComponent\(practiceProblem\.id\)\}/);
  assert.match(app, /gameMode === "practice" && !practiceAnalysisUnlocked/);
  assert.match(app, /function analyzePracticePosition\(\)/);
  assert.match(app, /if \(!board\.previewMove\(x, y\)\)/);
  assert.match(app, /board\.tryMove\(move\.point\.x, move\.point\.y, \{ silent: true \}\)/);
  assert.match(index, /id="btn-practice-back"/);
  assert.match(app, /function stepBackPracticeAnalysis\(\)/);
  assert.match(app, /function recordAbandonedPracticeIfNeeded\(\)/);
  assert.match(app, /await recordAbandonedPracticeIfNeeded\(\)/);
  assert.match(app, /if \(!practiceAnalysisUnlocked\) \{/);
  assert.match(app, /PracticeState\.chooseProblemIndex/);
  assert.match(app, /metadata\.title_en/);
  assert.match(app, /metadata\.hints_en/);
});


test("teaching hints have a dedicated overlay and responsive two-rail layout", () => {
  assert.match(board, /setPracticeOverlay\(overlay = null\)/);
  assert.match(board, /_drawPracticeOverlay\(\)/);
  assert.match(index, /id="practice-hint-text"[^>]+aria-live="polite"/);
  assert.match(style, /html\.practice-active #main-content/);
  assert.match(style, /"mode board practice"/);
  assert.match(style, /@media \(max-width: 840px\)/);
});
