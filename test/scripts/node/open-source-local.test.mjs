import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  describeEnvKey,
  dtcoderStandardCandidates,
  findExecutable,
  parseDotEnvKeys
} from "../../../scripts/open-source-local.mjs";

test("dotenv inspection returns names without values", () => {
  const source = [
    "# ignored",
    "PORT=8787",
    "export ANTHROPIC_API_KEY=must-not-leak",
    "TRACKER_SECRET = another-secret",
    "PORT=9999"
  ].join("\n");
  const keys = parseDotEnvKeys(source);
  assert.deepEqual(keys, ["PORT", "ANTHROPIC_API_KEY", "TRACKER_SECRET"]);
  assert.equal(keys.join(",").includes("must-not-leak"), false);
  assert.deepEqual(describeEnvKey("ANTHROPIC_API_KEY"), { key: "ANTHROPIC_API_KEY", sensitive: true });
  assert.deepEqual(describeEnvKey("PORT"), { key: "PORT", sensitive: false });
});

test("doctor discovery includes official macOS program directories", () => {
  const candidates = dtcoderStandardCandidates("/Users/example", "darwin", {});
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiwork"));
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiworkcn"));
  assert.ok(candidates.includes("/Users/example/.agentix/bin/aiworkcli"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/internal/current/bin/aiwork"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/external/current/bin/aiworkcn"));
  assert.ok(candidates.includes("/Users/example/Library/Application Support/Agentix/program/global/current/bin/aiworkcli"));
  assert.ok(dtcoderStandardCandidates().length >= 2);
});

test("runtime detection honors an executable explicit path and rejects a missing path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-runtime-"));
  const binary = path.join(root, "aiworkcn");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    assert.equal(await findExecutable(["aiwork"], { UI_AGENT_AIWORK_BIN: binary, UI_AGENT_DTCODER_BIN: "/missing/legacy", PATH: "" }), binary);
    assert.equal(await findExecutable(["aiworkcn"], { UI_AGENT_DTCODER_BIN: binary, PATH: "" }), binary);
    assert.equal(await findExecutable(["aiworkcn"], { UI_AGENT_DTCODER_BIN: path.join(root, "missing"), PATH: "" }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
