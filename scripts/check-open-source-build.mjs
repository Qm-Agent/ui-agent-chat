import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const wheelDir = path.resolve("vendor/browser-use");
const runtimeConstraintsPath = path.resolve("vendor/ui-test-runtime/constraints.txt");
const runtimeBuilderPath = path.resolve("scripts/prepare-ui-test-runtime.mjs");
const wheels = fs.existsSync(wheelDir)
  ? fs.readdirSync(wheelDir).filter((name) => /^browser_use-3\.1\.6-[^/]+\.whl$/.test(name))
  : [];

if (wheels.length !== 1) {
  console.error("需要恰好一个经过净化、审核并固定哈希的 browser-use 3.1.6 SDK wheel：vendor/browser-use/browser_use-3.1.6-*.whl");
  process.exit(1);
}

const wheelPath = path.join(wheelDir, wheels[0]);
if (!fs.existsSync(runtimeConstraintsPath) || !fs.existsSync(runtimeBuilderPath)) {
  console.error("缺少 UI 测试 Runtime 依赖锁或构建器。公开桌面包不能在运行时回退到未锁定下载。");
  process.exit(1);
}
const runtimeConstraints = fs.readFileSync(runtimeConstraintsPath, "utf8");
const runtimeBuilder = fs.readFileSync(runtimeBuilderPath, "utf8");
if (!/^playwright==1\.58\.0$/m.test(runtimeConstraints)
  || !/^beautifulsoup4==4\.13\.3$/m.test(runtimeConstraints)
  || !/^PySocks==1\.7\.1$/m.test(runtimeConstraints)
  || !/^annotated-doc==0\.0\.5$/m.test(runtimeConstraints)
  || !/^et-xmlfile==2\.0\.0$/m.test(runtimeConstraints)
  || !/^lxml==6\.1\.3$/m.test(runtimeConstraints)
  || !/^socksio==1\.0\.0$/m.test(runtimeConstraints)
  || /(?:--index-url|--extra-index-url|https?:\/\/|alipay|antfin|antgroup)/i.test(runtimeConstraints)) {
  console.error("UI 测试 Runtime constraints 未锁定关键版本，或包含私有/外部包源覆盖。");
  process.exit(1);
}
for (const digest of [
  "5e656e09fc73c7ae10e4df66e6aa253f1f5980509b3be8a242e883d67a5fdf26",
  "a870f5bb476ebe4483761ffdcd39b316dbef9f59f158706296d2c6f138057cae",
  "54a38c5e7cc1a5fd2b0182b495f29606dc1455d18ebfd3b5bf0a3c09253b5031",
  "2725bd0a9925919b9b51739eea5f9e2bae91e83288108a9ad338b2e3a4435ee5"
]) {
  if (!runtimeBuilder.includes(digest)) {
    console.error(`UI 测试 Runtime 构建器缺少固定 CPython digest：${digest}`);
    process.exit(1);
  }
}
let entries;
try {
  entries = execFileSync("unzip", ["-Z", "-1", wheelPath], { encoding: "utf8" }).split("\n");
} catch {
  console.error("无法检查 wheel 内容；请安装 unzip 并确认 wheel 是有效 ZIP 文件。");
  process.exit(1);
}

const distInfo = "browser_use-3.1.6.dist-info/";
if (!entries.includes(`${distInfo}METADATA`) || !entries.includes(`${distInfo}licenses/LICENSE`)) {
  console.error("wheel 缺少 browser-use 3.1.6 元数据或上游 LICENSE，不能用于公开镜像构建。");
  process.exit(1);
}

const metadata = execFileSync("unzip", ["-p", wheelPath, `${distInfo}METADATA`], { encoding: "utf8" });
const license = execFileSync("unzip", ["-p", wheelPath, `${distInfo}licenses/LICENSE`], { encoding: "utf8" });
const wheelText = execFileSync("unzip", ["-p", wheelPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (!/^Name: browser-use$/m.test(metadata) || !/^Version: 3\.1\.6$/m.test(metadata)) {
  console.error("wheel 元数据中的包名或版本与 browser-use 3.1.6 不一致。");
  process.exit(1);
}
if (!license.includes("MIT License") || !license.includes("Copyright")) {
  console.error("wheel 缺少有效的上游 MIT 版权与许可声明。");
  process.exit(1);
}
const forbiddenWheelEntries = entries.filter((entry) => (
  /(^|\/)tests\//.test(entry)
  || entry.startsWith("browser_use/static/benchmarks/")
  || entry === "browser_use/static/custom-hosts"
));
if (forbiddenWheelEntries.length) {
  console.error("内置 browser-use SDK 仍含测试、benchmark 或私有 hosts 资源，不能公开发布。");
  process.exit(1);
}
if (/(?:code\.linke|alipay\.com|alipay\.net|antgroup-inc\.cn|yuque\.antfin|theta\.aistest)/i.test(wheelText)) {
  console.error("内置 browser-use SDK 含内部服务地址，不能公开发布。");
  process.exit(1);
}

const sha256 = createHash("sha256").update(fs.readFileSync(wheelPath)).digest("hex");
const expected = process.env.UIWARDEN_BROWSER_USE_WHEEL_SHA256?.trim().toLowerCase();
const redistributionApproved = process.env.UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED === "true";
if (expected && (!/^[a-f0-9]{64}$/.test(expected) || expected !== sha256)) {
  console.error("browser-use wheel 的 SHA-256 与 UIWARDEN_BROWSER_USE_WHEEL_SHA256 不一致。");
  process.exit(1);
}

console.log(`browser-use 3.1.6 wheel: ${wheels[0]}`);
console.log(`SHA-256: ${sha256}`);
if (!expected) console.warn("尚未固定审核过的 SHA-256；发布构建请设置 UIWARDEN_BROWSER_USE_WHEEL_SHA256。");
if (process.env.UIWARDEN_PUBLIC_RELEASE === "true") {
  if (!expected || !redistributionApproved || !fs.existsSync(path.resolve("LICENSE"))) {
    console.error("公开发布须设置已审核 wheel 的 SHA-256、显式确认再分发授权，并提供仓库根目录 LICENSE。");
    process.exit(1);
  }
}
console.warn("此检查验证版本、文件完整性和显式发布声明；声明内容仍须由有权审批者及法律审查记录支持。");
