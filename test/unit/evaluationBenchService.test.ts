import test from "node:test";
import assert from "node:assert/strict";
import {
  getEvaluationTargetServiceStatuses,
  resolveEvaluationTargetServices,
  resolveEvaluationTargetUrl,
  startEvaluationTargetService,
  stopAllEvaluationTargetServices,
  stopEvaluationTargetService
} from "../../server/src/evaluationBenchService.js";
import { normalizeEvaluationSuite } from "../../server/src/evaluationLabDomain.js";

test("内置 Browser Bench 只能手动启动并解析逻辑目标 URL", async () => {
  const suite = normalizeEvaluationSuite({
    id: "browser-bench",
    name: "Browser Bench",
    targetServices: [{
      id: "browser-common",
      name: "Browser Common",
      kind: "managed",
      provider: "uiwarden-browser-common-v1",
      healthPath: "/_uiwarden/health"
    }],
    cases: [{
      id: "form",
      operationType: "browser",
      instruction: "填写表单",
      targetUrl: "{{targetService:browser-common}}/codex-ui-complex-fixture.html"
    }]
  });
  try {
    const initial = await getEvaluationTargetServiceStatuses(suite);
    assert.equal(initial[0].status, "stopped");
    assert.equal(initial[0].startable, true);
    await assert.rejects(
      () => resolveEvaluationTargetServices(suite),
      /请在启动评测窗口中先检测并手动启动服务/
    );

    const started = await startEvaluationTargetService(suite, "browser-common");
    assert.equal(started.status, "ready");
    assert.match(started.baseUrl || "", /^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(started.healthUrl!);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { status: string }).status, "ready");
    const fixture = await fetch(`${started.baseUrl}/codex-ui-complex-fixture.html`);
    assert.equal(fixture.status, 200);
    assert.match(await fixture.text(), /Codex UI Complex Benchmark/);

    const resolvedServices = await resolveEvaluationTargetServices(suite);
    assert.equal(resolvedServices.length, 1);
    assert.equal(
      resolveEvaluationTargetUrl(suite.cases[0].targetUrl, resolvedServices),
      `${started.baseUrl}/codex-ui-complex-fixture.html`
    );

    const stopped = await stopEvaluationTargetService(suite, "browser-common");
    assert.equal(stopped.status, "stopped");
  } finally {
    await stopAllEvaluationTargetServices();
  }
});

test("外部目标服务保留通用 URL 与健康检查定义", () => {
  const suite = normalizeEvaluationSuite({
    name: "External Bench",
    targetServices: [{
      id: "custom-app",
      name: "Custom App",
      kind: "external",
      baseUrl: "http://127.0.0.1:19090/base/",
      healthPath: "/health"
    }],
    cases: [{
      id: "custom",
      instruction: "打开自定义页面",
      targetUrl: "{{targetService:custom-app}}/form"
    }]
  });
  assert.equal(suite.targetServices?.[0].kind, "external");
  assert.equal(suite.targetServices?.[0].baseUrl, "http://127.0.0.1:19090/base/");
  assert.equal(suite.cases[0].targetUrl, "{{targetService:custom-app}}/form");
});
