import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const index = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../static/js/app.js", import.meta.url), "utf8");
const zh = JSON.parse(readFileSync(new URL("../static/locales/zh.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../static/locales/en.json", import.meta.url), "utf8"));

test("beginner controls and analysis surfaces stay available", () => {
  const requiredIds = [
    "goboard",
    "btn-undo",
    "btn-pass",
    "btn-resign",
    "btn-new-game",
    "btn-analyze",
    "btn-position",
    "btn-camera",
    "btn-snipping",
    "btn-paste",
    "btn-live-review",
    "live-next-player",
    "live-review-status",
    "live-review-video",
    "live-review-canvas",
    "show-analysis",
    "show-ownership",
    "show-move-number",
    "board-size",
    "komi",
    "max-visits",
    "suggestions-list",
    "pv-display",
    "recognize-modal",
    "recognize-next-player",
  ];
  for (const id of requiredIds) {
    assert.match(index, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test("account and advanced AI-vs-AI UI are removed", () => {
  for (const removed of ["auth-modal", "btn-show-login", 'data-mode="ai-vs-ai"']) {
    assert.equal(index.includes(removed), false, `${removed} should not be present`);
  }
  for (const removedCode of ["jwt_token", "/api/login", "withToken("]) {
    assert.equal(app.includes(removedCode), false, `${removedCode} should not be present`);
  }
});

test("live review reuses local recognition and never automates moves", () => {
  assert.match(app, /getDisplayMedia/);
  assert.match(app, /fetch\("\/api\/recognize"/);
  assert.match(app, /AbortController/);
  assert.match(app, /liveReviewGeneration/);
  assert.match(app, /findLiveMoveTransition/);
  assert.match(app, /livePendingCount < 2/);
  assert.match(app, /generation !== liveReviewGeneration \|\| !liveReviewStream/);
  assert.equal(app.includes("mouse_event"), false);
  assert.equal(app.includes("dispatchEvent(new MouseEvent"), false);
});

test("screenshots can be selected, snipped, or pasted from the clipboard", () => {
  assert.match(app, /ms-screenclip:\/\/capture\/image/);
  assert.match(app, /navigator\.clipboard\.read/);
  assert.match(app, /addEventListener\("paste"/);
  assert.match(app, /imageFromClipboardData/);
  assert.match(app, /manualRecognitionSeq/);
  assert.match(app, /manualRecognitionController\.abort/);
});

test("AI responses are position-scoped and hidden review shortcuts stay removed", () => {
  assert.match(app, /_latestAiReqId/);
  assert.match(app, /data\.reqId !== _latestAiReqId/);
  assert.equal(app.includes('case "ArrowLeft"'), false);
  assert.equal(app.includes('case "ArrowRight"'), false);
  assert.match(app, /isThinking && isAiTurn\(\)/);
  assert.match(app, /gameMode === "play-black" \? 1/);
});

test("new beginner and live-review strings exist in both languages", () => {
  const keys = [
    "position", "resign", "confirmResign", "screenshotImport",
    "liveStart", "liveStop", "liveIdle", "liveRecognizing", "liveSynced",
    "snipThenPaste", "pasteShortcut", "clipboardNoImage",
    "liveTurnMismatch", "liveIllegalChange", "liveRelocated",
  ];
  for (const key of keys) {
    assert.ok(zh[key], `missing zh.${key}`);
    assert.ok(en[key], `missing en.${key}`);
  }
});
