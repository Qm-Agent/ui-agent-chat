import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ComputerRuntime } from "../../../native-automation/dist/runtime.js";
import { RUNTIME_VERSION } from "../../../native-automation/dist/types.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const computerCli = path.join(repoRoot, "native-automation", "dt-gui-computer");
const evidencePath = path.join(repoRoot, ".skill-output", "benchmarks", "uiwarden-computer-calculator.png");
const outputPath = path.resolve(
  process.env.BENCHMARK_OUTPUT
    || path.join(repoRoot, ".skill-output", "benchmarks", "uiwarden-codex-computer.json")
);
const trials = Math.max(1, Number(process.env.BENCHMARK_TRIALS || 5));

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-codex-computer-benchmark-"));
const computerHome = path.join(temporary, "computer-home");
process.env.DT_GUI_COMPUTER_HOME = computerHome;

try {
  await execFileAsync("/usr/bin/open", ["-b", "com.apple.calculator"]);
  const runtime = await ComputerRuntime.create(computerHome);
  progress("computer persistent benchmark");
  const persistent = await runPersistentTrials(runtime);
  progress("computer CLI benchmark");
  const cli = await runCommandTrials("cli");
  progress("computer CLI action-and-observe benchmark");
  const cliCombined = await runCommandTrials("cli-combined", {}, computerCli, true);
  progress("computer MCP compatibility benchmark");
  const mcp = await runMcpTrials();
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      computerRuntimeVersion: RUNTIME_VERSION,
      trialCount: trials
    },
    methodology: {
      task: "Calculator: clear, enter 1+100, verify 101",
      persistentMode: "ComputerRuntime loaded once in the benchmark process",
      cliMode: "One production-style CLI process per atomic command",
      cliCombinedMode: "One CLI process performs each action and its post-action observation",
      mcpMode: "One persistent dt-gui-computer MCP daemon and macOS Provider; each compatible command performs an action and a differential post-action observation",
      timing: "Session initialization and task execution are measured separately; session stop is excluded"
    },
    computer: { persistent, cli, cliCombined, mcp: mcp.rows },
    summary: {
      computerPersistent: summarizeRows(persistent),
      computerCli: summarizeRows(cli),
      computerCliCombined: summarizeRows(cliCombined),
      computerMcp: {
        ...summarizeRows(mcp.rows),
        daemonStartupMs: mcp.daemonStartupMs
      }
    }
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, summary: result.summary })}\n`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

async function runPersistentTrials(runtime) {
  const results = [];
  for (let index = 0; index < trials; index += 1) {
    const initStarted = performance.now();
    const session = await runtime.startSession({
      providerId: "macos-accessibility",
      app: { kind: "bundle-id", value: "com.apple.calculator" },
      controlMode: "agent-control",
      approvalPolicy: "none",
      artifactRoot: path.join(temporary, "artifacts", "persistent", String(index + 1))
    });
    const initMs = rounded(performance.now() - initStarted);
    const taskStarted = performance.now();
    const metrics = await performCalculatorTask({
      observe: () => runtime.observe(session.sessionId, true),
      click: async (snapshot, element) => {
        await runtime.performAction(
          session.sessionId,
          snapshot.snapshotId,
          { kind: "click", elementId: element.elementId },
          undefined,
          "agent"
        );
        return undefined;
      }
    });
    const taskMs = rounded(performance.now() - taskStarted);
    if (index === trials - 1) await preserveEvidence(metrics.finalScreenshotPath);
    await runtime.stopSession(session.sessionId, "benchmark-complete");
    const { finalScreenshotPath: _finalScreenshotPath, ...recordedMetrics } = metrics;
    results.push({ trial: index + 1, success: true, initMs, taskMs, ...recordedMetrics });
  }
  return results;
}

async function runCommandTrials(
  mode,
  extraEnvironment = {},
  executable = computerCli,
  combinedObserve = false,
  differentialObserve = false
) {
  const results = [];
  const environment = {
    ...process.env,
    DT_GUI_COMPUTER_HOME: computerHome,
    DT_GUI_COMPUTER_NODE: process.execPath,
    DT_GUI_COMPUTER_PROVIDER_PERSISTENT: "0",
    ...extraEnvironment
  };
  for (let index = 0; index < trials; index += 1) {
    const initStarted = performance.now();
    const session = (await runCli([
      "session", "start",
      "--provider", "macos-accessibility",
      "--app-kind", "bundle-id",
      "--app", "com.apple.calculator",
      "--mode", "agent-control",
      "--approval-policy", "none",
      "--artifact-root", path.join(temporary, "artifacts", mode, String(index + 1)),
      "--json"
    ], environment, executable)).data;
    const initMs = rounded(performance.now() - initStarted);
    const taskStarted = performance.now();
    const metrics = await performCalculatorTask({
      observe: async () => (await runCli([
        "observe", "--session", session.sessionId, "--full", "--json"
      ], environment, executable)).data,
      click: async (snapshot, element) => {
        const response = await runCli([
          "click",
          "--session", session.sessionId,
          "--snapshot", snapshot.snapshotId,
          "--element", element.elementId,
          "--actor", "agent",
          ...(combinedObserve
            ? ["--observe", "--full", ...(differentialObserve ? ["--diff"] : [])]
            : []),
          "--json"
        ], environment, executable);
        return combinedObserve ? response.data.snapshot : undefined;
      }
    });
    const taskMs = rounded(performance.now() - taskStarted);
    await runCli([
      "session", "stop",
      "--session", session.sessionId,
      "--reason", "benchmark-complete",
      "--json"
    ], environment, executable);
    const { finalScreenshotPath: _finalScreenshotPath, ...recordedMetrics } = metrics;
    results.push({ trial: index + 1, success: true, initMs, taskMs, ...recordedMetrics });
  }
  return results;
}

async function runMcpTrials() {
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\uiwarden-mcp-benchmark-${process.pid}`
    : `/tmp/uiw-mcp-benchmark-${process.pid}.sock`;
  const startedAt = performance.now();
  const child = spawn(computerCli, [
    "--runtime-home", computerHome,
    "mcp", "--socket", socketPath
  ], {
    env: {
      ...process.env,
      DT_GUI_COMPUTER_HOME: computerHome,
      DT_GUI_COMPUTER_NODE: process.execPath,
      DT_GUI_COMPUTER_PROVIDER_PERSISTENT: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });
  try {
    await waitForSocket(socketPath, child, () => stderr);
    const daemonStartupMs = rounded(performance.now() - startedAt);
    const launcher = await writeMcpLauncher(socketPath);
    const rows = await runCommandTrials(
      "mcp",
      process.platform === "win32" ? { DT_GUI_COMPUTER_MCP_ENDPOINT: socketPath } : {},
      launcher,
      true,
      true
    );
    return { daemonStartupMs, rows };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (child.exitCode == null) child.kill("SIGKILL");
    if (process.platform !== "win32") await fs.rm(socketPath, { force: true });
  }
}

async function performCalculatorTask(executor) {
  const observationSizes = [];
  let observationCount = 0;
  let actionCount = 0;
  let snapshot = await executor.observe();
  observationCount += 1;
  observationSizes.push(observationSize(snapshot));
  for (const buttonName of ["全部清除", "1", "加", "1", "0", "0", "等于"]) {
    const postActionSnapshot = await executor.click(snapshot, findButton(snapshot, buttonName));
    actionCount += 1;
    const observed = postActionSnapshot || await executor.observe();
    observationCount += 1;
    observationSizes.push(observationSize(observed));
    snapshot = observed.diff === true ? mergeDiffSnapshot(snapshot, observed) : observed;
  }
  const visibleValues = snapshot.elements
    .filter((element) => element.role === "AXStaticText")
    .map((element) => normalizeAxText(element.value))
    .filter(Boolean);
  assert.ok(visibleValues.includes("101"), `Calculator result was not 101: ${visibleValues.join(", ")}`);
  return {
    actionCount,
    observationCount,
    finalObservationChars: observationSizes.at(-1),
    totalObservationChars: sum(observationSizes),
    finalScreenshotPath: snapshot.screenshotPath
  };
}

async function preserveEvidence(screenshotPath) {
  assert.ok(screenshotPath, "Calculator observation did not include a screenshot");
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.copyFile(screenshotPath, evidencePath);
}

async function runCli(args, environment, executable = computerCli) {
  let stdout = "";
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
      env: environment
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = String(error.stdout || "");
    if (!stdout.trim()) throw error;
  }
  const envelope = JSON.parse(stdout.trim());
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope;
}

async function writeMcpLauncher(socketPath) {
  if (process.platform === "win32") return computerCli;
  const launcher = path.join(temporary, "dt-gui-computer-mcp");
  await fs.writeFile(launcher, [
    "#!/bin/sh",
    "set -eu",
    `RESPONSE=$({ printf 'UIWARDEN_CLI_V1\\0'; printf '%s\\0' "$@"; printf '\\0'; } | /usr/bin/nc -U '${socketPath}')`,
    "printf '%s\\n' \"$RESPONSE\"",
    "case \"$RESPONSE\" in",
    "  '{\"ok\":true,'*) exit 0 ;;",
    "  *) exit 2 ;;",
    "esac",
    ""
  ].join("\n"), { mode: 0o700 });
  return launcher;
}

function findButton(snapshot, name) {
  const element = snapshot.elements.find((item) => item.role === "AXButton" && item.name === name);
  assert.ok(element, `Calculator button not found: ${name}`);
  return element;
}

function normalizeAxText(value) {
  return String(value || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
}

function observationSize(snapshot) {
  return JSON.stringify({
    text: snapshot.text,
    elements: snapshot.elements,
    removedElementIds: snapshot.removedElementIds
  }).length;
}

function mergeDiffSnapshot(previous, differential) {
  const elementsById = new Map(
    previous.elements.map((element) => [String(element.elementId), element])
  );
  for (const elementId of differential.removedElementIds || []) {
    elementsById.delete(String(elementId));
  }
  for (const element of differential.elements || []) {
    elementsById.set(String(element.elementId), element);
  }
  return {
    ...previous,
    ...differential,
    diff: false,
    elements: [...elementsById.values()],
    text: previous.text
  };
}

function summarizeRows(rows) {
  return {
    successRate: `${rows.filter((row) => row.success).length}/${rows.length}`,
    meanInitMs: mean(rows.map((row) => row.initMs)),
    meanTaskMs: mean(rows.map((row) => row.taskMs)),
    p95TaskMs: percentile(rows.map((row) => row.taskMs), 0.95),
    meanFinalObservationChars: mean(rows.map((row) => row.finalObservationChars)),
    meanTotalObservationChars: mean(rows.map((row) => row.totalObservationChars)),
    actionsPerTrial: rows[0]?.actionCount || 0,
    observationsPerTrial: rows[0]?.observationCount || 0
  };
}

function mean(values) {
  return rounded(sum(values) / values.length);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

function progress(message) {
  process.stderr.write(`[uiwarden-codex-computer-benchmark] ${message}\n`);
}

async function waitForSocket(socketPath, child, readStderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`MCP daemon exited before ready: ${readStderr()}`);
    }
    try {
      const stat = await fs.stat(socketPath);
      if (stat.isSocket()) return;
    } catch {
      // Endpoint is created asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`MCP daemon did not create socket: ${readStderr()}`);
}
