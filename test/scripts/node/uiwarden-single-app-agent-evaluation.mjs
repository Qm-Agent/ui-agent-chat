import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const caseId = String(process.env.BENCHMARK_CASE_ID || "").trim();
const definition = cases()[caseId];
if (!definition) throw new Error(`BENCHMARK_CASE_ID 无效：${caseId || "(empty)"}`);

const runRoot = path.resolve(process.env.BENCHMARK_RUN_ROOT
  || path.join(repoRoot, ".skill-output", "uiwarden-single-app-20260725", caseId));
const serverEntry = path.join(repoRoot, "dist", "server", "index.js");
const sourceBinary = path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer");
const providerApp = path.join(repoRoot, "native-automation", "target", "native-provider", "dt-gui-computer Provider.app");
const runtimeBinDir = path.join(runRoot, "UIWarden Runtime", "bin");
const runtimeBinary = path.join(runtimeBinDir, "dt-gui-computer");
const runtimeHome = path.join(runRoot, "native-runtime");
const dataRoot = path.join(runRoot, "data");
const outputPath = path.join(runRoot, "result.json");
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || definition.timeoutMs || 8 * 60_000);
let server;
let logs = "";
const startedAt = new Date().toISOString();
const startedMs = Date.now();

try {
  const message = await prepareCaseFixture(definition.message);
  await fs.mkdir(runtimeBinDir, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  try { await fs.symlink(sourceBinary, runtimeBinary); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const database = path.join(dataRoot, "ui-agent-chat.db");
  server = spawn(process.execPath, ["--env-file", path.join(repoRoot, ".env"), serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      UI_AGENT_DESKTOP: "true",
      UI_AGENT_DATA_DIR: dataRoot,
      UI_AGENT_DB_MODE: "sqlite",
      UI_AGENT_DB_FILE: database,

      UI_AGENT_DISABLE_BACKGROUND_TASKS: "true",
      DT_GUI_COMPUTER_BIN: runtimeBinary,
      DT_GUI_COMPUTER_HOME: runtimeHome,
      DT_GUI_COMPUTER_MACOS_PROVIDER: providerApp
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => { logs += String(chunk); });
  server.stderr.on("data", (chunk) => { logs += String(chunk); });
  await waitForServer();
  const payloads = await sendOperation(message, timeoutMs);
  const route = payloads.find((payload) => payload.type === "session")?.data || {};
  const operationTaskId = String(route.operationTaskId || "");
  const operationRunId = String(route.operationRunId || "");
  const sessionId = String(route.sessionId || "");
  const tasks = await fetchJson(`${baseUrl}/api/ui-operations`);
  const task = tasks.find((item) => item.id === operationTaskId);
  const run = task?.runs?.find((item) => item.id === operationRunId);
  const agent = sessionId ? await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`) : undefined;
  const assistantText = payloads
    .filter((payload) => payload.type === "message" && payload.data?.role === "assistant")
    .map((payload) => String(payload.data.content || ""))
    .join("\n");
  const completed = run?.status === "completed" && agent?.status === "completed";
  const nativeCompleted = /\[UIWARDEN_NATIVE_RESULT: completed\]/.test(assistantText);
  await writeResult({
    schemaVersion: 1,
    caseId,
    category: definition.category,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    status: completed && nativeCompleted ? "passed" : completed ? "partial" : "failed",
    operationTaskId,
    operationRunId,
    sessionId,
    runStatus: run?.status,
    agentStatus: agent?.status,
    nativeArtifactDir: run?.nativeArtifactDir,
    assistantText,
    reason: completed && nativeCompleted ? undefined : agent?.lastError || run?.error || "Agent 未产生 completed Native 结果",
    runRoot
  });
} catch (error) {
  await writeResult({
    schemaVersion: 1,
    caseId,
    category: definition.category,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    status: error?.name === "TimeoutError" ? "failed" : "blocked",
    reason: error instanceof Error ? error.message : String(error),
    serverLogTail: logs.slice(-12_000),
    runRoot
  });
  process.exitCode = 1;
} finally {
  if (server) await stopProcess(server);
  await stopActiveRuntimeSessions();
}

function cases() {
  return {
    SL01: {
      category: "DTCoder CN 多轮对话",
      timeoutMs: 8 * 60_000,
      message: "打开 DTCoder CN，新建一个临时对话。在同一个对话中依次完成三轮：第一轮发送‘计算 12×17，只输出结果’，确认回复 204；第二轮发送‘基于上一轮结果减去 44，只输出结果’，确认回复 160；第三轮发送‘把前两轮结果整理为两行 Markdown，格式为 step1=、step2=’，确认回复同时包含 step1=204 和 step2=160。记录当前对话可见标题或会话标识。完成后删除这个临时对话，不要读取或修改其他对话。"
    },
    SL02: {
      category: "DTCoder CN 配置恢复",
      timeoutMs: 10 * 60_000,
      message: "打开 DTCoder CN 的模型与执行底座设置，先观察并记录当前底座和模型。切换到另一个界面明确显示为可用的候选，观察确认生效；新建临时对话发送‘只输出 SWITCH_OK’，确认回复与运行记录。随后恢复原底座和模型，再次观察确认恢复成功，最后删除临时对话。不得修改其他设置；任何原值无法确认时停止，不要猜测。"
    },
    SL03: {
      category: "DTCoder CN 临时工作区编辑",
      timeoutMs: 10 * 60_000,
      message: "在 DTCoder CN 中打开本任务提供的空临时工作区：<WORKSPACE_PATH>。通过文件面板新建 benchmark.md，写入 UIWarden Single-App Benchmark 固定内容并保存；在内置终端执行 pwd 和 wc -c benchmark.md；回到编辑器追加 Conclusion: keep observations compact.，执行一次撤销和一次重做并确认最终内容。只操作这个临时工作区。"
    },
    SL04: {
      category: "DTCoder CN 文件问答",
      timeoutMs: 8 * 60_000,
      message: "在 DTCoder CN 中打开临时工作区：<WORKSPACE_PATH>。新建对话，要求读取 benchmark.md 并输出标题和 Conclusion；第二轮询问文件总行数；第三轮只生成两条修改建议且明确不要修改文件。最后确认 benchmark.md 内容未变化并删除临时对话。"
    },
    SL05: {
      category: "DTCoder CN 停止与续作",
      timeoutMs: 8 * 60_000,
      message: "在 DTCoder CN 中打开临时工作区：<WORKSPACE_PATH>。新建临时对话，发送一个需要多步只读分析当前工作区的任务；观察到首次工具动作后立即点击停止，等待 5 秒并确认没有新增工具动作。随后在同一对话发送‘继续，但只总结已经读取的内容’，确认可以继续回复。最后删除临时对话。"
    },
    SL06: {
      category: "Excel 编辑与汇总",
      timeoutMs: 10 * 60_000,
      message: "打开 Microsoft Excel 并新建临时空白工作簿，确认不是用户已有工作簿后再操作。建立 1月至6月的华东、华南、华北、目标固定数据表，新增合计和完成率列，使用公式逐行计算；底部计算三个区域合计、总合计、平均完成率、最大和最小月合计。确认月合计依次为 320、338、390、390、435、480，总合计 2353，区域合计为 868、717、768，平均完成率约107.23%，最大480、最小320。完成后关闭临时工作簿并选择不保存。"
    },
    SL07: {
      category: "Excel 排序筛选与纠错",
      timeoutMs: 10 * 60_000,
      message: "打开 Microsoft Excel 并新建临时空白工作簿，录入评测输入集 SL06 的固定数据。按合计降序排序，筛选完成率大于等于100%的月份。将2月华北98误改为89，观察结果后执行撤销、重做、再撤销，最终恢复98。确认排序首行为6月，筛选只含1月、3月、4月、5月、6月。关闭时不保存。"
    },
    SL08: {
      category: "Excel 多工作表",
      timeoutMs: 10 * 60_000,
      message: "打开 Microsoft Excel 并新建临时空白工作簿，录入评测输入集 SL06 固定数据。将工作表命名为原始数据，新增汇总工作表，通过跨表公式生成区域总计、月均值、总合计和每月是否达标，冻结首行并往返核对。确认华东868、华南717、华北768、总合计2353，达标月份为1月、3月、4月、5月、6月。关闭时不保存。"
    },
    SL09: {
      category: "Excel 格式与图表",
      timeoutMs: 10 * 60_000,
      message: "打开 Microsoft Excel 并新建临时空白工作簿，录入评测输入集 SL06 固定数据及公式。设置完成率百分比两位小数，对低于100%的行应用红色条件格式，创建按月份展示合计和目标的簇状柱形图，标题改为月度完成情况。确认仅2月命中条件格式，图表有6个分类和2个系列。关闭时不保存。"
    },
    SL10: {
      category: "PowerPoint 完整编辑",
      timeoutMs: 10 * 60_000,
      message: "打开 Microsoft PowerPoint 并新建临时演示文稿，确认不是用户已有文件后操作。创建封面、能力清单、对比表、风险、结论共5页；第3页插入3×3表格，第4页插入三个形状并对齐，第5页添加演讲者备注。交换第4、5页顺序后撤销并重做，最终确认5页内容和顺序。关闭时不保存。"
    },
    SL11: {
      category: "备忘录长编辑",
      timeoutMs: 8 * 60_000,
      message: "打开备忘录，新建标题为 UIWarden Single-App Benchmark Temporary 的临时备忘录，输入三级结构、5个核对项和3×3表格，勾选第2和第4项；使用搜索定位该笔记；修改结论后撤销并重做；移动到新建的临时文件夹后再移回原位置。确认内容与状态后将笔记和临时文件夹移入最近删除，不永久删除，不操作其他笔记。"
    },
    SL13: {
      category: "系统设置只读巡检",
      timeoutMs: 8 * 60_000,
      message: "打开系统设置，只读完成巡检：依次进入通用/关于本机、隐私与安全性/辅助功能、隐私与安全性/屏幕与系统音频录制，读取系统版本以及 UIWarden 的两个权限状态，然后返回设置首页。不得切换任何权限开关或修改设置。"
    }
  };
}

async function prepareCaseFixture(message) {
  if (!message.includes("<WORKSPACE_PATH>")) return message;
  const workspacePath = path.join(runRoot, "fixture-workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  if (caseId === "SL04" || caseId === "SL05") {
    const fixture = [
      "# UIWarden Single-App Benchmark",
      "",
      "Purpose: validate a bounded desktop workflow.",
      "Owner: UIWarden benchmark.",
      "Conclusion: keep observations compact."
    ].join("\n");
    await fs.writeFile(path.join(workspacePath, "benchmark.md"), `${fixture}\n`, "utf8");
  }
  return message.replaceAll("<WORKSPACE_PATH>", workspacePath);
}

async function sendOperation(message, operationTimeoutMs) {
  const response = await fetch(`${baseUrl}/api/ui-operations/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      businessId: "",
      executionTarget: {
        kind: "native-app",
        providerId: "macos-accessibility",
        app: { kind: "name", value: "__agent_select__" },
        displayName: "Agent 自动选择"
      },
      approvalMode: "none"
    }),
    signal: AbortSignal.timeout(operationTimeoutMs)
  });
  if (!response.ok || !response.body) throw new Error(`UI operation HTTP ${response.status}: ${await response.text()}`);
  return readSse(response.body);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function readSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const payloads = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data) payloads.push(JSON.parse(data));
    }
    if (done) break;
  }
  return payloads;
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}: ${logs.slice(-4000)}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server startup timeout: ${logs.slice(-4000)}`);
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  const selectedPort = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => listener.close(resolve));
  return selectedPort;
}

async function writeResult(result) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ caseId, status: result.status, outputPath, reason: result.reason })}\n`);
}

async function stopProcess(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

async function stopActiveRuntimeSessions() {
  const sessionsDir = path.join(runtimeHome, "sessions");
  let entries = [];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionPath = path.join(sessionsDir, entry.name);
    let session;
    try {
      session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    } catch {
      continue;
    }
    if (session?.state !== "active" || !session?.sessionId) continue;
    await runCli([
      "--runtime-home", runtimeHome,
      "session", "stop",
      "--session", session.sessionId,
      "--reason", "benchmark-harness-cleanup",
      "--json"
    ]);
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(runtimeBinary, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        DT_GUI_COMPUTER_NODE: process.execPath,
        DT_GUI_COMPUTER_MACOS_PROVIDER: providerApp
      },
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}
