# Native Desktop Automation Agent-in-Loop 测试方案

## 范围

- 版本化原生桌面自动化协议与 JSON Schema。
- 原子 CLI、MCP stdio、会话 lease、快照过期保护和审批挑战。
- Mock Provider 的确定性动作与 Native Rep。
- macOS Accessibility Provider 的权限探测、应用发现和只读观察。
- UIWarden 桌面服务的只读能力探测；Web 模式必须拒绝本机能力。

## 非范围

- Windows 实机动作验证：当前环境没有 Windows 和 .NET 运行时。
- macOS 高风险真实动作：不在开发机上执行删除、发送、支付或系统设置变更。
- 录制回放生成 Skill：本轮只冻结产物与扩展协议。

## 分层

| 层级 | 验证内容 |
|---|---|
| L1 | Schema、Rust/Swift/TypeScript 编译和单元测试 |
| L2 | CLI 命令、JSON 错误、MCP tools/list 与 tools/call |
| L3 | Mock Provider 完整会话、人工审批、Native Rep |
| L4 | macOS 权限/应用/观察、UIWarden 桌面探测和 Web 隔离 |
| L5 | 并发 lease、过期快照、敏感字段脱敏、进程退出恢复 |

