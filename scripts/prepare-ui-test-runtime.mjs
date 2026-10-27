#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repoRoot, "desktop", "runtime", "ui-test-runtime");
const cacheRoot = path.join(repoRoot, ".cache", "ui-test-runtime");
const browserUseWheel = path.join(repoRoot, "vendor", "browser-use", "browser_use-3.1.6-py3-none-any.whl");
const constraintsPath = path.join(repoRoot, "vendor", "ui-test-runtime", "constraints.txt");
const manifestPath = path.join(outputRoot, "runtime-manifest.json");
const schemaVersion = "uiwarden-ui-test-runtime/v1";
const builderRevision = 5;
const pythonVersion = "3.11.17";
const pythonBuild = "20261013";
const browserUseVersion = "3.1.6";
const playwrightVersion = "1.58.0";
const pipSocksBootstrap = {
  file: "PySocks-1.7.1-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/8d/59/b4572118e098ac8e46e399a1dd0f2d85403ce8bbaad9ec79373ed6badaf9/PySocks-1.7.1-py3-none-any.whl",
  sha256: "2725bd0a9925919b9b51739eea5f9e2bae91e83288108a9ad338b2e3a4435ee5"
};

const pythonDistributions = {
  "darwin-arm64": {
    file: `cpython-${pythonVersion}+${pythonBuild}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: "5e656e09fc73c7ae10e4df66e6aa253f1f5980509b3be8a242e883d67a5fdf26"
  },
  "darwin-x64": {
    file: `cpython-${pythonVersion}+${pythonBuild}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: "a870f5bb476ebe4483761ffdcd39b316dbef9f59f158706296d2c6f138057cae"
  },
  "win32-x64": {
    file: `cpython-${pythonVersion}+${pythonBuild}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
    sha256: "54a38c5e7cc1a5fd2b0182b495f29606dc1455d18ebfd3b5bf0a3c09253b5031"
  }
};

function valueFor(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const platform = valueFor("platform", process.platform);
const arch = valueFor("arch", process.arch);
const force = process.argv.includes("--force");
const targetKey = `${platform}-${arch}`;
const distribution = pythonDistributions[targetKey];

if (!distribution) {
  console.error(`[ui-test-runtime] unsupported target: ${targetKey}`);
  process.exit(1);
}
if (platform !== process.platform || arch !== process.arch) {
  console.error(
    `[ui-test-runtime] ${targetKey} must be built on the matching host; current host is ${process.platform}-${process.arch}`
  );
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pythonExecutable(root = outputRoot) {
  return platform === "win32"
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", "python3");
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout || 30 * 60_000
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${file} ${args.join(" ")} failed (${result.status ?? "spawn"})\n${detail}`);
  }
  return String(result.stdout || "").trim();
}

function readReusableManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const browserDirectory = path.join(outputRoot, "ms-playwright");
    if (
      manifest.schemaVersion === schemaVersion
      && manifest.builderRevision === builderRevision
      && manifest.platform === platform
      && manifest.arch === arch
      && manifest.pythonVersion === pythonVersion
      && manifest.browserUseVersion === browserUseVersion
      && manifest.playwrightVersion === playwrightVersion
      && manifest.browserUseWheelSha256 === sha256File(browserUseWheel)
      && manifest.constraintsSha256 === sha256File(constraintsPath)
      && fs.existsSync(pythonExecutable())
      && fs.existsSync(browserDirectory)
      && fs.readdirSync(browserDirectory).some((name) => name.startsWith("chromium-"))
      && fs.readdirSync(browserDirectory).some((name) => name.startsWith("firefox-"))
    ) return manifest;
  } catch {
    // A partial or stale Runtime is rebuilt below.
  }
  return null;
}

function download(url, destination) {
  const partial = `${destination}.partial`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const curl = platform === "win32" ? "curl.exe" : "curl";
  run(curl, [
    "--fail", "--location", "--show-error", "--retry", "8", "--retry-all-errors",
    "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "120",
    "--continue-at", "-", "--output", partial, url
  ], { timeout: 45 * 60_000 });
  fs.renameSync(partial, destination);
}

function defaultPlaywrightCache() {
  if (process.env.UIWARDEN_PLAYWRIGHT_BUILD_CACHE) return process.env.UIWARDEN_PLAYWRIGHT_BUILD_CACHE;
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "ms-playwright");
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

function seedCompatibleBrowserCache(destination) {
  const source = defaultPlaywrightCache();
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of ["chromium-1208", "chromium_headless_shell-1208", "ffmpeg-1011"]) {
    const sourceEntry = path.join(source, entry);
    const destinationEntry = path.join(destination, entry);
    if (fs.existsSync(sourceEntry) && !fs.existsSync(destinationEntry)) {
      console.log(`[ui-test-runtime] seeding compatible Playwright cache entry: ${entry}`);
      fs.cpSync(sourceEntry, destinationEntry, { recursive: true, verbatimSymlinks: true });
    }
  }
}

async function main() {
  if (!fs.existsSync(browserUseWheel) || !fs.existsSync(constraintsPath)) {
    throw new Error("browser-use wheel or Runtime constraints are missing");
  }
  if (!force && readReusableManifest()) {
    console.log(`[ui-test-runtime] reusable ${targetKey} Runtime is ready: ${outputRoot}`);
    return;
  }

  const archive = path.join(cacheRoot, distribution.file);
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonBuild}/${encodeURIComponent(distribution.file)}`;
  if (!fs.existsSync(archive) || sha256File(archive) !== distribution.sha256) {
    console.log(`[ui-test-runtime] downloading CPython ${pythonVersion} for ${targetKey}`);
    let lastDownloadError;
    for (let attempt = 1; attempt <= 5 && !fs.existsSync(archive); attempt += 1) {
      try {
        download(url, archive);
      } catch (error) {
        lastDownloadError = error;
        console.warn(`[ui-test-runtime] download attempt ${attempt}/5 failed; the next attempt will resume: ${String(error)}`);
      }
    }
    if (!fs.existsSync(archive)) throw lastDownloadError || new Error("CPython download did not complete");
  }
  const actualArchiveSha = sha256File(archive);
  if (actualArchiveSha !== distribution.sha256) {
    throw new Error(`CPython archive SHA-256 mismatch: ${actualArchiveSha}`);
  }

  const socksWheel = path.join(cacheRoot, pipSocksBootstrap.file);
  if (!fs.existsSync(socksWheel) || sha256File(socksWheel) !== pipSocksBootstrap.sha256) {
    console.log("[ui-test-runtime] downloading pinned pip SOCKS bootstrap wheel");
    download(pipSocksBootstrap.url, socksWheel);
  }
  const actualSocksSha = sha256File(socksWheel);
  if (actualSocksSha !== pipSocksBootstrap.sha256) {
    throw new Error(`PySocks bootstrap wheel SHA-256 mismatch: ${actualSocksSha}`);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-ui-test-runtime-"));
  const stagedRoot = path.join(staging, "ui-test-runtime");
  fs.mkdirSync(stagedRoot, { recursive: true });
  try {
    run("tar", ["-xzf", archive, "-C", stagedRoot]);
    const python = pythonExecutable(stagedRoot);
    if (!fs.existsSync(python)) throw new Error(`portable Python executable is missing: ${python}`);
    if (platform !== "win32") fs.chmodSync(python, 0o755);

    // A pristine Python cannot use a SOCKS-configured build proxy until this
    // tiny, hash-pinned bootstrap wheel is installed locally.
    run(python, [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-deps", socksWheel
    ]);
    const pipNoProxy = [
      process.env.NO_PROXY,
      process.env.no_proxy,
      "pypi.org",
      "files.pythonhosted.org"
    ].filter(Boolean).join(",");
    const pipEnv = { NO_PROXY: pipNoProxy, no_proxy: pipNoProxy };
    run(python, [
      "-m", "pip", "install", "--disable-pip-version-check",
      "--constraint", constraintsPath, browserUseWheel
    ], { env: pipEnv });
    run(python, [path.join(repoRoot, "scripts", "patch-browser-use.py")], { env: pipEnv });
    run(python, ["-m", "pip", "check"], { env: pipEnv });

    const browsersPath = path.join(stagedRoot, "ms-playwright");
    seedCompatibleBrowserCache(browsersPath);
    const browserNoProxy = [
      process.env.NO_PROXY,
      process.env.no_proxy,
      "cdn.playwright.dev",
      "storage.googleapis.com",
      "playwright.download.prss.microsoft.com"
    ].filter(Boolean).join(",");
    const runtimeEnv = {
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      NO_PROXY: browserNoProxy,
      no_proxy: browserNoProxy
    };
    run(python, ["-m", "playwright", "install", "chromium", "firefox"], { env: runtimeEnv });

    const probe = [
      "from importlib.metadata import version",
      "from playwright.sync_api import sync_playwright",
      `assert version('browser-use') == '${browserUseVersion}'`,
      `assert version('playwright') == '${playwrightVersion}'`,
      "with sync_playwright() as p:",
      "    browser = p.chromium.launch(headless=True)",
      "    page = browser.new_page()",
      "    page.set_content('<title>UIWarden Runtime</title>')",
      "    assert page.title() == 'UIWarden Runtime'",
      "    browser.close()",
      "    firefox = p.firefox.launch(headless=True)",
      "    firefox.close()",
      "print('UIWarden UI test Runtime OK')"
    ].join("\n");
    run(python, ["-c", probe], { env: runtimeEnv });

    const packages = JSON.parse(run(python, ["-m", "pip", "list", "--format=json"], { capture: true }))
      .map((entry) => `${entry.name}==${entry.version}`)
      .sort((left, right) => left.localeCompare(right));
    const browserEntries = fs.readdirSync(browsersPath).sort();
    const createdAt = process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString();
    const manifest = {
      schemaVersion,
      builderRevision,
      createdAt,
      platform,
      arch,
      pythonVersion,
      pythonBuild,
      pythonArchive: distribution.file,
      pythonArchiveSha256: distribution.sha256,
      pipSocksBootstrapSha256: pipSocksBootstrap.sha256,
      browserUseVersion,
      browserUseWheelSha256: sha256File(browserUseWheel),
      constraintsSha256: sha256File(constraintsPath),
      playwrightVersion,
      browsers: browserEntries,
      packages,
      runtimeNetworkRequired: false
    };
    fs.writeFileSync(path.join(stagedRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(stagedRoot, "README.txt"), [
      "UIWarden bundled UI test Runtime",
      "",
      "This directory contains a platform-specific CPython Runtime, the reviewed browser-use 3.1.6 SDK and its locked dependencies, and Playwright Chromium and Firefox.",
      "It is assembled at build time and does not download Python packages or browser binaries when UIWarden runs.",
      "Package license metadata remains available in Python site-packages; Chromium notices remain inside the browser distribution."
    ].join("\n"));

    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
    fs.renameSync(stagedRoot, outputRoot);
    console.log(`[ui-test-runtime] ready: ${outputRoot}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[ui-test-runtime] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
