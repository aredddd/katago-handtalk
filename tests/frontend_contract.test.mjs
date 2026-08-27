import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const index = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../static/js/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../static/css/style.css", import.meta.url), "utf8");
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
    "analysis-toggle-label",
    "analysis-toggle-hint",
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
    "recognize-source-preview",
    "recognize-uncertain-count",
    "confirm-modal",
    "confirm-title",
    "confirm-message",
    "confirm-cancel",
    "confirm-accept",
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
  assert.match(index, /js\/live-review-state\.js/);
  assert.match(app, /getDisplayMedia/);
  assert.match(app, /fetch\("\/api\/recognize"/);
  assert.match(app, /AbortController/);
  assert.match(app, /liveReviewGeneration/);
  assert.match(app, /new LiveReviewState\.Tracker\(\)/);
  assert.match(app, /liveReviewTracker\.observe\(current, \{ frameId \}\)/);
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
  assert.match(app, /manualRecognitionBusy/);
  assert.match(app, /if \(liveReviewStream \|\| liveReviewStarting \|\| manualRecognitionBusy\) return/);
  assert.equal(app.includes("manualRecognitionController"), false);
});

test("manual recognition optimizes screenshots and surfaces uncertain intersections", () => {
  assert.match(app, /prepareManualRecognitionImage/);
  assert.match(app, /const maxSide = 1600/);
  assert.match(app, /canvas\.toBlob\(resolve, "image\/jpeg", 0\.90\)/);
  assert.match(app, /Screenshot optimization failed; using original image/);
  assert.match(app, /data\.cell_confidence/);
  assert.match(app, /data\.cell_margin/);
  assert.match(app, /data\.uncertain_points/);
  assert.match(app, /recognizedUncertainPoints\.delete/);
  assert.match(app, /ctx\.strokeStyle = "#ff9500"/);
  assert.match(css, /#recognize-uncertain-count\.has-uncertain/);
});

test("live review verifies complete frames and recovers from skipped moves", () => {
  assert.match(app, /sourceConfidence < 0\.55 \|\| rectifiedConfidence < 0\.70/);
  assert.match(app, /function scheduleLiveFrame\(delay = 350\)/);
  assert.match(app, /requestVideoFrameCallback/);
  assert.match(app, /liveReviewTracker\.observe\(current, \{ frameId \}\)/);
  assert.match(app, /canvas\.toBlob\(resolve, "image\/jpeg", 0\.90\)/);
  assert.match(app, /function liveChangedPointsAreReliable/);
  assert.match(app, /stoneConfidence >= 0\.70/);
  assert.match(app, /confidence < 0\.75/);
  assert.match(app, /margin < 0\.20/);
  assert.doesNotMatch(app, /function stabilizeLiveBoard/);
  assert.match(app, /decision\.effect === "global-resync"/);
  assert.match(app, /loadRecognizedBoard\(current, selectedPlayer, true\)/);
  assert.match(app, /statusKey: "liveRelocated"/);
  assert.match(app, /liveResumeBaseline/);
  assert.match(app, /resumeBaseline\.nextPlayer !== board\.currentPlayer/);
  assert.match(app, /loadRecognizedBoard\(recognizedBoard, null, false, true\)/);
});

test("AI responses are position-scoped and hidden review shortcuts stay removed", () => {
  assert.match(app, /_latestAiReqId/);
  assert.match(app, /data\.reqId !== _latestAiReqId/);
  assert.equal(app.includes('case "ArrowLeft"'), false);
  assert.equal(app.includes('case "ArrowRight"'), false);
  assert.match(app, /isThinking && isAiTurn\(\)/);
  assert.match(app, /gameMode === "play-black" \? 1/);
});

test("analysis can be fully closed and safely reopened", () => {
  assert.match(app, /function setAnalysisEnabled\(enabled/);
  assert.match(app, /setAnalysisEnabled\(!isAnalysisEnabled\(\)\)/);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(enabled\)\)/);
  assert.match(app, /board\.clearAnalysis\(\)/);
  assert.match(app, /!\(isThinking && isAiTurn\(\)\)/);
  assert.match(app, /if \(!isAnalysisEnabled\(\)\) return/);
  assert.match(app, /setAnalysisEnabled\(true, \{ request: false \}\)/);
  assert.equal(
    [...app.matchAll(/if \(isAnalysisEnabled\(\)\) updateWinrate/g)].length,
    2,
    "an AI move must not restore evaluation after analysis is closed",
  );
});

test("destructive confirmations use the styled accessible dialog", () => {
  assert.doesNotMatch(app, /\bconfirm\s*\(/);
  assert.match(index, /id="confirm-modal"[^>]+role="alertdialog"[^>]+aria-modal="true"/);
  assert.match(app, /function showConfirmDialog\(config\)/);
  assert.match(app, /titleKey: "newGameDialogTitle"/);
  assert.match(app, /titleKey: "resignDialogTitle"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /\.modal-overlay\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.confirm-modal-content\.is-danger/);
});

test("new beginner and live-review strings exist in both languages", () => {
  const keys = [
    "position", "resign", "confirmResign", "screenshotImport",
    "liveStart", "liveStop", "liveIdle", "liveRecognizing", "liveSynced",
    "snipThenPaste", "pasteShortcut", "clipboardNoImage",
    "recognizeCropHint", "recognizeCheckCount", "recognizeCheckClear",
    "liveTurnMismatch", "liveIllegalChange", "liveRelocated", "liveNeedsResync",
    "analysisOn", "analysisOff", "analysisOnHint", "analysisOffHint",
    "confirmAction", "cancel", "newGameDialogTitle", "startNewGame",
    "resignDialogTitle", "confirmResignAction",
  ];
  for (const key of keys) {
    assert.ok(zh[key], `missing zh.${key}`);
    assert.ok(en[key], `missing en.${key}`);
  }
});

test("small desktop windows keep every functional card reachable", () => {
  assert.match(css, /@media \(min-width: 841px\) and \(max-width: 1280px\)/);
  assert.match(css, /max-height: 900px/);
  assert.match(css, /grid-template-areas:\s*"mode action"\s*"live action"\s*"analysis pv"\s*"analysis settings"/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /@media \(max-width: 840px\)/);

  for (const area of ["mode", "action", "live", "analysis", "pv", "settings"]) {
    assert.match(css, new RegExp(`grid-area:\\s*${area}`), `missing compact ${area} area`);
  }
});
