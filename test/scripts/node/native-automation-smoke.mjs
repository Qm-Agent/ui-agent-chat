import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const binary = process.env.DT_GUI_COMPUTER_BIN
  || path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-computer-smoke-"));
const env = {
  ...process.env,
  DT_GUI_COMPUTER_HOME: home
};
let socketDaemon;

function run(args, expectedStatus = 0) {
  const result = spawnSync(binary, args, { encoding: "utf8", env });
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.ok, expectedStatus === 0, JSON.stringify(output));
  return output;
}

try {
  const doctor = run(["doctor", "--json"]).data;
  assert.equal(doctor.protocolVersion, 1);
  assert.equal(doctor.providers.some((provider) => provider.providerId === "mock" && provider.status === "ok"), true);

  const apps = run(["apps", "list", "--provider", "mock", "--json"]).data.apps;
  assert.equal(apps[0].id, "mock.demo");

  const artifactRoot = path.join(home, "workspace", ".skill-output", "native-reps");
  const session = run([
    "session", "start", "--provider", "mock", "--app", "__agent_select__", "--mode", "agent-control",
    "--artifact-root", artifactRoot, "--json"
  ]).data;
  assert.equal(session.state, "active");
  assert.equal(path.dirname(session.artifactDir), artifactRoot);
  const targeted = run([
    "session", "target", "--session", session.sessionId, "--app-kind", "name", "--app", "mock.demo", "--json"
  ]).data;
  assert.deepEqual(targeted.app, { kind: "name", value: "mock.demo" });
  const launched = run([
    "session", "launch", "--session", session.sessionId, "--app-kind", "name", "--app", "UIWarden Mock Desktop", "--json"
  ]).data;
  assert.equal(launched.app.id, "mock.demo");
  assert.equal(launched.session.app.kind, "process-id");

  const busy = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control", "--json"
  ], 3);
  assert.equal(busy.error.code, "DESKTOP_BUSY");

  const first = run(["observe", "--session", session.sessionId, "--full", "--json"]).data;
  assert.deepEqual(first.projection, {
    mode: "full",
    maxDepth: 12,
    maxElements: 800,
    truncated: false
  });
  assert.equal(first.elements.some((element) => element.elementId === "input-name"), true);
  assert.equal(first.elements.find((element) => element.elementId === "password")?.value, "[REDACTED]");
  const staticInput = run([
    "set-value", "--session", session.sessionId, "--snapshot", first.snapshotId,
    "--element", "static-search", "--value", "must-not-be-accepted", "--json"
  ], 2);
  assert.equal(staticInput.error.code, "UNSUPPORTED_ACTION");
  assert.match(staticInput.error.message, /不是可编辑输入控件/);
  const offscreenClick = run([
    "click", "--session", session.sessionId, "--snapshot", first.snapshotId,
    "--element", "offscreen-result", "--allow-coordinate-fallback", "--json"
  ], 2);
  assert.equal(offscreenClick.error.code, "UNSUPPORTED_ACTION");
  assert.match(offscreenClick.error.message, /目标窗口之外/);

  const human = run([
    "session", "control", "--session", session.sessionId, "--mode", "human-control", "--json"
  ]).data;
  assert.equal(human.controlMode, "human-control");
  const pausedAction = run([
    "set-value", "--session", session.sessionId, "--snapshot", first.snapshotId,
    "--element", "input-name", "--value", "blocked", "--json"
  ], 3);
  assert.equal(pausedAction.error.code, "HUMAN_CONTROL_ACTIVE");
  run(["session", "control", "--session", session.sessionId, "--mode", "agent-control", "--json"]);

  run([
    "set-value", "--session", session.sessionId, "--snapshot", first.snapshotId,
    "--element", "input-name", "--value", "Alice", "--json"
  ]);
  const stale = run([
    "click", "--session", session.sessionId, "--snapshot", first.snapshotId,
    "--element", "button-save", "--json"
  ], 2);
  assert.equal(stale.error.code, "STALE_SNAPSHOT");

  const second = run(["observe", "--session", session.sessionId, "--json"]).data;
  assert.equal(second.elements.find((element) => element.elementId === "input-name")?.value, "Alice");

  run([
    "type-text", "--session", session.sessionId, "--snapshot", second.snapshotId,
    "--element", "input-name", "--value", "-B", "--json"
  ]);
  const third = run(["observe", "--session", session.sessionId, "--json"]).data;
  assert.equal(third.elements.find((element) => element.elementId === "input-name")?.value, "Alice-B");

  const handoff = run([
    "set-value", "--session", session.sessionId, "--snapshot", third.snapshotId,
    "--element", "password", "--value", "not-recorded", "--json"
  ], 4);
  assert.equal(handoff.error.code, "HANDOFF_REQUIRED");

  const approvalRequired = run([
    "click", "--session", session.sessionId, "--snapshot", third.snapshotId,
    "--element", "button-delete", "--json"
  ], 4);
  assert.equal(approvalRequired.error.code, "APPROVAL_REQUIRED");
  const challengeId = approvalRequired.error.details.challenge.challengeId;
  run(["approval", "grant", "--session", session.sessionId, "--challenge", challengeId, "--json"]);
  run([
    "click", "--session", session.sessionId, "--snapshot", third.snapshotId,
    "--element", "button-delete", "--approval", challengeId, "--json"
  ]);

  const fourth = run(["observe", "--session", session.sessionId, "--json"]).data;
  assert.equal(fourth.elements.some((element) => element.elementId === "button-delete"), false);
  const stopped = run([
    "session", "stop", "--session", session.sessionId, "--reason", "smoke-complete", "--json"
  ]).data;
  assert.equal(stopped.state, "stopped");

  const manifest = JSON.parse(await fs.readFile(path.join(stopped.artifactDir, "manifest.json"), "utf8"));
  assert.equal(manifest.stopReason, "smoke-complete");
  assert.equal(manifest.snapshotCount, 4);
  assert.equal(manifest.actionCount, 3);
  assert.equal(manifest.approvalCount, 2);
  assert.equal(manifest.captureGaps.includes("mock-provider-no-screenshot"), true);
  const latestSnapshot = JSON.parse(await fs.readFile(path.join(stopped.artifactDir, "snapshots", "latest.json"), "utf8"));
  assert.equal(latestSnapshot.elements.find((element) => element.elementId === "password")?.value, "[REDACTED]");
  await fs.access(path.join(stopped.artifactDir, "schemas", "snapshot.schema.json"));
  const events = await fs.readFile(path.join(stopped.artifactDir, "streams", "events.jsonl"), "utf8");
  const actions = await fs.readFile(path.join(stopped.artifactDir, "streams", "actions.jsonl"), "utf8");
  assert.equal(events.includes("not-recorded"), false);
  assert.equal(events.includes("Alice"), false);
  assert.equal(events.includes("Alice-B"), false);
  assert.equal(actions.includes('"targetName":"Name"'), true);
  assert.equal(actions.includes('"targetName":"Delete record"'), true);

  const coordinateSession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control", "--json"
  ]).data;
  const coordinateSnapshot = run(["observe", "--session", coordinateSession.sessionId, "--json"]).data;
  const implicitCoordinate = run([
    "click", "--session", coordinateSession.sessionId, "--snapshot", coordinateSnapshot.snapshotId,
    "--x", "10", "--y", "20", "--json"
  ], 2);
  assert.equal(implicitCoordinate.error.code, "INVALID_ARGUMENT");
  const coordinateClick = run([
    "click", "--session", coordinateSession.sessionId, "--snapshot", coordinateSnapshot.snapshotId,
    "--x", "10", "--y", "20", "--allow-coordinate-fallback", "--json"
  ]);
  assert.equal(coordinateClick.data.performed, true);
  run(["session", "stop", "--session", coordinateSession.sessionId, "--reason", "coordinate-smoke", "--json"]);

  const actionObserveSession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control",
    "--approval-policy", "none", "--delivery-mode", "background-safe", "--json"
  ]).data;
  assert.equal(actionObserveSession.deliveryMode, "background-safe");
  const actionObserveInitial = run([
    "observe", "--session", actionObserveSession.sessionId, "--json"
  ]).data;
  const actionObserveResult = run([
    "set-value", "--session", actionObserveSession.sessionId,
    "--snapshot", actionObserveInitial.snapshotId,
    "--element", "input-name", "--value", "Combined",
    "--observe", "--diff", "--json"
  ]).data;
  assert.equal(actionObserveResult.action.performed, true);
  assert.equal(actionObserveResult.action.deliveryMode, "background-safe");
  assert.equal(actionObserveResult.action.providerResult.frontmostApplicationUnchanged, true);
  assert.equal(actionObserveResult.action.providerResult.cursorUnchanged, true);
  assert.equal(actionObserveResult.snapshot.diff, true);
  assert.equal(
    actionObserveResult.snapshot.elements.find((element) => element.elementId === "input-name")?.value,
    "Combined"
  );
  run([
    "session", "stop", "--session", actionObserveSession.sessionId,
    "--reason", "action-observe-smoke", "--json"
  ]);

  const pictureInPictureSession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control", "--json"
  ]).data;
  const pictureInPictureSnapshot = run([
    "observe", "--session", pictureInPictureSession.sessionId, "--json"
  ]).data;
  run([
    "session", "control", "--session", pictureInPictureSession.sessionId,
    "--mode", "human-control", "--json"
  ]);
  const pictureInPictureClick = run([
    "click", "--session", pictureInPictureSession.sessionId,
    "--snapshot", pictureInPictureSnapshot.snapshotId,
    "--element", "button-save", "--actor", "user", "--json"
  ]).data;
  assert.equal(pictureInPictureClick.actor, "user");
  const pictureInPictureStopped = run([
    "session", "stop", "--session", pictureInPictureSession.sessionId,
    "--reason", "picture-in-picture-smoke", "--json"
  ]).data;
  const pictureInPictureActions = await fs.readFile(
    path.join(pictureInPictureStopped.artifactDir, "streams", "actions.jsonl"),
    "utf8"
  );
  assert.equal(pictureInPictureActions.includes('"actor":"user"'), true);

  const noApprovalSession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control",
    "--approval-policy", "none", "--json"
  ]).data;
  assert.equal(noApprovalSession.approvalPolicy, "none");
  const noApprovalSnapshot = run(["observe", "--session", noApprovalSession.sessionId, "--json"]).data;
  const submitted = run([
    "key", "--session", noApprovalSession.sessionId, "--snapshot", noApprovalSnapshot.snapshotId,
    "--key", "Return", "--json"
  ]).data;
  assert.equal(submitted.performed, true);
  run(["session", "stop", "--session", noApprovalSession.sessionId, "--reason", "no-approval-smoke", "--json"]);

  const recoverySession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control",
    "--approval-policy", "none", "--json"
  ]).data;
  let recoverySnapshot = run(["observe", "--session", recoverySession.sessionId, "--json"]).data;
  run([
    "click", "--session", recoverySession.sessionId, "--snapshot", recoverySnapshot.snapshotId,
    "--element", "button-save", "--json"
  ]);
  recoverySnapshot = run(["observe", "--session", recoverySession.sessionId, "--json"]).data;
  run([
    "key", "--session", recoverySession.sessionId, "--snapshot", recoverySnapshot.snapshotId,
    "--key", "Return", "--json"
  ]);
  recoverySnapshot = run(["observe", "--session", recoverySession.sessionId, "--json"]).data;
  run([
    "click", "--session", recoverySession.sessionId, "--snapshot", recoverySnapshot.snapshotId,
    "--element", "button-save", "--json"
  ]);
  recoverySnapshot = run(["observe", "--session", recoverySession.sessionId, "--json"]).data;
  assert.equal(recoverySnapshot.delta.noProgressCount, 3);
  assert.equal(run([
    "session", "status", "--session", recoverySession.sessionId, "--json"
  ]).data.state, "active");
  run(["session", "stop", "--session", recoverySession.sessionId, "--reason", "recovery-smoke", "--json"]);

  const noProgressSession = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control",
    "--approval-policy", "none", "--json"
  ]).data;
  const noProgressSnapshot = run(["observe", "--session", noProgressSession.sessionId, "--json"]).data;
  assert.equal(noProgressSnapshot.delta.changed, true);
  run([
    "click", "--session", noProgressSession.sessionId, "--snapshot", noProgressSnapshot.snapshotId,
    "--element", "button-save", "--json"
  ]);
  const noProgressOne = run(["observe", "--session", noProgressSession.sessionId, "--json"]).data;
  assert.equal(noProgressOne.delta.noProgressCount, 1);
  const repeatedObservation = run(["observe", "--session", noProgressSession.sessionId, "--json"]).data;
  assert.equal(repeatedObservation.delta.noProgressCount, 1);
  assert.equal(repeatedObservation.delta.actionCountSinceLastObservation, 0);
  run([
    "click", "--session", noProgressSession.sessionId, "--snapshot", repeatedObservation.snapshotId,
    "--element", "button-save", "--json"
  ]);
  const noProgressTwo = run(["observe", "--session", noProgressSession.sessionId, "--json"]).data;
  assert.equal(noProgressTwo.delta.noProgressCount, 2);
  run([
    "click", "--session", noProgressSession.sessionId, "--snapshot", noProgressTwo.snapshotId,
    "--element", "button-save", "--json"
  ]);
  const noProgress = run(["observe", "--session", noProgressSession.sessionId, "--json"], 3);
  assert.equal(noProgress.error.code, "NO_PROGRESS");
  const failedNoProgressSession = run([
    "session", "status", "--session", noProgressSession.sessionId, "--json"
  ]).data;
  assert.equal(failedNoProgressSession.state, "failed");
  assert.equal(failedNoProgressSession.stopReason, "no-progress");

  const staleOwner = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control", "--json"
  ]).data;
  const leasePath = path.join(home, "desktop-write-lease.json");
  const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
  await fs.writeFile(leasePath, JSON.stringify({ ...lease, expiresAt: "1970-01-01T00:00:00.000Z" }), { mode: 0o600 });
  const recovered = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "agent-control", "--json"
  ]).data;
  run(["session", "stop", "--session", recovered.sessionId, "--reason", "lease-recovered", "--json"]);
  run(["session", "stop", "--session", staleOwner.sessionId, "--reason", "stale-owner-cleanup", "--json"]);

  const corrupted = run([
    "session", "start", "--provider", "mock", "--app", "mock.demo", "--mode", "observe", "--json"
  ]).data;
  const corruptedPath = path.join(home, "sessions", `${corrupted.sessionId}.json`);
  await fs.writeFile(corruptedPath, "{broken-json", { mode: 0o600 });
  const corruption = run(["session", "status", "--session", corrupted.sessionId, "--json"], 2);
  assert.equal(corruption.error.code, "STORAGE_CORRUPTED");
  assert.equal(await fs.readFile(corruptedPath, "utf8"), "{broken-json");

  const mcpInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "native_doctor", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "native_capabilities", arguments: {} } }
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  const mcp = spawnSync(binary, ["mcp"], { encoding: "utf8", env, input: mcpInput });
  assert.equal(mcp.status, 0, mcp.stderr);
  const responses = mcp.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.serverInfo.name, "dt-gui-computer");
  const mcpToolNames = responses[1].result.tools.map((tool) => tool.name);
  for (const expected of [
    "native_capabilities", "native_apps_list", "native_session_start", "native_session_status",
    "native_session_target", "native_session_launch", "native_session_control", "native_observe",
    "native_action_and_observe", "native_click", "native_set_value",
    "native_type_text", "native_key", "native_scroll", "native_approval_grant",
    "native_approval_reject", "native_session_stop"
  ]) {
    assert.equal(mcpToolNames.includes(expected), true, `missing MCP tool ${expected}`);
  }
  assert.equal(mcpToolNames.includes("native_shell"), false);
  assert.equal(responses[2].result.isError, false);
  assert.equal(responses[3].result.isError, false);

  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\dt-gui-computer-smoke-${process.pid}`
    : path.join(home, "runtime.sock");
  const explicitMcpHome = path.join(home, "explicit-mcp-home");
  socketDaemon = spawn(binary, [
    "--runtime-home", explicitMcpHome, "mcp", "--socket", socketPath
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForMcpSocket(socketPath, socketDaemon);
  const socketClientEnv = { ...env, DT_GUI_COMPUTER_MCP_ENDPOINT: socketPath };
  const socketApps = spawnSync(binary, [
    "apps", "list", "--provider", "mock", "--query", "UIWarden", "--limit", "5", "--json"
  ], { encoding: "utf8", env: socketClientEnv });
  assert.equal(socketApps.status, 0, socketApps.stderr);
  const socketEnvelope = JSON.parse(socketApps.stdout.trim());
  assert.equal(socketEnvelope.ok, true);
  assert.equal(socketEnvelope.data.apps[0].id, "mock.demo");
  const socketDoctor = spawnSync(binary, ["doctor", "--json"], {
    encoding: "utf8",
    env: socketClientEnv
  });
  assert.equal(socketDoctor.status, 0, socketDoctor.stderr);
  assert.equal(JSON.parse(socketDoctor.stdout.trim()).ok, true);
  if (process.platform === "darwin") {
    await fs.access(path.join(explicitMcpHome, "provider-macos-daemon", "ready.json"));
  }

  const macApps = run(["apps", "list", "--provider", "macos-accessibility", "--json"]).data.apps;
  assert.equal(macApps.length > 0, true);
  assert.equal(macApps.some((app) => app.id === "com.apple.calculator"), true);

  const macProvider = doctor.providers.find((provider) => provider.providerId === "macos-accessibility");
  assert.equal(macProvider?.status, "ok");
  const macSession = run([
    "session", "start", "--provider", "macos-accessibility",
    "--app", "__agent_select__", "--mode", "agent-control", "--json"
  ]).data;
  run([
    "session", "launch", "--session", macSession.sessionId,
    "--app-kind", "bundle-id", "--app", "com.apple.calculator", "--json"
  ]);
  if (macProvider.data.permission === "granted") {
    const macSnapshot = run(["observe", "--session", macSession.sessionId, "--json"]).data;
    assert.equal(macSnapshot.app.id, "com.apple.calculator");
    assert.equal(macSnapshot.elements.length > 0, true);
    if (macProvider.data.screenCapturePermission === "granted") {
      assert.equal(typeof macSnapshot.screenshotPath, "string");
      await fs.access(macSnapshot.screenshotPath);
      assert.deepEqual(macSnapshot.captureGaps, []);
    }
  } else {
    const denied = run(["observe", "--session", macSession.sessionId, "--json"], 2);
    assert.equal(denied.error.code, "PERMISSION_DENIED");
  }
  run(["session", "stop", "--session", macSession.sessionId, "--reason", "permission-probe-complete", "--json"]);

  console.log(`dt-gui-computer smoke: PASS session=${session.sessionId} events=${manifest.eventCount} macApps=${macApps.length} macPermission=${macProvider.data.permission}`);
} finally {
  if (socketDaemon && socketDaemon.exitCode == null) {
    socketDaemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => socketDaemon.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
  await fs.rm(home, { recursive: true, force: true });
}

async function waitForMcpSocket(endpoint, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`MCP socket daemon exited with ${child.exitCode}`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection(endpoint);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("MCP socket daemon did not become ready");
}
