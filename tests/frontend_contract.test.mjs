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
    "app-toast",
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
  assert.match(app, /controller\.abort\("timeout"\)/);
  assert.match(app, /recognitionTimedOut/);
  assert.match(app, /}, 30000\)/);
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
  assert.match(app, /liveReviewStream \|\| liveReviewStarting \|\| manualRecognitionBusy/);
  assert.match(app, /manualRecognitionAbortController/);
  assert.match(app, /manualRecognitionAbortController\.abort\("closed"\)/);
  assert.match(app, /setManualRecognitionBusy\(false\)/);
  assert.match(app, /showToast\(t\(clipboardWasReadable/);
});

test("manual recognition optimizes screenshots and surfaces uncertain intersections", () => {
  assert.match(app, /prepareManualRecognitionImage/);
  assert.match(app, /result\.style\.display\s*=\s*"flex"/);
  assert.match(css, /\.recognize-modal-content\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.recognize-preview-row\s*\{[^}]*overflow:\s*auto;/s);
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
  assert.match(app, /invalidatePendingAi\(\);\s*if \(socket && socket\.connected\) socket\.emit\(EVENTS\.CANCEL\);\s*showAiRecovery\(t\("aiTimedOut"\)\)/);
  assert.match(app, /showAiRecovery\(t\("aiInvalidMove"\)\)/);
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

test("release capabilities, recognition cancellation, and AI recovery are visible states", () => {
  assert.match(app, /cfg\.capabilities/);
  assert.match(app, /applyCapabilities\(\)/);
  assert.match(app, /recognition\.available !== false/);
  assert.match(app, /controller\.abort\("timeout"\)/);
  assert.match(app, /manualRecognitionAbortController\.abort\("closed"\)/);
  assert.match(app, /showAiRecovery/);
  assert.match(app, /failedAiPositionKey === currentPositionKey\(\)/);
  assert.match(app, /AI 分析已关闭/);
  assert.match(index, /id="ai-recovery"/);
  assert.match(index, /id="btn-recognize-cancel"/);
  assert.match(index, /id="btn-lang"[^>]*hidden/);
  assert.equal(zh.analysisDisabled, "AI 分析已关闭");
  assert.equal(en.analysisDisabled, "AI analysis is off");
  assert.match(app, /loadedLocale/);
});

test("step back removes exactly one move and never asks the AI to replay it", () => {
  assert.equal(zh.undo, "退一手");
  assert.equal(en.undo, "Back one move");
  assert.ok(zh.stepBackHint);
  assert.ok(en.stepBackHint);
  assert.match(index, /id="btn-undo"[^>]+disabled/);
  assert.match(index, /data-key="undo">退一手</);

  const handler = app.match(
    /document\.getElementById\("btn-undo"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n        \}\);/,
  )?.[0] || "";
  assert.match(handler, /stepBackOneMove\(\)/);
  assert.doesNotMatch(handler, /board\.undo\(\);\s*board\.undo\(\)/);

  const stepBack = app.match(
    /function stepBackOneMove\(\) \{[\s\S]*?\n    \}/,
  )?.[0] || "";
  assert.equal([...stepBack.matchAll(/board\.undo\(\)/g)].length, 1);
  assert.match(stepBack, /socket\.emit\(EVENTS\.CANCEL\)/);
  assert.match(stepBack, /requestAnalysis\(\)/);
  assert.doesNotMatch(stepBack, /continueFromCurrentPosition\(\)/);
});

test("destructive confirmations use the styled accessible dialog", () => {
  assert.doesNotMatch(app, /\bconfirm\s*\(/);
  assert.doesNotMatch(app, /\balert\s*\(/);
  assert.match(index, /id="confirm-modal"[^>]+role="alertdialog"[^>]+aria-modal="true"/);
  assert.match(app, /function showConfirmDialog\(config\)/);
  assert.match(app, /titleKey: "newGameDialogTitle"/);
  assert.match(app, /titleKey: "resignDialogTitle"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /function trapModalFocus\(event, modal\)/);
  assert.match(app, /recognizeModalTrigger/);
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
    "stepBackHint",
    "recognitionTimedOut", "recognizeKeyboard", "emptyPoint", "blackStone",
    "whiteStone", "aiTimedOut", "aiInvalidMove",
    "practiceMode", "practiceModeHint", "practiceGoalLabel", "practiceTieredHints",
    "practiceHintButton", "practiceRetry", "practiceAnswer", "practiceNext",
    "practiceAnalyze", "practiceLoadingLibrary", "practiceThinkTitle",
    "practiceProgressStart", "practiceIllegalTitle", "practiceSuccessTitle",
    "practiceFailureTitle", "practiceContinueTitle", "practiceNoHint",
    "practiceAnswerMarked", "practiceAnalyzingTitle", "practiceDerivedHint",
  ];
  for (const key of keys) {
    assert.ok(zh[key], `missing zh.${key}`);
    assert.ok(en[key], `missing en.${key}`);
  }
});

test("responsive workspaces use one stable breakpoint and readable rails", () => {
  assert.match(css, /@media \(max-width: 840px\)/);
  assert.match(css, /@media \(min-width: 841px\) and \(max-width: 1699px\)/);
  assert.match(css, /@media \(min-width: 1700px\) and \(min-height: 760px\)/);
  assert.match(css, /\(min-width: 1700px\) and \(max-height: 759px\)/);
  assert.doesNotMatch(css, /min-aspect-ratio:\s*9\s*\/\s*5/);
  assert.match(css, /grid-template-areas:\s*"mode board action"\s*"live board suggestions"\s*"settings board pv"/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.doesNotMatch(css, /grid-template-areas:\s*"mode action"\s*"live action"/);
});

test("both board canvases have keyboard interaction and a visible focus state", () => {
  assert.match(index, /id="goboard"[^>]+tabindex="0"[^>]+role="application"/);
  assert.match(index, /id="recognize-board-canvas"[^>]+tabindex="0"[^>]+role="application"/);
  assert.match(app, /canvas\._recognizeKeyHandler/);
  assert.match(app, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(css, /#goboard:focus-visible/);
  assert.match(css, /#recognize-board-canvas:focus-visible/);
});

test("engine-provided suggestions and variations are rendered as text", () => {
  assert.match(app, /button\.setAttribute\("aria-label", label\)/);
  assert.match(app, /span\.textContent = value/);
  assert.match(app, /item\.textContent = `\$\{i \+ 1\}\.\$\{move\}`/);
  assert.doesNotMatch(app, /data-pv=/);
});

test("board size follows its square container instead of viewport guesses", () => {
  const board = readFileSync(new URL("../static/js/goboard.js", import.meta.url), "utf8");
  assert.match(board, /new ResizeObserver\(this\._handleResize\)/);
  assert.match(board, /this\._resizeObserver\.observe\(this\.canvas\.parentElement\)/);
  assert.match(board, /Math\.min\(availableWidth, availableHeight\)/);
  assert.match(board, /window\.innerWidth <= 840/g);
  assert.doesNotMatch(board, /window\.innerWidth <= 768/);
  assert.doesNotMatch(board, /const navH\s*=/);
  assert.doesNotMatch(board, /window\.innerWidth - 12/);
  assert.match(css, /#goboard\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/s);
});

test("core controls and supporting text meet the compact accessibility floor", () => {
  assert.match(css, /\.icon-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.import-quick-actions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.suggestion-item\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.setting-row select,[\s\S]*?\.recognize-guide select\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.eyebrow\s*\{[^}]*color:\s*var\(--accent-deep\)[^}]*font-size:\s*12px/s);
  assert.match(css, /--text-muted:\s*#656870/);
});
