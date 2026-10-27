import type { TestOutcome } from "./types.js";

export interface TestResultParse {
  outcome: TestOutcome;
  summary?: string;
}

/**
 * 从 agent 输出文本中解析测试断言结论（PASS/FAIL）。
 * 与执行状态正交：执行成功但输出 FAIL 视为"测试未通过"。
 *
 * 解析策略：
 * 1. 取末尾 ~2000 字符窗口（结论通常在末尾）。
 * 2. 失败优先匹配（避免"测试未通过"被"通过"子串误判）。
 * 3. 命中 PASS 标记 -> pass。
 * 4. 都不命中 -> unknown（agent 未给出明确结论）。
 *
 * 纯函数，无运行时副作用，可独立单测。
 */
export function parseTestOutcome(assistantText: string): TestResultParse {
  const text = (assistantText ?? "").trim();
  if (!text) {
    return { outcome: "unknown" };
  }
  const window = text.length > 2000 ? text.slice(-2000) : text;
  const lines = window.split(/\r?\n/);

  // 失败优先检测（避免"测试未通过"被"通过"子串误判）。
  const failPatterns = [
    /\bFAIL\b/i,
    /未通过/,
    /不通过/,
    /测试失败/,
    /不符合预期/,
    /校验失败/,
    /验证失败/,
    /❌/
  ];
  const passPatterns = [
    /\bPASS\b/i,
    /测试通过/,
    /巡检通过/,
    /回归通过/,
    /符合预期/,
    /校验通过/,
    /验证通过/,
    /✅/
  ];

  let failLine: string | undefined;
  let passLine: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (failLine === undefined && failPatterns.some((p) => p.test(trimmed))) {
      failLine = trimmed;
      break;
    }
    if (passLine === undefined && passPatterns.some((p) => p.test(trimmed))) {
      passLine = trimmed;
    }
  }

  if (failLine) {
    return { outcome: "fail", summary: failLine.slice(0, 200) };
  }
  if (passLine) {
    return { outcome: "pass", summary: passLine.slice(0, 200) };
  }
  return { outcome: "unknown" };
}
