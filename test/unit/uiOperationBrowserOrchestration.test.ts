import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBrowserTaskGroupInstruction,
  resolveUiOperationBrowserScreenshotPath
} from "../../server/src/uiOperationService.js";

test("已创建的宿主标签组被明确标记为完成且禁止 Agent 重试", () => {
  const instruction = buildBrowserTaskGroupInstruction({
    status: "created",
    groupId: 42,
    chromeTabId: 7,
    targetId: "chrome-tab-7",
    markerUrl: "about:blank#uiwarden-task-test",
    title: "打开百度"
  });
  assert.match(instruction, /宿主编排已完成/);
  assert.match(instruction, /groupId=42/);
  assert.match(instruction, /targetId=chrome-tab-7/);
  assert.match(instruction, /视为已完成/);
  assert.match(instruction, /禁止再次查询或尝试创建标签组/);
});

test("宿主标签组创建失败时禁止 Agent 通过 CLI 或 CDP 补做", () => {
  const instruction = buildBrowserTaskGroupInstruction({
    status: "failed",
    error: "扩展未连接"
  });
  assert.match(instruction, /扩展未连接/);
  assert.match(instruction, /不要用 dt-gui-browser 或直接 CDP 重试/);
});

test("浏览器执行截图只允许从当前工作区 Browser Rep 读取", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-browser-observation-"));
  const artifactDir = path.join(workspace, ".skill-output", "browser-reps", "browser-test");
  const screenshot = path.join(artifactDir, "screenshots", "frame_0001.png");
  const outside = path.join(os.tmpdir(), `uiwarden-outside-${Date.now()}.png`);
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(screenshot, "inside");
  await fs.writeFile(outside, "outside");
  try {
    assert.equal(
      await resolveUiOperationBrowserScreenshotPath(artifactDir, screenshot, workspace),
      await fs.realpath(screenshot)
    );
    assert.equal(
      await resolveUiOperationBrowserScreenshotPath(artifactDir, outside, workspace),
      undefined
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});
