import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { BROWSER_ENV_KEYS } from "./browserProfiles.js";
import { getSkillEnvView } from "./skillEnvStore.js";
import { isDesktopMode } from "./runtimeMode.js";
import { getServerManagedBrowserBridge } from "./serverManagedBrowser.js";
import type { AgentSession, TestOutcome } from "./types.js";

export interface BrowserExecutionSession {
  version: 1;
  kernel: "playwright" | "uiwarden-embedded" | "gui-computer";
  runId: string;
  sessionId: string;
  cdpUrl: string;
  targetId: string;
  pageUrl?: string;
  controlMode: "agent-control" | "human-control";
  startedAt: string;
}

export interface EmbeddedBrowserRunHandle {
  execution: BrowserExecutionSession;
  sessionFile: string;
  repDir: string;
  bridge: BrowserBridgeConfig;
}

interface BrowserBridgeConfig {
  url: string;
  token: string;
  cdpUrl?: string;
}

export function normalizeEmbeddedBrowserCdpUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("内置浏览器返回的 CDP 地址无效");
  }
  if ((url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || !url.port) {
    throw new Error("内置浏览器 CDP 必须绑定 127.0.0.1/localhost 随机端口");
  }
  if (url.protocol === "ws:") {
    if (!url.pathname.startsWith("/devtools/browser/")) {
      throw new Error("内置浏览器返回的 CDP WebSocket 地址无效");
    }
  } else if (url.protocol !== "http:" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("内置浏览器 CDP 必须使用本机 HTTP 基址");
  }
  return `http://127.0.0.1:${url.port}`;
}

function normalizeStandaloneExecutionKernel(
  execution: BrowserExecutionSession,
  requestedKernel: AgentSession["browserKernel"]
): BrowserExecutionSession {
  // UIWarden-Browser 0.3.1 使用独立控制桥，但沿用了 uiwarden-embedded
  // 的会话字段；在独立浏览器边界统一为 gui-computer，避免影响后续适配器。
  if (
    (
      requestedKernel === "playwright"
      || requestedKernel === "gui-computer"
      || requestedKernel === "uiwarden-embedded"
    )
    && execution.kernel !== requestedKernel
  ) {
    return { ...execution, kernel: requestedKernel };
  }
  return execution;
}

async function readDiscovery(discoveryPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(discoveryPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function isDiscoveryAlive(discovery: Record<string, unknown>): Promise<boolean> {
  const url = String(discovery.bridgeUrl || "");
  const token = String(discovery.bridgeToken || "");
  if (!url || !token) return false;
  try {
    const response = await fetch(`${url}/v1/browser/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1200)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function activateStandaloneBrowser(discovery: Record<string, unknown>): Promise<void> {
  if (process.platform !== "darwin") return;
  const product = String(discovery.product || "");
  const applicationName = product === "UIWarden-Browser"
    ? "UIWarden-Browser"
    : product === "gui-computer"
      ? "gui-computer"
      : "";
  if (!applicationName) return;
  await new Promise<void>((resolve) => {
    const child = spawn("/usr/bin/open", ["-a", applicationName], { stdio: "ignore" });
    const timer = setTimeout(resolve, 2000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function ensureStandaloneBrowser(discoveryPaths: string[]): Promise<Record<string, unknown>> {
  for (const discoveryPath of discoveryPaths) {
    const existing = await readDiscovery(discoveryPath);
    if (existing && await isDiscoveryAlive(existing)) {
      await activateStandaloneBrowser(existing);
      return existing;
    }
    if (existing) await fs.rm(discoveryPath, { force: true }).catch(() => undefined);
  }

  const envView = await getSkillEnvView(false);
  const env = Object.fromEntries(envView.map((entry) => [entry.key, entry.value]));
  let executable = env[BROWSER_ENV_KEYS.standaloneBrowserPath]?.trim()
    || env[BROWSER_ENV_KEYS.customBrowserPath]?.trim()
    || "";
  if (process.platform === "darwin" && executable.toLowerCase().endsWith(".app")) {
    const appName = path.basename(executable, path.extname(executable));
    executable = path.join(executable, "Contents", "MacOS", appName);
  }
  if (!executable || !/gui-computer|uiwarden-browser/i.test(executable)) {
    throw new Error("独立 gui-browser 未运行，且配置中心没有可启动的 UIWarden-Browser 路径");
  }

  const child = spawn(executable, [], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    for (const discoveryPath of discoveryPaths) {
      const discovery = await readDiscovery(discoveryPath);
      if (discovery && await isDiscoveryAlive(discovery)) {
        await activateStandaloneBrowser(discovery);
        return discovery;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("独立 gui-browser 已启动但控制桥 12 秒内未就绪，请检查安装包版本或本机权限");
}

function isCompatibleStandaloneProduct(product: unknown): boolean {
  return product === "gui-computer" || product === "UIWarden-Browser";
}

async function bridgeConfig(session: AgentSession): Promise<BrowserBridgeConfig> {
  const embeddedUrl = process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL?.trim() ?? "";
  const embeddedToken = process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN?.trim() ?? "";
  if (session.browserKernel === "uiwarden-embedded" && embeddedUrl && embeddedToken) {
    return { url: embeddedUrl, token: embeddedToken };
  }
  if (session.browserKernel === "playwright") {
    return getServerManagedBrowserBridge();
  }
  if (
    session.browserKernel === "uiwarden-embedded"
    && !isDesktopMode()
    && String(process.env.UI_AGENT_SERVER_MANAGED_BROWSER ?? "true").trim().toLowerCase() !== "false"
  ) {
    return getServerManagedBrowserBridge();
  }
  if (session.browserKernel === "gui-computer" || session.browserKernel === "uiwarden-embedded") {
    const appDataRoot = process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const configuredDiscovery = process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE;
    const discoveryPaths = configuredDiscovery
      ? [configuredDiscovery]
      : [
          path.join(appDataRoot, "UIWarden-Browser", "control-bridge.json"),
          path.join(appDataRoot, "gui-computer", "control-bridge.json")
        ];
    const discovery = await ensureStandaloneBrowser(discoveryPaths);
    const url = String(discovery.bridgeUrl || "");
    const token = String(discovery.bridgeToken || "");
    if (discovery.protocolVersion !== 1
      || !isCompatibleStandaloneProduct(discovery.product)
      || !url
      || !token) {
      throw new Error("独立 gui-browser 发现协议不兼容，请升级或重新启动 UIWarden-Browser");
    }
    const cdpUrl = discovery.cdpUrl ? normalizeEmbeddedBrowserCdpUrl(discovery.cdpUrl) : undefined;
    return { url, token, cdpUrl };
  }
  throw new Error("浏览器控制桥未配置，且配置中心没有可启动的 UIWarden-Browser 路径");
}

async function bridgeRequest<T>(bridge: BrowserBridgeConfig, pathname: string, init?: RequestInit): Promise<T> {
  const { url, token } = bridge;
  const response = await fetch(`${url}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers
    },
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `内置浏览器控制桥 HTTP ${response.status}`);
  return body;
}

export async function startEmbeddedBrowserRun(
  session: AgentSession,
  options: { initialUrl?: string; initialControlMode?: "agent-control" | "human-control" } = {}
): Promise<EmbeddedBrowserRunHandle> {
  const bridge = await bridgeConfig(session);
  if (options.initialUrl) {
    await bridgeRequest(bridge, "/v1/browser/navigate", {
      method: "POST",
      body: JSON.stringify({ url: options.initialUrl })
    });
  }
  let execution = normalizeStandaloneExecutionKernel(await bridgeRequest<BrowserExecutionSession>(bridge, "/v1/browser/runs", {
    method: "POST",
    body: JSON.stringify({ sessionId: session.id })
  }), session.browserKernel);
  execution = {
    ...execution,
    cdpUrl: normalizeEmbeddedBrowserCdpUrl(bridge.cdpUrl || execution.cdpUrl)
  };
  if (execution.version !== 1 || execution.kernel !== session.browserKernel || !execution.targetId) {
    throw new Error("内置浏览器执行会话协议不兼容或缺少 targetId");
  }
  if (options.initialControlMode === "human-control") {
    execution = normalizeStandaloneExecutionKernel(await bridgeRequest<BrowserExecutionSession>(bridge, `/v1/browser/runs/${execution.runId}/control`, {
      method: "POST",
      body: JSON.stringify({ mode: "human-control" })
    }), session.browserKernel);
    execution = {
      ...execution,
      cdpUrl: normalizeEmbeddedBrowserCdpUrl(bridge.cdpUrl || execution.cdpUrl)
    };
  }
  const repDir = path.join(session.workspacePath, ".skill-output", "uiwarden-reps", execution.runId);
  const sessionDir = path.join(os.tmpdir(), "gui-computer-browser-sessions");
  const sessionFile = path.join(sessionDir, `${execution.runId}.json`);
  await Promise.all([
    fs.mkdir(sessionDir, { recursive: true }),
    fs.mkdir(path.join(repDir, "streams"), { recursive: true }),
    fs.mkdir(path.join(repDir, "screenshots"), { recursive: true }),
    fs.mkdir(path.join(repDir, "trace"), { recursive: true })
  ]);
  await fs.writeFile(sessionFile, JSON.stringify({
    ...execution,
    requestedKernel: session.browserKernel,
    controlUrl: bridge.url,
    controlToken: bridge.token,
    captureDir: repDir,
    continueCurrentPage: Boolean(session.sdkSessionId)
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  return { execution, sessionFile, repDir, bridge };
}

async function countLines(filePath: string): Promise<number> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function buildHar(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const entries: Array<Record<string, unknown>> = [];
  const pending = new Map<string, Array<Record<string, unknown>>>();
  for (const event of events) {
    const url = String(event.url || "");
    if (!url) continue;
    if (event.type === "request") {
      const entry = {
        startedDateTime: String(event.timestamp || new Date(0).toISOString()),
        time: 0,
        request: { method: String(event.method || "GET"), url, httpVersion: "", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: 0, statusText: "", httpVersion: "", headers: [], cookies: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _resourceType: event.resourceType || ""
      };
      entries.push(entry);
      pending.set(url, [...(pending.get(url) || []), entry]);
    } else if (event.type === "response" || event.type === "requestfailed") {
      const queue = pending.get(url) || [];
      const entry = queue.shift();
      if (!entry) continue;
      pending.set(url, queue);
      entry.response = {
        ...(entry.response as Record<string, unknown>),
        status: event.type === "response" ? Number(event.status || 0) : 0,
        statusText: event.type === "requestfailed" ? String(event.failure || "requestfailed") : ""
      };
      if (event.type === "requestfailed") entry._failure = event.failure || "requestfailed";
    }
  }
  return { log: { version: "1.2", creator: { name: "UIWarden", version: "0.2.1" }, pages: [], entries } };
}

export async function finalizeEmbeddedBrowserRun(
  handle: EmbeddedBrowserRunHandle,
  input: { stopReason: string; testOutcome?: TestOutcome; summary?: string }
): Promise<void> {
  try {
    await bridgeRequest(handle.bridge, `/v1/browser/runs/${encodeURIComponent(handle.execution.runId)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason: input.stopReason })
    });
  } catch (error) {
    await fs.appendFile(
      path.join(handle.repDir, "streams", "capture-gaps.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), reason: "bridge-finalize-failed", detail: String(error) })}\n`,
      "utf8"
    );
  }
  const screenshots = await fs.readdir(path.join(handle.repDir, "screenshots")).catch(() => [] as string[]);
  const traces = await fs.readdir(path.join(handle.repDir, "trace")).catch(() => [] as string[]);
  const traceFile = traces.includes("trace.zip")
    ? "trace/trace.zip"
    : traces.find((name) => name.endsWith(".zip"))
      ? `trace/${traces.find((name) => name.endsWith(".zip"))}`
      : null;
  const streamNames = ["events", "network", "console", "page-errors", "capture-gaps"] as const;
  const initialCounts = Object.fromEntries(await Promise.all(streamNames.map(async (name) => [
    name,
    await countLines(path.join(handle.repDir, "streams", `${name}.jsonl`))
  ])));
  const screenshotCount = screenshots.filter((name) => name.endsWith(".png")).length;
  const captureEmpty = screenshotCount === 0 && !traceFile
    && Number(initialCounts.events || 0) === 0
    && Number(initialCounts.network || 0) === 0
    && Number(initialCounts.console || 0) === 0
    && Number(initialCounts["page-errors"] || 0) === 0;
  if (captureEmpty) {
    await fs.appendFile(path.join(handle.repDir, "streams", "capture-gaps.jsonl"), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      reason: "empty-browser-capture",
      detail: "任务结束但未采集到截图、Trace 或浏览器事件；不得将该 Rep 视为完整录制"
    })}\n`, "utf8");
  }
  const counts = Object.fromEntries(await Promise.all(streamNames.map(async (name) => [
    name,
    await countLines(path.join(handle.repDir, "streams", `${name}.jsonl`))
  ])));
  const networkEvents = await readJsonLines(path.join(handle.repDir, "streams", "network.jsonl"));
  const har = buildHar(networkEvents);
  const stoppedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: "uiwarden-browser-rep/v1",
    artifactKind: "browser-rep",
    browserRunId: handle.execution.runId,
    captureStopReason: input.stopReason,
    metadata: {
      captureMode: "browser-use-embedded",
      recordedAt: handle.execution.startedAt,
      recordingStartedAt: handle.execution.startedAt,
      recordingStoppedAt: stoppedAt,
      captureStatus: captureEmpty ? "incomplete" : "complete",
      testOutcome: input.testOutcome ?? "unknown",
      summary: input.summary ?? ""
    },
    target: {
      cdpUrl: handle.execution.cdpUrl,
      targetId: handle.execution.targetId
    },
    evidence: {
      streams: counts,
      screenshots: screenshotCount,
      trace: traceFile,
      har: "network.har",
      gaps: counts["capture-gaps"]
    }
  };
  await Promise.all([
    fs.writeFile(path.join(handle.repDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    fs.writeFile(path.join(handle.repDir, "network.har"), JSON.stringify(har, null, 2), "utf8"),
    fs.writeFile(path.join(handle.repDir, "manifest.schema.json"), JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "UIWarden Browser Rep Manifest",
      type: "object",
      required: ["schemaVersion", "artifactKind", "browserRunId", "metadata", "evidence"],
      properties: {
        schemaVersion: { const: "uiwarden-browser-rep/v1" },
        artifactKind: { const: "browser-rep" },
        browserRunId: { type: "string" },
        captureStopReason: { type: "string" },
        metadata: { type: "object" },
        evidence: { type: "object" }
      }
    }, null, 2), "utf8"),
    fs.writeFile(path.join(handle.repDir, "README.md"), [
      `# UIWarden Browser Rep ${handle.execution.runId}`,
      "",
      `- 开始：${handle.execution.startedAt}`,
      `- 结束：${stoppedAt}`,
      `- 停止原因：${input.stopReason}`,
      `- 测试结论：${input.testOutcome ?? "unknown"}`,
      `- 采集状态：${captureEmpty ? "incomplete（证据为空）" : "complete"}`,
      "",
      "先读取 manifest.json，再按需查看 streams、screenshots 和 trace。"
    ].join("\n"), "utf8")
  ]);
  await fs.rm(handle.sessionFile, { force: true });
}

export async function waitForEmbeddedAgentControl(
  handle: EmbeddedBrowserRunHandle,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    const state = await getEmbeddedBrowserRunState(handle);
    if (state.controlMode === "agent-control") return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("任务已被中止"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 250);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error("任务已被中止");
}

/** 读取控制桥实时状态，并同步用户人工切换后的可见 target。 */
export async function getEmbeddedBrowserRunState(
  handle: EmbeddedBrowserRunHandle
): Promise<BrowserExecutionSession> {
  const state = await bridgeRequest<BrowserExecutionSession>(
    handle.bridge,
    `/v1/browser/runs/${encodeURIComponent(handle.execution.runId)}`
  );
  if (state.version !== 1 || state.runId !== handle.execution.runId || !state.targetId) {
    throw new Error("内置浏览器执行会话状态无效");
  }
  handle.execution = state;
  return state;
}

export async function diagnoseLatestBrowserRep(session: AgentSession): Promise<{ markdownPath: string; jsonPath: string }> {
  const { runId: latest, repDir } = await latestBrowserRep(session);
  const consoleText = await fs.readFile(path.join(repDir, "streams", "console.jsonl"), "utf8").catch(() => "");
  const networkText = await fs.readFile(path.join(repDir, "streams", "network.jsonl"), "utf8").catch(() => "");
  const pageErrorText = await fs.readFile(path.join(repDir, "streams", "page-errors.jsonl"), "utf8").catch(() => "");
  const networkFailures = networkText.split("\n").filter((line) => /"status":(?:4|5)\d\d|requestfailed/i.test(line)).length;
  const consoleErrors = consoleText.split("\n").filter((line) => /"type":"error"|\berror\b/i.test(line)).length;
  const pageErrors = pageErrorText.split("\n").filter(Boolean).length;
  const layer = pageErrors || consoleErrors ? "frontend" : networkFailures ? "backend-or-environment" : "unknown";
  const confidence = layer === "unknown" ? "low" : "medium";
  const diagnosis = {
    browserRunId: latest,
    suspectedLayer: layer,
    confidence,
    evidence: { pageErrors, consoleErrors, networkFailures },
    nextStep: layer === "unknown" ? "结合截图时间线和 Agent 日志人工复核" : "按时间戳对齐最后操作、错误日志和失败请求"
  };
  const jsonPath = path.join(repDir, "diagnosis.json");
  const markdownPath = path.join(repDir, "diagnosis.md");
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(diagnosis, null, 2), "utf8"),
    fs.writeFile(markdownPath, [
      "# 问题归因分析",
      "",
      `- 疑似层级：${layer}`,
      `- 置信度：${confidence}`,
      `- 页面错误：${pageErrors}`,
      `- Console 错误：${consoleErrors}`,
      `- 失败请求：${networkFailures}`,
      "",
      `下一步：${diagnosis.nextStep}`,
      "",
      layer === "unknown" ? "当前证据不足，不生成确定性因果结论。" : "该结论仅为证据关联，不替代代码级根因确认。"
    ].join("\n"), "utf8")
  ]);
  return { markdownPath, jsonPath };
}

export async function latestBrowserRep(session: AgentSession): Promise<{ runId: string; repDir: string }> {
  const root = path.join(session.workspacePath, ".skill-output", "uiwarden-reps");
  const runs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(runs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const repDir = path.join(root, entry.name);
    const stat = await fs.stat(repDir);
    return { runId: entry.name, repDir, modifiedAt: stat.mtimeMs };
  }));
  const latest = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  if (!latest) throw new Error("当前会话没有内置浏览器 Rep 产物");
  return { runId: latest.runId, repDir: latest.repDir };
}
