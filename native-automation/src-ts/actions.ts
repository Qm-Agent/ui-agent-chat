import {
  GuiAutomationError,
  optionalInteger,
  optionalNumber,
  optionalString,
  type ParsedCliArguments
} from "../shared-runtime/index.js";
import type { NativeAction } from "./types.js";

export function buildAction(kind: string, options: ParsedCliArguments["options"]): NativeAction {
  return {
    kind,
    elementId: optionalString(options, "element"),
    value: optionalString(options, "value"),
    key: optionalString(options, "key"),
    direction: optionalString(options, "direction"),
    pages: optionalInteger(options, "pages"),
    x: optionalNumber(options, "x"),
    y: optionalNumber(options, "y"),
    allowCoordinateFallback: options["allow-coordinate-fallback"] === true,
    focused: options.focused === true,
    visualText: optionalString(options, "text"),
    matchMode: optionalString(options, "match"),
    occurrence: optionalInteger(options, "occurrence")
  };
}

export function validateAction(action: NativeAction): void {
  if (action.kind === "click" && !action.elementId && (action.x == null || action.y == null)) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "click 需要 --element 或同时提供 --x/--y");
  }
  if (action.kind === "click" && !action.elementId && !action.allowCoordinateFallback) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "坐标点击必须显式提供 --allow-coordinate-fallback");
  }
  if (action.kind === "visual-click" && !action.visualText?.trim()) throw new GuiAutomationError("INVALID_ARGUMENT", "visual-click 需要 --text");
  if (action.kind === "visual-click" && action.matchMode && !["exact", "contains"].includes(action.matchMode)) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "visual-click 的 --match 只能是 exact 或 contains");
  }
  if (action.kind === "visual-click" && action.occurrence != null && action.occurrence < 1) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "visual-click 的 --occurrence 必须大于 0");
  }
  if (action.kind === "set-value" && (!action.elementId || action.value == null)) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "set-value 需要 --element 和 --value");
  }
  if (action.kind === "type-text" && (action.value == null || (!action.elementId && !action.focused))) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "type-text 需要 --value，并指定 --element 或 --focused");
  }
  if (action.kind === "type-text" && action.elementId && action.focused) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "type-text 的 --element 与 --focused 不能同时使用");
  }
  if (action.kind === "key" && !action.key) throw new GuiAutomationError("INVALID_ARGUMENT", "key 需要 --key");
  if (action.kind === "scroll" && !action.direction) throw new GuiAutomationError("INVALID_ARGUMENT", "scroll 需要 --direction");
}
