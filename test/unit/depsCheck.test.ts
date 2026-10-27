import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aiworkDistributionForExecutable,
  dtcoderInstallCandidates,
  mergeExecutablePaths,
  resolveBrowserUseWheel,
  resolveBundledUiTestRuntime,
  resolveDtcoderExecutable
} from "../../server/src/depsCheck.js";
import { getExecutionRuntimeDefinition, resolveExecutionRuntimeExecutable } from "../../server/src/executionRuntime.js";

test("依赖 PATH 合并保留 GUI 与登录 Shell 目录并去重", () => {
  const first = ["/app/bin", "/usr/bin"].join(path.delimiter);
  const second = ["/opt/homebrew/bin", "/usr/bin", "/user/nvm/bin"].join(path.delimiter);
  assert.equal(
    mergeExecutablePaths(first, second),
    ["/app/bin", "/usr/bin", "/opt/homebrew/bin", "/user/nvm/bin"].join(path.delimiter)
  );
});

test("bundled UI test Runtime requires a matching manifest, Python, Chromium and Firefox", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-ui-test-runtime-"));
  const runtime = path.join(root, "ui-test-runtime");
  try {
    const python = path.join(runtime, "python", process.platform === "win32" ? "python.exe" : path.join("bin", "python3"));
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "fixture");
    fs.mkdirSync(path.join(runtime, "ms-playwright", "chromium-1234"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "ms-playwright", "firefox-1234"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), JSON.stringify({
      schemaVersion: "uiwarden-ui-test-runtime/v1",
      builderRevision: 5,
      platform: process.platform,
      arch: process.arch,
      pythonVersion: "3.11.17",
      browserUseVersion: "3.1.6",
      playwrightVersion: "1.58.0"
    }));
    assert.equal(resolveBundledUiTestRuntime({}, root)?.pythonPath, python);
    fs.rmSync(path.join(runtime, "ms-playwright", "firefox-1234"), { recursive: true, force: true });
    assert.equal(resolveBundledUiTestRuntime({}, root), undefined);
    fs.mkdirSync(path.join(runtime, "ms-playwright", "firefox-1234"), { recursive: true });
    fs.rmSync(path.join(runtime, "ms-playwright"), { recursive: true, force: true });
    assert.equal(resolveBundledUiTestRuntime({}, root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DTCoder explicit executable is preferred and invalid overrides do not fall back", () => {
  const previousAiwork = process.env.UI_AGENT_AIWORK_BIN;
  const previous = process.env.UI_AGENT_DTCODER_BIN;
  try {
    process.env.UI_AGENT_AIWORK_BIN = process.execPath;
    process.env.UI_AGENT_DTCODER_BIN = "/nonexistent/legacy-dtcoder";
    assert.equal(resolveExecutionRuntimeExecutable("dtcoder"), process.execPath);
    delete process.env.UI_AGENT_AIWORK_BIN;
    process.env.UI_AGENT_DTCODER_BIN = process.execPath;
    assert.equal(resolveExecutionRuntimeExecutable("dtcoder"), process.execPath);
    process.env.UI_AGENT_DTCODER_BIN = "/nonexistent/dtcoder";
    assert.equal(resolveExecutionRuntimeExecutable("dtcoder"), undefined);
  } finally {
    if (previousAiwork === undefined) delete process.env.UI_AGENT_AIWORK_BIN;
    else process.env.UI_AGENT_AIWORK_BIN = previousAiwork;
    if (previous === undefined) delete process.env.UI_AGENT_DTCODER_BIN;
    else process.env.UI_AGENT_DTCODER_BIN = previous;
  }
});

test("AiWork discovery includes current internal, external and global Agentix directories", () => {
  const candidates = dtcoderInstallCandidates("/Users/example", "darwin", {});
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiwork"));
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiworkcn"));
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiworkcli"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/internal/current/bin/aiwork"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/external/current/bin/aiworkcn"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/global/current/bin/aiworkcli"));
});

test("AiWork discovery resolves an executable from the current internal program directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-aiwork-home-"));
  const executable = path.join(home, "Library", "Application Support", "Agentix", "program", "internal", "current", "bin", "aiwork");
  try {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveDtcoderExecutable({
      env: {},
      home,
      platform: "darwin",
      pathLookup: () => null
    }), executable);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AiWork PATH discovery prefers internal, then external, global and legacy commands", () => {
  const lookups: string[] = [];
  const resolved = resolveDtcoderExecutable({
    env: {},
    pathLookup: (command) => {
      lookups.push(command);
      return command === "aiworkcn" ? "/runtime/aiworkcn" : null;
    }
  });
  assert.equal(resolved, "/runtime/aiworkcn");
  assert.deepEqual(lookups, ["aiwork", "aiworkcn"]);
});

test("AiWork executable names map to their distribution", () => {
  assert.equal(aiworkDistributionForExecutable("/opt/bin/aiwork"), "internal");
  assert.equal(aiworkDistributionForExecutable("/opt/bin/aiworkcn"), "external");
  assert.equal(aiworkDistributionForExecutable("C:\\Agentix\\aiworkcli.exe"), "global");
  assert.equal(aiworkDistributionForExecutable("/opt/bin/dtcoder"), undefined);
});

test("unknown execution runtime definitions fall back to DTCoder instead of CFuse", () => {
  assert.equal(getExecutionRuntimeDefinition("invalid-runtime" as never).id, "dtcoder");
});

test("browser-use SDK resolves only one bundled 3.1.6 wheel", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-browser-use-wheel-"));
  try {
    const directory = path.join(root, "vendor", "browser-use");
    fs.mkdirSync(directory, { recursive: true });
    const wheel = path.join(directory, "browser_use-3.1.6-py3-none-any.whl");
    fs.writeFileSync(wheel, "fixture");
    assert.equal(resolveBrowserUseWheel({}, root), wheel);
    fs.writeFileSync(path.join(directory, "browser_use-3.1.6-extra.whl"), "fixture");
    assert.equal(resolveBrowserUseWheel({}, root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser-use SDK rejects missing or incorrectly named explicit wheels", () => {
  assert.equal(resolveBrowserUseWheel({ UIWARDEN_BROWSER_USE_WHEEL: "/missing/browser_use-3.1.6.whl" }), undefined);
  assert.equal(resolveBrowserUseWheel({ UIWARDEN_BROWSER_USE_WHEEL: process.execPath }), undefined);
});
