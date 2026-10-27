import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { capabilities } from "../../../browser-automation/src/runtime.mjs";

const schemaDir = path.resolve(import.meta.dirname, "../../../browser-automation/schemas");
const schemaNames = ["protocol", "session", "snapshot", "action", "manifest", "error"];
const schemas = Object.fromEntries(await Promise.all(schemaNames.map(async (name) => [
  name,
  JSON.parse(await fs.readFile(path.join(schemaDir, `${name}.schema.json`), "utf8"))
])));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validators = Object.fromEntries(schemaNames.map((name) => [name, ajv.compile(schemas[name])]));
const now = "2026-07-12T00:00:00.000Z";
const sessionId = "browser-11111111-2222-3333-4444-555555555555";
const snapshotId = "snapshot-11111111-2222-3333-4444-555555555555";
const targetId = "ABCDEF123456";

const samples = {
  protocol: capabilities(),
  session: {
    version: 1,
    runtimeVersion: "0.3.2",
    sessionId,
    runId: "run-1",
    cdpUrl: "http://127.0.0.1:47971",
    targetId,
    targetTitle: "Example",
    targetUrl: "https://example.com",
    controlMode: "agent-control",
    state: "active",
    currentSnapshotId: null,
    artifactDir: "/tmp/browser-rep",
    startedAt: now,
    finishedAt: null,
    stopReason: null,
    eventCount: 1,
    snapshotSequence: 0,
    actionCount: 0,
    screenshotCount: 0,
    captureGapCount: 0
  },
  snapshot: {
    version: 1,
    snapshotId,
    sessionId,
    sequence: 1,
    targetId,
    url: "https://example.com",
    title: "Example",
    readyState: "complete",
    viewport: { width: 1000, height: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
    text: "Apply",
    elements: [{
      elementId: "web-1111111111111111",
      tag: "button",
      role: "button",
      name: "Apply",
      secure: false,
      enabled: true,
      actions: ["click"],
      riskLevel: "normal",
      rect: { x: 10, y: 20, width: 80, height: 30 }
    }],
    screenshotPath: "/tmp/browser-rep/screenshots/frame_0001.png",
    captureGaps: [],
    capturedAt: now
  },
  action: {
    version: 1,
    actionId: "action-11111111-2222-3333-4444-555555555555",
    sessionId,
    sequence: 1,
    performedAt: now,
    kind: "click",
    targetId,
    snapshotId,
    elementId: "web-1111111111111111",
    targetName: "Apply",
    result: { clicked: true }
  },
  manifest: {
    artifactKind: "browser-rep",
    schemaVersion: 1,
    runId: "run-1",
    browserRunId: sessionId,
    runtimeVersion: "0.3.2",
    target: { cdpUrl: "http://127.0.0.1:47971", targetId, title: "Example", url: "https://example.com" },
    startedAt: now,
    finishedAt: now,
    stopReason: "completed",
    captureStopReason: "completed",
    eventCount: 3,
    snapshotCount: 1,
    actionCount: 1,
    screenshotCount: 1,
    captureGapCount: 0,
    captureStatus: "complete"
  },
  error: { ok: false, error: { code: "STALE_SNAPSHOT", message: "observe again", details: {} } }
};

for (const name of schemaNames) {
  const valid = validators[name](samples[name]);
  assert.equal(valid, true, `${name}: ${ajv.errorsText(validators[name].errors)}`);
}
assert.equal(validators.action({ ...samples.action, value: "must-not-be-recorded" }), false);
console.log(JSON.stringify({ ok: true, schemas: schemaNames, runtimeVersion: samples.protocol.runtimeVersion }));
