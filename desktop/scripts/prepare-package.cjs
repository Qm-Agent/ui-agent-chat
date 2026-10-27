// 打包前检查：pack 脚本已先重建产物，此处验证运行时与协议完整性。
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stagePackageResources } = require("./stage-package-resources.cjs");

function stripControlSequences(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

function linkDirectoryWithoutNestedModules(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".cache") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      linkDirectoryWithoutNestedModules(from, to);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.linkSync(from, to);
    }
  }
}

function stageProductionNodeModules(repoRoot) {
  const outputRoot = path.join(repoRoot, "desktop", "runtime", "server-node-modules");
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const listed = spawnSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  if (listed.status !== 0) {
    throw new Error(`无法解析生产依赖树：${listed.stderr || listed.stdout || "npm ls failed"}`);
  }
  const sourceRoot = path.join(repoRoot, "node_modules");
  const packageDirectories = String(listed.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && path.resolve(value) !== path.resolve(repoRoot));
  for (const source of packageDirectories) {
    const relative = path.relative(sourceRoot, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`生产依赖位于 node_modules 之外：${source}`);
    }
    linkDirectoryWithoutNestedModules(source, path.join(outputRoot, relative));
  }
  return { outputRoot, packageCount: packageDirectories.length };
}

function nodeRuntimeCandidates(repoRoot) {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    process.env.UIWARDEN_BUNDLED_NODE_PATH,
    process.execPath,
  ];
  const pathLookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    process.platform === "win32" ? [executableName] : ["-a", executableName],
    { encoding: "utf8" }
  );
  candidates.push(...String(pathLookup.stdout || "").split(/\r?\n/));
  if (process.platform !== "win32") {
    const nvmVersions = path.join(os.homedir(), ".nvm", "versions", "node");
    if (fs.existsSync(nvmVersions)) {
      for (const version of fs.readdirSync(nvmVersions).sort().reverse()) {
        candidates.push(path.join(nvmVersions, version, "bin", executableName));
      }
    }
  }
  const bundledPath = path.join(repoRoot, "desktop", "runtime", executableName);
  return [...new Set(candidates
    .map((candidate) => String(candidate || "").trim())
    .filter((candidate) => candidate && path.resolve(candidate) !== path.resolve(bundledPath))
    .filter((candidate) => fs.existsSync(candidate)))];
}

function inspectPortableNodeRuntime(candidate, repoRoot) {
  const nativeModuleProbe = `
    const Database = require(${JSON.stringify(path.join(repoRoot, "node_modules", "better-sqlite3"))});
    const database = new Database(":memory:");
    database.close();
    process.stdout.write(JSON.stringify({
      version: process.version,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath
    }));
  `;
  const inspected = spawnSync(candidate, ["-e", nativeModuleProbe], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (inspected.status !== 0) {
    return { ok: false, reason: stripControlSequences(inspected.stderr || inspected.stdout || "原生模块加载失败") };
  }
  let metadata;
  try {
    metadata = JSON.parse(inspected.stdout);
  } catch {
    return { ok: false, reason: "无法读取 Node Runtime 元数据" };
  }
  if (metadata.platform !== process.platform || metadata.arch !== process.arch) {
    return {
      ok: false,
      reason: `平台或架构不匹配：${metadata.platform}/${metadata.arch} != ${process.platform}/${process.arch}`,
    };
  }
  if (process.platform === "darwin") {
    const linked = spawnSync("otool", ["-L", candidate], { encoding: "utf8" });
    if (linked.status !== 0) return { ok: false, reason: "无法读取 Node 动态库依赖" };
    const externalDependencies = String(linked.stdout || "")
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/)[0])
      .filter(Boolean)
      .filter((dependency) =>
        dependency.startsWith("@rpath/")
        || dependency.startsWith("@loader_path/")
        || (!dependency.startsWith("/usr/lib/")
          && !dependency.startsWith("/System/Library/"))
      );
    if (externalDependencies.length > 0) {
      return {
        ok: false,
        reason: `依赖外部动态库：${externalDependencies.slice(0, 3).join(", ")}`,
      };
    }
  }
  return { ok: true, metadata };
}

function resolvePortableNodeRuntime(repoRoot) {
  const failures = [];
  for (const candidate of nodeRuntimeCandidates(repoRoot)) {
    const inspected = inspectPortableNodeRuntime(candidate, repoRoot);
    if (inspected.ok) return { path: candidate, metadata: inspected.metadata };
    failures.push(`  - ${candidate}: ${inspected.reason}`);
  }
  console.error(
    "[desktop] 未找到可独立分发且兼容 better-sqlite3 的 Node Runtime。\n"
    + "请安装与当前原生模块 ABI 匹配的官方 Node，或通过 UIWARDEN_BUNDLED_NODE_PATH 指定。\n"
    + failures.join("\n")
  );
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, "../..");
const browserUseWheel = path.join(repoRoot, "vendor", "browser-use", "browser_use-3.1.6-py3-none-any.whl");
const browserUseWheelSha256 = "4cf70be8ed5a833b803d8417af5a3185b97accd437122206a82c0cd969452e4b";
const uiTestRuntimeRoot = path.join(repoRoot, "desktop", "runtime", "ui-test-runtime");
const uiTestRuntimeManifest = path.join(uiTestRuntimeRoot, "runtime-manifest.json");
const uiTestRuntimePython = path.join(
  uiTestRuntimeRoot,
  "python",
  process.platform === "win32" ? "python.exe" : path.join("bin", "python3")
);
const required = [
  path.join(repoRoot, "dist", "server", "index.js"),
  path.join(repoRoot, "dist", "client", "index.html"),
  path.join(repoRoot, "browser-automation", "cli.mjs"),
  path.join(repoRoot, "browser-automation", "shared-runtime", "index.js"),
  path.join(repoRoot, "browser-automation", "bin", process.platform === "win32" ? "dt-gui-browser.cmd" : "dt-gui-browser"),
  path.join(repoRoot, "native-automation", "dist", "cli.js"),
  path.join(repoRoot, "native-automation", "shared-runtime", "index.js"),
  path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer"),
  path.join(repoRoot, "skills", "dt-gui-browser-skill", "SKILL.md"),
  path.join(repoRoot, "desktop", "application-menu.cjs"),
  path.join(repoRoot, "desktop", "embedded-browser-url.cjs"),
  path.join(repoRoot, "desktop", "window-lifecycle.cjs"),
  path.join(repoRoot, "desktop", "picture-in-picture.cjs"),
  path.join(repoRoot, "desktop", "pip-preload.cjs"),
  path.join(repoRoot, "desktop", "pip-renderer.js"),
  path.join(repoRoot, "desktop", "pip.html"),
  path.join(repoRoot, "browser-task-group-extension", "manifest.json"),
  path.join(repoRoot, "browser-task-group-extension", "control.js"),
  path.join(repoRoot, "browser-task-group-extension", "background.js"),
  path.join(repoRoot, "test", "fixtures", "browser", "codex-ui-complex-fixture.html"),
  path.join(repoRoot, "test", "fixtures", "browser", "codex-ui-complex-frame.html"),
  path.join(repoRoot, "test", "fixtures", "browser", "codex-ui-benchmark-download.txt"),
  browserUseWheel,
  uiTestRuntimeManifest,
  uiTestRuntimePython,
];

const missing = required.filter((p) => !fs.existsSync(p));
if (missing.length > 0) {
  console.error("[desktop] 缺少构建产物，请先在仓库根目录执行 npm run build：");
  for (const p of missing) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("[desktop] 构建产物检查通过。");

const actualBrowserUseWheelSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(browserUseWheel))
  .digest("hex");
if (actualBrowserUseWheelSha256 !== browserUseWheelSha256) {
  console.error(`[desktop] browser-use SDK wheel 哈希不匹配：${actualBrowserUseWheelSha256}`);
  process.exit(1);
}
console.log("[desktop] browser-use 3.1.6 SDK wheel 哈希校验通过。");

const uiTestManifest = JSON.parse(fs.readFileSync(uiTestRuntimeManifest, "utf8"));
if (
  uiTestManifest.schemaVersion !== "uiwarden-ui-test-runtime/v1"
  || uiTestManifest.builderRevision !== 5
  || uiTestManifest.platform !== process.platform
  || uiTestManifest.arch !== process.arch
  || uiTestManifest.pythonVersion !== "3.11.17"
  || uiTestManifest.browserUseVersion !== "3.1.6"
  || uiTestManifest.playwrightVersion !== "1.58.0"
) {
  console.error("[desktop] 内置 UI 测试 Runtime 元数据与当前构建目标不匹配。", uiTestManifest);
  process.exit(1);
}
const uiTestProbe = [
  "from importlib.metadata import version",
  "from playwright.sync_api import sync_playwright",
  "assert version('browser-use') == '3.1.6'",
  "assert version('playwright') == '1.58.0'",
  "with sync_playwright() as p:",
  "    browser = p.chromium.launch(headless=True)",
  "    page = browser.new_page()",
  "    page.set_content('<title>UIWarden package probe</title>')",
  "    assert page.title() == 'UIWarden package probe'",
  "    browser.close()",
  "    firefox = p.firefox.launch(headless=True)",
  "    firefox.close()",
  "print('OK')"
].join("\n");
const uiTestRuntimeProbe = spawnSync(uiTestRuntimePython, ["-c", uiTestProbe], {
  cwd: uiTestRuntimeRoot,
  encoding: "utf8",
  timeout: 60_000,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(uiTestRuntimeRoot, "ms-playwright"),
    PLAYWRIGHT_SKIP_BROWSER_GC: "1"
  }
});
if (uiTestRuntimeProbe.status !== 0 || !uiTestRuntimeProbe.stdout.includes("OK")) {
  console.error("[desktop] 内置 UI 测试 Runtime 自检失败。");
  console.error(uiTestRuntimeProbe.stdout || uiTestRuntimeProbe.stderr || "无输出");
  process.exit(uiTestRuntimeProbe.status || 1);
}
console.log("[desktop] 内置 Python、browser-use 与 Playwright Chromium/Firefox Runtime 自检通过。");

if (process.platform !== "win32") {
  fs.chmodSync(path.join(repoRoot, "browser-automation", "bin", "dt-gui-browser"), 0o755);
}
const browserCli = spawnSync(process.execPath, [path.join(repoRoot, "browser-automation", "cli.mjs"), "doctor", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (browserCli.status !== 0 || !browserCli.stdout.includes('"status":"ok"')) {
  console.error("[desktop] dt-gui-browser Runtime 自检失败。");
  console.error(browserCli.stdout || browserCli.stderr || "无输出");
  process.exit(browserCli.status || 1);
}
console.log("[desktop] dt-gui-browser Runtime 自检通过。");

const runtimeName = process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer";
const runtimePath = path.join(repoRoot, "native-automation", runtimeName);
if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o755);
const computerDoctorHome = fs.mkdtempSync(path.join(os.tmpdir(), "dt-gui-computer-doctor-"));
const computerCli = spawnSync(runtimePath, ["--runtime-home", computerDoctorHome, "doctor", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, DT_GUI_COMPUTER_NODE: process.execPath }
});
fs.rmSync(computerDoctorHome, { recursive: true, force: true });
if (computerCli.status !== 0 || !computerCli.stdout.includes('"providerId":"mock"')) {
  console.error("[desktop] dt-gui-computer TypeScript Runtime 自检失败。");
  console.error(computerCli.stdout || computerCli.stderr || "无输出");
  process.exit(computerCli.status || 1);
}
const providerDir = path.join(repoRoot, "native-automation", "target", "native-provider");
fs.mkdirSync(providerDir, { recursive: true });
if (process.platform === "darwin") {
  const provider = spawnSync(path.join(repoRoot, "native-automation", "scripts", "build-macos-provider.sh"), [], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (provider.status !== 0) {
    console.error("[desktop] macOS Accessibility Provider 构建失败。");
    process.exit(provider.status || 1);
  }
} else if (process.platform === "win32") {
  const provider = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(repoRoot, "native-automation", "scripts", "build-windows-provider.ps1"),
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (provider.status !== 0) {
    console.error("[desktop] Windows UI Automation Provider 构建失败，请确认已安装 .NET 8 SDK。");
    process.exit(provider.status || 1);
  }
}
console.log("[desktop] 原生桌面自动化 TypeScript Runtime 构建产物检查通过。");

const bundledNodeDir = path.join(repoRoot, "desktop", "runtime");
const bundledNodeName = process.platform === "win32" ? "node.exe" : "node";
const bundledNodePath = path.join(bundledNodeDir, bundledNodeName);
const portableNode = resolvePortableNodeRuntime(repoRoot);
let nodeSource = portableNode.path;
let stagedNodeDir;
let preservedUiTestRuntime;
if (path.resolve(nodeSource) === path.resolve(bundledNodePath)) {
  stagedNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-node-runtime-"));
  nodeSource = path.join(stagedNodeDir, bundledNodeName);
  fs.copyFileSync(portableNode.path, nodeSource);
}
if (fs.existsSync(uiTestRuntimeRoot)) {
  preservedUiTestRuntime = path.join(
    path.dirname(bundledNodeDir),
    `.ui-test-runtime-preserved-${process.pid}`
  );
  fs.rmSync(preservedUiTestRuntime, { recursive: true, force: true });
  fs.renameSync(uiTestRuntimeRoot, preservedUiTestRuntime);
}
try {
  fs.rmSync(bundledNodeDir, { recursive: true, force: true });
  fs.mkdirSync(bundledNodeDir, { recursive: true });
  fs.copyFileSync(nodeSource, bundledNodePath);
} finally {
  if (stagedNodeDir) fs.rmSync(stagedNodeDir, { recursive: true, force: true });
  if (preservedUiTestRuntime && fs.existsSync(preservedUiTestRuntime)) {
    fs.mkdirSync(bundledNodeDir, { recursive: true });
    fs.renameSync(preservedUiTestRuntime, uiTestRuntimeRoot);
  }
}
if (process.platform !== "win32") {
  fs.chmodSync(bundledNodePath, 0o755);
}
fs.writeFileSync(path.join(bundledNodeDir, "node-runtime.json"), JSON.stringify({
  version: portableNode.metadata.version,
  modules: portableNode.metadata.modules,
  platform: portableNode.metadata.platform,
  arch: portableNode.metadata.arch
}, null, 2));
console.log(
  `[desktop] 已内置 Node ${portableNode.metadata.version}（ABI ${portableNode.metadata.modules}），`
  + "Server 不再依赖客户本机 Node。"
);

const bundledAgentDir = path.join(bundledNodeDir, "agents");
fs.mkdirSync(bundledAgentDir, { recursive: true });
fs.writeFileSync(path.join(bundledAgentDir, "runtime-manifest.json"), JSON.stringify({
  defaultRuntime: "dtcoder",
  externalRuntime: "aiworkcn",
  supportedRuntimeCommands: ["aiwork", "aiworkcn", "aiworkcli", "dtcoder"],
  bundledCommercialRuntimes: false
}, null, 2));
console.log("[desktop] 安装包不复制商业执行底座或下载地址；客户端仅检测用户已安装的 AiWork CLI。");

const stagedResources = stagePackageResources(repoRoot);
console.log(`[desktop] 已生成脱敏资源目录：${stagedResources}`);
const stagedDependencies = stageProductionNodeModules(repoRoot);
console.log(`[desktop] 已暂存 ${stagedDependencies.packageCount} 个生产依赖：${stagedDependencies.outputRoot}`);
