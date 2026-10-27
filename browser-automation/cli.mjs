#!/usr/bin/env node

import {
  callCliCompatibilitySocket,
  parseCliArguments,
  runMcpJsonLines,
  runMcpSocket
} from "./shared-runtime/index.js";
import { asAutomationError, BrowserAutomationError } from "./src/error.mjs";
import {
  activateTab,
  capabilities,
  doctor,
  dragElement,
  getSession,
  goBack,
  goForward,
  listDownloads,
  listTabs,
  navigate,
  observe,
  performElementAction,
  reload,
  RUNTIME_VERSION,
  screenshot,
  scroll,
  sendKey,
  setControlMode,
  setSessionTarget,
  shutdownPersistentRuntime,
  startSession,
  stopSession,
  uploadFile
} from "./src/runtime.mjs";

const BOOLEAN_FLAGS = new Set(["json", "full", "full-page", "allow-target-selection", "diff"]);

try {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArguments(rawArgs);
  const result = parsed.command[0] === "mcp"
    ? await runMcp(parsed.options)
    : process.env.DT_GUI_BROWSER_MCP_ENDPOINT
      ? await callCliCompatibilitySocket(process.env.DT_GUI_BROWSER_MCP_ENDPOINT, rawArgs)
    : await dispatch(parsed.command, parsed.options);
  if (parsed.command[0] !== "mcp") writeSuccess(result, parsed.options.json === true);
} catch (error) {
  const failure = asAutomationError(error);
  writeFailure(failure);
  process.exitCode = failure.exitCode;
}

export async function dispatch(command, options) {
  const [group, action] = command;
  validateOptions(command, options);
  if (group === "doctor" && !action) return doctor();
  if (group === "capabilities" && !action) return capabilities();
  if (group === "session" && action === "start") {
    return startSession({
      cdpUrl: requireOption(options, "cdp-url"),
      targetId: requireOption(options, "target"),
      artifactRoot: requireOption(options, "artifact-root"),
      runId: options["run-id"],
      uiwardenSessionId: options["uiwarden-session"],
      controlMode: options.mode || "agent-control",
      allowTargetSelection: options["allow-target-selection"] === true,
      uploadRoots: options["upload-root"] ? [options["upload-root"]] : []
    });
  }
  if (group === "session" && action === "status") return getSession(requireOption(options, "session"));
  if (group === "session" && action === "target") {
    return setSessionTarget(requireOption(options, "session"), requireOption(options, "target"));
  }
  if (group === "session" && action === "control") {
    return setControlMode(requireOption(options, "session"), requireOption(options, "mode"));
  }
  if (group === "session" && action === "stop") {
    return stopSession(requireOption(options, "session"), String(options.reason || "completed"));
  }
  if (group === "tabs" && action === "list") return listTabs(requireOption(options, "session"));
  if (group === "tabs" && action === "activate") {
    return activateTab(requireOption(options, "session"), requireOption(options, "target"));
  }
  if (group === "downloads" && action === "list") return listDownloads(requireOption(options, "session"));
  if (group === "observe" && !action) {
    return observe(requireOption(options, "session"), {
      maxElements: numberOption(options, "max-elements"),
      maxTextLength: numberOption(options, "max-text-length"),
      fullPage: options.full === true || options["full-page"] === true,
      diff: options.diff === true
    });
  }
  if (group === "navigate" && !action) return navigate(requireOption(options, "session"), requireOption(options, "url"));
  if (group === "back" && !action) return goBack(requireOption(options, "session"));
  if (group === "forward" && !action) return goForward(requireOption(options, "session"));
  if (group === "reload" && !action) return reload(requireOption(options, "session"));
  if (["click", "set-value", "type-text", "select-option", "hover"].includes(group) && !action) {
    if (options["dialog-action"] && !["accept", "dismiss"].includes(options["dialog-action"])) {
      throw new BrowserAutomationError("INVALID_ARGUMENT", "--dialog-action 必须是 accept 或 dismiss");
    }
    if (options["prompt-text"] != null && options["dialog-action"] !== "accept") {
      throw new BrowserAutomationError("INVALID_ARGUMENT", "--prompt-text 只能和 --dialog-action accept 一起使用");
    }
    return performElementAction(requireOption(options, "session"), {
      kind: group,
      snapshotId: requireOption(options, "snapshot"),
      elementId: requireOption(options, "element"),
      value: options.value,
      dialogAction: options["dialog-action"],
      promptText: options["prompt-text"]
    });
  }
  if (group === "key" && !action) return sendKey(requireOption(options, "session"), requireOption(options, "key"));
  if (group === "drag" && !action) {
    return dragElement(requireOption(options, "session"), {
      snapshotId: requireOption(options, "snapshot"),
      sourceElementId: requireOption(options, "source"),
      targetElementId: requireOption(options, "target")
    });
  }
  if (group === "upload-file" && !action) {
    return uploadFile(requireOption(options, "session"), {
      snapshotId: requireOption(options, "snapshot"),
      elementId: requireOption(options, "element"),
      filePath: requireOption(options, "file")
    });
  }
  if (group === "scroll" && !action) {
    return scroll(requireOption(options, "session"), {
      direction: options.direction || "down",
      pages: numberOption(options, "pages")
    });
  }
  if (group === "screenshot" && !action) {
    return screenshot(requireOption(options, "session"), options.full === true || options["full-page"] === true);
  }
  throw new BrowserAutomationError("INVALID_ARGUMENT", `未知命令：${command.join(" ") || "(empty)"}`);
}

export function parseArguments(args) {
  return parseCliArguments(args, BOOLEAN_FLAGS);
}

function validateOptions(command, options) {
  const key = command.join(" ");
  const common = ["json"];
  const allowedByCommand = {
    doctor: common,
    capabilities: common,
    "session start": [...common, "cdp-url", "target", "artifact-root", "run-id", "uiwarden-session", "mode", "allow-target-selection", "upload-root"],
    "session status": [...common, "session"],
    "session target": [...common, "session", "target"],
    "session control": [...common, "session", "mode"],
    "session stop": [...common, "session", "reason"],
    "tabs list": [...common, "session"],
    "tabs activate": [...common, "session", "target"],
    "downloads list": [...common, "session"],
    observe: [...common, "session", "max-elements", "max-text-length", "full", "full-page", "diff"],
    navigate: [...common, "session", "url"],
    back: [...common, "session"],
    forward: [...common, "session"],
    reload: [...common, "session"],
    click: [...common, "session", "snapshot", "element", "dialog-action", "prompt-text"],
    "set-value": [...common, "session", "snapshot", "element", "value"],
    "type-text": [...common, "session", "snapshot", "element", "value"],
    "select-option": [...common, "session", "snapshot", "element", "value"],
    hover: [...common, "session", "snapshot", "element"],
    key: [...common, "session", "key"],
    drag: [...common, "session", "snapshot", "source", "target"],
    "upload-file": [...common, "session", "snapshot", "element", "file"],
    scroll: [...common, "session", "direction", "pages"],
    screenshot: [...common, "session", "full", "full-page"],
    mcp: ["session", "socket"]
  };
  const allowed = allowedByCommand[key];
  if (!allowed) return;
  const unknown = Object.keys(options).find((name) => !allowed.includes(name));
  if (unknown) throw new BrowserAutomationError("INVALID_ARGUMENT", `${key} 不支持 --${unknown}`);
}

async function runMcp(options) {
  const sessionId = requireOption(options, "session");
  await getSession(sessionId);
  process.env.DT_GUI_BROWSER_PERSISTENT_CDP = "1";
  const serverOptions = {
    serverName: "dt-gui-browser",
    serverVersion: RUNTIME_VERSION,
    tools: mcpTools(),
    toolCapabilities: { listChanged: false },
    parentPid: Number(process.env.DT_GUI_BROWSER_PARENT_PID) || undefined,
    callTool: (name, args) => callMcpTool(sessionId, name, args),
    compatibilityCall: async (args) => {
      const parsed = parseArguments(args);
      const requestedSession = parsed.options.session;
      if (requestedSession && requestedSession !== sessionId) {
        throw new BrowserAutomationError("SESSION_NOT_ALLOWED", "MCP daemon 只允许访问绑定的浏览器会话");
      }
      parsed.options.session = sessionId;
      if (parsed.command[0] === "mcp" || (parsed.command[0] === "session" && parsed.command[1] === "start")) {
        throw new BrowserAutomationError("INVALID_ARGUMENT", "MCP CLI 兼容入口不允许启动嵌套服务或新建会话");
      }
      return dispatch(parsed.command, parsed.options);
    }
  };
  try {
    if (options.socket) await runMcpSocket(serverOptions, String(options.socket));
    else await runMcpJsonLines(serverOptions);
  } finally {
    shutdownPersistentRuntime();
  }
}

async function callMcpTool(sessionId, name, args) {
  if (name === "tabs_list") return listTabs(sessionId);
  if (name === "downloads_list") return listDownloads(sessionId);
  if (name === "observe") {
    return observe(sessionId, {
      maxElements: args.maxElements,
      fullPage: args.fullPage === true,
      diff: args.diff === true
    });
  }
  if (name === "navigate") return navigate(sessionId, requireToolString(args, "url"));
  if (name === "back") return goBack(sessionId);
  if (name === "forward") return goForward(sessionId);
  if (name === "reload") return reload(sessionId);
  if (["click", "set_value", "type_text", "select_option", "hover"].includes(name)) {
    return performElementAction(sessionId, {
      kind: name.replaceAll("_", "-"),
      snapshotId: requireToolString(args, "snapshotId"),
      elementId: requireToolString(args, "elementId"),
      value: args.value,
      dialogAction: args.dialogAction,
      promptText: args.promptText
    });
  }
  if (name === "key") return sendKey(sessionId, requireToolString(args, "key"));
  if (name === "drag") {
    return dragElement(sessionId, {
      snapshotId: requireToolString(args, "snapshotId"),
      sourceElementId: requireToolString(args, "sourceElementId"),
      targetElementId: requireToolString(args, "targetElementId")
    });
  }
  if (name === "upload_file") {
    return uploadFile(sessionId, {
      snapshotId: requireToolString(args, "snapshotId"),
      elementId: requireToolString(args, "elementId"),
      filePath: requireToolString(args, "filePath")
    });
  }
  if (name === "scroll") return scroll(sessionId, { direction: args.direction, pages: args.pages });
  if (name === "screenshot") return screenshot(sessionId, args.fullPage === true);
  throw new BrowserAutomationError("INVALID_ARGUMENT", `未知 MCP 工具：${name}`);
}

function mcpTools() {
  const sessionless = (name, description, properties = {}, required = []) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  });
  const elementProperties = {
    snapshotId: { type: "string", description: "Latest observe snapshotId" },
    elementId: { type: "string", description: "Element ID from that snapshot" }
  };
  return [
    sessionless("tabs_list", "Read the UIWarden-controlled browser target."),
    sessionless("downloads_list", "List observed downloads, completion state, suggested filename, and captured file evidence."),
    sessionless("observe", "Capture semantic page state and a screenshot.", {
      maxElements: { type: "integer", minimum: 1, maximum: 500 },
      fullPage: { type: "boolean" },
      diff: { type: "boolean", description: "Return only semantic changes after the first observation." }
    }),
    sessionless("navigate", "Navigate the current target to an HTTP/HTTPS URL.", { url: { type: "string" } }, ["url"]),
    sessionless("back", "Navigate backward in page history."),
    sessionless("forward", "Navigate forward in page history."),
    sessionless("reload", "Reload the current page."),
    sessionless("click", "Click one element. If DIALOG_RESPONSE_REQUIRED is returned, retry with dialogAction.", {
      ...elementProperties,
      dialogAction: { enum: ["accept", "dismiss"] },
      promptText: { type: "string", maxLength: 4000 }
    }, ["snapshotId", "elementId"]),
    sessionless("set_value", "Replace a non-secure input value.", { ...elementProperties, value: { type: "string" } }, ["snapshotId", "elementId", "value"]),
    sessionless("type_text", "Append text to a non-secure input.", { ...elementProperties, value: { type: "string" } }, ["snapshotId", "elementId", "value"]),
    sessionless("select_option", "Select an option by value or visible label.", { ...elementProperties, value: { type: "string" } }, ["snapshotId", "elementId", "value"]),
    sessionless("hover", "Hover one element from the latest snapshot.", elementProperties, ["snapshotId", "elementId"]),
    sessionless("key", "Send one key or modifier chord such as Meta+A.", { key: { type: "string" } }, ["key"]),
    sessionless("drag", "Drag a snapshot-scoped source to a snapshot-scoped drop target.", {
      snapshotId: elementProperties.snapshotId,
      sourceElementId: elementProperties.elementId,
      targetElementId: elementProperties.elementId
    }, ["snapshotId", "sourceElementId", "targetElementId"]),
    sessionless("upload_file", "Upload one regular file from the authorized workspace to a file input.", {
      ...elementProperties,
      filePath: { type: "string", description: "Absolute path inside the authorized workspace" }
    }, ["snapshotId", "elementId", "filePath"]),
    sessionless("scroll", "Scroll the page by viewport pages.", {
      direction: { enum: ["up", "down", "left", "right"] },
      pages: { type: "number", minimum: 0.1, maximum: 20 }
    }),
    sessionless("screenshot", "Capture the current page.", { fullPage: { type: "boolean" } })
  ];
}

function writeSuccess(data, compact) {
  const envelope = { ok: true, data };
  process.stdout.write(`${JSON.stringify(envelope, null, compact ? 0 : 2)}\n`);
}

function writeFailure(error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error.code, message: error.message, details: error.details || {} }
  })}\n`);
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserAutomationError("INVALID_ARGUMENT", `缺少 --${name}`);
  }
  return value;
}

function numberOption(options, name) {
  if (options[name] == null) return undefined;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new BrowserAutomationError("INVALID_ARGUMENT", `--${name} 必须是数字`);
  return value;
}

function requireToolString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new BrowserAutomationError("INVALID_ARGUMENT", `MCP 参数 ${name} 不能为空`);
  return value;
}
