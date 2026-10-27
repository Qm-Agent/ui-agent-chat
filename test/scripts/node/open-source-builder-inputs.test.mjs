import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("public builder COPY inputs compile without other repository files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-public-builder-"));
  try {
    const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
    const builder = dockerfile.split(/^FROM .* AS runtime$/m)[0];
    const copies = [...builder.matchAll(/^COPY (.+)$/gm)];
    assert.ok(copies.length > 0);

    for (const [, statement] of copies) {
      const parts = statement.trim().split(/\s+/);
      const destination = parts.pop();
      for (const source of parts) {
        const from = path.join(root, source);
        const intoDirectory = parts.length > 1 || destination.endsWith("/");
        const to = path.join(temp, intoDirectory ? path.join(destination, path.basename(source)) : destination);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, {
          recursive: true,
          filter: (item) => {
            const segments = path.relative(root, item).split(path.sep);
            return !segments.some((part) => part === "node_modules" || part === ".skill-output"
              || part === "__pycache__" || part === "shared-runtime" || part === "target"
              || part === "dist" || part === "logs" || part === ".env");
          }
        });
      }
    }

    fs.symlinkSync(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
    const result = spawnSync("npm", ["run", "build"], {
      cwd: temp,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.status, 0, `${result.stdout || ""}\n${result.stderr || ""}`);
    assert.ok(fs.existsSync(path.join(temp, "dist/server/index.js")));
    assert.ok(fs.existsSync(path.join(temp, "dist/client/index.html")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
