# dt-gui-computer

UIWarden 的独立电脑控制 CLI/MCP。`dt-gui-computer` 与 `dt-gui-browser` 复用 `gui-runtime/` 中的 TypeScript CLI、错误、存储和 MCP 核心；macOS Swift 与 Windows .NET Provider 保持独立。

## 安装

公开 npm 包发布后，Coder 工程可固定版本安装：

```bash
npm install --save-dev @uiwarden/dt-gui-computer@0.6.1
npx dt-gui-computer doctor --json
```

使用 pnpm 的等价命令：

```bash
pnpm add --save-dev @uiwarden/dt-gui-computer@0.6.1
pnpm exec dt-gui-computer doctor --json
```

当前仓库默认关闭 npm 发布。源码用户应在仓库根目录运行 `npm run gui:release:pack`，
然后从 `release/gui-packages/0.6.1/` 安装生成的 `.tgz` 文件。生成包内置 Mock Provider
和当前发布机生成的 macOS Provider。Windows Provider 已保留协议和构建入口，但本版本
没有 Windows 发布包实机验收。生产客户端也可以通过
`DT_GUI_COMPUTER_MACOS_PROVIDER`/`DT_GUI_COMPUTER_WINDOWS_PROVIDER` 指向宿主随包 Provider。

## 构建

```bash
npm run build:runtimes
native-automation/scripts/build-macos-provider.sh
# Windows PowerShell
native-automation/scripts/build-windows-provider.ps1
```

## 快速验证

```bash
DT_GUI_COMPUTER_HOME=$(mktemp -d) native-automation/dt-gui-computer doctor --json
DT_GUI_COMPUTER_HOME=$(mktemp -d) native-automation/dt-gui-computer apps list --provider mock --json
```

macOS Helper 不会自动弹出 TCC 授权窗口。`doctor` 只报告当前权限；UIWarden 客户端通过原生权限接口打开 Accessibility 或 Screen Recording 设置。授权录屏后，每次 `observe` 会将目标窗口 PNG 写入 Native Rep 的 `screenshots/`。

开发构建默认使用带稳定 Bundle ID requirement 的 ad-hoc 签名，避免每次 Swift 重编译都因 `cdhash` 变化丢失 Accessibility 授权。正式构建必须通过 `DT_GUI_COMPUTER_CODESIGN_IDENTITY` 或桌面打包签名链使用 Developer ID；修改签名类型后需要在系统设置中重新添加一次 Provider。

安装包中的 CLI 使用客户端随包 Node 执行 TypeScript 编译产物，并优先加载 Runtime 同目录的 `dt-gui-computer Provider.app`；开发环境回退到 `target/native-provider`。也可通过 `DT_GUI_COMPUTER_NODE` 和 `DT_GUI_COMPUTER_MACOS_PROVIDER` 显式覆盖。CLI、MCP、JSON Schema、错误码和 Native Rep 保持协议版本 1 兼容。

写会话可在 Agent 和用户之间切换控制权：

```bash
dt-gui-computer session control --session <session-id> --mode human-control --json
dt-gui-computer session control --session <session-id> --mode agent-control --json
```

主 Agent 可先读取应用列表，再为 UIWarden 已创建的受控会话选择目标；该命令不会创建新会话：

```bash
dt-gui-computer apps list --provider macos-accessibility --json
dt-gui-computer session target --session <session-id> --app-kind process-id --app <pid> --json
dt-gui-computer session launch --session <session-id> --app-kind bundle-id --app com.apple.calculator --json
```

`session start` 可通过 `--artifact-root <dir>` 将 Native Rep 写入指定父目录；运行时仍会为每个会话创建独立子目录。默认 `--approval-policy sensitive-actions` 对提交和危险动作生成挑战；UIWarden 的默认授权任务使用 `--approval-policy none`，避免自动授权时反复重启 Agent。常驻 daemon 无法继承调用进程环境时，可在任意原子命令前传入受控的 `--runtime-home <dir>`。

## MCP stdio

```bash
dt-gui-computer mcp
```

MCP 与 CLI 共用同一个 Runtime，提供 capability、应用发现/启动/目标选择、会话生命周期/控制、observe、语义 click、`visual-click`、set-value、type-text、key、scroll、审批和停止封装。MCP 不暴露任意 shell，也不开放任意裸坐标点击；在默认 `sensitive-actions` 策略下，`Return`、`Enter` 和 `Space` 键必须通过绑定当前快照的审批挑战。

对只暴露静态占位文本的自绘控件，observe 会返回元素 `bounds` 和 `UIWardenCenterClick` 动作。调用方可用该元素 ID 加 `--allow-coordinate-fallback` 执行快照绑定的语义中心点击，observe 一次后立即用 `type-text --focused` 向活动输入写入 Unicode。焦点令牌在任何中间动作或额外观察后失效；这与无语义锚点的裸坐标点击不同。

AX Tree 没有可用元素但目标文字可见时，可使用 `visual-click --text <label> --match exact|contains --occurrence 1`。macOS Provider 使用 Vision OCR 在最新窗口截图中定位文字，将截图坐标映射为屏幕坐标，并写入动作后截图。窗口尺寸变化会触发 `STALE_SNAPSHOT`；返回的 `visualChanged` 只表示像素变化，调用方仍需重新 observe 校验业务状态。显式裸坐标点击不再触发审批，但必须携带最新 snapshot 和 `--allow-coordinate-fallback`，并写入 Rep 审计。

原生浏览器未暴露地址栏 AX 元素时，`Command+L` 会建立一次性地址栏焦点令牌；调用方必须 observe 恰好一次后立即执行 `type-text --focused`。任何中间动作或额外观察都会使令牌失效。

当前主名称、二进制和环境变量前缀分别为 `dt-gui-computer` 与 `DT_GUI_COMPUTER_*`，不提供旧名称别名。
