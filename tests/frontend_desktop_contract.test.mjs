import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../static/js/app.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const zh = JSON.parse(readFileSync(new URL("../static/locales/zh.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../static/locales/en.json", import.meta.url), "utf8"));

test("desktop shell uses native screenshot and clipboard bridges with browser fallbacks", () => {
  assert.match(app, /window\.pywebview\.api/);
  assert.match(app, /api\.open_snipping_tool/);
  assert.match(app, /api\.read_clipboard_image \|\| api\.get_clipboard_image/);
  assert.match(app, /ms-screenclip:\/\/capture\/image/);
  assert.match(app, /navigator\.clipboard\.read/);
  assert.match(app, /nativeClipboardPayloadToFile/);
});

test("live review remains browser-native and explains desktop limitations", () => {
  assert.match(app, /navigator\.mediaDevices\.getDisplayMedia/);
  assert.match(app, /isDesktopShell\(\) \? "liveDesktopUnsupported" : "liveUnsupported"/);
  assert.ok(zh.liveDesktopUnsupported);
  assert.ok(en.liveDesktopUnsupported);
});

test("desktop shell reports client readiness and JavaScript failures", () => {
  assert.match(app, /reportDesktopEvent\("client_ready"/);
  assert.match(app, /reportDesktopEvent\("client_error"/);
  assert.match(app, /pywebviewready/);
  assert.match(app, /unhandledrejection/);
});

test("desktop header can pin and unpin the native window", () => {
  assert.match(index, /id="btn-topmost"/);
  assert.match(index, /class="icon-button desktop-only"/);
  assert.match(index, /aria-pressed="false"/);
  assert.match(app, /api\.get_always_on_top/);
  assert.match(app, /api\.set_always_on_top/);
  assert.ok(zh.windowPin && zh.windowPinned && zh.windowPinnedTitle);
  assert.ok(en.windowPin && en.windowPinned && en.windowPinnedTitle);
});
