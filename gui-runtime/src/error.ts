export interface AutomationErrorOptions {
  details?: unknown;
  exitCode?: number;
}

export class GuiAutomationError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, options: AutomationErrorOptions = {}) {
    super(message);
    this.name = "GuiAutomationError";
    this.code = code;
    this.details = options.details ?? {};
    this.exitCode = options.exitCode ?? 2;
  }

  envelope(): { ok: false; error: { code: string; message: string; details: unknown } } {
    return {
      ok: false,
      error: { code: this.code, message: this.message, details: this.details }
    };
  }
}

export function asGuiAutomationError(error: unknown): GuiAutomationError {
  if (error instanceof GuiAutomationError) return error;
  return new GuiAutomationError("INTERNAL", error instanceof Error ? error.message : String(error));
}
