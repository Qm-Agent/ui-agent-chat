# UIWarden 评测实验室标准评测集

本目录保存可直接导入“评测实验室”的版本化评测输入；已完成的基线运行按日期归档到
`results/`，不覆盖评测集源文件。

| 文件 | 范围 | 用例数 |
| --- | --- | ---: |
| `uiwarden-browser-core-v1.json` | Browser 核心交互与复杂页面能力 | 8 |
| `uiwarden-computer-core-v1.json` | Computer 常用桌面应用能力 | 5 |

首轮基线报告见 `results/2026-07-26/README.md`。

## 执行前置

Browser 评测集可以通过 `targetServices` 声明目标服务，并在 `targetUrl` 中使用
`{{targetService:<id>}}/path`。创建评测方案后：

1. 点击“启动评测”。
2. 页面检测评测目标服务状态。
3. 内置服务未就绪时，由用户点击“启动”或在继续运行提示中确认启动。
4. 服务 Ready 后再启动跑批；评测运行会冻结本次随机 loopback 地址。

内置 Browser Common Bench 随服务/客户端提供，不再要求手动运行
`python3 -m http.server`，也不固定使用 `127.0.0.1:18765`。外部 Fixture 可声明
`kind=external`、`baseUrl` 和 `healthPath`，由外部系统负责启动。

Computer 评测需要：

- macOS 已授予 UIWarden 辅助功能和屏幕录制权限。
- Microsoft Excel、Microsoft PowerPoint、DTCoder CN 和备忘录可用。
- 不操作用户已有文档。Office 用例必须新建临时文档并在结束时不保存。
- 备忘录用例只创建带固定前缀的临时内容，验证后移入“最近删除”。

## 判定约定

- 每条任务必须在动作后重新观察，并在最终回复中输出用例定义要求的精确结果标记。
- 精确结果标记只能在页面或应用状态已经验证后输出。
- 报告中的通过状态同时要求执行完成、结果标记命中、没有失败信号且存在执行产物。
- 两个评测集源自 `docs/benchmarks/ui-capability-evaluation-input-2026-07-25.md`，
  是适合日常跑批的核心子集；完整 52 场景仍以原输入文档为准。
