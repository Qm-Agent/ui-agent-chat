import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInside, resolveContainedRegularFile } from "../../server/src/safeFilePath.js";

test("isPathInside rejects the root and lexical traversal", () => {
  const root = path.resolve("/tmp/uiwarden-root");
  assert.equal(isPathInside(root, path.join(root, "artifact.txt")), true);
  assert.equal(isPathInside(root, root), false);
  assert.equal(isPathInside(root, path.resolve(root, "../secret.txt")), false);
});

test("resolveContainedRegularFile accepts only files whose real path stays inside the root", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires elevated privileges");
    return;
  }

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-safe-file-"));
  const root = path.join(parent, "workspace");
  const inside = path.join(root, "artifacts", "result.txt");
  const outside = path.join(parent, "secret.txt");
  const outsideLink = path.join(root, "artifacts", "outside-link.txt");
  const insideLink = path.join(root, "artifacts", "inside-link.txt");
  await fs.mkdir(path.dirname(inside), { recursive: true });
  await fs.writeFile(inside, "result", "utf8");
  await fs.writeFile(outside, "secret", "utf8");
  await fs.symlink(outside, outsideLink);
  await fs.symlink(inside, insideLink);

  try {
    assert.equal(await resolveContainedRegularFile(root, inside), await fs.realpath(inside));
    assert.equal(await resolveContainedRegularFile(root, insideLink), await fs.realpath(inside));
    assert.equal(await resolveContainedRegularFile(root, outsideLink), undefined);
    assert.equal(await resolveContainedRegularFile(root, outside), undefined);
    assert.equal(await resolveContainedRegularFile(root, path.join(root, "missing.txt")), undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
