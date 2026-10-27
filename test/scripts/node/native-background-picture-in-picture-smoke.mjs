import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (process.platform !== "darwin") {
  console.log("native background picture-in-picture smoke: SKIP non-macOS");
  process.exit(0);
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repoRoot, "native-automation", "dt-gui-computer");
const providerAppPath = path.join(
  repoRoot,
  "native-automation",
  "target",
  "native-provider",
  "dt-gui-computer Provider.app"
);
const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-computer-background-"));
const env = {
  ...process.env,
  DT_GUI_COMPUTER_HOME: runtimeHome,
  DT_GUI_COMPUTER_MACOS_PROVIDER: providerAppPath
};
const require = createRequire(import.meta.url);
const { NativeWindowStream } = require("../../../desktop/native-window-stream.cjs");

function calculatorProcessIds() {
  const result = spawnSync("/usr/bin/pgrep", ["-x", "Calculator"], { encoding: "utf8" });
  return result.status === 0
    ? result.stdout.trim().split(/\s+/).filter(Boolean)
    : [];
}

const existingCalculatorProcessIds = new Set(calculatorProcessIds());
let launchedCalculatorProcessId;

function run(args, expectedStatus = 0) {
  const result = spawnSync(cli, [...args, "--json"], { encoding: "utf8", env });
  assert.equal(
    result.status,
    expectedStatus,
    `${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`
  );
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.ok, expectedStatus === 0, JSON.stringify(output));
  return output.data;
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}+＝=]/gu, "");
}

function findElement(snapshot, aliases) {
  const expected = aliases.map(normalized);
  const candidates = [
    ...snapshot.elements.filter((element) => element.role === "AXButton"),
    ...snapshot.elements.filter((element) => element.role !== "AXButton")
  ];
  return candidates.find((element) => {
    const values = [element.name, element.value].map(normalized);
    return values.some((value) => expected.includes(value));
  });
}

function assertBackgroundAction(action) {
  assert.equal(action.performed, true);
  assert.equal(action.deliveryMode, "background-safe");
  assert.equal(action.providerResult.backgroundSafetyVerified, true);
  assert.equal(action.providerResult.targetApplicationActivated, false);
  assert.equal(action.providerResult.frontmostApplicationUnchanged, true);
  assert.equal(action.providerResult.cursorUnchanged, true);
  assert.match(
    String(action.providerResult.deliveryMethod || ""),
    /^(?:ax-|targeted-)/
  );
}

let session;
let stream;
try {
  const doctor = run(["doctor"]);
  const macProvider = doctor.providers.find((provider) => provider.providerId === "macos-accessibility");
  assert.equal(macProvider?.status, "ok", JSON.stringify(macProvider));
  assert.equal(macProvider?.data?.permission, "granted", JSON.stringify(macProvider));
  assert.equal(macProvider?.data?.screenCapturePermission, "granted", JSON.stringify(macProvider));

  session = run([
    "session", "start",
    "--provider", "macos-accessibility",
    "--app", "__agent_select__",
    "--mode", "agent-control",
    "--approval-policy", "none",
    "--delivery-mode", "background-safe"
  ]);
  assert.equal(session.deliveryMode, "background-safe");

  const launched = run([
    "session", "launch",
    "--session", session.sessionId,
    "--app-kind", "bundle-id",
    "--app", "com.apple.calculator"
  ]);
  assert.equal(launched.app.backgroundSafetyVerified, true, JSON.stringify(launched.app));
  assert.equal(launched.app.targetApplicationActivated, false, JSON.stringify(launched.app));
  assert.equal(launched.app.frontmostApplicationUnchanged, true, JSON.stringify(launched.app));
  assert.equal(launched.app.cursorUnchanged, true, JSON.stringify(launched.app));
  assert.notEqual(Number(launched.app.processId), 0);
  launchedCalculatorProcessId = String(launched.app.processId);

  let snapshot = run(["observe", "--session", session.sessionId, "--full"]);
  const sequence = [
    [["clear", "allclear", "ac", "清除", "全部清除"], false],
    [["1", "一"], true],
    [["+", "add", "加"], true],
    [["1", "一"], true],
    [["0", "零"], true],
    [["0", "零"], true],
    [["=", "＝", "equals", "等于"], true]
  ];
  const actionEvidence = [];
  for (const [aliases, required] of sequence) {
    const element = findElement(snapshot, aliases);
    if (!element && !required) continue;
    assert.ok(
      element,
      `Calculator element not found: ${aliases.join("/")}\n${snapshot.elements
        .filter((item) => item.role === "AXButton")
        .map((item) => `${item.name}:${item.value || ""}`)
        .join("\n")}`
    );
    const result = run([
      "click",
      "--session", session.sessionId,
      "--snapshot", snapshot.snapshotId,
      "--element", element.elementId,
      "--observe",
      "--diff"
    ]);
    assertBackgroundAction(result.action);
    actionEvidence.push({
      name: element.name,
      deliveryMethod: result.action.providerResult.deliveryMethod
    });
    // Diff snapshots only contain changed elements; refresh the full AX tree so
    // the next action never reuses a stale or omitted element identifier.
    snapshot = run(["observe", "--session", session.sessionId, "--full"]);
  }

  const finalSnapshot = run(["observe", "--session", session.sessionId, "--full"]);
  const visibleResult = [
    finalSnapshot.text,
    ...finalSnapshot.elements.flatMap((element) => [element.name, element.value])
  ].some((value) => /(?:^|\D)101(?:\D|$)/.test(String(value || "").replace(/,/g, "")));
  assert.equal(visibleResult, true, `Calculator did not expose 101\n${finalSnapshot.text}`);

  let latestFrame;
  let streamStatus;
  stream = new NativeWindowStream({
    providerAppPath,
    onFrame: (frame) => { latestFrame = frame; },
    onStatus: (status) => { streamStatus = status; }
  });
  await stream.start({ kind: "process-id", value: String(launched.app.processId) });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && Number(latestFrame?.sequence || 0) < 2) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(streamStatus?.status, "live", JSON.stringify(streamStatus));
  assert.equal(
    Number(latestFrame?.sequence || 0) >= 2,
    true,
    JSON.stringify({
      sequence: latestFrame?.sequence,
      capturedAt: latestFrame?.capturedAt,
      width: latestFrame?.width,
      height: latestFrame?.height,
      configuredFps: latestFrame?.configuredFps
    })
  );
  assert.match(latestFrame?.dataUrl || "", /^data:image\/jpeg;base64,/);
  assert.equal(latestFrame?.configuredFps, 20);

  const stopped = run([
    "session", "stop",
    "--session", session.sessionId,
    "--reason", "background-picture-in-picture-smoke"
  ]);
  session = undefined;
  const manifest = JSON.parse(await fs.readFile(path.join(stopped.artifactDir, "manifest.json"), "utf8"));
  assert.equal(manifest.deliveryMode, "background-safe");
  assert.equal(manifest.stopReason, "background-picture-in-picture-smoke");
  console.log(JSON.stringify({
    ok: true,
    provider: macProvider.data,
    calculatorResult: 101,
    actionEvidence,
    stream: {
      configuredFps: latestFrame.configuredFps,
      observedFps: latestFrame.fps,
      frames: latestFrame.sequence,
      width: latestFrame.width,
      height: latestFrame.height
    },
    artifactDir: stopped.artifactDir
  }, null, 2));
} finally {
  stream?.stop();
  if (session?.sessionId) {
    try {
      run([
        "session", "stop",
        "--session", session.sessionId,
        "--reason", "background-picture-in-picture-smoke-cleanup"
      ]);
    } catch {
      // Keep the original assertion as the failure signal.
    }
  }
  if (
    launchedCalculatorProcessId
    && !existingCalculatorProcessIds.has(launchedCalculatorProcessId)
  ) {
    try {
      process.kill(Number(launchedCalculatorProcessId), "SIGTERM");
    } catch {
      // The fixture application may already have exited.
    }
  }
}
