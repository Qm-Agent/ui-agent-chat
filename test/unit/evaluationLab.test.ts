import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEvaluationTemplateXlsx,
  evaluationSuiteHash,
  normalizeEvaluationSuite,
  parseEvaluationSuiteFile,
  renderEvaluationHtmlReport,
  scoreEvaluationCaseRun,
  summarizeEvaluationRun
} from "../../server/src/evaluationLabDomain.js";
import {
  evaluationAssistantTextFromEvents,
  evaluationOperationBlocksBatch,
  extractEvaluationOperationIds,
  nativeEvaluationReadinessError,
  normalizeEvaluationRunConfig,
  prepareEvaluationRunRetry,
  selectEvaluationCasesForRun
} from "../../server/src/evaluationLabService.js";
import type { EvaluationCaseRun, EvaluationExperimentReport, EvaluationPlan, EvaluationRun, UiOperationRun } from "../../server/src/types.js";

test("JSON 评测集归一化并生成稳定哈希", () => {
  const suite = normalizeEvaluationSuite({
    id: "suite-1",
    name: "基础评测",
    cases: [{
      caseId: "browser-1",
      name: "搜索",
      operationType: "browser",
      instruction: "打开百度并搜索杭州天气",
      expectedResult: "杭州|天气",
      forbiddenResult: "无法执行",
      minArtifacts: 1,
      maxDurationMs: 60_000
    }]
  }, "suite.json", "2026-07-26T00:00:00.000Z");
  assert.equal(suite.schemaVersion, "1.0");
  assert.deepEqual(suite.cases[0].compatibleTargets, ["browser"]);
  assert.deepEqual(
    suite.cases[0].assertions.map((item) => item.evaluator),
    ["run-completed", "summary-contains", "summary-not-contains", "artifact-count", "duration"]
  );
  assert.equal(evaluationSuiteHash(suite), evaluationSuiteHash(structuredClone(suite)));
  assert.equal(suite.cases[0].timeoutMs, 30 * 60_000);
});

test("单例重跑只选择指定且兼容的启用样本", () => {
  const suite = normalizeEvaluationSuite({
    name: "单例重跑",
    cases: [
      { id: "browser-1", instruction: "浏览器一", compatibleTargets: ["browser"] },
      { id: "browser-2", instruction: "浏览器二", compatibleTargets: ["browser"] },
      { id: "computer-1", instruction: "桌面一", compatibleTargets: ["computer"] }
    ]
  });
  assert.deepEqual(
    selectEvaluationCasesForRun(suite, "browser", ["browser-2"]).map((item) => item.id),
    ["browser-2"]
  );
  assert.deepEqual(selectEvaluationCasesForRun(suite, "browser", ["computer-1"]), []);
});

test("断点续跑在同一 Run 中只替换未执行样本并归档历史", () => {
  const suite = normalizeEvaluationSuite({
    id: "resume-suite",
    name: "断点续跑",
    cases: [
      { id: "done", instruction: "已完成" },
      { id: "pending", instruction: "未执行" }
    ]
  });
  const run = evaluationRun(suite);
  run.caseRuns = [
    { ...caseRun("pass", 100, 1_000), id: "done-run", caseId: "done", attemptNumber: 1 },
    {
      ...caseRun("not-run", undefined, 0),
      id: "pending-run",
      caseId: "pending",
      attemptNumber: 1,
      reason: "服务重启前尚未开始执行"
    }
  ];
  run.summary = summarizeEvaluationRun(run.caseRuns);
  const resumed = prepareEvaluationRunRetry(
    run,
    ["pending-run"],
    "checkpoint-resume",
    "2026-07-28T06:00:00.000Z"
  );
  assert.equal(resumed.id, run.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.caseRuns[0].id, "done-run");
  assert.equal(resumed.caseRuns[0].status, "pass");
  assert.notEqual(resumed.caseRuns[1].id, "pending-run");
  assert.equal(resumed.caseRuns[1].status, "queued");
  assert.equal(resumed.caseRuns[1].attemptNumber, 2);
  assert.equal(resumed.caseRuns[1].attemptHistory?.[0].snapshot.status, "not-run");
  assert.equal(resumed.resumeHistory?.[0].trigger, "checkpoint-resume");
});

test("单例原位重跑覆盖当前结果并保留旧尝试快照", () => {
  const run = evaluationRun();
  run.caseRuns[0].caseId = run.suiteSnapshot.cases[0].id;
  run.caseRuns[0].attemptNumber = 2;
  const { attemptHistory: _attemptHistory, ...firstAttemptSnapshot } = run.caseRuns[0];
  run.caseRuns[0].attemptHistory = [{
    attemptNumber: 1,
    trigger: "case-rerun",
    archivedAt: "2026-07-28T05:00:00.000Z",
    snapshot: { ...firstAttemptSnapshot, attemptNumber: 1 }
  }];
  const retried = prepareEvaluationRunRetry(
    run,
    [run.caseRuns[0].id],
    "case-rerun",
    "2026-07-28T06:00:00.000Z"
  );
  assert.equal(retried.caseRuns.length, 1);
  assert.equal(retried.caseRuns[0].attemptNumber, 3);
  assert.equal(retried.caseRuns[0].attemptHistory?.length, 2);
  assert.equal(retried.caseRuns[0].attemptHistory?.[1].snapshot.score, 20);
});

test("Excel 模板可以无损导回评测集领域模型", () => {
  const workbook = createEvaluationTemplateXlsx();
  assert.ok(workbook.length > 1_000);
  const suite = parseEvaluationSuiteFile(workbook, "uiwarden-evaluation-template.xlsx");
  assert.equal(suite.cases.length, 2);
  assert.equal(suite.cases[0].id, "browser-search-001");
  assert.deepEqual(suite.cases[0].compatibleTargets, ["browser"]);
  assert.equal(suite.cases[1].id, "computer-calculator-001");
  assert.deepEqual(suite.cases[1].compatibleTargets, ["computer"]);
  assert.ok(suite.cases.every((item) => item.timeoutMs === 30 * 60_000));
});

test("评测用例默认超时为 30 分钟并保留显式预算", () => {
  const normalized = normalizeEvaluationSuite({
    name: "超时策略",
    cases: [
      { id: "default", instruction: "默认任务" },
      { id: "short", instruction: "短任务", timeoutMs: 240_000 },
      { id: "long", instruction: "长任务", timeoutMs: 45 * 60_000 }
    ]
  });
  assert.equal(normalized.cases[0].timeoutMs, 30 * 60_000);
  assert.equal(normalized.cases[1].timeoutMs, 240_000);
  assert.equal(normalized.cases[2].timeoutMs, 45 * 60_000);
});

test("Computer 评测启动前拒绝缺少屏幕录制权限的 macOS 环境", () => {
  const error = nativeEvaluationReadinessError({
    protocolVersion: 1,
    runtimeVersion: "0.6.0",
    platform: "darwin",
    architecture: "arm64",
    providers: [{
      providerId: "macos-accessibility",
      status: "ok",
      data: { permission: "granted", screenCapturePermission: "denied" }
    }]
  }, "macos-accessibility");
  assert.match(error || "", /屏幕录制权限未授权/);
  assert.equal(nativeEvaluationReadinessError({
    protocolVersion: 1,
    runtimeVersion: "0.6.0",
    platform: "darwin",
    architecture: "arm64",
    providers: [{
      providerId: "macos-accessibility",
      status: "ok",
      data: { permission: "granted", screenCapturePermission: "granted" }
    }]
  }, "macos-accessibility"), undefined);
});

test("评分器输出得分、原因和观测缺口", () => {
  const definition = normalizeEvaluationSuite({
    name: "评分",
    cases: [{
      id: "case-1",
      name: "计算器",
      operationType: "computer",
      instruction: "计算 1+100",
      expectedResult: "101",
      forbiddenResult: "无法执行",
      minArtifacts: 1,
      maxDurationMs: 20_000,
      passThreshold: 80
    }]
  }).cases[0];
  const operationRun: UiOperationRun = {
    id: "operation-run",
    taskId: "task",
    sessionId: "session",
    status: "completed",
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:10.000Z",
    summary: "计算器显示最终结果 101",
    artifactsCount: 3
  };
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun,
    durationMs: 10_000,
    artifactsCount: 3,
    passThreshold: 80
  });
  assert.equal(result.status, "pass");
  assert.equal(result.score, 100);
  assert.match(result.reason, /得分 100/);
  assert.deepEqual(result.observabilityGaps, ["token_usage_unavailable"]);
});

test("必需断言失败会给出可定位原因", () => {
  const definition = normalizeEvaluationSuite({
    name: "评分失败",
    cases: [{
      id: "case-1",
      instruction: "搜索",
      expectedResult: "杭州|天气"
    }]
  }).cases[0];
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun: {
      id: "operation-run",
      taskId: "task",
      sessionId: "session",
      status: "completed",
      startedAt: "2026-07-26T00:00:00.000Z",
      summary: "只找到了上海",
      artifactsCount: 0
    },
    durationMs: 1_000,
    artifactsCount: 0
  });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /杭州、天气/);
});

test("Provider 阻塞不进入业务断言评分", () => {
  const definition = normalizeEvaluationSuite({
    name: "Provider 阻塞",
    cases: [{
      id: "case-1",
      operationType: "computer",
      instruction: "打开计算器",
      expectedResult: "101",
      minArtifacts: 1
    }]
  }).cases[0];
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun: {
      id: "operation-run",
      taskId: "task",
      sessionId: "session",
      status: "failed",
      startedAt: "2026-07-26T00:00:00.000Z",
      error: "dt-gui-computer 报告任务仍有阻塞步骤，未达到用户目标",
      summary: "PROVIDER_UNAVAILABLE: macOS Provider 30 秒内未返回响应",
      artifactsCount: 3
    },
    durationMs: 30_000,
    artifactsCount: 3
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.score, undefined);
  assert.ok(result.assertions.every((item) => item.status === "unknown"));
});

test("Browser 前置条件阻塞不会因底层误报 completed 进入业务评分", () => {
  const definition = normalizeEvaluationSuite({
    name: "Browser 阻塞",
    cases: [{
      id: "case-1",
      operationType: "browser",
      instruction: "打开目标页面",
      expectedResult: "EVAL_PASS_CASE_1"
    }]
  }).cases[0];
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun: {
      id: "operation-run",
      taskId: "task",
      sessionId: "session",
      status: "completed",
      startedAt: "2026-07-26T00:00:00.000Z",
      summary: "ERR_CONNECTION_REFUSED，前置条件不满足，未输出 EVAL_PASS_CASE_1",
      artifactsCount: 2
    },
    durationMs: 5_000,
    artifactsCount: 2
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.score, undefined);
});

test("summary-contains 不把否定语境中的 Oracle 标记判为通过", () => {
  const definition = normalizeEvaluationSuite({
    name: "否定 Oracle",
    cases: [{
      id: "case-1",
      instruction: "确认结果",
      expectedResult: "ORACLE_OK"
    }]
  }).cases[0];
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun: {
      id: "operation-run",
      taskId: "task",
      sessionId: "session",
      status: "completed",
      startedAt: "2026-07-26T00:00:00.000Z",
      summary: "页面状态未验证，因此不得输出 ORACLE_OK。",
      artifactsCount: 1
    },
    durationMs: 1_000,
    artifactsCount: 1
  });
  assert.equal(result.status, "fail");
  assert.equal(result.assertions.find((item) => item.evaluator === "summary-contains")?.status, "fail");
});

test("summary-contains 不把“不包含 Oracle”判为通过", () => {
  const definition = normalizeEvaluationSuite({
    name: "否定 Oracle",
    cases: [{
      id: "case-1",
      instruction: "确认下载",
      expectedResult: "DOWNLOAD_VERIFIED"
    }]
  }).cases[0];
  const result = scoreEvaluationCaseRun({
    definition,
    operationRun: {
      id: "operation-run",
      taskId: "task",
      sessionId: "session",
      status: "completed",
      startedAt: "2026-07-26T00:00:00.000Z",
      summary: "文件名缺少直接证据，因此最终回复不包含 DOWNLOAD_VERIFIED。",
      artifactsCount: 1
    },
    durationMs: 1_000,
    artifactsCount: 1
  });
  assert.equal(result.status, "fail");
});

test("评测从完整流式事件恢复末尾 Oracle 标记", () => {
  const events = [
    { sequence: 3, type: "text", data: "EVAL_PASS_CASE_1" },
    { sequence: 1, type: "text", data: "执行过程".repeat(700) },
    { sequence: 2, type: "tool", data: { phase: "stop" } }
  ];
  const summary = evaluationAssistantTextFromEvents(events);
  assert.ok(summary);
  assert.ok(summary.length > 1_200);
  assert.match(summary, /EVAL_PASS_CASE_1$/);
});

test("已完成操作中的普通 Provider 文本不会中止后续评测", () => {
  const completed: UiOperationRun = {
    id: "operation-run",
    taskId: "task",
    sessionId: "session",
    status: "completed",
    startedAt: "2026-07-26T00:00:00.000Z",
    summary: "无人工接管或 Provider 故障",
    artifactsCount: 1
  };
  assert.equal(evaluationOperationBlocksBatch("pass", completed), false);
  assert.equal(evaluationOperationBlocksBatch("fail", completed), false);
  assert.equal(evaluationOperationBlocksBatch("blocked", completed), true);
  assert.equal(evaluationOperationBlocksBatch("fail", {
    ...completed,
    status: "failed",
    error: "PROVIDER_UNAVAILABLE: macOS Provider 30 秒内未返回响应"
  }), true);
});

test("运行汇总计算通过率、平均分和 P95", () => {
  const caseRuns = [
    caseRun("pass", 100, 1_000),
    caseRun("pass", 80, 2_000),
    caseRun("fail", 40, 9_000),
    caseRun("unknown", undefined, 3_000)
  ];
  const summary = summarizeEvaluationRun(caseRuns);
  assert.equal(summary.completed, 4);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.notRun, 0);
  assert.equal(summary.averageScore, 73.3);
  assert.equal(summary.totalDurationMs, 15_000);
  assert.equal(summary.averageDurationMs, 3_750);
  assert.equal(summary.p95DurationMs, 9_000);
});

test("评测运行配置拒绝非法目标并隔离共享 UI 执行器", () => {
  assert.throws(
    () => normalizeEvaluationRunConfig({ suiteId: "suite", operationType: "invalid" as never }),
    /UI 操作类型/
  );
  assert.throws(
    () => normalizeEvaluationRunConfig({
      suiteId: "suite",
      operationType: "browser",
      browserKernel: "invalid" as never
    }),
    /浏览器执行内核/
  );
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "browser",
    browserKernel: "uiwarden-embedded",
    concurrency: 3
  }).concurrency, 1);
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "computer",
    providerId: "mock"
  }).guiRuntimeTransport, "inherit");
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "computer",
    providerId: "mock",
    guiRuntimeTransport: "mcp"
  }).guiRuntimeTransport, "mcp");
  assert.throws(
    () => normalizeEvaluationRunConfig({
      suiteId: "suite",
      operationType: "computer",
      guiRuntimeTransport: "invalid" as never
    }),
    /GUI Runtime 传输模式/
  );
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "browser",
    browserKernel: "playwright",
    concurrency: 3
  }).concurrency, 1);
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "computer",
    providerId: "mock",
    concurrency: 3
  }).concurrency, 1);
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "browser"
  }).browserKernel, "playwright");
  assert.deepEqual(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "browser",
    executionRuntimeId: "dtcoder",
    model: "gpt-5.5"
  }), {
    operationType: "browser",
    browserKernel: "playwright",
    providerId: undefined,
    nativeDeliveryMode: "foreground-compatible",
    executionRuntimeId: "dtcoder",
    model: "gpt-5.5",
    businessId: undefined,
    repetitions: 1,
    passThreshold: 70,
    concurrency: 1
  });
  assert.equal(normalizeEvaluationRunConfig({
    suiteId: "suite",
    operationType: "browser",
    executionRuntimeId: "" as never,
    model: " "
  }).executionRuntimeId, undefined);
  assert.throws(
    () => normalizeEvaluationRunConfig({
      suiteId: "suite",
      operationType: "browser",
      executionRuntimeId: "invalid" as never
    }),
    /执行底座/
  );
});

test("仅操作会话事件可以更新评测运行标识", () => {
  assert.deepEqual(extractEvaluationOperationIds({
    type: "session",
    data: {
      operationTaskId: "task-1",
      operationRunId: "run-1",
      sessionId: "session-1"
    }
  }), {
    taskId: "task-1",
    operationRunId: "run-1",
    sessionId: "session-1"
  });
  assert.equal(extractEvaluationOperationIds({
    type: "session",
    data: { sdkSessionId: "runtime-session" }
  }), undefined);
});

test("HTML 报告转义评测集和失败原因", () => {
  const run = evaluationRun();
  run.suiteName = "<script>alert(1)</script>";
  run.caseRuns[0].reason = "<b>bad</b>";
  const html = renderEvaluationHtmlReport(run);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;bad&lt;/b&gt;"));
});

test("丰富报告展示诊断、完整输入和 Rep 证据索引", () => {
  const run = evaluationRun();
  const definition = run.suiteSnapshot.cases[0];
  const report: EvaluationExperimentReport = {
    ...run,
    reportSchemaVersion: "2.0",
    generatedAt: "2026-07-27T00:00:00.000Z",
    scoreCoverage: {
      scoredCases: 1,
      totalCases: 1,
      percent: 100,
      note: "完整"
    },
    privacy: {
      rawApplicationContentIncluded: false,
      note: "原始内容不进入摘要"
    },
    diagnosisSummary: {
      primaryFailureCategories: { timeout: 1 },
      sharedContributingFactors: ["观察输出过大"],
      prioritizedRecommendations: ["使用差量观察"]
    },
    caseDetails: [{
      caseRunId: run.caseRuns[0].id,
      caseId: definition.id,
      instruction: "完整任务输入",
      tags: [],
      timeoutMs: definition.timeoutMs,
      passThreshold: 70,
      expectedAssertions: definition.assertions,
      identifiers: {
        taskId: "task",
        operationRunId: "operation",
        sessionId: "session",
        nativeSessionId: "native"
      },
      operation: {
        status: "aborted",
        error: "evaluation-case-timeout",
        artifactsCount: 12,
        nativeArtifactDir: "/tmp/native-rep",
        browserArtifactDir: "/tmp/browser-rep"
      },
      metrics: {
        timeoutUtilizationPercent: 100,
        evaluationEvents: 100,
        toolEvents: 60,
        toolCalls: 10,
        textEvents: 20,
        commandErrors: 2,
        oversizedOutputs: 1,
        providerTimeouts: 0,
        staleSnapshots: 1,
        focusContextErrors: 1,
        maxEventGapMs: 30_000,
        nativeActions: 5,
        nativeSnapshots: 6,
        nativeEvents: 12,
        actionKinds: { click: 5 }
      },
      progressSummary: "已完成部分动作",
      captureGaps: ["screen-recording-permission-denied"],
      eventEvidencePath: `events/${run.caseRuns[0].id}.jsonl`,
      artifacts: [{
        name: "actions.jsonl",
        relativePath: "streams/actions.jsonl",
        kind: "actions",
        size: 1_024
      }],
      visualEvidence: {
        firstScreenshot: {
          reportPath: "evidence/case-run/first.png",
          sourceRelativePath: "screenshots/frame_0001.png",
          size: 2_048
        },
        lastScreenshot: {
          reportPath: "evidence/case-run/last.png",
          sourceRelativePath: "screenshots/frame_0009.png",
          size: 4_096
        }
      },
      diagnosis: {
        category: "timeout",
        stage: "verification",
        confidence: "high",
        primaryCause: "达到超时上限",
        contributingFactors: ["观察输出过大"],
        evidence: ["Native 动作=5"],
        recommendations: ["使用差量观察"]
      }
    }]
  };
  const html = renderEvaluationHtmlReport(report);
  assert.match(html, /样本详情与 Coder 调优证据/);
  assert.match(html, /完整任务输入/);
  assert.match(html, /达到超时上限/);
  assert.match(html, /streams\/actions\.jsonl/);
  assert.match(html, /首帧 \/ 末帧对照/);
  assert.match(html, /evidence\/case-run\/first\.png/);
  assert.match(html, /evidence\/case-run\/last\.png/);
});

test("目录化存储保留历史运行快照", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-evaluation-store-"));
  const previous = process.env.UI_AGENT_DATA_DIR;
  process.env.UI_AGENT_DATA_DIR = dataDir;
  try {
    const store = await import(`../../server/src/evaluationLabStore.js?test=${Date.now()}`);
    const suite = normalizeEvaluationSuite({
      id: "suite-store",
      name: "存储评测",
      cases: [{ id: "case-1", instruction: "打开页面" }]
    });
    await store.ensureEvaluationLabStorage();
    await store.saveEvaluationSuite(suite);
    assert.equal((await store.listEvaluationSuites()).length, 1);
    const plan: EvaluationPlan = {
      schemaVersion: "1.0",
      id: "plan-store",
      name: "浏览器方案",
      suiteId: suite.id,
      suiteName: suite.name,
      config: {
        operationType: "browser",
        browserKernel: "playwright",
        nativeDeliveryMode: "foreground-compatible",
        repetitions: 1,
        passThreshold: 70,
        concurrency: 1
      },
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z"
    };
    await store.saveEvaluationPlan(plan);
    assert.equal((await store.loadEvaluationPlan(plan.id)).suiteId, suite.id);
    const run = evaluationRun(suite);
    run.planId = plan.id;
    run.planName = plan.name;
    run.planSnapshot = plan;
    await store.createEvaluationRun(run);
    assert.equal((await store.listEvaluationRuns())[0].planSnapshot, undefined);
    await store.updateEvaluationCaseRun(run.id, run.caseRuns[0].id, { status: "running" });
    assert.equal((await store.loadEvaluationRun(run.id)).caseRuns[0].status, "running");
    await store.appendEvaluationEvent(run.id, run.caseRuns[0].id, { type: "observe", timestamp: "now" });
    assert.equal((await store.readEvaluationEvents(run.id, run.caseRuns[0].id)).length, 1);
    await store.deleteEvaluationSuite(suite.id);
    assert.equal((await store.listEvaluationSuites()).length, 0);
    assert.equal((await store.loadEvaluationRun(run.id)).suiteSnapshot.id, suite.id);
    await store.deleteEvaluationPlan(plan.id);
    assert.equal((await store.listEvaluationPlans()).length, 0);
    assert.equal((await store.loadEvaluationRun(run.id)).planSnapshot?.id, plan.id);
    await store.deleteEvaluationRun(run.id);
    await assert.rejects(() => store.loadEvaluationRun(run.id), /评测运行不存在/);
    await assert.rejects(() => fs.access(store.evaluationRunDirectory(run.id)));
  } finally {
    if (previous == null) delete process.env.UI_AGENT_DATA_DIR;
    else process.env.UI_AGENT_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function caseRun(
  status: EvaluationCaseRun["status"],
  score: number | undefined,
  durationMs: number
): EvaluationCaseRun {
  return {
    id: `${status}-${durationMs}`,
    caseId: "case",
    caseName: "用例",
    category: "基础",
    repetition: 1,
    status,
    score,
    durationMs,
    artifactsCount: 1,
    assertions: [],
    observability: { eventCount: 1, gaps: [] }
  };
}

function evaluationRun(suite = normalizeEvaluationSuite({
  id: "suite",
  name: "评测",
  cases: [{ id: "case-1", instruction: "打开页面" }]
})): EvaluationRun {
  const caseRuns = [caseRun("fail", 20, 1_000)];
  return {
    schemaVersion: "1.0",
    id: "run-1",
    suiteId: suite.id,
    suiteName: suite.name,
    suiteHash: evaluationSuiteHash(suite),
    suiteSnapshot: suite,
    status: "completed",
    config: {
      operationType: "browser",
      browserKernel: "playwright",
      nativeDeliveryMode: "foreground-compatible",
      repetitions: 1,
      passThreshold: 70,
      concurrency: 1
    },
    environment: {
      executionRuntimeId: "cfuse",
      model: "test-model",
      platform: "darwin",
      desktop: true,
      executionChain: ["主 Agent", "dt-gui-browser-skill", "dt-gui-browser Runtime", "Playwright 配套 Chromium"],
      capturedAt: "2026-07-26T00:00:00.000Z"
    },
    createdAt: "2026-07-26T00:00:00.000Z",
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:01.000Z",
    caseRuns,
    summary: summarizeEvaluationRun(caseRuns)
  };
}
