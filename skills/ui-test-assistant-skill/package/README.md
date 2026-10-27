# package

技能根下的 **Python 源码与 CLI 入口**均在本目录，便于与仓库根的配置（`config/`）、文档（`references/`、`SKILL.md`）区分。

## 布局

| 路径 | 说明 |
|------|------|
| **`scripts/`** | 可执行入口：`check_ui_test_env`、`run_quick_mode`、`run_exploration_case_generator`、`run_recursive_exploration`、`run_yaml_repair`、`run_yaml_repair_batch` |
| **`recursive_exploration/`** | 递归探索核心（`explorer`、`yaml_repair`、配置与测试等） |
| **`graph_retrieval/`** | 探索产物图谱检索（`GraphRetriever`、`load_run_bundle`） |
| **`graph_analysis/`** | 图谱路径与业务流挖掘（供任务侧组合） |
| **`task_mode/`** | 任务模式侧图谱增强规划（依赖 `graph_retrieval` / `graph_analysis`） |

运行时入口脚本会将 **`package/`** 加入 `sys.path`，因此模块仍按 **`import recursive_exploration`**、`import graph_retrieval`** 等形式导入（无需写 `package.` 前缀）。

仓库根目录下的 **`scripts/`** 为**兼容薄封装**，转发到 **`package/scripts/`**，旧命令 `python scripts/run_*.py` 仍可用。

**pytest**：仓库根已配置 **`pytest.ini`**（`pythonpath = package`），在技能根执行 `pytest` 即可跑 **`package/recursive_exploration/tests`**。

**事后补生成审查 HTML**（不重新跑探索）：在技能根执行  
`PYTHONPATH=package python -m recursive_exploration.review_report <run_output_dir>`  
（或先 `cd package` 再 `python -m recursive_exploration.review_report …`，无需设置 `PYTHONPATH`）。
