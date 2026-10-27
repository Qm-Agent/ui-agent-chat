#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), "..");
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

export function parseDotEnvKeys(source) {
  const keys = [];
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

export function describeEnvKey(key) {
  return { key, sensitive: SECRET_KEY_PATTERN.test(key) };
}

async function isExecutable(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(names, env = process.env) {
  const explicit = String(env.UI_AGENT_AIWORK_BIN || env.UI_AGENT_DTCODER_BIN || "").trim();
  if (explicit) {
    const candidate = path.resolve(explicit);
    return (await isExecutable(candidate)) ? candidate : null;
  }

  const pathEntries = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathEntries) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(directory, `${name}${suffix}`);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function dtcoderStandardCandidates(
  home = os.homedir(),
  platform = process.platform,
  env = process.env
) {
  const executable = (command) => platform === "win32" ? `${command}.exe` : command;
  const commands = ["aiwork", "aiworkcn", "aiworkcli"].map(executable);
  const candidates = commands.flatMap((command) => [
    path.join(home, ".agentix", "bin", command),
    path.join(home, ".local", "bin", command)
  ]);
  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(home, "Library", "Application Support", "Agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(home, "Library", "Application Support", "Agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(home, "Library", "Application Support", "Agentix", "program", "bin", command)),
      path.join(home, "Library", "Application Support", "AiWorkCN", "program", "bin", executable("aiworkcn"))
    );
  } else if (platform === "linux") {
    const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    candidates.push(
      path.join(dataHome, "agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(dataHome, "agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(dataHome, "agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(dataHome, "agentix", "program", "bin", command))
    );
  } else if (platform === "win32" && env.LOCALAPPDATA) {
    candidates.push(
      path.join(env.LOCALAPPDATA, "Agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(env.LOCALAPPDATA, "Agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(env.LOCALAPPDATA, "Agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(env.LOCALAPPDATA, "Agentix", "program", "bin", command))
    );
  }
  return [...new Set(candidates)];
}

export async function findDtcoderExecutable(env = process.env) {
  const fromPath = await findExecutable(["aiwork", "aiworkcn", "aiworkcli", "dtcoder"], env);
  if (fromPath || String(env.UI_AGENT_AIWORK_BIN || env.UI_AGENT_DTCODER_BIN || "").trim()) return fromPath;
  for (const candidate of dtcoderStandardCandidates(os.homedir(), process.platform, env)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: process.env
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
  return {
    ok: result.status === 0,
    version: output,
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

async function fileExists(relativePath) {
  try {
    await fs.access(path.join(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function collectDoctorReport() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const npm = commandVersion(process.platform === "win32" ? "npm.cmd" : "npm");
  const npmMajor = Number.parseInt(String(npm.version || "").split(".")[0], 10);
  const envPath = path.join(projectRoot, ".env");
  let envKeys = [];
  let envFileExists = false;
  try {
    envKeys = parseDotEnvKeys(await fs.readFile(envPath, "utf8"));
    envFileExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const runtimePath = await findDtcoderExecutable();
  const runtime = runtimePath ? commandVersion(runtimePath) : null;
  const nodeModules = await fileExists("node_modules/.package-lock.json");
  const serverBuild = await fileExists("dist/server/index.js");
  const clientBuild = await fileExists("dist/client/index.html");

  const checks = [
    { id: "node", level: nodeMajor === 22 ? "ok" : "error", message: `Node.js ${process.versions.node}; required major is 22` },
    { id: "npm", level: npm.ok && npmMajor >= 10 ? "ok" : "error", message: npm.version ? `npm ${npm.version}; required major is >= 10` : "npm is not available" },
    { id: "dependencies", level: nodeModules ? "ok" : "error", message: nodeModules ? "npm dependencies are installed" : "node_modules is missing; run npm ci explicitly" },
    { id: "env", level: envFileExists ? "ok" : "warning", message: envFileExists ? `.env exists with ${envKeys.length} configured key(s); values were not read into the report` : ".env is absent; copy .env.example manually if configuration is required" },
    { id: "build", level: serverBuild && clientBuild ? "ok" : "warning", message: serverBuild && clientBuild ? "server and client build outputs exist" : "build outputs are incomplete; production start requires npm run build" },
    { id: "runtime", level: runtime?.ok ? "ok" : "warning", message: runtimePath ? `${path.basename(runtimePath)} detected${runtime?.version ? `: ${runtime.version}` : ""}` : "AiWork CLI was not detected; install external aiworkcn or provide an internal/global AiWork runtime before running Agent tasks" }
  ];

  return {
    ok: !checks.some((check) => check.level === "error"),
    projectRoot,
    checks,
    env: {
      exists: envFileExists,
      keys: envKeys.map(describeEnvKey)
    },
    runtime: runtimePath ? { path: runtimePath, ...runtime } : null,
    build: { server: serverBuild, client: clientBuild }
  };
}

function printReport(report) {
  const marker = { ok: "PASS", warning: "WARN", error: "FAIL" };
  console.log("UIWarden local preflight");
  for (const check of report.checks) {
    console.log(`[${marker[check.level]}] ${check.message}`);
  }
  if (report.env.keys.length > 0) {
    const names = report.env.keys.map(({ key, sensitive }) => `${key}${sensitive ? " (sensitive)" : ""}`);
    console.log(`[INFO] .env keys only: ${names.join(", ")}`);
  }
  console.log("[INFO] Runtime authentication and model availability must be verified in Configuration Center.");
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function waitForHealth(url, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`UIWarden exited before health check (exit ${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Server and Vite may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function start(mode) {
  const report = await collectDoctorReport();
  printReport(report);
  if (!report.ok) process.exit(1);
  if (mode === "production" && (!report.build.server || !report.build.client)) {
    console.error("[FAIL] Production build is missing. Run npm run build explicitly.");
    process.exit(1);
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", mode === "production" ? "start" : "dev"], {
    cwd: projectRoot,
    env: { ...process.env, HOST: process.env.HOST || "127.0.0.1" },
    stdio: "inherit"
  });
  const relay = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => relay("SIGINT"));
  process.once("SIGTERM", () => relay("SIGTERM"));

  try {
    const port = process.env.PORT || "8787";
    const healthUrl = process.env.UIWARDEN_HEALTH_URL || `http://127.0.0.1:${port}/api/health`;
    await waitForHealth(healthUrl, child);
    console.log(`[READY] API health check passed: ${healthUrl}`);
    console.log(`[READY] ${mode === "production" ? `UI: http://127.0.0.1:${port}` : "UI: http://127.0.0.1:5174"}`);
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    relay("SIGTERM");
    process.exitCode = 1;
  }

  const exitCode = child.exitCode ?? await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  if (process.exitCode == null) process.exitCode = exitCode || 0;
}

function usage() {
  console.log("Usage: node scripts/open-source-local.mjs <doctor|start> [--json] [--production] [--install] [--build]");
  console.log("  doctor              Check prerequisites without changing local state");
  console.log("  start               Start in the foreground and wait for /api/health");
  console.log("  --install           Explicitly run npm ci before doctor/start");
  console.log("  --build             Explicitly run npm run build before doctor/start");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--")) || "doctor";
  if (!["doctor", "start"].includes(command) || args.includes("--help")) {
    usage();
    process.exit(command === "doctor" ? 0 : 2);
  }
  if (args.includes("--install")) runChecked(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"]);
  if (args.includes("--build")) runChecked(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);

  if (command === "doctor") {
    const report = await collectDoctorReport();
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  await start(args.includes("--production") ? "production" : "development");
}

if (path.resolve(process.argv[1] || "") === scriptFile) {
  await main();
}
