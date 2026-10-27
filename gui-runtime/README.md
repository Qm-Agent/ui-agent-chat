# @uiwarden/dt-gui-runtime

`dt-gui-browser` 与 `dt-gui-computer` 的共享 TypeScript 基础库，提供：

- CLI 参数解析和统一 JSON 输出；
- `GuiAutomationError` 错误 envelope；
- MCP stdio JSON-RPC 的初始化、工具枚举和工具调用；
- 原子 JSON 文件、JSONL 事件流和损坏存储保护。

它不包含浏览器 CDP、macOS Accessibility、Windows UI Automation、Agent、模型或
Skill。业务 Runtime 应在自己的 Provider 和 session 层之上复用本包。

## 安装

```bash
npm install @uiwarden/dt-gui-runtime@0.6.1
# or: pnpm add @uiwarden/dt-gui-runtime@0.6.1
```

```ts
import {
  GuiAutomationError,
  atomicWriteJson,
  parseCliArguments,
  runMcpJsonLines
} from "@uiwarden/dt-gui-runtime";
```

Node.js 要求 `>=18`。该包使用 DT GUI Agent 统一 release train，当前 Runtime
协议版本由 `dt-gui-browser` 和 `dt-gui-computer` 分别声明。
