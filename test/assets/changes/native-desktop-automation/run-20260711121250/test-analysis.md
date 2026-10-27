# Native Desktop Automation 测分

## P0 需求

1. CLI 能以稳定 JSON 契约完成 provider 探测、应用发现、会话、观察和原子动作。
2. 元素引用绑定快照；旧快照操作快速失败，禁止误操作。
3. 高风险动作生成审批挑战，未授权不能执行。
4. Mock Provider 可完成确定性端到端动作并生成本地 Native Rep。
5. macOS Provider 独立于 UIWarden 主进程，能够返回真实权限和应用状态。
6. Web 模式不能访问本机自动化；桌面模式只暴露受限探测接口。

## P1 需求

1. MCP stdio 与 CLI 复用同一 dispatch，不复制业务逻辑。
2. 一个真实桌面只允许一个写 lease，观察能力可以安全查询。
3. 安全输入和密码字段不进入产物明文。
4. 协议具备 capability negotiation，Windows Provider 可按同一契约实现。

## 风险

- macOS TCC 授权与进程签名绑定，开发态 helper 可能只有 denied 状态。
- Windows 实机不可用，只能做 Schema 和平台边界审计。
- Accessibility Tree 在自绘 UI、游戏和部分 Electron Canvas 中不完整，必须保留截图/坐标降级能力但不能静默降级。

