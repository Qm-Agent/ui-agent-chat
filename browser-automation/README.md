# dt-gui-browser

面向编程 Agent 的浏览器原子控制 CLI/MCP。它绑定明确的 CDP target，提供
snapshot-scoped 的导航、观察、语义元素动作、截图、控制权切换和 Browser Rep。
任务意图与步骤规划由主 Agent 完成，本包不内置 browser-use 或第二个端到端 Agent。

## 安装

公开 npm 包发布后，Coder 工程可将其作为固定版本依赖安装：

```bash
npm install --save-dev @uiwarden/dt-gui-browser@0.6.1
npx dt-gui-browser doctor
```

使用 pnpm 的等价命令：

```bash
pnpm add --save-dev @uiwarden/dt-gui-browser@0.6.1
pnpm exec dt-gui-browser doctor
```

当前仓库默认关闭 npm 发布。源码用户应在仓库根目录运行 `npm run gui:release:pack`，
然后从 `release/gui-packages/0.6.1/` 安装生成的 `.tgz` 文件；不要依赖内部 registry。

Node.js 要求 `>=20`。

## MCP

先由宿主创建 Browser session，再使用对应 session 启动 MCP。生产宿主建议使用
`--socket`，使 Agent 保持原 CLI 参数的同时复用同一 Runtime：

```bash
dt-gui-browser mcp --session <session-id> --socket /tmp/dt-gui-browser.sock
```

CLI 和 MCP 使用相同 Runtime、target lease、snapshot epoch 和产物目录。运行时只允许
loopback CDP 和精确 target，不开放任意 JavaScript 或任意 CDP 命令。

持久 MCP 进程会为当前 target 保持一个 CDP WebSocket。首次 `observe` 返回完整语义
基线，后续可使用 `observe --diff` 读取稳定元素 ID 的增量；每次观察和截图都会记录
`connectionId`、截图序号和 SHA-256。切换 target 或停止 session 会释放连接。

## 通用动作

除点击、输入、选择、滚动和导航外，Runtime 还提供：

- 组合快捷键：`key --key "Meta+A"` 或 `key --key "Control+A"`。
- 可信拖放：`drag --snapshot <id> --source <id> --target <id>`。
- 受限文件上传：`upload-file --snapshot <id> --element <id> --file <absolute-path>`。
- 下载证据：`downloads list` 返回 CDP 观察到的完成状态、建议文件名和 Rep 文件存在性。
- JavaScript 弹窗：首次普通点击返回 `DIALOG_RESPONSE_REQUIRED` 和弹窗内容并安全取消；
  观察后使用同一点击命令附加 `--dialog-action accept|dismiss`，Prompt 可额外传
  `--prompt-text`。

文件上传仅允许宿主在创建 session 时授权的 workspace，拒绝相对路径、目录、符号链接、
越界路径和超过 50 MB 的单文件。Electron 本身不实现页面 `window.prompt()`；外部
Chromium 的 Prompt 可使用上述协议，内置 Electron 浏览器可处理 alert 和 confirm。

## UIWarden 源码模式

UIWarden 本仓不从远端 registry 安装自身 Runtime。`npm run build:runtimes` 会编译
`../gui-runtime` 并复制到 `shared-runtime/`，客户端再将整个目录打入安装包。
发布包用于 DTCoder、其他 Coder 客户端、插件和独立 Agent。
