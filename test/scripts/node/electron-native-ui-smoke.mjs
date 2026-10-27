import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
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

const options = parseArgs(process.argv.slice(2));
const cdpUrl = required(options, "cdp-url").replace(/\/$/, "");
const appUrl = required(options, "app-url").replace(/\/$/, "");
const screenshotPath = required(options, "screenshot");
const embeddedTaskName = `内置浏览器槽位 ${Date.now()}`;
const nativeStatus = await fetchJson(`${appUrl}/api/native-automation/status`);
const macProvider = nativeStatus.providers?.find((provider) => provider.providerId === "macos-accessibility");
const expectedPermissionDenied = macProvider?.data?.permission === "denied";

const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
const target = targets.find((item) => {
  const url = String(item.url || "").replace(/\/$/, "");
  return item.type === "page"
    && String(item.title || "").toLowerCase() === "uiwarden"
    && (url === appUrl || (url.startsWith(`${appUrl}/`) && !url.startsWith(`${appUrl}/api/`)));
});
assert.ok(target?.webSocketDebuggerUrl, `UIWarden renderer not found: ${targets.map((item) => item.url).join(", ")}`);

const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, `document.readyState === "complete" && Boolean(window.uiwardenDesktop?.embeddedBrowser)`);
  assert.equal(await evaluate(cdp, `document.querySelector(".brand-title")?.textContent?.trim()`), "UIWarden");
  assert.equal(await evaluate(cdp, `document.title`), "UIWarden");
  assert.equal(await evaluate(cdp, "Boolean(window.uiwardenDesktop?.embeddedBrowser)"), true);
  assert.equal(await clickButton(cdp, "测试任务"), true);
  await waitFor(cdp, `document.querySelector(".chat-header h1")?.textContent?.trim() === "测试任务"`);
  assert.equal(await evaluate(cdp, `!document.body.innerText.includes("对话任务")`), true);
  if (!await evaluate(cdp, `Boolean(document.querySelector(".kernel-picker select"))`)) {
    assert.equal(await clickButton(cdp, "新对话"), true);
    await waitFor(cdp, `Boolean(document.querySelector(".kernel-picker select"))`);
  }
  const testKernelOptions = await evaluate(cdp, `(() => {
    const picker = document.querySelector(".kernel-picker select");
    return picker ? [...picker.options].map((option) => ({ value: option.value, text: option.textContent?.trim() })) : [];
  })()`);
  assert.deepEqual(testKernelOptions, [
    { value: "playwright", text: "Playwright 配套 Chromium（默认）" },
    { value: "skill-profile", text: "Skill 配置浏览器（Chromium 系）" },
    { value: "external-cdp", text: "外部 CDP" },
    { value: "uiwarden-embedded", text: "客户端内置 gui-browser" },
  ]);
  assert.equal(await clickButton(cdp, "配置中心"), true);
  await waitFor(cdp, `document.querySelector(".config-center-header h1")?.textContent?.trim() === "配置中心"`);
  const configSections = await evaluate(cdp, `[...document.querySelectorAll(".config-center-tabs button")].map((button) => button.textContent?.trim())`);
  assert.deepEqual(configSections, ["浏览器与 Skill", "GUI Runtime", "环境配置", "Host 管理", "模型与执行底座", "通知管理", "依赖环境"]);
  const configScroll = await evaluate(cdp, `(() => {
    const content = document.querySelector(".config-center-content");
    const style = getComputedStyle(content);
    return { clientHeight: content?.clientHeight ?? 0, scrollHeight: content?.scrollHeight ?? 0, overflowY: style.overflowY };
  })()`);
  assert.ok(configScroll.clientHeight > 0, JSON.stringify(configScroll));
  assert.ok(["auto", "scroll"].includes(configScroll.overflowY), JSON.stringify(configScroll));
  assert.equal(await clickButtonContaining(cdp, "浏览器与 Skill"), true);
  await waitFor(cdp, `Boolean(document.querySelector(".browser-config-block"))`);
  const firefoxButton = await evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll(".browser-detected button")];
    const button = buttons.find((item) => item.textContent?.includes("Firefox"));
    if (!button) return { detected: false, labels: buttons.map((item) => item.textContent?.trim()) };
    const enabled = !button.disabled;
    button.click();
    return { detected: true, enabled };
  })()`);
  if (firefoxButton.detected) {
    assert.equal(firefoxButton.enabled, true);
    await waitFor(cdp, `(() => {
      const profile = [...document.querySelectorAll(".browser-config-row")].find((row) => row.textContent?.includes("浏览器 Profile"))?.querySelector("select")?.value;
      const path = [...document.querySelectorAll(".browser-config-row")].find((row) => row.textContent?.includes("BU_FIREFOX_PATH"))?.querySelector("input")?.value || "";
      return profile === "firefox" && path.includes("Firefox.app");
    })()`);
  }
  const uiwardenButton = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll(".browser-detected button")].find((item) => item.textContent?.includes("UIWarden-Browser"));
    if (!button) return { detected: false };
    const enabled = !button.disabled;
    button.click();
    return { detected: true, enabled };
  })()`);
  if (uiwardenButton.detected) {
    assert.equal(uiwardenButton.enabled, true);
    await waitFor(cdp, `[...document.querySelectorAll(".browser-config-row")].find((row) => row.textContent?.includes("UI 操作独立浏览器路径"))?.querySelector("input")?.value.includes("UIWarden-Browser")`);
    assert.equal(await evaluate(cdp, `[...document.querySelectorAll(".browser-detected button")].find((item) => item.textContent?.includes("UIWarden-Browser"))?.querySelector("svg") === null`), true);
  }
  if (firefoxButton.detected) {
    const finalFirefoxConfig = await evaluate(cdp, `(() => ({
      profile: document.querySelector(".browser-config-block .browser-config-row select")?.value || "",
      path: [...document.querySelectorAll(".browser-config-block .browser-config-row")]
        .find((row) => row.querySelector(":scope > span")?.textContent?.includes("BU_FIREFOX_PATH"))
        ?.querySelector("input")?.value || ""
    }))()`);
    assert.equal(finalFirefoxConfig.profile, "firefox", JSON.stringify(finalFirefoxConfig));
    assert.match(finalFirefoxConfig.path, /Firefox\.app/, JSON.stringify(finalFirefoxConfig));
  }
  const configScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const configScreenshotPath = screenshotPath.replace(/\.png$/i, "-config-center.png");
  await fs.mkdir(path.dirname(configScreenshotPath), { recursive: true });
  await fs.writeFile(configScreenshotPath, Buffer.from(configScreenshot.data, "base64"));

  assert.equal(await clickButton(cdp, "UI 操作"), true);
  await waitFor(cdp, `document.querySelector("h1")?.textContent?.trim() === "UI 操作"`);
  assert.equal(await clickButton(cdp, "新对话"), true);
  await waitFor(cdp, `(() => {
    const create = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "新对话");
    return create && !create.disabled
      && document.querySelector('[aria-label="执行目标"] button.active')?.textContent?.trim() === "电脑桌面";
  })()`);

  assert.equal(await evaluate(cdp, `document.querySelector('[aria-label="执行目标"] button.active')?.textContent?.trim()`), "电脑桌面");
  await waitFor(cdp, `document.body.innerText.includes("Agent 自动选择应用")`);
  assert.equal(await clickButton(cdp, "浏览器"), true);
  await waitFor(cdp, `Boolean(document.querySelector(".operationKernelField select"))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".operationKernelField select")?.value`), "playwright");
  const operationModeAlignment = await evaluate(cdp, `(() => {
    const kernel = document.querySelector(".operationKernelField select")?.getBoundingClientRect();
    const environment = [...document.querySelectorAll(".operationModeBar label")]
      .find((label) => [...label.children].some((child) => child.tagName === "SPAN" && child.textContent?.trim() === "业务环境"))
      ?.querySelector("select")?.getBoundingClientRect();
    return kernel && environment ? {
      topDelta: Math.abs(kernel.top - environment.top),
      heightDelta: Math.abs(kernel.height - environment.height)
    } : null;
  })()`);
  assert.ok(operationModeAlignment, JSON.stringify(operationModeAlignment));
  assert.ok(operationModeAlignment.topDelta <= 1, JSON.stringify(operationModeAlignment));
  assert.ok(operationModeAlignment.heightDelta <= 1, JSON.stringify(operationModeAlignment));
  assert.deepEqual(await evaluate(cdp, `Array.from(document.querySelectorAll(".operationKernelField select option")).map((option) => ({ value: option.value, text: option.textContent.trim() }))`), [
    { value: "playwright", text: "Playwright 配套 Chromium（默认）" },
    { value: "uiwarden-embedded", text: "客户端内置 gui-browser" },
    { value: "external-cdp", text: "用户浏览器桥接" },
  ]);
  const bridgeTaskGroupBefore = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.operationExperienceBar button')]
      .find((node) => node.textContent.includes('浏览器桥接标签组'));
    return button ? {
      disabled: button.disabled,
      checked: button.getAttribute('aria-checked'),
      title: button.title
    } : null;
  })()`);
  assert.deepEqual(bridgeTaskGroupBefore, {
    disabled: true,
    checked: "false",
    title: "切换为“用户浏览器桥接”内核后可用"
  });
  await setSelectValue(cdp, ".operationKernelField select", "external-cdp");
  await waitFor(cdp, `(() => {
    const button = [...document.querySelectorAll('.operationExperienceBar button')]
      .find((node) => node.textContent.includes('浏览器桥接标签组'));
    return button && !button.disabled;
  })()`);
  await waitFor(cdp, `Boolean(document.querySelector(".operationCdpBrowserSelect select")?.value)`);
  const cdpBrowserState = await evaluate(cdp, `(() => {
    const select = document.querySelector(".operationCdpBrowserSelect select");
    return {
      value: select?.value || "",
      options: [...(select?.options || [])].map((option) => option.textContent?.trim()),
      note: document.querySelector(".operationCdpBrowserSelect em")?.textContent?.trim() || ""
    };
  })()`);
  assert.ok(cdpBrowserState.value, JSON.stringify(cdpBrowserState));
  assert.ok(cdpBrowserState.options.some((label) => label?.includes("UIWarden-Browser") && label.includes("切换内置内核")), JSON.stringify(cdpBrowserState));
  assert.ok(cdpBrowserState.options.some((label) => label?.includes("Firefox") && label.includes("切换 Firefox Profile")), JSON.stringify(cdpBrowserState));
  assert.ok(cdpBrowserState.options.some((label) => label?.includes("Google Chrome")), JSON.stringify(cdpBrowserState));
  assert.ok(cdpBrowserState.note, JSON.stringify(cdpBrowserState));
  const cdpPanelScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(screenshotPath.replace(/\.png$/i, "-cdp-panel.png"), Buffer.from(cdpPanelScreenshot.data, "base64"));
  assert.equal(await clickButton(cdp, "电脑桌面"), true);
  if (expectedPermissionDenied) {
    await waitFor(cdp, `document.body.innerText.includes("电脑桌面权限未授权")`);
  }
  const backgroundModeBefore = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll(".operationExperienceBar button")]
      .find((node) => node.textContent.includes("后台执行"));
    return button ? {
      disabled: button.disabled,
      checked: button.getAttribute("aria-checked"),
      subtitle: button.querySelector("em")?.textContent?.trim(),
      title: button.title
    } : null;
  })()`);
  assert.deepEqual(backgroundModeBefore, {
    disabled: false,
    checked: "false",
    subtitle: "不抢焦点 · 窗口可见",
    title: "使用 AX 语义动作和目标 PID 定向事件，禁止激活应用、移动系统鼠标或占用剪贴板"
  });
  assert.equal(await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll(".operationExperienceBar button")]
      .find((node) => node.textContent.includes("后台执行"));
    button?.click();
    return Boolean(button);
  })()`), true);
  await waitFor(cdp, `(() => {
    const button = [...document.querySelectorAll(".operationExperienceBar button")]
      .find((node) => node.textContent.includes("后台执行"));
    return button?.getAttribute("aria-checked") === "true";
  })()`);

  const formState = await evaluate(cdp, `(() => ({
    hasConversation: Boolean(document.querySelector(".operationConversation")),
    hasComposer: Boolean(document.querySelector(".operationComposer textarea")),
    hasAutoTarget: document.body.innerText.includes("Agent 自动选择应用"),
    hasRunningApp: document.body.innerText.includes("运行应用"),
    hasLegacyModal: Boolean(document.querySelector(".qualityModalPanel")),
    providerLabel: document.body.innerText.includes("macOS Accessibility"),
    permissionDenied: document.body.innerText.includes("电脑桌面权限未授权")
  }))()`);
  assert.equal(formState.hasConversation, true);
  assert.equal(formState.hasComposer, true);
  assert.equal(formState.hasAutoTarget, true);
  assert.equal(formState.hasRunningApp, false);
  assert.equal(formState.hasLegacyModal, false);
  assert.equal(formState.providerLabel, true);
  assert.equal(formState.permissionDenied, expectedPermissionDenied);

  const geometry = await evaluate(cdp, `(() => {
    const rect = document.querySelector(".operationChatLayout")?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      left: rect?.left ?? -1,
      right: rect?.right ?? -1,
      top: rect?.top ?? -1,
      bottom: rect?.bottom ?? -1
    };
  })()`);
  assert.ok(geometry.scrollWidth <= geometry.width);
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.left < geometry.right);
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height && geometry.top < geometry.bottom);

  await cdp.send("Page.bringToFront");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const embeddedTaskResponse = await fetch(`${appUrl}/api/ui-operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: embeddedTaskName,
      instruction: "打开本地健康页",
      executionTarget: { kind: "browser", browserKernel: "uiwarden-embedded" },
      approvalMode: "manual-finalize"
    })
  });
  assert.equal(embeddedTaskResponse.status, 201, await embeddedTaskResponse.text());
  assert.equal(await clickButton(cdp, "刷新"), true);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(embeddedTaskName)})`);
  assert.equal(await clickButtonContaining(cdp, embeddedTaskName), true);
  await waitFor(cdp, `Boolean(document.querySelector(".operationBrowserSlot"))`);
  const embeddedGeometry = await evaluate(cdp, `(() => {
    const slot = document.querySelector(".operationBrowserSlot")?.getBoundingClientRect();
    const toolbar = document.querySelector(".operationBrowserToolbar")?.getBoundingClientRect();
    return { width: slot?.width ?? 0, height: slot?.height ?? 0, top: slot?.top ?? -1, toolbarBottom: toolbar?.bottom ?? -1 };
  })()`);
  assert.ok(embeddedGeometry.width >= 300, JSON.stringify(embeddedGeometry));
  assert.ok(embeddedGeometry.height >= 250, JSON.stringify(embeddedGeometry));
  assert.ok(embeddedGeometry.top >= embeddedGeometry.toolbarBottom, JSON.stringify(embeddedGeometry));
  await evaluate(cdp, `(async () => window.uiwardenDesktop.embeddedBrowser.navigate(${JSON.stringify(`${appUrl}/api/health`)}))()`);
  await waitFor(cdp, `(async () => {
    const state = await window.uiwardenDesktop.embeddedBrowser.getState();
    return state.visible && state.tabs.find((tab) => tab.id === state.activeTabId)?.url.includes("/api/health");
  })()`, 10_000);
  const embeddedTargets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const embeddedTarget = embeddedTargets.find((item) => String(item.url || "").includes("/api/health"));
  assert.ok(embeddedTarget?.webSocketDebuggerUrl, JSON.stringify(embeddedTargets.map((item) => item.url)));
  const embeddedCdp = await CdpClient.connect(embeddedTarget.webSocketDebuggerUrl);
  try {
    await embeddedCdp.send("Runtime.enable");
    await waitFor(embeddedCdp, `document.body.innerText.includes('"ok"')`, 10_000);
  } finally {
    embeddedCdp.close();
  }
  console.log(`electron native UI smoke: PASS permissionDenied=${formState.permissionDenied} firefox=${JSON.stringify(firefoxButton)} screenshot=${screenshotPath}`);
} catch (error) {
  throw error;
} finally {
  cdp.close();
}

function labelSelectValue(label) {
  return `(() => [...document.querySelectorAll("label")].find((item) => item.querySelector("span")?.textContent?.trim() === ${JSON.stringify(label)})?.querySelector("select")?.value)()`;
}

async function clickButton(cdp, label) {
  return evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
}

async function clickButtonContaining(cdp, label) {
  return evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(${JSON.stringify(label)}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
}

async function setSelectValue(cdp, selector, value) {
  return evaluate(cdp, `(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select || select.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function selectOptionContaining(cdp, selector, label) {
  return evaluate(cdp, `(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    const option = [...(select?.options || [])].find((item) => item.textContent?.includes(${JSON.stringify(label)}));
    if (!select || !option || option.disabled || select.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function waitFor(cdp, condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `(async () => Boolean(await (${condition})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${condition}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

function parseArgs(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    result.set(String(args[index]).replace(/^--/, ""), args[index + 1]);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status} ${url}`);
  return response.json();
}
