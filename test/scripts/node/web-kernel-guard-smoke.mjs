import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47904").replace(/\/+$/, "");

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

for (const browserKernel of ["playwright", "uiwarden-embedded"]) {
  const operation = await post("/api/ui-operations", {
    instruction: "读取页面",
    executionTarget: { kind: "browser", browserKernel }
  });
  assert.equal(operation.response.status, 201, JSON.stringify(operation.payload));
  assert.equal(operation.payload.executionTarget.browserKernel, browserKernel);
}

for (const browserKernel of ["skill-profile", "external-cdp", "gui-computer"]) {
  const operation = await post("/api/ui-operations", {
    instruction: "读取页面",
    executionTarget: { kind: "browser", browserKernel }
  });
  assert.equal(operation.response.status, 403, JSON.stringify(operation.payload));
  assert.match(operation.payload.error, /Web 部署只支持/);
}

const mockDesktop = await post("/api/ui-operations", {
  instruction: "读取桌面协议",
  executionTarget: { kind: "native-app", providerId: "mock" }
});
assert.equal(mockDesktop.response.status, 201, JSON.stringify(mockDesktop.payload));

const localDesktop = await post("/api/ui-operations", {
  instruction: "读取桌面",
  executionTarget: { kind: "native-app", providerId: "macos-accessibility" }
});
assert.equal(localDesktop.response.status, 403, JSON.stringify(localDesktop.payload));
assert.match(localDesktop.payload.error, /UIWarden 客户端/);

const playwright = await post("/api/ui-operations", { instruction: "读取页面", browserKernel: "playwright" });
assert.equal(playwright.response.status, 201);
assert.equal(playwright.payload.browserKernel, "playwright");

for (const browserKernel of ["playwright", "uiwarden-embedded", "external-cdp"]) {
  const session = await post("/api/sessions", { title: `web ${browserKernel}`, browserKernel });
  assert.equal(session.response.status, 201, JSON.stringify(session.payload));
  assert.equal(session.payload.browserKernel, browserKernel);
}

const unsupportedTestKernel = await post("/api/sessions", { title: "web gui-computer", browserKernel: "gui-computer" });
assert.equal(unsupportedTestKernel.response.status, 400);
assert.match(unsupportedTestKernel.payload.error, /测试任务不支持/);

console.log("web host capability smoke: PASS");
