import { execFileSync } from "node:child_process";

const historyRef = process.env.UIWARDEN_HISTORY_REF?.trim() || "--all";
if (historyRef !== "--all") {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${historyRef}^{commit}`], { stdio: "ignore" });
  } catch {
    console.error(`无法解析待发布历史引用：${historyRef}`);
    process.exit(1);
  }
}

let objects;
let historyPaths;
try {
  objects = execFileSync("git", ["rev-list", "--objects", historyRef], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });
  historyPaths = execFileSync("git", ["log", historyRef, "--format=", "--name-only", "-z"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });
} catch {
  console.error("无法读取 Git 历史对象；请在 Git 仓库中执行历史发布检查。");
  process.exit(1);
}

const categories = [
  ["test-reports", /(^|\/)test-reports\//],
  ["evaluation-results", /(^|\/)test\/data\/evaluation-lab\/results\//],
  ["skill-output", /(^|\/)\.skill-output\//],
  ["local-agent-settings", /(^|\/)\.claude\/settings\.local\.json$/],
  ["editor-settings", /(^|\/)\.idea\//],
  ["local-env", /(^|\/)\.env(?:\.(?!example$)[^/]*)?$/]
];
const findings = new Map(categories.map(([name]) => [name, new Set()]));
findings.set("populated-env-example", new Set());
const credentialKeyNames = new Set();
for (const rawFile of historyPaths.split("\0")) {
  const file = rawFile.replace(/^\n+|\n+$/g, "");
  if (!file) continue;
  for (const [name, pattern] of categories) {
    if (pattern.test(file)) findings.get(name).add(file);
  }
}

for (const line of objects.split("\n")) {
  const separator = line.indexOf(" ");
  if (separator < 0) continue;
  const objectId = line.slice(0, separator);
  const file = line.slice(separator + 1);
  if (/(^|\/)\.env(?:\.(?:example|[^/]+))?$/.test(file)) {
    const content = execFileSync("git", ["cat-file", "-p", objectId], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const populatedSecretPattern = /^[ \t]*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))[ \t]*=[ \t]*(\S+)/gm;
    for (const match of content.matchAll(populatedSecretPattern)) {
      const value = match[2];
      if (!/^(?:<[^>]+>|your[-_]|example[-_]|change[-_]?me)/i.test(value)) {
        credentialKeyNames.add(match[1]);
      }
    }
    if (file.endsWith(".env.example") && /^[ \t]*[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[ \t]*=[ \t]*\S+/m.test(content)) {
      findings.get("populated-env-example").add(objectId);
    }
  }
}

const found = [...findings].filter(([, files]) => files.size > 0);
if (found.length) {
  for (const [name, files] of found) {
    console.error(`${name}: ${files.size} 个历史${name === "populated-env-example" ? "对象" : "路径"}`);
  }
  if (credentialKeyNames.size > 0) {
    console.error(`credential-key-names (values suppressed): ${[...credentialKeyNames].sort().join(", ")}`);
  }
  console.error("旧历史不能直接推送到公开远端；先审计、轮换凭据，并从净化后的历史创建发布仓库。此检查不扫描普通源文件中的密钥内容。");
  process.exit(1);
}
console.log("历史对象路径未发现已知测试产物、本机设置、实际 .env 或 wheel；仍需单独进行密钥内容和许可审计。");
