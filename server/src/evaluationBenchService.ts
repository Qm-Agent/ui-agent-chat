import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import path from "node:path";
import { projectRoot } from "./paths.js";
import type {
  EvaluationResolvedTargetService,
  EvaluationSuite,
  EvaluationTargetServiceDefinition,
  EvaluationTargetServiceStatus
} from "./types.js";

const SERVICE_REFERENCE = /\{\{targetService:([a-zA-Z0-9._-]+)\}\}/g;
const START_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const BUILTIN_BROWSER_PROVIDER = "uiwarden-browser-common-v1";
const BUILTIN_FILES = new Map([
  ["/codex-ui-complex-fixture.html", "codex-ui-complex-fixture.html"],
  ["/codex-ui-complex-frame.html", "codex-ui-complex-frame.html"],
  ["/codex-ui-benchmark-download.txt", "codex-ui-benchmark-download.txt"]
]);

interface ManagedTargetService {
  server: Server;
  baseUrl: string;
  startedAt: string;
  assetsDirectory: string;
}

const managedServices = new Map<string, ManagedTargetService>();
const serviceStarts = new Map<string, Promise<ManagedTargetService>>();

/** 返回评测集声明的目标服务状态，不会隐式启动任何服务。 */
export async function getEvaluationTargetServiceStatuses(
  suite: EvaluationSuite
): Promise<EvaluationTargetServiceStatus[]> {
  return Promise.all((suite.targetServices ?? []).map(async (definition) => {
    if (definition.kind === "managed") {
      const provider = definition.provider ?? "";
      const current = managedServices.get(provider);
      const managed = current?.server.listening ? current : undefined;
      if (current && !managed) managedServices.delete(provider);
      return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        provider: definition.provider,
        status: managed ? "ready" : "stopped",
        startable: Boolean(definition.provider && isSupportedManagedProvider(definition.provider)),
        baseUrl: managed?.baseUrl,
        healthUrl: managed ? new URL("/_uiwarden/health", managed.baseUrl).toString() : undefined,
        startedAt: managed?.startedAt
      };
    }
    return externalTargetServiceStatus(definition);
  }));
}

/** 由用户操作显式启动一个评测集声明的内置目标服务。 */
export async function startEvaluationTargetService(
  suite: EvaluationSuite,
  serviceId: string
): Promise<EvaluationTargetServiceStatus> {
  const definition = requiredServiceDefinition(suite, serviceId);
  if (definition.kind !== "managed" || !definition.provider) {
    throw new Error(`目标服务“${definition.name}”由外部管理，UIWarden 无法启动`);
  }
  if (!isSupportedManagedProvider(definition.provider)) {
    throw new Error(`不支持的内置评测服务 Provider：${definition.provider}`);
  }
  await startManagedBrowserService(definition.provider);
  const statuses = await getEvaluationTargetServiceStatuses(suite);
  return statuses.find((item) => item.id === serviceId)!;
}

/** 停止一个由评测实验室启动的目标服务。 */
export async function stopEvaluationTargetService(
  suite: EvaluationSuite,
  serviceId: string
): Promise<EvaluationTargetServiceStatus> {
  const definition = requiredServiceDefinition(suite, serviceId);
  if (definition.kind !== "managed" || !definition.provider) {
    throw new Error(`目标服务“${definition.name}”由外部管理，UIWarden 无法停止`);
  }
  const managed = managedServices.get(definition.provider);
  if (managed) {
    managedServices.delete(definition.provider);
    await new Promise<void>((resolve, reject) => {
      managed.server.close((error) => error ? reject(error) : resolve());
    });
  }
  const statuses = await getEvaluationTargetServiceStatuses(suite);
  return statuses.find((item) => item.id === serviceId)!;
}

/** 评测启动门禁：所有声明的服务必须 ready，并冻结本次实际地址。 */
export async function resolveEvaluationTargetServices(
  suite: EvaluationSuite
): Promise<EvaluationResolvedTargetService[]> {
  const definitions = suite.targetServices ?? [];
  if (!definitions.length) return [];
  const statuses = await getEvaluationTargetServiceStatuses(suite);
  const unavailable = statuses.filter((item) => item.status !== "ready");
  if (unavailable.length) {
    const names = unavailable.map((item) => item.name).join("、");
    throw new Error(`评测目标服务未就绪：${names}。请在启动评测窗口中先检测并手动启动服务`);
  }
  return definitions.map((definition) => {
    const status = statuses.find((item) => item.id === definition.id);
    if (!status?.baseUrl) throw new Error(`评测目标服务缺少可用地址：${definition.name}`);
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      provider: definition.provider,
      baseUrl: status.baseUrl,
      healthUrl: status.healthUrl
    };
  });
}

/** 将逻辑服务引用解析为本次运行冻结的实际 URL。 */
export function resolveEvaluationTargetUrl(
  targetUrl: string | undefined,
  services: EvaluationResolvedTargetService[] | undefined
): string | undefined {
  if (!targetUrl) return undefined;
  return targetUrl.replace(SERVICE_REFERENCE, (_match, serviceId: string) => {
    const service = services?.find((item) => item.id === serviceId);
    if (!service) throw new Error(`评测目标 URL 引用了未就绪服务：${serviceId}`);
    return service.baseUrl.replace(/\/+$/, "");
  });
}

/** 测试和进程收尾使用；产品页面不会自动调用。 */
export async function stopAllEvaluationTargetServices(): Promise<void> {
  const services = [...managedServices.values()];
  managedServices.clear();
  serviceStarts.clear();
  await Promise.all(services.map((managed) => new Promise<void>((resolve) => {
    managed.server.close(() => resolve());
  })));
}

function requiredServiceDefinition(
  suite: EvaluationSuite,
  serviceId: string
): EvaluationTargetServiceDefinition {
  const definition = suite.targetServices?.find((item) => item.id === serviceId);
  if (!definition) throw new Error(`评测集未声明目标服务：${serviceId}`);
  return definition;
}

async function externalTargetServiceStatus(
  definition: EvaluationTargetServiceDefinition
): Promise<EvaluationTargetServiceStatus> {
  if (!definition.baseUrl) {
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      status: "error",
      startable: false,
      error: "外部目标服务未配置 baseUrl"
    };
  }
  const healthUrl = new URL(definition.healthPath || "/", definition.baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual"
    });
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      status: response.ok || (response.status >= 300 && response.status < 400) ? "ready" : "error",
      startable: false,
      baseUrl: definition.baseUrl,
      healthUrl,
      error: response.ok || (response.status >= 300 && response.status < 400)
        ? undefined
        : `健康检查返回 HTTP ${response.status}`
    };
  } catch (error) {
    return {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      status: "error",
      startable: false,
      baseUrl: definition.baseUrl,
      healthUrl,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSupportedManagedProvider(provider: string): boolean {
  return provider === BUILTIN_BROWSER_PROVIDER;
}

async function startManagedBrowserService(provider: string): Promise<ManagedTargetService> {
  const existing = managedServices.get(provider);
  if (existing?.server.listening) return existing;
  if (existing) managedServices.delete(provider);
  const pending = serviceStarts.get(provider);
  if (pending) return pending;
  const start = createManagedBrowserService(provider);
  serviceStarts.set(provider, start);
  try {
    const managed = await start;
    managedServices.set(provider, managed);
    return managed;
  } finally {
    serviceStarts.delete(provider);
  }
}

async function createManagedBrowserService(provider: string): Promise<ManagedTargetService> {
  const assetsDirectory = await resolveBenchAssetsDirectory();
  const server = http.createServer((request, response) => {
    void handleBenchRequest(request, response, provider, assetsDirectory);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("内置评测服务启动超时"));
    }, START_TIMEOUT_MS);
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("内置评测服务未获得有效监听地址");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    startedAt: new Date().toISOString(),
    assetsDirectory
  };
}

async function resolveBenchAssetsDirectory(): Promise<string> {
  const candidates = [
    process.env.UIWARDEN_EVALUATION_BENCH_ASSETS_DIR,
    path.join(projectRoot, "evaluation-bench-assets"),
    path.join(projectRoot, "test", "fixtures", "browser")
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    const valid = await Promise.all([...BUILTIN_FILES.values()].map((fileName) =>
      fs.access(path.join(candidate, fileName)).then(() => true, () => false)
    ));
    if (valid.every(Boolean)) return candidate;
  }
  throw new Error(`内置评测资源不完整，已检查：${candidates.join("、")}`);
}

async function handleBenchRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  provider: string,
  assetsDirectory: string
): Promise<void> {
  const method = request.method || "GET";
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (pathname === "/_uiwarden/health") {
    sendJson(response, method, 200, {
      status: "ready",
      service: provider,
      schemaVersion: "1.0",
      capabilities: ["form", "table", "dialog", "drag-drop", "shadow-dom", "iframe", "tabs", "files", "scroll"]
    });
    return;
  }
  if (pathname === "/") {
    response.writeHead(302, { Location: "/codex-ui-complex-fixture.html" }).end();
    return;
  }
  const fileName = BUILTIN_FILES.get(pathname);
  if (!fileName) {
    sendJson(response, method, 404, { error: "fixture-route-not-found", path: pathname });
    return;
  }
  try {
    const content = await fs.readFile(path.join(assetsDirectory, fileName));
    response.writeHead(200, { "Content-Type": contentType(fileName) });
    response.end(method === "HEAD" ? undefined : content);
  } catch (error) {
    sendJson(response, method, 500, {
      error: "fixture-read-failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function sendJson(
  response: http.ServerResponse,
  method: string,
  status: number,
  value: unknown
): void {
  const content = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.byteLength
  });
  response.end(method === "HEAD" ? undefined : content);
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
