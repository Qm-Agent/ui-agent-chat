const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TARGET_KINDS = new Set(["bundle-id", "path", "name", "process-id"]);

function normalizeNativeStreamTarget(value) {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind || "").trim();
  const targetValue = String(value.value || "").trim();
  if (!TARGET_KINDS.has(kind) || !targetValue || targetValue.length > 1024) return null;
  return { kind, value: targetValue };
}

class NativeWindowStream {
  constructor(options) {
    this.providerAppPath = options.providerAppPath;
    this.onFrame = options.onFrame;
    this.onStatus = options.onStatus;
    this.streamDirectory = null;
    this.targetKey = "";
    this.pollTimer = null;
    this.generation = 0;
    this.lastSequence = 0;
    this.frameTimes = [];
    this.currentTarget = null;
    this.restartScheduled = false;
    this.startedAt = 0;
    this.startupFailureReported = false;
  }

  async start(target) {
    const normalized = normalizeNativeStreamTarget(target);
    if (!normalized) throw new Error("原生画中画缺少有效的目标应用");
    if (process.platform !== "darwin") throw new Error("连续窗口画中画当前仅支持 macOS");
    const targetKey = `${normalized.kind}:${normalized.value}`;
    if (this.streamDirectory && this.targetKey === targetKey) return;
    this.stop();
    if (!fs.existsSync(this.providerAppPath)) {
      throw new Error(`未找到 macOS Provider：${this.providerAppPath}`);
    }

    const generation = ++this.generation;
    const streamDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-window-stream-"));
    this.streamDirectory = streamDirectory;
    this.targetKey = targetKey;
    this.currentTarget = normalized;
    this.restartScheduled = false;
    this.startedAt = Date.now();
    this.startupFailureReported = false;
    this.lastSequence = 0;
    this.frameTimes = [];
    this.onStatus?.({ status: "starting", error: "" });

    const launcher = spawn("/usr/bin/open", [
      "-n",
      this.providerAppPath,
      "--args",
      "--stream-dir", streamDirectory,
      "--app-kind", normalized.kind,
      "--app", normalized.value,
      "--fps", "20",
      "--max-width", "1280",
    ], {
      stdio: "ignore",
    });
    launcher.once("error", (error) => {
      if (generation !== this.generation) return;
      this.onStatus?.({ status: "failed", error: error.message });
    });
    this.schedulePoll(generation, 40);
  }

  schedulePoll(generation, delay) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll(generation);
    }, delay);
  }

  async poll(generation) {
    if (generation !== this.generation || !this.streamDirectory) return;
    const metadataPath = path.join(this.streamDirectory, "stream.json");
    try {
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
      if (metadata.status === "failed" || metadata.status === "target-closed") {
        this.onStatus?.({
          status: metadata.status,
          error: String(metadata.error || ""),
        });
        this.schedulePoll(generation, 250);
        return;
      }
      const sequence = Number(metadata.sequence || 0);
      if (metadata.status === "live" && sequence > this.lastSequence) {
        const jpeg = await fs.promises.readFile(path.join(this.streamDirectory, "latest-frame.jpg"));
        if (generation !== this.generation) return;
        this.lastSequence = sequence;
        const now = Date.now();
        this.frameTimes.push(now);
        this.frameTimes = this.frameTimes.filter((value) => now - value <= 1000);
        this.onFrame?.({
          dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          sequence,
          capturedAt: String(metadata.capturedAt || ""),
          width: Number(metadata.width || 0),
          height: Number(metadata.height || 0),
          fps: this.frameTimes.length,
          configuredFps: Number(metadata.configuredFps || 0),
          windowBounds: metadata.windowBounds,
          targetWindowChanged: metadata.targetWindowChanged === true,
        });
        this.onStatus?.({ status: "live", error: "" });
        this.startupFailureReported = false;
        if (metadata.targetWindowChanged === true) this.restartForFocusedWindow();
      }
    } catch (error) {
      if (
        error?.code === "ENOENT"
        && !this.startupFailureReported
        && Date.now() - this.startedAt >= 4_000
      ) {
        this.startupFailureReported = true;
        this.onStatus?.({
          status: "failed",
          error: "连续窗口画面未启动，请检查 UIWarden 的屏幕录制权限",
        });
      } else if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") {
        this.onStatus?.({ status: "failed", error: error.message || String(error) });
      }
    }
    this.schedulePoll(generation, 40);
  }

  restartForFocusedWindow() {
    if (this.restartScheduled || !this.currentTarget) return;
    this.restartScheduled = true;
    const target = { ...this.currentTarget };
    setTimeout(() => {
      if (!this.restartScheduled) return;
      this.stop();
      void this.start(target).catch((error) => {
        this.onStatus?.({ status: "failed", error: error.message || String(error) });
      });
    }, 180).unref?.();
  }

  stop() {
    this.generation += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const streamDirectory = this.streamDirectory;
    this.streamDirectory = null;
    this.targetKey = "";
    this.lastSequence = 0;
    this.frameTimes = [];
    this.currentTarget = null;
    this.restartScheduled = false;
    this.startedAt = 0;
    this.startupFailureReported = false;
    if (!streamDirectory) return;
    try {
      fs.writeFileSync(path.join(streamDirectory, "stop"), "");
    } catch {
      // The helper may already have exited and removed its temporary state.
    }
    setTimeout(() => {
      fs.rm(streamDirectory, { recursive: true, force: true }, () => undefined);
    }, 2500).unref?.();
  }
}

module.exports = {
  NativeWindowStream,
  normalizeNativeStreamTarget,
};
