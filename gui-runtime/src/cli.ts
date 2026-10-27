import { GuiAutomationError } from "./error.js";

export interface ParsedCliArguments {
  command: string[];
  options: Record<string, string | boolean>;
}

export function takeGlobalOption(args: string[], optionName: string): string | undefined {
  const index = args.indexOf(`--${optionName}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new GuiAutomationError("INVALID_ARGUMENT", `--${optionName} 必须提供值`);
  }
  args.splice(index, 2);
  return value;
}

export function parseCliArguments(
  args: string[],
  booleanFlags: ReadonlySet<string>,
  maximumCommandParts = 2
): ParsedCliArguments {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      if (Object.keys(options).length > 0) {
        throw new GuiAutomationError("INVALID_ARGUMENT", `选项后不能出现位置参数：${token}`);
      }
      command.push(token);
      continue;
    }
    const rawOption = token.slice(2);
    const equalIndex = rawOption.indexOf("=");
    const name = equalIndex >= 0 ? rawOption.slice(0, equalIndex) : rawOption;
    if (!name) throw new GuiAutomationError("INVALID_ARGUMENT", `不支持的选项格式：${token}`);
    if (Object.hasOwn(options, name)) throw new GuiAutomationError("INVALID_ARGUMENT", `选项重复：--${name}`);
    if (equalIndex >= 0) {
      if (booleanFlags.has(name)) {
        throw new GuiAutomationError("INVALID_ARGUMENT", `布尔选项不接受值：--${name}`);
      }
      options[name] = rawOption.slice(equalIndex + 1);
      continue;
    }
    if (booleanFlags.has(name)) {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new GuiAutomationError("INVALID_ARGUMENT", `选项缺少值：--${name}`);
    }
    options[name] = value;
    index += 1;
  }
  if (command.length === 0 || command.length > maximumCommandParts) {
    throw new GuiAutomationError("INVALID_ARGUMENT", `命令必须包含一到${maximumCommandParts}个位置参数`);
  }
  return { command, options };
}

export function requiredOption(options: ParsedCliArguments["options"], name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new GuiAutomationError("INVALID_ARGUMENT", `缺少参数 --${name}`);
  }
  return value;
}

export function optionalString(options: ParsedCliArguments["options"], name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function optionalInteger(options: ParsedCliArguments["options"], name: string): number | undefined {
  const value = optionalString(options, name);
  if (value == null) return undefined;
  if (!/^-?\d+$/.test(value)) throw new GuiAutomationError("INVALID_ARGUMENT", `不是有效整数：${value}`);
  return Number(value);
}

export function optionalNumber(options: ParsedCliArguments["options"], name: string): number | undefined {
  const value = optionalString(options, name);
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new GuiAutomationError("INVALID_ARGUMENT", `不是有效数字：${value}`);
  return parsed;
}

export function writeCliSuccess(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

export function writeCliFailure(error: GuiAutomationError): void {
  process.stdout.write(`${JSON.stringify(error.envelope())}\n`);
}
