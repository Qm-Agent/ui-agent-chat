const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const slots = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${String(result.stderr || result.stdout).trim()}`);
  }
}

function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`不是有效 PNG：${filePath}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function verifyIconSet(iconSetDir) {
  for (const [name, expectedSize] of slots) {
    const filePath = path.join(iconSetDir, name);
    if (!fs.existsSync(filePath)) throw new Error(`ICNS 缺少标准槽位：${name}`);
    const dimensions = pngDimensions(filePath);
    if (dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
      throw new Error(
        `${name} 尺寸错误：${dimensions.width}x${dimensions.height}，应为 ${expectedSize}x${expectedSize}`
      );
    }
  }
}

function verifyIcns(icnsPath) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-icon-verify-"));
  const iconSetDir = path.join(temporary, "icon.iconset");
  try {
    run("iconutil", ["-c", "iconset", icnsPath, "-o", iconSetDir]);
    verifyIconSet(iconSetDir);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function buildIcns() {
  const desktopRoot = path.resolve(__dirname, "..");
  const source = path.join(desktopRoot, "build", "icon.png");
  const destination = path.join(desktopRoot, "build", "icon.icns");
  const sourceDimensions = pngDimensions(source);
  if (sourceDimensions.width !== 1024 || sourceDimensions.height !== 1024) {
    throw new Error(`macOS 图标源文件必须是 1024x1024：${source}`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-icon-build-"));
  const iconSetDir = path.join(temporary, "icon.iconset");
  fs.mkdirSync(iconSetDir);
  try {
    for (const [name, size] of slots) {
      run("sips", ["-s", "format", "png", "-z", String(size), String(size), source, "--out", path.join(iconSetDir, name)]);
    }
    verifyIconSet(iconSetDir);
    run("iconutil", ["-c", "icns", iconSetDir, "-o", destination]);
    verifyIcns(destination);
    console.log(`[desktop] macOS ICNS 标准槽位校验通过：${destination}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const [command = "build", value] = process.argv.slice(2);
if (process.platform !== "darwin") {
  throw new Error("macOS ICNS 构建与校验只能在 macOS 执行");
}
if (command === "build") {
  buildIcns();
} else if (command === "verify" && value) {
  verifyIcns(path.resolve(value));
  console.log(`[desktop] macOS ICNS 标准槽位校验通过：${path.resolve(value)}`);
} else {
  throw new Error("用法：node scripts/mac-icon.cjs build | verify <icon.icns>");
}
