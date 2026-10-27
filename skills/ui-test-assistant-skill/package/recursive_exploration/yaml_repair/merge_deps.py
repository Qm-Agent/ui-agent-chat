"""将 import/use 及可选 bootstrap 合并为单一 TasksConfig YAML。"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml


class MergeDepsError(RuntimeError):
    """合并失败时抛出，携带对用户可读说明。"""


def _load_yaml(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise MergeDepsError(f"YAML 根必须为 mapping: {path}")
    return data


def _module_flow_by_name(doc: dict[str, Any]) -> dict[str, list[Any]]:
    reg: dict[str, list[Any]] = {}
    tasks = doc.get("tasks")
    if not isinstance(tasks, list):
        return reg
    for t in tasks:
        if not isinstance(t, dict):
            continue
        name = t.get("name")
        flow = t.get("flow")
        if isinstance(name, str) and isinstance(flow, list):
            reg[name] = flow
    return reg


def _expand_use_in_flow(flow: list[Any], modules: dict[str, list[Any]], *, depth: int = 0) -> list[Any]:
    if depth > 50:
        raise MergeDepsError("use 展开递归过深（可能存在循环模块引用）")
    out: list[Any] = []
    for step in flow:
        if isinstance(step, dict) and len(step) == 1 and "use" in step:
            mod = step.get("use")
            if not isinstance(mod, str):
                raise MergeDepsError(f"use 必须为字符串模块名，当前: {step!r}")
            if mod not in modules:
                raise MergeDepsError(f"未找到模块 '{mod}'，请检查 import 与 task.name")
            inner = copy.deepcopy(modules[mod])
            out.extend(_expand_use_in_flow(inner, modules, depth=depth + 1))
            continue
        if isinstance(step, dict) and "if" in step:
            step = copy.deepcopy(step)
            then_flow = step.get("then")
            if isinstance(then_flow, list):
                step["then"] = _expand_use_in_flow(then_flow, modules, depth=depth + 1)
            else_flow = step.get("else")
            if isinstance(else_flow, list):
                step["else"] = _expand_use_in_flow(else_flow, modules, depth=depth + 1)
            out.append(step)
            continue
        out.append(copy.deepcopy(step))
    return out


def _collect_imports(entry: Path, doc: dict[str, Any]) -> dict[str, list[Any]]:
    modules: dict[str, list[Any]] = {}
    imports = doc.get("import")
    if not isinstance(imports, list):
        return modules
    base = entry.parent
    for block in imports:
        if not isinstance(block, dict):
            continue
        from_path = block.get("from")
        mod_names = block.get("modules")
        if not isinstance(from_path, str):
            raise MergeDepsError("import 项缺少 from 路径")
        if not isinstance(mod_names, list):
            raise MergeDepsError("import 项缺少 modules 列表")
        ref = (base / from_path).resolve()
        if not ref.is_file():
            raise MergeDepsError(f"import 文件不存在: {ref}")
        sub = _load_yaml(ref)
        sub_modules = _module_flow_by_name(sub)
        for mn in mod_names:
            if not isinstance(mn, str):
                continue
            if mn not in sub_modules:
                raise MergeDepsError(f"文件 {ref.name} 中缺少 task.name={mn!r}")
            modules[mn] = sub_modules[mn]
    return modules


def _resolve_bootstrap_path(
    entry: Path,
    *,
    merge_bootstrap: bool,
    bootstrap_path: Path | None,
) -> Path | None:
    if bootstrap_path is not None:
        p = Path(bootstrap_path).expanduser().resolve()
        if not p.is_file():
            raise MergeDepsError(f"指定的 bootstrap 不存在: {p}")
        return p
    if not merge_bootstrap:
        return None
    cand = entry.parent / "bootstrap.yaml"
    return cand.resolve() if cand.is_file() else None


def merge_to_single_document(
    entry: Path,
    *,
    merge_bootstrap: bool = True,
    expand_imports: bool = True,
    bootstrap_path: Path | None = None,
) -> dict[str, Any]:
    """
    返回合并后的文档 dict（尚未写入磁盘）。
    - 可选将 bootstrap 的任务列表前置；
    - 展开 import + flow 内 use。
    """
    entry = entry.expanduser().resolve()
    if not entry.is_file():
        raise MergeDepsError(f"入口 YAML 不存在: {entry}")

    main = _load_yaml(entry)
    boot_file = _resolve_bootstrap_path(entry, merge_bootstrap=merge_bootstrap, bootstrap_path=bootstrap_path)

    merged_target: dict[str, Any] = {}
    if boot_file is not None:
        bdoc = _load_yaml(boot_file)
        bt = bdoc.get("target")
        mt = main.get("target")
        if isinstance(bt, dict):
            merged_target.update(bt)
        if isinstance(mt, dict):
            merged_target.update(mt)
    else:
        tgt = main.get("target")
        if isinstance(tgt, dict):
            merged_target = copy.deepcopy(tgt)

    modules = _collect_imports(entry, main) if expand_imports else {}

    tasks_out: list[dict[str, Any]] = []

    if boot_file is not None:
        bdoc = _load_yaml(boot_file)
        bt = bdoc.get("tasks")
        if isinstance(bt, list):
            tasks_out.extend(copy.deepcopy(t) for t in bt if isinstance(t, dict))

    mt = main.get("tasks")
    if not isinstance(mt, list):
        raise MergeDepsError("主 YAML 缺少 tasks 列表")
    for t in mt:
        if not isinstance(t, dict):
            continue
        t2 = copy.deepcopy(t)
        flow = t2.get("flow")
        if expand_imports and isinstance(flow, list):
            t2["flow"] = _expand_use_in_flow(flow, modules)
        tasks_out.append(t2)

    out_doc: dict[str, Any] = {"target": merged_target, "tasks": tasks_out}
    if not isinstance(out_doc["target"], dict):
        raise MergeDepsError("合并后 target 非法")
    return out_doc


def write_merged_yaml(doc: dict[str, Any], dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
