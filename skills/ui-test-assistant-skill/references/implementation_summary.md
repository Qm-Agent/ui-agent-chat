# 探索模式实现概要（Skill 自含）

本文档概括 **browser-use==3.1.6** 中 **`CaseGeneratorAgent`**（`browser_use/case_generator/agent.py`）的内部流水线。**不依赖**工作区其他模块；旧版 **TestAssistant** 多层级队列 **不在** 公开 wheel 中，此处不描述其实现细节。

## 一、`CaseGeneratorAgent` 主流程

1. **浏览器**：若未传入 `browser_context`，则创建 `Browser` + `BrowserContext`（受 `headless` 等配置影响）。
2. **可选登录**：若提供 `login_config`，按当前实现尝试（如根据 `task_file` 导航）；否则跳过。
3. **打开被测页**：`navigate_to(url)` → `get_state()`。
4. **页面分析**：`PageAnalyzer.analyze(ctx)` → 得到页面类型与可测点等（`PageAnalysisResult`）。
5. **用例设计**：`CaseDesigner.design(analysis)` → 多条 `TestCaseDesign`。
6. **YAML 生成**：`YamlGenerator.generate(cases, target_url)` → 多条 YAML 字符串。
7. **写盘**：在 `output_dir` 下生成 `01-xxx.yaml`、`02-xxx.yaml`…（文件名由用例名清洗得到）。
8. **收尾**：关闭自建 browser/context。

## 二、核心子模块（与代码对应）

| 模块 | 职责 |
|------|------|
| **PageAnalyzer** | 基于当前页面状态做 LLM 辅助的页面分析 |
| **CaseDesigner** | 将分析结果转为结构化用例设计 |
| **YamlGenerator** | 将用例设计转为可执行 YAML，结构与 [yaml-and-ui-operations.md](yaml-and-ui-operations.md) 对齐 |

## 三、与旧「多层级探索」叙述的关系

技能早期文档中的 **ExplorationPlanner / 多层级队列 / L0、L1 目录** 对应部分算法侧 **TestAssistant** 产品形态；**CaseGeneratorAgent** 固定为 **单 URL 一次分析、多案输出**。若仓库升级引入新类，以该版本 `case_generator` 源码为准。

## 四、相关文档

- 使用方式与示例：[exploration_mode_guide.md](exploration_mode_guide.md)
- 参数表：[test_assistant_config.md](test_assistant_config.md)
- 编排与执行策略：[SKILL.md](../SKILL.md)
