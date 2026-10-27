# UIWarden 部署指南

## 部署形态

UIWarden 开源版支持三种运行形态：

| 形态 | 适用场景 | 能力边界 |
| --- | --- | --- |
| Electron 桌面客户端 | 完整 Browser/Computer UI 操作 | 可申请本机系统权限、使用内置浏览器和画中画 |
| 本地生产服务 | 单机 Web/API 验证 | 可使用服务器 Chromium；不能控制浏览器所在机器之外的桌面 |
| Docker | 可复现构建、Web/API 和 Mock 验证 | 无宿主机 macOS Accessibility/Windows UI Automation |

开源服务没有面向公网的多租户认证和权限系统。默认必须监听 loopback；需要远程访问时，应在受控网络中增加发行方自己的认证反向代理和 TLS。

## 本地生产模式

```bash
cp .env.example .env
npm ci
npm run build
npm run doctor:local
npm run start:local -- --production
```

关键环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；公开版不建议改为全网卡 |
| `PORT` | `8787` | HTTP 端口 |
| `UI_AGENT_DATA_DIR` | `./data` | SQLite、会话和产物根目录 |
| `UI_AGENT_DB_MODE` | `sqlite` | 开源版只接受 `sqlite` |
| `UI_AGENT_DB_FILE` | `<data>/ui-agent-chat.db` | 可选 SQLite 文件位置 |
| `UI_AGENT_ALLOWED_ORIGINS` | 空 | 额外允许的精确 Origin 列表 |
| `UI_AGENT_SERVER_MANAGED_BROWSER` | `true` | 启用服务器托管 Chromium |

环境变量完整模板见根目录 `.env.example`。不要把填有凭据的 `.env` 放入镜像或提交到 Git。

## Docker

```bash
docker build -t uiwarden:local .
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -v uiwarden-data:/data/ui-agent-chat \
  uiwarden:local
curl -fsS http://127.0.0.1:8787/api/health
```

镜像构建需要访问公开软件源；运行阶段不再执行依赖安装或浏览器下载。企业环境可通过 Dockerfile 已声明的 build args 替换为经过审核的公共镜像源，但不得把源凭据写进构建参数、镜像层或日志。

## 数据库与文件存储

公开版没有 MySQL、PostgreSQL、Redis、对象存储或云数据库依赖。所有结构化状态保存在一个本地 SQLite 文件中，大体积证据保存在 `UI_AGENT_DATA_DIR` 下的会话目录。

备份时应先停止 UIWarden，再复制整个数据目录，而不是只复制 `.db` 文件：

```bash
DATA_DIR="${UI_AGENT_DATA_DIR:-./data}"
tar -czf uiwarden-data-backup.tgz -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
```

恢复时保持应用停止，使用同一 UIWarden 版本先验证数据，再执行升级。会话产物可能包含截图、登录态、页面内容和模型输出，备份应按敏感数据保护。

## 升级与回滚

1. 停止任务并退出应用。
2. 备份完整数据目录。
3. 阅读 `CHANGELOG.md` 的数据或协议变更说明。
4. 安装新版本并先执行健康检查和一个无副作用任务。
5. 回滚应用版本前恢复对应备份；不要让旧版本直接写入已被新版本迁移的数据文件。

覆盖安装 macOS `.app` 通常不会删除 `~/Library/Application Support/UIWarden/data`，但卸载工具或手工清理可能删除该目录。

## 健康检查与日志

- HTTP 健康检查：`GET /api/health`。
- 源码运行日志：启动服务的终端输出。
- 桌面运行数据：`~/Library/Application Support/UIWarden/data`。
- 单次问题优先导出对应会话或评测的诊断包，不要直接共享完整数据目录。

## 安全检查清单

- 服务只监听 `127.0.0.1`，或位于带认证和 TLS 的受控代理之后。
- `.env`、SQLite、会话目录、浏览器 Profile 和诊断包均未提交到 Git。
- 执行底座使用最小权限账号，模型密钥不写入评测集或 Prompt。
- 桌面系统权限只授予实际安装的 UIWarden 与 Provider。
- 发布前执行 `npm run check:open-source-index` 和 `npm run check:open-source-history`。
- 对外 DMG/安装包使用发布者自己的代码签名、公证和第三方许可审查。
