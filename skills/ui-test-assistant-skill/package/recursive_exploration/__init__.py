"""
递归探索编排（技能包内实现）：DOM 优先枚举、双队列、去重、事件日志与 graph.json。

入口脚本见 **`package/scripts/run_recursive_exploration.py`**（仓库根 **`scripts/`** 为兼容转发）。本包位于 **`package/recursive_exploration/`**，运行时应将 **`package/`** 置于 `sys.path`（入口脚本已处理）。
"""

from recursive_exploration.config import ExplorationRunConfig, ExecutionMode

__all__ = ["ExplorationRunConfig", "ExecutionMode"]
