import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { listCdpTargets, withTarget, evaluate } from "../../../browser-automation/src/cdp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(projectRoot, "desktop/package.json"));
const electronBinary = require("electron");
const desktopEntry = path.join(projectRoot, "desktop");
const packagedAppBinary = String(process.env.UIWARDEN_ELECTRON_APP || "").trim();
const electronCommand = packagedAppBinary || electronBinary;
const electronArgs = packagedAppBinary ? [] : [desktopEntry];
const runtimeNodeDir = path.join(projectRoot, "desktop/runtime");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-pip-smoke-"));
const apiPort = await freePort();
let embeddedPort = await freePort();
while (embeddedPort === apiPort) embeddedPort = await freePort();
const logs = [];
const child = spawn(electronCommand, electronArgs, {
  cwd: projectRoot,
  env: {
    ...process.env,
    PATH: `${runtimeNodeDir}${path.delimiter}${process.env.PATH || ""}`,
    UI_AGENT_DESKTOP_E2E: "true",
    UI_AGENT_DESKTOP_API_PORT: String(apiPort),
    UI_AGENT_EMBEDDED_CDP_PORT: String(embeddedPort),
    UI_AGENT_DESKTOP_DATA_DIR: dataDir
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => logs.push(String(chunk)));
child.stderr.on("data", (chunk) => logs.push(String(chunk)));

try {
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const electronCdp = `http://127.0.0.1:${embeddedPort}`;
  await waitFor(async () => (await fetch(`${apiBase}/api/health`)).ok, 60_000, "desktop API");
  const mainTarget = await waitForTarget(
    electronCdp,
    (target) => target.type === "page" && target.url.startsWith(apiBase)
  );

  const snapshotUrl = await runInTarget(electronCdp, mainTarget.targetId, `
    (() => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.fillStyle = "#d94747";
      context.fillRect(0, 0, 400, 400);
      context.fillStyle = "#2876c7";
      context.fillRect(400, 0, 400, 400);
      return canvas.toDataURL("image/png");
    })()
  `);
  const snapshotState = await runInTarget(electronCdp, mainTarget.targetId, `
    window.uiwardenDesktop.pictureInPicture.open({
      source: "snapshot",
      title: "电脑桌面验收",
      subtitle: "只读镜像",
      status: "running",
      snapshotUrl: ${JSON.stringify(snapshotUrl)}
    })
  `);
  assert.equal(snapshotState.open, true);
  assert.equal(snapshotState.source, "snapshot");
  assert.equal(snapshotState.interactive, false);

  let pipTarget = await waitForTarget(
    electronCdp,
    (target) => target.type === "page" && target.url.endsWith("/pip.html")
  );
  const snapshotDom = await runInTarget(electronCdp, pipTarget.targetId, `
    new Promise((resolve) => {
      const image = document.querySelector("[data-role='snapshot']");
      const finish = () => resolve({
        title: document.querySelector("[data-role='title']").textContent,
        source: document.querySelector("[data-role='surface']").dataset.source,
        hidden: image.hidden,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        objectFit: getComputedStyle(image).objectFit,
        renderedWidth: image.getBoundingClientRect().width,
        renderedHeight: image.getBoundingClientRect().height,
        controlsInside: [
          document.querySelector("[data-role='status']"),
          document.querySelector("[data-action='return']"),
          document.querySelector("[data-action='close']")
        ].every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
        })
      });
      if (image.complete) finish(); else image.addEventListener("load", finish, { once: true });
    })
  `);
  assert.deepEqual(snapshotDom, {
    title: "电脑桌面验收",
    source: "snapshot",
    hidden: false,
    naturalWidth: 800,
    naturalHeight: 400,
    objectFit: "contain",
    renderedWidth: 340,
    renderedHeight: 170,
    controlsInside: true
  });
  const emptyState = await runInTarget(electronCdp, mainTarget.targetId, `
    window.uiwardenDesktop.pictureInPicture.open({
      source: "snapshot",
      title: "等待新任务",
      subtitle: "任务仍在准备",
      status: "running",
      snapshotUrl: "",
      placeholder: "等待新的执行画面"
    })
  `);
  assert.equal(emptyState.snapshotUrl, "");
  const emptyDom = await runInTarget(electronCdp, pipTarget.targetId, `
    (() => {
      const image = document.querySelector("[data-role='snapshot']");
      const empty = document.querySelector("[data-role='empty']");
      return {
        imageHidden: image.hidden,
        imageDisplay: getComputedStyle(image).display,
        imageSource: image.getAttribute("src"),
        emptyHidden: empty.hidden,
        emptyText: empty.textContent
      };
    })()
  `);
  assert.deepEqual(emptyDom, {
    imageHidden: true,
    imageDisplay: "none",
    imageSource: null,
    emptyHidden: false,
    emptyText: "等待新的执行画面"
  });
  const mainVisibility = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "document.visibilityState"
  );
  assert.equal(mainVisibility, "visible");
  const focusState = await runInTarget(
    electronCdp,
    pipTarget.targetId,
    "window.uiwardenPictureInPicture.focusMainWindow()"
  );
  assert.equal(focusState.open, true);
  assert.equal(
    (await listCdpTargets(electronCdp)).some((target) => target.url.endsWith("/pip.html")),
    true
  );
  if (process.env.PIP_SCREENSHOT_PATH) {
    await captureTarget(electronCdp, pipTarget.targetId, process.env.PIP_SCREENSHOT_PATH);
  }
  const closedSnapshotState = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "window.uiwardenDesktop.pictureInPicture.close()"
  );
  assert.equal(closedSnapshotState.open, false);
  assert.equal(closedSnapshotState.closeReason, "user");
  await waitFor(
    async () => !(await listCdpTargets(electronCdp)).some((target) => target.url.endsWith("/pip.html")),
    8_000,
    "snapshot picture-in-picture close"
  );
  const rapidToggleResults = await runInTarget(electronCdp, mainTarget.targetId, `
    Promise.allSettled(Array.from({ length: 8 }, () => [
      window.uiwardenDesktop.pictureInPicture.open({
        source: "snapshot",
        title: "连续开关验收",
        subtitle: "IPC 生命周期",
        status: "running",
        snapshotUrl: ${JSON.stringify(snapshotUrl)}
      }),
      window.uiwardenDesktop.pictureInPicture.close()
    ]).flat())
  `);
  assert.equal(rapidToggleResults.filter((result) => result.status === "rejected").length, 0);
  const rapidToggleState = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "window.uiwardenDesktop.pictureInPicture.getState()"
  );
  assert.equal(rapidToggleState.open, false);
  await waitFor(
    async () => !(await listCdpTargets(electronCdp)).some((target) => target.url.endsWith("/pip.html")),
    8_000,
    "rapid picture-in-picture toggles"
  );

  if (process.env.NATIVE_PIP_TARGET_PID) {
    const nativeState = await runInTarget(electronCdp, mainTarget.targetId, `
      window.uiwardenDesktop.pictureInPicture.open({
        source: "native-stream",
        title: "计算器",
        subtitle: "实时窗口",
        status: "running",
        nativeTarget: { kind: "process-id", value: ${JSON.stringify(process.env.NATIVE_PIP_TARGET_PID)} }
      })
    `);
    assert.equal(nativeState.source, "native-stream");
    pipTarget = await waitForTarget(
      electronCdp,
      (target) => target.type === "page" && target.url.endsWith("/pip.html")
    );
    const nativeDom = await waitFor(() => runInTarget(electronCdp, pipTarget.targetId, `
      (() => {
        const image = document.querySelector("[data-role='snapshot']");
        const live = document.querySelector("[data-role='live']");
        return image.naturalWidth > 0 && live.dataset.status === "live"
          ? {
              width: image.naturalWidth,
              height: image.naturalHeight,
              renderedWidth: image.getBoundingClientRect().width,
              renderedHeight: image.getBoundingClientRect().height,
              live: live.textContent,
              interactionHidden: document.querySelector("[data-action='interaction']").hidden
            }
          : null;
      })()
    `), 12_000, "native picture-in-picture frame");
    assert.equal(nativeDom.width > 0, true);
    assert.equal(nativeDom.height > 0, true);
    assert.equal(nativeDom.renderedWidth <= 340, true);
    assert.equal(nativeDom.renderedHeight <= 186, true);
    assert.equal(
      Math.abs((nativeDom.renderedWidth / nativeDom.renderedHeight) - (nativeDom.width / nativeDom.height)) < 0.02,
      true
    );
    assert.equal(nativeDom.live, "20 FPS");
    assert.equal(nativeDom.interactionHidden, true);
    if (process.env.NATIVE_PIP_SCREENSHOT_PATH) {
      await captureTarget(electronCdp, pipTarget.targetId, process.env.NATIVE_PIP_SCREENSHOT_PATH);
    }
    await runInTarget(electronCdp, mainTarget.targetId, "window.uiwardenDesktop.pictureInPicture.close()");
    await waitFor(
      async () => !(await listCdpTargets(electronCdp)).some((target) => target.url.endsWith("/pip.html")),
      8_000,
      "native picture-in-picture close"
    );
  }

  const before = await runInTarget(electronCdp, mainTarget.targetId, `
    (async () => {
      await window.uiwardenDesktop.embeddedBrowser.setBounds({ x: 500, y: 120, width: 640, height: 480 });
      await window.uiwardenDesktop.embeddedBrowser.setVisible(true);
      await window.uiwardenDesktop.embeddedBrowser.navigate("${apiBase}/api/health");
      return window.uiwardenDesktop.embeddedBrowser.getState();
    })()
  `);
  const targetId = before.activeTabId;
  assert.ok(targetId);

  const liveState = await runInTarget(electronCdp, mainTarget.targetId, `
    window.uiwardenDesktop.pictureInPicture.open({
      source: "embedded-browser",
      title: "内置浏览器验收",
      subtitle: "实时可交互",
      status: "running"
    })
  `);
  assert.equal(liveState.open, true);
  assert.equal(liveState.interactive, true);
  pipTarget = await waitForTarget(
    electronCdp,
    (target) => target.type === "page" && target.url.endsWith("/pip.html")
  );
  const during = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "window.uiwardenDesktop.embeddedBrowser.getState()"
  );
  assert.equal(during.activeTabId, targetId);
  assert.equal(during.presentationMode, "picture-in-picture");
  const embeddedMainVisibility = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "document.visibilityState"
  );
  assert.equal(embeddedMainVisibility, "visible");
  const embeddedPreview = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "window.uiwardenDesktop.embeddedBrowser.capturePreview()"
  );
  assert.match(embeddedPreview.dataUrl, /^data:image\/png;base64,/);
  assert.equal(embeddedPreview.width > 0, true);
  assert.equal(embeddedPreview.height > 0, true);

  await runInTarget(
    electronCdp,
    pipTarget.targetId,
    "window.uiwardenPictureInPicture.close()"
  ).catch((error) => {
    if (error?.code !== "TARGET_GONE") throw error;
  });
  await waitFor(
    async () => !(await listCdpTargets(electronCdp)).some((target) => target.url.endsWith("/pip.html")),
    8_000,
    "live picture-in-picture close"
  );
  const after = await runInTarget(
    electronCdp,
    mainTarget.targetId,
    "window.uiwardenDesktop.embeddedBrowser.getState()"
  );
  assert.equal(after.activeTabId, targetId);
  assert.equal(after.presentationMode, "inline");
  assert.equal(after.tabs.find((tab) => tab.id === targetId)?.url, `${apiBase}/api/health`);

  console.log(JSON.stringify({
    ok: true,
    snapshot: snapshotDom,
    mainVisibilityWhileOpen: mainVisibility,
    pictureInPictureOpenAfterFocusMain: focusState.open,
    rapidToggleCalls: rapidToggleResults.length,
    embeddedTargetId: targetId,
    embeddedMainVisibilityWhileOpen: embeddedMainVisibility,
    embeddedPreviewSize: `${embeddedPreview.width}x${embeddedPreview.height}`,
    restoredPresentation: after.presentationMode
  }, null, 2));
} catch (error) {
  console.error(logs.join("").slice(-8_000));
  throw error;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  await fs.rm(dataDir, { recursive: true, force: true });
}

async function runInTarget(cdpUrl, targetId, expression) {
  return withTarget(cdpUrl, targetId, (client) => evaluate(client, expression));
}

async function captureTarget(cdpUrl, targetId, outputPath) {
  const screenshot = await withTarget(cdpUrl, targetId, (client) =>
    client.send("Page.captureScreenshot", { format: "png", fromSurface: true })
  );
  await fs.writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
}

async function waitForTarget(cdpUrl, predicate) {
  return waitFor(async () => (await listCdpTargets(cdpUrl)).find(predicate), 12_000, "CDP target");
}

async function waitFor(operation, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
