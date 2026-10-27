import assert from "node:assert/strict";
import test from "node:test";
import {
  canAutoLoadUnpackedTaskGroupExtension,
  normalizeCdpTaskGroupTitle
} from "../../server/src/cdpManager.js";

test("official branded Chromium browsers are not launched with unpacked extensions", () => {
  assert.equal(
    canAutoLoadUnpackedTaskGroupExtension(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "Google Chrome"
    ),
    false
  );
  assert.equal(
    canAutoLoadUnpackedTaskGroupExtension(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Microsoft Edge"
    ),
    false
  );
});

test("developer Chromium distributions may auto-load the bundled task group extension", () => {
  assert.equal(
    canAutoLoadUnpackedTaskGroupExtension(
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "Chromium"
    ),
    true
  );
  assert.equal(
    canAutoLoadUnpackedTaskGroupExtension(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "Chrome for Testing"
    ),
    true
  );
});

test("task group titles are bounded and strip control characters", () => {
  assert.equal(normalizeCdpTaskGroupTitle("\u0000  检查\n同步任务结果  "), "检查 同步任务结果");
  assert.equal(normalizeCdpTaskGroupTitle("一".repeat(40)).length, 24);
  assert.equal(normalizeCdpTaskGroupTitle(" \n "), "UIWarden Task");
});
