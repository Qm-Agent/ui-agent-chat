# Native Desktop Automation 测试用例

| ID | 优先级 | 场景 | 预期 | 结果 |
|---|---|---|---|---|
| CUA-001 | P0 | `doctor/capabilities` | 输出协议版本、provider 和可用能力 | PASS |
| CUA-002 | P0 | Mock 会话 observe -> set-value -> observe | 新快照反映输入值，旧快照不可复用 | PASS |
| CUA-003 | P0 | 点击删除按钮 | 首次返回 `APPROVAL_REQUIRED`，授权挑战后才执行 | PASS |
| CUA-004 | P0 | 两个写会话竞争 lease | 第二个会话返回 `DESKTOP_BUSY` | PASS |
| CUA-005 | P0 | stop 会话 | Native Rep 含 manifest、events 和 stop reason | PASS |
| CUA-006 | P0 | MCP `tools/list`/`tools/call` | 与 CLI 返回契约一致 | PASS |
| CUA-007 | P0 | macOS probe/list-apps/observe | 返回真实 TCC 状态和运行应用；未授权时拒绝 observe | PARTIAL：拒绝链路已验证，授权后观察待补 |
| CUA-008 | P0 | Web 请求 native status | 返回 403 | PASS |
| CUA-009 | P1 | 安全字段观察与输入 | 值被脱敏且输入动作被拒绝或移交用户 | PASS |
| CUA-010 | P1 | 损坏会话文件 | 保护原文件并返回结构化错误，不覆盖 | PASS |
