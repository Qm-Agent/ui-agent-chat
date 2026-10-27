---
name: ui-test-assistant-skill
version: 2.5.0
type: e2etest
author: UIWarden Contributors
description: 基于 browser-use==3.1.6。支持 **快速测试模式**（quick 单任务 / md xlsx csv tsv 批量用例集合 / 需求或测分文档拆解执行）、**普通探索**（单 URL 单轮生成）与**深度/遍历探索**（实现位于 **`package/recursive_exploration`** + **`package/scripts/run_recursive_exploration.py`**）。另有 **package/task_mode**、**package/graph_retrieval**、**package/graph_analysis** 等与 SKILL 任务/图谱叙事对齐。**修复自愈**见 **`package/scripts/run_yaml_repair.py`**。模型凭据由用户配置，不随源码内置。
---

# UI Test Assistant Skill

本技能的操作链路分为六类（用户可同时触发其中一类为主流程）：

| 链路 | 含义 |
|------|------|
| **快速测试模式** | browser-use `quick` 一句话任务；或将 `.md` / `.xlsx` / `.csv` / `.tsv` 测试用例集合逐条改写为 quick query 后串行执行；若快速模式输入是需求文档或测分文档，则先拆解为测试用例再逐条 quick。另支持 **冒烟验证 / 前端走查** 与 **页面巡检 / 探活** 意图：冒烟会盘点可见一级主模块并做核心前端可用性检查；巡检只确认入口页可访问、正常渲染和完成基本加载。支持固定上下文目录与可选参考资料，失败后用 `observe` 获取当前页面状态并生成独立 retry query 后 `quick --resume` |
| **普通探索模式** | **单入口 URL** → `CaseGeneratorAgent`（**一轮**页面分析 + 批量 YAML）；**不**运行 `run_recursive_exploration.py`，**不包含**递归多锚点、多 URL 发现队列与意图批量子任务 |
| **深度 / 遍历探索模式** | **`package/scripts/run_recursive_exploration.py`**：在同一技能语义下须走完 **① 单步首轮入队 → ② 单步成功后队列扩增（DOM 新暴露操作入队，≠ composite / graph_guided 播种）→ ③ 意图任务（intent_mission，默认 late 规划；默认 hybrid：原 YAML Agent 失败后 quick fallback）**；受单锚预算、`max_total_actions`、去重等约束；用户未要求中止时 **禁止擅自中断**，误中断后用 **`--resume-session`** 接续 |
| **任务模式** | 自然语言步骤、模块叙事或需求/在线文档 → **生成用例再执行**（与「仅执行已有 YAML」区分） |
| **用例执行模式** | 用户给出 **已有 `.yaml` 路径**，只做 **`browser_use.cli --task-file`**（无生成）；日志落在 `exploration/logs/` 或 `task/logs/` 按语境 |
| **修复自愈模式** | **`package/scripts/run_yaml_repair.py`**：失败用例迭代修复与报告 |

用户**未指定**其他输出根时，产物落在 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/`**。**快速测试** → **`quick/`**；**探索相关** → **`exploration/`**；**任务相关** → **`task/`**；**修复自愈** → **`repair/`**。`<RUN_TS>/` 根仅放 **`execution.log`**（或 `execution.md`）。

**源码与脚本**：探索/图谱/任务相关 Python 包位于 **`package/`**（含 **`recursive_exploration`**、**`graph_retrieval`**、**`graph_analysis`**、**`task_mode`**）；CLI 入口在 **`package/scripts/`**。技能根下 **`scripts/`** 为转发桩；详见 **`package/README.md`**。

**文档自含**：本 Skill 所需说明均在 **SKILL.md** 与 **references/** 下。客户端使用随包提供的 browser-use 3.1.6 Runtime；源码环境通过 `npm run prepare:ui-test-runtime` 从仓库内固定哈希 wheel 构建，不依赖公网同名包。

## 配置来源约束（Agent 必读）

执行 quick / 探索 / 任务前，被测 **URL**（包含所需 query 参数）、**登录账号**、**辅助资料路径** 等**仅允许**来自以下来源：

| 来源 | 说明 |
|------|------|
| **用户当次 query / 对话** | 用户本条消息中的 URL、步骤、显式给出的文件路径 |
| **`{技能根}/config/.env`** | 如 **`QUICK_URL`**（完整入口 URL，与 browser-use 一致，query 参数直接写在 URL 中）、`QUICK_MAX_STEPS`、`QUICK_MAX_RETRIES`、`QUICK_NAME` / `QUICK_USERNAME` / `QUICK_PASSWORD`、`BU_LOCAL_BROWSER_CDP_URL`、`USERNAME` / `PASSWORD` 等（见 **`config/.env.example`**） |
| **`{技能根}/config/upload_files/`** | UI 上传测试文件目录。用户可把需上传的样例文件放在此目录，并在当次 query / 用例中显式写出完整文件路径；若用户只要求验证上传流程但未指定文件，Agent 可在该目录内按页面提示/可接受类型自主选择内置样例文件 |

**禁止（违反须停止执行并向用户说明，不得静默借用）**：

- 搜索或读取工作区**其他项目**的配置来补全信息，例如 `dt-knowledge-test/**/.env`、`ui-agent-test/**`、任意 `**/application-*.properties`、其他仓库 YAML 内嵌的 `${kengwebUrl}` / `projectId` / `botId`
- 未经用户**当次明确指定**，将其他项目 YAML/文档作为 `--context` 或任务模式参考资料
- 未经用户**当次明确指定文件路径或上传验证意图**，自动从 `config/upload_files/` 或其它目录挑选文件上传；若用户明确要测上传但未指定文件，只能从 `config/upload_files/` 内置样例中选择，不得扫描其它目录
- 在对话或命令中「猜测」URL、租户 ID、账号并擅自写入
- 从 **`.skill-output` 历史产物**、白皮书中的「探索环境」域名、过往 `quick_task_*.yaml` / `execution.log` 等**自行推断**入口 URL 并执行

**缺失时**：**不得启动** `run_quick_mode.py`、`browser_use.cli` 或探索脚本；向用户列出缺少项（URL / 账号 / 密码等）及合法配置方式，请用户补充后**再执行**。`run_quick_mode.py` 会在执行前预检，缺 URL / 登录凭据 / 非法 `--context` 时 **exit 3** 并打印完整配置指引，**不得**改从历史记录或其它项目补全后再跑。

**⚠️ 强制行为规则（凭据与执行）**：

- **MUST 直接执行，不停下来问确认**：用户提供了 URL + 凭据时，Agent **必须立即**构造并执行 `run_quick_mode.py` 命令，**不得**停下来问"是否确认配置"、"是否可以继续"等确认问题
- **MUST 用 `--username` / `--password` 传凭据**：用户在对话中提供了账号密码（如「账号/密码：mingxiong / mingxiong1023」），Agent **必须**在命令中加 `--username <账号> --password <密码>`，**不得**要求用户手动编辑 .env。`run_quick_mode.py` 会将值写入 USERNAME、QUICK_NAME、PASSWORD 等环境变量供 browser-use 自动登录
- **MUST 用 `--no-login` 跳过公开页面凭据检查**：用户说「不需要登录」「公开页面」时，Agent **必须**加 `--no-login`，**不得**因 .env 缺少 USERNAME/PASSWORD 而阻断执行。`run_quick_mode.py` 已内置意图推断，文本包含「不需要登录」「无需登录」「免登录」「公开页面/站点」等关键词时自动跳过凭据预检
- **NEVER 因缺少 .env 凭据而停止**：当用户已在对话中提供了凭据时，**禁止**停下来提示"缺少登录凭据配置"或"请先配置 .env"
- **NEVER 要求用户手动编辑 .env 传入凭据**：`--username` / `--password` 已实现凭据传递，**禁止**引导用户去编辑 config/.env 文件
- **NEVER 反复问确认**：用户提供 URL + 凭据后，**禁止**问"是否确认配置"、"是否可以继续执行"等问题，直接执行即可

**上下文规则**：quick 不得主动扫描 `.skill-output`、历史日志或任意 README 作为上下文。页面特性注入只来自 **`config/prompt_context/`**，但默认只注入 **`global_readme.md`**；该目录下其它特定业务文件只有在用户当次 query / `--user-query` / `--task-prefix` 明确提到文件名、stem 或完整路径时才注入。失败修复参考只来自 **`config/perference_context/`**，或在该目录为空时来自用户当次明确给出的 `--context`。`--context` 仅当路径在用户 query 中出现，或位于**本技能包目录内**（如 `references/`）时方可传入；其他项目路径若未在用户消息中出现，预检将拒绝。`.skill-output` 历史产物即使在技能包目录内，也只有用户当次 query 明确给出路径时才允许作为 `--context`。

**上下文目录由用户管控（Agent 必读）**：

- **`config/prompt_context/`** 与 **`config/perference_context/`** 内的资料**仅由用户**放置、编辑或删除；Agent **不得**擅自新建/修改/删除其中任何 `.md`、`.txt` 等文件（含从 `.skill-output`、历史 `prompt_execution_hints`、其它项目或对话中「摘抄」后写入）。
- **`config/upload_files/`** 用于用户放置 UI 上传测试样例文件；内置 `file_jpg.jpg`、`file_jpeg.jpeg`、`file_pdf.pdf`、`file_md.md` 样例。Agent 应优先使用用户当次 query / 用例里的明确路径；若用户明确要求验证上传但未指定文件，可根据页面提示或文件类型限制自主选择一个内置样例。不得扫描其它目录找文件，也不得把上传文件内容作为 prompt 上下文注入。
- **上传路径硬规则**：用户当次 query / 用例已明确给出上传文件路径时，`upload.path` 必须逐字复制该真实路径，禁止改写为 `/path/to/...`、`example`、`sample`、`image.jpg` 等示例占位路径；路径不存在时应报告路径问题或使用脚本明确列出的内置样例路径，不得臆造替代路径。
- 目录为空时：**直接执行** quick（无注入、无失败参考），**不得**为「提高成功率」自作主张补文件；可向用户说明可在此两目录自行添加资料，但须等用户确认后再动文件。
- 用户**明确要求**「写入/更新/删除某上下文文件」时，方可按用户指定路径与内容操作；操作后简要告知变更，不扩大范围。

## 触发条件

**当用户说以下任一内容时，Agent 必须启用本 Skill：**

| 用户表述 | 对应动作 |
|---------|---------|
| **快速测试 / 快测 / 快速验证 / quick** + 自然语言任务、URL、测试用例集合、需求文档或测分文档路径 | **快速测试模式**：`package/scripts/run_quick_mode.py`；单任务直接 quick；用例集合先解析每条记录；需求/测分文档先拆解为用例；最后均逐条改写为 query 后串行执行。注意：`QUICK_URL=...`、`QUICK_MAX_STEPS` 等环境变量名只是配置，不是快速模式触发词 |
| **冒烟验证 / 冒烟测试 / 前端走查 / 页面走查 / 主页面走查 / 主模块走查** + URL | **快速冒烟走查模式**：`package/scripts/run_quick_mode.py --smoke-walkthrough --query "<用户原始请求>"`；合成 aiQuick 走查 prompt，先视觉盘点左侧/顶部导航的可见一级主模块，再逐个覆盖这些主模块的核心前端可用性，执行后打印疑似 bug，并写 `quick/batch/smoke_walkthrough_report.md/json` 与 `quick/batch/smoke_ai_analysis.md/json`。AI 分析优先由大模型基于日志整体理解给出明确结论：`冒烟通过 / 需要人工核对 / 有问题`，规则仅兜底；默认冒烟只要未发现明确前端 bug 即判 `冒烟通过`，未覆盖/定位未确认/报告验收失败列为人工核对项；用户附加明确模块、校验、断言、必须覆盖项时按自定义冒烟保守判断，未要求模块不写成未覆盖问题 |
| **页面巡检 / 巡检 / 页面探活 / 探活 / 页面存活** + URL | **页面巡检模式**：`package/scripts/run_quick_mode.py --health-check --query "<用户原始请求>"`；合成 aiQuick 探活 prompt，只检查入口页是否可访问、正常渲染、完成基本加载，输出 `quick/batch/health_check_report.md/json`。不做模块盘点、导航探索、输入提交或业务功能验证 |
| **快速测试** + 辅助资料 / 背景资料 / 参考资料 / 上下文 / 图谱目录 / 白皮书 / 代码库 / 文档目录 | **快速测试模式 + 辅助参考**：若 `config/perference_context/` 为空，用户显式资料作为失败后 query 改写参考；不直接拼入 quick query |
| **普通探索**：「探索 / 测一下 / 帮我测试 / 验一下」+ URL，且**未**要求深度、遍历、递归、多页、意图批跑、图谱发现等（见下「分流」） | **普通探索模式**：`CaseGeneratorAgent` + 可选批量执行 |
| **深度 / 遍历探索**：含 **深度、遍历、递归、多 URL、多锚、整站/站点多页、发现链接入队、strict 阶段、意图探索、图谱/graph** 等与 **`run_recursive_exploration`** / **`recursive_exploration`** 相当的诉求 | **深度 / 遍历探索模式**：`package/scripts/run_recursive_exploration.py`，须尊重「首轮入队 → 单步扩队 → 意图」完整语义，**禁止无故中断** |
| 探索模式测试、URL 开始测试、对 xxx 进行探索测试 | 结合上文关键词分流至 **普通** 或 **深度** |
| **测一下、帮我测试、验一下** + URL | 默认 **普通探索**；若同句含深度类关键词 → **深度探索** |
| 指定模块测试、测试 xxx 模块 | **优先任务模式** |
| 执行测试用例、跑用例、任务式测试 | **任务模式**（若仅丢 YAML 路径、无生成诉求 → **用例执行模式**） |
| 根据需求文档生成并执行、按步骤执行测试 | **任务模式** |
| **仅**给出 YAML 路径、「跑这个用例」「执行该 yaml」、无生成描述 | **用例执行模式** |
| **修复 YAML、自愈、修失败用例、YAML 修复** + 用例路径 | **修复自愈模式** |
| `/ui-test-assistant-skill` | 手动触发，由 Agent 询问选择模式 |

**若用户未 @ 其他 skill，且涉及上述关键词，优先使用本 Skill。**

## 探索分流（普通 vs 深度 / 遍历）

- **走「快速测试模式」**：用户明确出现 **快速、快测、快速测试、快速验证、quick** 等任务语义时，优先走 quick 链路。若用户同时明确说 **普通模式 / 普通探索 / 老的执行模式 / 非快速模式**，则按普通探索或任务/用例执行分流，不能因配置片段里出现 `QUICK_URL=...`、`QUICK_*`、文件路径或环境变量名中的 `quick` 而触发快速模式。若输入是自然语言或 URL → 单任务 quick；若输入是 `.md` / `.xlsx` / `.csv` / `.tsv` 测试用例集合 → 先抽取记录并改写为 quick query；若输入明确是需求文档或测分文档 → 先拆解为一条条 UI 测试用例，再改写为 quick query 逐条串行执行。未出现快速语义时，不因“测一下 + URL”改走 quick。
- **走「页面巡检模式」**：用户要求对某个 URL 做 **页面巡检 / 巡检 / 页面探活 / 探活 / 页面存活 / 可用性巡检** 时，走 quick 链路并追加 `--health-check`。该模式比冒烟更轻，只关注入口页是否能打开、完成基本渲染和加载；不做模块盘点、不点击导航、不验证业务功能、不输入或提交。登录页、验证码页、权限页若正常渲染，记录为“部分可达/备注”，不判定为前端 bug。
- **走「快速冒烟走查模式」**：用户要求对某个 URL 做 **冒烟验证 / 冒烟测试 / 前端走查 / 页面走查 / 主页面走查 / 主模块走查 / 可用性走查** 时，即使没有说“快速”，也走 quick 链路并追加 `--smoke-walkthrough`。该模式不是生成完整测试用例，也不是深度探索；必须先视觉盘点入口页左侧/顶部导航、可展开分组和当前页面标题，只列出当前页面实际可见的一级主模块，再逐个进入这些主模块或代表性子入口做轻量冒烟，不能套用历史站点或固定产品模块名，不能只检查默认打开的第一个模块。用户原话中的附加关注点（如“重点看导航和红色告警”“关注创建入口是否可见”）必须进入走查 prompt 并优先覆盖。
- **走「普通探索模式」**：用户只说 **探索 / 测试 / 测一下 + URL**，或泛泛的「做个页面探索」「生成用例」，**没有**明确要求下列任一意图 → 使用 **`run_exploration_case_generator.py` / `CaseGeneratorAgent`**，产物在 **`exploration/generated_cases/`**，流程见 **「探索模式流程（Step E）」**（单 URL、单轮生成；与本 Skill 内深度探索管线无关）。
- **走「深度 / 遍历探索模式」**：用户提到 **递归、遍历、深度、多层级 / 多锚点、发现 URL 继续探、意图任务跑满、图谱引导、graph_guided、strict 探索阶段**，或点名 **`run_recursive_exploration`** / **`recursive_exploration`** → 使用 **`package/scripts/run_recursive_exploration.py`**，产物在 **`exploration/recursive/`**。默认须覆盖 **单步首轮入队、单步成功后队列扩增、意图任务** 三段；**不得**为「先交付半成品」而主动终止进程（见下文「禁止无故中断」）。
- **深度探索意图 hybrid 执行器**：`intent_mission` 默认 **hybrid**，即先用原结构化 YAML Agent 执行，保留图谱/事件/YAML 产物；若该意图失败，再用 browser-use `quick` 对同一高层意图做一次 fallback。quick 成功时该 intent 记为成功，并在事件 `extra.intent_mission_quick`、`intent_mission_logs/<task_id>/round_<n>/quick_fallback/` 中归档 query、命令和 quick 日志；不替换单步探索，也不把 quick 结果反向拆成 DOM 边。

## 模式识别逻辑

```
若用户提供：
  - 页面巡检 / 巡检 / 页面探活 / 探活 / 页面存活 + URL：
    1. 使用页面巡检模式：
       `"$PY" package/scripts/run_quick_mode.py --query "<用户原始请求>" --health-check --output-dir <RUN_TS>/quick`
    2. prompt 由脚本合成，只覆盖：
       - 打开入口 URL，等待页面稳定到不再明显 loading；
       - 判断首屏是否有可识别标题、导航、主体内容、卡片/表格/列表/表单或登录表单之一；
       - 检查 DNS/证书/网络错误、404/500/无权限错误页、白屏、崩溃页、长时间 loading、主体缺失、明显红色错误或严重布局错乱；
       - 若自动跳到登录页、验证码页、安全校验页或非同域页面，只记录最终 URL、标题和渲染状态，不继续登录、点击导航或探索其它页面。
    3. 最终 done 文本须输出 `HEALTH_REPORT`：结论、入口、最终页面、渲染状态、异常、备注。脚本写入 `quick/batch/health_check_report.md` 与 `.json`。
  - 冒烟验证 / 冒烟测试 / 前端走查 / 页面走查 / 主页面走查 / 主模块走查 + URL：
    1. 使用快速冒烟走查模式：
       `"$PY" package/scripts/run_quick_mode.py --query "<用户原始请求>" --smoke-walkthrough --output-dir <RUN_TS>/quick`
    2. prompt 由脚本合成，必须覆盖：
       - 打开入口并等待主页面稳定，排除白屏、崩溃、登录死循环、404/500、无权限、长期 loading；
       - 先视觉盘点左侧/顶部导航、可展开分组和当前页面标题，只列出实际可见一级主模块；不得套用历史站点、固定产品或 `prompt_context` 中的模块名，不能只停留在默认模块；
       - 逐个进入可见一级主模块或代表性子入口，检查主内容、关键列表/卡片/表单/搜索区/操作按钮是否可见；
       - 每个模块轻量点击或切换 1–2 个核心入口，只做只读或可撤销操作，禁止新增、删除、发布、支付等破坏性动作；
       - 模块存在搜索框、筛选输入框、试用对话框等低风险输入场景时，输入简短测试文本并触发查询/发送/提交，验证输入、按钮响应和结果/提示变化；若提交语义会新增、保存、发布、购买、支付等，则不提交并记录未覆盖；
       - 逐模块观察红色错误/警告、异常 toast/modal/banner、接口失败提示、空数据异常、按钮无响应、组件遮挡重叠、内容溢出、关键控件不可点击、明显视觉错乱；
       - 每次点击、提交或打开新页后检查地址栏 host；若跳转到与被测入口不同域名、不同控制台或明显外部平台，只验证外部页是否可达、标题/核心内容是否白屏或报错，记录后立即返回被测入口或上一页继续其它本域模块；不要继续探索外部平台的导航、二级页面或业务流程，也不要反复触发同一跨域入口；
       - 验证码、滑块、人机校验、安全验证、登录二次校验等风控页面通常是正常防护机制，不直接判定为前端 bug 或整体阻塞；记录到“未覆盖/风险说明”，返回入口页或可访问区域继续走查其他主模块；
       - 某个模块因权限、风控、验证码、数据缺失或单点异常无法继续时，不反复绕过，不提前结束；标记该模块未覆盖或疑似问题后继续检查其他可访问主导航/主模块；
       - 目标选项、模型、按钮或模块首屏不可见时，不得直接判定不存在或提前 `done(success=false)`；先滚动对应列表容器到顶部/底部、使用搜索框输入目标文本、键盘方向键/Enter、关闭重开下拉等方式复核，仍未找到再写入“未覆盖/需人工核对”，并继续输出完整 `SMOKE_REPORT`；
       - 根据用户附加关注点动态调整优先覆盖内容。
    3. 最终 done 文本须输出 `SMOKE_REPORT`：结论、模块清单、模块覆盖、已检查、疑似问题、未覆盖、建议。脚本会从 `quick_task_result*.json` 汇总疑似问题与未覆盖/风险说明，写入 `quick/batch/smoke_walkthrough_report.md` 与 `.json`，并在控制台打印疑似 bug 列表。脚本还会额外生成 `quick/batch/smoke_ai_analysis.md/json`，用 `冒烟通过 / 需要人工核对 / 有问题` 给出明确 AI 分析结论、覆盖点、问题点和人工核对点。默认冒烟中，执行器失败、报告字段缺失、定位未确认或部分未覆盖不会自动拉低页面冒烟结论；只要未发现明确前端 bug，则结论为 `冒烟通过`，并把这些项列入人工核对。用户明确提出模块/控件/校验/断言/必须覆盖等自定义冒烟要求时，未覆盖或验收失败仍应保守判为 `需要人工核对`。
  - 快速 / 快测 / 快速测试 / 快速验证 / quick（仅指用户任务意图中的 quick；不包括 `QUICK_URL` 等配置名）：
    1. 若同时给出 md/xlsx/csv/tsv 测试用例集合路径 → 快速批量模式：
       `"$PY" package/scripts/run_quick_mode.py --input <用例集合> --output-dir <RUN_TS>/quick [--context <资料路径> ...]`
       脚本会识别「用例标题 / 前置条件 / 测试步骤 / 预期结果 / 是否UI自动化」等列；
       `是否UI自动化=不可UI自动化` 的记录默认跳过，其余记录逐条改写为 quick query 后串行执行。
    2. 若同时给出需求文档或测分文档路径 → 快速文档拆解模式：
       `"$PY" package/scripts/run_quick_mode.py --input <文档> --input-kind requirement|analysis --target-url <入口URL> --output-dir <RUN_TS>/quick [--context <资料路径> ...]`
       `--input-kind auto` 会先识别用例集合，再按文件名/正文中的「需求/PRD/验收」或「测分/测试分析/测试点」判断文档类型；无法判断时须显式指定。
       需求/测分文档默认按章节分片生成并覆盖每个明确功能点，**不要**主动设置很小的 `--max-generated-cases`；默认 `--max-generated-cases 0` 表示不限制总数，`--cases-per-doc-chunk 0` 表示不限制每片段条数。PRD/需求输入会按结构化用例质量规则拆解：过滤变更记录、需求背景、产品目标等文档元信息；生成 `module1/module2/priority/smoke/case_type/test_point/precondition/entry_hint/navigation/steps/expected/ui_auto/fixture_required` 等字段；缺少可操作 UI 或缺少可满足前置数据的记录会在原始用例产物中说明，`ui_auto=false` 的记录默认跳过。
       `--context` 可传图谱目录、产品白皮书、代码库、接口/设计文档等任意辅助材料；仅在 `config/perference_context/` 为空时作为拆解用例和失败修复背景，不直接拼进 quick query。
    3. 否则 → 快速单任务模式：
       `"$PY" package/scripts/run_quick_mode.py --query "<用户原始任务>" --output-dir <RUN_TS>/quick [--context <资料路径> ...]`
    4. CDP 与有头/无头是两组独立开关：用户未显式说明时，quick 默认走 **非 CDP + 无头**（脚本默认等价 `--no-cdp --headless true`）。只有用户明确提到 **本地登录态、调试、本地浏览器、已有 Chrome、CDP** 等语义时才追加 `--cdp`；只有用户明确提到 **有头、可视化、打开浏览器观察** 时才追加 `--headed`。脚本也会从 `--query` / `--user-query` / `--task-prefix` 中识别这些语义并自动切换；但 Agent 调用时仍应显式传参，避免歧义。用户要求「CDP + 无头」时用 `--cdp`；用户要求「非 CDP + 有头」时用 `--headed` 且不要追加 `--cdp`。
    5. 普通 quick 每条失败后执行 `observe`，结合当前页面与原始 query 改写后 `quick --resume`；重试次数由 `--max-retries` 或 `config/.env` 的 `QUICK_MAX_RETRIES` 控制，默认 1 次；冒烟走查和页面巡检默认不自愈重试，除非用户显式要求。
       批量模式中单条失败不阻断后续记录，最终写汇总结果。
    6. **仅 CDP 且续跑自愈最终成功**时：告知用户 `quick/logs/<case_id>/regression/` 已生成回归 YAML/query（**未自动复跑**）；默认非 CDP 模式失败重试不使用 `--resume`，也不生成 CDP regression 归档。
  - **分流**：先按「探索分流」判定普通 vs 深度；深度 → `run_recursive_exploration.py`；普通 → 下文 CaseGeneratorAgent 流程
  - 普通探索：仅 URL，或「测一下 / 测试 / 帮我测试 / 验一下」等 + URL，且**未**出现「只生成」「不要执行」「仅出用例」「别跑」→ **CaseGeneratorAgent 生成 YAML 后立即**按「批量执行（探索模式）」逐个 `--task-file`，**不得**停在中途询问是否执行
  - 用户明确只要用例、不跑执行 → 普通探索，**仅生成**
  - URL + 模块名 / 强语义路径 → **优先任务模式**：若必须坚持模块叙事且无直达 URL，用任务模式
  - **已有 YAML 路径**、且用户意图是「只执行、不生成」→ **用例执行模式**（`browser_use.cli --task-file`）；若还要按需求/步骤**生成** → **任务模式**
  - 测试步骤 / 需求文档 / 可读取的在线文档链接 → **任务模式**，先生成再执行（默认**生成后执行**，除非用户只要 YAML）
  - **修复 / 自愈 / 修失败用例** + YAML 路径 → **修复自愈模式**：优先调用 `python package/scripts/run_yaml_repair.py --task-file <yaml> --work-dir <RUN_TS>/repair/<名字>`（需已 `export DOTENV_PATH`）；成功口径为 **CLI 执行无报错**；若用例内**已有断言**则不得擅自新增断言步骤（校验相对首轮合并基线）；依赖（`import`/`use`）与同目录 `bootstrap.yaml` 可合并为**单文件**后再跑（见 `package/recursive_exploration/yaml_repair/merge_deps.py`）。自愈在调用 LLM 前可走**启发式**：① **断言失败**且断言文案含「创建成功」等瞬时 Toast → **删除该断言**，并可把「创建」后的长 `sleep` 换成 `aiWaitFor:「等待页面加载完成」`（`YR_HEURISTIC_TRANSIENT_ASSERT` 等）；② 登录「账号密码登录表单」等待：**timeout** 或重复 ≥2 次时，改为 **`aiWaitFor:「等待页面加载完成」`**（默认），少用固定长 `sleep`（`YR_HEURISTIC_LOGIN_USE_WAIT` / `YR_HEURISTIC_LOGIN_WAIT_TEXT`）。每轮失败会在控制台打印**失败分析**与**修复策略**（`YR_REPAIR_QUIET=1` 关闭）。若 **aiWaitFor 弱特征**（如「分区名获取完成」）在日志中已 **timeout**，可自动改为短 **sleep** 或备用等待（`YR_HEURISTIC_VAGUE_WAIT*`）。**批量逐个修复时禁止在外层额外设置“单文件 timeout”并强杀进程**，应让 `run_yaml_repair.py` / `browser_use.cli` 自行完成并在失败时自然退出；仅在用户明确要求中断时才停止当前文件。
```

## 输出目录结构（强制分栏）

```
<工作区根>/.skill-output/ui-test-assistant-skill-output/
└── <RUN_TS>/                               # 单次触发 skill 的时间戳目录（每轮新建）
    ├── execution.log                       # 本会话总览（可选 execution.md）：模式、关键命令、产物路径
    ├── quick/                              # 仅快速测试模式：quick 单任务或批量记录执行
    │   ├── logs/                           # 每条 quick / retry 的 --log-dir
    │   ├── observe/                        # 失败后 observe_<n>.json 与截图路径引用
    │   ├── context/                        # 固定上下文与参考资料摘要、来源记录
    │   ├── rewrite/                        # 失败后 query 改写建议与最终独立 retry query
    │   └── batch/                          # 批量输入解析产物：records.jsonl、queries.md、original_cases.*、results.*
    ├── exploration/                        # 仅探索模式：下面所有内容都属于探索
    │   ├── logs/                           # 探索用例执行时 --log-dir 必须指向此树下子目录
    │   │   └── {子目录}/                   # 如 batch_20260322-153045、single_01_xxx
    │   └── generated_cases/                # CaseGeneratorAgent 建议的 output_dir 子目录（平铺 YAML）
    │       ├── 01-xxx.yaml
    │       └── 02-xxx.yaml
    │   └── recursive/                      # 可选：技能包「递归探索」脚本产物（events.jsonl、graph.json、generated_cases/…）
    │   # 若使用算法侧扩展包（含 TestAssistant），可能出现 {run_id}/cases/L0_… 树与 reports/；公开 wheel 以平铺目录为准
    ├── repair/                             # 可选：修复自愈模式（run_yaml_repair 产物）
    │   └── {run_name}/                   # merged.yaml、iter_*.yaml、repaired.yaml、repair_report.md
    └── task/                               # 仅任务模式：下面所有内容都属于任务
        ├── logs/                         # 任务执行时 --log-dir 必须指向此树下子目录
        │   └── {子目录}/
        └── {project_name}/                # 如 service-market、promote-project-list
            ├── 01-xxx.yaml
            └── 02-xxx.yaml
```

**规则摘要**

| 内容 | 必须所在位置 |
|------|----------------|
| 快速测试 `run_quick_mode.py --output-dir` | `<RUN_TS>/quick/` |
| quick 单条/批量每条执行日志 | `<RUN_TS>/quick/logs/<case_id>/` |
| quick 失败观察产物 | `<RUN_TS>/quick/observe/` |
| quick 页面特性注入摘要 | `<RUN_TS>/quick/context/prompt_context_summary.md`、`prompt_execution_hints.md`；默认只选 `config/prompt_context/global_readme.md`，特定业务文件需用户显式命名；冒烟/巡检默认跳过注入并写 `prompt_execution_hints.skipped.md` |
| quick 失败修复参考摘要 | `<RUN_TS>/quick/context/perference_context_summary.md`、`perference_execution_hints.md`、`context_sources.json` |
| quick retry 改写审计 | `<RUN_TS>/quick/rewrite/*_advice.md`、`*_query.txt` |
| quick CDP 自愈成功后的回归归档 | `<RUN_TS>/quick/logs/<case_id>/regression/<case_id>_regression.yaml`、`*_regression_query.txt`、`*_regression_notes.md` |
| quick 批量解析与汇总 | `<RUN_TS>/quick/batch/records.jsonl`、`queries.md`、`original_cases.md`、`original_cases.json`、`original_cases/<case_id>.md`、`results.md`、`results.json` |
| quick 每条执行原始用例 | `<RUN_TS>/quick/logs/<case_id>/original_case.md` |
| CaseGeneratorAgent `output_dir` | 建议 **`<RUN_TS>/exploration/generated_cases`**（或自定义子目录；库将 **平铺** 写入 `01-名称.yaml`） |
| 探索批量/单次 `browser_use.cli` 的 `--log-dir` | `<RUN_TS>/exploration/logs/<有意义子目录名>/` |
| 任务模式生成的 YAML | `<RUN_TS>/task/{项目名}/` |
| 任务 `browser_use.cli` 的 `--log-dir` | `<RUN_TS>/task/logs/<有意义子目录名>/` |
| 修复自愈 `package/scripts/run_yaml_repair.py` 的 `--work-dir` | `<RUN_TS>/repair/<有意义子目录名>/`（内含 `merged.yaml`、`repaired.yaml`、`repair_report.md`） |
| 会话级总览日志 | `<RUN_TS>/execution.log`（或 `execution.md`） |

**仅执行单一模式时**：未用到的目录可以不创建（例如只做任务则可无 `exploration/`）。

**.env 公用配置**：API、模型与登录凭据放在 **本 Skill 目录下的 `config/.env`**（与 `<RUN_TS>` **无关**）。开源仓库和安装包不内置可用密钥；首次使用前须从同目录的 **`config/.env.example`** 创建本地 `config/.env`，并填写自己的模型服务配置。`config/.env` 不得提交，也不要写入 `.skill-output/`。执行 CLI 前须能加载该文件，例如在工作区根：`export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"`（路径按实际技能根调整）；或 `cd` 到技能根后 `export DOTENV_PATH="$(pwd)/config/.env"`。

**更新 .env 时保留已有配置**：若 **`config/.env`** **已存在**，Agent **不得**用空模板或整文件覆盖方式清空 `BU_OPENAI_API_BASE`、`BU_OPENAI_API_KEY`、`BU_OPENAI_API_KEY`、`BU_OPENAI_*` 等；仅可按用户当次要求**增量更新**（如只改本次测试的 USERNAME/PASSWORD），**保留用户已配置的 API 等项**。

## 快速测试模式（quick）

**适用场景**：用户希望一句话快速执行浏览器任务，给出原始测试用例集合并要求快速逐条执行，或在快速模式下给出需求文档/测分文档要求先拆解再执行。该链路不生成传统 YAML 用例，不进入 `CaseGeneratorAgent` 分析链路；browser-use quick 会自行产出 `quick_task_<timestamp>.yaml` 供后续复跑。

**执行前预检（强制）**：Agent 调用 `run_quick_mode.py` 前须确认入口 URL 已来自**用户当次 query**、**`--target-url` / `--task-prefix`** 或 **`config/.env` 的 `QUICK_URL`**（与 browser-use `resolve_quick_url` 一致；兼容 `QUICK_TARGET_URL` / `TARGET_URL` 旧名）（见上文「配置来源约束」）。若三者皆无 URL，**不得执行**；须将脚本 **exit 3** 打印的配置指引原样告知用户，等待补充后再跑。**禁止**从 `.skill-output` 历史、白皮书探索环境名或其它项目配置推断 URL。

**最大步数**：`run_quick_mode.py` 调用 `browser-use quick` 时默认 **`--max-steps 40`**（高于 browser-use enhanced 模式内置下限 16）。可在 **`config/.env`** 设置 **`QUICK_MAX_STEPS`**，或用 CLI **`--max-steps N`** 覆盖（优先级：CLI > `.env` > 默认 40）。多步链路（登录 + 建库 + 发布 + 命中测试）步数不足时可调大该值。

**自愈重试次数**：普通 quick 每条失败后默认最多自愈重试 **1 次**（即总共最多执行 2 轮 quick）。可在 **`config/.env`** 设置 **`QUICK_MAX_RETRIES=1`**，或用 CLI **`--max-retries N`** 覆盖（优先级：CLI > `.env` > 默认 1；`0` 表示失败后不自愈重试）。**冒烟走查和页面巡检默认不做第二轮自愈**，即未显式传 `--max-retries` 时按 `0` 处理；只有用户明确要求重试/自愈/再跑一轮时才为这两类轻量模式传 `--max-retries N`。

**quick 登录文案与 HTML 报告**：快速测试的自然语言 query **禁止**写 `${USERNAME}`、`${PASSWORD}` 等 OmegaConf 风格占位符（会写入 browser-use 的 `quick_display_query`，任务成功也可能**无法生成** `quick_task_report_*.html` / `quick_task_result.json`）。登录说明用「使用 config/.env 账号密码」或「CDP 已登录可跳过」即可；`run_quick_mode.py` 会在调用 CLI 前自动净化上述占位符。执行时 browser-use 仍会从 `.env` 向 `task_text` 注入登录占位符。**产物**：每条 attempt 成功结束后应在 `quick/logs/<case_id>/attempt_<n>/` 下看到 `quick_task_report_*.html` 与 `quick_task_result.json`；**最终是否记为 success 以完成度验收为准**（见下），勿仅凭 HTML 文件名含 `success` 判断。

**quick query 压缩**：`run_quick_mode.py` 会在执行前统一规范化每条 record query：仅做通用清理，例如去掉与 `入口 URL` 重复的 `建议入口`，避免同一入口在 prompt 中重复出现。不得在通用链路里写入特定业务系统的入口转换、导航路径、数据命名或操作约束；如需业务特性约束，应放入 `config/prompt_context/` 或由用户当次 query 明确提供。

**quick 通用执行约束（Agent 策略）**：与业务无关的下拉操作、反循环等 Agent 行为约束由 **`run_quick_mode.py` 内置 `QUICK_AGENT_GUARDRAILS`** 注入，以「通用执行约束」段落追加到每条 quick query（含失败 retry 改写器系统提示中的对应规则）。**不要**把这些通用策略写入 `config/prompt_context/`——该目录只放被测产品的业务特性（菜单结构、业务禁忌、白名单 URL、模块导航等）。约束要点：

- **下拉/格式选择**：禁止 `select_dropdown_option`；展开后精确点目标选项，或键盘 `ArrowDown` + `Enter`；禁止连续 3 次只点下拉触发器。
- **指定模型/模式/选项**：用户明确指定模型名、模式名、格式或其它下拉选项时，必须先读取当前显示值；若不是目标值，先切换并再次读取确认。确认目标值前禁止上传文件、输入业务文本或点击提交/生成；提交/生成前还要二次确认页面没有回到默认值。
- **生成/提交类任务必须执行本轮操作**：用户要求输入内容并生成/提交/发送时，必须在本轮实际完成目标模型/模式确认、输入用户指定内容、点击提交/生成/发送按钮，再依据本轮结果判断。页面已有的历史记录、旧生成结果、缓存预览或先前会话结果只能作为背景，不得作为本次成功依据；即使历史结果的模型和提示词完全匹配，也必须重新执行输入和提交。若权限、余额、开通、缺少上传材料或按钮不可用导致无法重新提交，必须判失败并说明原因。
- **上传路径**：若任务中出现本地文件路径，执行 `upload` 动作时 `path` 字段只能使用该路径或脚本明确追加的内置样例路径，不能使用 `/path/to/local/image.jpg` 一类占位示例。
- **异步/生成类任务**：点击提交/生成后，若页面进入生成中、创建中、处理中、任务执行中、AI 正在回复、排队中、加载中等状态，说明任务已被受理；必须分段等待并复查，累计至少 60 秒或直到明确成功/失败。此时不要回头反复修复上传、下拉、输入等前置控件，也不要因历史/残留校验提示立即失败；前置控件疑点只列人工核对项。
- **反循环**：同一控件操作 2 次后关键状态未变，第 3 次必须换策略（键盘、补必填项、关弹窗重开、滚动重定位等）或 `done(success=false)` 说明卡点；提交按钮 2 次无效时先查表单校验/警告，不要盲点多按。

**输入文本唯一性**：`run_quick_mode.py` 会为包含输入/新建/创建等操作的 quick query 追加“文本唯一性规则”。规则只作用于 Agent 自己临时决定的名称、标题、描述、备注、问题、答案、标签名、库名等输入文本：若用例或用户未明确给出具体内容，则在该文本末尾追加本次运行时间戳；若用户/用例已明确给出具体文本、URL、文件路径、账号密码或断言期望值，必须原样使用，不得追加或改写。失败自愈改写和 CDP 回归归档也必须保留该规则，避免重跑时因重名导致不稳定。

**完成度二次验收（必读）**：`browser-use quick` 的 Agent 可能只完成登录就 `done(success=true)`，导致 `returncode=0` 与 `quick_task_report_success.html` 的**假阳性**。`run_quick_mode.py` 在每轮 CLI 结束后会调用 `package/scripts/quick_completion_validate.py`，对照 **`original_case.md` / `record.raw` 中的测试步骤与预期结果**、**`quick_task_result.json` 的 done 说明与动作轨迹** 做二次验收：

- **通过口径**：`returncode=0` **且** `completion_validation.json` 中 `passed=true`（启发式步骤覆盖 + 必要时 LLM 裁判）。
- **未通过**：CLI 成功但验收失败 → 记为 **failed**，默认继续走 observe + retry（与 CLI 失败相同）；控制台会打印「CLI 返回成功但验收未通过（假阳性已拦截）」。
- **生成/提交类验收**：若原始任务包含「输入/提示词」与「生成/提交/发送」目标，二次验收会检查本轮动作轨迹中是否真实出现 `input_text` 以及其后的提交/生成/发送动作；仅靠 `done` 文案声称页面已有匹配历史结果，不会判通过。
- **产物**：`quick/logs/<case_id>/attempt_<n>/completion_validation.json` 与 `completion_validation.md`；`quick/batch/results.md` 增加 **validation** 列摘要。
- **跳过验收**：设置环境变量 `QUICK_SKIP_COMPLETION_VALIDATE=1`（仅调试时建议）。

**单任务命令**（工作区根执行，先保证 `DOTENV_PATH` 指向本 Skill 的 `config/.env`）：

```bash
PY="${UI_TEST_PYTHON:-python3}"
RUN_TS=$(date +%Y%m%d%H%M%S)
OUT=".skill-output/ui-test-assistant-skill-output/${RUN_TS}/quick"
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --query "快速测试 https://example.com 登录后创建知识库" \
  --output-dir "$OUT"
```

**冒烟走查命令**：用户说「执行 xx URL 的冒烟验证 / 前端走查」时使用。脚本会把用户原始请求中的关注点合成到 aiQuick prompt，先盘点可见一级主模块，再逐个执行主模块可用性检查，并输出 `quick/batch/smoke_walkthrough_report.md/json`。

```bash
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --query "执行 https://example.com/app 的前端走查，重点看导航、红色告警和主按钮是否可用" \
  --smoke-walkthrough \
  --output-dir "$OUT"
```

**冒烟走查 prompt 口径**：覆盖入口页可见的一级主模块，不做破坏性写操作。先视觉盘点左侧/顶部导航、可展开分组和当前页面标题，只列出当前页面实际可见的一级主模块，不得套用历史站点或固定产品模块名；随后逐个进入这些模块或代表性子入口，检查页面稳定性、模块主内容/关键控件可见性、每个模块 1–2 个只读或可撤销核心交互。若用户明确指定某模块、控件、对话、校验或断言，本次冒烟以该指定范围为主，其它未要求模块只记录可见性，不作为未覆盖问题。若模块存在搜索、筛选、试用对话等低风险输入场景，应输入简短测试文本并触发查询/发送/提交，验证输入、按钮响应和结果/提示变化；若提交会新增、保存、发布、购买、支付等，则不提交并记录未覆盖。导航或菜单点击后页面未变化时，先按执行器未点准、命中折叠/遮挡区域处理，需改用点击文字中心、链接文本、滚动后再点、展开父级、键盘 Enter、先点相邻项再回来等方式重试；只有明确点中正确控件且页面给出错误、禁用或异常提示时才写疑似问题，定位不确定的点击失败只能写「未覆盖：执行定位未确认/未点准」。下拉/列表/模型选择中目标项首屏不可见时，不得直接判定不存在或提前 `done(success=false)`；必须滚动列表容器、使用搜索、键盘方向键/Enter、关闭重开后复核，仍未找到再写入「未覆盖/需人工核对」并继续输出完整 `SMOKE_REPORT`。重点观察红色错误/警告、异常 toast/modal/banner、接口失败、白屏、长期 loading、遮挡重叠、内容溢出、按钮无响应等疑似 bug。冒烟主范围限定在被测入口同域/同产品页面；每次点击、提交或打开新页后检查 host，若跳到不同域名、不同控制台或明显外部平台，只记录外部页可达性、页面标题和是否白屏/报错，随后立即返回入口页或上一页继续本域其它模块，不继续探索外部平台的导航、二级页面或业务流程。验证码、滑块、人机校验、安全验证、登录二次校验等风控页面按正常防护机制处理：记录到「未覆盖/风险说明」，不要直接判定为 bug 或整体阻塞；随后返回入口页或可访问区域继续走查其他主模块。若某个模块因权限、风控、验证码、数据缺失、跨域外部平台或单点异常无法继续，标记该模块未覆盖或疑似问题后继续检查其他可访问模块，最终汇总总报告。最终 `done` 必须包含 `SMOKE_REPORT`，字段为「结论 / 模块清单 / 模块覆盖 / 已检查 / 疑似问题 / 未覆盖 / 建议」。脚本最终还会生成 AI 分析结论，优先由大模型基于执行日志整体理解给出「冒烟通过 / 需要人工核对 / 有问题」、覆盖点、问题点和人工核对点，规则仅兜底；默认冒烟只要无明确 bug 即为「冒烟通过」，未覆盖/定位未确认/执行器失败列为人工核对；自定义冒烟中，只有用户要求的核心验收点出现明确页面错误、接口错误、失败提示或可复现功能异常才判「有问题」，执行器早停、报告字段缺失、目标项未充分探索只能判「需要人工核对」。若用户补充关注点，应优先覆盖并体现在报告中。冒烟首轮默认不注入 `config/prompt_context/`，避免固定业务系统提示污染跨站点模块盘点。

**页面巡检 / 探活命令**：用户说「巡检一下 xx URL」「页面探活 xx URL」时使用。该模式只判断入口页能否正常打开、渲染和加载，不做模块盘点、导航点击或业务功能验证，并输出 `quick/batch/health_check_report.md/json`。

```bash
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --query "巡检一下 https://example.com/app" \
  --health-check \
  --output-dir "$OUT"
```

**页面巡检 prompt 口径**：只打开入口页并等待稳定，检查首屏标题/主体/登录表单/错误页是否可识别，重点发现 DNS/证书/网络错误、404/500、白屏、崩溃、长期 loading、主体缺失、明显红色错误或严重布局错乱。若自动跳转到登录页、验证码页、安全校验页、权限页或非同域页面，只记录最终 URL、标题、渲染状态和备注，不继续登录、点击导航、输入提交或探索其它页面。巡检默认不注入 `config/prompt_context/`，默认不自愈重试，默认 `max_steps` 上限收敛到 25。

**批量命令**：输入 `.md` / `.xlsx` / `.csv` / `.tsv` 测试用例集合时，脚本会识别测试记录，默认只执行未标记为“不可UI自动化”的记录。

```bash
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --input "/path/to/测试用例汇总.xlsx" \
  --output-dir "$OUT"
```

**需求/测分文档拆解命令**：输入不是用例集合而是需求文档或测分文档时，先拆解为 quick 批量记录，再逐条执行。文档未写入口 URL 时，用 `--target-url` 或 `--task-prefix` 从用户原始请求补入。

```bash
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --input "/path/to/需求文档.md" \
  --input-kind requirement \
  --target-url "https://example.com/app" \
  --context "/path/to/product-docs" \
  --output-dir "$OUT"

"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --input "/path/to/测分文档.xlsx" \
  --input-kind analysis \
  --task-prefix "入口 URL：https://example.com/app；使用已登录 CDP Chrome" \
  --cdp \
  --output-dir "$OUT"
```

**文档拆解覆盖策略**：脚本默认将需求/测分文档按 Markdown 章节分片，每个片段独立生成用例并去重，避免整篇文档被模型压缩成少数代表性用例。拆解策略参考「从测分生成用例」的精简原则：先识别可测需求点，过滤背景/目标/过程项，再生成 UI 友好的原子步骤；默认全量覆盖，不主动抽样。`--max-generated-cases` 默认 **0（不限制总数）**，`--cases-per-doc-chunk` 默认 **0（不限制每片段条数）**；若用户明确要求只抽样或冒烟测试，才设置较小数值。可用 `--doc-chunk-chars` 调整片段大小。

**PRD/需求拆解质量门禁**：需求文档输入不是直接把每个标题变成 quick 任务。拆解器会按类似 15 列用例规范的字段先产出结构化记录，并做确定性后处理：
- **过滤文档元信息**：变更记录、修订记录、需求背景、产品目标、长期目标、常态化运营、需求列表链接、图示占位等不作为产品 UI quick 用例；误生成时会标记 `ui_auto=false`。
- **保留可执行 UI 点**：只让具备明确页面对象、可见操作、可观察断言的记录进入执行；步骤必须是一组原子动作，预期必须能判定成功/失败。
- **显式标注 fixture 风险**：凡依赖已存在标签/文件/知识库、已发布知识、上传样例文件、处理成功任务、特定权限或状态，会写入 `fixture_required/fixture`，便于审查为什么某条 quick 可能失败。
- **入口来源稳定**：批量文档执行会优先把合法配置来源中的 `QUICK_URL` / `--target-url` 写入每条 query 前缀，避免 PRD 或历史材料中的环境域名抢占目标入口。

**原始用例追溯**：当输入是 PRD / 需求文档 / 测分文档，或输入是 `.md/.xlsx/.csv/.tsv` 用例集合时，脚本会在执行前写出每条测试的“原始用例”产物，便于审查“本次 quick 到底执行的是哪条用例”。批量总览在 `quick/batch/original_cases.md` 与 `quick/batch/original_cases.json`；每条用例单文件在 `quick/batch/original_cases/<case_id>.md`；对应执行日志目录也会写入 `quick/logs/<case_id>/original_case.md`。`quick/batch/results.md` 会附带 `original_case_path`。

**固定上下文与辅助参考**：

- **`config/prompt_context/`**：页面特性注入目录（**用户自备**）。普通 quick 默认只选 **`global_readme.md`** 并摘要为 `quick/context/prompt_execution_hints.md` 注入 query，用于放全局通用业务禁忌、全局登录/断言口径等。该目录下其它特定业务文件（如某产品、某站点、某模块说明）不会默认带入；只有用户当次请求明确说“参考 xxx.md”、写出文件 stem（如 `product_readme`）或完整路径时才会加入本次 prompt_context。目录为空或无 `global_readme.md` 时始终不传递。**冒烟走查/页面巡检默认不注入该目录**，避免固定业务系统提示污染跨站点模块盘点；用户若确需业务定制，应写在当次请求中并显式点名文件。Agent **禁止**擅自在此目录创建或改写文件（见上文「上下文目录由用户管控」）。
- **`config/perference_context/`**：失败修复参考目录（按用户约定拼写 `perference`，**用户自备**）。该目录下资料**仅在 quick 失败后**由 `run_quick_mode.py` 摘要并参与 `rewrite_retry_query`，**不直接写入首次 query/YAML**。适合放图谱目录摘录、产品白皮书、代码库说明、需求/设计文档等。失败后脚本会先结合原始目标与 observe 卡点筛选“当前失败相关修复重点”，只把缺失前置、导航纠偏、页面禁忌、控件文案、等待/切换策略、断言口径等少量信息送入改写器；不把大段背景资料整体塞入 retry query。首轮成功时白皮书等**不会**进入 browser-use 任务。Agent **禁止**擅自在此目录创建或改写文件。
- **`--context`**：只表示用户当次显式提供的参考资料。仅当 `config/perference_context/` 为空时，脚本把 `--context` 摘要写入本次运行的 `quick/context/perference_context_summary.md` 并作为失败修复参考；若 `config/perference_context/` 非空，`--context` 不进入 quick query，也不会覆盖固定参考目录。
- **禁止**：主动扫描 `.skill-output`、历史 quick YAML、历史 README、其它项目文档作为上下文；不得把本地参考文件地址、参考文件全文或“参考文件：...”拼进 quick query；**禁止** Agent 未经用户要求向 `prompt_context/`、`perference_context/` 写入或从历史产物复制上下文文件。

```bash
"$PY" /path/to/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py \
  --input "/path/to/测试用例汇总.md" \
  --context "/path/to/product-docs" \
  --context "/path/to/exploration/recursive" \
  --output-dir "$OUT"
```

**CDP / 有头无头策略**：quick 的连接模式与浏览器可见性彼此独立。用户未显式说明时，`run_quick_mode.py` 默认 **非 CDP + 无头**，即新启浏览器、不附着本地 Chrome、不展示浏览器窗口。只有用户明确提到 **本地登录态、调试、本地浏览器、已有 Chrome、CDP** 等语义时才追加 **`--cdp`**；只有用户明确提到 **有头、可视化、打开浏览器观察** 时才追加 **`--headed`**。脚本也会从 `--query` / `--user-query` / `--task-prefix` 中识别这些语义并自动切换；但 Agent 调用时仍应显式传参，避免歧义。`--no-cdp` / `--headless` 保留为兼容旧命令，但默认已经等价于非 CDP + 无头；用户说「有头模式」只影响 headless，不代表必须 CDP；用户说「非 CDP 有头」时只使用 `--headed`，不要追加 `--cdp`。若 CDP 未启动且用户要求 CDP，先提示用户在 macOS 启动：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  '--remote-allow-origins=*' \
  --user-data-dir="$HOME/.browser-use/cdp-chrome"
curl http://127.0.0.1:9222/json/version
```

用户持续未打开 CDP，或明确要求新浏览器 / 非 CDP 执行时，不追加 `--cdp`；用户明确要求可视化时追加 `--headed`，否则保持默认无头。

**失败回改策略**：每条 quick 失败后执行 `browser-use observe`，观察文件落在 `quick/observe/`；CDP quick 使用实时 `observe --output`，`--no-cdp` quick 使用 3.1.6 的 `observe --no-cdp --log-dir <attempt_log_dir> --output` 从 quick history 最后截图生成观察结果。脚本会读取 observe JSON，并先从 `config/perference_context/` 或显式 `--context` 中筛选与当前失败直接相关的修复重点，再生成**消化后的独立 retry query**；不得把“上一次执行未完成”“当前页面 URL/标题”“请结合观察结果文件 xxx.json”这类诊断文本、外部路径或无关背景写入 quick query / quick_task YAML。每次筛选说明、改写建议与最终 query 写入 `quick/rewrite/*_advice.md`、`*_query.txt` 供审查。默认最多 1 次 observe 驱动重试（由 `QUICK_MAX_RETRIES` 控制）；批量模式中单条失败不阻断后续记录。

**CDP 自愈成功后的回归归档（必读）**：

- **CDP 模式**下，第 2 轮及以后的 quick **默认 `--resume` 续跑**（接同一 CDP 标签页），与 observe 自愈链路一致。
- 当经历至少一轮失败，且**最终在某次续跑轮成功**时，`run_quick_mode.py` 会结合**原始 query**与各轮 attempt query **自动合成**一条「**单次 quick、非续跑**」回归任务，写入 **`quick/logs/<case_id>/regression/`**：
  - `<case_id>_regression.yaml`（`target.url` + `aiQuick`，供归档与后续回归）
  - `<case_id>_regression_query.txt`
  - `<case_id>_regression_notes.md`（合成说明与各轮轨迹）
- **不会在归档后自动再跑验证**；向用户说明归档路径即可。用户明确要求「验证归档 / 跑回归 / 存档复跑」时再执行该 YAML 或 query。
- 合成目标：一次 quick 即可复现原始断言，**不依赖**续跑现场残留；必要时在 query 中写明新建会话等步骤。
- **首轮即成功**或 **`--no-cdp`**：**不生成** regression 产物。

**控制台过程日志**：`run_quick_mode.py` 会打印 `[quick]` 前缀的进度日志，包括上下文来源、解析出的记录数、每条 case 开始、每轮执行 query 分隔块、失败返回码、observe 摘要、改写建议路径、下一轮 retry query 与最终汇总。每次调用 browser-use quick 前，完整 query 同步写入 `quick/logs/<case_id>/attempt_<n>/attempt_query.txt`；每轮结束后无论成功/失败都会打印本轮结果摘要、`quick_task_result*.json`、HTML 报告与 quick YAML 路径。控制台日志用于用户感知进度，完整 query / advice / results 仍以 `quick/logs/`、`quick/batch/`、`quick/rewrite/` 产物为准。

---

## 安装

**首次使用或环境缺失时，按以下顺序安装。**

### 执行环境策略（默认本机 · 沙箱仅用户指定）

在 Claude Code、Cursor Agent 等**带沙箱**的框架里，须区分两种模式；**用户未特别声明时，一律按「本机模式」执行。**

| 模式 | 何时启用 | Agent 行为 |
|------|----------|------------|
| **本机模式（默认）** | 用户**没有**明确要求只在沙箱/隔离环境跑 | **目标**是尽量使用用户**本机已安装、可持久**的 Python 与依赖（与后续 CLI 同一解释器）。**权限**：**不强制**首轮或每次终端调用都必须 `required_permissions: ["all"]`（或平台最高权限）；按**当前 Agent / IDE 实际能力**选择——若默认终端已能访问本机环境则直接检查与执行；若明显落在受限沙箱且检查/安装/CLI 失败，则**引导用户**：（1）在 IDE 中为相关命令**放宽权限**（若平台提供「全部 / 非沙箱 / 本机」等选项可择机勾选），或（2）到**系统终端**按「安装」节完成依赖并设置 **`UI_TEST_PYTHON`**，再在 Agent 中继续。**禁止**在已判定无效的受限环境里**无意义循环** `pip install`；**不要**假定沙箱内一定能配齐持久 Chromium。 |
| **沙箱模式（显式 opt-in）** | 用户**明确**要求，例如「只在沙箱执行」「不要申请本机权限」「用当前 Agent 容器环境即可」等 | 将 **`PY`** 视为当前受限 shell 的解释器（或用户指定的容器内 Python），**仅在该环境**内做检查与（在平台允许范围内）安装尝试。若缺少依赖、Playwright/Chromium 或网络：**说明**真实 UI 自动化通常需要本机浏览器与持久环境；请用户 **(A)** 改为在本机环境执行（含酌情放宽 IDE 权限），或 **(B)** 接受沙箱内能力上限（可能无法跑通）。**禁止**为「默认流程」在受限沙箱里循环 `pip install`。 |

**用户对权限未表态时**：Agent **简短说明**依赖本机 Python、Playwright 与网络即可；**按环境决定**是否先尝试当前默认终端，失败再引导**开放配置**（IDE 权限）或**本地配置**（系统终端 + `UI_TEST_PYTHON`），**不要**把「必须申请最高权限」写成硬性前置条件。

可选约定：用户可在会话中声明「本机执行」或「沙箱执行」；未声明即**本机模式**。

### 沙箱与持久解释器（Claude / IDE 受限执行，必读）

**问题**：在 Claude Code、Cursor Agent 等环境中，若命令落在**受限沙箱**或**临时解释器**上，反复执行 `pip install` 往往写入**不持久**的 `site-packages`，下一轮对话或下一次工具调用仍报「未安装」，形成无效重装。**默认应避免把检查与 CLI 放在这种环境里**（见上表「本机模式」）；仅用户指定沙箱模式时才以沙箱为唯一目标环境。

**约定 —— 下文「`PY`」**：执行本 Skill 中一切检查、`PY -m browser_use.cli`、`PY -m pip …` 时，**优先**使用环境变量 **`UI_TEST_PYTHON`**（若已设置且非空，值为 python 可执行文件的绝对路径，如 `~/.venvs/ui-test-assistant/bin/python3`）；未设置时 **`PY` = `python3`**（以当前 shell 解析为准）。检查脚本亦支持兼容变量 **`UI_TEST_ASSISTANT_PYTHON`**（与 `UI_TEST_PYTHON` 二选一即可）。

**多 Python 环境与裸 `pip`（必读）**：macOS/Linux 上常见 **`python3` 指向 Conda/系统旧版，而 `browser-use` 装在另一套 `python3.11` / `python3.12` 等**。此时在终端执行**裸 `pip` / `pip show browser-use`** 会走到与将要跑 CLI 的 Python **不同的** site-packages，产生「pip 显示未安装、但 `python3.12 -c "import browser_use"` 正常」的假阴性。**禁止**用裸 `pip` 做依赖检测；须使用 **`"$PY" -m pip …`**（`PY` 与将要跑 CLI 的解释器一致），或 **`"$PY" -c "from importlib.metadata import version; print(version('browser-use'))"`**，或运行本技能包内 **`package/scripts/check_ui_test_env.py`**（未设 `UI_TEST_PYTHON` 时，脚本会在 PATH 上依次尝试 `python3.x`，自动选中 **Python 3.10–3.13**、已装 browser-use **3.1.6** 且可 `import browser_use` 的解释器，并提示 `export UI_TEST_PYTHON=…`）。

**推荐（一次性解决）**：在本机**系统终端**（非受限沙箱）用 **Python 3.10–3.13** 中**已有或新装**的解释器创建固定 venv（**无现成合适环境时，仍推荐 Python 3.10** 建 venv，与历史联调一致），之后在 Agent 会话或 shell 中 `export UI_TEST_PYTHON=$HOME/.venvs/ui-test-assistant/bin/python3`（路径按实际填写）：

```bash
python3.10 -m venv ~/.venvs/ui-test-assistant   # 或 python3.11 / python3.12 / python3.13
~/.venvs/ui-test-assistant/bin/python -m pip install -U pip
~/.venvs/ui-test-assistant/bin/python -m pip install <repo>/vendor/browser-use/browser_use-3.1.6-py3-none-any.whl
~/.venvs/ui-test-assistant/bin/python -m playwright install chromium
export UI_TEST_PYTHON=$HOME/.venvs/ui-test-assistant/bin/python3
```

**Agent 强制规则**

- **本机模式（默认）**：运行 `browser_use.cli`、Playwright、探索/任务 Python 脚本、`check_ui_test_env.py` 时，**优先**使命令落在用户**本机持久** Python 上；**是否**申请 `required_permissions: ["all"]`（或平台最高权限）**由当前环境与失败现象决定**——能跑通则不必强求；受限失败时引导用户**放宽 IDE 权限**或到**系统终端**用同一 `PY` 安装并设置 `UI_TEST_PYTHON`。
- **`pip install` / `playwright install`**：用与 CLI **同一** `"$PY"` 执行；**禁止**在明显无效的受限沙箱内**循环**装包。若当前环境装不上或装完仍不可用 → 引导**系统终端**安装 + `UI_TEST_PYTHON`，或请用户在 IDE 中**开放相应命令权限**后重试。**沙箱模式**下：仅用户 opt-in 时在受限环境尝试，失败即停止并引导改本机或接受无法跑通。
- **工作区标记文件不能代替真实包**：不得在仅写入「已安装」类标记后跳过 `import browser-use` 级校验。

### 0. Python 版本（**3.10–3.13**；优先使用本机已有满足项）

**browser-use** 仓库 `pyproject.toml` 一般声明 **requires-python `>=3.10,<4.0`**。本技能将可执行范围**明确为 Python 3.10–3.13（含）**；**同一**解释器上安装 **browser-use==3.1.6** 与 Playwright。**优先**：本机若已有 **3.10–3.13** 且可装依赖，直接使用并设 **`UI_TEST_PYTHON`**。**若无**任何可用的 3.10–3.13，再**推荐安装 Python 3.10** 建 venv（与技能历史联调一致），勿将「只能用 3.10」当作唯一口径。对 **`PY`** 自检：

```bash
PY="${UI_TEST_PYTHON:-python3}"
"$PY" -c "import sys; v=sys.version_info; assert (3,10)<=v[:2]<=(3,13), '需要 Python 3.10–3.13'; print(f'OK: {v.major}.{v.minor}.{v.micro}')"
```

若断言失败：**不要**在低于 3.10 或高于 3.13 的解释器上继续装本技能依赖；引导用户换用 **3.10–3.13** 之一，或**新装 Python 3.10**（如 macOS Homebrew `brew install python@3.10`、[pyenv](https://github.com/pyenv/pyenv)、或从 [python.org](https://www.python.org/downloads/) 安装 3.10），并确保 **`PY`** / **`UI_TEST_PYTHON`** 指向该解释器。

**一键检查（推荐）**：在已克隆或已安装的技能目录下执行（可先 `export UI_TEST_PYTHON=…`）：

```bash
python3 path/to/skills/ui-test-assistant-skill/package/scripts/check_ui_test_env.py
```

未设置 `UI_TEST_PYTHON` 时，脚本**先**校验运行该脚本所用的解释器；若不满足，**再**在 PATH 上探测 `python3.20`…`python3.10` 及 `python3`（去重），直到找到同时满足 **Python 3.10–3.13**、browser-use **3.1.6（固定）** **且可 `import browser_use`** 的解释器（避免仅装了包元数据但缺 **socksio** 等传递依赖）；若选中者与运行脚本的解释器不同，会打印建议的 `export UI_TEST_PYTHON=…`。设置 `UI_TEST_PYTHON` 后则**仅**校验该变量指向的解释器。失败时含沙箱/持久环境与「勿用裸 pip」提示。

### 1. 安装 browser-use（固定 **3.1.6**）

使用 **`==3.1.6`** 安装，**勿**使用宽松的 `>=…` 范围约束，以免 `pip` 解析到非本技能联调版本；算法侧能力与联调以 **3.1.6** 为准。

#### 为何「第一次 `pip install` 会失败」？

| 现象 | 常见原因 |
|------|----------|
| `No matching distribution found for browser-use==3.1.6` 或 `from versions: none` | 本技能的 3.1.6 是内置 SDK，公网 PyPI 通常不提供。使用仓库 `vendor/browser-use/` 中的固定 wheel；不要安装其它同名版本替代。 |
| 公网能装上 `browser-use`，但版本是 `0.x` | PyPI 上同名包为**另一条发布线**，**不能**替代 **`browser-use==3.1.6`**；混用会导致与本 Skill、YAML 引擎行为不一致。 |
| 安装本地 wheel 仍失败 | 检查 **Python 须为 3.10–3.13** 且 **`"$PY" -m pip install`** 与跑 CLI 的 `PY` 为同一解释器（勿用裸 `pip`）。 |

**须与后续执行 CLI 使用同一解释器**（建议已设 `UI_TEST_PYTHON` 或明确 `PY`）：

```bash
PY="${UI_TEST_PYTHON:-python3}"
# 使用仓库内置、经过净化和哈希校验的 SDK wheel
"$PY" -m pip install <repo>/vendor/browser-use/browser_use-3.1.6-py3-none-any.whl
```

**若 `python -m browser_use.cli` 或 `import browser_use` 报 `No module named 'socksio'`**（部分环境下 httpx 的 SOCKS 可选依赖未装齐）：在同一解释器执行 `"$PY" -m pip install socksio`，或 `"$PY" -m pip install 'httpx[socks]'`。`check_ui_test_env.py` 会在版本校验后做一次 `import browser_use`，缺依赖时会打印上述命令。

### 2. 准备浏览器可执行文件

默认 Profile 使用 Chromium：

```bash
PY="${UI_TEST_PYTHON:-python3}"
"$PY" -m playwright install chromium
```

当配置中心选择 Firefox Profile 时，执行链通过统一的 browser-use
`BrowserProfile` 使用 Playwright Firefox launcher。普通系统 Firefox 不包含
Playwright 所需的 Juggler 协议，不能作为 `executable_path` 直接驱动；
`BU_FIREFOX_PATH` 仅用于本机安装发现，实际执行前必须安装配套 Firefox：

```bash
"$PY" -m playwright install firefox
BU_BROWSER_TYPE=firefox
BU_FIREFOX_PATH=/Applications/Firefox.app/Contents/MacOS/firefox
```

Firefox 仍必须选择 `firefox` Profile，不能把路径写入 `BU_CUSTOM_BROWSER_PATH`
后按 Chromium launcher 启动；差异只在 Profile 的 `playwright_browser` 字段。

### 3. 配置 .env

在 **`{技能根}/config/.env`** 中配置（探索/任务模式共用）。亦可使用项目根 `.env`，但须保证执行 `browser_use.cli` 时通过 `DOTENV_PATH` 或工作目录能加载到与 **`config/.env`** 等价的内容。

#### 探索模式与模型（页面分析 / 用例设计 / YAML 生成）

- **browser-use==3.1.6** 探索入口为 **`CaseGeneratorAgent`**（`browser_use/case_generator/agent.py`）：打开 URL → `PageAnalyzer` → `CaseDesigner` → `YamlGenerator` 写文件；各阶段 LLM 由 `build_models()` 与 **进程环境**决定。**程序化调用**须 **`load_dotenv` 早于首次 `import browser_use`**，且**勿**依赖无参 `CaseGeneratorAgent()`（见下文「`chat_models` 导入顺序与 `build_models`」）；**不得**在已配置上述变量时仍向用户索要 `GOOGLE_API_KEY`、`GEMINI_API_KEY` 或反复提示配置 Gemini。
- **模型配置**：`BU_OPENAI_API_BASE` 与 `BU_OPENAI_API_KEY` 必须成对配置，模型名由 `BU_*_MODEL` 变量指定。配置有效时直接执行；仅在服务明确返回认证、配额或端点错误时提示用户修正配置。

#### Skill 默认模板（仅当 `config/.env` 不存在时创建整文件）

**首次**发现 **`config/.env`** 不存在时，可从同目录 `config/.env.example` 复制。公开模板不预置 API 地址或凭据；执行前须填写本人可访问的兼容模型端点、密钥，并确认该端点提供所选视觉模型。

```bash
## 模型配置
BU_OPENAI_API_BASE=
BU_OPENAI_API_KEY=
# 默认模型
BU_ACTOR_MODEL=qwen3.7-plus
BU_PLANNER_MODEL=qwen3.7-plus
BU_ASSERTER_MODEL=qwen3.7-plus
BU_PAGE_EXTRACTION_LLM=qwen3.7-plus
BU_LOCATING_LLM=qwen3.7-plus
BU_CODING_LLM=qwen3.7-plus

# 快速测试 quick 配置（可选）
QUICK_URL=
BU_LOCAL_BROWSER_CDP_URL=http://127.0.0.1:9222
QUICK_USERNAME=
QUICK_PASSWORD=
QUICK_MAX_STEPS=40
QUICK_MAX_RETRIES=1
RECURSIVE_INTENT_EXECUTOR=hybrid
RECURSIVE_INTENT_QUICK_MAX_STEPS=40
RECURSIVE_INTENT_QUICK_NO_CDP=false

# 本用例登录（由用户在对话中提供，仅保存在本地 .env）
USERNAME=
PASSWORD=

SENSITIVE_VARIABLES=USERNAME,PASSWORD,QUICK_USERNAME,QUICK_PASSWORD
ANONYMIZED_TELEMETRY=false
```

若 `config/.env` 已存在，只做增量更新，不要整文件覆盖，也不要将已有 `BU_OPENAI_*` 配置写为空。

**用户名与密码：通过 `--username` / `--password` 传入，或在 .env 中配置**

- **如需登录**：优先通过 `run_quick_mode.py --username <账号> --password <密码>` 传入，无需手动编辑 .env。也可在 `.env` 中配置（如 `USERNAME`、`PASSWORD`），并在 YAML 中用占位符 `${USERNAME}`、`${PASSWORD}` 表示，不在指令或用例中写明文。
- **`--username` / `--password` 机制**：`run_quick_mode.py` 会将 CLI 传入的值写入 `USERNAME`、`QUICK_NAME`、`QUICK_USERNAME`、`PASSWORD`、`QUICK_PASSWORK`、`QUICK_PASSWORD` 等环境变量，供 browser-use 子进程自动登录。凭据仅存在于进程环境变量中，不会写入 .env 文件或产物文件。
- **必须配置 SENSITIVE_VARIABLES**：把账号、密码对应的环境变量名写进 `SENSITIVE_VARIABLES`（逗号分隔，如 `SENSITIVE_VARIABLES=USERNAME,PASSWORD`）。列入敏感字段后，全程会加密处理，**不会将明文传给模型**。
- **重要**：若账号密码直接传给模型，**强制会执行失败**。未配置 SENSITIVE_VARIABLES 时，占位符会在加载阶段被替换成明文，模型会看到密码且导致执行失败。
- **`CaseGeneratorAgent.run()`** 不接账号密码参数；YAML 中的占位符凭据仅在 **.env** + `SENSITIVE_VARIABLES` 中配置。可选 `login_config`（如含 `task_file`）行为以当前库实现为准，复杂登录优先**任务模式**登录用例。
- **公开页面无需登录**：加 `--no-login` 跳过凭据检查即可，**不得**因 .env 缺少 USERNAME/PASSWORD 而阻断执行。

---

## 前置环境检查

**探索模式与任务模式执行前，Agent 必须完成以下检查。** 令 **`PY`** = `UI_TEST_PYTHON`（若已 export）否则 `python3`。

**执行环境**：默认按「安装 · 执行环境策略」的**本机模式**——在 IDE/Agent 内跑检查、安装与 CLI 时**按实际环境选择权限**；若受限失败，引导用户**开放 IDE 配置/权限**或**本机系统终端**完成安装与 `UI_TEST_PYTHON`。**仅当用户已明确要求沙箱模式**时，才以受限环境为主做检查，失败时按该策略说明上限或引导改本机。

| 步骤 | 检查项 | 检查命令 | 不通过时动作 |
|------|--------|----------|--------------|
| 1 | Python **3.10–3.13** | `"$PY" -c "import sys; v=sys.version_info; assert (3,10)<=v[:2]<=(3,13)"` 或 `python3 <技能目录>/package/scripts/check_ui_test_env.py`（可配合已 export 的 `UI_TEST_PYTHON`） | **禁止**在低于 3.10 或高于 3.13 的解释器继续装包或跑 CLI；引导换用 **3.10–3.13** 中已有环境，或**新装 Python 3.10**（见「安装」第 0 步） |
| 2 | 执行环境 | - | **本机模式（默认）**：按环境尝试检查/安装/CLI；受限失败 → 引导**开放 IDE 权限**或**系统终端**执行，勿默认在沙箱循环 `pip install`。**沙箱模式**：仅用户指定；不通过则引导本机或说明上限 |
| 3 | browser-use 已安装且为 **3.1.6** | **优先**运行 `check_ui_test_env.py`；或 `"$PY" -c "from importlib.metadata import version; print(version('browser-use'))"` | 客户端使用内置 Runtime；源码环境运行 `npm run prepare:ui-test-runtime` 安装仓库内固定哈希 wheel，禁止按包名从公网获取替代版本 |
| 4 | CLI 可用 | `"$PY" -m browser_use.cli --help` | 若失败 → 确认 `PY` 与安装包时一致；再排查版本与 Playwright |
| 5 | Playwright 浏览器 | 执行时若报浏览器不存在 | 默认执行 `"$PY" -m playwright install chromium`；Firefox Profile 执行 `"$PY" -m playwright install firefox` |
| 6 | .env 配置 | 检查 `BU_OPENAI_API_BASE`、`BU_OPENAI_API_KEY` 与 `BU_*_MODEL`；如需登录，账号密码须列入 `SENSITIVE_VARIABLES`，或由 `--username` / `--password` 传入。已有 `.env` 只做增量更新 | 缺失时从 `config/.env.example` 创建并引导用户填写自己的模型服务配置；公开页面可用 `--no-login` 跳过凭据检查 |

**检查流程（Agent 执行）：**

1. 判断**本机模式（默认）**或**沙箱模式**（仅用户明确指定时）；未指定则**本机模式**。
2. 确认将用 **`PY`** 执行后续 CLI；若用户已有本机 venv，可提示其 `export UI_TEST_PYTHON=…` 后再继续。
3. **本机模式**：**优先**运行技能包内 `package/scripts/check_ui_test_env.py`；终端权限**按平台与用户环境决定**，不强制首轮即最高权限。**沙箱模式**：仅在用户要求下用受限环境运行检查。
4. 若检查失败：**本机模式**下先判断是否受限/路径不对 → 可建议用户在 IDE 中**放宽该命令权限**后重试；仍失败则输出**本机 Terminal 可复制**的安装步骤与 `UI_TEST_PYTHON`，**禁止**在沙箱内为默认流程反复 `pip install`。**沙箱模式**下说明局限并引导改本机或本地安装。
5. 运行 `"$PY" -m browser_use.cli --help` 确认 CLI 可用（与后续执行使用相同环境与权限策略）。
6. 若执行用例时报浏览器缺失，默认用 `"$PY" -m playwright install chromium`；Firefox Profile 用 `"$PY" -m playwright install firefox`（受限时改系统终端或放宽权限后重试）。
7. 若缺 **`config/.env`** → 从 **`config/.env.example`** 复制并写入「安装」第 3 步默认模板，或等用户自配；**已满足有效 API 组合时不得**反复提醒配置 Gemini/Google Key，**不得**因 wheel 内 Gemini 默认描述要求用户增配 **`BU_OPENAI_*`**。

**执行模式**：**探索模式与任务模式均默认启用无头模式**（`headless=True`）。用户明确要求「有头模式」「打开浏览器观察」时使用 `headless=False`。

**前台执行（避免「卡住却看不到」）**：递归探索脚本属于长时任务。**默认不要 `nohup …&` 后台启动**——意图任务、LLM 重试、Playwright 等待时进度行间隔较长，后台会让用户误以为「卡死」。建议在 IDE Agent / 终端**前台**运行，并：

```bash
export PYTHONUNBUFFERED=1
"$UI_TEST_PYTHON" package/scripts/run_recursive_exploration.py ... \
  --progress-log-interval-seconds 5
```

调小 `--progress-log-interval-seconds`（默认 12s）可让 `[explore]` 进度行更密；如需更彻底排障，可 `RECURSIVE_EXPLORATION_LLM_RETRY_MAX_PERSISTENT=1` 让 401 / DNS 类持久错误**首发即失败**。

**LLM 重试策略（`package/recursive_exploration/llm_retry.py`）**：内置错误分类——
- **persistent**（鉴权 401/403、`服务未授权`、DNS `nodename nor servname`）：默认仅 **2 次**尝试，直接抛出并打印一行排障提示，**不会**长时间无效重试；
- **transient**（429、APITimeout/InternalServerError、瞬时连接错误）：使用 `--RECURSIVE_EXPLORATION_LLM_RETRY_MAX`（默认 5）做指数退避；
- **其他**（`ValueError` 等）：**不重试**，立即抛出。

`browser-use` 内部 `agent.max_llm_retry` 默认改为 **3**（旧值 6 会与外层 wrapper 叠成 30 次）。如需恢复旧值或调整，可设环境变量 `RECURSIVE_EXPLORATION_AGENT_MAX_LLM_RETRY`。

**LLM 全局并发闸门 + 节流（缓解 OpenAI-compatible provider 网关并发抖动 401）**：所有经 `ChatModelRetryWrapper` 包装的 LLM 调用共享一把全局信号量与最小调用间隔。
- `RECURSIVE_EXPLORATION_LLM_MAX_CONCURRENCY`（默认 **2**）：同时进行的 `invoke` / `ainvoke` 上限。actor + locating_llm 并发抢占网关时，把它降到 1 通常能立刻消除偶发 401「服务未授权」；
- `RECURSIVE_EXPLORATION_LLM_MIN_INTERVAL_MS`（默认 **0**）：相邻 LLM 调用之间至少留多少毫秒间隔（同一进程内）。配额抖动严重时设到 200~500 ms 即可。

**截图稳定性**：`RelaxedLoadBrowserContext.take_screenshot` 在 `wait_for_load_state` 之外，再等一次 networkidle + 短暂静默：
- `RECURSIVE_EXPLORATION_SCREENSHOT_NETWORKIDLE_MS`（默认 6000 ms）：截图前的 networkidle 等待上限；
- `RECURSIVE_EXPLORATION_SCREENSHOT_QUIET_MS`（默认 400 ms）：networkidle 后再追加的静默窗口，避免「骨架屏未替换为真实内容」时取样。

**URL 入队两层去重 + 预算消耗顺序**：
1. 「URL 等价键」（path + 参数名集合）：同一路径且 query 参数名集合一致的 URL 视为同站点同页面；
2. 「页面结构指纹」（`structural_state_id` = 标题 + landmark）：URL 完全不同（如 `/keng/qa` 与 `/keng/qa?...`）但渲染同一页面时也只探索一次，写出 `url_skip_state_dup` 审计；
3. `--max-new-urls` 预算严格按 **DOM 发现顺序**消耗：先发现的 URL 入队，**不会**因为后发现的 URL 抢占预算而被丢。

**意图任务（intent_mission）规划与入队时机**：意图任务**依赖前置探索成果**才有价值，故默认走「late 规划」：
- 锚点开始时**不再**调用 LLM 规划意图（此时 graph 还没积累成功边）；
- 锚点的 **phase A 单步队列**（含每步成功后的 **DOM 扩列入队**，即「队列新增」；**不是** composite / graph_guided **播种**）彻底排空后，重新打开一个 ctx 拍最新 obs，**用累积的 graph + 页面观测做 LLM 规划**，再以 `queue.append` 注入队尾；
- 审计事件 `intent_mission_enqueue` 上携带 `phase=late`，便于与早期模式区分；
- 仅 `intent_missions_execution_only=True`（不跑探索单步、只跑意图）时仍走 anchor_start 早期规划。

**续跑（resume）默认行为**：在断点处**原样**继续，不主动改变 `--max-actions` / `--max-new-urls` 等参数语义，避免「网络抖动恢复后改了参数反而又重跑入口 URL」。当用户**显式**追加 `--resume-reopen-entry-on-higher-budget` 且本次预算更大时，才会把入口 URL 加回 pending 消耗新预算。

**中断后续跑**：对有 **`session_state.json`** 的产物目录执行  
`"$PY" package/scripts/run_recursive_exploration.py --resume-session "<RUN_TS>/exploration/recursive" ...`  
（同上节须 `export DOTENV_PATH`）；本次命令行传入的 `--max-actions`、`--max-total-actions`、`--screenshot-remove-highlights` 等会经 **`_overlay_cli_config_on_resume`** 覆盖快照里对应字段。**strict 模式**：`session_state.json` 中的 **`current_anchor`**（队列快照 + `strict_resume_phase`）在 URL/深度匹配时用于 **从断点继续**，无需整段重跑首轮枚举；非 strict 或快照不匹配时仍按会话其余状态恢复。**要确认 intent 已全部消费**：看进程**自然退出**，或 **`agent_unified.log`** 中各 `intent_mission` 的 `END` 与 **`session_state.json`** 的 `status`。

**禁止无故中断长跑（Agent 必读）**：`run_recursive_exploration.py`、`CaseGeneratorAgent`、批量 `browser_use.cli`、`package/scripts/run_yaml_repair.py` 等可能长时间运行；末尾 **intent_mission** 常占大量时间。用户**未**明确要求「中止 / 限时 / 只要部分产物」时，Agent **禁止**为「尽快交付可读半成品」而对进程 **`kill` / `SIGTERM`**（含 IDE 中止）或建议用户中途放弃。**应让任务自然跑完**；若宿主环境对单次前台命令限时，改用**后台 Shell**（`run_in_background`）、`PYTHONUNBUFFERED=1`，并指引用户 **`tail -f …/exploration/recursive/agent_unified.log`** 与 **`execution.log`** 观察进度。误中断后用上一段 **`--resume-session`** 续跑。

**URL 报告改为「全量发现概览」**：报告里的「URL 发现全量概览」面板会展示**所有**已发现 URL，并按标签分类：
- 「本次执行」（已 dequeue）/「本次待执行」（已 enqueue 未轮到）；
- 「预算外跳过」（受 `--max-new-urls` 限制）/「URL 等价去重」/「页面指纹去重」/「已访问」/「深度超限」；
- 来源 `queues.jsonl` 的 `url_enqueue` / `url_skip_budget` / `url_skip_state_dup` 等事件。被预算外跳过的 URL 直接给出原因，便于下次直接 `--resume-session` 调大 `--max-new-urls` 来增量补跑剩余 URL，无需手动追踪发现顺序。

**`browser_use.cli` 有头模式（必读）**：在 **browser-use==3.1.6** 下，CLI 外层 **`--headless false`** 可能**未**传入内层 Playwright **`launch()`**，浏览器仍按无头启动。须在整条命令**末尾**再追加 **`browser.headless false`**（空格分隔，作为 CLI 余参），内层才会按有头启动。无头时**不要**追加该项。

- 无头示例：  
  `"$PY" -m browser_use.cli --task-file <yaml> --headless true --log-dir <dir>`  
  且已 `export DOTENV_PATH="{技能根}/config/.env"`（路径按实际填写）。
- 有头示例：  
  `"$PY" -m browser_use.cli --task-file <yaml> --headless false --log-dir <dir> browser.headless false`

**Checklist Before Execution**：

- [ ] 已确定**本机模式（默认）**或用户显式**沙箱模式**；未声明则按本机模式
- [ ] 已确定 **`PY`**（`UI_TEST_PYTHON` 或 `python3`），且检查/安装/CLI 使用同一解释器
- [ ] **本机模式**：检查、pip、playwright、CLI 已在**当前环境**下尝试；若失败已引导**开放 IDE 权限**或**系统终端 + `UI_TEST_PYTHON`**（不强制每次最高权限）
- [ ] Python **3.10–3.13**：`check_ui_test_env.py` 或 `"$PY" -c "import sys; v=sys.version_info; assert (3,10)<=v[:2]<=(3,13)"`
- [ ] browser-use **3.1.6** **且可 import**：`check_ui_test_env.py`（推荐，含 `import browser_use` 与 socksio 等提示），或版本检测 + 手动 `"$PY" -c "import browser_use"`（**勿**裸 `pip`）
- [ ] Playwright 浏览器：默认 `"$PY" -m playwright install chromium`；Firefox Profile 已执行 `"$PY" -m playwright install firefox`
- [ ] `.env` 已成对配置 `BU_OPENAI_API_BASE` 与 `BU_OPENAI_API_KEY`，并设置可用的 `BU_*_MODEL`；登录凭据已列入 `SENSITIVE_VARIABLES`
- [ ] 执行模式：默认无头（用户可主动指定有头）

---

## 探索模式流程（Step E · 普通探索）

适用于 **普通探索模式**（单 URL、单轮 `CaseGeneratorAgent`）。**深度 / 遍历探索**见本节下方 **「递归探索」** 与 **`run_recursive_exploration.py`**。

1. **前置检查**：按上述完成环境、版本、Playwright、.env 检查
2. **调用 `CaseGeneratorAgent`**：默认 `headless=True`（无头），用户要求有头时用 `headless=False`
   - **推荐**：技能包内 **`package/scripts/run_exploration_case_generator.py`**（内部已 **先 `load_dotenv` 再 import `browser_use`**，并用 **`BU_*_MODEL` 显式 `build_models`** 后构造 Agent，避免无参 `CaseGeneratorAgent()` 踩默认 `gemini-2.5-flash`）。
   - 若手写 Python：**必须**遵守下文「`chat_models` 导入顺序与 `build_models`」；**禁止**在 `load_dotenv` 之前 `import browser_use`。
   - 建议：`output_dir="<工作区根>/.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases"`；`project_name` 可用简短英文/拼音便于区分批次
   - 输出：上述 `output_dir` 下 **平铺** 的 `01-xxx.yaml`、`02-xxx.yaml`…（数量由页面分析结果决定）
3. **是否执行（默认执行）**：
   - 用户表述为 **测一下 / 测试 / 帮我测试 / 验一下** 等典型「端到端验证」意图，且**未**说「只生成」「不要跑」→ **不得**询问；生成完成后**立即**进入步骤 4
   - 用户**明确**只要 YAML、不执行 → 跳过步骤 4，仅汇总生成结果路径
4. **批量执行用例**：按下方「批量执行（探索模式）」，对 `output_dir` 下**每个** `.yaml` **分别**一次 `--task-file`；**禁止**把多案合并进单次 CLI；若存在 `index.yaml` 且为索引专用，**不可**作为 `--task-file`；**本机模式**下按环境选择终端权限，失败时引导**放宽权限**或**系统终端**
5. **汇总报告**：读取 **`<RUN_TS>/exploration/logs/`** 下各子目录及 CLI 产物；公开 wheel 的探索阶段**不一定**产生 `reports/`，以 `execution.log` 与 logs 为准，输出 Markdown 表格

### 递归探索（深度 / 遍历探索模式 · 前置合并强制规则）

- **触发条件（强制）**：当用户在递归探索语境下明确提到“先执行某个 YAML / 前置步骤 / 登录前置 / 执行后再探索”等意图时，Agent **必须**同时执行两件事：
  1) 先独立执行该前置 YAML（满足用户“先执行”诉求）；  
  2) 启动 `package/scripts/run_recursive_exploration.py` 时显式传入 `--bootstrap-task-file <前置YAML路径>`，确保前置步骤被合并进后续每条 generated case（`bootstrap_prefixed=yes`）。
- **禁止遗漏**：仅执行前置 YAML、但递归探索命令未带 `--bootstrap-task-file`，属于错误行为，会导致后续 case 回到未登录态（常见表现：落到登录页、generated case 显示 `bootstrap_prefixed=no`）。
- **默认策略**：除非用户明确要求“不要合并前置到生成用例”，否则在上述触发条件下，`embed_bootstrap_in_generated_yaml` 保持默认开启（即不传 `--no-embed-bootstrap-in-yaml`）。
- **执行后自检（必须）**：至少抽查一条 `generated_cases/*.yaml`，确认 `description` 或元信息包含 `bootstrap_prefixed=yes`；若为 `no`，应立即停止并按正确参数重跑。

**统一汇总日志（排查 timeout / 中断必看）**：递归探索运行时会在产物目录下追加 **`agent_unified.log`**，按时间顺序汇总所有 UI agent（initial bootstrap、per-task bootstrap 重放、intent_mission 重放）以及 explorer/browser_use/controller 的日志。每次 agent 调用前后都有边界标记：

- `===== bootstrap_replay START subdir=… log_dir=… =====`
- `===== bootstrap_replay FAIL  subdir=… elapsed=… error=… =====`
- `===== bootstrap_replay END   subdir=… elapsed=… =====`
- `===== intent_mission START task_id=… yaml=… log_dir=… =====`
- `===== intent_mission FAIL  task_id=… elapsed=… error=… =====`
- `===== intent_mission END   task_id=… elapsed=… =====`

排查命令：

```bash
# 跟踪运行中的统一日志
tail -f .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/recursive/agent_unified.log

# 抓一次 run 里所有的失败/超时段落（含上下文）
rg -n "FAIL|❌ Timeout|RuntimeError|exploration_abort_exception" \
   .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/recursive/agent_unified.log -C 3

# 找到具体是哪个 task 的 bootstrap 重放阻塞
rg -n "bootstrap_replay (START|FAIL|END)" \
   .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/recursive/agent_unified.log
```

如发现「`bootstrap_replay FAIL` 出现在多次成功步之后」，常见原因：测试环境 Cookie/会话失效、后端短暂慢、SPA 跳转后入口 URL 不再含等待文案；解决方案优先调整前置 YAML（增大 `aiWaitFor.timeout`、显式登录、用更稳定的等待文案）或缩短探索时长。

**递归探索标准命令模板（含前置）**：

```bash
PY="${UI_TEST_PYTHON:-python3}"
export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"
cd <工作区根>

# 1) 先执行前置 YAML（不改文件）
"$PY" -m browser_use.cli \
  --task-file "<前置YAML路径>" \
  --headless true \
  --log-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs/bootstrap_$(date +%Y%m%d-%H%M%S)"

# 2) 再跑递归探索，并显式传 --bootstrap-task-file 合并前置
"$PY" package/scripts/run_recursive_exploration.py \
  --url "<目标URL>" \
  --output-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/recursive" \
  --bootstrap-task-file "<前置YAML路径>" \
  --exploration-depth 5 \
  --max-actions 100 \
  --max-total-actions 300 \
  --max-new-urls 5
```

### 批量执行（探索模式）

- **不合并**：`CaseGeneratorAgent` 输出为 `output_dir` 下每个 case 一个 YAML（如 `01-页面加载.yaml`）。若目录中存在仅作索引用途的 `index.yaml`，**不可**作为 `--task-file`。批量执行 = 对每个业务用例 `.yaml` 分别执行一次 CLI。扩展包若产出 `L0_首页/01_xxx.yaml` 等树形结构，规则相同：逐文件执行。
- **为何「批量跑 5 个只跑了 2 个」**：若误用一个 YAML 内包含多个 task（或误用合并后的文件），当前执行引擎行为是**按 task 顺序执行，任一 task 内任一步骤失败会抛错退出，后续 task 不再执行**。因此例如第 3 个 task 失败时，只会看到前 2 个执行完。要真正批量跑多个用例且互不影响，必须**每个 case 一个文件、每个文件执行一次**。
- **正确批量执行方式**：在项目根或能 `import browser_use` 的环境下，对 `cases/` 下各层级目录中的每个 `.yaml` 分别执行，例如：

```bash
# 在工作区根执行：对 CaseGeneratorAgent 平铺目录下每个用例逐个执行
PY="${UI_TEST_PYTHON:-python3}"
export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"   # 按实际技能根路径修改
cd <工作区根>
GEN=.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases
mkdir -p .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs
for f in "$GEN"/*.yaml; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .yaml)
  case "$base" in index) continue ;; esac
  echo "=== $f ==="
  "$PY" -m browser_use.cli --task-file "$f" --headless true --log-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs/${base}_$(date +%Y%m%d-%H%M%S)"
done
# 有头模式时，将 --headless true 改为 --headless false，并在行末追加： browser.headless false
```

或对单个用例：  
`PY="${UI_TEST_PYTHON:-python3}" && export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env" && cd <工作区根> && "$PY" -m browser_use.cli --task-file .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases/01-示例.yaml --headless true --log-dir .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs/single_$(date +%Y%m%d-%H%M%S)`。

**禁止**：`--log-dir` 指向 `<RUN_TS>/logs/...`（根下 `logs`）；必须落在 **`exploration/logs/`** 或 **`task/logs/`**。

### `CaseGeneratorAgent.run()`（参考实现：`browser_use/case_generator/agent.py`）

**实现位置**：`browser_use/case_generator/agent.py` 中 `CaseGeneratorAgent`。生成探索模式启动脚本时以该类为准。旧文档中的 **`TestAssistant`**（如 `case_generator/assistant.py`）仅存在于部分算法侧扩展构建；**与本技能配套的固定版本 `browser-use==3.1.6` 以 `CaseGeneratorAgent` 为准。**

**与旧 TestAssistant 的能力边界**（避免用户误以为已做多层级全站遍历时，实际仅为单 URL 一轮分析）：

| 能力 | CaseGeneratorAgent（3.1.6） | 部分扩展包 TestAssistant |
|------|-----------------------------|---------------------------|
| 入口 | 单 `url` → `PageAnalyzer` → `CaseDesigner` → `YamlGenerator` | 可含 `user_input`、`exploration_depth`、多层级队列 |
| 输出 | `output_dir` 下平铺 `01-xxx.yaml`… | 常见 `run_id/cases/L0_…` 与 `reports/` |

**`run()` 参数摘要**：`url`（必填）、`output_dir`、`project_name`、`login_config`（可选）、`browser_context`（可选）、`headless`。不接账号密码；凭据仅 `.env` + `SENSITIVE_VARIABLES`。

**把用户意图转成调用的规则**：

- **仅 URL 或「测一下 + URL」**：优先 **`package/scripts/run_exploration_case_generator.py`**；或手写脚本时 **`load_dotenv` → `build_models(BU_*…)` → `CaseGeneratorAgent(page_analysis_llm=…, …)`** 再 `run(...)`（**勿**无参 `CaseGeneratorAgent()`）
- **自然语言含多步路径 / 登录后再去某页**：无 `user_input` API → **任务模式**（task-case-generation），或请用户提供**目标页 URL** 再 `CaseGeneratorAgent`
- **强调业务模块名而无直达链接**：**任务模式** 描述步骤

**`chat_models` 导入顺序与 `build_models`（browser-use==3.1.6，必读）**

- `browser_use/agent/chat_models.py` 在调用 `build_models()` 时读取 `BU_OPENAI_API_BASE`、`BU_OPENAI_API_KEY` 与各角色模型变量，不在模块 import 时固化凭据。
- `CaseGeneratorAgent()` 无参时会调用 `build_models()`，3.1.6 公开 Runtime 的六个默认角色均为 `qwen3.7-plus`。CLI 和程序化入口使用同一公开配置契约；缺少 Base 或 Key 时会在构建模型阶段明确失败。
- **正确做法**：（1）**先** `load_dotenv(技能根/config/.env, override=True)`（或已 `export` 全部所需变量）；（2）**再** `from browser_use.agent.chat_models import build_models` / `from browser_use.case_generator import CaseGeneratorAgent`；（3）用 **`os.getenv("BU_ACTOR_MODEL", "qwen3.7-plus")`** 等对 **`build_models(actor=…, planner=…, asserter=…, page_extraction_llm=…, locating_llm=…, coding_llm=…)`** 显式传参；（4）取 **`aux["page_extraction_llm"]`**（与库内无参路径一致，三节共用同一 LLM），传入 **`CaseGeneratorAgent(page_analysis_llm=llm, case_design_llm=llm, yaml_gen_llm=llm)`**。

**探索模式调用示例（手写脚本，顺序不可调换）**：

```python
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

# 1) 必须先加载 .env，且在本块内尚未 import browser_use
workspace = Path("<工作区根>")
skill_env = workspace / "ui-test-assistant-skill/config/.env"  # 按实际技能根调整
load_dotenv(skill_env, override=True)

# 2) 再 import browser_use（触发 chat_models 构建 __factory__）
from browser_use.agent.chat_models import build_models
from browser_use.case_generator import CaseGeneratorAgent

RUN_TS = "<RUN_TS>"
out = workspace / f".skill-output/ui-test-assistant-skill-output/{RUN_TS}/exploration/generated_cases"
out.mkdir(parents=True, exist_ok=True)

def m(key: str, default: str = "qwen3.7-plus") -> str:
    v = (os.getenv(key) or "").strip()
    return v if v else default

page = m("BU_PAGE_EXTRACTION_LLM")
_, _, _, aux = build_models(
    actor=m("BU_ACTOR_MODEL"),
    planner=m("BU_PLANNER_MODEL"),
    asserter=m("BU_ASSERTER_MODEL"),
    page_extraction_llm=page,
    locating_llm=m("BU_LOCATING_LLM", page),
    coding_llm=m("BU_CODING_LLM", page),
)
llm = aux["page_extraction_llm"]

async def run_exploration():
    agent = CaseGeneratorAgent(
        page_analysis_llm=llm,
        case_design_llm=llm,
        yaml_gen_llm=llm,
    )
    written = await agent.run(
        url="https://example.com",
        output_dir=str(out),
        project_name="example_probe",
        headless=True,
    )
    return written  # List[Path]

asyncio.run(run_exploration())
```

**命令行等价（推荐）**：

```bash
PY="${UI_TEST_PYTHON:-python3}"
export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"   # 可选；脚本也会默认读技能根 config/.env
"$PY" "<技能根>/package/scripts/run_exploration_case_generator.py" \
  --url "https://example.com" \
  --output-dir "<工作区根>/.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases"
# 有头：追加 --no-headless
```

生成完成后，**默认**立即进入批量 `browser_use.cli`（见步骤 4）；仅当用户事先声明不要执行时跳过。

---

## 任务模式流程（Step T）

1. **输入类型判断**：
   - 已有 YAML 用例 → 跳至步骤 3 执行
   - 测试步骤 / 需求文档 / 可读取的在线文档链接 → 进入步骤 2，**按 task-case-generation.md 生成用例**
2. **用例生成**：按 [references/task-case-generation.md](references/task-case-generation.md) 执行，输出到 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/{项目名}/`**。**生成 YAML 时必须同时参考** [references/yaml-and-ui-operations.md](references/yaml-and-ui-operations.md)：采用其 YAML 结构（target/tasks/flow）、仅使用其中定义的 UI 指令与格式、遵守禁止项。
3. **前置检查**：同上述（browser-use 3.1.6、Playwright、.env）
4. **执行**：`export DOTENV_PATH="{技能根}/config/.env"`，`PY="${UI_TEST_PYTHON:-python3}"`，`"$PY" -m browser_use.cli --task-file <用例路径> --headless true --log-dir <目录>`（默认无头；有头见上文「`browser_use.cli` 有头模式」）
5. **汇总报告**：按下方「测试报告汇总」章节执行

**任务模式执行示例**（默认无头）：

```bash
PY="${UI_TEST_PYTHON:-python3}"
export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"
# 执行探索模式生成的用例：须对每个 case 的 .yaml 分别执行（见上方「批量执行（探索模式）」），不要用 index.yaml
cd <工作区根> && "$PY" -m browser_use.cli --task-file .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases/01-示例.yaml --headless true --log-dir .skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs/run_$(date +%Y%m%d-%H%M%S)

# 执行任务模式生成的用例（日志必须在 task/logs 下）
cd <工作区根> && "$PY" -m browser_use.cli --task-file .skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/promote-project-list/01-xxx.yaml --headless true --log-dir .skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/logs/run_$(date +%Y%m%d-%H%M%S)
# 有头：在上述任一行末尾追加「 browser.headless false」，并把 --headless true 改为 false
```

### 任务模式使用示例

**举例**：`/ui-test-assistant-skill` 进入任务模式，用户可这样描述测试需求：

> 帮我测试下 https://example.com/service-market，账号 ${TEST_USERNAME} 和密码 ${TEST_PASSWORD} 从本地配置读取；进入服务体验，点击开始体验，在对话框输入：冒泡排序

**Agent 处理流程**：

1. 识别为任务模式（测试步骤 + URL）
2. 按步骤生成 YAML 用例：登录用占位符 `${USERNAME}`、`${PASSWORD}`（从 **`{技能根}/config/.env`** 读取，须列入 SENSITIVE_VARIABLES）
3. 用例 flow 包含：登录 → 进入服务体验 → 点击开始体验 → 在对话框输入「冒泡排序」→ 校验点
4. 输出到 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/service-market/`**，执行并汇总报告

---

## 执行与 IDE 内运行

**在 Cursor / Claude Code / VSCode 等 IDE 的 Agent 中执行时**（默认**本机模式**，见「安装 · 执行环境策略」）：

| 步骤 | 操作 |
|------|------|
| 1. 执行命令 | 在工作区根执行：`export DOTENV_PATH="{技能根}/config/.env"`，`PY="${UI_TEST_PYTHON:-python3}"`，`"$PY" -m browser_use.cli --task-file <用例相对路径> --headless true --log-dir <路径>`。**log-dir** 规则：探索用例 → `…/<RUN_TS>/exploration/logs/<子目录>/`；任务用例 → `…/<RUN_TS>/task/logs/<子目录>/`（默认无头；有头时 `--headless false` 且**命令末尾追加** `browser.headless false`） |
| 2. 权限 | **本机模式（默认）**：按用户环境与平台能力为 run_terminal_cmd（或等价）选择权限；若默认受限导致失败，引导用户**在 IDE 中放宽权限**或到**系统终端**执行。**沙箱模式**：仅用户明确要求时；勿为默认流程在受限环境反复装依赖 |
| 3. 环境变量（可选） | 若报 `Executable doesn't exist`，可加 `env PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright`（macOS）；持久 venv 建议设置 **`UI_TEST_PYTHON`** |
| 4. 依赖安装 vs 跑用例 | **本机模式**：CLI / Playwright 与检查尽量共用同一 `PY`；若 IDE 内无法持久化或装浏览器，引导 **Terminal** 安装并设置 `UI_TEST_PYTHON`。**沙箱模式**：失败则引导改本机或说明无法跑通，**禁止**默认在沙箱循环 `pip install` |

**若仍失败**：说明是 Playwright 浏览器路径或系统权限问题；可请用户在 **Terminal.app** 用同一 `"$PY"` 执行相同命令以对比报错。

---

## 测试报告汇总

**触发场景**：用户询问「测试进度如何」「汇总测试报告」「整理测试结果」等。

**数据来源**：

| 来源 | 路径/说明 |
|------|-----------|
| 探索模式生成侧报告 | **公开 wheel 通常无固定 `reports/`**；若有扩展包产物可扫 **`exploration/{run_id}/reports/`** |
| 探索模式执行日志 | **`<RUN_TS>/exploration/logs/<子目录>/`**（`browser_use.cli` 产出） |
| 任务模式 YAML | **`<RUN_TS>/task/{项目名}/`** |
| 任务模式执行日志 | **`<RUN_TS>/task/logs/<子目录>/`** |
| 报告文件 | 各 `logs` 子目录下 `*_report.html`、`*_report_执行成功.html`、`*_report_执行失败.html` |
| result.json | 同上，各执行子目录内 |
| log.log | 同上 |

**汇总报告输出格式**：必须以 **Markdown 表格** 形式输出，包含以下列：

| 列名 | 说明 |
|------|------|
| 测试用例名称 | 用例 YAML 文件名或任务名称 |
| 执行结果 | **成功** / **失败** / **执行中** |
| 失败原因 | 仅当执行结果为「失败」时展示，从 result.json 或 log.log 提取错误摘要 |
| 执行时长 | 从 result.json 或 log 解析，格式如 `2m30s` 或 `150s` |

**输出示例**：

```markdown
## 测试执行汇总

| 测试用例名称 | 执行结果 | 失败原因 | 执行时长 |
|-------------|---------|---------|---------|
| 01-运营项目列表页加载与导航 | 失败 | Element not found - 业务工作台 | 2m44s |
| 02-新增运营项目 | 执行中 | - | - |
| 03-运营项目列表搜索 | 成功 | - | 1m12s |
```

**操作步骤**：

1. 确定目录：探索则扫 **`<RUN_TS>/exploration/logs/`**；若有 **`exploration/{run_id}/reports/`**（扩展包）一并参考；任务则扫 **`<RUN_TS>/task/logs/`** 下各子目录。
2. 扫描上述子目录及报告文件，判断各用例状态（成功/失败/执行中）
3. 从 `result.json`、`log.log` 提取失败原因、执行时长
4. 按上述 Markdown 表格格式输出

---

## 探索模式 Agent 说明

**本 Skill 如何知道如何使用探索模式**：**`browser-use==3.1.6`** 下由 **`CaseGeneratorAgent`**（`browser_use/case_generator/agent.py`）串联 **PageAnalyzer → CaseDesigner → YamlGenerator**；各阶段 LLM 由 **`build_models()`** 与 **.env** 决定（模板默认 **OpenAI-compatible provider + Qwen `BU_*_MODEL`**）。**不得**在已配 OpenAI-compatible provider 时索要 Google/Gemini Key，**不得**用库内 **gemini-2.5-flash** 等默认描述推导出必须配置 **`BU_OPENAI_*`**。生成启动脚本时以 **`CaseGeneratorAgent.run()`** 为准（见上节）。

**文档自含**：探索模式说明见下表。

| 文档 | 说明 |
|------|------|
| **[references/exploration_mode_guide.md](references/exploration_mode_guide.md)** | 探索模式简介、`CaseGeneratorAgent` 调用、输出目录、与任务模式衔接 |
| **[references/test_assistant_config.md](references/test_assistant_config.md)** | **CaseGeneratorAgent** 参数与凭据说明（文件名历史遗留，内容与旧 TestAssistant 脱钩） |
| **[references/implementation_summary.md](references/implementation_summary.md)** | CaseGeneratorAgent 流水线与子模块职责概要 |

**核心调用**：**先** `load_dotenv`，**再** `build_models(BU_*…)` + **`CaseGeneratorAgent(page_analysis_llm=…, case_design_llm=…, yaml_gen_llm=…)`**，**勿**无参 `CaseGeneratorAgent()`；或直接运行 **`package/scripts/run_exploration_case_generator.py`**。若使用算法侧扩展包提供的 `TestAssistant`，以该仓库文档为准，**非本技能默认依赖**。

---

## YAML 规范与 UI 操作指令

**当用户要求「生成用例」「写 YAML」「有哪些操作指令」「goTo 怎么用」等时**，Agent 必须依据本 Skill 内的规范文档：

| 文档 | 说明 |
|------|------|
| **[references/yaml-and-ui-operations.md](references/yaml-and-ui-operations.md)** | **YAML 用例生成规范**（target/tasks/flow 结构、一个用例一文件、import 复用）+ **UI 操作指令说明书**（goTo、ai、aiAction、aiTap、aiWaitFor、sleep、aiInput、aiAssert、assertText、aiScroll、upload 等 21 种指令的格式与用法）。与 browser-use 执行引擎兼容。 |

### 如何使用 yaml-and-ui-operations.md

1. **生成 YAML 文件时必须参考该文档**
   - 凡涉及**生成、编写、输出** UI 测试用例 YAML（任务模式根据步骤/需求文档生成、探索模式产出用例、或用户直接要求「写一个用例」）时，Agent **必须先参考** [references/yaml-and-ui-operations.md](references/yaml-and-ui-operations.md)，再生成内容。
   - **必须遵守**：顶层仅 `target` + `tasks`，`flow` 位于 task 内部；仅使用文档中定义的 21 种指令及规定格式；不添加未定义子 key（如 aiTap 禁止加 `timeout`）；每个用例至少一个校验点（aiAssert、assertText、aiWaitFor 等）。
   - **禁止**：使用 `task` 单数、顶层 `flow`、或文档「禁止的格式」中的写法。
2. **解释或列举 UI 指令时**：以 references/yaml-and-ui-operations.md 第二节「UI 操作指令说明书」为准，包括指令含义、格式、示例与选择建议。
3. **用户询问某条指令用法时**（如「goTo 怎么用」「aiWaitFor 能写 timeout 吗」）：从 references/yaml-and-ui-operations.md 中引用对应说明作答。

---

## 版本与变更记录

- 当前版本号见本文件 YAML 头部的 **`version`**。
- **历次更新摘要**见同目录 [版本记录.md](版本记录.md)。每次优化技能包时，请**同步**递增 `version`、更新 `description`（如有需要），并在 `版本记录.md` **顶部**追加一条记录。

## 附加资源

- **YAML 规范与 UI 操作指令**：[references/yaml-and-ui-operations.md](references/yaml-and-ui-operations.md)（YAML 生成规范 + 21 种 UI 指令说明，与 browser-use 执行引擎兼容）
- **任务模式用例生成**：[references/task-case-generation.md](references/task-case-generation.md)（文档读取、生成流程、输出目录、.env）
