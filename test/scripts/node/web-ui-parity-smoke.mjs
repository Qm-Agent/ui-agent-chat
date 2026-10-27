import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const appUrl = String(process.argv[2] || "http://127.0.0.1:5174").replace(/\/$/, "");
const screenshotPath = process.argv[3] || "/tmp/uiwarden-web-parity.png";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-web-smoke-"));
const port = 47932;
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--window-size=1440,960",
  "--no-first-run",
  "--no-default-browser-check",
  `${appUrl}/quality`
], { stdio: "ignore" });

try {
  const target = await waitForTarget(port, appUrl);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await waitFor(cdp, `document.readyState === "complete" && document.querySelector(".qualityHeader h1")?.textContent?.trim() === "质量看板"`);
    await waitFor(cdp, `document.querySelectorAll(".qualityRunFilters select").length === 3`);
    assert.deepEqual(await evaluate(cdp, `[...document.querySelectorAll(".qualityRunFilters select")].map((node) => node.getAttribute("aria-label"))`), ["来源类型", "运行状态", "运行结果"]);
    await capture(cdp, screenshotPath.replace(/\.png$/i, "-quality.png"));

    await clickMenu(cdp, "配置中心");
    await waitFor(cdp, `document.querySelector(".config-center-header h1")?.textContent?.trim() === "配置中心"`);
    const configSections = await evaluate(cdp, `[...document.querySelectorAll(".config-center-tabs button")].map((node) => node.textContent?.trim())`);
    assert.ok(configSections.includes("浏览器与 Skill"), JSON.stringify(configSections));
    await evaluate(cdp, `document.querySelector(".config-center-tabs button:first-child")?.click()`);
    await waitFor(cdp, `location.pathname === "/config-center/browser-skill" && document.querySelector(".config-center-content .chat-header h1")?.textContent?.trim() === "浏览器与 Skill"`);
    await capture(cdp, screenshotPath.replace(/\.png$/i, "-config.png"));

    await clickMenu(cdp, "UI 操作");
    await waitFor(cdp, `document.querySelector(".operationPageHeader h1")?.textContent?.trim() === "UI 操作"`);
    await waitFor(cdp, `[...document.querySelectorAll(".operationPageHeader button")].some((node) => node.textContent?.includes("刷新") && !node.disabled)`);
    const embeddedMirrorAvailable = await evaluate(cdp, `Boolean(document.querySelector(".operationWebBrowserHeader")?.textContent?.includes("UIWarden-Browser 执行镜像"))`);
    if (embeddedMirrorAvailable) {
      assert.ok(await evaluate(cdp, `[...document.querySelectorAll(".operationWorkspaceTabs button")].some((node) => node.textContent?.includes("浏览器"))`));
      const mirrorHasImage = await evaluate(cdp, `Boolean(document.querySelector(".operationWebBrowserMirror img"))`);
      if (mirrorHasImage) await waitFor(cdp, `document.querySelector(".operationWebBrowserMirror img")?.naturalWidth > 0`);
      await capture(cdp, screenshotPath.replace(/\.png$/i, "-embedded-browser.png"));
    }
    await evaluate(cdp, `[...document.querySelectorAll(".operationPageHeader button")].find((node) => node.textContent?.includes("新对话"))?.click()`);
    await waitFor(cdp, `document.querySelectorAll('[aria-label="执行目标"] button').length === 2`);
    await waitFor(cdp, `[...document.querySelectorAll('[aria-label="执行目标"] button')].some((node) => node.classList.contains("active"))`);
    await evaluate(cdp, `[...document.querySelectorAll('[aria-label="执行目标"] button')].find((node) => node.textContent?.includes("浏览器"))?.click()`);
    const kernels = await evaluate(cdp, `[...document.querySelectorAll(".operationKernelField option")].map((node) => node.value)`);
    assert.deepEqual(kernels, ["playwright", "uiwarden-embedded"]);

    await capture(cdp, screenshotPath);

    await clickMenu(cdp, "评测实验室");
    await waitFor(cdp, `location.pathname === "/evaluation-lab" && document.querySelector(".evaluationHeader h1")?.textContent?.trim() === "评测实验室"`);
    const evaluationTabs = await evaluate(cdp, `[...document.querySelectorAll(".evaluationTabs button")].map((node) => node.textContent?.trim())`);
    assert.deepEqual(evaluationTabs, ["评测集", "评测方案", "结果中心"]);
    const evaluationTemplates = await evaluate(cdp, `[...document.querySelectorAll(".evaluationHeaderActions a")].map((node) => node.getAttribute("href"))`);
    assert.ok(evaluationTemplates.includes("/api/evaluation-lab/templates/json"), JSON.stringify(evaluationTemplates));
    assert.ok(evaluationTemplates.includes("/api/evaluation-lab/templates/xlsx"), JSON.stringify(evaluationTemplates));
    const evaluationScreenshotPath = screenshotPath.replace(/\.png$/i, "-evaluation-lab.png");
    await capture(cdp, evaluationScreenshotPath);

    console.log(JSON.stringify({
      ok: true,
      screenshotPath,
      evaluationScreenshotPath,
      configSections,
      kernels,
      evaluationTabs,
      embeddedMirrorAvailable
    }));
  } finally {
    cdp.close();
  }
} finally {
  chrome.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  await fs.rm(profileDir, { recursive: true, force: true });
}

async function clickMenu(cdp, label) {
  await evaluate(cdp, `[...document.querySelectorAll(".side-menu button")].find((node) => node.textContent?.includes(${JSON.stringify(label)}))?.click()`);
}

async function waitForTarget(portNumber, expectedUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json();
      const target = targets.find((item) => item.type === "page" && String(item.url || "").startsWith(expectedUrl));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome CDP startup timeout");
}

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`wait timeout: ${expression}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.value;
}

async function capture(cdp, outputPath) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
}
