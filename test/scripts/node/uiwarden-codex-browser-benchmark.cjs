const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");
const { app, BrowserWindow } = require("electron");

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "../../..");
const browserCli = path.join(repoRoot, "browser-automation", "cli.mjs");
const fixturePath = path.join(repoRoot, "test", "fixtures", "browser", "codex-ui-complex-fixture.html");
const evidencePath = path.join(repoRoot, ".skill-output", "benchmarks", "uiwarden-browser-benchmark.png");
const outputPath = path.resolve(
  process.env.BENCHMARK_OUTPUT
    || path.join(repoRoot, ".skill-output", "benchmarks", "uiwarden-codex-browser.json")
);
const trials = Math.max(1, Number(process.env.BENCHMARK_TRIALS || 5));
const cdpPort = 46000 + Math.floor(Math.random() * 1000);

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-allow-origins", "*");

async function main() {
  await app.whenReady();
  progress("runtime ready");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-codex-benchmark-"));
  const browserHome = path.join(temporary, "browser-home");
  process.env.DT_GUI_BROWSER_HOME = browserHome;

  const benchmarkWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    webPreferences: { sandbox: true }
  });

  try {
    await benchmarkWindow.loadFile(fixturePath);
    const target = await waitForTarget(benchmarkWindow.webContents.getURL());
    progress("browser target ready");
    const browserRuntime = await import(pathToFileUrl(path.join(repoRoot, "browser-automation", "src", "runtime.mjs")));
    progress("browser persistent benchmark");
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        browserRuntimeVersion: browserRuntime.RUNTIME_VERSION,
        trialCount: trials
      },
      methodology: {
        fixture: path.relative(repoRoot, fixturePath),
        browserTask: "set query, select Browser, confirm, run, verify SUCCESS, scroll",
        persistentMode: "Runtime loaded once in the Electron benchmark process",
        cliMode: "One production-style CLI process per atomic command",
        timing: "Session initialization and task execution are measured separately; session stop is excluded"
      },
      browser: {
        persistent: await runBrowserTrials({
          mode: "persistent",
          target,
          benchmarkWindow,
          temporary,
          browserRuntime
        }),
        cli: undefined
      }
    };
    progress("browser CLI benchmark");
    result.browser.cli = await runBrowserTrials({
          mode: "cli",
          target,
          benchmarkWindow,
          temporary
        });
    result.summary = summarize(result);
    await writeResult(result);
  } finally {
    benchmarkWindow.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
    await app.quit();
  }
}

async function runBrowserTrials({ mode, target, benchmarkWindow, temporary, browserRuntime }) {
  const results = [];
  for (let index = 0; index < trials; index += 1) {
    await benchmarkWindow.loadFile(fixturePath);
    const artifactRoot = path.join(temporary, "browser-artifacts", mode, String(index + 1));
    const initStarted = performance.now();
    const session = mode === "persistent"
      ? await browserRuntime.startSession({
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        targetId: target.id,
        artifactRoot,
        runId: `browser-${mode}-${index + 1}`
      })
      : (await runBrowserCli([
        "session", "start",
        "--cdp-url", `http://127.0.0.1:${cdpPort}`,
        "--target", target.id,
        "--artifact-root", artifactRoot,
        "--run-id", `browser-${mode}-${index + 1}`,
        "--json"
      ])).data;
    const initMs = rounded(performance.now() - initStarted);
    const execute = mode === "persistent"
      ? createPersistentBrowserExecutor(browserRuntime, session.sessionId)
      : createCliBrowserExecutor(session.sessionId);
    const taskStarted = performance.now();
    const observationSizes = [];
    let actionCount = 0;
    let observationCount = 0;

    let snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    await execute.elementAction("set-value", snapshot, findBrowserElement(snapshot, "任务文本", "input"), "codex-ui-benchmark");
    actionCount += 1;

    snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    await execute.elementAction("select-option", snapshot, findBrowserElement(snapshot, "执行模式", "select"), "browser");
    actionCount += 1;

    snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    await execute.elementAction("click", snapshot, findBrowserElement(snapshot, "确认执行", "input"));
    actionCount += 1;

    snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    await execute.elementAction("click", snapshot, findBrowserElement(snapshot, "运行原子任务", "button"));
    actionCount += 1;

    snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    assert.match(snapshot.text, /SUCCESS:browser:codex-ui-benchmark/);
    const scrollResult = await execute.scroll();
    actionCount += 1;
    const scrollY = Number(scrollResult?.result?.scrollY ?? scrollResult?.scrollY ?? 0);
    assert.ok(scrollY > 0, `Browser page did not scroll: ${scrollY}`);

    snapshot = await execute.observe();
    observationCount += 1;
    observationSizes.push(observationSize(snapshot));
    assert.match(snapshot.text, /滚动目标已到达/);
    const taskMs = rounded(performance.now() - taskStarted);
    if (mode === "persistent" && index === trials - 1) {
      await fs.mkdir(path.dirname(evidencePath), { recursive: true });
      await fs.copyFile(snapshot.screenshotPath, evidencePath);
    }
    await execute.stop();
    results.push({
      trial: index + 1,
      success: true,
      initMs,
      taskMs,
      actionCount,
      observationCount,
      finalObservationChars: observationSizes.at(-1),
      totalObservationChars: sum(observationSizes),
      scrollY
    });
  }
  return results;
}

function createPersistentBrowserExecutor(runtime, sessionId) {
  return {
    observe: () => runtime.observe(sessionId),
    elementAction: (kind, snapshot, element, value) => runtime.performElementAction(sessionId, {
      kind,
      snapshotId: snapshot.snapshotId,
      elementId: element.elementId,
      value
    }),
    scroll: () => runtime.scroll(sessionId, { direction: "down", pages: 1 }),
    stop: () => runtime.stopSession(sessionId, "benchmark-complete")
  };
}

function createCliBrowserExecutor(sessionId) {
  return {
    observe: async () => (await runBrowserCli(["observe", "--session", sessionId, "--json"])).data,
    elementAction: async (kind, snapshot, element, value) => {
      const args = [
        kind, "--session", sessionId, "--snapshot", snapshot.snapshotId,
        "--element", element.elementId
      ];
      if (value != null) args.push("--value", value);
      args.push("--json");
      return (await runBrowserCli(args)).data;
    },
    scroll: async () => (await runBrowserCli([
      "scroll", "--session", sessionId, "--direction", "down", "--pages", "1", "--json"
    ])).data,
    stop: () => runBrowserCli([
      "session", "stop", "--session", sessionId, "--reason", "benchmark-complete", "--json"
    ])
  };
}

function findBrowserElement(snapshot, name, tag) {
  const element = snapshot.elements.find((item) => item.tag === tag && String(item.name || "").includes(name));
  assert.ok(element, `Browser element not found: ${name} (${tag})`);
  return element;
}

function observationSize(snapshot) {
  return JSON.stringify({ text: snapshot.text, elements: snapshot.elements }).length;
}

async function runBrowserCli(args) {
  return runJsonCommand(process.execPath, [browserCli, ...args], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1"
  });
}

async function runJsonCommand(command, args, environment) {
  let stdout = "";
  try {
    const result = await execFileAsync(command, args, {
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

async function waitForTarget(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.url === url);
        if (target?.id) return target;
      }
    } catch {
      // Chromium remote debugging is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Benchmark target was not available: ${url}`);
}

function summarize(result) {
  const entries = {
    browserPersistent: result.browser.persistent,
    browserCli: result.browser.cli
  };
  return Object.fromEntries(Object.entries(entries).filter(([, rows]) => Array.isArray(rows)).map(([name, rows]) => [name, {
    successRate: `${rows.filter((row) => row.success).length}/${rows.length}`,
    meanInitMs: mean(rows.map((row) => row.initMs)),
    meanTaskMs: mean(rows.map((row) => row.taskMs)),
    p95TaskMs: percentile(rows.map((row) => row.taskMs), 0.95),
    meanFinalObservationChars: mean(rows.map((row) => row.finalObservationChars)),
    meanTotalObservationChars: mean(rows.map((row) => row.totalObservationChars)),
    actionsPerTrial: rows[0]?.actionCount || 0,
    observationsPerTrial: rows[0]?.observationCount || 0
  }]));
}

async function writeResult(result) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  progress(`result written: ${outputPath}`);
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, summary: result.summary })}\n`);
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

function pathToFileUrl(filePath) {
  return `file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function progress(message) {
  process.stderr.write(`[uiwarden-codex-benchmark] ${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  app.exit(1);
});
