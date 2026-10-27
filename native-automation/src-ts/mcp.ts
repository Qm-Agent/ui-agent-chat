import {
  callMcpToolSocket,
  GuiAutomationError,
  parseCliArguments,
  runMcpJsonLines,
  runMcpSocket,
  takeGlobalOption,
  type ParsedCliArguments
} from "../shared-runtime/index.js";
import { RUNTIME_VERSION, type NativeAction } from "./types.js";
import { ComputerRuntime } from "./runtime.js";
import { buildAction, validateAction } from "./actions.js";
import { filterApps, filterObservation } from "./query.js";

const COMPATIBILITY_BOOLEAN_FLAGS = new Set(["json", "full", "diff", "observe", "focused", "allow-coordinate-fallback"]);
const ACTION_TOOLS: Record<string, string> = {
  click: "native_click",
  "visual-click": "native_visual_click",
  "set-value": "native_set_value",
  "type-text": "native_type_text",
  key: "native_key",
  scroll: "native_scroll"
};

export async function runComputerMcp(runtime: ComputerRuntime, endpoint?: string): Promise<void> {
  const configuredParentPid = Number(process.env.DT_GUI_COMPUTER_PARENT_PID);
  const options = {
    serverName: "dt-gui-computer",
    serverVersion: RUNTIME_VERSION,
    tools: computerMcpTools(),
    parentPid: Number.isInteger(configuredParentPid) && configuredParentPid > 0
      ? configuredParentPid
      : undefined,
    callTool: (name: string, args: Record<string, unknown>) => callComputerTool(runtime, name, args),
    compatibilityCall: async (rawArgs: string[]) => {
      const args = [...rawArgs];
      takeGlobalOption(args, "runtime-home");
      const call = computerMcpCall(parseCliArguments(args, COMPATIBILITY_BOOLEAN_FLAGS));
      return callComputerTool(runtime, call.name, call.args);
    }
  };
  if (endpoint) {
    await runMcpSocket(options, endpoint);
    return;
  }
  await runMcpJsonLines(options);
}

export async function callComputerTool(runtime: ComputerRuntime, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "native_doctor") return runtime.doctor();
  if (name === "native_capabilities") return runtime.capabilities();
  if (name === "native_apps_list") {
    return filterApps(
      await runtime.listApps(required(args, "provider")),
      stringValue(args.query),
      numberValue(args.limit) ?? 40
    );
  }
  if (name === "native_session_start") return runtime.startSession({
    providerId: required(args, "provider"),
    app: { kind: stringValue(args.appKind) || "name", value: required(args, "app") } as never,
    controlMode: stringValue(args.mode) || "agent-control",
    deliveryMode: stringValue(args.deliveryMode) || "foreground-compatible",
    approvalPolicy: stringValue(args.approvalPolicy) || "sensitive-actions",
    artifactRoot: stringValue(args.artifactRoot)
  });
  if (name === "native_session_status") return runtime.sessionStatus(required(args, "sessionId"));
  if (name === "native_session_target") return runtime.setTarget(required(args, "sessionId"), {
    kind: (stringValue(args.appKind) || "name") as never, value: required(args, "app")
  });
  if (name === "native_session_launch") return runtime.launchTarget(required(args, "sessionId"), {
    kind: (stringValue(args.appKind) || "name") as never, value: required(args, "app")
  });
  if (name === "native_session_control") return runtime.setControlMode(required(args, "sessionId"), required(args, "mode"));
  if (name === "native_observe") {
    const query = stringValue(args.query);
    const snapshot = await runtime.observe(
      required(args, "sessionId"),
      args.full === true,
      args.diff === true
    );
    return filterObservation(
      snapshot as unknown as Record<string, unknown>,
      query,
      numberValue(args.limit) ?? 60,
      args.diff === true
    );
  }
  if (name === "native_approval_grant") return runtime.grantApproval(required(args, "sessionId"), required(args, "challengeId"));
  if (name === "native_approval_reject") return runtime.rejectApproval(required(args, "sessionId"), required(args, "challengeId"), stringValue(args.reason) || "user-rejected");
  if (name === "native_session_stop") return runtime.stopSession(required(args, "sessionId"), stringValue(args.reason) || "completed");
  const actionTool = name === "native_action_and_observe"
    ? ACTION_TOOLS[required(args, "actionKind")]
    : name;
  if (!actionTool) throw new GuiAutomationError("INVALID_ARGUMENT", `未知动作：${String(args.actionKind || "")}`);
  const action = mcpAction(actionTool, args);
  validateAction(action);
  const actionResult = await runtime.performAction(
    required(args, "sessionId"),
    required(args, "snapshotId"),
    action,
    stringValue(args.approvalId),
    stringValue(args.actor) || "agent"
  );
  if (name !== "native_action_and_observe") return actionResult;
  const query = stringValue(args.query);
  const snapshot = await runtime.observe(
    required(args, "sessionId"),
    args.full === true,
    args.diff === true
  );
  return {
    action: actionResult,
    snapshot: filterObservation(
      snapshot as unknown as Record<string, unknown>,
      query,
      numberValue(args.limit) ?? 60,
      args.diff === true
    )
  };
}

export function computerMcpTools(): unknown[] {
  return [
    tool("native_doctor", "探测 Runtime、平台 Provider 和权限"),
    tool("native_capabilities", "读取协议版本、Provider、动作和安全能力"),
    tool("native_apps_list", "列出 Provider 可见应用", [["provider", "string"]], [["query", "string"], ["limit", "integer"]]),
    tool("native_session_start", "创建桌面自动化会话", [["provider", "string"], ["app", "string"]], [["appKind", "string"], ["mode", "string"], ["deliveryMode", "string"], ["approvalPolicy", "string"], ["artifactRoot", "string"]]),
    tool("native_session_status", "读取桌面自动化会话状态", [["sessionId", "string"]]),
    tool("native_session_target", "将受控会话切换到 Agent 选定的应用", [["sessionId", "string"], ["app", "string"]], [["appKind", "string"]]),
    tool("native_session_launch", "启动一个应用并将受控会话绑定到该应用", [["sessionId", "string"], ["app", "string"]], [["appKind", "string"]]),
    tool("native_session_control", "在 Agent 与用户之间切换桌面控制权", [["sessionId", "string"], ["mode", "string"]]),
    tool("native_observe", "读取最新可访问性树和元素；复杂应用可按文本查询或返回差量", [["sessionId", "string"]], [["full", "boolean"], ["diff", "boolean"], ["query", "string"], ["limit", "integer"]]),
    tool("native_action_and_observe", "执行一个快照约束动作并返回动作后的最新观察", [["actionKind", "string"], ["sessionId", "string"], ["snapshotId", "string"]], [
      ["elementId", "string"], ["value", "string"], ["key", "string"], ["direction", "string"],
      ["pages", "integer"], ["x", "number"], ["y", "number"], ["allowCoordinateFallback", "boolean"],
      ["focused", "boolean"], ["text", "string"], ["match", "string"], ["occurrence", "integer"],
      ["approvalId", "string"], ["actor", "string"], ["full", "boolean"], ["diff", "boolean"], ["query", "string"], ["limit", "integer"]
    ]),
    tool("native_click", "点击语义元素", [["sessionId", "string"], ["snapshotId", "string"]], [["elementId", "string"], ["x", "number"], ["y", "number"], ["allowCoordinateFallback", "boolean"], ["approvalId", "string"], ["actor", "string"]]),
    tool("native_visual_click", "在最新目标窗口截图中 OCR 定位文字并点击，返回后置截图供下一次观察验证", [["sessionId", "string"], ["snapshotId", "string"], ["text", "string"]], [["match", "string"], ["occurrence", "integer"], ["actor", "string"]]),
    tool("native_set_value", "设置普通输入元素的值", [["sessionId", "string"], ["snapshotId", "string"], ["elementId", "string"], ["value", "string"]], [["actor", "string"]]),
    tool("native_type_text", "在普通输入元素末尾追加文本", [["sessionId", "string"], ["snapshotId", "string"], ["value", "string"]], [["elementId", "string"], ["focused", "boolean"], ["actor", "string"]]),
    tool("native_key", "向目标应用发送受限键盘动作", [["sessionId", "string"], ["snapshotId", "string"], ["key", "string"]], [["approvalId", "string"], ["actor", "string"]]),
    tool("native_scroll", "滚动目标应用", [["sessionId", "string"], ["snapshotId", "string"], ["direction", "string"]], [["pages", "integer"], ["actor", "string"]]),
    tool("native_approval_grant", "批准一个动作挑战", [["sessionId", "string"], ["challengeId", "string"]]),
    tool("native_approval_reject", "拒绝一个动作挑战", [["sessionId", "string"], ["challengeId", "string"]], [["reason", "string"]]),
    tool("native_session_stop", "停止会话并封装 Native Rep", [["sessionId", "string"]], [["reason", "string"]])
  ];
}

function mcpAction(name: string, args: Record<string, unknown>): NativeAction {
  const kinds: Record<string, string> = {
    native_click: "click",
    native_visual_click: "visual-click",
    native_set_value: "set-value",
    native_type_text: "type-text",
    native_key: "key",
    native_scroll: "scroll"
  };
  const kind = kinds[name];
  if (!kind) throw new GuiAutomationError("INVALID_ARGUMENT", `未知 MCP tool：${name}`);
  return {
    kind,
    elementId: stringValue(args.elementId),
    value: stringValue(args.value),
    key: stringValue(args.key),
    direction: stringValue(args.direction),
    pages: numberValue(args.pages),
    x: numberValue(args.x),
    y: numberValue(args.y),
    allowCoordinateFallback: args.allowCoordinateFallback === true,
    focused: args.focused === true,
    visualText: stringValue(args.text),
    matchMode: stringValue(args.match),
    occurrence: numberValue(args.occurrence)
  };
}

/** 将兼容 CLI 命令映射到同一组 MCP 原子工具。 */
export async function dispatchComputerMcp(
  endpoint: string,
  parsed: ParsedCliArguments
): Promise<unknown> {
  const call = computerMcpCall(parsed);
  return callMcpToolSocket(endpoint, call.name, call.args);
}

export function computerMcpCall(parsed: ParsedCliArguments): {
  name: string;
  args: Record<string, unknown>;
} {
  const [group, action] = parsed.command;
  const options = parsed.options;
  if (group === "doctor" && !action) return { name: "native_doctor", args: {} };
  if (group === "capabilities" && !action) return { name: "native_capabilities", args: {} };
  if (group === "apps" && action === "list") {
    return {
      name: "native_apps_list",
      args: compact({
        provider: optional(options, "provider") || defaultProvider(),
        query: optional(options, "query"),
        limit: integer(options, "limit")
      })
    };
  }
  if (group === "session" && action === "start") {
    return {
      name: "native_session_start",
      args: compact({
        provider: optional(options, "provider") || defaultProvider(),
        app: requiredOptionValue(options, "app"),
        appKind: optional(options, "app-kind") || "name",
        mode: optional(options, "mode") || "agent-control",
        deliveryMode: optional(options, "delivery-mode") || "foreground-compatible",
        approvalPolicy: optional(options, "approval-policy") || "sensitive-actions",
        artifactRoot: optional(options, "artifact-root")
      })
    };
  }
  const sessionId = () => requiredOptionValue(options, "session");
  if (group === "session" && action === "status") return { name: "native_session_status", args: { sessionId: sessionId() } };
  if (group === "session" && (action === "target" || action === "launch")) {
    return {
      name: action === "target" ? "native_session_target" : "native_session_launch",
      args: {
        sessionId: sessionId(),
        app: requiredOptionValue(options, "app"),
        appKind: optional(options, "app-kind") || "name"
      }
    };
  }
  if (group === "session" && action === "control") {
    return { name: "native_session_control", args: { sessionId: sessionId(), mode: requiredOptionValue(options, "mode") } };
  }
  if (group === "session" && action === "stop") {
    return {
      name: "native_session_stop",
      args: { sessionId: sessionId(), reason: optional(options, "reason") || "completed" }
    };
  }
  if (group === "observe" && !action) {
    return {
      name: "native_observe",
      args: compact({
        sessionId: sessionId(),
        full: options.full === true,
        diff: options.diff === true ? true : undefined,
        query: optional(options, "query"),
        limit: integer(options, "limit")
      })
    };
  }
  if (ACTION_TOOLS[group] && !action) {
    const nativeAction = buildAction(group, options);
    validateAction(nativeAction);
    return {
      name: options.observe === true ? "native_action_and_observe" : ACTION_TOOLS[group],
      args: compact({
        actionKind: options.observe === true ? group : undefined,
        sessionId: sessionId(),
        snapshotId: requiredOptionValue(options, "snapshot"),
        elementId: nativeAction.elementId,
        value: nativeAction.value,
        key: nativeAction.key,
        direction: nativeAction.direction,
        pages: nativeAction.pages,
        x: nativeAction.x,
        y: nativeAction.y,
        allowCoordinateFallback: nativeAction.allowCoordinateFallback,
        focused: nativeAction.focused,
        text: nativeAction.visualText,
        match: nativeAction.matchMode,
        occurrence: nativeAction.occurrence,
        approvalId: optional(options, "approval"),
        actor: optional(options, "actor") || "agent",
        full: options.observe === true ? options.full === true : undefined,
        diff: options.observe === true && options.diff === true ? true : undefined,
        query: options.observe === true ? optional(options, "query") : undefined,
        limit: options.observe === true ? integer(options, "limit") : undefined
      })
    };
  }
  if (group === "approval" && action === "grant") {
    return {
      name: "native_approval_grant",
      args: { sessionId: sessionId(), challengeId: requiredOptionValue(options, "challenge") }
    };
  }
  if (group === "approval" && action === "reject") {
    return {
      name: "native_approval_reject",
      args: {
        sessionId: sessionId(),
        challengeId: requiredOptionValue(options, "challenge"),
        reason: optional(options, "reason") || "user-rejected"
      }
    };
  }
  throw new GuiAutomationError("INVALID_ARGUMENT", `MCP 模式不支持命令：${parsed.command.join(" ")}`);
}

function tool(name: string, description: string, required: Array<[string, string]> = [], optional: Array<[string, string]> = []): unknown {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries([...required, ...optional].map(([key, type]) => [key, { type }])),
      required: required.map(([key]) => key),
      additionalProperties: false
    }
  };
}

function required(args: Record<string, unknown>, key: string): string {
  const value = stringValue(args[key]);
  if (!value) throw new GuiAutomationError("INVALID_ARGUMENT", `MCP 参数缺少 ${key}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optional(options: ParsedCliArguments["options"], key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(options: ParsedCliArguments["options"], key: string): number | undefined {
  const value = Number(options[key]);
  return Number.isInteger(value) ? value : undefined;
}

function requiredOptionValue(options: ParsedCliArguments["options"], key: string): string {
  const value = optional(options, key);
  if (!value) throw new GuiAutomationError("INVALID_ARGUMENT", `缺少 --${key}`);
  return value;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function defaultProvider(): string {
  return process.platform === "darwin" ? "macos-accessibility" : process.platform === "win32" ? "windows-ui-automation" : "mock";
}
