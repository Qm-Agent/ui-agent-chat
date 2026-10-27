import type { ExecutionRuntimeId, ModelProfile } from "./types.js";

export interface ModelConnectionResult {
  ok: true;
  runtimeId: ExecutionRuntimeId;
  protocol: "anthropic" | "openai" | "runtime-managed";
  latencyMs: number;
  detail: string;
}

const CONNECTION_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY_LENGTH = 600;

export async function testModelProfileConnection(profile: ModelProfile): Promise<ModelConnectionResult> {
  const baseUrl = profile.baseUrl.trim();
  const authToken = profile.authToken.trim();
  const model = profile.model.trim();
  if (!baseUrl && !authToken) {
    return {
      ok: true,
      runtimeId: profile.runtimeId,
      protocol: "runtime-managed",
      latencyMs: 0,
      detail: "该配置使用执行底座本地认证与路由，无独立服务地址可探测"
    };
  }
  if (!baseUrl || !authToken || !model) {
    throw new Error("自定义路由必须同时填写 API Base URL、API Token 和主模型");
  }

  const protocols = profile.runtimeId === "codex"
    ? ["openai"] as const
    : profile.runtimeId === "dtcoder"
      ? ["anthropic", "openai"] as const
      : ["anthropic"] as const;
  const failures: string[] = [];
  for (const protocol of protocols) {
    try {
      return await probeProtocol(profile, protocol);
    } catch (error) {
      failures.push(`${protocol === "anthropic" ? "Anthropic" : "OpenAI"}：${safeErrorMessage(error)}`);
    }
  }
  throw new Error(failures.join("；"));
}

async function probeProtocol(
  profile: ModelProfile,
  protocol: "anthropic" | "openai"
): Promise<ModelConnectionResult> {
  const endpoint = buildProbeEndpoint(profile.baseUrl, protocol);
  const wireModel = resolveWireModel(profile);
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: protocol === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": profile.authToken,
          authorization: `Bearer ${profile.authToken}`,
          "anthropic-version": "2023-06-01"
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${profile.authToken}`
        },
    body: JSON.stringify(protocol === "anthropic"
      ? {
          model: wireModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "Reply OK" }]
        }
      : {
          model: wireModel,
          input: "Reply OK",
          max_output_tokens: 16
        }),
    signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS)
  });
  const latencyMs = Date.now() - startedAt;
  const responseText = await response.text();
  if (!response.ok) {
    const detail = sanitizeResponseText(responseText, profile.authToken);
    throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
  }
  const payload = parseModelResponse(responseText);
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload) {
    throw new Error(`服务返回错误：${sanitizeResponseText(JSON.stringify(payload.error), profile.authToken)}`);
  }
  return {
    ok: true,
    runtimeId: profile.runtimeId,
    protocol,
    latencyMs,
    detail: `${protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Responses"} 联通成功`
  };
}

export function resolveWireModel(profile: Pick<ModelProfile, "runtimeId" | "model">): string {
  if (profile.runtimeId !== "dtcoder") return profile.model;
  const separator = profile.model.indexOf("/");
  return separator >= 0 ? profile.model.slice(separator + 1) : profile.model;
}

function parseModelResponse(value: string): unknown {
  if (!value.trim()) {
    throw new Error("服务返回空响应，无法确认模型协议");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("服务返回的不是 JSON 模型响应，请检查 Base URL 是否指向 API 根路径");
  }
}

export function buildProbeEndpoint(baseUrl: string, protocol: "anthropic" | "openai"): string {
  const url = new URL(baseUrl.trim());
  const endpointSuffix = protocol === "anthropic" ? "/messages" : "/responses";
  const completeSuffix = `/v1${endpointSuffix}`;
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(completeSuffix) || pathname.endsWith(endpointSuffix)) {
    url.pathname = pathname;
  } else if (pathname.endsWith("/v1")) {
    url.pathname = `${pathname}${endpointSuffix}`;
  } else {
    url.pathname = `${pathname}${completeSuffix}`;
  }
  return url.toString();
}

function sanitizeResponseText(value: string, authToken: string): string {
  const compact = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  const withoutExactToken = authToken
    ? compact.replaceAll(authToken, "[redacted]")
    : compact;
  return withoutExactToken
    .replace(/(?:sk|ak)-[a-z0-9._-]+/gi, "[redacted]")
    .slice(0, MAX_ERROR_BODY_LENGTH);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `连接超过 ${CONNECTION_TIMEOUT_MS / 1000} 秒未响应`;
  }
  if (error instanceof TypeError && /invalid url/i.test(error.message)) {
    return "API Base URL 格式无效";
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    const cause = error.cause instanceof Error ? error.cause.message : "";
    return cause ? `网络连接失败：${cause}` : "网络连接失败，请检查地址、代理和证书";
  }
  return error instanceof Error ? error.message : String(error);
}
