import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const forbiddenEntries = [
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)test-reports(?:\/|$)/,
  /(^|\/)data(?:\/|$)/,
  /(^|\/)\.skill-output(?:\/|$)/,
  /(^|\/)\.env(?:\.(?!example$)[^/]*)?$/
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runNodeScript(name, env = process.env) {
  execFileSync(process.execPath, [path.join(scriptDir, name)], {
    cwd: projectRoot,
    env,
    stdio: "inherit"
  });
}

export function validateSnapshotEntries(entries) {
  const normalized = entries.map((entry) => entry.replace(/^uiwarden-source\//, "")).filter(Boolean);
  const forbidden = normalized.filter((entry) => forbiddenEntries.some((rule) => rule.test(entry)));
  const required = ["LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "Dockerfile", "README.md"];
  const missing = required.filter((entry) => !normalized.includes(entry));
  return { forbidden, missing };
}

function parseOutput(argv) {
  const index = argv.indexOf("--output");
  if (index < 0 || !argv[index + 1]) {
    fail("用法：npm run export:open-source-snapshot -- --output /absolute/path/uiwarden-source.tar.gz");
  }
  const output = path.resolve(argv[index + 1]);
  if (!output.endsWith(".tar.gz")) fail("输出文件必须使用 .tar.gz 后缀。");
  const relative = path.relative(projectRoot, output);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    fail("公开快照必须输出到仓库目录之外，避免将发布物重新纳入源码树。");
  }
  return output;
}

if (process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const output = parseOutput(process.argv.slice(2));
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8"
  }).trim();
  if (dirty) fail("工作树不是干净状态；请先审阅并提交开源改造，再导出可复现快照。");

  runNodeScript("check-open-source-index.mjs");
  runNodeScript("check-open-source-build.mjs", {
    ...process.env,
    UIWARDEN_PUBLIC_RELEASE: "true"
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    "--prefix=uiwarden-source/",
    `--output=${output}`,
    "HEAD"
  ], { cwd: projectRoot, stdio: "inherit" });

  const entries = execFileSync("tar", ["-tzf", output], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const validation = validateSnapshotEntries(entries);
  if (validation.forbidden.length || validation.missing.length) {
    fs.rmSync(output, { force: true });
    if (validation.forbidden.length) console.error(`快照含禁止路径：${validation.forbidden.join(", ")}`);
    if (validation.missing.length) console.error(`快照缺少发布文件：${validation.missing.join(", ")}`);
    process.exit(1);
  }

  const sha256 = createHash("sha256").update(fs.readFileSync(output)).digest("hex");
  fs.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, "utf8");
  console.log(`已生成无 Git 历史的开源源码快照：${output}`);
  console.log(`SHA-256：${sha256}`);
}
