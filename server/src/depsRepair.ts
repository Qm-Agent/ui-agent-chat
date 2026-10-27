/**
 * 桌面客户端依赖一键修复。
 *
 * 修复策略（与 SKILL.md 安装指引一致）：
 * - python / browser-use / playwright-chromium / playwright-firefox：
 *   建 ~/.venvs/ui-test-assistant venv → 安装客户端内置 browser-use 3.1.6 wheel
 *   → python -m playwright install chromium → 持久化 UI_TEST_PYTHON。
 * - claude-cli：npm install -g @anthropic-ai/claude-code（需本机已有 npm）。
 * - chrome：不支持自动修复，仅给手动指引。
 *
 * 修复过程通过 SSE 逐行透传 stdout/stderr；单依赖项互斥防并发。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Response } from "express";
import {
  BROWSER_USE_VERSION,
  DEFAULT_VENV_DIR,
  type DepId,
  findExecutable,
  readDepsState,
  resolveBrowserUseWheel,
  resolveBundledUiTestRuntime,
  resolvePythonCandidate,
  resolveUserPath,
  venvPythonPath,
  writeDepsState
} from "./depsCheck.js";

interface RepairStep {
  label: string;
  file: string;
  args: string[];
}

const runningRepairs = new Set<DepId>();

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function runStep(res: Response, step: RepairStep): Promise<number> {
  return new Promise((resolve) => {
    sseSend(res, "step", { label: step.label, command: [step.file, ...step.args].join(" ") });
    const child = spawn(step.file, step.args, {
      env: { ...process.env, PATH: resolveUserPath() },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) sseSend(res, "log", { line });
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => {
      sseSend(res, "log", { line: `spawn 失败：${String(error)}` });
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/**
 * 解析 Python 修复链使用的基础解释器：
 * 优先用户本机 python3（venv 的种子解释器）。
 */
function findSystemPython(): string | null {
  for (const cmd of ["python3.12", "python3.11", "python3.10", "python3", "python"]) {
    const found = findExecutable(cmd);
    if (found) return found;
  }
  return null;
}

async function pythonChainSteps(target: DepId): Promise<RepairStep[] | { error: string }> {
  const bundled = resolveBundledUiTestRuntime();
  if (bundled) {
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= bundled.browsersPath;
    process.env.PLAYWRIGHT_SKIP_BROWSER_GC ||= "1";
    const browserProbe = target === "playwright-chromium" ? "chromium"
      : target === "playwright-firefox" ? "firefox"
        : undefined;
    const probe = browserProbe
      ? `from importlib.metadata import version; from playwright.sync_api import sync_playwright; assert version('browser-use') == '3.1.6'; p=sync_playwright().start(); b=p.${browserProbe}.launch(headless=True); b.close(); p.stop(); print('bundled Runtime OK')`
      : "from importlib.metadata import version; assert version('browser-use') == '3.1.6'; assert version('playwright') == '1.58.0'; print('bundled Runtime OK')";
    return [{
      label: "校验安装包内置 UI 测试 Runtime",
      file: bundled.pythonPath,
      args: ["-c", probe]
    }];
  }
  const venvPy = venvPythonPath();
  const steps: RepairStep[] = [];
  const browserUseWheel = resolveBrowserUseWheel();
  if (!browserUseWheel) {
    return {
      error: "安装包缺少经过校验的 browser-use 3.1.6 SDK wheel。请重新安装完整的 UIWarden 客户端；客户端不会从 PyPI 下载同名替代包。"
    };
  }

  // 1) venv 不存在则创建（python 缺失本身也走这条链）
  if (!fs.existsSync(venvPy)) {
    const seed = findSystemPython();
    if (!seed) {
      return {
        error:
          "本机未找到 Python 3。请先安装 Python 3.10+（如 brew install python@3.12），再回来重试一键修复。"
      };
    }
    steps.push({ label: "创建虚拟环境", file: seed, args: ["-m", "venv", DEFAULT_VENV_DIR] });
  }

  // 始终从安装包内审核 wheel 装/对齐 SDK。其余 Python 依赖按用户 pip 源解析。
  steps.push({
    label: `安装内置 browser-use SDK ${BROWSER_USE_VERSION}`,
    file: venvPy,
    args: ["-m", "pip", "install", browserUseWheel]
  });

  // 3) Playwright Chromium
  if (target === "playwright-chromium") {
    steps.push({
      label: "安装 Playwright Chromium",
      file: venvPy,
      args: ["-m", "playwright", "install", "chromium"]
    });
  }
  if (target === "playwright-firefox") {
    steps.push({
      label: "安装 Playwright Firefox",
      file: venvPy,
      args: ["-m", "playwright", "install", "firefox"]
    });
  }
  return steps;
}

async function claudeCliSteps(): Promise<RepairStep[] | { error: string }> {
  const npm = findExecutable("npm");
  if (!npm) {
    return {
      error:
        "本机未找到 npm，无法自动安装 claude CLI。请手动执行官方安装脚本或安装 Node.js 后重试。"
    };
  }
  return [
    {
      label: "安装 Claude CLI",
      file: npm,
      args: ["install", "-g", "@anthropic-ai/claude-code"]
    }
  ];
}

async function codexCliSteps(): Promise<RepairStep[] | { error: string }> {
  const npm = findExecutable("npm");
  if (!npm) {
    return { error: "本机未找到 npm，无法自动安装 Codex CLI。请先安装 Node.js。" };
  }
  return [{ label: "安装 Codex CLI", file: npm, args: ["install", "-g", "@openai/codex"] }];
}

/**
 * 执行指定依赖项的修复流程，全程 SSE 输出。
 * 返回前会把选定解释器持久化为 UI_TEST_PYTHON（Python 链）。
 */
export async function repairDependency(depId: DepId, res: Response): Promise<void> {
  if (runningRepairs.has(depId)) {
    sseSend(res, "error", { message: "该依赖项正在修复中，请勿重复触发" });
    res.end();
    return;
  }
  runningRepairs.add(depId);
  try {
    let steps: RepairStep[] | { error: string };
    switch (depId) {
      case "python":
      case "browser-use":
      case "playwright-chromium":
      case "playwright-firefox":
        steps = await pythonChainSteps(depId);
        break;
      case "claude-cli":
        steps = await claudeCliSteps();
        break;
      case "codex-cli":
        steps = await codexCliSteps();
        break;
      case "dtcoder-cli":
        steps = { error: "UIWarden 不内置 AiWork 下载地址或安装器。请先按供应方公开文档安装 CLI，或设置 UI_AGENT_AIWORK_BIN。" };
        break;
      default:
        steps = { error: "该依赖项不支持自动修复，请按手动指引处理" };
    }

    if (!Array.isArray(steps)) {
      sseSend(res, "error", { message: steps.error });
      res.end();
      return;
    }

    for (const step of steps) {
      const code = await runStep(res, step);
      if (code !== 0) {
        sseSend(res, "error", {
          message: `「${step.label}」失败（exit ${code}）。可复制命令到系统终端重试：${step.file} ${step.args.join(" ")}`
        });
        res.end();
        return;
      }
    }

    // Python 链修复成功后持久化解释器选择，立即对当前进程生效
    if (depId === "python" || depId === "browser-use" || depId === "playwright-chromium" || depId === "playwright-firefox") {
      const bundled = resolveBundledUiTestRuntime();
      if (bundled) {
        process.env.UI_TEST_PYTHON = bundled.pythonPath;
        process.env.PLAYWRIGHT_BROWSERS_PATH ||= bundled.browsersPath;
        sseSend(res, "log", { line: `已启用安装包内置 UI 测试 Runtime：${bundled.root}` });
        sseSend(res, "done", { depId });
        res.end();
        return;
      }
      const venvPy = venvPythonPath();
      if (fs.existsSync(venvPy)) {
        const state = await readDepsState();
        await writeDepsState({ ...state, pythonPath: venvPy });
        process.env.UI_TEST_PYTHON = venvPy;
        sseSend(res, "log", { line: `UI_TEST_PYTHON 已指向 ${venvPy}` });
      } else {
        const fallback = await resolvePythonCandidate();
        if (fallback) {
          const state = await readDepsState();
          await writeDepsState({ ...state, pythonPath: fallback });
          process.env.UI_TEST_PYTHON = fallback;
        }
      }
    }

    sseSend(res, "done", { depId });
    res.end();
  } finally {
    runningRepairs.delete(depId);
  }
}
