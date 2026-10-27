from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


def stable_hash(parts: list[str]) -> str:
    raw = "\n".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_url(
    url: str,
    *,
    strip_trailing_slash: bool = True,
    keep_fragment: bool = False,
) -> str:
    p = urlparse(url.strip())
    path = p.path or "/"
    if strip_trailing_slash and len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    q = parse_qsl(p.query, keep_blank_values=True)
    q_sorted = sorted(q, key=lambda x: (x[0], x[1]))
    query = urlencode(q_sorted, doseq=True)
    frag = p.fragment if keep_fragment else ""
    return urlunparse((p.scheme.lower(), (p.hostname or "").lower(), path, "", query, frag))


def site_key_from_url(url: str) -> str:
    """技能级 site_key：无 publicsuffix 库时取 hostname 末两段（常见二级域）。"""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return "unknown"
    parts = [x for x in host.split(".") if x]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host


def element_fingerprint(
    index: int,
    branch_path_hash: str,
    tag_name: str,
    attrs: dict[str, str],
    *,
    action_kind: str = "click",
) -> str:
    keys = ("data-testid", "id", "name", "aria-label", "role", "href")
    parts = [str(index), branch_path_hash, tag_name.lower(), action_kind]
    for k in keys:
        v = (attrs or {}).get(k, "")
        if v:
            parts.append(f"{k}={v}")
    return stable_hash(parts)


def scroll_fingerprint(delta_y: int, *, surface: str = "window") -> str:
    """视口/窗口滚动，与 DOM 元素指纹解耦。"""
    return stable_hash(["scroll", surface, str(int(delta_y))])


def structural_state_id(url_norm: str, title: str, landmark_text: str) -> str:
    t = re.sub(r"\s+", " ", (title or "").strip())[:200]
    m = re.sub(r"\s+", " ", (landmark_text or "").strip())[:400]
    return stable_hash(["structural", url_norm, t, m])


def actionable_signature_from_hashes(sorted_branch_hashes: list[str]) -> str:
    return stable_hash(["actionable_sig", ",".join(sorted_branch_hashes)])


def page_state_id(structural_id: str, actionable_sig: str) -> str:
    return stable_hash(["page_state", structural_id, actionable_sig])


def canonical_prefix_steps_json(steps: list[dict[str, Any]]) -> str:
    return json.dumps(steps, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def dedupe_path_key(anchor_url_norm: str, prefix_canonical: str, target_fp: str) -> str:
    return stable_hash(["path", anchor_url_norm, prefix_canonical, target_fp])


def dedupe_action_key(anchor_url_norm: str, page_state_id_before: str, action_fp: str) -> str:
    return stable_hash(["action", anchor_url_norm, page_state_id_before, action_fp])


def dedupe_url_key(url_norm: str) -> str:
    return stable_hash(["url", url_norm])


def url_equivalence_key(url: str) -> str:
    """URL 结构等价 key：path + 排序后的参数名集合（忽略参数值）。

    例如 ``/page?tenantId=A&tab=1`` 和 ``/page?tenantId=B&tab=2``
    有相同的等价 key，视为同构页面。
    """
    p = urlparse(url.strip())
    path = p.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    params = parse_qsl(p.query, keep_blank_values=True)
    param_names = sorted(set(k for k, _ in params))
    return stable_hash(["url_equiv", (p.hostname or "").lower(), path, ",".join(param_names)])


def css_selector_skeleton(css: str) -> str:
    """将 CSS selector 中的索引/数字替换为占位符，提取 DOM 骨架。

    例如 ``div > ul > li:nth-child(3) > a.link`` → ``div > ul > li:nth-child(*) > a.link``
    同一列表下的不同行因此映射到同一骨架。
    """
    return re.sub(r":nth-child\(\d+\)", ":nth-child(*)", css)


def text_overlap_ratio(a: str, b: str) -> float:
    """Token 级 Jaccard 相似度，用于元素文本模糊匹配。"""
    sa = set(a.lower().split())
    sb = set(b.lower().split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)
