import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

let result = spawnSync(tsc, ["-p", path.join(root, "gui-runtime/tsconfig.json")], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);

for (const destination of [
  path.join(root, "native-automation", "shared-runtime"),
  path.join(root, "browser-automation", "shared-runtime")
]) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(path.join(root, "gui-runtime", "dist"), destination, { recursive: true });
}

result = spawnSync(tsc, ["-p", path.join(root, "native-automation/tsconfig.json")], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
