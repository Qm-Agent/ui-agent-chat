#!/usr/bin/env node

import {
  asGuiAutomationError,
  GuiAutomationError,
  optionalInteger,
  optionalString,
  parseCliArguments,
  requiredOption,
  takeGlobalOption,
  writeCliFailure,
  writeCliSuccess,
  type ParsedCliArguments
} from "../shared-runtime/index.js";
import { dispatchComputerMcp, runComputerMcp } from "./mcp.js";
import { ComputerRuntime } from "./runtime.js";
import type { AppSelector } from "./types.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAction, validateAction } from "./actions.js";
import { filterApps, filterObservation } from "./query.js";

export { buildAction, validateAction } from "./actions.js";
export { filterApps, filterObservation } from "./query.js";

const BOOLEAN_FLAGS = new Set(["json", "full", "diff", "observe", "focused", "allow-coordinate-fallback"]);
const HELP = "dt-gui-computer [--runtime-home <path>] doctor|capabilities|apps list|session start|session status|session target|session launch|session control|observe|click|visual-click|set-value|type-text|key|scroll|approval grant|approval reject|session stop|mcp";

export async function main(rawArgs = process.argv.slice(2)): Promise<void> {
  const args = [...rawArgs];
  try {
    const runtimeHome = takeGlobalOption(args, "runtime-home");
    const parsed = parseCliArguments(args, BOOLEAN_FLAGS);
    const mcpEndpoint = process.env.DT_GUI_COMPUTER_MCP_ENDPOINT?.trim();
    if (mcpEndpoint && parsed.command[0] !== "mcp") {
      writeCliSuccess(await dispatchComputerMcp(mcpEndpoint, parsed));
      return;
    }
    if (parsed.command[0] === "mcp") {
      process.env.DT_GUI_COMPUTER_PROVIDER_PERSISTENT ||= "1";
      if (runtimeHome) process.env.DT_GUI_COMPUTER_HOME = runtimeHome;
    }
    const runtime = await ComputerRuntime.create(runtimeHome);
    if (parsed.command[0] === "mcp") {
      await runComputerMcp(runtime, optionalString(parsed.options, "socket"));
      return;
    }
    writeCliSuccess(await dispatch(runtime, parsed));
  } catch (error) {
    const failure = asGuiAutomationError(error);
    writeCliFailure(failure);
    process.exitCode = failure.exitCode;
  }
}

export async function dispatch(runtime: ComputerRuntime, parsed: ParsedCliArguments): Promise<unknown> {
  const [group, action] = parsed.command;
  const options = parsed.options;
  if (group === "doctor" && !action) return runtime.doctor();
  if (group === "capabilities" && !action) return runtime.capabilities();
  if (group === "apps" && action === "list") {
    return filterApps(
      await runtime.listApps(optionalString(options, "provider") || defaultProvider()),
      optionalString(options, "query"),
      optionalInteger(options, "limit") ?? 40
    );
  }
  if (group === "session" && action === "start") {
    return runtime.startSession({
      providerId: optionalString(options, "provider") || defaultProvider(),
      app: selector(options),
      controlMode: optionalString(options, "mode") || "agent-control",
      deliveryMode: optionalString(options, "delivery-mode") || "foreground-compatible",
      approvalPolicy: optionalString(options, "approval-policy") || "sensitive-actions",
      artifactRoot: optionalString(options, "artifact-root")
    });
  }
  if (group === "session" && action === "status") return runtime.sessionStatus(requiredOption(options, "session"));
  if (group === "session" && action === "target") return runtime.setTarget(requiredOption(options, "session"), selector(options));
  if (group === "session" && action === "launch") return runtime.launchTarget(requiredOption(options, "session"), selector(options));
  if (group === "session" && action === "control") return runtime.setControlMode(requiredOption(options, "session"), requiredOption(options, "mode"));
  if (group === "session" && action === "stop") return runtime.stopSession(requiredOption(options, "session"), optionalString(options, "reason") || "completed");
  if (group === "observe" && !action) {
    const query = optionalString(options, "query");
    return filterObservation(
      await runtime.observe(
        requiredOption(options, "session"),
        options.full === true,
        options.diff === true
      ) as unknown as Record<string, unknown>,
      query,
      optionalInteger(options, "limit") ?? 60,
      options.diff === true
    );
  }
  if (["click", "visual-click", "set-value", "type-text", "key", "scroll"].includes(group) && !action) {
    const nativeAction = buildAction(group, options);
    validateAction(nativeAction);
    const actionResult = await runtime.performAction(
      requiredOption(options, "session"),
      requiredOption(options, "snapshot"),
      nativeAction,
      optionalString(options, "approval"),
      optionalString(options, "actor") || "agent"
    );
    if (options.observe !== true) return actionResult;
    const query = optionalString(options, "query");
    const snapshot = await runtime.observe(
      requiredOption(options, "session"),
      options.full === true,
      options.diff === true
    );
    return {
      action: actionResult,
      snapshot: filterObservation(
        snapshot as unknown as Record<string, unknown>,
        query,
        optionalInteger(options, "limit") ?? 60,
        options.diff === true
      )
    };
  }
  if (group === "approval" && action === "grant") {
    return runtime.grantApproval(requiredOption(options, "session"), requiredOption(options, "challenge"));
  }
  if (group === "approval" && action === "reject") {
    return runtime.rejectApproval(
      requiredOption(options, "session"),
      requiredOption(options, "challenge"),
      optionalString(options, "reason") || "user-rejected"
    );
  }
  if ((group === "help" || group === "-h" || group === "--help") && !action) return { usage: HELP };
  throw new GuiAutomationError("INVALID_ARGUMENT", `未知命令：${parsed.command.join(" ")}\n${HELP}`);
}

function selector(options: ParsedCliArguments["options"]): AppSelector {
  return {
    kind: (optionalString(options, "app-kind") || "name") as AppSelector["kind"],
    value: requiredOption(options, "app")
  };
}

function defaultProvider(): string {
  return process.platform === "darwin" ? "macos-accessibility" : process.platform === "win32" ? "windows-ui-automation" : "mock";
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
