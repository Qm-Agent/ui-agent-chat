import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.UIWARDEN_BASE_URL || "http://127.0.0.1:8891";
const expectDesktop = process.env.UIWARDEN_EXPECT_DESKTOP === "true";
const existingTasks = await fetch(`${baseUrl}/api/ui-operations`).then((response) => response.json());
const existingTaskIds = new Set(existingTasks.map((task) => task.id));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent: expectDesktop
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/38.8.6 Chrome/140.0.0.0 Safari/537.36"
    : undefined
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
const page = await context.newPage();

try {
  await page.goto(`${baseUrl}/ui-operations`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "新对话" }).click();

  await page.waitForFunction(async (knownIds) => {
    const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
    return currentTasks.some((task) => !knownIds.includes(task.id) && Boolean(task.conversationSessionId));
  }, [...existingTaskIds]);

  const tasks = await page.evaluate(async () => fetch("/api/ui-operations").then((response) => response.json()));
  const createdTask = tasks.find((task) => !existingTaskIds.has(task.id));
  assert.ok(createdTask);
  assert.equal(tasks.length, existingTasks.length + 1);

  const item = page.locator(`.operationConversationItem[data-task-id="${createdTask.id}"]`);
  await item.waitFor({ state: "visible" });
  assert.equal(await item.locator("strong").textContent(), "新 UI 操作");
  assert.match(await item.locator("em").innerText(), /\d{2}\/\d{2}.*\d{2}:\d{2}.*(?:gui-browser|电脑桌面)/);

  assert.equal(createdTask.isDraft, true);
  assert.equal(createdTask.runs.length, 0);
  assert.ok(createdTask.conversationSessionId);
  assert.equal(createdTask.executionTarget.kind, expectDesktop ? "native-app" : "browser");

  if (expectDesktop) {
    await page.locator(".operationTargetSwitch").getByRole("button", { name: "浏览器" }).click();
    await page.waitForFunction(async (taskId) => {
      const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
      return currentTasks.find((task) => task.id === taskId)?.executionTarget?.kind === "browser";
    }, createdTask.id);
  } else {
    await page.locator(".operationTargetSwitch").getByRole("button", { name: "电脑桌面" }).click();
    await page.waitForFunction(async (taskId) => {
      const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
      const target = currentTasks.find((task) => task.id === taskId)?.executionTarget;
      return target?.kind === "native-app" && target.providerId === "mock";
    }, createdTask.id);
    await page.getByText("服务器 Mock Provider（协议验证）", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".operationTargetSwitch").getByRole("button", { name: "浏览器" }).click();
    await page.waitForFunction(async (taskId) => {
      const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
      return currentTasks.find((task) => task.id === taskId)?.executionTarget?.kind === "browser";
    }, createdTask.id);
  }

  const kernelSelect = page.locator(".operationKernelField select");
  await kernelSelect.selectOption("playwright");
  await page.waitForFunction(async (taskId) => {
    const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
    return currentTasks.find((task) => task.id === taskId)?.executionTarget?.browserKernel === "playwright";
  }, createdTask.id);
  await kernelSelect.selectOption("uiwarden-embedded");
  await page.waitForFunction(async (taskId) => {
    const currentTasks = await fetch("/api/ui-operations").then((response) => response.json());
    return currentTasks.find((task) => task.id === taskId)?.executionTarget?.browserKernel === "uiwarden-embedded";
  }, createdTask.id);

  const copyButton = item.locator(".operationConversationCopy");
  assert.equal(await copyButton.isEnabled(), true);
  await copyButton.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), createdTask.conversationSessionId);

  await page.screenshot({ path: "/tmp/uiwarden-ui-operation-conversations-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 760, height: 860 });
  await item.scrollIntoViewIfNeeded();
  const itemBox = await item.boundingBox();
  const actionsBox = await item.locator(".operationConversationActions").boundingBox();
  assert.ok(itemBox && actionsBox);
  assert.ok(actionsBox.x + actionsBox.width <= itemBox.x + itemBox.width + 1);
  await page.screenshot({ path: "/tmp/uiwarden-ui-operation-conversations-compact.png", fullPage: true });

  await item.locator(".operationConversationDelete").click();
  await item.waitFor({ state: "detached" });
  const remaining = await page.evaluate(async () => fetch("/api/ui-operations").then((response) => response.json()));
  assert.deepEqual(remaining.map((task) => task.id).sort(), [...existingTaskIds].sort());
  const deletedSessionResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(createdTask.conversationSessionId)}`);
  assert.notEqual(deletedSessionResponse.status, 200);

  console.log(JSON.stringify({
    ok: true,
    expectDesktop,
    conversationSessionId: createdTask.conversationSessionId,
    screenshots: [
      "/tmp/uiwarden-ui-operation-conversations-desktop.png",
      "/tmp/uiwarden-ui-operation-conversations-compact.png"
    ]
  }));
} finally {
  await browser.close();
}
