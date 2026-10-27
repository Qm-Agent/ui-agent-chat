import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GuiAutomationError } from "../shared-runtime/index.js";
import type {
  AppInfo,
  AppSelector,
  AutomationSession,
  DeliveryMode,
  NativeAction,
  NativeProvider,
  ProviderId,
  ProviderSnapshot,
  UiElement
} from "./types.js";

const execFileAsync = promisify(execFile);
const MAC_PROVIDER_RESPONSE_TIMEOUT_MS = 30_000;
const MAC_PROVIDER_OBSERVE_TIMEOUT_MS = 25_000;
const MAC_PROVIDER_RESPONSE_POLL_MS = 20;
const MAC_PROVIDER_DAEMON_READY_TIMEOUT_MS = 10_000;
const MAC_PROVIDER_DAEMON_POLL_MS = 5;
const providerInstances = new Map<ProviderId, NativeProvider>();

export function provider(providerId: string): NativeProvider {
  const existing = providerInstances.get(providerId as ProviderId);
  if (existing) return existing;
  const created = providerId === "mock"
    ? new MockProvider()
    : providerId === "macos-accessibility"
      ? new MacOsProvider()
      : providerId === "windows-ui-automation"
        ? new WindowsProvider()
        : undefined;
  if (!created) throw new GuiAutomationError("UNSUPPORTED_PROVIDER", `未知 Provider：${providerId}`);
  providerInstances.set(created.id, created);
  return created;
}

class MockProvider implements NativeProvider {
  readonly id: ProviderId = "mock";

  async probe(): Promise<Record<string, unknown>> {
    return {
      providerId: this.id,
      available: true,
      permission: "granted",
      capabilities: ["observe", "click", "set-value", "type-text", "key", "scroll"]
    };
  }

  async listApps(): Promise<AppInfo[]> {
    return [{ id: "mock.demo", displayName: "UIWarden Mock Desktop", isRunning: true, processId: process.pid }];
  }

  async launchApp(_app: AppSelector, _deliveryMode: DeliveryMode): Promise<AppInfo> {
    return (await this.listApps())[0];
  }

  async observe(session: AutomationSession, _full: boolean): Promise<ProviderSnapshot> {
    const input = String(session.providerState.input || "");
    const deleted = session.providerState.deleted === true;
    const scrollPosition = Number(session.providerState.scrollPosition || 0);
    const elements: UiElement[] = [
      element("input-name", "0.0", "TextField", "Name", ["set-value"], {
        value: input, focused: true, bounds: { x: 20, y: 20, width: 240, height: 32 }
      }),
      element("button-save", "0.1", "Button", "Save draft", ["click"], {
        bounds: { x: 20, y: 70, width: 120, height: 32 }
      }),
      element("button-delete", "0.2", "Button", "Delete record", ["click"], {
        bounds: { x: 150, y: 70, width: 120, height: 32 }
      }),
      element("password", "0.3", "SecureTextField", "Password", [], {
        value: "[REDACTED]", secure: true, bounds: { x: 20, y: 120, width: 240, height: 32 }
      }),
      element("static-search", "0.4", "AXStaticText", "Search", ["UIWardenCenterClick"], {
        bounds: { x: 20, y: 170, width: 240, height: 32 }
      }),
      element("offscreen-result", "0.5", "AXStaticText", "Offscreen result", ["UIWardenCenterClick"], {
        bounds: { x: 20, y: 720, width: 240, height: 32 }
      })
    ].filter((item) => !deleted || item.elementId !== "button-delete");
    return withProjection({
      app: { id: session.app.value, displayName: "UIWarden Mock Desktop", isRunning: true, processId: process.pid },
      text: `Window UIWarden Mock Desktop\nTextField Name value=${JSON.stringify(input)}\nButton Save draft\n${deleted ? "Status record deleted" : "Button Delete record"}\nScrollPosition ${scrollPosition}`,
      elements,
      windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      captureGaps: ["mock-provider-no-screenshot"]
    }, _full, nativeObservationLimits(_full));
  }

  async perform(session: AutomationSession, action: NativeAction): Promise<Record<string, unknown>> {
    const state = session.providerState;
    if (action.kind === "click") {
      if (!action.elementId && (action.x == null || action.y == null)) {
        throw new GuiAutomationError("INVALID_ARGUMENT", "click 需要 element 或坐标");
      }
      if (action.elementId === "button-delete") state.deleted = true;
      if (action.elementId === "button-save") state.saveCount = Number(state.saveCount || 0) + 1;
    } else if (action.kind === "set-value") {
      state.input = action.value || "";
    } else if (action.kind === "type-text") {
      state.input = `${String(state.input || "")}${action.value || ""}`;
    } else if (action.kind === "key") {
      state.lastKey = action.key;
    } else if (action.kind === "scroll") {
      state.scrollPosition = Number(state.scrollPosition || 0) + (action.direction === "up" ? -1 : 1) * (action.pages ?? 1);
    } else {
      throw new GuiAutomationError("UNSUPPORTED_ACTION", `Mock Provider 不支持动作：${action.kind}`);
    }
    return session.deliveryMode === "background-safe"
      ? {
          performed: true,
          kind: action.kind,
          deliveryMethod: "mock-background",
          deliveryMode: "background-safe",
          frontmostApplicationUnchanged: true,
          cursorUnchanged: true
        }
      : { performed: true, kind: action.kind, deliveryMethod: "mock-foreground" };
  }
}

class MacOsProvider implements NativeProvider {
  readonly id: ProviderId = "macos-accessibility";
  private readonly helperPath = resolveMacHelperPath();
  private daemonReady?: Promise<string>;

  async probe(): Promise<Record<string, unknown>> {
    return objectResult(await this.invoke({ command: "probe" }));
  }

  async listApps(): Promise<AppInfo[]> {
    return arrayResult<AppInfo>(await this.invoke({ command: "listApps" }), "macOS 应用列表协议无效");
  }

  async launchApp(app: AppSelector, deliveryMode: DeliveryMode): Promise<AppInfo> {
    if (app.kind === "process-id") throw new GuiAutomationError("INVALID_ARGUMENT", "不能使用 process-id 启动尚未运行的应用");
    const launched = objectResult(await this.invoke({ command: "launch", app, deliveryMode })) as unknown as AppInfo;
    if (launched.processId) return launched;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = (await this.listApps()).find((candidate) => appMatches(candidate, app));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new GuiAutomationError("APP_LAUNCH_FAILED", `应用已请求启动，但未出现可操作窗口：${app.value}`);
  }

  async observe(session: AutomationSession, full: boolean): Promise<ProviderSnapshot> {
    const limits = nativeObservationLimits(full);
    const observed = objectResult(await this.invoke({
      command: "observe",
      app: session.app,
      maxDepth: limits.maxDepth,
      maxElements: limits.maxElements,
      visibleOnly: !full,
      diagnosticOutputDir: path.join(session.artifactDir, "provider-diagnostics"),
      screenshotPath: path.join(session.artifactDir, "screenshots", `frame_${pad(session.snapshotSequence + 1)}.png`)
    })) as unknown as ProviderSnapshot;
    return withProjection(observed, full, limits);
  }

  async perform(session: AutomationSession, action: NativeAction): Promise<Record<string, unknown>> {
    const target = action.elementId ? session.lastElements.find((item) => item.elementId === action.elementId) : undefined;
    return objectResult(await this.invoke({
      command: "perform",
      app: session.app,
      deliveryMode: session.deliveryMode,
      action,
      providerPath: target?.providerPath,
      diagnosticOutputDir: path.join(session.artifactDir, "provider-diagnostics"),
      screenshotPath: session.lastScreenshotPath,
      snapshotWindowBounds: session.lastWindowBounds,
      postScreenshotPath: path.join(session.artifactDir, "screenshots", `action_${pad(session.actionCount + 1)}_post.png`),
      expectedElement: target ? { role: target.role, name: target.name, secure: target.secure, bounds: target.bounds } : undefined
    }));
  }

  private async invoke(request: Record<string, unknown>): Promise<unknown> {
    if (process.platform !== "darwin") {
      throw new GuiAutomationError("PROVIDER_UNAVAILABLE", "macOS Accessibility Provider 只能在 macOS 运行");
    }
    const appStat = await fs.stat(this.helperPath).catch(() => undefined);
    if (!appStat?.isDirectory()) {
      throw new GuiAutomationError("PROVIDER_UNAVAILABLE", `macOS Provider App 不存在：${this.helperPath}；请先执行 scripts/build-macos-provider.sh`);
    }
    const executable = macHelperExecutablePath(this.helperPath);
    const executableStat = await fs.stat(executable).catch(() => undefined);
    if (!executableStat?.isFile()) {
      throw new GuiAutomationError("PROVIDER_UNAVAILABLE", `macOS Provider 可执行文件不存在：${executable}`);
    }
    if (process.env.DT_GUI_COMPUTER_PROVIDER_PERSISTENT !== "1") {
      return invokeMacAppProviderWithRecovery(this.helperPath, request);
    }
    const directory = resolveMacProviderDaemonDirectory();
    try {
      const readyDirectory = await (this.daemonReady ??= ensureMacProviderDaemon(this.helperPath).catch((error) => {
        this.daemonReady = undefined;
        throw error;
      }));
      return await invokeMacDaemonProvider(
        readyDirectory,
        request,
        macProviderResponseTimeout(request)
      );
    } catch (error) {
      if (error instanceof GuiAutomationError && error.code !== "PROVIDER_UNAVAILABLE") throw error;
      this.daemonReady = undefined;
      await resetMacProviderDaemon(directory);
      if (String(request.command) === "perform") throw error;
      try {
        const readyDirectory = await (this.daemonReady ??= ensureMacProviderDaemon(this.helperPath));
        return await invokeMacDaemonProvider(
          readyDirectory,
          request,
          macProviderResponseTimeout(request)
        );
      } catch (retryError) {
        this.daemonReady = undefined;
        throw retryError;
      }
    }
  }
}

class WindowsProvider implements NativeProvider {
  readonly id: ProviderId = "windows-ui-automation";
  private readonly helperPath = resolveWindowsHelperPath();

  async probe(): Promise<Record<string, unknown>> {
    return objectResult(await this.invoke({ command: "probe" }));
  }
  async listApps(): Promise<AppInfo[]> {
    return arrayResult<AppInfo>(await this.invoke({ command: "listApps" }), "Windows 应用列表协议无效");
  }
  async launchApp(app: AppSelector, _deliveryMode: DeliveryMode): Promise<AppInfo> {
    return objectResult(await this.invoke({ command: "launch", app })) as unknown as AppInfo;
  }
  async observe(session: AutomationSession, full: boolean): Promise<ProviderSnapshot> {
    const limits = nativeObservationLimits(full);
    const observed = objectResult(await this.invoke({
      command: "observe",
      app: session.app,
      maxDepth: limits.maxDepth,
      maxElements: limits.maxElements
    })) as unknown as ProviderSnapshot;
    return withProjection(observed, full, limits);
  }
  async perform(session: AutomationSession, action: NativeAction): Promise<Record<string, unknown>> {
    const target = action.elementId ? session.lastElements.find((item) => item.elementId === action.elementId) : undefined;
    return objectResult(await this.invoke({
      command: "perform",
      app: session.app,
      deliveryMode: session.deliveryMode,
      action,
      providerPath: target?.providerPath,
      expectedElement: target ? { role: target.role, name: target.name, secure: target.secure } : undefined
    }));
  }
  private async invoke(request: Record<string, unknown>): Promise<unknown> {
    if (process.platform !== "win32") {
      throw new GuiAutomationError("PROVIDER_UNAVAILABLE", "Windows UI Automation Provider 只能在 Windows 运行");
    }
    const stat = await fs.stat(this.helperPath).catch(() => undefined);
    if (!stat?.isFile()) {
      throw new GuiAutomationError("PROVIDER_UNAVAILABLE", `Windows Provider 不存在：${this.helperPath}；请先执行 scripts/build-windows-provider.ps1`);
    }
    return invokeFileProvider(this.helperPath, [], request, "Windows Provider");
  }
}

async function invokeFileProvider(executable: string, prefixArgs: string[], request: Record<string, unknown>, label: string): Promise<unknown> {
  const call = await createProviderCall(request);
  try {
    await execFileAsync(executable, [...prefixArgs, "--request", call.requestPath, "--response", call.responsePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    return providerPayload(await fs.readFile(call.responsePath, "utf8"), label);
  } catch (error) {
    if (error instanceof GuiAutomationError) throw error;
    throw providerUnavailableError(label, error);
  } finally {
    await cleanupProviderCall(call);
  }
}

async function invokeMacAppProvider(
  appPath: string,
  request: Record<string, unknown>,
  responseTimeoutMs = macProviderResponseTimeout(request)
): Promise<unknown> {
  const call = await createProviderCall(request);
  let launcherResult: Record<string, unknown> = { launcher: "/usr/bin/open" };
  try {
    const launched = await execFileAsync("/usr/bin/open", macProviderLaunchArguments(
      appPath,
      call.requestPath,
      call.responsePath,
      call.diagnosticPath
    ), {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024
    });
    launcherResult = {
      ...launcherResult,
      exitCode: 0,
      stdout: launched.stdout,
      stderr: launched.stderr
    };
    const deadline = Date.now() + responseTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(call.responsePath, "utf8");
        if (raw.trim()) return providerPayload(raw, "macOS Provider");
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "";
        if (code !== "ENOENT") {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Unexpected end of JSON input/.test(message)) throw error;
        }
      }
      await delay(MAC_PROVIDER_RESPONSE_POLL_MS);
    }
    const error = new GuiAutomationError(
      "PROVIDER_UNAVAILABLE",
      `macOS Provider ${responseTimeoutMs / 1000} 秒内未返回响应`
    );
    const diagnosticDir = await preserveProviderCall(call, {
      ...launcherResult,
      timeoutMs: responseTimeoutMs
    });
    throw new GuiAutomationError(error.code, error.message, {
      details: { diagnosticDir }
    });
  } catch (error) {
    if (error instanceof GuiAutomationError) throw error;
    launcherResult = {
      ...launcherResult,
      exitCode: processExitCode(error),
      signal: processSignal(error),
      stdout: processOutput(error, "stdout"),
      stderr: processOutput(error, "stderr")
    };
    if (isProcessTimeout(error)) {
      const diagnosticDir = await preserveProviderCall(call, {
        ...launcherResult,
        timeoutMs: responseTimeoutMs
      });
      throw new GuiAutomationError(
        "PROVIDER_UNAVAILABLE",
        "macOS Provider 启动器 10 秒内未返回",
        { details: { diagnosticDir } }
      );
    }
    throw providerUnavailableError("macOS Provider", error);
  } finally {
    await cleanupProviderCall(call);
  }
}

async function invokeMacExecutableProvider(
  appPath: string,
  request: Record<string, unknown>,
  responseTimeoutMs = macProviderResponseTimeout(request)
): Promise<unknown> {
  const call = await createProviderCall(request);
  try {
    await execFileAsync(
      macHelperExecutablePath(appPath),
      macProviderExecutableArguments(call.requestPath, call.responsePath, call.diagnosticPath),
      {
        encoding: "utf8",
        timeout: responseTimeoutMs,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    return providerPayload(await fs.readFile(call.responsePath, "utf8"), "macOS Provider");
  } catch (error) {
    if (error instanceof GuiAutomationError) throw error;
    const response = await readOptionalProviderResponse(call.responsePath);
    if (response) return providerPayload(response, "macOS Provider");
    if (isProcessTimeout(error)) {
      const diagnosticDir = await preserveProviderCall(call, {
        launcher: macHelperExecutablePath(appPath),
        timeoutMs: responseTimeoutMs,
        exitCode: processExitCode(error),
        signal: processSignal(error),
        stdout: processOutput(error, "stdout"),
        stderr: processOutput(error, "stderr")
      });
      throw new GuiAutomationError(
        "PROVIDER_UNAVAILABLE",
        `macOS Provider 可执行文件 ${responseTimeoutMs / 1000} 秒内未返回响应`,
        { details: { diagnosticDir } }
      );
    }
    throw providerUnavailableError("macOS Provider", error);
  } finally {
    await cleanupProviderCall(call);
  }
}

async function invokeMacAppProviderWithRecovery(
  appPath: string,
  request: Record<string, unknown>
): Promise<unknown> {
  try {
    return await invokeMacAppProvider(appPath, request);
  } catch (error) {
    if (
      String(request.command) === "perform"
      || !isTransientMacProviderFailure(error)
    ) {
      throw error;
    }
    await delay(120);
    return invokeMacExecutableProvider(appPath, request);
  }
}

async function ensureMacProviderDaemon(appPath: string): Promise<string> {
  const directory = resolveMacProviderDaemonDirectory();
  const readyPath = path.join(directory, "ready.json");
  const existing = await readOptionalProviderReady(readyPath);
  if (existing) {
    const ownerPid = Number(existing.ownerPid);
    const providerPid = Number(existing.providerPid);
    if (ownerPid === process.pid && processIsAlive(providerPid)) return directory;
    if (ownerPid > 0 && ownerPid !== process.pid && processIsAlive(ownerPid)) {
      throw new GuiAutomationError(
        "PROVIDER_BUSY",
        "macOS Provider 已由另一个 dt-gui-computer Runtime 持有",
        { details: { ownerPid, providerPid } }
      );
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  try {
    await execFileAsync(
      "/usr/bin/open",
      macProviderDaemonLaunchArguments(appPath, directory, process.pid),
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }
    );
  } catch (error) {
    throw providerUnavailableError("macOS Provider", error);
  }
  const deadline = Date.now() + MAC_PROVIDER_DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await readOptionalProviderReady(readyPath);
    if (
      Number(ready?.ownerPid) === process.pid
      && processIsAlive(Number(ready?.providerPid))
    ) {
      return directory;
    }
    await delay(MAC_PROVIDER_DAEMON_POLL_MS);
  }
  throw new GuiAutomationError(
    "PROVIDER_UNAVAILABLE",
    `macOS Provider 常驻服务 ${MAC_PROVIDER_DAEMON_READY_TIMEOUT_MS / 1000} 秒内未就绪`
  );
}

async function invokeMacDaemonProvider(
  directory: string,
  request: Record<string, unknown>,
  responseTimeoutMs = macProviderResponseTimeout(request)
): Promise<unknown> {
  await assertMacProviderDaemonAlive(directory);
  const id = `${Date.now()}-${randomUUID()}`;
  const temporaryPath = path.join(directory, `${id}.request.tmp`);
  const requestPath = path.join(directory, `${id}.request.json`);
  const responsePath = path.join(directory, `${id}.response.json`);
  const diagnosticPath = path.join(directory, `${id}.stages.jsonl`);
  const call: ProviderCall = { id, requestPath, responsePath, diagnosticPath };
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({
      ...request,
      diagnosticPath
    }), { mode: 0o600 });
    await fs.rename(temporaryPath, requestPath);
    const deadline = Date.now() + responseTimeoutMs;
    let nextHealthCheck = Date.now() + 100;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(responsePath, "utf8");
        if (raw.trim()) return providerPayload(raw, "macOS Provider");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= nextHealthCheck) {
        await assertMacProviderDaemonAlive(directory);
        nextHealthCheck = Date.now() + 100;
      }
      await delay(MAC_PROVIDER_DAEMON_POLL_MS);
    }
    const diagnosticDir = await preserveProviderCall(call, {
      launcher: "persistent-provider",
      timeoutMs: responseTimeoutMs,
      providerDaemonDirectory: directory
    });
    throw new GuiAutomationError(
      "PROVIDER_UNAVAILABLE",
      `macOS Provider 常驻服务 ${responseTimeoutMs / 1000} 秒内未返回响应`,
      { details: { diagnosticDir } }
    );
  } finally {
    await Promise.all([
      fs.rm(temporaryPath, { force: true }),
      fs.rm(requestPath, { force: true }),
      fs.rm(responsePath, { force: true }),
      fs.rm(diagnosticPath, { force: true })
    ]);
  }
}

async function resetMacProviderDaemon(directory: string): Promise<void> {
  const ready = await readOptionalProviderReady(path.join(directory, "ready.json"));
  const providerPid = Number(ready?.providerPid);
  if (Number(ready?.ownerPid) === process.pid && processIsAlive(providerPid)) {
    try {
      process.kill(providerPid, "SIGTERM");
    } catch {
      // Provider 可能已在健康检查后退出，目录清理仍需继续。
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
}

async function assertMacProviderDaemonAlive(directory: string): Promise<void> {
  const ready = await readOptionalProviderReady(path.join(directory, "ready.json"));
  const providerPid = Number(ready?.providerPid);
  if (Number(ready?.ownerPid) === process.pid && processIsAlive(providerPid)) return;
  throw new GuiAutomationError(
    "PROVIDER_UNAVAILABLE",
    "macOS Provider 常驻服务已退出，将回退到一次性 Provider",
    { details: { providerPid: Number.isInteger(providerPid) ? providerPid : undefined } }
  );
}

interface ProviderCall {
  id: string;
  requestPath: string;
  responsePath: string;
  diagnosticPath: string;
  diagnosticOutputDir?: string;
}

async function createProviderCall(request: Record<string, unknown>): Promise<ProviderCall> {
  const callDir = path.join(os.tmpdir(), "dt-gui-computer-provider-calls");
  await fs.mkdir(callDir, { recursive: true });
  const id = `${process.pid}-${randomUUID()}`;
  const call = {
    id,
    requestPath: path.join(callDir, `${id}.request.json`),
    responsePath: path.join(callDir, `${id}.response.json`),
    diagnosticPath: path.join(callDir, `${id}.stages.jsonl`),
    diagnosticOutputDir: optionalAbsoluteDirectory(request.diagnosticOutputDir)
  };
  await fs.writeFile(call.requestPath, JSON.stringify({
    ...request,
    diagnosticPath: call.diagnosticPath
  }), { mode: 0o600 });
  return call;
}

async function cleanupProviderCall(call: ProviderCall): Promise<void> {
  await Promise.all([
    fs.rm(call.requestPath, { force: true }),
    fs.rm(call.responsePath, { force: true }),
    fs.rm(call.diagnosticPath, { force: true })
  ]);
}

async function preserveProviderCall(
  call: ProviderCall,
  runtime: Record<string, unknown>
): Promise<string> {
  const root = call.diagnosticOutputDir || path.join(
    path.resolve(process.env.DT_GUI_COMPUTER_HOME?.trim() || path.join(os.homedir(), ".dt-gui-computer")),
    "provider-diagnostics"
  );
  const directory = path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${call.id}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const providerPid = await readProviderPid(call.diagnosticPath);
  await Promise.all([
    copyOptionalFile(call.requestPath, path.join(directory, "request.json")),
    copyOptionalFile(call.responsePath, path.join(directory, "response.json")),
    copyOptionalFile(call.diagnosticPath, path.join(directory, "stages.jsonl")),
    fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify({
      capturedAt: new Date().toISOString(),
      runtimePid: process.pid,
      providerPid,
      ...runtime
    }, null, 2), { mode: 0o600 })
  ]);
  return directory;
}

async function readProviderPid(diagnosticPath: string): Promise<number | undefined> {
  try {
    const lines = (await fs.readFile(diagnosticPath, "utf8")).trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const payload = JSON.parse(line) as { providerPid?: unknown };
      const providerPid = Number(payload.providerPid);
      if (Number.isInteger(providerPid) && providerPid > 0) return providerPid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function copyOptionalFile(source: string, destination: string): Promise<void> {
  await fs.copyFile(source, destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function processExitCode(error: unknown): string | number | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

function processSignal(error: unknown): string | undefined {
  return error && typeof error === "object" && "signal" in error
    ? String((error as { signal?: unknown }).signal ?? "")
    : undefined;
}

function processOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(key in error)) return "";
  return String((error as Record<string, unknown>)[key] ?? "").slice(0, 64 * 1024);
}

function optionalAbsoluteDirectory(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return path.resolve(value.trim());
}

async function readOptionalProviderResponse(responsePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(responsePath, "utf8");
    return raw.trim() ? raw : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function providerPayload(raw: string, label: string): unknown {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  if (payload.ok === false) {
    const failure = objectResult(payload.error);
    throw new GuiAutomationError(
      String(failure.code || "INTERNAL"),
      String(failure.message || `${label} 执行失败`),
      { details: failure.details }
    );
  }
  return payload.data;
}

function providerUnavailableError(label: string, error: unknown): GuiAutomationError {
  const message = error instanceof Error ? error.message : String(error);
  if (label === "macOS Provider" && /kLSIncompatibleSystemVersionErr|NSOSStatusErrorDomain Code=-10825/.test(message)) {
    return new GuiAutomationError(
      "PROVIDER_UNAVAILABLE",
      "macOS Provider 与当前系统版本不兼容；请安装支持当前 macOS 版本的 UIWarden 客户端",
      { details: { cause: message } }
    );
  }
  return new GuiAutomationError("PROVIDER_UNAVAILABLE", `${label} 未返回有效响应：${message}`);
}

function macProviderResponseTimeout(request: Record<string, unknown>): number {
  return String(request.command) === "observe"
    ? MAC_PROVIDER_OBSERVE_TIMEOUT_MS
    : MAC_PROVIDER_RESPONSE_TIMEOUT_MS;
}

function isTransientMacProviderFailure(error: unknown): boolean {
  return error instanceof GuiAutomationError
    && error.code === "PROVIDER_UNAVAILABLE"
    && /未返回响应|未返回有效响应|常驻服务已退出|No such process|No such file or directory/i.test(error.message);
}

function isProcessTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const processError = error as { killed?: unknown; signal?: unknown; code?: unknown };
  return processError.killed === true
    || processError.signal === "SIGTERM"
    || processError.code === "ETIMEDOUT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOptionalProviderReady(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolveMacProviderDaemonDirectory(): string {
  const configured = process.env.DT_GUI_COMPUTER_PROVIDER_DAEMON_DIR?.trim();
  if (configured) return path.resolve(configured);
  const runtimeHome = path.resolve(
    process.env.DT_GUI_COMPUTER_HOME
      || path.join(os.homedir(), ".dt-gui-computer")
  );
  return path.join(runtimeHome, "provider-macos-daemon");
}

export function nativeObservationLimits(full: boolean): { maxDepth: number; maxElements: number } {
  return full
    ? { maxDepth: 12, maxElements: 800 }
    : { maxDepth: 8, maxElements: 400 };
}

function withProjection(
  snapshot: ProviderSnapshot,
  full: boolean,
  limits: { maxDepth: number; maxElements: number }
): ProviderSnapshot {
  return {
    ...snapshot,
    projection: {
      mode: full ? "full" : "compact",
      ...limits,
      truncated: snapshot.elements.length >= limits.maxElements
    }
  };
}

function resolveMacHelperPath(): string {
  if (process.env.DT_GUI_COMPUTER_MACOS_PROVIDER) return path.resolve(process.env.DT_GUI_COMPUTER_MACOS_PROVIDER);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packaged = path.join(packageRoot, "dt-gui-computer Provider.app");
  const development = path.join(packageRoot, "target", "native-provider", "dt-gui-computer Provider.app");
  return [packaged, development].find(existsSync) || development;
}

export function macHelperExecutablePath(appPath: string): string {
  return path.join(appPath, "Contents", "MacOS", "dt-gui-computer-provider");
}

export function macProviderLaunchArguments(
  appPath: string,
  requestPath: string,
  responsePath: string,
  diagnosticPath?: string
): string[] {
  return [
    "-n", appPath, "--args", "--request", requestPath, "--response", responsePath,
    ...(diagnosticPath ? ["--diagnostics", diagnosticPath] : [])
  ];
}

export function macProviderExecutableArguments(
  requestPath: string,
  responsePath: string,
  diagnosticPath?: string
): string[] {
  return [
    "--request", requestPath, "--response", responsePath,
    ...(diagnosticPath ? ["--diagnostics", diagnosticPath] : [])
  ];
}

export function macProviderDaemonLaunchArguments(appPath: string, directory: string, parentPid: number): string[] {
  return ["-n", appPath, "--args", "--daemon-dir", directory, "--parent-pid", String(parentPid)];
}

function resolveWindowsHelperPath(): string {
  if (process.env.DT_GUI_COMPUTER_WINDOWS_PROVIDER) return path.resolve(process.env.DT_GUI_COMPUTER_WINDOWS_PROVIDER);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packaged = path.join(packageRoot, "windows", "DTGuiComputer.WindowsProvider.exe");
  const development = path.join(packageRoot, "target", "native-provider", "windows", "DTGuiComputer.WindowsProvider.exe");
  return [packaged, development].find(existsSync) || development;
}

function element(id: string, providerPath: string, role: string, name: string, actions: string[], extra: Partial<UiElement> = {}): UiElement {
  return { elementId: id, providerPath, role, name, secure: false, enabled: true, actions, focused: false, ...extra };
}

function appMatches(candidate: AppInfo, selector: AppSelector): boolean {
  if (selector.kind === "bundle-id") return candidate.id.toLowerCase() === selector.value.toLowerCase();
  if (selector.kind === "process-id") return String(candidate.processId || "") === selector.value;
  if (selector.kind === "path") return candidate.id.toLowerCase() === selector.value.toLowerCase() || candidate.displayName.toLowerCase() === path.basename(selector.value, ".app").toLowerCase();
  const expected = normalizeAppName(selector.value);
  return candidate.displayName.toLowerCase() === selector.value.toLowerCase()
    || candidate.id.toLowerCase() === selector.value.toLowerCase()
    || normalizeAppName(candidate.id.split(".").at(-1) || "") === expected;
}

function normalizeAppName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function objectResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuiAutomationError("INTERNAL", "Provider 返回对象协议无效");
  return value as Record<string, unknown>;
}

function arrayResult<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new GuiAutomationError("INTERNAL", message);
  return value as T[];
}

function pad(value: number): string {
  return String(value).padStart(4, "0");
}
