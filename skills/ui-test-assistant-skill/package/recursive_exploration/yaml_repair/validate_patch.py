"""校验改写未擅自新增断言 / 代码探测类步骤。"""

from __future__ import annotations

from typing import Any

import yaml

from recursive_exploration.yaml_repair.assertions import (
    count_assert_steps_in_tasks,
    count_code_query_steps,
)


def _tasks_from_yaml_text(text: str) -> list[dict[str, Any]]:
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError("YAML 根必须为 mapping")
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("缺少 tasks 列表")
    out: list[dict[str, Any]] = []
    for t in tasks:
        if isinstance(t, dict):
            out.append(t)
    if not out:
        raise ValueError("tasks 为空")
    return out


def validate_repair_yaml(
    baseline_text: str,
    candidate_text: str,
) -> tuple[bool, str]:
    """
    若候选相对基线 **新增** 断言步骤或新增 pyCode/jsCode/aiQuery 步骤，拒绝。
    允许减少或修改现有步骤文案。
    """
    try:
        base_tasks = _tasks_from_yaml_text(baseline_text)
        cand_tasks = _tasks_from_yaml_text(candidate_text)
    except Exception as e:
        return False, f"YAML 解析失败: {e}"

    ba = count_assert_steps_in_tasks(base_tasks)
    ca = count_assert_steps_in_tasks(cand_tasks)
    if ca > ba:
        return False, "候选 YAML 较基线新增了断言类步骤（aiAssert/aiAssertText/assertText），已拒绝"

    b_pyjs, b_q, _ = count_code_query_steps(base_tasks)
    c_pyjs, c_q, _ = count_code_query_steps(cand_tasks)
    if c_pyjs > b_pyjs:
        return False, "候选 YAML 新增了 pyCode/jsCode 步骤，已拒绝"
    if c_q > b_q:
        return False, "候选 YAML 新增了 aiQuery 步骤，已拒绝"

    return True, ""
