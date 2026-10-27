import { createHash, randomUUID } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type {
  EvaluationAssertionDefinition,
  EvaluationAssertionResult,
  EvaluationCaseDefinition,
  EvaluationCaseRun,
  EvaluationExperimentReport,
  EvaluationOperationType,
  EvaluationRun,
  EvaluationRunSummary,
  EvaluationScreenshotEvidence,
  EvaluationSuite,
  UiOperationRun
} from "./types.js";

const MAX_CASES = 500;
const MAX_FIELD_LENGTH = 20_000;
const MAX_XLSX_ENTRIES = 200;
const MAX_XLSX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PASS_THRESHOLD = 70;
const EXCEL_HEADERS = [
  "caseId",
  "name",
  "category",
  "operationType",
  "instruction",
  "targetUrl",
  "tags",
  "expectedResult",
  "forbiddenResult",
  "minArtifacts",
  "maxDurationMs",
  "passThreshold",
  "timeoutMs",
  "enabled"
] as const;

type ExcelHeader = typeof EXCEL_HEADERS[number];

interface ImportedCaseRow extends Partial<Record<ExcelHeader, unknown>> {
  assertions?: unknown;
  compatibleTargets?: unknown;
}

interface ScoreInput {
  definition: EvaluationCaseDefinition;
  operationRun: UiOperationRun;
  durationMs: number;
  artifactsCount: number;
  passThreshold?: number;
}

/** 解析 JSON 或 XLSX 评测集并转换为稳定的 1.0 领域模型。 */
export function parseEvaluationSuiteFile(
  buffer: Buffer,
  fileName: string
): EvaluationSuite {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".json")) {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return normalizeEvaluationSuite(parsed, fileName);
  }
  if (lowerName.endsWith(".xlsx")) {
    return normalizeEvaluationSuite({
      name: fileName.replace(/\.xlsx$/i, ""),
      description: "从 Excel 导入",
      cases: parseXlsxRows(buffer)
    }, fileName);
  }
  throw new Error("评测集仅支持 .json 和 .xlsx 文件");
}

/** 将宽松输入归一化为可版本化、可复现的评测集快照。 */
export function normalizeEvaluationSuite(
  input: unknown,
  sourceFileName?: string,
  now = new Date().toISOString()
): EvaluationSuite {
  const source = Array.isArray(input) ? { cases: input } : asRecord(input, "评测集根节点必须是对象或数组");
  const rawCases = Array.isArray(source.cases) ? source.cases : [];
  if (!rawCases.length) throw new Error("评测集至少需要 1 条用例");
  if (rawCases.length > MAX_CASES) throw new Error(`单个评测集最多支持 ${MAX_CASES} 条用例`);
  const cases = rawCases.map((item, index) => normalizeCase(item, index));
  const duplicate = findDuplicate(cases.map((item) => item.id));
  if (duplicate) throw new Error(`评测用例 ID 重复：${duplicate}`);
  return {
    schemaVersion: "1.0",
    id: safeId(source.id) || randomUUID(),
    name: text(source.name, "评测集名称", 200) || sourceFileName?.replace(/\.(json|xlsx)$/i, "") || "未命名评测集",
    description: optionalText(source.description, "评测集描述", 2_000),
    sourceFileName,
    createdAt: validIso(source.createdAt) ?? now,
    updatedAt: now,
    targetServices: normalizeTargetServices(source.targetServices),
    cases
  };
}

/** 生成可直接编辑和再次导入的 XLSX 模板。 */
export function createEvaluationTemplateXlsx(): Buffer {
  const rows: Array<Record<ExcelHeader, string | number | boolean>> = [
    {
      caseId: "browser-search-001",
      name: "百度搜索杭州天气",
      category: "浏览器搜索",
      operationType: "browser",
      instruction: "打开 https://www.baidu.com，搜索杭州今天天气",
      targetUrl: "https://www.baidu.com",
      tags: "browser,search,smoke",
      expectedResult: "杭州|天气",
      forbiddenResult: "无法执行|未安装",
      minArtifacts: 1,
      maxDurationMs: 180000,
      passThreshold: 70,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      enabled: true
    },
    {
      caseId: "computer-calculator-001",
      name: "计算器计算 1+100",
      category: "桌面基础操作",
      operationType: "computer",
      instruction: "打开系统计算器，计算 1+100，并读取最终结果",
      targetUrl: "",
      tags: "computer,calculator,smoke",
      expectedResult: "101",
      forbiddenResult: "未验证|无法执行",
      minArtifacts: 1,
      maxDurationMs: 180000,
      passThreshold: 80,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      enabled: true
    }
  ];
  const table = [EXCEL_HEADERS, ...rows.map((row) => EXCEL_HEADERS.map((header) => row[header]))];
  const worksheetXml = renderWorksheetXml(table);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="evaluation-cases" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="1"><xf xfId="0"/></cellXfs>
</styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(worksheetXml)
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** 对单次 UI 操作结果执行可解释的确定性评分。 */
export function scoreEvaluationCaseRun(input: ScoreInput): {
  status: EvaluationCaseRun["status"];
  score?: number;
  reason: string;
  assertions: EvaluationAssertionResult[];
  observabilityGaps: string[];
} {
  const blockedReason = blockedOperationReason(input.operationRun);
  if (blockedReason) {
    return {
      status: "blocked",
      score: undefined,
      reason: blockedReason,
      assertions: input.definition.assertions.map((assertion) => ({
        id: assertion.id,
        label: assertion.label,
        evaluator: assertion.evaluator,
        status: "unknown",
        score: 0,
        maxScore: assertion.weight,
        reason: "基础执行链阻塞，未进入业务断言评分",
        evidencePaths: []
      })),
      observabilityGaps: ["execution_blocked", "token_usage_unavailable"]
    };
  }
  const results = input.definition.assertions.map((assertion) =>
    evaluateAssertion(assertion, input)
  );
  const maxScore = results.reduce((sum, item) => sum + item.maxScore, 0);
  const earned = results.reduce((sum, item) => sum + item.score, 0);
  const score = maxScore ? Math.round((earned / maxScore) * 1000) / 10 : 0;
  const requiredFailed = input.definition.assertions.some((definition) =>
    definition.required
    && results.find((result) => result.id === definition.id)?.status !== "pass"
  );
  const passThreshold = input.definition.passThreshold ?? input.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const operationFailed = input.operationRun.status === "failed";
  const operationAborted = input.operationRun.status === "aborted";
  const status = operationAborted
    ? "aborted"
    : operationFailed || requiredFailed || score < passThreshold
      ? "fail"
      : "pass";
  const failures = results.filter((item) => item.status === "fail").map((item) => item.reason);
  const reason = operationAborted
    ? input.operationRun.error || "UI 操作被中止"
    : operationFailed
      ? input.operationRun.error || "UI 操作执行失败"
      : failures.length
        ? failures.join("；")
        : `全部评分项满足要求，得分 ${score}`;
  const hasSemanticAssertion = input.definition.assertions.some((item) =>
    item.evaluator === "summary-contains" || item.evaluator === "summary-not-contains"
  );
  return {
    status,
    score,
    reason,
    assertions: results,
    observabilityGaps: [
      "token_usage_unavailable",
      ...(!hasSemanticAssertion ? ["semantic_correctness_not_asserted"] : [])
    ]
  };
}

/** 汇总实验运行指标，保持结果状态和执行状态正交。 */
export function summarizeEvaluationRun(caseRuns: EvaluationCaseRun[]): EvaluationRunSummary {
  const terminal = caseRuns.filter((item) =>
    ["pass", "fail", "blocked", "not-run", "unknown", "aborted"].includes(item.status)
  );
  const scores = terminal.map((item) => item.score).filter((value): value is number => Number.isFinite(value));
  const durations = terminal.map((item) => item.durationMs).filter((value): value is number => Number.isFinite(value));
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const p95Index = sortedDurations.length ? Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * 0.95) - 1) : 0;
  const passed = terminal.filter((item) => item.status === "pass").length;
  const passRateOutcomes = terminal.filter((item) => item.status !== "not-run");
  return {
    total: caseRuns.length,
    completed: terminal.length,
    passed,
    failed: terminal.filter((item) => item.status === "fail").length,
    blocked: terminal.filter((item) => item.status === "blocked").length,
    notRun: terminal.filter((item) => item.status === "not-run").length,
    unknown: terminal.filter((item) => item.status === "unknown").length,
    aborted: terminal.filter((item) => item.status === "aborted").length,
    passRate: passRateOutcomes.length ? round((passed / passRateOutcomes.length) * 100) : 0,
    averageScore: scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p95DurationMs: sortedDurations.length ? sortedDurations[p95Index] : 0
  };
}

function blockedOperationReason(operationRun: UiOperationRun): string | undefined {
  const evidence = `${operationRun.error || ""}\n${operationRun.summary || ""}`;
  if (
    /UIWARDEN_(?:NATIVE|BROWSER)_RESULT:\s*blocked|报告任务仍有阻塞步骤|未产生有效(?:桌面|页面)观察|PROVIDER_UNAVAILABLE|Provider .*(?:未返回响应|不可用|超时)|ERR_CONNECTION_REFUSED|前置条件不满足|目标(?:页面|服务|服务器).*(?:不可达|未启动|拒绝连接)|未输出\s+`?EVAL_PASS_/i.test(evidence)
  ) {
    return operationRun.error || "基础 UI 执行链阻塞，未进入可评分状态";
  }
  if (operationRun.status !== "failed") return undefined;
  return undefined;
}

/** 返回评测集内容哈希，用于比较和复现实验输入。 */
export function evaluationSuiteHash(suite: EvaluationSuite): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: suite.schemaVersion,
    name: suite.name,
    description: suite.description,
    cases: suite.cases
  })).digest("hex");
}

/** 生成无需额外前端依赖即可下载查看的评测 HTML 报告。 */
export function renderEvaluationHtmlReport(run: EvaluationRun | EvaluationExperimentReport): string {
  const details = "caseDetails" in run ? run.caseDetails : [];
  const detailById = new Map(details.map((item) => [item.caseRunId, item]));
  const rows = run.caseRuns.map((item) => {
    const detail = detailById.get(item.id);
    return `
    <tr>
      <td>${escapeHtml(item.caseName)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${item.repetition}</td>
      <td><span class="status ${escapeHtml(item.status)}">${escapeHtml(caseStatusLabel(item.status))}</span></td>
      <td>${item.score ?? "未评分"}</td>
      <td>${formatDuration(item.durationMs)}</td>
      <td>${escapeHtml(item.reason || item.error || "暂无原因")}</td>
      <td>${detail?.operation.artifactsCount ?? item.artifactsCount}</td>
    </tr>`;
  }).join("");
  const scoreCoverage = "scoreCoverage" in run
    ? `${run.scoreCoverage.scoredCases} / ${run.scoreCoverage.totalCases}（${run.scoreCoverage.percent}%）`
    : `${run.caseRuns.filter((item) => item.score != null).length} / ${run.caseRuns.length}`;
  const diagnosisSummary = "diagnosisSummary" in run
    ? `<section class="diagnosis-summary"><h2>失败聚类与优化优先级</h2>
      <div class="summary-grid">
        <div><h3>主失败类别</h3>${renderKeyValueList(run.diagnosisSummary.primaryFailureCategories)}</div>
        <div><h3>共同影响因素</h3>${renderStringList(run.diagnosisSummary.sharedContributingFactors, "未发现跨样本共同因素")}</div>
        <div><h3>建议优先级</h3>${renderStringList(run.diagnosisSummary.prioritizedRecommendations, "暂无建议")}</div>
      </div></section>`
    : "";
  const caseSections = details.map((detail) => {
    const item = run.caseRuns.find((candidate) => candidate.id === detail.caseRunId);
    if (!item) return "";
    const assertionRows = detail.expectedAssertions.map((definition) => {
      const result = item.assertions.find((candidate) => candidate.id === definition.id);
      return `<tr>
        <td>${escapeHtml(definition.label)}</td>
        <td>${escapeHtml(definition.evaluator)}</td>
        <td>${definition.required ? "必需" : "可选"}</td>
        <td>${result ? escapeHtml(result.status) : "未执行"}</td>
        <td>${result ? `${result.score} / ${result.maxScore}` : "-"}</td>
        <td>${escapeHtml(result?.reason || "执行未到达可评分结果")}</td>
      </tr>`;
    }).join("");
    const artifactRows = detail.artifacts.map((artifact) =>
      `<tr><td>${escapeHtml(artifact.kind)}</td><td><code>${escapeHtml(artifact.relativePath)}</code></td><td>${formatBytes(artifact.size)}</td></tr>`
    ).join("");
    const visualEvidence = detail.visualEvidence
      ? `<h3>首帧 / 末帧对照</h3><div class="visual-evidence">
          ${renderEvaluationScreenshot("开始状态", detail.visualEvidence.firstScreenshot)}
          ${renderEvaluationScreenshot("结束状态", detail.visualEvidence.lastScreenshot)}
        </div>`
      : "";
    const sessionLinks = detail.identifiers.sessionId
      ? `<a href="/sessions/${encodeURIComponent(detail.identifiers.sessionId)}/artifacts" target="_blank" rel="noreferrer">查看会话产物</a>
         <a href="/api/sessions/${encodeURIComponent(detail.identifiers.sessionId)}/artifacts/download">下载全部产物</a>`
      : "";
    const attemptRows = item.attemptHistory?.map((attempt) => `<tr>
      <td>${attempt.attemptNumber}</td>
      <td>${attempt.trigger === "case-rerun" ? "单例重跑" : "断点续跑"}</td>
      <td>${escapeHtml(caseStatusLabel(attempt.snapshot.status))}</td>
      <td>${attempt.snapshot.score ?? "未评分"}</td>
      <td>${formatDuration(attempt.snapshot.durationMs)}</td>
      <td>${escapeHtml(attempt.snapshot.reason || attempt.snapshot.error || "无结果摘要")}</td>
      <td><code>${escapeHtml(attempt.snapshot.id)}</code></td>
    </tr>`).join("") ?? "";
    return `<details class="case-detail" ${item.status !== "pass" ? "open" : ""}>
      <summary>
        <span class="status ${escapeHtml(item.status)}">${escapeHtml(caseStatusLabel(item.status))}</span>
        <strong>${escapeHtml(item.caseName)}</strong>
        <span>${item.score ?? "未评分"} 分 · ${formatDuration(item.durationMs)} · ${detail.operation.artifactsCount} 个产物</span>
      </summary>
      <div class="case-body">
        <div class="diagnosis ${escapeHtml(detail.diagnosis.category)}">
          <h3>诊断：${escapeHtml(detail.diagnosis.primaryCause)}</h3>
          <p>类别 ${escapeHtml(detail.diagnosis.category)} · 阶段 ${escapeHtml(detail.diagnosis.stage)} · 置信度 ${escapeHtml(detail.diagnosis.confidence)}</p>
          <div class="two-columns">
            <div><h4>影响因素</h4>${renderStringList(detail.diagnosis.contributingFactors, "无")}</div>
            <div><h4>优化建议</h4>${renderStringList(detail.diagnosis.recommendations, "无")}</div>
          </div>
        </div>
        <h3>任务输入</h3><pre>${escapeHtml(detail.instruction)}</pre>
        <h3>尝试历史</h3>
        ${attemptRows
          ? `<div class="table-wrap"><table><thead><tr><th>尝试</th><th>触发方式</th><th>结果</th><th>得分</th><th>耗时</th><th>原因</th><th>Case Run ID</th></tr></thead><tbody>${attemptRows}</tbody></table></div>`
          : `<p class="privacy-note">当前为首次执行。</p>`}
        <div class="meta detail-meta">
          <dt>Case Run ID</dt><dd><code>${escapeHtml(detail.caseRunId)}</code></dd>
          <dt>Task / Operation</dt><dd><code>${escapeHtml(detail.identifiers.taskId || "-")} / ${escapeHtml(detail.identifiers.operationRunId || "-")}</code></dd>
          <dt>Session / Native Session</dt><dd><code>${escapeHtml(detail.identifiers.sessionId || "-")} / ${escapeHtml(detail.identifiers.nativeSessionId || "-")}</code></dd>
          <dt>底层状态</dt><dd>${escapeHtml(detail.operation.status || "unknown")} · ${escapeHtml(detail.operation.error || "无底层错误")}</dd>
          <dt>超时占用</dt><dd>${detail.metrics.timeoutUtilizationPercent ?? "-"}%</dd>
          <dt>事件 / 工具调用 / 流事件</dt><dd>${detail.metrics.evaluationEvents} / ${detail.metrics.toolCalls} / ${detail.metrics.toolEvents}</dd>
          <dt>命令错误 / 大输出</dt><dd>${detail.metrics.commandErrors} / ${detail.metrics.oversizedOutputs}</dd>
          <dt>Provider 超时</dt><dd>${detail.metrics.providerTimeouts}</dd>
          <dt>焦点缺失 / 快照过期</dt><dd>${detail.metrics.focusContextErrors} / ${detail.metrics.staleSnapshots}</dd>
          <dt>最大事件停顿</dt><dd>${formatDuration(detail.metrics.maxEventGapMs)}</dd>
          <dt>Native 动作 / 快照 / 事件</dt><dd>${detail.metrics.nativeActions} / ${detail.metrics.nativeSnapshots} / ${detail.metrics.nativeEvents}</dd>
          <dt>动作类型</dt><dd>${escapeHtml(Object.entries(detail.metrics.actionKinds).map(([key, value]) => `${key}:${value}`).join("，") || "无")}</dd>
          <dt>采集缺口</dt><dd>${escapeHtml(detail.captureGaps.join("，") || "无")}</dd>
          <dt>事件证据</dt><dd><code>${escapeHtml(detail.eventEvidencePath)}</code></dd>
          <dt>Native Rep</dt><dd><code>${escapeHtml(detail.operation.nativeArtifactDir || "未生成")}</code></dd>
          <dt>Browser Rep</dt><dd><code>${escapeHtml(detail.operation.browserArtifactDir || "未生成")}</code></dd>
        </div>
        ${visualEvidence}
        <h3>脱敏进度摘要</h3><p class="progress">${escapeHtml(detail.progressSummary || item.summary || "没有可用进度摘要")}</p>
        <h3>断言与评分</h3>
        <div class="table-wrap"><table><thead><tr><th>断言</th><th>评分器</th><th>要求</th><th>结果</th><th>得分</th><th>原因</th></tr></thead><tbody>${assertionRows}</tbody></table></div>
        <h3>诊断证据</h3>${renderStringList(detail.diagnosis.evidence, "无")}
        <div class="artifact-heading"><h3>Rep 产物索引（${detail.artifacts.length}）</h3><div>${sessionLinks}</div></div>
        <div class="table-wrap artifact-table"><table><thead><tr><th>类型</th><th>相对路径</th><th>大小</th></tr></thead><tbody>${artifactRows || "<tr><td colspan=\"3\">没有发现 Rep 文件</td></tr>"}</tbody></table></div>
      </div>
    </details>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(run.suiteName)} - UIWarden 评测报告</title>
  <style>
    :root { color: #243247; background: #f4f6f8; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; } body { margin: 0; } main { width: min(1280px, calc(100% - 32px)); margin: 24px auto 48px; }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; } .subtitle { margin: 6px 0 18px; color: #728095; }
    .metrics { display: grid; grid-template-columns: repeat(8, minmax(110px, 1fr)); gap: 8px; }
    .metric, section { background: #fff; border: 1px solid #dfe6ee; border-radius: 7px; }
    .metric { min-height: 74px; padding: 12px; } .metric span { color: #788597; font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 22px; } section { margin-top: 12px; padding: 15px; overflow: auto; }
    h2 { margin: 0 0 12px; font-size: 15px; } h3 { font-size: 13px; margin: 16px 0 8px; } h4 { margin: 0 0 7px; font-size: 12px; }
    table { width: 100%; min-width: 980px; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 9px; border-bottom: 1px solid #e8edf2; text-align: left; vertical-align: top; }
    th { color: #68778b; background: #f7f9fb; } .status { display: inline-block; padding: 3px 7px; border-radius: 4px; }
    .status.pass { color: #17603d; background: #eaf7ef; } .status.fail { color: #9f322e; background: #fff0ef; }
    .status.aborted, .status.unknown, .status.blocked, .status.not-run { color: #76591b; background: #f7f1df; }
    .meta { display: grid; grid-template-columns: 170px 1fr; gap: 6px 10px; margin: 0; font-size: 12px; }
    .meta dt { color: #778497; } .meta dd { margin: 0; overflow-wrap: anywhere; }
    .summary-grid, .two-columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .two-columns { grid-template-columns: repeat(2, 1fr); }
    ul { margin: 0; padding-left: 18px; } li { margin: 5px 0; font-size: 12px; line-height: 1.5; }
    .case-detail { margin-top: 10px; background: #fff; border: 1px solid #dfe6ee; border-radius: 7px; overflow: hidden; }
    .case-detail > summary { display: grid; grid-template-columns: auto minmax(220px, 1fr) auto; align-items: center; gap: 10px; padding: 13px 15px; cursor: pointer; }
    .case-detail > summary > span:last-child { color: #6f7d90; font-size: 12px; } .case-body { border-top: 1px solid #e5ebf1; padding: 15px; }
    .diagnosis { padding: 12px; background: #f7f9fb; border-left: 4px solid #7b8798; } .diagnosis.timeout, .diagnosis.execution, .diagnosis.assertion { background: #fff6f4; border-color: #c94a43; }
    .diagnosis h3 { margin: 0 0 6px; } .diagnosis p { margin: 0 0 12px; color: #6f7d90; font-size: 12px; }
    pre, .progress { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 10px; border: 1px solid #e2e8ef; background: #f8fafb; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .detail-meta { margin-top: 14px; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .artifact-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; } .artifact-heading h3 { margin-bottom: 8px; }
    .artifact-heading a { margin-left: 10px; color: #17603d; font-size: 12px; } .artifact-table { max-height: 360px; overflow: auto; }
    .visual-evidence { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .visual-evidence figure { min-width: 0; margin: 0; padding: 8px; border: 1px solid #e2e8ef; background: #f8fafb; }
    .visual-evidence figcaption { margin-bottom: 7px; color: #68778b; font-size: 12px; }
    .visual-evidence img { display: block; width: 100%; max-height: 420px; object-fit: contain; background: #fff; }
    .table-wrap { overflow: auto; } .privacy-note { color: #657286; font-size: 12px; line-height: 1.6; }
    @media (max-width: 900px) { .metrics { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body><main>
  <header><h1>${escapeHtml(run.suiteName)}</h1><p class="subtitle">UIWarden 评测实验报告 · ${escapeHtml(run.id)}</p></header>
  <div class="metrics">
    <div class="metric"><span>通过率</span><strong>${run.summary.passRate}%</strong></div>
    <div class="metric"><span>平均得分</span><strong>${run.summary.averageScore}</strong></div>
    <div class="metric"><span>通过 / 总数</span><strong>${run.summary.passed} / ${run.summary.total}</strong></div>
    <div class="metric"><span>平均耗时</span><strong>${formatDuration(run.summary.averageDurationMs)}</strong></div>
    <div class="metric"><span>P95 耗时</span><strong>${formatDuration(run.summary.p95DurationMs)}</strong></div>
    <div class="metric"><span>累计样本耗时</span><strong>${formatDuration(run.summary.totalDurationMs)}</strong></div>
    <div class="metric"><span>失败 / 阻塞</span><strong>${run.summary.failed} / ${run.summary.blocked ?? 0}</strong></div>
    <div class="metric"><span>评分覆盖</span><strong>${scoreCoverage}</strong></div>
  </div>
  <section><h2>实验环境</h2><dl class="meta">
    <dt>评测集哈希</dt><dd>${escapeHtml(run.suiteHash)}</dd>
    <dt>操作类型</dt><dd>${escapeHtml(run.config.operationType)}</dd>
    <dt>执行内核</dt><dd>${escapeHtml(run.config.browserKernel || run.config.providerId || "-")}</dd>
    <dt>执行底座</dt><dd>${escapeHtml(run.environment.executionRuntimeId)}</dd>
    <dt>模型</dt><dd>${escapeHtml(run.environment.model || "未检测到")}</dd>
    <dt>底座选择</dt><dd>${run.environment.selectionSource === "plan-override" ? "方案指定" : "继承配置中心"}</dd>
    <dt>执行链路</dt><dd>${escapeHtml(run.environment.executionChain.join(" → "))}</dd>
    <dt>Runtime 传输</dt><dd>${escapeHtml(run.environment.guiRuntimeTransport || "-")}</dd>
    <dt>断点 / 单例重跑</dt><dd>${run.resumeHistory?.length ?? 0} 次</dd>
    ${run.rerunOfRunId ? `<dt>重跑来源</dt><dd>${escapeHtml(run.rerunOfRunId)}</dd>` : ""}
    ${run.rerunOfCaseRunId ? `<dt>单例来源</dt><dd>${escapeHtml(run.rerunOfCaseRunId)}</dd>` : ""}
    <dt>开始 / 结束</dt><dd>${escapeHtml(run.startedAt || run.createdAt)} / ${escapeHtml(run.finishedAt || "尚未结束")}</dd>
  </dl>${"privacy" in run ? `<p class="privacy-note">${escapeHtml(run.privacy.note)}</p>` : ""}</section>
  ${diagnosisSummary}
  <section><h2>用例结果</h2><table><thead><tr><th>用例</th><th>类别</th><th>轮次</th><th>结果</th><th>得分</th><th>耗时</th><th>原因</th><th>产物</th></tr></thead><tbody>${rows}</tbody></table></section>
  <section><h2>样本详情与 Coder 调优证据</h2><p class="privacy-note">阻塞 ${run.summary.blocked ?? 0}，未执行 ${run.summary.notRun ?? 0}。每个已启动样本包含完整输入、断言、阶段诊断、动作/观察指标、脱敏进度摘要和 Rep 文件索引；机器分析请优先下载同目录 report.json。</p>${caseSections || "<p>此历史报告没有样本详情，请重新生成报告。</p>"}</section>
</main></body></html>`;
}

function renderStringList(values: string[], empty: string): string {
  return values.length
    ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
    : `<p class="privacy-note">${escapeHtml(empty)}</p>`;
}

function renderEvaluationScreenshot(
  label: string,
  screenshot?: EvaluationScreenshotEvidence
): string {
  if (!screenshot) return `<figure><figcaption>${escapeHtml(label)}</figcaption><p class="privacy-note">未采集截图</p></figure>`;
  return `<figure>
    <figcaption>${escapeHtml(label)} · <code>${escapeHtml(screenshot.sourceRelativePath)}</code></figcaption>
    <img src="${escapeHtml(screenshot.reportPath)}" alt="${escapeHtml(label)}"/>
  </figure>`;
}

function renderKeyValueList(values: Record<string, number>): string {
  return renderStringList(
    Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    "暂无分类"
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

function normalizeCase(value: unknown, index: number): EvaluationCaseDefinition {
  const source = asRecord(value, `第 ${index + 1} 条用例必须是对象`);
  const instruction = text(source.instruction ?? source.prompt, `第 ${index + 1} 条用例 instruction`, MAX_FIELD_LENGTH);
  if (!instruction) throw new Error(`第 ${index + 1} 条用例缺少 instruction`);
  const compatibleTargets = normalizeTargets(source.compatibleTargets ?? source.operationType);
  const assertions = normalizeAssertions(source.assertions, source, index);
  return {
    id: safeId(source.id ?? source.caseId) || `case-${String(index + 1).padStart(3, "0")}`,
    name: text(source.name, `第 ${index + 1} 条用例名称`, 300) || instruction.slice(0, 80),
    category: text(source.category, `第 ${index + 1} 条用例类别`, 120) || "未分类",
    instruction,
    compatibleTargets,
    targetUrl: optionalHttpUrl(source.targetUrl, index),
    tags: normalizeList(source.tags, 30, 80),
    timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_TIMEOUT_MS, 10_000, 60 * 60 * 1000),
    enabled: normalizeBoolean(source.enabled, true),
    passThreshold: source.passThreshold == null
      ? undefined
      : boundedNumber(source.passThreshold, DEFAULT_PASS_THRESHOLD, 0, 100),
    assertions
  };
}

function normalizeAssertions(
  value: unknown,
  source: Record<string, unknown>,
  index: number
): EvaluationAssertionDefinition[] {
  if (Array.isArray(value) && value.length) {
    return value.map((item, assertionIndex) => {
      const raw = asRecord(item, `第 ${index + 1} 条用例的第 ${assertionIndex + 1} 个断言必须是对象`);
      const evaluator = normalizeEvaluator(raw.evaluator);
      return {
        id: safeId(raw.id) || `assertion-${assertionIndex + 1}`,
        label: text(raw.label, "断言名称", 200) || evaluatorLabel(evaluator),
        evaluator,
        weight: boundedNumber(raw.weight, 1, 0.1, 1000),
        required: normalizeBoolean(raw.required, false),
        params: normalizeAssertionParams(raw.params ?? raw)
      };
    });
  }
  const assertions: EvaluationAssertionDefinition[] = [
    {
      id: "run-completed",
      label: "执行链路完成",
      evaluator: "run-completed",
      weight: 40,
      required: true,
      params: {}
    }
  ];
  const expectedTerms = normalizeList(source.expectedResult, 30, 500, "|");
  if (expectedTerms.length) {
    assertions.push({
      id: "expected-result",
      label: "结果包含期望信息",
      evaluator: "summary-contains",
      weight: 40,
      required: true,
      params: { terms: expectedTerms, matchMode: "all" }
    });
  }
  const forbiddenTerms = normalizeList(source.forbiddenResult, 30, 500, "|");
  if (forbiddenTerms.length) {
    assertions.push({
      id: "forbidden-result",
      label: "结果不含失败信号",
      evaluator: "summary-not-contains",
      weight: 10,
      required: true,
      params: { terms: forbiddenTerms, matchMode: "all" }
    });
  }
  const minArtifacts = optionalNumber(source.minArtifacts);
  if (minArtifacts != null) {
    assertions.push({
      id: "artifact-count",
      label: "执行证据完整",
      evaluator: "artifact-count",
      weight: 10,
      required: false,
      params: { min: Math.max(0, Math.floor(minArtifacts)) }
    });
  }
  const maxDurationMs = optionalNumber(source.maxDurationMs);
  if (maxDurationMs != null) {
    assertions.push({
      id: "duration",
      label: "执行耗时达标",
      evaluator: "duration",
      weight: 10,
      required: false,
      params: { maxMs: Math.max(1, Math.floor(maxDurationMs)) }
    });
  }
  return assertions;
}

function evaluateAssertion(
  definition: EvaluationAssertionDefinition,
  input: ScoreInput
): EvaluationAssertionResult {
  const summary = `${input.operationRun.summary || ""}\n${input.operationRun.error || ""}`.toLowerCase();
  let status: EvaluationAssertionResult["status"] = "unknown";
  let reason = "当前评分器缺少可用证据";
  const evidencePaths: string[] = [];
  if (definition.evaluator === "run-completed") {
    status = input.operationRun.status === "completed" ? "pass" : "fail";
    reason = status === "pass" ? "UI 操作执行完成" : `UI 操作状态为 ${input.operationRun.status}`;
  } else if (definition.evaluator === "summary-contains") {
    const terms = definition.params.terms ?? [];
    if (terms.length) {
      const matches = terms.map((term) => positiveSummaryMatch(summary, term));
      const passed = definition.params.matchMode === "any" ? matches.some(Boolean) : matches.every(Boolean);
      status = passed ? "pass" : "fail";
      const missed = terms.filter((_term, termIndex) => !matches[termIndex]);
      reason = passed ? `结果摘要包含期望信息：${terms.join("、")}` : `结果摘要缺少：${missed.join("、")}`;
      evidencePaths.push("session://assistant-summary");
    }
  } else if (definition.evaluator === "summary-not-contains") {
    const terms = definition.params.terms ?? [];
    if (terms.length) {
      const found = terms.filter((term) => summary.includes(term.toLowerCase()));
      status = found.length ? "fail" : "pass";
      reason = found.length ? `结果摘要出现禁止信息：${found.join("、")}` : "结果摘要未出现禁止信息";
      evidencePaths.push("session://assistant-summary");
    }
  } else if (definition.evaluator === "artifact-count") {
    const minimum = definition.params.min ?? 1;
    status = input.artifactsCount >= minimum ? "pass" : "fail";
    reason = `产物数量 ${input.artifactsCount}，要求至少 ${minimum}`;
    if (input.artifactsCount) evidencePaths.push("artifacts://session");
  } else if (definition.evaluator === "duration") {
    const maxMs = definition.params.maxMs;
    if (maxMs != null) {
      status = input.durationMs <= maxMs ? "pass" : "fail";
      reason = `耗时 ${formatDuration(input.durationMs)}，要求不超过 ${formatDuration(maxMs)}`;
    }
  }
  return {
    id: definition.id,
    label: definition.label,
    evaluator: definition.evaluator,
    status,
    score: status === "pass" ? definition.weight : 0,
    maxScore: definition.weight,
    reason,
    evidencePaths
  };
}

function positiveSummaryMatch(summary: string, term: string): boolean {
  const normalizedTerm = term.toLowerCase();
  if (!summary.includes(normalizedTerm)) return false;
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(
    `(?:未输出|不输出|没有输出|禁止输出|不得输出|不会输出|无法输出|不能输出|不应输出|未包含|不包含|没有包含|不能声称|未达到|不满足)[^\\n。；]{0,80}${escaped}`,
    "i"
  ).test(summary);
}

function parseXlsxRows(buffer: Buffer): ImportedCaseRow[] {
  inspectZipSafety(buffer);
  const archive = unzipSync(new Uint8Array(buffer));
  const worksheet = archive["xl/worksheets/sheet1.xml"];
  if (!worksheet) throw new Error("Excel 中未找到第一个工作表");
  const sharedStrings = parseSharedStrings(archive["xl/sharedStrings.xml"]);
  const parsed = parseSafeXml(strFromU8(worksheet));
  const rows = toArray(parsed?.worksheet?.sheetData?.row);
  if (rows.length < 2) throw new Error("Excel 评测集没有数据行");
  const table = rows.map((row) => parseWorksheetRow(row, sharedStrings));
  const headers = table[0].map((value) => String(value ?? "").trim());
  const unknownHeaders = headers.filter((header) => header && !EXCEL_HEADERS.includes(header as ExcelHeader));
  if (unknownHeaders.length) throw new Error(`Excel 包含不支持的列：${unknownHeaders.join("、")}`);
  const results: ImportedCaseRow[] = [];
  for (const values of table.slice(1)) {
    if (values.every((value) => value == null || String(value).trim() === "")) continue;
    const row: ImportedCaseRow = {};
    headers.forEach((header, index) => {
      if (header) row[header as ExcelHeader] = values[index];
    });
    results.push(row);
  }
  return results;
}

function inspectZipSafety(buffer: Buffer): void {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = Math.max(0, buffer.length - 65_557); offset <= buffer.length - 22; offset += 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) eocdOffset = offset;
  }
  if (eocdOffset < 0) throw new Error("Excel 文件不是有效的 XLSX ZIP");
  const entries = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entries > MAX_XLSX_ENTRIES) throw new Error("Excel 内部文件数量超过安全限制");
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Excel ZIP 中央目录损坏");
    }
    total += buffer.readUInt32LE(cursor + 24);
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) throw new Error("Excel 解压后大小超过 25MB 安全限制");
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
}

function parseSharedStrings(value?: Uint8Array): string[] {
  if (!value) return [];
  const parsed = parseSafeXml(strFromU8(value));
  return toArray(parsed?.sst?.si).map((item) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return flattenXmlText(source.t ?? source.r);
  });
}

function parseSafeXml(value: string): Record<string, unknown> & {
  worksheet?: { sheetData?: { row?: unknown } };
  sst?: { si?: unknown };
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error("Excel XML 不允许 DOCTYPE 或 ENTITY");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    processEntities: false,
    trimValues: false
  });
  return parser.parse(value) as ReturnType<typeof parseSafeXml>;
}

function parseWorksheetRow(row: unknown, sharedStrings: string[]): unknown[] {
  const source = asRecord(row, "Excel 行格式无效");
  const cells = toArray(source.c);
  const values: unknown[] = [];
  for (const item of cells) {
    const cell = asRecord(item, "Excel 单元格格式无效");
    const reference = String(cell["@r"] ?? "");
    const index = columnIndex(reference);
    const type = String(cell["@t"] ?? "");
    const raw = type === "inlineStr"
      ? flattenXmlText((cell.is as Record<string, unknown> | undefined)?.t)
      : cell.v;
    const value = type === "s"
      ? sharedStrings[Number(raw)] ?? ""
      : type === "b"
        ? String(raw) === "1"
        : raw;
    values[index] = value;
  }
  return values;
}

function renderWorksheetXml(rows: readonly (readonly unknown[])[]): string {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, column) => {
      const reference = `${columnName(column)}${rowIndex + 1}`;
      if (typeof value === "number") return `<c r="${reference}"><v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
      return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${columnName(EXCEL_HEADERS.length - 1)}${rows.length}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${EXCEL_HEADERS.map((_header, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 4 ? 58 : index === 1 ? 28 : 18}" customWidth="1"/>`).join("")}</cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function normalizeTargets(value: unknown): EvaluationOperationType[] {
  const values = normalizeList(value, 2, 20).flatMap((item) => item === "both" ? ["browser", "computer"] : [item]);
  const targets = values.filter((item): item is EvaluationOperationType => item === "browser" || item === "computer");
  return targets.length ? [...new Set(targets)] : ["browser", "computer"];
}

function normalizeEvaluator(value: unknown): EvaluationAssertionDefinition["evaluator"] {
  if (
    value === "run-completed"
    || value === "summary-contains"
    || value === "summary-not-contains"
    || value === "artifact-count"
    || value === "duration"
  ) return value;
  throw new Error(`不支持的评分器：${String(value ?? "")}`);
}

function normalizeAssertionParams(value: unknown): EvaluationAssertionDefinition["params"] {
  const source = asRecord(value, "断言参数必须是对象");
  return {
    terms: normalizeList(source.terms, 30, 500, "|"),
    matchMode: source.matchMode === "any" ? "any" : "all",
    min: optionalNumber(source.min),
    maxMs: optionalNumber(source.maxMs)
  };
}

function evaluatorLabel(value: EvaluationAssertionDefinition["evaluator"]): string {
  return {
    "run-completed": "执行链路完成",
    "summary-contains": "结果包含期望信息",
    "summary-not-contains": "结果不含禁止信息",
    "artifact-count": "执行证据完整",
    duration: "执行耗时达标"
  }[value];
}

function caseStatusLabel(value: EvaluationCaseRun["status"]): string {
  return {
    queued: "排队中",
    running: "执行中",
    pass: "通过",
    fail: "失败",
    blocked: "阻塞",
    "not-run": "未执行",
    unknown: "未知",
    aborted: "已中止"
  }[value];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = MAX_FIELD_LENGTH): string {
  const result = value == null ? "" : String(value).trim();
  if (result.length > max) throw new Error(`${field}超过 ${max} 字符限制`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  return text(value, field, max) || undefined;
}

function safeId(value: unknown): string {
  return String(value ?? "").trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 160);
}

function validIso(value: unknown): string | undefined {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || String(value).toLowerCase() === "true") return true;
  if (value === false || value === 0 || String(value).toLowerCase() === "false") return false;
  return fallback;
}

function normalizeList(value: unknown, maxItems: number, maxLength: number, separator = ","): string[] {
  const source = Array.isArray(value)
    ? value
    : value == null || String(value).trim() === ""
      ? []
      : String(value).split(separator);
  return source
    .map((item) => text(item, "列表项", maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(boundedNumber(value, fallback, min, max));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function optionalHttpUrl(value: unknown, index: number): string | undefined {
  const input = text(value, `第 ${index + 1} 条用例 targetUrl`, 2_000);
  if (!input) return undefined;
  if (/^\{\{targetService:[a-zA-Z0-9._-]+\}\}(?:\/.*)?$/.test(input)) return input;
  const normalized = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(normalized);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`第 ${index + 1} 条用例 targetUrl 只支持 HTTP/HTTPS`);
  return url.toString();
}

function normalizeTargetServices(value: unknown): EvaluationSuite["targetServices"] {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("targetServices 必须是数组");
  if (value.length > 20) throw new Error("单个评测集最多声明 20 个目标服务");
  const services = value.map((item, index) => {
    const source = asRecord(item, `第 ${index + 1} 个目标服务必须是对象`);
    const id = safeId(source.id);
    if (!id) throw new Error(`第 ${index + 1} 个目标服务缺少合法 id`);
    const kind: "managed" | "external" | undefined = source.kind === "external"
      ? "external"
      : source.kind === "managed"
        ? "managed"
        : undefined;
    if (!kind) throw new Error(`目标服务 ${id} 的 kind 必须是 managed 或 external`);
    const provider = optionalText(source.provider, `目标服务 ${id} provider`, 120);
    const baseUrl = optionalServiceBaseUrl(source.baseUrl, id);
    if (kind === "managed" && !provider) throw new Error(`内置目标服务 ${id} 必须声明 provider`);
    if (kind === "external" && !baseUrl) throw new Error(`外部目标服务 ${id} 必须声明 baseUrl`);
    return {
      id,
      name: text(source.name, `目标服务 ${id} 名称`, 120) || id,
      kind,
      provider,
      baseUrl,
      healthPath: optionalText(source.healthPath, `目标服务 ${id} healthPath`, 500)
    };
  });
  const duplicate = findDuplicate(services.map((item) => item.id));
  if (duplicate) throw new Error(`目标服务 ID 重复：${duplicate}`);
  return services;
}

function optionalServiceBaseUrl(value: unknown, serviceId: string): string | undefined {
  const input = optionalText(value, `目标服务 ${serviceId} baseUrl`, 2_000);
  if (!input) return undefined;
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`目标服务 ${serviceId} baseUrl 只支持 HTTP/HTTPS`);
  return url.toString();
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

function toArray<T>(value: T | T[] | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function flattenXmlText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(flattenXmlText).join("");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("@"))
      .map(([, child]) => flattenXmlText(child))
      .join("");
  }
  return String(value);
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function columnName(index: number): string {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value: unknown): string {
  return escapeXml(value).replaceAll("'", "&#39;");
}

function formatDuration(value?: number): string {
  if (value == null) return "-";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${round(value / 1_000)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
