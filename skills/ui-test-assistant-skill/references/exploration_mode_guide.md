# 探索模式使用指南（Skill 自含）

本文档为 **UI 测试助手 Skill** 自含说明。**browser-use==3.1.6** 下探索用例生成入口为 **`browser_use.case_generator.CaseGeneratorAgent`**（`agent.py`）。旧版 **`TestAssistant`** 仅见于部分算法侧扩展构建；与技能默认联调版本以 **CaseGeneratorAgent** 为准。

## 一、探索模式简介

**探索模式**：用户给出**入口 URL**（或「测一下 + URL」），Agent 打开页面后由 **PageAnalyzer → CaseDesigner → YamlGenerator** 自动生成多条 UI 测试 YAML。

### 与任务模式对比

| 维度 | 探索模式（CaseGeneratorAgent） | 任务模式 |
|------|-------------------------------|----------|
| **入口** | `CaseGeneratorAgent.run(url=..., output_dir=..., ...)` | 已有 YAML 或由需求/步骤生成的 YAML |
| **输入** | 单 URL；**无** `user_input` / `target_module` | YAML 路径；或文档/步骤 → 生成 YAML |
| **过程** | 导航到 URL → 取页面状态 → 分析 → 设计多案 → 写文件 | 按 `target`/`tasks`/`flow` 逐步执行 |
| **输出** | `output_dir` 下平铺 `01-xxx.yaml`、`02-xxx.yaml`… | 执行日志、HTML 报告等 |
| **执行策略** | 用户若表达「测一下」等，**默认生成后立即**对各 YAML 跑 `browser_use.cli`（见 [SKILL.md](../SKILL.md) Step E） | 默认生成后执行（除非只要 YAML） |

- **单 URL 能力边界**：公开 wheel **不做**多层级点击队列探索；若用户要强依赖「模块名导航」「登录后多跳」，转 **任务模式** 或提供**目标页 URL**。

## 二、模型与 .env

`browser_use.agent.chat_models` 在首次 import 时读取当前环境。须在 `import browser_use` 之前加载 `.env`，并用 `BU_*_MODEL` 显式调用 `build_models` 后将 LLM 传入 `CaseGeneratorAgent`。

- **推荐**：技能包 **`package/scripts/run_exploration_case_generator.py`** 已按上述顺序封装。
- `BU_OPENAI_API_BASE` 与 `BU_OPENAI_API_KEY` 成对配置；模型角色由 `BU_*_MODEL` 指定。

## 三、程序化调用

```python
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

workspace = Path("<工作区根>")
load_dotenv(workspace / "ui-test-assistant-skill/config/.env", override=True)

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

async def main():
    agent = CaseGeneratorAgent(
        page_analysis_llm=llm,
        case_design_llm=llm,
        yaml_gen_llm=llm,
    )
    paths = await agent.run(
        url="https://example.com",
        output_dir=str(out),
        project_name="probe_example",
        headless=True,
    )
    return paths

asyncio.run(main())
```

### 参数要点

见 [test_assistant_config.md](test_assistant_config.md)（文档名历史遗留，实为 **CaseGeneratorAgent** 说明）。

## 四、输出目录（推荐）

```
.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/
  generated_cases/          # CaseGeneratorAgent 的 output_dir
    01-页面加载.yaml
    02-搜索.yaml
    ...
  logs/                     # browser_use.cli 每次 --log-dir 的子目录
```

若使用**扩展包**且产出 `run_id/cases/L0_…` 与 `reports/`，批量执行规则不变：对 **每个业务 YAML 单独** `--task-file`，**不用**仅作索引的 `index.yaml` 当 task-file。

## 五、与任务模式衔接

生成完成后，在工作区根对每个 `.yaml` 执行（示例）：

```bash
PY="${UI_TEST_PYTHON:-python3}"
export DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"
cd <工作区根>
GEN=.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases
for f in "$GEN"/*.yaml; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .yaml)
  case "$base" in index) continue ;; esac
  "$PY" -m browser_use.cli --task-file "$f" --headless true \
    --log-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/logs/${base}_$(date +%Y%m%d-%H%M%S)"
done
# 有头：--headless false，行末追加 browser.headless false（见 SKILL.md）
```

任务模式用例生成见 [task-case-generation.md](task-case-generation.md)；YAML 规范见 [yaml-and-ui-operations.md](yaml-and-ui-operations.md)。

## 六、更多说明

- 流水线概要：[implementation_summary.md](implementation_summary.md)
- 参数与凭据：[test_assistant_config.md](test_assistant_config.md)

## 六点五、快速测试模式（quick）与探索模式的边界

browser-use 3.1.6 的 `quick` / `observe` / `aiQuick` 能力由本 Skill 的 **快速测试模式** 使用，入口为 `package/scripts/run_quick_mode.py`。它适合一句话快速验证，把 Markdown / Excel / CSV / TSV 测试用例集合逐条改写为 quick query 后串行执行，或在快速模式下将需求/测分文档先拆解为用例再执行。

- **quick 不替代探索模式**：用户只说「测一下 + URL」仍走 `CaseGeneratorAgent` 生成 YAML 后批量执行；只有出现「快速 / 快测 / quick」任务语义时才进入 quick。若用户明确说「普通模式 / 普通探索 / 老的执行模式 / 非快速模式」，即使同句有 `QUICK_URL=...` 等环境变量配置，也按普通探索或任务/用例执行分流。
- **页面巡检 / 探活**：用户要求执行某 URL 的页面巡检、巡检、页面探活、探活、页面存活时，走 quick 的 `--health-check` 链路。该链路只打开入口页并等待稳定，判断页面是否可访问、正常渲染和完成基本加载；不做模块盘点、导航点击、输入提交或业务功能验证。重点识别 DNS/证书/网络错误、404/500、白屏、崩溃、长期 loading、主体缺失、明显红色错误或严重布局错乱；登录页、验证码页、安全校验页或权限页若正常渲染，记录为可达/备注，不直接判定为前端 bug。页面巡检默认只跑一轮，不做失败自愈，除非用户显式要求重试；执行后汇总 `quick/batch/health_check_report.md/json`。
- **冒烟验证 / 前端走查**：用户要求执行某 URL 的冒烟验证、冒烟测试、前端走查、页面走查时，走 quick 的 `--smoke-walkthrough` 链路。该链路先视觉盘点左侧/顶部导航、可展开分组和当前页面标题，只列出当前页面实际可见一级主模块，不套用历史站点或固定产品模块名，再逐个进入这些主模块或代表性子入口做轻量冒烟，并根据用户追加关注点动态调整 prompt；若用户明确指定某模块、控件、对话、校验或断言，则本次冒烟以指定范围为主，其它未要求模块只记录可见性，不作为未覆盖问题；存在搜索、筛选、试用对话等低风险输入场景时，输入简短测试文本并触发查询/发送/提交，验证输入、按钮响应和结果/提示变化，破坏性提交只记录未覆盖；导航或菜单点击后页面未变化时，先按执行器未点准、命中折叠/遮挡区域处理，需换文字中心、链接文本、滚动后再点、展开父级、键盘 Enter、先点相邻项再回来等方式重试；只有明确点中正确控件且页面给出错误/禁用/异常提示时才记疑似问题，定位不确定的点击失败只记未覆盖；冒烟主范围限定在被测入口同域/同产品页面，每次点击/提交/打开新页后检查 host，若跳到不同域名、不同控制台或明显外部平台，只记录外部页可达性和是否白屏/报错，随后立即返回入口或上一页继续本域其它模块，不继续探索外部平台导航；验证码/滑块/安全验证等正常风控记为未覆盖/风险说明，不直接判定为 bug 或整体阻塞，遇到单模块阻塞时继续走查其他可访问主模块；冒烟默认只跑一轮，不做失败自愈，除非用户显式要求重试；执行后汇总 `quick/batch/smoke_walkthrough_report.md/json` 与 `quick/batch/smoke_ai_analysis.md/json`。AI 分析优先由大模型基于日志整体理解给出 `冒烟通过 / 需要人工核对 / 有问题`、覆盖点、问题点和人工核对点，规则仅兜底；默认冒烟未发现明确前端 bug 即判 `冒烟通过`，未覆盖/定位未确认/报告验收失败仅列人工核对；用户明确提出模块、控件、校验、断言或必须覆盖项时按自定义冒烟保守判断。控制台打印疑似 bug 与 AI 结论。
- **批量 quick**：从“测试用例总表”或 Excel sheet 中抽取 `用例标题 / 前置条件 / 测试步骤 / 预期结果 / 是否UI自动化` 等字段；标记“不可UI自动化”的记录默认跳过。
- **文档拆解 quick**：需求文档用 `--input-kind requirement`，测分/测试分析文档用 `--input-kind analysis`；`--input-kind auto` 会先识别用例集合，再根据文件名和正文关键词判断文档类型。文档默认按章节分片生成，先识别可测需求点、过滤背景/过程项，再生成 UI 原子步骤；`--max-generated-cases 0` 与 `--cases-per-doc-chunk 0` 表示不限制总数和单片段条数；不要为完整需求测试主动设置过小上限。
- **辅助上下文**：可通过 `--context` 传入图谱目录、产品白皮书、代码库或需求/设计文档目录；只作为用例拆解、quick 背景提示和失败修复参考，不反向修改探索产物。`config/prompt_context/` 默认只注入 `global_readme.md`；其它特定业务文件需用户当次明确提到文件名、stem 或完整路径才会带入。进入 quick query 的是 `execution_hints.md`，必须去掉本地路径、URL 和“参考文件”依赖表述。
- **CDP 与有头/无头解耦**：是否 CDP 只看是否显式要求 `--no-cdp` / 新浏览器 / 非 CDP；是否有头只看「有头 / 无头 / 打开浏览器观察」。非 CDP 有头使用 `--no-cdp --headless false`；无头使用 `--headless true`，不要因为“有头”默认推断为 CDP。
- **失败回改**：quick 单条失败后执行 `observe`，再基于当前页面状态 `quick --resume` 重试，默认最多 1 次；CDP 模式走实时页面观察，`--no-cdp` 模式走 3.1.6 的 `observe --no-cdp --log-dir <attempt_log_dir>` 读取 quick history 最后截图。retry query 必须内联页面观察摘要，不写外部 observe 文件路径。

## 七、递归探索（可选 · 技能包内）

与 **CaseGeneratorAgent** 的「单轮分析 + 批量 YAML」并行，技能包在 **`package/recursive_exploration/`** 实现递归探索，入口为 **`package/scripts/run_recursive_exploration.py`**：基于 `browser-use` 的 **DOM 可点元素**枚举，做 **可控深度** 的队列探索，并产出 **`events.jsonl`**（事实源）、**`graph.json`**（含检索 `indexes`）、**`exploration_report.md`**、按需 **`generated_cases/*.yaml`**。此外为可审计性追加：**`queues.jsonl`**（动作队列与 URL 待办队列的入队/出队/跳过轨迹）、**`enumerations.jsonl`**（每轮用于入队决策的元素枚举快照，与视口过滤策略一致）；`exploration_report.md` 中会摘要上述文件的行数/路径。

- **人类叙事审查（推荐打开）**：每次 run 结束还会生成 **`review_timeline.html`**（按 **锚点 URL** 分节、同锚点内按 **`url_after` 变化**加小节；时间轴上区分 **全局序** 与 **锚点内序**；若存在 **`generated_cases/*.yaml`** 则展示对应 `tasks[0].flow` 步片段）及 **`timeline.json`**（`steps[]` 含 `yaml_flow_snippet`、`anchor_step_seq` 等）。`queues.jsonl` 仍以可机读、可 join 为主。打开 HTML 时请保持与 **`assets/`** 的相对目录关系。**事后补生成常规报告**（刷新 `timeline.json` + `review_timeline.html`）：在技能根执行 **`PYTHONPATH=package python -m recursive_exploration.review_report <run_output_dir>`**（或 **`cd package && python -m recursive_exploration.review_report <run_output_dir>`**）。**默认不生成** `review_timeline.standalone.html`；**仅当用户明确要求离线单文件 / 内嵌图**时，在**不重新跑探索**的前提下执行 **`PYTHONPATH=package python -m recursive_exploration.review_report <run_output_dir> --standalone`**：读已有 `timeline.json` 将本地截图转为 data URL，**只写出** `review_timeline.standalone.html`，**不覆盖** `review_timeline.html` 与 `timeline.json`。
- **操作类型与 YAML**：对 `input`/`textarea`（非 file/button 等）会生成 **`input`** 任务，执行 `input_text_element_node` 并写入 **`aiInput`** 步骤。**占位文本由模型根据当前页 URL、标题与控件描述自动生成**（与 `package/scripts/run_exploration_case_generator.py` 相同链路：`load_dotenv` 后 `build_models` + `BU_*_MODEL`）；仅当模型不可用或调用失败时回退到配置项 **`mock_input_text`**（默认 `exploration_mock_input`），**不需要、也不应要求用户传 CLI 占位串**。若需完全关闭 LLM（例如离线单测），可将 `ExplorationRunConfig.use_llm_for_input_mock` 设为 `False`。`--yaml-policy` 默认 **`all`**，每次成功动作均写 **`generated_cases/*.yaml`**，`aiTap`/`aiInput` 优先使用 **自然语言 `locate_prompt`**。同页多个节点若 **`branch_path_hash` 碰撞**，重放时 **优先按记录时的 `element_index` 解析**，降低误点。

- **深度**：`--exploration-depth` 与 OpenSpec 一致，`1` 仅入口锚点；`2` 另对入口执行中发现的跨页 URL 各跑一轮。
- **`max_actions`（按锚点 URL）**：配置与 CLI 默认 **50**（各锚点独立计数）。**每个**待爬锚点（入口算一层，跨页发现的新 URL 各算一层内的一个锚点）在**本会话内**各自拥有相同的成功动作上限 `max_actions`，**额度互不占用**。例如 `exploration_depth=2` 且第一层发现 3 个新 URL，则入口最多成功 `max_actions` 次，**每个**第二层 URL 锚点也各自最多再成功 `max_actions` 次（全 run 总成功次数可达约 `4 * max_actions` 量级，视去重与队列而定）。
- **`max_total_actions`（全 run）**：默认 **200**；统计**跨所有锚点**的累计成功动作次数，达到后不再执行新的成功步（与单锚点 `max_actions` 是两维独立上限）。CLI：`--max-total-actions`。耗尽时在 `budget_truncation.json` 中可见 `phase` 为 `run_total_actions` 等段落。
- **组合检查点（交错）**：默认每 **15** 次「非组合」单步成功后，在**当前锚点会话内**插入一轮组合规划（`composite_checkpoint_every_single_successes`，CLI `--composite-checkpoint-every`）；设为 **0** 关闭检查点，但仍保留「动作队列见底」时的组合 **boost**。若单锚点内从未因「队列空」触发过 boost，在锚点收尾前仍会补一轮组合规划，或写入 `composite_phase_skipped` 类审计。上述交错语义仅在 **`strict_phase_traversal=False`** 时成立（需 **`--no-strict-phase-traversal`**；未实现入队时代码路径可能仍不产生组合任务，以实际运行为准）。
- **严格阶段遍历（`strict_phase_traversal`）**：**默认 True**（`ExplorationRunConfig`；CLI **`--no-strict-phase-traversal`** 关闭）。为 True 时单锚点内 **先阶段 A 后阶段 B**：阶段 A **仅**消费由单步扩队产生的任务；若头元素为 composite 则放回并结束 A。阶段 A 因**队列空**终止、且整 run 与单锚点预算仍可用、`composite_enabled` 未关闭时，**至多调用一次**组合规划以 **入队阶段 B** 的组合任务或写入 `composite_phase_skipped`。阶段 B 内 **禁止**再次组合规划（也不会再走交错检查点/`appendleft` 插队等与预算 composite-review 交错相关的路径）。与 **`incremental_composite_mode` 不得同时为 True**（初始化时会报错）。**URL 队列**：仍为外层 `while pending`；仅在当前 `_explore_anchor` **返回后**才对下一个 `UrlTask` 出队，不会在单锚点尚未结束时抢先调度下一锚点。
- **扩队**：每次成功动作后，若当前规范化 URL **仍与本锚点入口一致**，则基于 **当前页** DOM 再入队可扩展元素。**若本次动作导致规范化 URL 变更（跨页）**：不向本会话的 action 队列扩队（避免把新页索引混入锚点队列）；跨页目标已通过 **`url_discovered`** / **`pending` URL 队列**交给更深的锚点会话处理（如需到达状态路径回放，属于 UrlTask 前缀扩展能力，见代码演进）。
- **动作后落地等待**：每次点击/输入/组合原子步成功后，会先 **等待 DOM、可选 networkidle、`document.readyState`，并轮询直至地址栏 URL 在连续若干毫秒内不再变化**，再截取 **after** 图并写入 events/graph（避免导航中途的过程截图与错误 `url_after`）。慢加载判定 **不依赖具体站点名单**：由 **`locate` 等文案中的「链接→URL」与当前会话 `anchor_url` 解析对比**（跨主机名、或同主机下路径/查询变化）叠加 **通用路径语义**（如 `/login`、`/oauth`、`/products`），自动 **加长 settle**；**顶栏 URL 长时间不变** 时仍可通过 **`post_action_heavy_min_url_phase_ms`** 与 **`load` / `document.readyState === 'complete'`**（`post_action_heavy_*`）拉长落地。对应 **`generated_cases/*.yaml`** 会在最终目标动作前 **额外插入 `aiWaitFor`**。
- **滚动（scroll）**：当页可纵向滚动且未到底时，会入队 **主视口 `mouse.wheel` 向下滚动** 任务（`action_kind=scroll`），减少长页只采到首屏的漏测；事件/边中可过滤 `action_kind` 与 `target_step.kind=scroll`。
- **组合补探（composite）**：**默认开启**（`ExplorationRunConfig.composite_enabled=True`）。在单步阶段把当前锚点动作队列基本消费完后，会再按启发式（同视口内多 `input` + 提交/按钮类控件）规划 **多步组合** 并入队；`events.jsonl` 中可带 `composite_plan_id` / `task_source` 区分。命令行关闭：``--no-composite``。若已有一份 run 的 **``graph.json``**，可用 ``--prior-graph <path>`` 与 ``--incremental-composite`` 做 **仅组合补探的增量跑**（会尝试跳过 prior 中已存在的 `dedupe_path_key`；若当前视口无「可填输入 + 可点提交」组合，则本次可能 **0 条** 组合入队，属预期）。
- **预算截断可观测**：达到 **单锚点** `max_actions` 或 **全 run** `max_total_actions` 时写入 **`budget_truncation.json`**（HTML/timeline 摘要）；`queues.jsonl` 中有 `type=budget_truncated` 便于检索。
- **产物目录**：建议 `<RUN_TS>/exploration/recursive/`（与 `generated_cases/` 平级，避免混放）。
- **站点总图合并**：脚本支持 `--merge-site-graph` 与 `--merge-output`，将多份 run 级 `graph.json` 合并为 `graph_kind: site_merged`。
- **基准场景说明**（验证去重与 depth）：见 [recursive_exploration_benchmarks.md](recursive_exploration_benchmarks.md)。

示例（工作区根，先 `export DOTENV_PATH=…/config/.env`）：

```bash
PY="${UI_TEST_PYTHON:-python3}"
RUN_TS=$(date +%Y%m%d%H%M%S)
OUT=".skill-output/ui-test-assistant-skill-output/${RUN_TS}/exploration/recursive"
mkdir -p "$OUT"
cd <工作区根>/skills/ui-test-assistant-skill   # 或仓库根即技能根
"$PY" package/scripts/run_recursive_exploration.py \
  --url "https://example.com" \
  --output-dir "$OUT" \
  --exploration-depth 1 \
  --max-actions 40 \
  --max-total-actions 200

# 可选：基于已有图谱仅跑组合补探（增量）
# "$PY" package/scripts/run_recursive_exploration.py \
#   --url "https://example.com" \
#   --output-dir "$OUT/incremental" \
#   --exploration-depth 1 \
#   --max-actions 15 \
#   --prior-graph ".skill-output/.../exploration/recursive/graph.json" \
#   --incremental-composite
```
