import type { ExecutionRuntimeId } from "./types.js";

export const CLAUDE_CODE_RUNTIME_ENABLE_ENV = "UIWARDEN_ENABLE_CLAUDE_CODE_RUNTIME";

/** 判断执行底座是否允许创建或继续任务。 */
export function isExecutionRuntimeEnabled(
  runtimeId: ExecutionRuntimeId,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (runtimeId !== "claude-code") return true;
  return env[CLAUDE_CODE_RUNTIME_ENABLE_ENV]?.trim().toLowerCase() === "true";
}

export function executionRuntimeDisabledDetail(runtimeId: ExecutionRuntimeId): string | undefined {
  if (runtimeId !== "claude-code") return undefined;
  return `Claude Code 兼容底座已按平台策略禁用；后续开放时设置 ${CLAUDE_CODE_RUNTIME_ENABLE_ENV}=true 恢复`;
}
