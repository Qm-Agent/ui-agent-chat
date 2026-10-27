# UIWarden

UIWarden 是一个桌面优先的 UI 自动化测试与通用 UI 操作客户端。主 Agent 负责理解和规划任务，通过原子化的 `dt-gui-browser` 与 `dt-gui-computer` Runtime 操作浏览器或本机应用，并把截图、事件、日志和报告保存在本机。

## 主要能力

- 测试任务、UI 操作、巡检、回归和评测实验室。
- Playwright Chromium、UIWarden 内置浏览器、浏览器桥接与外部 CDP。
- macOS Accessibility 原生应用操作，以及 Mock/Windows Provider 协议。
- 会话停止、人工接管、画中画、执行观察和结构化 Rep 产物。
- 桌面包内置平台专属 Python 3.11 Runtime、经过审核的 browser-use 3.1.6 SDK 及锁定依赖、Playwright 1.58.0 Chromium 与 Firefox；安装和运行测试任务不再访问 PyPI 或 Playwright CDN。
- 评测集导入、单例/断点重跑、LLM 结果评审和诊断包导出。
- 本地 SQLite 与文件存储；模型密钥、浏览器 Profile 和执行证据不上传到 UIWarden 服务。

## 源码结构

| 目录 | 内容 |
| --- | --- |
| `client/`、`server/` | React 客户端页面与本地服务 |
| `desktop/`、`gui-computer/` | Electron 客户端与独立浏览器 |
| `browser-automation/` | `dt-gui-browser` 原子 Runtime |
| `native-automation/` | `dt-gui-computer` 原子 Runtime 与 Provider |
| `gui-runtime/` | Browser/Computer 共享 TypeScript 协议 |
| `skills/` | UI 测试、浏览器和电脑桌面 Skill |
| `test/` | 单元测试、脚本、数据、资产与可复现 Fixture |
| `docs/` | 快速开始、功能使用、部署运维与桌面客户端构建说明 |

## 文档

- [快速开始](docs/QUICK_START.md)：从源码启动，并完成第一个 Browser/Computer 任务。
- [功能使用](docs/USER_GUIDE.md)：执行底座、浏览器模式、电脑桌面、评测与本地数据。
- [部署指南](docs/DEPLOYMENT.md)：Docker、本地生产模式、数据备份、升级和安全边界。
- [桌面客户端指南](docs/CLIENT_GUIDE.md)：macOS 权限、源码验证、打包和发布要求。

## 本地开发

要求 Node.js 22 和 npm 10。真实 Agent 任务还需要用户自行安装并登录一个受支持的执行底座；公开仓库不捆绑商业 CLI、账号或模型凭据。首次使用建议直接按[快速开始](docs/QUICK_START.md)操作。

```bash
cp .env.example .env
npm ci
npm run build
npm test
npm run dev
```

开发页面为 `http://127.0.0.1:5174`。本地生产模式可运行 `npm run start:local -- --production`。

## Docker 启动

Docker 适合验证 Web、本地 API、SQLite、服务器托管 Chromium、Browser Runtime 与 Mock Computer 协议。容器不能直接获得宿主机的 macOS Accessibility 或 Windows UI Automation 权限；真实桌面应用操作请使用对应平台的 UIWarden 客户端。

```bash
docker build -t uiwarden:local .
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v uiwarden-data:/data/ui-agent-chat \
  uiwarden:local
```

打开 `http://127.0.0.1:8787`，健康检查为 `http://127.0.0.1:8787/api/health`。默认只映射到 loopback，不应把未配置统一认证的本地 API 直接暴露到公网。

首次构建需要访问 Docker Hub、Debian、npm、PyPI 与 Playwright CDN。网络较慢时可通过公开镜像参数覆盖软件源，例如：

```bash
docker build \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org/ \
  --build-arg PIP_INDEX_URL=https://pypi.org/simple/ \
  --build-arg PIP_DEFAULT_TIMEOUT=180 \
  --build-arg PIP_RETRIES=10 \
  -t uiwarden:local .
```

`PIP_DEFAULT_TIMEOUT`、`PIP_RETRIES` 与 `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT`
只控制构建阶段的公开依赖下载容错，不会写入用户凭据或改变运行时网络行为。

运行时不执行 `npm install`、`pip install` 或浏览器下载。Agent 任务仍需用户自己的执行底座、账号和模型配置。

## 桌面打包

```bash
npm --prefix desktop ci
UIWARDEN_OPEN_SOURCE_BUILD=true \
CSC_IDENTITY_AUTO_DISCOVERY=false \
npm --prefix desktop run pack:mac
```

未签名 DMG 仅用于本机开发验证。对外分发需要开发者自己的签名、公证和第三方许可审查。完整步骤、系统权限和数据位置见[客户端指南](docs/CLIENT_GUIDE.md)，服务器部署见[部署指南](docs/DEPLOYMENT.md)。

## 开源边界

本仓库提供单机客户端和本地服务。多用户认证、组织级权限、远程执行节点、集中存储、托管模型网关和云端运维属于增值云端能力，不在开源发行物中。

公开版本默认不启用任何缺陷管理平台。服务端只保留通用能力边界；后续可按该边界实现 Jira、禅道等适配器，并由发行方显式注册，未注册的 Provider 按能力缺失处理。

本地服务默认只监听 loopback，不能直接暴露到公网。提交 Issue 前请移除账号、模型密钥、浏览器 Profile、截图、会话文件夹和业务数据。安全说明见 [SECURITY.md](SECURITY.md)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

UIWarden 使用 [Apache License 2.0](LICENSE)。内置 browser-use SDK 的上游 MIT 声明保存在 [LICENSES/browser-use-MIT.txt](LICENSES/browser-use-MIT.txt)。
