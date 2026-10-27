const fs = require("node:fs");
const path = require("node:path");

const RESOURCES = [
  { name: "ui-test-assistant-skill", source: path.join("skills", "ui-test-assistant-skill") },
  { name: "dt-gui-computer-skill", source: path.join("skills", "dt-gui-computer-skill") },
  { name: "dt-gui-browser-skill", source: path.join("skills", "dt-gui-browser-skill") },
  { name: "browser-task-group-extension", source: "browser-task-group-extension" },
  { name: "browser-automation", source: "browser-automation" }
];
const RESOURCE_DIRS = RESOURCES.map((resource) => resource.name);
const EXCLUDED_DIRS = new Set([".git", ".skill-output", "__pycache__", "logs", "node_modules", "release", "test-reports"]);
const CREDENTIAL_ASSIGNMENT = /^[ \t]*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))[ \t]*=[ \t]*\S+/m;
const PUBLIC_PROMPT_CONTEXT_FILES = new Set([".gitkeep", "global_readme.md"]);

function isPrivateSkillContext(resourceName, relative) {
  if (resourceName !== "ui-test-assistant-skill") return false;
  const normalized = relative.split(path.sep).join("/");
  if (normalized.startsWith("config/perference_context/")) {
    return path.posix.basename(normalized) !== ".gitkeep";
  }
  if (normalized.startsWith("config/prompt_context/")) {
    return !PUBLIC_PROMPT_CONTEXT_FILES.has(path.posix.basename(normalized));
  }
  return false;
}

function stagePackageResources(repoRoot) {
  const outputRoot = path.join(repoRoot, "desktop", "runtime", "package-resources");
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  for (const resource of RESOURCES) {
    const { name } = resource;
    const source = path.join(repoRoot, resource.source);
    if (!fs.statSync(source).isDirectory()) throw new Error(`Missing package resource: ${name}`);
    fs.cpSync(source, path.join(outputRoot, name), {
      recursive: true,
      filter(entry) {
        const relative = path.relative(source, entry);
        if (!relative) return true;
        if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Package resource symlink is not allowed: ${name}/${relative}`);
        if (isPrivateSkillContext(name, relative)) return false;
        const parts = relative.split(path.sep);
        if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;
        const base = parts.at(-1);
        if (base === ".DS_Store") return false;
        if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return false;
        if (base.endsWith(".pyc") || base.endsWith(".log")) return false;
        if (base === ".env.example") {
          const content = fs.readFileSync(entry, "utf8");
          const match = CREDENTIAL_ASSIGNMENT.exec(content);
          if (match) throw new Error(`Package env example contains populated ${match[1]}: ${name}/${relative}`);
        }
        return true;
      }
    });
  }
  return outputRoot;
}

module.exports = { RESOURCE_DIRS, stagePackageResources };
