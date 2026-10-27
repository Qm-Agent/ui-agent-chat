import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  forceStopBrowserAutomationSessionsForUiwardenSession,
  startBrowserAutomationSession,
  stopBrowserAutomationSession
} from "../../../server/src/browserAutomation.js";
import { updateGuiRuntimeSettings } from "../../../server/src/configStore.js";

const execFileAsync = promisify(execFile);
interface LauncherResult {
  activeTargetId?: string;
  projection?: string;
  transport?: {
    connectionId?: string;
    reused?: boolean;
  };
  screenshotSequence?: number;
}

const [cdpUrl, targetId, workspacePath] = process.argv.slice(2);
assert.ok(cdpUrl && targetId && workspacePath);
await updateGuiRuntimeSettings({ cliCompatibilityMode: false });
const session = await startBrowserAutomationSession({
  cdpUrl,
  targetId,
  runId: "server-mcp-smoke",
  uiwardenSessionId: "server-mcp-smoke",
  artifactRoot: `${workspacePath}/artifacts`,
  workspacePath
});
assert.ok(session.agentBinPath);
const launcher = session.agentBinPath;

try {
  const tabs = await runLauncher(launcher, ["tabs", "list", "--json"]);
  assert.equal(tabs.activeTargetId, targetId);
  const first = await runLauncher(launcher, ["observe", "--diff", "--json"]);
  const second = await runLauncher(launcher, ["observe", "--diff", "--json"]);
  const screenshot = await runLauncher(launcher, ["screenshot", "--json"]);
  assert.equal(first.projection, "full");
  assert.equal(second.projection, "diff");
  assert.equal(second.transport?.connectionId, first.transport?.connectionId);
  assert.equal(screenshot.transport?.connectionId, first.transport?.connectionId);
  assert.ok(second.transport?.reused);
  assert.ok(screenshot.transport?.reused);
  const forceStopped = await forceStopBrowserAutomationSessionsForUiwardenSession(
    "server-mcp-smoke",
    "force-stop-smoke"
  );
  assert.deepEqual(forceStopped, [session.sessionId]);
  const replacement = await startBrowserAutomationSession({
    cdpUrl,
    targetId,
    runId: "server-mcp-smoke-replacement",
    uiwardenSessionId: "server-mcp-smoke-replacement",
    artifactRoot: `${workspacePath}/replacement-artifacts`,
    workspacePath
  });
  await stopBrowserAutomationSession(replacement.sessionId, "replacement-complete");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId: session.sessionId,
    replacementSessionId: replacement.sessionId,
    agentBinPath: session.agentBinPath,
    connectionId: first.transport?.connectionId,
    screenshotSequences: [
      first.screenshotSequence,
      second.screenshotSequence,
      screenshot.screenshotSequence
    ]
  })}\n`);
} finally {
  await stopBrowserAutomationSession(session.sessionId, "server-mcp-smoke-complete");
}

async function runLauncher(
  launcher: string,
  args: string[]
): Promise<LauncherResult> {
  const result = await execFileAsync(launcher, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const envelope = JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    data?: LauncherResult;
    error?: { message?: string };
  };
  assert.equal(envelope.ok, true, envelope.error?.message);
  assert.ok(envelope.data);
  return envelope.data;
}
