/**
 * 运行形态标识：web 部署（默认）或桌面客户端本地模式。
 *
 * 桌面客户端（desktop/main.cjs）拉起 server 时会注入 UI_AGENT_DESKTOP=true。
 * web 与客户端共用同一套 server/前端代码，仅通过该标志切换本地化行为：
 * - agent 提示词引导使用用户本机浏览器环境（有头/CDP/本机登录态可用）；
 * - 数据落在本机 SQLite 和会话文件目录中。
 */
export function isDesktopMode(): boolean {
  return String(process.env.UI_AGENT_DESKTOP ?? "").trim().toLowerCase() === "true";
}

interface UiOperationTargetLike {
  kind?: string;
  browserKernel?: string;
  providerId?: string;
}

/** Returns the reason a UI operation cannot run in a Web deployment. */
export function webUiOperationTargetError(target: UiOperationTargetLike | undefined): string | undefined {
  if (!target) return undefined;
  if (target.kind === "native-app" && target.providerId !== "mock") {
    return "Web 部署只能使用服务器 Mock Provider 验证电脑控制协议；真实 macOS/Windows 桌面请使用 UIWarden 客户端";
  }
  if (
    target.kind === "browser"
    && target.browserKernel !== "playwright"
    && target.browserKernel !== "uiwarden-embedded"
  ) {
    return "Web 部署只支持 Playwright Chromium 或服务端托管 gui-browser";
  }
  return undefined;
}
