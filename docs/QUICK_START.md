# UIWarden 快速开始

本指南用于从公开源码启动 UIWarden，并完成一次可观察的 UI 操作。桌面应用控制需要安装桌面客户端；Web/Docker 模式只能使用服务器浏览器与 Mock Computer。

## 1. 环境要求

- Node.js 22.x、npm 10.x。
- macOS 打包额外需要 Xcode Command Line Tools。
- 至少一个已安装、已登录且模型可用的 Agent 执行底座。没有执行底座时仍可启动界面、查看配置并运行协议级测试，但不能完成自然语言 UI 任务。

## 2. 从源码启动

```bash
git clone <your-uiwarden-repository-url>
cd uiwarden
cp .env.example .env
npm ci
npm run dev
```

打开 `http://127.0.0.1:5174`。Vite 会把 `/api` 请求代理到本地服务；默认服务端口为 `8787`。

首次启动会在 `UI_AGENT_DATA_DIR` 下创建本地 SQLite 文件和会话目录。默认开发目录是仓库下的 `data/`，该目录已被 Git 忽略。

## 3. 配置执行底座

1. 打开“配置中心 > 执行底座”。
2. 检测本机已安装的受支持 CLI，或填写其可执行文件绝对路径。
3. 在对应 CLI/客户端中完成登录并选择可用模型。
4. 回到 UIWarden 执行连接检测；检测通过后设为当前底座。

UIWarden 不附带商业 CLI、账号、API Key 或模型额度。密钥应保存在用户自己的执行底座配置或未提交的 `.env` 中。

## 4. 完成第一个浏览器任务

1. 进入“UI 操作”，新建会话。
2. 选择“浏览器”。
3. 首次验证建议使用 Playwright 配套 Chromium。
4. 输入一个无登录、无写操作的任务，例如：`打开 https://example.com，返回页面标题。`
5. 在“执行观察”检查步骤、截图和最终结果，在“产物与诊断”查看 Browser Rep。

内置浏览器、用户浏览器桥接和外部 CDP 的适用边界见[功能使用指南](USER_GUIDE.md)。

## 5. 完成第一个电脑桌面任务

桌面任务必须使用 Electron 客户端。macOS 请先在“系统设置 > 隐私与安全性”中为 UIWarden 及其 Provider 开启辅助功能；需要截图、视觉定位或画中画时还要开启屏幕录制。

1. 进入“UI 操作”，新建会话并选择“电脑桌面”。
2. 保持“后台执行”关闭完成首次验证，避免目标应用不支持后台动作时直接停止。
3. 输入：`打开计算器，计算 1+3，并根据界面结果回答。`
4. 检查最终截图和 Native Rep，确认结果来自目标应用而不是文本推断。

## 6. 生产构建与自检

```bash
npm run typecheck
npm test
npm run build
npm run doctor:local
npm run start:local -- --production
```

生产页面默认位于 `http://127.0.0.1:8787`，健康检查为 `/api/health`。Docker、备份和升级步骤见[部署指南](DEPLOYMENT.md)。

## 常见阻塞

- **页面可打开但任务不执行**：检查执行底座是否存在、已登录且模型可用。
- **电脑桌面未授权**：完全退出 UIWarden，确认应用与 Provider 均已授权后重开。
- **浏览器观察为空**：确认选中的浏览器内核已启动，并检查 Browser Rep 中的 target 与 capture gap。
- **端口占用**：修改 `.env` 中的 `PORT`；桌面客户端端口由其本地运行时管理。
