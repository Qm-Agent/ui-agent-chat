import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

test("extension bridge exposes existing tabs through the restricted CDP proxy", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-extension-bridge-"));
  process.env.UI_AGENT_DATA_DIR = temporary;
  const bridge = await import("../../server/src/browserExtensionBridge.js");
  const server = http.createServer();
  bridge.installBrowserExtensionBridge(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const pairing = await bridge.createBrowserExtensionPairing(baseUrl);
  const token = new URL(pairing.pairingUrl).searchParams.get("token");
  assert.ok(token);

  const extension = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/cdp/extension-bridge/socket?token=${token}&extensionId=${bridge.BROWSER_EXTENSION_ID}`,
    { headers: { Origin: `chrome-extension://${bridge.BROWSER_EXTENSION_ID}` } }
  );
  await new Promise<void>((resolve, reject) => {
    extension.once("open", resolve);
    extension.once("error", reject);
  });
  extension.send(JSON.stringify({ type: "hello", version: "0.9.1", browserName: "Test Chromium" }));
  const receivedMethods: string[] = [];
  extension.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as {
      type?: string;
      id?: string;
      method?: string;
      params?: { tabId?: number; method?: string };
    };
    if (message.type !== "command") return;
    receivedMethods.push(String(message.method || ""));
    let result: unknown = {};
    if (message.method === "tabs.list") {
      result = {
        tabs: [
          { id: 17, windowId: 2, title: "Existing target", url: "https://example.test/current", active: true },
          { id: 18, windowId: 2, title: "Other target", url: "https://example.test/other", active: false },
          { id: 19, windowId: 2, title: "Extensions", url: "chrome://extensions", active: false }
        ]
      };
    } else if (message.method === "cdp.send") {
      assert.equal(message.params?.tabId, 17);
      assert.equal(message.params?.method, "Runtime.evaluate");
      result = { result: { type: "string", value: "existing-page-controlled" } };
    } else if (message.method === "taskGroups.create") {
      assert.equal(message.params?.tabId, 17);
      result = {
        version: 1,
        chromeTabId: 17,
        groupId: 9,
        markerUrl: "https://example.test/current"
      };
    }
    extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
  });

  try {
    let status = await bridge.getBrowserExtensionBridgeStatus();
    const versionDeadline = Date.now() + 2_000;
    while (status.version !== "0.9.1" && Date.now() < versionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await bridge.getBrowserExtensionBridgeStatus();
    }
    assert.equal(status.connected, true);
    assert.equal(status.version, "0.9.1");
    assert.equal(status.canGroupExistingTab, true);
    assert.equal(status.tabs.length, 2);
    assert.equal(status.tabs[0].id, "chrome-tab-17");
    const pong = new Promise<Record<string, unknown>>((resolve) => {
      extension.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    });
    extension.send(JSON.stringify({ type: "ping", at: Date.now() }));
    assert.equal((await pong).type, "pong");

    const targets = await bridge.listBrowserExtensionCdpTargets(baseUrl);
    assert.equal(targets.length, 2);
    const group = await bridge.createBrowserExtensionTaskGroup({
      markerUrl: "about:blank#uiwarden-task-test",
      title: "Existing page task",
      color: "red",
      targetId: "chrome-tab-17"
    });
    assert.equal(group.chromeTabId, 17);
    assert.equal(group.groupId, 9);
    const target = targets[0] as { webSocketDebuggerUrl: string };
    const proxy = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      proxy.once("open", resolve);
      proxy.once("error", reject);
    });
    const response = new Promise<Record<string, unknown>>((resolve) => {
      proxy.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    });
    proxy.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true }
    }));
    assert.deepEqual(await response, {
      id: 1,
      result: { result: { type: "string", value: "existing-page-controlled" } }
    });
    const event = new Promise<Record<string, unknown>>((resolve) => {
      proxy.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    });
    extension.send(JSON.stringify({
      type: "cdp.event",
      tabId: 17,
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ type: "string", value: "bridge-event" }] }
    }));
    assert.deepEqual(await event, {
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ type: "string", value: "bridge-event" }] }
    });
    proxy.close();
    const deadline = Date.now() + 2_000;
    while (!receivedMethods.includes("cdp.detach") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(receivedMethods.includes("taskGroups.create"));
    assert.ok(receivedMethods.includes("cdp.detach"));
  } finally {
    extension.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("extension bridge does not advertise existing-tab grouping before version 0.9.0", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-extension-legacy-"));
  process.env.UI_AGENT_DATA_DIR = temporary;
  const bridge = await import(`../../server/src/browserExtensionBridge.js?legacy=${Date.now()}`);
  const server = http.createServer();
  bridge.installBrowserExtensionBridge(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const pairing = await bridge.createBrowserExtensionPairing(baseUrl);
  const token = new URL(pairing.pairingUrl).searchParams.get("token");
  assert.ok(token);
  const extension = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/cdp/extension-bridge/socket?token=${token}&extensionId=${bridge.BROWSER_EXTENSION_ID}`,
    { headers: { Origin: `chrome-extension://${bridge.BROWSER_EXTENSION_ID}` } }
  );
  await new Promise<void>((resolve, reject) => {
    extension.once("open", resolve);
    extension.once("error", reject);
  });
  extension.send(JSON.stringify({ type: "hello", version: "0.8.9", browserName: "Legacy Chromium" }));
  extension.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as { type?: string; id?: string; method?: string };
    if (message.type !== "command") return;
    const result = message.method === "tabs.list" ? { tabs: [] } : {};
    extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
  });

  try {
    let status = await bridge.getBrowserExtensionBridgeStatus();
    const deadline = Date.now() + 2_000;
    while (status.version !== "0.8.9" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await bridge.getBrowserExtensionBridgeStatus();
    }
    assert.equal(status.connected, true);
    assert.equal(status.version, "0.8.9");
    assert.equal(status.canGroupExistingTab, false);
    await assert.rejects(
      bridge.createBrowserExtensionTaskGroup({
        markerUrl: "about:blank#uiwarden-task-legacy",
        title: "Legacy task",
        color: "red",
        targetId: "chrome-tab-17"
      }),
      /0\.9\.0/
    );
  } finally {
    extension.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
