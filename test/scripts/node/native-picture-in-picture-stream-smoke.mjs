import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("native picture-in-picture stream smoke: SKIP non-macOS");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { NativeWindowStream } = require("../../../desktop/native-window-stream.cjs");
const providerAppPath = path.join(
  root,
  "native-automation",
  "target",
  "native-provider",
  "dt-gui-computer Provider.app"
);

function calculatorProcessIds() {
  try {
    return execFileSync("/usr/bin/pgrep", ["-x", "Calculator"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

const existingProcessIds = new Set(calculatorProcessIds());
execFileSync("/usr/bin/open", ["-g", "-a", "Calculator"]);
await new Promise((resolve) => setTimeout(resolve, 800));
const processId = calculatorProcessIds()[0];
assert.match(processId, /^\d+$/);
const ownsCalculatorProcess = !existingProcessIds.has(processId);

let latestFrame;
let status;
const stream = new NativeWindowStream({
  providerAppPath,
  onFrame: (frame) => { latestFrame = frame; },
  onStatus: (value) => { status = value; },
});

try {
  await stream.start({ kind: "process-id", value: processId });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && Number(latestFrame?.sequence || 0) < 2) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.status, "live", JSON.stringify(status));
  assert.match(latestFrame?.dataUrl || "", /^data:image\/jpeg;base64,/);
  assert.equal(latestFrame?.configuredFps, 20, JSON.stringify(latestFrame));
  assert.equal(Number(latestFrame?.sequence || 0) >= 2, true, JSON.stringify(latestFrame));
  assert.equal(Number(latestFrame?.windowBounds?.width || 0) > 0, true);
  assert.equal(Number(latestFrame?.windowBounds?.height || 0) > 0, true);
  console.log(JSON.stringify({
    ok: true,
    fps: latestFrame.fps,
    configuredFps: latestFrame.configuredFps,
    frame: {
      width: latestFrame.width,
      height: latestFrame.height,
      sequence: latestFrame.sequence,
    },
    windowBounds: latestFrame.windowBounds,
  }, null, 2));
} finally {
  stream.stop();
  if (ownsCalculatorProcess) {
    try {
      process.kill(Number(processId), "SIGTERM");
    } catch {
      // The fixture application may already have exited.
    }
  }
}
