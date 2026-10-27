# Windows UI Automation Provider

本目录实现基于 .NET 8 `System.Windows.Automation` 的独立 Provider。它通过一次性请求/响应文件与 TypeScript `dt-gui-computer` Runtime 通信，支持 `probe`、`listApps`、`observe` 与 `perform`。

```powershell
native-automation/scripts/build-windows-provider.ps1
```

实现约束：

- 以当前用户和 `asInvoker` 完整性级别运行，不请求管理员权限。
- 目标进程若以更高完整性级别运行，UI Automation 读取或动作可能被 UIPI 拒绝。
- 密码字段只返回 `[REDACTED]`，输入动作强制人工接管。
- 元素动作绑定观察快照中的 UIA 路径与元素指纹，树变化后返回 `STALE_SNAPSHOT`。
- 当前不采集截图；Native Rep 会记录 `windows-provider-no-screenshot` 采集缺口。

本轮完成源码与桌面打包接线，真实 UIA Tree、UIPI 与安装包验收暂缓到 Windows x64/arm64 环境执行。
