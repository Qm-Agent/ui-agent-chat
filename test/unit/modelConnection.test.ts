import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildProbeEndpoint,
  resolveWireModel,
  testModelProfileConnection
} from "../../server/src/modelConnection.js";
import type { ExecutionRuntimeId, ModelProfile } from "../../server/src/types.js";

test("model route probe builds protocol endpoints without duplicating v1", () => {
  assert.equal(
    buildProbeEndpoint("https://example.test/anthropic", "anthropic"),
    "https://example.test/anthropic/v1/messages"
  );
  assert.equal(
    buildProbeEndpoint("https://example.test/v1/", "openai"),
    "https://example.test/v1/responses"
  );
});

test("model route probe verifies Anthropic and OpenAI compatible routes", async () => {
  const requests: Array<{ path: string; authorization?: string; apiKey?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        path: request.url || "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const anthropic = await testModelProfileConnection(profile("cfuse", baseUrl));
    const openai = await testModelProfileConnection(profile("codex", `${baseUrl}/v1`));
    assert.equal(anthropic.protocol, "anthropic");
    assert.equal(openai.protocol, "openai");
    assert.deepEqual(requests.map((request) => request.path), ["/v1/messages", "/v1/responses"]);
    assert.equal(requests[0].apiKey, "secret-token");
    assert.equal(requests[1].authorization, "Bearer secret-token");
    assert.equal(JSON.parse(requests[0].body).model, "test-model");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("runtime-managed model profile does not make a network request", async () => {
  const result = await testModelProfileConnection(profile("cfuse", ""));
  assert.equal(result.protocol, "runtime-managed");
  assert.equal(result.latencyMs, 0);
});

test("DTCoder route keeps provider qualification locally and sends the bare wire model", () => {
  assert.equal(
    resolveWireModel({
      runtimeId: "dtcoder",
      model: "maas/claude-opus-4-8"
    }),
    "claude-opus-4-8"
  );
});

test("model route probe rejects an HTML page even when it returns HTTP 200", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Gateway</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      () => testModelProfileConnection(profile("cfuse", `http://127.0.0.1:${address.port}`)),
      /不是 JSON 模型响应/
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function profile(runtimeId: ExecutionRuntimeId, baseUrl: string): ModelProfile {
  return {
    id: "test-profile",
    runtimeId,
    name: "test",
    baseUrl,
    authToken: baseUrl ? "secret-token" : "",
    model: "test-model",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
