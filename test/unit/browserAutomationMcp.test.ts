import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  callBrowserAutomationMcpCli,
  ensureBrowserAutomationMcp,
  stopBrowserAutomationMcp
} from "../../server/src/browserAutomationMcp.js";

test("browser MCP daemon keeps one session-bound CLI compatibility endpoint", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-browser-mcp-"));
  const runtimeHome = path.join(temporary, "runtime");
  const sessionId = "browser-11111111-1111-4111-8111-111111111111";
  const artifactDir = path.join(temporary, "artifacts", sessionId);
  await fs.mkdir(path.join(runtimeHome, "sessions"), { recursive: true });
  await fs.mkdir(path.join(artifactDir, "streams"), { recursive: true });
  await fs.mkdir(path.join(artifactDir, "downloads"), { recursive: true });
  await fs.writeFile(path.join(artifactDir, "downloads", "result.txt"), "done");
  await fs.writeFile(path.join(artifactDir, "streams", "downloads.jsonl"), [
    JSON.stringify({
      version: 1,
      sessionId,
      timestamp: "2026-07-28T00:00:00.000Z",
      state: "will-begin",
      guid: "download-1",
      url: "https://example.com/result.txt",
      suggestedFilename: "result.txt",
      source: "cdp"
    }),
    JSON.stringify({
      version: 1,
      sessionId,
      timestamp: "2026-07-28T00:00:01.000Z",
      state: "completed",
      guid: "download-1",
      receivedBytes: 4,
      totalBytes: 4,
      source: "cdp"
    })
  ].join("\n"));
  await fs.writeFile(path.join(runtimeHome, "sessions", `${sessionId}.json`), JSON.stringify({
    version: 1,
    runtimeVersion: "0.6.0",
    sessionId,
    runId: "mcp-manager-test",
    cdpUrl: "http://127.0.0.1:9222",
    targetId: "target-test",
    controlMode: "agent-control",
    state: "active",
    currentSnapshotId: null,
    currentSnapshot: null,
    lastObservedSnapshot: null,
    artifactDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopReason: null,
    eventCount: 0,
    snapshotSequence: 0,
    actionCount: 0,
    screenshotCount: 0,
    captureGapCount: 0,
    consoleCount: 0,
    pageErrorCount: 0,
    downloadCount: 0,
    dialogCount: 0,
    targetCount: 1,
    allowedTargetIds: ["target-test"],
    discoveredTargetIds: [],
    targetRelations: {},
    targetSelection: "uiwarden",
    uploadRoots: []
  }));
  const script = path.resolve("browser-automation/cli.mjs");
  try {
    const first = await ensureBrowserAutomationMcp({
      sessionId,
      script,
      runtimeHome,
      node: process.execPath
    });
    const second = await ensureBrowserAutomationMcp({
      sessionId,
      script,
      runtimeHome,
      node: process.execPath
    });
    assert.equal(first.state, "ready");
    assert.equal(second.pid, first.pid);
    assert.equal(second.endpoint, first.endpoint);
    const status = await callBrowserAutomationMcpCli<Record<string, unknown>>(
      sessionId,
      ["session", "status", "--json"]
    );
    assert.equal(status.sessionId, sessionId);
    assert.equal(status.state, "active");
    const downloads = await callBrowserAutomationMcpCli<{
      downloads: Array<{ state: string; suggestedFilename: string; filePresent: boolean; relativePath?: string }>;
    }>(sessionId, ["downloads", "list", "--json"]);
    assert.deepEqual(downloads.downloads, [{
      guid: "download-1",
      state: "completed",
      url: "https://example.com/result.txt",
      suggestedFilename: "result.txt",
      receivedBytes: 4,
      totalBytes: 4,
      startedAt: "2026-07-28T00:00:00.000Z",
      completedAt: "2026-07-28T00:00:01.000Z",
      filePresent: true,
      relativePath: "downloads/result.txt"
    }]);
  } finally {
    await stopBrowserAutomationMcp(sessionId);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
