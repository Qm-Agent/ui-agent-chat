# UIWarden 版本说明

本文件记录开源基线及其后的公开版本。每次向用户交付新的安装包都必须使用新版本号，并记录用户可见变化、数据或协议影响、验证结果和已知限制。

## 0.12.5 - 2026-10-27

- 公开版移除专有缺陷平台实现、配置页面、路由和测试，仅保留可注册的通用 Defect Provider 契约。
- browser-use 模型配置统一为 `BU_OPENAI_API_BASE`、`BU_OPENAI_API_KEY` 与可配置视觉模型名，支持公开 OpenAI-compatible 服务。
- 清理内部模型网关兼容变量、历史技能记录和执行样例，补齐快速开始、功能使用、部署与客户端构建文档。
- 升级并固化 browser-use 3.1.6 wheel 的来源、MIT 许可、哈希校验与 Runtime 构建路径；公开模型默认改为 `qwen3.7-plus`。
- Docker 公开构建增加可配置的 pip 重试、读超时和 Playwright 下载超时，降低普通外网下载大 wheel 或浏览器时的偶发失败。
- 桌面 Runtime 构建对 GitHub Release 与 Python 官方文件源使用直连回退，避免本机代理导致便携 Python 和 bootstrap wheel 长时间无进展。
- 锁定公开 Runtime 的完整 Python 依赖闭包，并升级上传、请求解析和前端构建依赖，生产依赖审计无已知漏洞。
- GUI Runtime 包统一使用公开命名空间 `@uiwarden/*` 和 npm/pnpm 工作流，移除内部包管理器与内部 scope 引用。
- 验证 Node 22 类型检查、218 个单元测试、公开源码索引、桌面资源净化和 Python Runtime 补丁测试。

### 验证与安装包

- macOS arm64 安装包：`UIWarden-0.12.5-arm64.dmg`、`UIWarden-0.12.5-arm64.zip`。
- 已验证 Docker arm64 公开构建、容器健康检查、SQLite 初始化、`pip check`、生产依赖审计和包内 Chromium 启动。
- 已验证 macOS arm64 DMG checksum、Finder 安装布局、应用深度签名、随包 Server、Node/SQLite ABI、Python 3.11.17、browser-use 3.1.6、Playwright Chromium/Firefox、画中画和内置浏览器预览。

### 已知限制

- 当前 macOS 包仅使用本地 ad-hoc 签名，未进行 Apple Developer ID 签名与公证，不可直接作为面向公众的正式分发包。
- 本轮未执行 macOS x64、Windows 安装包和外部在线模型端到端验收。
- browser-use wheel 随包再分发前仍需发布方完成许可证与分发合规确认。

## 0.12.4 - 2026-10-15

- 桌面发布包新增平台专属 UI 测试 Runtime：内置可重定位 CPython 3.11.17、browser-use 3.1.5 及锁定依赖、Playwright 1.58.0 Chromium 与 Firefox。
- 安装和任务执行不再依赖终端用户的 Python、PyPI 或 Playwright CDN。
- macOS arm64、macOS x64 与 Windows x64 使用各自的平台 Runtime，不能跨架构复用。
- 发布打包和 DMG 验收会导入 browser-use，并实际启动随包 Chromium 与 Firefox。

## 0.12.3 - 2026-10-15

- 缺陷闭环改为能力驱动，公开版默认不启用任何缺陷平台，并为外部 Provider 预留统一边界。
- 执行底座统一通过可检测的外部 CLI 适配；公开包不内置商业 CLI、账号、下载地址或凭据。
- 修复公开版 macOS 本地构建的应用资源封装与 ad-hoc 签名检查。
- DMG 验收增加应用 bundle 完整性检查。

## 0.12.2 - 2026-10-15

- 修复 macOS 安装镜像 Finder 布局异常、图标错位和 Applications 占位图标空白问题。
- 安装镜像改为固定窗口、图标视图、图标尺寸和拖拽方向后再生成只读 DMG。
- 安装包验收增加 Finder 布局检查。

## 0.12.1 - 2026-10-14

- 桌面安装包内置经过审核并固定哈希的 browser-use 3.1.5 SDK wheel。
- 依赖修复改为安装本地 wheel，不再在终端用户机器上下载 Python 包。
- 修复测试、浏览器和电脑桌面 Skill 的打包资源路径注入。

## 0.12.0 - 2026-10-14

### 开源客户端基线

- 源码结构统一为 `skills/` 与 `test/`，移除私有 Agent 配置、临时文件、内部研究文档和执行产物。
- 开源版收敛为桌面客户端、本地 SQLite 与本地文件存储，不依赖中心数据库或对象存储。
- README 和客户端指南采用桌面优先定位，明确云端多租户能力不在开源发行范围内。
- 增加公开索引、历史、构建输入、桌面资源和无历史快照检查。

### 验证

- Node 22 干净依赖安装、TypeScript 类型检查、单元测试和生产构建通过。
- 本地 Server 健康检查、SQLite 初始化、开源索引与桌面资源脱敏检查通过。
- 未签名 macOS 安装包仅用于本机开发验证；公开分发需使用发行方自己的签名与公证。
