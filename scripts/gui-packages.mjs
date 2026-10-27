import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseConfigPath = path.join(root, "gui-packages.release.json");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const knownPackageIds = new Set(["runtime", "browser", "computer"]);

const [command = "check", ...args] = process.argv.slice(2);

try {
  if (command === "check") {
    await checkReleaseConfiguration();
  } else if (command === "prepare") {
    await preparePackage(requiredPackageId(args[0]));
    await checkReleaseConfiguration();
  } else if (command === "version") {
    await setReleaseVersion(requiredVersion(args[0]));
    await checkReleaseConfiguration();
  } else if (command === "pack") {
    await packRelease();
  } else if (command === "publish") {
    await publishRelease();
  } else if (command === "verify-registry") {
    await verifyRegistry();
  } else {
    fail(`未知命令：${command}`);
  }
} catch (error) {
  console.error(`[gui-packages] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function checkReleaseConfiguration() {
  const config = await readReleaseConfig();
  assertSemver(config.releaseTrain, "releaseTrain");
  assertPositiveInteger(config.protocolVersion, "protocolVersion");
  if (!String(config.registry || "").startsWith("https://")) {
    fail("registry 必须是 HTTPS 地址");
  }

  const seenIds = new Set();
  const seenNames = new Set();
  for (const item of config.packages) {
    if (!knownPackageIds.has(item.id)) fail(`未知 package id：${item.id}`);
    if (seenIds.has(item.id)) fail(`package id 重复：${item.id}`);
    if (seenNames.has(item.name)) fail(`package name 重复：${item.name}`);
    seenIds.add(item.id);
    seenNames.add(item.name);

    const packageJsonPath = path.join(root, item.directory, "package.json");
    const packageJson = await readJson(packageJsonPath);
    assertEqual(packageJson.name, item.name, `${item.id} package name`);
    assertEqual(packageJson.version, config.releaseTrain, `${item.id} package version`);
    if (config.publishEnabled === true) {
      if (packageJson.private === true) fail(`${item.name} 仍标记为 private，禁止发布`);
      if (packageJson.license === "UNLICENSED") fail(`${item.name} 尚未选择许可证，禁止发布`);
      assertEqual(packageJson.publishConfig?.registry, config.registry, `${item.id} publish registry`);
    }
    if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
      fail(`${item.name} 必须声明 files 白名单`);
    }
  }

  if (seenIds.size !== knownPackageIds.size) {
    fail(`发布配置必须包含 ${[...knownPackageIds].join(", ")}`);
  }

  const browserRuntime = await fs.readFile(path.join(root, "browser-automation/src/runtime.mjs"), "utf8");
  assertSourceConstant(browserRuntime, "RUNTIME_VERSION", config.releaseTrain, "dt-gui-browser");
  assertSourceConstant(browserRuntime, "PROTOCOL_VERSION", config.protocolVersion, "dt-gui-browser");

  const computerTypes = await fs.readFile(path.join(root, "native-automation/src-ts/types.ts"), "utf8");
  assertSourceConstant(computerTypes, "RUNTIME_VERSION", config.releaseTrain, "dt-gui-computer");
  assertSourceConstant(computerTypes, "PROTOCOL_VERSION", config.protocolVersion, "dt-gui-computer");

  console.log(`[gui-packages] 配置一致：release=${config.releaseTrain} protocol=${config.protocolVersion}`);
}

async function preparePackage(packageId) {
  const config = await readReleaseConfig();
  await checkReleaseConfiguration();
  if (packageId === "runtime") {
    await buildSharedRuntime();
  } else if (packageId === "browser") {
    await buildSharedRuntime();
    await copySharedRuntime("browser-automation");
  } else if (packageId === "computer") {
    await buildSharedRuntime();
    await copySharedRuntime("native-automation");
    await runNode([typescriptCli(), "-p", path.join(root, "native-automation/tsconfig.json")]);
    await buildNativeProvider(config.releaseTrain);
  }
  console.log(`[gui-packages] 已准备 ${packageId}`);
}

async function packRelease() {
  const config = await readReleaseConfig();
  await checkReleaseConfiguration();
  await prepareAll(config.releaseTrain);

  const releaseDir = releaseDirectory(config.releaseTrain);
  await fs.rm(releaseDir, { recursive: true, force: true });
  await fs.mkdir(releaseDir, { recursive: true });

  const artifacts = [];
  for (const item of config.packages) {
    const result = npmJson([
      "pack",
      path.join(root, item.directory),
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      releaseDir
    ]);
    const packed = Array.isArray(result) ? result[0] : undefined;
    if (!packed?.filename || !Array.isArray(packed.files)) {
      fail(`${item.name} npm pack 未返回有效清单`);
    }
    validatePackedFiles(item.id, packed.files.map((entry) => entry.path), process.platform);
    const artifactPath = path.join(releaseDir, packed.filename);
    const content = await fs.readFile(artifactPath);
    artifacts.push({
      id: item.id,
      name: item.name,
      version: config.releaseTrain,
      filename: packed.filename,
      sha256: createHash("sha256").update(content).digest("hex"),
      shasum: createHash("sha1").update(content).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(content).digest("base64")}`,
      size: content.byteLength,
      fileCount: packed.files.length
    });
  }

  const manifest = {
    schemaVersion: 1,
    releaseTrain: config.releaseTrain,
    protocolVersion: config.protocolVersion,
    registry: config.registry,
    tag: config.tag,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    artifacts
  };
  await fs.writeFile(
    path.join(releaseDir, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  console.log(`[gui-packages] 已生成 ${releaseDir}`);
  for (const artifact of artifacts) {
    console.log(`[gui-packages] ${artifact.filename} sha256=${artifact.sha256}`);
  }
}

async function publishRelease() {
  const config = await readReleaseConfig();
  if (config.publishEnabled !== true) {
    fail("公开源码准备阶段禁止发布 GUI npm 包；完成权属、许可证与 registry 审批后再显式启用 publishEnabled");
  }
  await checkReleaseConfiguration();
  const releaseDir = releaseDirectory(config.releaseTrain);
  const manifest = await readJson(path.join(releaseDir, "release-manifest.json"));
  assertEqual(manifest.releaseTrain, config.releaseTrain, "release manifest version");
  assertEqual(manifest.registry, config.registry, "release manifest registry");

  for (const artifact of manifest.artifacts || []) {
    const artifactPath = path.join(releaseDir, artifact.filename);
    const content = await fs.readFile(artifactPath);
    const checksum = createHash("sha256").update(content).digest("hex");
    assertEqual(checksum, artifact.sha256, `${artifact.filename} checksum`);

    const existing = registryVersion(artifact.name, artifact.version, config.registry);
    if (existing === artifact.version) {
      console.log(`[gui-packages] 已存在，跳过发布：${artifact.name}@${artifact.version}`);
      continue;
    }

    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-publish-"));
    try {
      run("tar", ["-xzf", artifactPath, "-C", stagingRoot], { cwd: root });
      const publishDirectory = path.join(stagingRoot, "package");
      const stagedPackage = await readJson(path.join(publishDirectory, "package.json"));
      assertEqual(stagedPackage.name, artifact.name, `${artifact.filename} staged name`);
      assertEqual(stagedPackage.version, artifact.version, `${artifact.filename} staged version`);

      const publishArgs = [
        "publish",
        publishDirectory,
        "--ignore-scripts",
        "--registry",
        config.registry,
        "--tag",
        config.tag || "latest"
      ];
      if (artifact.name.startsWith("@")) publishArgs.push("--access", "public");
      run(process.env.GUI_PACKAGE_NPM_BIN || "npm", publishArgs, { cwd: root });
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }
  await verifyRegistry();
}

async function verifyRegistry() {
  const config = await readReleaseConfig();
  if (config.publishEnabled !== true) {
    fail("GUI npm 包发布尚未启用，不能验证远端 registry");
  }
  const releaseManifestPath = path.join(releaseDirectory(config.releaseTrain), "release-manifest.json");
  const releaseManifest = await readJson(releaseManifestPath).catch(() => undefined);
  for (const item of config.packages) {
    const version = registryVersion(item.name, config.releaseTrain, config.registry);
    assertEqual(version, config.releaseTrain, `${item.name} registry version`);
    const expected = releaseManifest?.artifacts?.find((artifact) => artifact.name === item.name);
    if (expected) {
      const dist = registryDist(item.name, config.releaseTrain, config.registry);
      assertEqual(dist.shasum, expected.shasum, `${item.name} registry shasum`);
      assertEqual(dist.integrity, expected.integrity, `${item.name} registry integrity`);
    }
    console.log(`[gui-packages] registry OK：${item.name}@${version}`);
  }
}

async function setReleaseVersion(version) {
  const config = await readReleaseConfig();
  config.releaseTrain = version;
  await writeJson(releaseConfigPath, config);

  for (const item of config.packages) {
    const packageJsonPath = path.join(root, item.directory, "package.json");
    const packageJson = await readJson(packageJsonPath);
    packageJson.version = version;
    await writeJson(packageJsonPath, packageJson);
  }

  await replaceSourceConstant(
    path.join(root, "browser-automation/src/runtime.mjs"),
    "RUNTIME_VERSION",
    JSON.stringify(version)
  );
  await replaceSourceConstant(
    path.join(root, "native-automation/src-ts/types.ts"),
    "RUNTIME_VERSION",
    JSON.stringify(version)
  );
  console.log(`[gui-packages] release train 已更新为 ${version}`);
}

async function prepareAll(version) {
  await buildSharedRuntime();
  await copySharedRuntime("browser-automation");
  await copySharedRuntime("native-automation");
  await runNode([typescriptCli(), "-p", path.join(root, "native-automation/tsconfig.json")]);
  await buildNativeProvider(version);
  await checkReleaseConfiguration();
}

async function buildSharedRuntime() {
  await runNode([typescriptCli(), "-p", path.join(root, "gui-runtime/tsconfig.json")]);
}

async function copySharedRuntime(destination) {
  const target = path.join(root, destination, "shared-runtime");
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(path.join(root, "gui-runtime/dist"), target, { recursive: true });
}

async function buildNativeProvider(version) {
  if (process.platform === "darwin") {
    run("bash", [path.join(root, "native-automation/scripts/build-macos-provider.sh")], {
      cwd: root,
      env: { ...process.env, DT_GUI_COMPUTER_PACKAGE_VERSION: version }
    });
    return;
  }
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "native-automation/scripts/build-windows-provider.ps1")
    ], { cwd: root });
    return;
  }
  console.warn("[gui-packages] 当前平台只打包 Mock Provider；真实 Provider 需在目标平台构建");
}

function validatePackedFiles(packageId, files, platform) {
  const required = {
    runtime: [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md"
    ],
    browser: [
      "cli.mjs",
      "bin/dt-gui-browser",
      "shared-runtime/index.js",
      "src/runtime.mjs",
      "schemas/protocol.schema.json",
      "README.md"
    ],
    computer: [
      "dist/cli.js",
      "dt-gui-computer",
      "shared-runtime/index.js",
      "schemas/protocol.schema.json",
      "README.md"
    ]
  }[packageId];
  for (const expected of required) {
    if (!files.includes(expected)) fail(`${packageId} 发布包缺少 ${expected}`);
  }
  if (packageId === "computer" && platform === "darwin") {
    const providerSuffix = "dt-gui-computer Provider.app/Contents/MacOS/dt-gui-computer-provider";
    if (!files.some((entry) => entry.endsWith(providerSuffix))) {
      fail(`computer 发布包缺少 macOS Provider：${providerSuffix}`);
    }
  }
}

function registryVersion(name, version, registry) {
  const result = spawnSync(process.env.GUI_PACKAGE_NPM_BIN || "npm", [
    "view",
    `${name}@${version}`,
    "version",
    "--json",
    "--registry",
    registry
  ], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) return undefined;
  const parsed = JSON.parse(result.stdout.trim() || "null");
  return typeof parsed === "string" ? parsed : undefined;
}

function registryDist(name, version, registry) {
  const result = spawnSync(process.env.GUI_PACKAGE_NPM_BIN || "npm", [
    "view",
    `${name}@${version}`,
    "dist",
    "--json",
    "--registry",
    registry
  ], { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) fail(`无法读取 ${name}@${version} registry dist`);
  const parsed = JSON.parse(result.stdout.trim() || "{}");
  if (typeof parsed.shasum !== "string" || typeof parsed.integrity !== "string") {
    fail(`${name}@${version} registry dist 不完整`);
  }
  return parsed;
}

function npmJson(args) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    fail(`npm ${args[0]} 失败，退出码 ${result.status}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`npm ${args[0]} 未返回 JSON：${result.stdout.slice(0, 500)}`);
  }
}

function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: "npm", args };
}

async function readReleaseConfig() {
  const config = await readJson(releaseConfigPath);
  if (!Array.isArray(config.packages)) fail("发布配置 packages 必须是数组");
  return config;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function replaceSourceConstant(filePath, constantName, serializedValue) {
  const source = await fs.readFile(filePath, "utf8");
  const pattern = new RegExp(`(export const ${constantName} = )[^;]+;`);
  if (!pattern.test(source)) fail(`${filePath} 缺少 ${constantName}`);
  await fs.writeFile(filePath, source.replace(pattern, `$1${serializedValue};`));
}

function assertSourceConstant(source, name, expected, label) {
  const match = source.match(new RegExp(`export const ${name} = ([^;]+);`));
  if (!match) fail(`${label} 缺少 ${name}`);
  const actual = JSON.parse(match[1]);
  assertEqual(actual, expected, `${label} ${name}`);
}

function typescriptCli() {
  return path.join(root, "node_modules/typescript/bin/tsc");
}

async function runNode(args) {
  run(process.execPath, args, { cwd: root });
}

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    fail(`${commandName} ${commandArgs.join(" ")} 失败，退出码 ${result.status ?? "unknown"}`);
  }
}

function releaseDirectory(version) {
  return path.join(root, "release", "gui-packages", version);
}

function requiredPackageId(value) {
  if (!knownPackageIds.has(value)) fail(`prepare 需要 package id：${[...knownPackageIds].join("|")}`);
  return value;
}

function requiredVersion(value) {
  assertSemver(value, "version");
  return value;
}

function assertSemver(value, label) {
  if (typeof value !== "string" || !semverPattern.test(value)) fail(`${label} 不是有效 SemVer：${value}`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} 必须是正整数`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} 不一致：actual=${actual} expected=${expected}`);
}

function fail(message) {
  throw new Error(message);
}
