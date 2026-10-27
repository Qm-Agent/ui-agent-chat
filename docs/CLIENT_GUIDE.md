# UIWarden 桌面客户端指南

## 适用范围

开源版以单机桌面客户端为主要交付形态：

- Electron 启动本机 UI 和仅监听 `127.0.0.1` 的服务。
- SQLite 保存配置、会话索引和任务状态。
- 会话目录保存上传文件、截图、Trace、Browser Rep、Native Rep 和评测报告。
- 用户自行安装、认证并配置 AiWork CLI、Codex、Claude Code 或其他受支持执行底座。

云端多租户、统一登录、组织权限、远程节点、集中数据库和对象存储不包含在开源版中，属于增值能力。

## 系统要求

### 源码构建

- Node.js 22.x 与 npm 10.x。
- macOS 客户端打包需要 Xcode Command Line Tools。
- UI 测试 Skill 使用桌面安装包内的平台专属 Python 3.11、经过审核的 browser-use 3.1.6 SDK 与锁定依赖，以及 Playwright 1.58.0 Chromium 和 Firefox。正式安装包运行时不访问 PyPI 或 Playwright CDN；系统 Python 只用于源码开发或旧安装包兼容。
- browser-use 的完整锁定依赖只在发布构建阶段由 pip 解析并写入平台 Runtime；终端用户安装和执行时不运行 pip，也不需要准备 wheelhouse 或访问 Python/Playwright 下载源。
- Agent 任务需要至少一个已登录的外部执行底座；仅浏览页面和 Mock 协议测试不需要模型。

### macOS 权限

在“系统设置 > 隐私与安全性”中按实际能力开启：

1. **辅助功能**：允许 `UIWarden` 和 `dt-gui-computer Provider` 读取 AX Tree、点击、输入和切换窗口。
2. **屏幕录制**：用于窗口截图、视觉定位、动作校验和连续画中画。
3. 权限修改后回到 UIWarden 重新检测；系统未刷新时完全退出并重开客户端。

权限只授予本机进程。桌面控制仍可能与用户鼠标、键盘和前台焦点冲突；后台执行不受目标应用支持时会明确停止，不会静默降级。

## 安装与首次使用

1. 把 `UIWarden.app` 拖入“应用程序”。
2. 首次启动后，在“配置中心 > 执行底座”检测并选择本机执行底座。UIWarden 可识别 `aiwork`、`aiworkcn` 和 `aiworkcli`，也可通过 `UI_AGENT_AIWORK_BIN` 指定用户自行安装的 CLI。
3. 在对应客户端完成登录和模型选择。UIWarden 不内置商业执行底座及其凭据。
4. 在“UI 操作”新建会话，选择“浏览器”或“电脑桌面”。
5. 电脑桌面任务先完成权限检测；浏览器任务可选 Playwright、内置浏览器、桥接用户浏览器或外部 CDP。

## 本地数据

macOS 默认数据目录：

```text
~/Library/Application Support/UIWarden/data
```

其中包含 SQLite 数据库、会话目录、评测报告和诊断证据。重新安装应用通常不会删除该目录；删除目录或系统清理应用数据会丢失历史。诊断包可能含敏感页面内容，分享前必须检查并脱敏。

公开版不连接外部数据库或对象存储。可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UI_AGENT_DATA_DIR` | `./data` | 本地数据根目录 |
| `UI_AGENT_DB_FILE` | `<data>/ui-agent-chat.db` | SQLite 文件 |
| `UI_AGENT_DEFAULT_EXECUTION_RUNTIME` | `dtcoder` | 新安装的默认执行底座 |
| `UI_AGENT_AIWORK_BIN` | 自动检测 | 指定 AiWork 可执行文件的绝对路径 |
| `UI_AGENT_DTCODER_BIN` | 自动检测 | `UI_AGENT_AIWORK_BIN` 的旧版兼容别名 |
| `UIWARDEN_DEFECT_PROVIDER` | `none` | 可选缺陷平台 Provider；公开版本默认不启用任何平台 |
| `UI_TEST_PYTHON` | 自动检测 | UI 测试 Skill 的 Python |
| `UI_AGENT_DESKTOP_API_PORT` | `8797` | 桌面本地服务端口 |

密钥只应写入未纳入 Git 的 `.env` 或客户端配置，不得写入源码、评测集或 Issue。

### UI 测试视觉模型

`ui-test-assistant-skill` 通过 OpenAI-compatible Chat Completions 调用视觉模型。公开模板使用以下字段：

| 变量 | 说明 |
| --- | --- |
| `BU_OPENAI_API_BASE` | OpenAI-compatible `/v1` 基础地址 |
| `BU_OPENAI_API_KEY` | 用户自己的 API Key |
| `BU_MODEL_BOX_FORMAT` | 视觉坐标顺序，Qwen 默认 `ltrb`，也可设为 `tlbr` |
| `BU_ACTOR_MODEL` 等 | Actor、Planner、Asserter 与辅助角色的实际模型 ID |

阿里云百炼应使用 API Key 页面展示的 Workspace 专属 OpenAI-compatible 地址，例如 `https://<workspace-host>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，并确保 Key 与 Workspace 匹配。公开模板默认模型为 `qwen3.7-plus`，也支持填写平台实际开放的其他视觉模型名。保存配置前建议先执行同一模型的图片输入联通测试；仅文本调用成功不足以证明 UI 自动化可用。

### 缺陷平台扩展

开源客户端默认不选择任何缺陷平台。缺陷闭环通过服务端能力接口按 Provider 启用，默认返回未启用；质量看板和任务操作会据此隐藏创建缺陷入口。Jira、禅道等外部平台尚未内置，二次开发时应实现独立 Provider 适配器，并复用统一的创建、附件、用户解析和 Evidence Bundle 能力声明，不应把平台字段写死到通用质量模型中。

## 源码验证

从干净克隆开始执行：

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run test:open-source-index
npm run test:open-source-builder
npm run test:open-source-desktop
npm run build
```

本地服务无副作用预检：

```bash
npm run doctor:local
npm run start:local -- --production
```

`doctor:local` 不打印 `.env` 的值，也不替用户登录或发起计费请求。

### Docker 外部环境验收

```bash
docker build -t uiwarden:local .
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v uiwarden-data:/data/ui-agent-chat \
  uiwarden:local
curl -fsS http://127.0.0.1:8787/api/health
```

镜像内包含 Node 服务、SQLite、审核后的 browser-use wheel、Python 虚拟环境、Playwright Chromium、三个 Skill 和 Browser/Computer Runtime。Docker 只能提供服务器 Chromium 与 Mock Computer；宿主机真实桌面控制、画中画、浏览器桥接和系统权限检测属于 Electron 客户端能力。不要使用 `-p 8787:8787` 把本地 API 暴露到不可信网络，除非发行方另行增加完整认证和访问控制。

首次镜像构建需要公网软件源，镜像运行不再下载安装依赖。`APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`、`PLAYWRIGHT_DOWNLOAD_HOST` 和 `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` 都可在构建时指向发行方审核过的公开镜像；这些参数不能携带凭据并写入公开构建日志。

客户端不包含 AiWork 下载地址或安装器，也不会在检测阶段联网安装商业执行底座。用户应通过供应方公开文档自行安装，然后重新检测；非标准路径可设置 `UI_AGENT_AIWORK_BIN`。

## macOS 未签名打包

```bash
npm --prefix desktop ci
UIWARDEN_OPEN_SOURCE_BUILD=true \
CSC_IDENTITY_AUTO_DISCOVERY=false \
npm --prefix desktop run pack:mac
```

输出位于 `desktop/release/`。打包过程会：

- 重建前后端和两个 TypeScript Runtime。
- 编译 macOS Accessibility Provider。
- 把三个 Skill 从 `skills/` 复制到脱敏暂存目录。
- 排除 `.env`、日志、私有上下文、执行产物、符号链接和填充凭据的示例文件。
- 内置与 `better-sqlite3` ABI 匹配的 Node Runtime。
- 校验 DMG 内的应用、Applications 链接、许可证和关键资源。

本地未签名构建使用系统 `hdiutil` 生成标准拖拽安装 DMG，不依赖额外的 DMG 下载工具；生产发行仍可在发布流水线替换为已签名、公证和品牌化的安装镜像。

未签名包可能被 Gatekeeper 阻止，只适合本机开发测试。正式发布者必须使用自己的 Apple Developer 身份完成签名与公证。

## browser-use SDK

`ui-test-assistant-skill` 使用仓库 `vendor/browser-use/` 下的审核 wheel，不修改外部 browser-use 仓库。构建会校验版本、许可证和可选 SHA-256。运行测试任务还需要用户自己的视觉模型配置；模板不含可用密钥。

桌面发布构建会执行 `npm run prepare:ui-test-runtime`，按当前操作系统和 CPU 架构下载固定 SHA-256 的 CPython 3.11.17，按照 `vendor/ui-test-runtime/constraints.txt` 安装依赖，并把 Playwright Chromium、Firefox 安装到随包目录。构建和 DMG 验收都会实际启动两种浏览器。macOS arm64、macOS x64 与 Windows x64 必须分别在对应架构主机上构建，不能交叉复用 Runtime。

## 安全边界

- 本地 API 没有面向公网的统一认证，只能监听 loopback。
- 不创建 SSH 反向代理或反向隧道。
- Host 管理会修改指定 hosts 文件，按最小权限运行。
- 浏览器登录态、桌面截图、对话与产物都属于用户本地敏感数据。
- 公开发布前应执行索引/历史检查，并只发布净化分支或 `export:open-source-snapshot` 生成的无历史快照。

## 常见问题

**客户端能启动但任务不能执行**
先在配置中心确认执行底座存在、已登录且模型可用。底座自报模型名称不应作为路由证据，以 UIWarden 记录的 provider/model 和底座日志为准。

**电脑桌面显示未授权**
确认应用与 Provider 都在系统权限列表中，切换权限后完全退出重开。不要通过关闭安全校验绕过系统授权。

**内置浏览器不可用**
检查本地端口是否被占用、客户端资源是否完整，并查看会话 Browser Rep。桥接用户浏览器需要安装并配对随包提供的浏览器扩展。

**重新安装会丢数据吗**
覆盖安装通常保留 Application Support 数据；手工删除数据目录、使用清理工具或更换系统用户会丢失。升级前可备份整个 UIWarden 数据目录。
