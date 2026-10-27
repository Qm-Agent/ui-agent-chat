# 递归探索产物职责（冻结）

与 OpenSpec 「恢复源 vs 审计」分层一致：

| 文件 | 职责 |
|------|------|
| `session_state.json` | **唯一** session / resume-strict 恢复源（队列、去重、统计快照）。 |
| `events.jsonl` | 动作与状态变更的**审计事实**；不作为唯一恢复依据。 |
| `queues.jsonl` | URL/action 队列轨迹审计；不作为唯一恢复依据。 |
| `enumerations.jsonl` | DOM 枚举轮次审计（可选检索）。 |
| `graph.json` | Run 级路径图谱与 `indexes`；合并 `run_meta.start_context`。 |
| `budget_truncation.json` | 预算截断结构化摘要（若有）。 |
| `review_timeline.html` / `timeline.json` | 人类可读时间线审查。 |
| `exploration_report.md` | 运行摘要与人类可读索引。 |
| `generated_cases/*.yaml` | 单任务可回放用例导出；若存在 `bootstrap.yaml` 且开启 `embed_bootstrap_in_generated_yaml`，各用例 flow **前置合并**前置脚本步骤（独立 CLI 回放即「前置 + 探索」）。 |

消费方（任务模式、检索层）应优先通过 **`graph_retrieval`** 读取，而非自行解析全文 JSON。
