import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47902").replace(/\/+$/, "");
const dataDir = process.argv[3];
assert.ok(dataDir, "data directory argument is required");
const storeFile = path.join(dataDir, "ui-operations", "tasks.json");
const backup = await fs.readFile(storeFile, "utf8");

try {
  await fs.writeFile(storeFile, "{corrupted-json", "utf8");
  const response = await fetch(`${baseUrl}/api/ui-operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: "不得覆盖损坏文件" })
  });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.match(body.error, /存储文件损坏.*停止写入/);
  assert.equal(await fs.readFile(storeFile, "utf8"), "{corrupted-json");
  console.log("ui operation corruption protection: PASS");
} finally {
  await fs.writeFile(storeFile, backup, "utf8");
}
