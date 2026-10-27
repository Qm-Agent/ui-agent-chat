import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const exporter = path.join(projectRoot, "scripts/export-open-source-snapshot.mjs");

test("snapshot entry validation rejects local output and requires release notices", async () => {
  const { validateSnapshotEntries } = await import(pathToFileURL(exporter).href);
  const invalid = validateSnapshotEntries([
    "uiwarden-source/README.md",
    "uiwarden-source/test-reports/private.json",
    "uiwarden-source/.env"
  ]);
  assert.deepEqual(invalid.forbidden, ["test-reports/private.json", ".env"]);
  assert.deepEqual(invalid.missing, ["LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "Dockerfile"]);
});

test("snapshot exporter creates a history-free archive only after release gates pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-public-snapshot-"));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-public-output-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    for (const name of ["export-open-source-snapshot.mjs", "check-open-source-index.mjs", "check-open-source-build.mjs"]) {
      fs.copyFileSync(path.join(projectRoot, "scripts", name), path.join(root, "scripts", name));
    }
    fs.copyFileSync(
      path.join(projectRoot, "scripts", "prepare-ui-test-runtime.mjs"),
      path.join(root, "scripts", "prepare-ui-test-runtime.mjs")
    );
    for (const name of ["LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "Dockerfile", "README.md"]) {
      fs.writeFileSync(path.join(root, name), `${name} fixture\n`, "utf8");
    }
    fs.writeFileSync(path.join(root, ".gitignore"), "data/\n", "utf8");
    fs.mkdirSync(path.join(root, "vendor/browser-use"), { recursive: true });
    fs.mkdirSync(path.join(root, "vendor/ui-test-runtime"), { recursive: true });
    fs.copyFileSync(
      path.join(projectRoot, "vendor/ui-test-runtime/constraints.txt"),
      path.join(root, "vendor/ui-test-runtime/constraints.txt")
    );
    const wheel = zipSync({
      "browser_use-3.1.6.dist-info/METADATA": strToU8("Name: browser-use\nVersion: 3.1.6\n"),
      "browser_use-3.1.6.dist-info/licenses/LICENSE": strToU8("MIT License\nCopyright (c) Test\n")
    });
    const wheelPath = path.join(root, "vendor/browser-use/browser_use-3.1.6-py3-none-any.whl");
    fs.writeFileSync(wheelPath, wheel);
    const wheelSha = createHash("sha256").update(wheel).digest("hex");

    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "public snapshot"], { cwd: root });

    const output = path.join(outputRoot, "uiwarden-source.tar.gz");
    const missingApproval = spawnSync(process.execPath, [path.join(root, "scripts/export-open-source-snapshot.mjs"), "--output", output], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, UIWARDEN_BROWSER_USE_WHEEL_SHA256: wheelSha }
    });
    assert.equal(missingApproval.status, 1);
    assert.match(missingApproval.stderr, /显式确认再分发授权/);

    const result = spawnSync(process.execPath, [path.join(root, "scripts/export-open-source-snapshot.mjs"), "--output", output], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        UIWARDEN_BROWSER_USE_WHEEL_SHA256: wheelSha,
        UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED: "true"
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.existsSync(`${output}.sha256`), true);
    const entries = execFileSync("tar", ["-tzf", output], { encoding: "utf8" });
    assert.match(entries, /uiwarden-source\/THIRD_PARTY_NOTICES\.md/);
    assert.match(entries, /uiwarden-source\/vendor\/browser-use\/browser_use-3\.1\.6-py3-none-any\.whl/);
    assert.doesNotMatch(entries, /test-reports|\.git\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
