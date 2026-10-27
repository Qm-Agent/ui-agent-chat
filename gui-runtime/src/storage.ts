import fs from "node:fs/promises";
import path from "node:path";
import { GuiAutomationError } from "./error.js";

export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw storageError(error);
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch (error) {
    throw storageError(error);
  }
}

export async function readJsonFile<T>(filePath: string, notFoundMessage: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT") throw new GuiAutomationError("SESSION_NOT_FOUND", notFoundMessage);
    if (error instanceof SyntaxError) {
      throw new GuiAutomationError("STORAGE_CORRUPTED", `会话文件损坏，已停止写入以保护原数据：${error.message}`);
    }
    throw storageError(error);
  }
}

export function storageError(error: unknown): GuiAutomationError {
  return new GuiAutomationError("INTERNAL", `本地存储操作失败：${error instanceof Error ? error.message : String(error)}`);
}
