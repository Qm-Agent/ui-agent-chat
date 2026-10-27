"""
版面分区与组合链连贯性启发式（DOM 几何 + 轻量导航区识别）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from recursive_exploration.fingerprints import stable_hash


@dataclass(frozen=True)
class LayoutHints:
    quadrant: str
    """tl | tr | bl | br | center"""
    is_left_rail: bool
    is_top_bar: bool
    is_right_cluster: bool
    zone_id: str
    """稳定版面分区 id，用于同区优先。"""


def _rect_center_xy(rect: Any) -> tuple[float, float]:
    x = float(getattr(rect, "x", 0) or 0)
    y = float(getattr(rect, "y", 0) or 0)
    w = float(getattr(rect, "width", 0) or getattr(rect, "w", 0) or 0)
    h = float(getattr(rect, "height", 0) or getattr(rect, "h", 0) or 0)
    return x + w / 2.0, y + h / 2.0


def viewport_quadrant(cx: float, cy: float, vw: float, vh: float) -> str:
    if vw <= 1 or vh <= 1:
        return "center"
    mx, my = vw / 2.0, vh / 2.0
    if cx < mx and cy < my:
        return "tl"
    if cx >= mx and cy < my:
        return "tr"
    if cx < mx and cy >= my:
        return "bl"
    return "br"


def _nav_shell_heuristic(el: Any) -> tuple[bool, bool, bool]:
    """(is_left_rail, is_top_bar, is_right_cluster) 粗分。"""
    rect = getattr(el, "rectangle", None)
    if not rect:
        return False, False, False
    # 无视口时无法几何分区
    attrs = el.attributes or {}
    cls = ""
    c = attrs.get("class")
    if isinstance(c, list):
        cls = " ".join(str(x) for x in c)
    elif c:
        cls = str(c)
    cls_l = cls.lower()
    role = str(attrs.get("role") or "").lower()
    tag = (getattr(el, "tag_name", None) or "").lower()
    left_hint = bool(
        role in ("navigation", "menu", "menubar")
        or any(k in cls_l for k in ("sidebar", "sider", "aside-menu", "nav-menu", "menu-inner"))
        or tag == "nav"
    )
    top_hint = bool(re.search(r"\b(header|topbar|top-bar|navbar)\b", cls_l) or role == "banner")
    # 右侧小块（租户/设置簇）：右上角区域由几何判定，此处仅 class 提示
    right_hint = bool(re.search(r"\b(header-right|tenant|user-dropdown|avatar)\b", cls_l))
    return left_hint, top_hint, right_hint


def layout_hints_for_element(el: Any, vw: float, vh: float) -> LayoutHints:
    rect = getattr(el, "rectangle", None)
    if not rect or vw <= 1 or vh <= 1:
        zh = stable_hash(["zone", "unknown"])
        return LayoutHints(
            quadrant="center",
            is_left_rail=False,
            is_top_bar=False,
            is_right_cluster=False,
            zone_id=f"z_{zh[:12]}",
        )
    cx, cy = _rect_center_xy(rect)
    q = viewport_quadrant(cx, cy, vw, vh)
    lr, tb, rc = _nav_shell_heuristic(el)
    # 左 22% 宽条视为左栏导航
    is_left_rail = lr or (cx < vw * 0.22)
    is_top_bar = tb or (cy < vh * 0.12 and cx < vw * 0.88)
    is_right_cluster = rc or (q == "tr" and cx > vw * 0.55 and cy < vh * 0.28)
    tag = (getattr(el, "tag_name", None) or "e").lower()
    zone_key = [tag, q, "L" if is_left_rail else "", "T" if is_top_bar else "", "R" if is_right_cluster else ""]
    zh = stable_hash(["zone", "|".join(zone_key)])
    return LayoutHints(
        quadrant=q,
        is_left_rail=is_left_rail,
        is_top_bar=is_top_bar,
        is_right_cluster=is_right_cluster,
        zone_id=f"z_{zh[:12]}",
    )


def spatial_pair_incoherent(a: LayoutHints, b: LayoutHints, *, strict: bool) -> bool:
    """
    若上一步在右上/顶栏交互簇，下一步落到左侧主导航，视为与「浮层/头部操作」不连贯（易整页跳走）。
    strict=True 时硬丢弃；否则仅作排序降权（本函数在 strict 下返回 True 表示应丢弃）。
    """
    # 顶/右交互后点左栏：强反模式
    if (a.is_right_cluster or a.quadrant == "tr") and b.is_left_rail:
        return True
    if strict and a.quadrant == "tr" and b.quadrant in ("tl", "bl") and b.is_left_rail:
        return True
    return False


def layout_hints_for_step(
    step: Any,
    sm: dict[int, Any],
    vw: float,
    vh: float,
) -> LayoutHints | None:
    """从 ExplorationStep 与当前 selector_map 取布局提示；scroll 无元素返回 None。"""
    sk = getattr(step, "step_kind", "click")
    if sk == "scroll":
        return None
    try:
        idx = int(getattr(step, "element_index", -1))
    except (TypeError, ValueError):
        return None
    if idx < 0 or idx not in sm:
        return None
    return layout_hints_for_element(sm[idx], vw, vh)
