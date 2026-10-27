import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveUiOperationNativeScreenshotPath } from "../../server/src/uiOperationService.js";

test("native picture-in-picture serves only regular files inside the current Native Rep", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-native-pip-"));
  const artifactDir = path.join(root, "native-rep");
  const screenshot = path.join(artifactDir, "screenshots", "frame_0001.png");
  const outside = path.join(root, "outside.png");
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(screenshot, "png");
  await fs.writeFile(outside, "private");
  try {
    const realScreenshot = await fs.realpath(screenshot);
    assert.equal(
      await resolveUiOperationNativeScreenshotPath(artifactDir, screenshot),
      realScreenshot
    );
    assert.equal(
      await resolveUiOperationNativeScreenshotPath(artifactDir, "screenshots/frame_0001.png"),
      realScreenshot
    );
    assert.equal(
      await resolveUiOperationNativeScreenshotPath(artifactDir, outside),
      undefined
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("native picture-in-picture rejects symlinks escaping the Native Rep", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires elevated privileges");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-native-pip-link-"));
  const artifactDir = path.join(root, "native-rep");
  const outside = path.join(root, "outside.png");
  const link = path.join(artifactDir, "screenshots", "frame_0001.png");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.writeFile(outside, "private");
  await fs.symlink(outside, link);
  try {
    assert.equal(
      await resolveUiOperationNativeScreenshotPath(artifactDir, link),
      undefined
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
