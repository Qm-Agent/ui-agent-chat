import { execFileSync } from "node:child_process";
import fs from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const excluded = [
  /^test-reports\//,
  /^test\/data\/evaluation-lab\/results\//,
  /^data\//,
  /^\.idea\//,
  /^\.claude\/settings\.local\.json$/,
  /(^|\/)\.skill-output\//,
  /(^|\/)\.env(?:\.(?!example$)[^/]*)?$/
];
const problems = [];

const sensitiveContentRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential-like sk token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["credential-like AK token", /\bAK[A-Za-z0-9]{10,62}\b/],
  ["internal package manager or scope", new RegExp(`(?:\\b${["t", "npm"].join("")}\\b|@${["ant", "agent"].join("")}\\/)`, "i")],
  ["private network address", /(?:^|[^0-9])(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?:[^0-9]|$)/],
  ["personal absolute path", /(?:\/Users\/qiming\/|\/home\/qiming\/|[A-Za-z]:\\Users\\qiming\\)/i]
];
const sensitiveContentExcluded = new Set(["package-lock.json", "desktop/package-lock.json"]);

for (const file of tracked) {
  if (excluded.some((rule) => rule.test(file))) {
    problems.push(`${file}: sensitive output or binary is tracked`);
  }

  if (sensitiveContentExcluded.has(file)) continue;
  let content;
  try {
    content = execFileSync("git", ["show", `:${file}`], {
      encoding: "utf8",
      maxBuffer: 6 * 1024 * 1024
    });
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  for (const [label, pattern] of sensitiveContentRules) {
    if (pattern.test(content)) problems.push(`${file}: ${label} in tracked text`);
  }
}

let leakedFiles = "";
try {
  leakedFiles = execFileSync("git", [
    "grep", "--cached", "-l", "-z", "-E",
    "^[[:space:]]*SHARED_MODEL_API_KEY=[^[:space:]]"
  ], { encoding: "utf8" });
} catch (error) {
  if (error.status !== 1) throw error;
}
for (const file of leakedFiles.split("\0").filter(Boolean)) {
  problems.push(`${file}: populated shared model key in tracked text`);
}

let internalDomainFiles = "";
try {
  const internalDomainPattern = [
    ["yuque", "antfin", "com"],
    ["project", "alipay", "com"],
    ["theta", "alipay", "com"],
    ["code", "alipay", "com"],
    ["", "dtagi", "cn"],
    ["", "alipay", "net"],
    ["", "antgroup-inc", "cn"]
  ].map((parts) => parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[.]")).join("|");
  internalDomainFiles = execFileSync("git", [
    "grep", "--cached", "-l", "-z", "-E",
    `(${internalDomainPattern})`
  ], { encoding: "utf8" });
} catch (error) {
  if (error.status !== 1) throw error;
}
for (const file of internalDomainFiles.split("\0").filter(Boolean)) {
  problems.push(`${file}: internal service domain in tracked text`);
}

const credentialAssignment = /^[ \t]*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))[ \t]*=[ \t]*\S+/gm;
for (const file of tracked.filter((name) => name.endsWith(".env.example"))) {
  const sources = [["index", execFileSync("git", ["show", `:${file}`], { encoding: "utf8" })]];
  if (fs.existsSync(file)) sources.push(["working tree", fs.readFileSync(file, "utf8")]);
  for (const [source, content] of sources) {
    for (const match of content.matchAll(credentialAssignment)) {
      problems.push(`${file}: populated credential field ${match[1]} in ${source} env example`);
    }
  }
}

if (problems.length) {
  for (const message of problems) console.error(message);
  process.exitCode = 1;
} else {
  console.log("Tracked source and env-example worktree have no known generated results, local/editor settings, local env, populated credentials, or internal service domains.");
  console.log("Audit Git history, other source content, and third-party rights separately.");
}
