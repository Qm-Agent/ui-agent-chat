import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(root, "desktop", "package.json"));
const asar = require("@electron/asar");
const appPathInput = process.argv[2] || [
  path.join(root, "desktop", "release", "mac-arm64", "UIWarden.app"),
  path.join(root, "desktop", "release", "mac", "UIWarden.app")
].find((candidate) => fs.existsSync(candidate));
const appPath = appPathInput ? path.resolve(appPathInput) : undefined;

assert.ok(appPath && fs.existsSync(appPath), "未找到 UIWarden.app，请先执行桌面打包");
const resources = path.join(appPath, "Contents", "Resources");
const agentDir = path.join(resources, "runtime", "agents");
const cfuse = path.join(agentDir, "cfuse");
const manifestPath = path.join(agentDir, "runtime-manifest.json");
const nodeManifestPath = path.join(resources, "runtime", "node-runtime.json");
const browserCli = path.join(resources, "browser-automation", "bin", process.platform === "win32" ? "dt-gui-browser.cmd" : "dt-gui-browser");
const browserPackage = JSON.parse(fs.readFileSync(path.join(resources, "browser-automation", "package.json"), "utf8"));
const bundledNode = path.join(resources, "runtime", process.platform === "win32" ? "node.exe" : "node");
const taskGroupExtension = path.join(resources, "browser-task-group-extension");
const betterSqlite = path.join(resources, "node_modules", "better-sqlite3");

assert.equal(fs.existsSync(cfuse), false, `公开安装包不得捆绑 CFuse：${cfuse}`);
assert.ok(fs.existsSync(path.join(resources, "dist", "server", "index.js")), "安装包缺少 server 产物");
assert.ok(fs.existsSync(path.join(resources, "dist", "client", "index.html")), "安装包缺少 client 产物");
assert.ok(fs.existsSync(browserCli), `安装包缺少 dt-gui-browser：${browserCli}`);
assert.ok(fs.existsSync(path.join(taskGroupExtension, "manifest.json")), "安装包缺少任务标签组扩展 Manifest");
assert.ok(fs.existsSync(path.join(taskGroupExtension, "control.js")), "安装包缺少任务标签组扩展控制脚本");
assert.ok(fs.existsSync(path.join(taskGroupExtension, "background.js")), "安装包缺少用户浏览器扩展桥后台脚本");
const asarFiles = new Set(asar.listPackage(path.join(resources, "app.asar")));
for (const required of [
  "/window-lifecycle.cjs",
  "/picture-in-picture.cjs",
  "/pip-preload.cjs",
  "/pip-renderer.js",
  "/pip.html"
]) {
  assert.equal(asarFiles.has(required), true, `安装包 app.asar 缺少 ${required}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const nodeManifest = JSON.parse(fs.readFileSync(nodeManifestPath, "utf8"));
assert.equal(manifest.defaultRuntime, "dtcoder");
assert.equal(manifest.externalRuntime, "aiworkcn");
assert.deepEqual(manifest.supportedRuntimeCommands, ["aiwork", "aiworkcn", "aiworkcli", "dtcoder"]);
assert.equal(manifest.externalInstallerUrl, undefined);
assert.equal(manifest.bundledCommercialRuntimes, false);
assert.equal(manifest.cfuse, undefined, "公开安装包清单不得包含 CFuse 元数据");

const bundledNodeProbe = spawnSync(bundledNode, ["-e", `
  const Database = require(${JSON.stringify(betterSqlite)});
  const database = new Database(":memory:");
  database.close();
  process.stdout.write(JSON.stringify({
    version: process.version,
    modules: process.versions.modules,
    platform: process.platform,
    arch: process.arch
  }));
`], {
  encoding: "utf8",
  timeout: 60_000
});
assert.equal(
  bundledNodeProbe.status,
  0,
  bundledNodeProbe.stderr || bundledNodeProbe.stdout || "随包 Node 或 better-sqlite3 ABI 自检失败"
);
const bundledNodeMetadata = JSON.parse(bundledNodeProbe.stdout);
assert.equal(bundledNodeMetadata.version, nodeManifest.version);
assert.equal(bundledNodeMetadata.modules, nodeManifest.modules);
assert.equal(bundledNodeMetadata.platform, nodeManifest.platform);
assert.equal(bundledNodeMetadata.arch, nodeManifest.arch);

const browserHome = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "dt-gui-browser-package-"));
const browserDoctor = spawnSync(browserCli, [
  "--node", bundledNode,
  "--runtime-home", browserHome,
  "doctor", "--json"
], {
  encoding: "utf8",
  env: { HOME: process.env.HOME || browserHome },
  timeout: 60_000
});
assert.equal(browserDoctor.status, 0, browserDoctor.stderr || browserDoctor.stdout || "dt-gui-browser daemon binding 自检失败");
const browserStatus = JSON.parse(browserDoctor.stdout);
assert.equal(browserStatus.data.runtimeHome, browserHome);
assert.equal(browserStatus.data.runtimeVersion, browserPackage.version);

console.log(
  `execution runtime package smoke: PASS app=${appPath} default=${manifest.defaultRuntime} browser=${browserPackage.version}`
);
