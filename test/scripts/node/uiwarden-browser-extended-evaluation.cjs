const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow } = require("electron");

const repoRoot = path.resolve(__dirname, "../../..");
const fixturePath = path.join(repoRoot, "test", "fixtures", "browser", "codex-ui-complex-fixture.html");
const outputPath = path.resolve(process.env.BENCHMARK_OUTPUT
  || path.join(repoRoot, ".skill-output", "uiwarden-benchmark-20260725", "browser-extended.json"));
const artifactRoot = path.resolve(process.env.BENCHMARK_ARTIFACT_ROOT
  || path.join(repoRoot, ".skill-output", "uiwarden-benchmark-20260725", "browser-artifacts"));
const cdpPort = 47000 + Math.floor(Math.random() * 1000);

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-allow-origins", "*");

async function main() {
  await app.whenReady();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-browser-extended-"));
  process.env.DT_GUI_BROWSER_HOME = path.join(temporary, "browser-home");
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } });
  const runtime = await import(pathToFileUrl(path.join(repoRoot, "browser-automation", "src", "runtime.mjs")));
  const results = [];
  try {
    const requestedIds = new Set(String(process.env.BENCHMARK_CASE_IDS || "")
      .split(",").map((item) => item.trim()).filter(Boolean));
    const selectedCases = requestedIds.size > 0
      ? cases().filter((definition) => requestedIds.has(definition.id))
      : cases();
    if (selectedCases.length === 0) throw new Error(`No benchmark cases matched: ${[...requestedIds].join(",")}`);
    for (const definition of selectedCases) results.push(await runCase(definition, { window, runtime }));
    const summary = summarize(results);
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runner: "uiwarden-browser-extended-evaluation",
      runtimeVersion: runtime.RUNTIME_VERSION,
      environment: { platform: process.platform, architecture: process.arch, electron: process.versions.electron, chromium: process.versions.chrome },
      methodology: "Each scenario uses a fresh UIWarden Browser session bound to an Electron WebContents target. Actions and observations use dt-gui-browser Runtime APIs only; BrowserWindow loadFile is harness setup/reset.",
      scenarios: results,
      summary
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, outputPath, summary })}\n`);
  } finally {
    window.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
    await app.quit();
  }
}

function cases() {
  return [
    routeCase("B01", "动态表格"), routeCase("B02", "复合组件"), routeCase("B03", "诊断与文件"),
    { id: "B04", category: "组合表单", run: runForm },
    { id: "B05", category: "表单校验", run: runInvalidForm },
    { id: "B06", category: "表单状态", run: runReset },
    { id: "B07", category: "动态表格筛选", run: runTableFilter },
    { id: "B08", category: "动态表格状态筛选", run: runStatusFilter },
    { id: "B09", category: "动态表格排序", run: runSort },
    { id: "B10", category: "动态表格分页", run: runPagination },
    { id: "B11", category: "动态表格编辑", run: runTableEdit },
    { id: "B12", category: "异步状态", run: runAsync },
    { id: "B13", category: "复合组件 Tab", run: runInnerTabs },
    { id: "B14", category: "HTML 弹窗", run: runHtmlDialog },
    { id: "B15", category: "JavaScript 弹窗", run: runJavaScriptDialog },
    { id: "B16", category: "组合快捷键", run: runShortcut },
    { id: "B17", category: "HTML5 拖放", run: runDragAndDrop },
    { id: "B18", category: "Shadow DOM", run: runShadow },
    { id: "B19", category: "同源 iframe", run: runFrame },
    { id: "B20", category: "折叠内容", run: runDetails },
    { id: "B21", category: "Console 诊断", run: runConsoleDiagnostics },
    { id: "B22", category: "新标签页和下载", run: runNewTabAndDownload },
    { id: "B23", category: "文件、滚动与历史", run: runUploadScrollHistory },
    { id: "SL12", category: "Browser 单应用长流程", run: runSingleSessionLongFlow }
  ];
}

function routeCase(id, label) {
  return { id, category: "SPA 路由", run: async (ctx) => {
    let snapshot = await ctx.observe();
    await ctx.click(snapshot, label, "button");
    snapshot = await ctx.observe();
    assertText(snapshot, `ROUTE:${routeFor(label)}`);
  } };
}

function unsupportedCase(id, category, reason) {
  return { id, category, unsupported: reason };
}

async function runCase(definition, context) {
  const started = performance.now();
  const artifacts = path.join(artifactRoot, definition.id);
  let session;
  let actions = 0;
  let observations = 0;
  let evidence = [];
  try {
    if (definition.unsupported) return record(definition, "failed", started, { reason: definition.unsupported });
    await context.window.loadFile(fixturePath);
    const target = await waitForTarget(context.window.webContents.getURL());
    session = await context.runtime.startSession({
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      targetId: target.id,
      artifactRoot: artifacts,
      runId: `evaluation-${definition.id}`
    });
    const api = {
      async observe() {
        const snapshot = await context.runtime.observe(session.sessionId, { fullPage: false });
        observations += 1;
        evidence.push(rel(snapshot.screenshotPath));
        return snapshot;
      },
      async click(snapshot, name, tag) {
        const item = find(snapshot, name, tag);
        await context.runtime.performElementAction(session.sessionId, { kind: "click", snapshotId: snapshot.snapshotId, elementId: item.elementId });
        actions += 1;
      },
      async setValue(snapshot, name, value, tag) {
        const item = find(snapshot, name, tag);
        await context.runtime.performElementAction(session.sessionId, { kind: "set-value", snapshotId: snapshot.snapshotId, elementId: item.elementId, value });
        actions += 1;
      },
      async select(snapshot, name, value) {
        const item = find(snapshot, name, "select");
        await context.runtime.performElementAction(session.sessionId, { kind: "select-option", snapshotId: snapshot.snapshotId, elementId: item.elementId, value });
        actions += 1;
      },
      async scroll() {
        await context.runtime.scroll(session.sessionId, { direction: "down", pages: 8 });
        actions += 1;
      },
      async back() { await context.runtime.goBack(session.sessionId); actions += 1; },
      async forward() { await context.runtime.goForward(session.sessionId); actions += 1; },
      async tabs() { return context.runtime.listTabs(session.sessionId); },
      async activate(targetId) {
        await context.runtime.activateTab(session.sessionId, targetId);
        actions += 1;
      },
      async probeDialog(snapshot, name) {
        const item = find(snapshot, name, "button");
        try {
          await context.runtime.performElementAction(session.sessionId, {
            kind: "click",
            snapshotId: snapshot.snapshotId,
            elementId: item.elementId
          });
        } catch (error) {
          if (error?.code === "DIALOG_RESPONSE_REQUIRED") return error.details?.dialog;
          throw error;
        }
        throw new Error("expected DIALOG_RESPONSE_REQUIRED");
      },
      async clickDialog(snapshot, name, dialogAction, promptText) {
        const item = find(snapshot, name, "button");
        await context.runtime.performElementAction(session.sessionId, {
          kind: "click",
          snapshotId: snapshot.snapshotId,
          elementId: item.elementId,
          dialogAction,
          promptText
        });
        actions += 1;
      },
      async key(key) {
        await context.runtime.sendKey(session.sessionId, key);
        actions += 1;
      },
      async drag(snapshot, sourceName, targetName) {
        const source = find(snapshot, sourceName);
        const target = find(snapshot, targetName);
        await context.runtime.dragElement(session.sessionId, {
          snapshotId: snapshot.snapshotId,
          sourceElementId: source.elementId,
          targetElementId: target.elementId
        });
        actions += 1;
      },
      async upload(snapshot, inputName, fileName, content) {
        const filePath = path.join(artifacts, fileName);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
        const input = find(snapshot, inputName, "input");
        await context.runtime.uploadFile(session.sessionId, {
          snapshotId: snapshot.snapshotId,
          elementId: input.elementId,
          filePath
        });
        actions += 1;
      },
      async expectUploadRejected(snapshot, inputName, filePath, expectedCode) {
        const input = find(snapshot, inputName, "input");
        try {
          await context.runtime.uploadFile(session.sessionId, {
            snapshotId: snapshot.snapshotId,
            elementId: input.elementId,
            filePath
          });
        } catch (error) {
          if (error?.code === expectedCode) return;
          throw error;
        }
        throw new Error(`upload unexpectedly accepted: ${filePath}`);
      },
      async createUploadSymlink(name, target) {
        const linkPath = path.join(artifacts, name);
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.symlink(target, linkPath);
        return linkPath;
      },
      async readStream(name) {
        const content = await fs.readFile(path.join(session.artifactDir, "streams", `${name}.jsonl`), "utf8");
        return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      }
    };
    const outcome = await definition.run(api);
    const stopped = await context.runtime.stopSession(session.sessionId, "evaluation-complete");
    return record(definition, outcome?.status || "passed", started, {
      actions,
      observations,
      evidence: unique(evidence),
      artifactDir: rel(stopped.artifactDir),
      reason: outcome?.reason
    });
  } catch (error) {
    if (session) {
      try {
        const stopped = await context.runtime.stopSession(session.sessionId, "evaluation-failed");
        evidence.push(rel(stopped.artifactDir));
      } catch {}
    }
    return record(definition, "failed", started, { actions, observations, evidence: unique(evidence), reason: error.message || String(error) });
  }
}

async function runForm(ctx) {
  let snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "姓名", "UIWarden", "input");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "邮箱", "uiwarden@example.test", "input");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "计划日期", "2026-08-01", "input");
  snapshot = await ctx.observe();
  await ctx.select(snapshot, "优先级", "high");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "视觉", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "确认本地执行", "input");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "备注", "browser-evaluation", "textarea");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "提交本地表单", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:FORM");
  assertText(snapshot, "uiwarden@example.test");
}

async function runInvalidForm(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "提交本地表单", "button");
  snapshot = await ctx.observe();
  const name = find(snapshot, "姓名", "input");
  if (name.value !== "") throw new Error("invalid form unexpectedly changed input state");
  if (snapshot.text.includes("SUCCESS:FORM")) throw new Error("invalid form unexpectedly submitted");
}

async function runReset(ctx) {
  let snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "姓名", "will-reset", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "重置", "button");
  snapshot = await ctx.observe();
  if (find(snapshot, "姓名", "input").value !== "") throw new Error("form reset did not clear name");
  assertText(snapshot, "等待提交");
}

async function inTable(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "动态表格", "button");
  return ctx.observe();
}

async function runTableFilter(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.setValue(snapshot, "筛选任务", "Alpha", "input");
  snapshot = await ctx.observe();
  assertText(snapshot, "Alpha 审查");
  if (snapshot.text.includes("Bravo 回归")) throw new Error("filter retained non-matching task");
}

async function runStatusFilter(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.select(snapshot, "状态筛选", "已完成");
  snapshot = await ctx.observe();
  assertText(snapshot, "Bravo 回归");
  if (snapshot.text.includes("Alpha 审查")) throw new Error("status filter retained pending task");
}

async function runSort(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.click(snapshot, "任务名称", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SORT:DESC");
}

async function runPagination(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.click(snapshot, "下一页", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "2 / 2");
  assertText(snapshot, "Foxtrot 复核");
}

async function runTableEdit(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.click(snapshot, "选择 Alpha 审查", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "编辑选中项", "button");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "编辑任务名称", "Alpha 更新", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "保存选中项", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:TABLE-SAVE:Alpha 更新");
}

async function runAsync(ctx) {
  let snapshot = await inTable(ctx);
  await ctx.click(snapshot, "异步刷新", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "LOADING");
  await sleep(750);
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:ASYNC");
}

async function inComponents(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "复合组件", "button");
  return ctx.observe();
}

async function runInnerTabs(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.click(snapshot, "证据", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "证据内容：截图、Trace、Rep。");
  await ctx.click(snapshot, "概览", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "概览内容：结构化操作。");
}

async function runHtmlDialog(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.click(snapshot, "打开确认弹窗", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "本地确认弹窗");
  await ctx.click(snapshot, "确认", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:MODAL-CONFIRMED");
}

async function runShadow(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.click(snapshot, "执行 Shadow 动作", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:SHADOW");
}

async function runFrame(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.setValue(snapshot, "iframe 输入", "inside-frame", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "提交 iframe", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:IFRAME:inside-frame");
}

async function runDetails(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.click(snapshot, "展开一级详情", "summary");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "展开二级详情", "summary");
  snapshot = await ctx.observe();
  assertText(snapshot, "一级详情已展开。");
  assertText(snapshot, "二级详情已展开。");
}

async function runJavaScriptDialog(ctx) {
  let snapshot = await inComponents(ctx);
  const dialog = await ctx.probeDialog(snapshot, "打开 JS Confirm");
  if (dialog?.type !== "confirm") throw new Error("confirm dialog was not captured");
  if (!String(dialog.message || "").includes("确认执行本地 benchmark")) {
    throw new Error("confirm dialog message was not captured");
  }
  snapshot = await ctx.observe();
  await ctx.clickDialog(snapshot, "打开 JS Confirm", "accept");
  snapshot = await ctx.observe();
  assertText(snapshot, "CONFIRM:ACCEPTED");
}

async function runShortcut(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.click(snapshot, "快捷键输入区", "input");
  await ctx.key(process.platform === "darwin" ? "Meta+A" : "Control+A");
  snapshot = await ctx.observe();
  assertText(snapshot, "SHORTCUT:SELECT-ALL");
}

async function runDragAndDrop(ctx) {
  let snapshot = await inComponents(ctx);
  await ctx.drag(snapshot, "拖动 BENCH-ITEM", "拖放目标");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:DRAG:BENCH-ITEM");
}

async function runConsoleDiagnostics(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "诊断与文件", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "生成控制台日志", "button");
  await sleep(100);
  const records = await ctx.readStream("console");
  for (const expected of ["BENCH-DEBUG", "BENCH-INFO", "BENCH-WARN", "BENCH-ERROR"]) {
    if (!records.some((record) => String(record.text || "").includes(expected))) {
      throw new Error(`console stream missing ${expected}`);
    }
  }
}

async function runNewTabAndDownload(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "诊断与文件", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "打开结果标签页", "button");
  await sleep(300);
  const tabs = await ctx.tabs();
  if (tabs.tabs.length < 2) throw new Error("runtime did not discover the descendant target");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "下载测试文件", "a");
  const downloads = await ctx.readStream("downloads");
  if (!downloads.some((record) => record.state === "requested" && record.suggestedFilename === "codex-ui-benchmark.txt")) {
    throw new Error("download stream did not record the semantic download request");
  }
}

async function runUploadScrollHistory(ctx) {
  let snapshot = await ctx.observe();
  await ctx.click(snapshot, "动态表格", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "复合组件", "button");
  await ctx.back();
  snapshot = await ctx.observe();
  assertText(snapshot, "ROUTE:table");
  await ctx.forward();
  snapshot = await ctx.observe();
  assertText(snapshot, "ROUTE:components");
  await ctx.click(snapshot, "诊断与文件", "button");
  snapshot = await ctx.observe();
  await ctx.expectUploadRejected(snapshot, "上传本地测试文件", fixturePath, "UPLOAD_PATH_NOT_ALLOWED");
  const symlink = await ctx.createUploadSymlink("outside-link.txt", fixturePath);
  await ctx.expectUploadRejected(snapshot, "上传本地测试文件", symlink, "UPLOAD_PATH_NOT_ALLOWED");
  await ctx.upload(snapshot, "上传本地测试文件", "benchmark-upload.txt", "UIWARDEN-UPLOAD");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:UPLOAD:benchmark-upload.txt:15");
  await ctx.scroll();
  snapshot = await ctx.observe();
  assertText(snapshot, "BENCH-B04-SCROLL-TARGET");
}

async function runSingleSessionLongFlow(ctx) {
  let snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "姓名", "UIWarden Long Flow", "input");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "邮箱", "long-flow@uiwarden.test", "input");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "计划日期", "2026-08-01", "input");
  snapshot = await ctx.observe();
  await ctx.select(snapshot, "优先级", "high");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "视觉", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "确认本地执行", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "提交本地表单", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:FORM");

  await ctx.click(snapshot, "动态表格", "button");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "筛选任务", "Alpha", "input");
  snapshot = await ctx.observe();
  assertText(snapshot, "Alpha 审查");
  await ctx.click(snapshot, "选择 Alpha 审查", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "编辑选中项", "button");
  snapshot = await ctx.observe();
  await ctx.setValue(snapshot, "编辑任务名称", "Alpha Long Flow", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "保存选中项", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:TABLE-SAVE:Alpha Long Flow");
  await ctx.setValue(snapshot, "筛选任务", "", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "下一页", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "2 / 2");

  await ctx.click(snapshot, "复合组件", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "证据", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "证据内容：截图、Trace、Rep。");
  await ctx.click(snapshot, "打开确认弹窗", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "确认", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:MODAL-CONFIRMED");
  await ctx.click(snapshot, "执行 Shadow 动作", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:SHADOW");
  await ctx.setValue(snapshot, "iframe 输入", "single-session-flow", "input");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "提交 iframe", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:IFRAME:single-session-flow");

  await ctx.click(snapshot, "诊断与文件", "button");
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "生成控制台日志", "button");
  snapshot = await ctx.observe();
  assertText(snapshot, "SUCCESS:CONSOLE:4");
  await ctx.click(snapshot, "打开结果标签页", "button");
  await sleep(300);
  const tabs = await ctx.tabs();
  const originalTab = tabs.tabs.find((tab) => tab.active);
  const childTab = tabs.tabs.find((tab) => !tab.active);
  if (originalTab && childTab) {
    await ctx.activate(childTab.targetId);
    const childSnapshot = await ctx.observe();
    assertText(childSnapshot, "FRAME:READY");
    await ctx.activate(originalTab.targetId);
  }
  snapshot = await ctx.observe();
  await ctx.click(snapshot, "下载测试文件", "a");
  await ctx.scroll();
  snapshot = await ctx.observe();
  assertText(snapshot, "BENCH-B04-SCROLL-TARGET");
  if (tabs.tabs.length < 2) {
    return {
      status: "partial",
      reason: "表单、表格、复合组件、iframe、下载触发和深滚动完成；运行中新标签页未纳入会话 target 列表，无法激活并验证后返回原标签页"
    };
  }
}

function find(snapshot, name, tag) {
  const exact = snapshot.elements.find((item) => (!tag || item.tag === tag) && String(item.name || "") === name);
  const partial = snapshot.elements.find((item) => (!tag || item.tag === tag) && String(item.name || "").includes(name));
  const item = exact || partial;
  if (!item) throw new Error(`element not found: ${name}${tag ? ` (${tag})` : ""}`);
  return item;
}

function assertText(snapshot, expected) {
  const semanticText = [
    snapshot.text,
    ...snapshot.elements.map((item) => `${item.name || ""}\n${item.value || ""}`)
  ].join("\n");
  if (!semanticText.includes(expected)) throw new Error(`missing expected text: ${expected}`);
}

function routeFor(label) {
  return { "动态表格": "table", "复合组件": "components", "诊断与文件": "diagnostics" }[label];
}

function record(definition, status, started, additional = {}) {
  return { id: definition.id, category: definition.category, status, durationMs: round(performance.now() - started), runtimeMode: "persistent", actions: 0, observations: 0, recoveries: 0, evidence: [], ...additional };
}

function summarize(rows) {
  return ["passed", "failed", "partial", "blocked", "skipped"].reduce((out, status) => {
    out[status] = rows.filter((row) => row.status === status).length;
    return out;
  }, { total: rows.length });
}

async function waitForTarget(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const targets = JSON.parse(await getText(`http://127.0.0.1:${cdpPort}/json/list`));
      const target = targets.find((item) => item.type === "page" && item.url === url);
      if (target) return { id: target.id };
    } catch {}
    await sleep(80);
  }
  throw new Error(`CDP target not found: ${url}`);
}

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let value = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { value += chunk; });
      response.on("end", () => resolve(value));
    }).on("error", reject);
  });
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function rel(value) { return value ? path.relative(repoRoot, value) : undefined; }
function round(value) { return Math.round(value * 10) / 10; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function pathToFileUrl(filePath) { return `file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`; }

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  app.exit(1);
});
