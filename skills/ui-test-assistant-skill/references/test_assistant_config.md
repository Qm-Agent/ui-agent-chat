# CaseGeneratorAgent 配置说明（Skill 自含）

> **文件名说明**：历史文件名为 `test_assistant_config.md`，内容为 **browser-use==3.1.6** 的 **`CaseGeneratorAgent`**，与旧文档中的 `TestAssistant` 脱钩。扩展包若仍提供 `TestAssistant`，以该仓库为准。

本文档说明探索模式的程序化参数与凭据约定，流程总览见 [exploration_mode_guide.md](exploration_mode_guide.md)。

## 〇、`CaseGeneratorAgent` 构造与导入顺序（browser-use==3.1.6）

**实现**：`browser_use/case_generator/agent.py`；模型工厂：`browser_use/agent/chat_models.py`。

- `chat_models` 在 import 时读取环境变量。必须在任何 `import browser_use` 之前加载技能包 `config/.env`。
- 显式调用 `build_models(actor=os.getenv("BU_ACTOR_MODEL", "qwen3.7-plus"), ...)`，并将返回的 `aux["page_extraction_llm"]` 传入三个生成阶段，避免依赖上游默认模型。
- **推荐**：使用技能包 **`package/scripts/run_exploration_case_generator.py`**，避免手写顺序错误。

## 一、`CaseGeneratorAgent.run()` 参数

**实现**：`browser_use/case_generator/agent.py`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `str` | （必填） | 被测入口 |
| `output_dir` | `str \| None` | 库内常为 `~/uiTest/{project_name}`（**勿用于本 Skill**） | 本 Skill 须指向工作区 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases`** |
| `project_name` | `str` | `uiTest`（库默认） | 本 Skill 以 `<RUN_TS>` + `exploration/generated_cases` 组织产出；`project_name` 仅影响库内默认路径时使用 |
| `login_config` | `dict \| None` | `None` | 可选；通常含 `task_file` 指向登录 YAML；行为以当前库实现为准 |
| `browser_context` | — | `None` | 可选，传入已有 `BrowserContext` |
| `headless` | `bool` | `True` | 无头浏览器 |

**当前 wheel 不包含**：`user_input`、`target_module`、`exploration_depth`、`max_cases_per_page`、`realtime_output`、`visual_error_check`（以上为部分 **TestAssistant** 扩展参数）。

## 二、凭据与 `SENSITIVE_VARIABLES`

- **不要**向 `run()` 传入用户名/密码。
- YAML 中的 `${USERNAME}` 等占位符须在 **`{技能根}/config/.env`**（或项目 `.env` + `DOTENV_PATH`）配置，并把变量名列入 **`SENSITIVE_VARIABLES`**，规则见 [SKILL.md](../SKILL.md)。
- 站点需复杂登录时：优先**任务模式**编写/生成登录 + 业务步骤 YAML，或使用 `login_config`（以源码为准）。

## 三、与 `TestAssistant` 的差异（备忘）

| 项目 | CaseGeneratorAgent | 典型 TestAssistant（扩展） |
|------|---------------------|---------------------------|
| 探索深度 | 单 URL 一轮分析与成批用例 | 可多层级页面队列 |
| 自然语言 | 不支持 `user_input` | 可解析 `user_input` |
| 输出 | `output_dir` 平铺 YAML | 常见分层目录 + `reports/` |
