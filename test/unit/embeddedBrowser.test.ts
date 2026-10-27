import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diagnoseLatestBrowserRep,
  finalizeEmbeddedBrowserRun,
  normalizeEmbeddedBrowserCdpUrl,
  startEmbeddedBrowserRun
} from "../../server/src/embeddedBrowser.js";
import { normalizeBrowserKernel } from "../../server/src/storage.js";
import type { AgentSession } from "../../server/src/types.js";
import {
  browserAutomationCommandViolation,
  browserAutomationSkillViolation,
  extractFirstUrl,
  formatAgentResultError,
  managedBrowserCommandViolation,
  NATIVE_MODEL_IMAGE_READ_LIMIT,
  nativeAutomationCommandViolation,
  nativeAutomationReadViolation,
  nativeAutomationSkillViolation,
  resolveAgentBrowserMode,
  resolveAgentMaxTurns,
  requiresManualLogin,
  updateNativeExecutionStallState
} from "../../server/src/agent.js";
import {
  resolveConfiguredCdpBrowserPath,
  resolveConfiguredSessionKernel,
  validateConfiguredBrowserProfile
} from "../../server/src/browserProfiles.js";
import { parseRemoteDebuggingPorts } from "../../server/src/cdpManager.js";
import { applyBrowserProfileMode, prepareWorkspace } from "../../server/src/workspace.js";
import {
  browserAutomationAgentBinPath,
  browserAutomationCompletionError,
  ensureBrowserAutomationAgentLauncher,
  browserAutomationHomePath,
  type BrowserAutomationSession
} from "../../server/src/browserAutomation.js";
import {
  nativeAutomationCompletionError,
  nativeAutomationHomePath,
  type NativeAutomationSession
} from "../../server/src/nativeAutomation.js";

test("旧 kind=cdp 映射为 external-cdp", () => {
  assert.equal(normalizeBrowserKernel(null, "cdp"), "external-cdp");
  assert.equal(normalizeBrowserKernel(null, null), "playwright");
  assert.equal(normalizeBrowserKernel("uiwarden-embedded", null), "uiwarden-embedded");
  assert.equal(normalizeBrowserKernel("gui-computer", null), "gui-computer");
});

test("电脑桌面执行不受会话占位浏览器内核影响", () => {
  for (const browserKernel of ["playwright", "uiwarden-embedded", "external-cdp", "gui-computer"] as const) {
    assert.equal(
      resolveAgentBrowserMode("operation", browserKernel, true),
      "none",
      `native execution must not start browser kernel ${browserKernel}`
    );
  }
  assert.equal(resolveAgentBrowserMode("operation", "playwright", false), "managed");
  assert.equal(resolveAgentBrowserMode("operation", "external-cdp", false), "external");
  assert.equal(resolveAgentBrowserMode("test", "playwright", false), "none");
});

test("浏览器原子命令守卫限制测试链路与会话管理命令", () => {
  const sessionId = "browser-11111111-2222-3333-4444-555555555555";
  assert.match(browserAutomationCommandViolation("python3 run_quick_mode.py", sessionId) || "", /禁止启动测试/);
  assert.match(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN session stop --session $DT_GUI_BROWSER_SESSION_ID", sessionId) || "",
    /生命周期/
  );
  assert.match(browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN observe --session browser-other", sessionId) || "", /必须显式绑定/);
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN observe --session $DT_GUI_BROWSER_SESSION_ID --json", sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN tabs activate --session $DT_GUI_BROWSER_SESSION_ID --target chrome-tab-17 --json", sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN downloads list --session $DT_GUI_BROWSER_SESSION_ID --json", sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN click --session $DT_GUI_BROWSER_SESSION_ID --snapshot snapshot-1 --element web-1 --json", sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation('$DT_GUI_BROWSER_BIN navigate --session $DT_GUI_BROWSER_SESSION_ID --url "https://example.com/?a=1&b=2" --json', sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation('$DT_GUI_BROWSER_BIN set-value --session $DT_GUI_BROWSER_SESSION_ID --snapshot snapshot-1 --element web-1 --value "A; B" --json', sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation('$DT_GUI_BROWSER_BIN key --session $DT_GUI_BROWSER_SESSION_ID --key "Meta+A" --json', sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN drag --session $DT_GUI_BROWSER_SESSION_ID --snapshot snapshot-1 --source web-1 --target web-2 --json", sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation('$DT_GUI_BROWSER_BIN upload-file --session $DT_GUI_BROWSER_SESSION_ID --snapshot snapshot-1 --element web-1 --file "/tmp/example.txt" --json', sessionId),
    undefined
  );
  assert.equal(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN click --session $DT_GUI_BROWSER_SESSION_ID --snapshot snapshot-1 --element web-1 --dialog-action accept --json", sessionId),
    undefined
  );
  assert.match(
    browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN observe --session $DT_GUI_BROWSER_SESSION_ID --json | tee output", sessionId) || "",
    /单个 dt-gui-browser 原子命令/
  );
  assert.match(browserAutomationCommandViolation("$DT_GUI_BROWSER_BIN doctor --json", sessionId) || "", /只能调用观察/);
  assert.equal(browserAutomationSkillViolation("dt-gui-browser-skill"), undefined);
  assert.match(browserAutomationSkillViolation("") || "", /必须明确加载/);
  assert.match(browserAutomationSkillViolation("ui-test-assistant-skill") || "", /只能加载/);
});

test("浏览器原子命令守卫接受 DTCoder daemon 的显式 Runtime 绑定", () => {
  const sessionId = "browser-session-1";
  const binary = "/Applications/UIWarden.app/Contents/Resources/browser-automation/bin/dt-gui-browser";
  const runtimeHome = "/Users/test/Library/Application Support/UIWarden/data/browser-automation";
  const node = "/Applications/UIWarden.app/Contents/Resources/runtime/node";
  assert.equal(browserAutomationCommandViolation(
    `'${binary}' --node '${node}' --runtime-home '${runtimeHome}' observe --session '${sessionId}' --json`,
    sessionId,
    binary,
    runtimeHome,
    node
  ), undefined);
  assert.match(browserAutomationCommandViolation(
    `'${binary}' --node '${node}' --runtime-home '/tmp/other' observe --session '${sessionId}' --json`,
    sessionId,
    binary,
    runtimeHome,
    node
  ) || "", /Runtime home/);
});

test("浏览器原子命令守卫接受 DTCoder 会话短入口并拒绝重复绑定", () => {
  const sessionId = "browser-11111111-2222-3333-4444-555555555555";
  const launcher = "/Users/test/.uiwarden/browser/browser-11111111-2222-3333-4444-555555555555";
  assert.equal(browserAutomationCommandViolation(
    `'${launcher}' observe --json`,
    sessionId,
    launcher,
    "/tmp/browser-home",
    "/tmp/node",
    true
  ), undefined);
  assert.match(browserAutomationCommandViolation(
    `'${launcher}' observe --session '${sessionId}' --json`,
    sessionId,
    launcher,
    "/tmp/browser-home",
    "/tmp/node",
    true
  ) || "", /禁止重复传入/);
  assert.match(browserAutomationCommandViolation(
    "'/tmp/other' observe --json",
    sessionId,
    launcher,
    "/tmp/browser-home",
    "/tmp/node",
    true
  ) || "", /只能调用/);
});

test("DTCoder 浏览器短入口写入会话绑定且不暴露长参数", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-browser-agent-bin-"));
  const runtimeHome = path.join(root, "runtime home");
  const cli = path.join(root, "cli.mjs");
  const sessionId = "browser-11111111-2222-3333-4444-555555555555";
  const env = {
    ...process.env,
    DT_GUI_BROWSER_AGENT_BIN_DIR: path.join(root, "bin"),
    DT_GUI_BROWSER_HOME: runtimeHome,
    DT_GUI_BROWSER_CLI: cli
  };
  try {
    const launcher = await ensureBrowserAutomationAgentLauncher(sessionId, env);
    assert.equal(launcher, browserAutomationAgentBinPath(sessionId, env));
    const content = await fs.readFile(launcher, "utf8");
    assert.match(content, /DT_GUI_BROWSER_HOME=/);
    assert.match(content, new RegExp(sessionId));
    assert.match(content, /"\$@" --session/);
    assert.doesNotMatch(launcher, /--node|--runtime-home|--session/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("浏览器 Runtime home 在 Server 与 Agent 间使用同一绝对路径", () => {
  assert.equal(
    browserAutomationHomePath({ DT_GUI_BROWSER_HOME: "./tmp/browser-runtime" }),
    path.resolve("./tmp/browser-runtime")
  );
  assert.ok(path.isAbsolute(browserAutomationHomePath({})));
});

test("浏览器操作没有页面观察时不能标记完成", () => {
  const runtime = {
    snapshotSequence: 0
  } as BrowserAutomationSession;
  assert.match(browserAutomationCompletionError(runtime) || "", /未产生有效页面观察/);
  runtime.snapshotSequence = 1;
  assert.equal(browserAutomationCompletionError(runtime), undefined);
});

test("可控浏览器会话拒绝 browser-use 回退命令", () => {
  assert.match(managedBrowserCommandViolation("python3 -m browser_use.cli quick --no-cdp x") || "", /禁止 --no-cdp/);
  assert.match(managedBrowserCommandViolation("python3 -m browser_use.cli quick x") || "", /禁止直接调用/);
  assert.match(managedBrowserCommandViolation("npx playwright test") || "", /禁止另起/);
  assert.equal(managedBrowserCommandViolation("python3 scripts/run_quick_mode.py --cdp --headed --query x"), undefined);
});

test("原生应用命令守卫限制浏览器与会话管理命令", () => {
  const sessionId = "cua-11111111-2222-3333-4444-555555555555";
  assert.match(nativeAutomationCommandViolation("python3 run_quick_mode.py", sessionId) || "", /禁止启动/);
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN session stop --session $DT_GUI_COMPUTER_SESSION_ID", sessionId) || "", /生命周期/);
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN observe --session cua-other", sessionId) || "", /必须显式绑定/);
  assert.equal(
    nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN observe --session $DT_GUI_COMPUTER_SESSION_ID --json", sessionId),
    undefined
  );
  assert.match(
    nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN observe --session $DT_GUI_COMPUTER_SESSION_ID --full --json", sessionId) || "",
    /完整 AX Tree/
  );
  assert.equal(
    nativeAutomationCommandViolation('$DT_GUI_COMPUTER_BIN observe --session $DT_GUI_COMPUTER_SESSION_ID --full --query "搜索" --json', sessionId),
    undefined
  );
  assert.equal(
    nativeAutomationCommandViolation(
      '$DT_GUI_COMPUTER_BIN visual-click --session $DT_GUI_COMPUTER_SESSION_ID --snapshot snap-1 --text "搜索" --match exact --json',
      sessionId
    ),
    undefined
  );
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN session target --app 123", sessionId) || "", /必须显式绑定/);
  assert.equal(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN session target --session $DT_GUI_COMPUTER_SESSION_ID --app 123", sessionId), undefined);
  assert.match(
    nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN click --session $DT_GUI_COMPUTER_SESSION_ID --snapshot snapshot-1 --x 10 --y 10 --allow-coordinate-fallback --actor user", sessionId) || "",
    /不能伪造人工画中画操作/
  );
  assert.match(nativeAutomationCommandViolation("open -a Calculator", sessionId) || "", /禁止绕过/);
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN session launch --app Calculator", sessionId) || "", /必须显式绑定/);
  assert.equal(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN session launch --session $DT_GUI_COMPUTER_SESSION_ID --app Calculator", sessionId), undefined);
  assert.match(nativeAutomationCommandViolation("pwd", sessionId) || "", /必须原样使用/);
  assert.match(
    nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN apps list --provider mock --json && open -a Calculator", sessionId) || "",
    /单个 dt-gui-computer 原子命令/
  );
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN doctor --json", sessionId) || "", /只能调用应用发现/);
  assert.match(nativeAutomationCommandViolation("$DT_GUI_COMPUTER_BIN get --session $DT_GUI_COMPUTER_SESSION_ID --json", sessionId) || "", /只能调用应用发现/);
  assert.equal(nativeAutomationSkillViolation("dt-gui-computer-skill"), undefined);
  assert.match(nativeAutomationSkillViolation("") || "", /必须明确加载/);
  assert.match(nativeAutomationSkillViolation("ui-test-assistant-skill") || "", /只能加载/);
});

test("原生命令守卫对猜测的 Skill 内二进制给出可恢复指引", () => {
  const sessionId = "cua-11111111-2222-3333-4444-555555555555";
  const trustedBinary = "/Applications/UIWarden.app/Contents/Resources/native-automation/dt-gui-computer";
  const guessedBinary = "/tmp/workspace/.claude/skills/dt-gui-computer-skill/bin/macos/dt-gui-computer";
  const violation = nativeAutomationCommandViolation(
    `"${guessedBinary}" apps list --provider macos-accessibility --json`,
    sessionId,
    trustedBinary
  );
  assert.match(violation || "", /不要展开、猜测或覆盖路径/);
  assert.match(violation || "", /\$DT_GUI_COMPUTER_BIN/);
  assert.equal(
    nativeAutomationCommandViolation(
      '"$DT_GUI_COMPUTER_BIN" apps list --provider "$DT_GUI_COMPUTER_PROVIDER_ID" --json',
      sessionId,
      trustedBinary
    ),
    undefined
  );
});

test("原生命令守卫接受 DTCoder daemon 的显式 Runtime 绑定", () => {
  const sessionId = "cua-11111111-2222-3333-4444-555555555555";
  const trustedBinary = "/Applications/UIWarden.app/Contents/Resources/native-automation/dt-gui-computer";
  const runtimeHome = "/Users/test/Library/Application Support/UIWarden/data/native-automation";
  assert.equal(
    nativeAutomationCommandViolation(
      `'${trustedBinary}' --runtime-home '${runtimeHome}' observe --session '${sessionId}' --full --query '搜索' --json`,
      sessionId,
      trustedBinary,
      runtimeHome
    ),
    undefined
  );
  assert.match(
    nativeAutomationCommandViolation(
      `'${trustedBinary}' --runtime-home '/tmp/other' observe --session '${sessionId}' --full --query '搜索' --json`,
      sessionId,
      trustedBinary,
      runtimeHome
    ) || "",
    /无效.*Runtime home/
  );
});

test("原生 Read 守卫只允许当前 Native Rep 截图", () => {
  const artifactDir = "/tmp/native-rep/cua-1";
  assert.equal(
    nativeAutomationReadViolation("/tmp/native-rep/cua-1/screenshots/frame_0001.png", artifactDir),
    undefined
  );
  assert.match(nativeAutomationReadViolation("/tmp/native-rep/cua-1/manifest.json", artifactDir) || "", /只能读取/);
  assert.match(nativeAutomationReadViolation("/tmp/native-rep/cua-2/screenshots/frame.png", artifactDir) || "", /只能读取/);
  assert.match(nativeAutomationReadViolation("/tmp/native-rep/cua-1/screenshots/../manifest.png", artifactDir) || "", /只能读取/);
  assert.equal(
    nativeAutomationReadViolation(
      "/tmp/native-rep/cua-1/screenshots/frame_0012.png",
      artifactDir,
      NATIVE_MODEL_IMAGE_READ_LIMIT - 1
    ),
    undefined
  );
  assert.match(
    nativeAutomationReadViolation(
      "/tmp/native-rep/cua-1/screenshots/frame_0013.png",
      artifactDir,
      NATIVE_MODEL_IMAGE_READ_LIMIT
    ) || "",
    /12 张预算/
  );
});

test("原生命令守卫接受带空格的可信打包路径", () => {
  const sessionId = "cua-11111111-2222-3333-4444-555555555555";
  const binary = "/Applications/UIWarden Runtime/bin/dt-gui-computer";
  assert.equal(
    nativeAutomationCommandViolation(
      `"${binary}" apps list --provider macos-accessibility --json`,
      sessionId,
      binary
    ),
    undefined
  );
  assert.equal(
    nativeAutomationCommandViolation(
      "/Applications/UIWarden\\ Runtime/bin/dt-gui-computer apps list --provider macos-accessibility --json",
      sessionId,
      binary
    ),
    undefined
  );
  assert.match(
    nativeAutomationCommandViolation(
      '"/tmp/dt-gui-computer" apps list --provider mock --json',
      sessionId,
      binary
    ) || "",
    /必须原样使用/
  );
});

test("原生 Runtime home 和完成证据门禁保持一致", () => {
  assert.equal(nativeAutomationHomePath({ DT_GUI_COMPUTER_HOME: "./tmp/native-runtime" }), path.resolve("./tmp/native-runtime"));
  const runtime = { snapshotSequence: 0 } as NativeAutomationSession;
  assert.match(nativeAutomationCompletionError(runtime) || "", /未产生有效桌面观察/);
  runtime.snapshotSequence = 1;
  assert.equal(nativeAutomationCompletionError(runtime), undefined);
  runtime.state = "failed";
  runtime.stopReason = "no-progress";
  assert.match(nativeAutomationCompletionError(runtime) || "", /熔断旧快照重试循环/);
  runtime.state = "active";
  runtime.stopReason = undefined;
  assert.equal(
    nativeAutomationCompletionError(runtime, "消息已经发送。\\n[UIWARDEN_NATIVE_RESULT: completed]"),
    undefined
  );
  assert.match(
    nativeAutomationCompletionError(runtime, "当前阻塞点：输入框无法写入。\\n[UIWARDEN_NATIVE_RESULT: blocked]") || "",
    /仍有阻塞步骤/
  );
  assert.match(
    nativeAutomationCompletionError(runtime, "需要人工协助：请手动发送消息。") || "",
    /未解决阻塞/
  );
});

test("原生与浏览器原子操作拥有独立 turn 预算", () => {
  assert.equal(resolveAgentMaxTurns("test"), 50);
  assert.equal(resolveAgentMaxTurns("browser-atomic"), 80);
  assert.equal(resolveAgentMaxTurns("native"), 100);
});

test("原生执行连续输入与页面状态失败时及时熔断", () => {
  let state = { failures: [] as string[] };
  for (const code of [
    "STALE_SNAPSHOT",
    "FOCUS_CONTEXT_MISSING",
    "SCREENSHOT_UNAVAILABLE"
  ]) {
    const result = updateNativeExecutionStallState(state, [
      `{"ok":false,"error":{"code":"${code}"}}`
    ]);
    state = result.state;
    assert.equal(result.error, undefined);
  }
  const blocked = updateNativeExecutionStallState(state, [
    '{"ok":false,"error":{"code":"UNSUPPORTED_ACTION"}}'
  ]);
  assert.match(blocked.error || "", /连续 4 次/);
  assert.match(blocked.error || "", /避免长时间重复操作/);
});

test("原生执行成功动作后清空暂态失败计数", () => {
  const result = updateNativeExecutionStallState(
    { failures: ["STALE_SNAPSHOT", "FOCUS_CONTEXT_MISSING"] },
    ['{"ok":true,"data":{"action":{"kind":"click","performed":true}}}']
  );
  assert.deepEqual(result.state.failures, []);
  assert.equal(result.error, undefined);
});

test("严格后台干扰或不兼容动作立即终止而不进入重试循环", () => {
  const interference = updateNativeExecutionStallState(
    { failures: [] },
    ['{"ok":false,"error":{"code":"BACKGROUND_INTERFERENCE_DETECTED"}}']
  );
  assert.match(interference.error || "", /已立即停止/);
  assert.match(interference.error || "", /未降级到前台执行/);

  const unsupported = updateNativeExecutionStallState(
    { failures: [] },
    ['{"ok":false,"error":{"code":"BACKGROUND_ACTION_UNSUPPORTED"}}']
  );
  assert.match(unsupported.error || "", /不支持无干扰后台动作/);
  assert.match(unsupported.error || "", /关闭“后台执行”/);
});

test("最小化窗口需要可见页面的动作允许 Agent 改用 AX 语义路径", () => {
  const result = updateNativeExecutionStallState(
    { failures: [] },
    ['{"ok":false,"error":{"code":"BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW"}}']
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.state.failures, ["BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW"]);
});

test("SDK turn 上限转换为可操作的原生任务错误", () => {
  assert.match(formatAgentResultError("Reached maximum number of turns (50)", true), /原生应用操作达到步骤上限/);
  assert.doesNotMatch(formatAgentResultError("Reached maximum number of turns (50)", true), /Claude Code returned/);
});

test("上游图片数量限制转换为可操作错误且说明 Rep 不受影响", () => {
  const message = formatAgentResultError(
    "API Error: 400 invalid params, the num of image is larger than the limit: 20 (2013)",
    true,
    "CFuse"
  );
  assert.match(message, /模型图片上下文.*上游限制/);
  assert.match(message, /完整截图仍保存在 Rep/);
  assert.doesNotMatch(message, /400 invalid params/);
});

test("可控浏览器登录任务缺少密码时进入人工登录", () => {
  assert.equal(extractFirstUrl("打开 www.deepseek.com，完成登录"), "https://www.deepseek.com");
  assert.equal(extractFirstUrl("访问 https://map.baidu.com/@1,2 后定位"), "https://map.baidu.com/@1,2");
  assert.equal(requiresManualLogin("打开 www.deepseek.com，完成登录"), true);
  assert.equal(requiresManualLogin("登录，账号：a，密码：secret"), false);
  assert.equal(requiresManualLogin("检查 DeepSeek 首页"), false);
});

test("CDP 自定义路径拒绝 Firefox 和独立 gui-browser 并接受 Chromium 兼容路径", () => {
  assert.equal(resolveConfiguredCdpBrowserPath({ BU_CUSTOM_BROWSER_PATH: "/Applications/Firefox.app/Contents/MacOS/firefox" }), undefined);
  assert.equal(resolveConfiguredCdpBrowserPath({ BU_CUSTOM_BROWSER_PATH: "/Applications/UIWarden-Browser.app/Contents/MacOS/UIWarden-Browser" }), undefined);
  assert.equal(
    resolveConfiguredCdpBrowserPath({ BU_CUSTOM_BROWSER_PATH: "/Applications/Chromium.app/Contents/MacOS/Chromium" }),
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  );
});

test("CDP 浏览器发现只接受有效 TCP 远程调试端口", () => {
  assert.deepEqual(parseRemoteDebuggingPorts("chrome --remote-debugging-port=9222 --user-data-dir=/tmp/a"), [9222]);
  assert.deepEqual(parseRemoteDebuggingPorts("msedge --remote-debugging-port 9333 --remote-debugging-port=9333"), [9333]);
  assert.deepEqual(parseRemoteDebuggingPorts("chrome --remote-debugging-pipe"), []);
  assert.deepEqual(parseRemoteDebuggingPorts("chrome --remote-debugging-port=0"), []);
});

test("测试任务新会话只使用配套 Chromium 或 Skill Profile", () => {
  assert.equal(resolveConfiguredSessionKernel(undefined), "playwright");
  assert.equal(resolveConfiguredSessionKernel({ BU_BROWSER_TYPE: "chrome" }), "playwright");
  assert.equal(resolveConfiguredSessionKernel({ BU_BROWSER_TYPE: "edge" }), "skill-profile");
  assert.equal(resolveConfiguredSessionKernel({
    BU_BROWSER_TYPE: "firefox",
    BU_FIREFOX_PATH: "/Applications/Firefox.app/Contents/MacOS/firefox"
  }), "skill-profile");
  assert.equal(resolveConfiguredSessionKernel({ BU_BROWSER_TYPE: "firefox" }), "skill-profile");
  assert.equal(resolveConfiguredSessionKernel({
    BU_BROWSER_TYPE: "custom",
    BU_CUSTOM_BROWSER_PATH: "/Applications/Firefox.app/Contents/MacOS/firefox"
  }), "playwright");
  assert.equal(resolveConfiguredSessionKernel({
    BU_BROWSER_TYPE: "custom",
    BU_CUSTOM_BROWSER_PATH: "/Applications/Chromium.app/Contents/MacOS/Chromium"
  }), "skill-profile");
  assert.equal(resolveConfiguredSessionKernel({
    BU_BROWSER_TYPE: "custom",
    BU_CUSTOM_BROWSER_PATH: "/Applications/UIWarden-Browser.app/Contents/MacOS/UIWarden-Browser"
  }), "playwright");
  assert.equal(resolveConfiguredSessionKernel({
    BU_BROWSER_TYPE: "custom",
    BU_CUSTOM_BROWSER_PATH: "/Applications/gui-computer.app/Contents/MacOS/gui-computer"
  }), "playwright");
});

test("Skill Profile 区分 Firefox、Chromium 和 UI 操作专用独立浏览器", () => {
  assert.match(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "custom"],
    ["BU_CUSTOM_BROWSER_PATH", "/Applications/Firefox.app/Contents/MacOS/firefox"]
  ])) || "", /Firefox/);
  assert.match(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "custom"],
    ["BU_CUSTOM_BROWSER_PATH", "/Applications/UIWarden-Browser.app/Contents/MacOS/UIWarden-Browser"]
  ])) || "", /UI 操作/);
  assert.match(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "custom"],
    ["BU_CUSTOM_BROWSER_PATH", "/Applications/gui-computer.app/Contents/MacOS/gui-computer"]
  ])) || "", /UI 操作/);
  assert.equal(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "firefox"]
  ])), undefined);
  assert.equal(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "firefox"],
    ["BU_FIREFOX_PATH", "/Applications/Firefox.app/Contents/MacOS/firefox"]
  ])), undefined);
  assert.equal(validateConfiguredBrowserProfile(new Map([
    ["BU_BROWSER_TYPE", "custom"],
    ["BU_CUSTOM_BROWSER_PATH", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  ])), undefined);
});

test("默认 Playwright workspace 强制使用配套 Chromium", () => {
  const env = new Map([
    ["BU_BROWSER_TYPE", "custom"],
    ["BU_BROWSER_TYPES", "chrome,edge"],
    ["BU_CUSTOM_BROWSER_PATH", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  ]);
  applyBrowserProfileMode(env, "bundled");
  assert.equal(env.get("BU_BROWSER_TYPE"), "chrome");
  assert.equal(env.has("BU_BROWSER_TYPES"), false);
  assert.equal(env.has("BU_CUSTOM_BROWSER_PATH"), false);
});

test("DTCoder 与 Claude Skill 目录获得相同的浏览器模型配置", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-skill-env-"));
  try {
    await prepareWorkspace(workspace, {
      browserProfileMode: "bundled",
      executionRuntimeId: "dtcoder"
    });
    const claudeEnvPath = path.join(
      workspace,
      ".claude",
      "skills",
      "ui-test-assistant-skill",
      "config",
      ".env"
    );
    const agentEnvPath = path.join(
      workspace,
      ".agents",
      "skills",
      "ui-test-assistant-skill",
      "config",
      ".env"
    );
    const [claudeEnv, agentEnv, claudeStat, agentStat] = await Promise.all([
      fs.readFile(claudeEnvPath, "utf8"),
      fs.readFile(agentEnvPath, "utf8"),
      fs.stat(claudeEnvPath),
      fs.stat(agentEnvPath)
    ]);
    assert.equal(agentEnv, claudeEnv);
    assert.match(agentEnv, /^BU_ACTOR_MODEL=qwen3.7-plus$/m);
    assert.match(agentEnv, /^BU_OPENAI_API_BASE=$/m);
    assert.match(agentEnv, /^BU_OPENAI_API_KEY=$/m);
    assert.match(agentEnv, /^BU_MODEL_BOX_FORMAT=ltrb$/m);
    assert.doesNotMatch(agentEnv, /^BU_OPENAI_API_KEY=\S+/m);
    assert.equal(agentStat.mode & 0o777, 0o600);
    assert.equal(claudeStat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("内置浏览器旧版 WebSocket CDP 地址规范化为本机 HTTP 基址", () => {
  assert.equal(
    normalizeEmbeddedBrowserCdpUrl("ws://127.0.0.1:46766/devtools/browser/browser-id"),
    "http://127.0.0.1:46766"
  );
  assert.equal(
    normalizeEmbeddedBrowserCdpUrl("http://localhost:46766"),
    "http://127.0.0.1:46766"
  );
  assert.throws(
    () => normalizeEmbeddedBrowserCdpUrl("ws://192.0.2.8:46766/devtools/browser/browser-id"),
    /必须绑定/
  );
});

test("内置浏览器执行会话生成并封装 Rep", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-embedded-"));
  const runId = "run-test-1";
  const token = "test-token";
  let navigatedUrl = "";
  let runKernel: "uiwarden-embedded" | "gui-computer" = "uiwarden-embedded";
  let runCdpUrl = "http://127.0.0.1:39999";
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/v1/browser/status") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/browser/navigate") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        navigatedUrl = JSON.parse(body).url;
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/browser/runs") {
      res.end(JSON.stringify({
        version: 1,
        kernel: runKernel,
        runId: runKernel === "gui-computer" ? "run-test-gui" : runId,
        sessionId: "session-1",
        cdpUrl: runCdpUrl,
        targetId: "target-1",
        controlMode: "agent-control",
        startedAt: "2026-07-10T00:00:00.000Z"
      }));
      return;
    }
    if (req.method === "POST" && req.url === `/v1/browser/runs/${runId}/control`) {
      res.end(JSON.stringify({
        version: 1,
        kernel: "uiwarden-embedded",
        runId,
        sessionId: "session-1",
        cdpUrl: "http://127.0.0.1:39999",
        targetId: "target-1",
        controlMode: "human-control",
        startedAt: "2026-07-10T00:00:00.000Z"
      }));
      return;
    }
    if (req.method === "DELETE" && req.url?.startsWith("/v1/browser/runs/")) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previousUrl = process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL;
  const previousToken = process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN;
  const previousDiscovery = process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE;
  process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN = token;
  const session: AgentSession = {
    id: "session-1",
    title: "embedded",
    status: "idle",
    browserKernel: "uiwarden-embedded",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    workspacePath,
    messages: [],
    files: [],
    artifacts: []
  };
  try {
    const handle = await startEmbeddedBrowserRun(session, {
      initialUrl: "https://www.deepseek.com",
      initialControlMode: "human-control"
    });
    assert.equal(navigatedUrl, "https://www.deepseek.com");
    assert.equal(handle.execution.controlMode, "human-control");
    const executionConfig = JSON.parse(await fs.readFile(handle.sessionFile, "utf8"));
    assert.equal(executionConfig.controlToken, token);
    assert.equal(path.dirname(handle.sessionFile), path.join(os.tmpdir(), "gui-computer-browser-sessions"));
    await fs.appendFile(path.join(handle.repDir, "streams", "console.jsonl"), '{"type":"error","text":"boom"}\n');
    await finalizeEmbeddedBrowserRun(handle, { stopReason: "completed", testOutcome: "fail" });
    await assert.rejects(fs.access(handle.sessionFile));
    const manifest = JSON.parse(await fs.readFile(path.join(handle.repDir, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, "uiwarden-browser-rep/v1");
    assert.equal(manifest.artifactKind, "browser-rep");
    assert.equal(manifest.browserRunId, runId);
    assert.equal(manifest.evidence.streams.console, 1);
    assert.equal(manifest.metadata.captureStatus, "complete");
    assert.equal(manifest.evidence.har, "network.har");
    const har = JSON.parse(await fs.readFile(path.join(handle.repDir, "network.har"), "utf8"));
    assert.equal(har.log.version, "1.2");
    assert.equal(JSON.stringify(manifest).includes(token), false);
    await fs.writeFile(path.join(handle.repDir, "manifest.json"), JSON.stringify({
      ...manifest,
      schemaVersion: "uiwarden-figo-rep/v1",
      artifactKind: "figo-rep"
    }, null, 2));
    const diagnosis = await diagnoseLatestBrowserRep(session);
    const diagnosisJson = JSON.parse(await fs.readFile(diagnosis.jsonPath, "utf8"));
    assert.equal(diagnosisJson.suspectedLayer, "frontend");

    const discoveryPath = path.join(workspacePath, "gui-computer-discovery.json");
    await fs.writeFile(discoveryPath, JSON.stringify({
      protocolVersion: 1,
      product: "UIWarden-Browser",
      bridgeUrl: `http://127.0.0.1:${address.port}`,
      bridgeToken: token,
      cdpUrl: "http://127.0.0.1:39999"
    }));
    process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE = discoveryPath;
    // UIWarden-Browser 0.3.1 的独立桥仍返回旧内核名，服务端应在边界规范化。
    runKernel = "uiwarden-embedded";
    runCdpUrl = "ws://127.0.0.1:39999/devtools/browser/legacy-browser-id";
    const standaloneSession: AgentSession = {
      ...session,
      id: "session-gui",
      title: "gui-computer",
      browserKernel: "gui-computer"
    };
    const standaloneHandle = await startEmbeddedBrowserRun(standaloneSession);
    assert.equal(standaloneHandle.execution.kernel, "gui-computer");
    assert.equal(standaloneHandle.execution.cdpUrl, "http://127.0.0.1:39999");
    assert.equal(path.dirname(standaloneHandle.sessionFile), path.join(os.tmpdir(), "gui-computer-browser-sessions"));
    await finalizeEmbeddedBrowserRun(standaloneHandle, { stopReason: "standalone-complete" });
  } finally {
    if (previousUrl === undefined) delete process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL;
    else process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN;
    else process.env.UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN = previousToken;
    if (previousDiscovery === undefined) delete process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE;
    else process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE = previousDiscovery;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
