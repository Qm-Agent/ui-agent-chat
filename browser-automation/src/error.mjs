import { GuiAutomationError } from "../shared-runtime/index.js";

export class BrowserAutomationError extends GuiAutomationError {
  constructor(code, message, details = {}, exitCode = 2) {
    super(code, message, { details, exitCode });
    this.name = "BrowserAutomationError";
  }
}

export function asAutomationError(error) {
  if (error instanceof BrowserAutomationError) return error;
  if (error instanceof GuiAutomationError) {
    return new BrowserAutomationError(error.code, error.message, error.details, error.exitCode);
  }
  return new BrowserAutomationError("INTERNAL", error instanceof Error ? error.message : String(error));
}
