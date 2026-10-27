"""Skill-layer config resolution: user query + skill config/.env only."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

_URL_RE = re.compile(r"https?://[^\s<>\"'）)]+", re.IGNORECASE)
# browser-use 将 quick 原文写入 OmegaConf 的 quick_display_query；${VAR} 会在收尾读配置时触发插值错误，导致无 HTML 报告
_OMEGACONF_INTERP_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

# quick 自然语言中推荐使用的登录说明（勿写 ${USERNAME}，执行层由 browser-use 从 .env 注入）
QUICK_LOGIN_HINT = (
    "使用 config/.env 中的登录账号密码（若 CDP 已登录可跳过；"
    "出现登录表单时由 browser-use 自动使用环境变量，无需在任务文案中写 ${USERNAME}）"
)

_LOGIN_VAR_REPLACEMENTS: dict[str, str] = {
    "USERNAME": "config/.env 中的登录账号",
    "PASSWORD": "config/.env 中的登录密码",
    "QUICK_USERNAME": "config/.env 中的登录账号",
    "QUICK_PASSWORD": "config/.env 中的登录密码",
    "QUICK_NAME": "config/.env 中的登录账号",
    "QUICK_PASSWORK": "config/.env 中的登录密码",
    "BU_USERNAME": "config/.env 中的登录账号",
    "BU_PASSWORD": "config/.env 中的登录密码",
}

# 与 browser-use `resolve_quick_url` / `.env.example` 对齐：QUICK_URL 优先；兼容旧别名
_ENV_URL_KEYS = ("QUICK_URL", "QUICK_TARGET_URL", "TARGET_URL")
# 与 browser-use `build_quick_sensitive_data` 对齐（文本内凭据仍优先）
_ENV_USER_KEYS = (
    "QUICK_NAME",
    "QUICK_USERNAME",
    "BU_USERNAME",
    "USERNAME",
)
_ENV_PASSWORD_KEYS = (
    "QUICK_PASSWORK",
    "QUICK_PASSWORD",
    "BU_PASSWORD",
    "PASSWORD",
)

DEFAULT_QUICK_MAX_STEPS = 40
DEFAULT_QUICK_MAX_RETRIES = 1


def _env_first(keys: tuple[str, ...]) -> str:
    for key in keys:
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return ""


def extract_url(text: str) -> str:
    match = _URL_RE.search(text or "")
    if not match:
        return ""
    return match.group(0).rstrip("。，,.)")


def resolve_target_url_from_env() -> str:
    raw = _env_first(_ENV_URL_KEYS)
    if not raw:
        return ""
    return raw


def resolve_target_url(
    query: str = "",
    *,
    explicit_url: str = "",
    task_prefix: str = "",
    user_query: str = "",
) -> str:
    """Resolve entry URL (priority: --target-url > text URL > QUICK_URL > legacy aliases).

    Text/env resolution matches browser-use ``resolve_quick_url`` when installed.
    """
    explicit = (explicit_url or "").strip()
    if explicit:
        found = extract_url(explicit) or explicit
        if found.lower().startswith("http"):
            return found

    combined = "\n".join(p for p in (user_query, query, task_prefix) if p)
    try:
        from browser_use.agent.quick import resolve_quick_url

        bu_url = resolve_quick_url(combined, explicit_url=None)
        if bu_url:
            return bu_url
    except ImportError:
        found = extract_url(combined)
        if found:
            return found

    # .env：QUICK_URL（browser-use）> QUICK_TARGET_URL / TARGET_URL（技能旧别名）
    return resolve_target_url_from_env()


def resolve_quick_max_steps(cli_value: int | None = None) -> int:
    """Quick ReAct max steps: CLI > QUICK_MAX_STEPS in .env > default 40."""
    if cli_value is not None:
        return max(1, int(cli_value))
    raw = (os.environ.get("QUICK_MAX_STEPS") or "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return DEFAULT_QUICK_MAX_STEPS


def resolve_quick_max_retries(cli_value: int | None = None) -> int:
    """Quick self-heal retries: CLI > QUICK_MAX_RETRIES in .env > default 1."""
    if cli_value is not None:
        return max(0, int(cli_value))
    raw = (os.environ.get("QUICK_MAX_RETRIES") or "").strip()
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return DEFAULT_QUICK_MAX_RETRIES


def sanitize_quick_query_for_cli(text: str) -> str:
    """Remove OmegaConf-style ``${VAR}`` from quick CLI text.

    browser-use stores the same string in ``quick_display_query``; unresolved
    interpolations break ``quick_task_result.json`` / HTML report generation.
    Login placeholders are still injected into ``task_text`` from ``.env`` by
    ``build_quick_sensitive_data`` — they must not appear in natural-language query.
    """
    if not text:
        return text

    def _repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key in _LOGIN_VAR_REPLACEMENTS:
            return _LOGIN_VAR_REPLACEMENTS[key]
        return f"（{key}）"

    return _OMEGACONF_INTERP_RE.sub(_repl, text)


def enrich_query_with_target_url(
    query: str,
    *,
    explicit_url: str = "",
    task_prefix: str = "",
    user_query: str = "",
) -> str:
    if extract_url(query):
        return query
    url = resolve_target_url(
        query,
        explicit_url=explicit_url,
        task_prefix=task_prefix,
        user_query=user_query,
    )
    if not url:
        return query
    stripped = (query or "").strip()
    if stripped:
        return f"快速测试 {url}。{stripped}"
    return f"快速测试 {url}"


def missing_login_fields(
    cli_username: str = "",
    cli_password: str = "",
) -> list[str]:
    missing: list[str] = []
    has_user = bool(_env_first(_ENV_USER_KEYS)) or bool((cli_username or "").strip())
    has_pass = bool(_env_first(_ENV_PASSWORD_KEYS)) or bool((cli_password or "").strip())
    if not has_user:
        missing.append(
            "登录账号（通过 --username 传入，或 config/.env 配置 QUICK_NAME / USERNAME 等）"
        )
    if not has_pass:
        missing.append(
            "登录密码（通过 --password 传入，或 config/.env 配置 QUICK_PASSWORK / PASSWORD 等）"
        )
    if missing:
        missing.append(
            "若用户已在对话中提供账号密码，请直接用 --username <账号> --password <密码> 传入，不要停下来问确认或要求编辑 .env"
        )
        missing.append(
            "若测试公开页面无需登录，可加 --no-login 跳过凭据检查"
        )
    return missing


def format_missing_target_url_guide(*, skill_root: Path | None = None) -> str:
    env_path = (skill_root / "config" / ".env") if skill_root else Path("config/.env")
    env_example = str(env_path)
    return "\n".join(
        [
            "【测试入口 URL】请任选一种方式提供后重试：",
            "",
            "方式一 · 在本条对话中写出完整 https:// 地址，例如：",
            "  快速测试 https://your-app.example.com/path?tenant=demo …",
            "",
            f"方式二 · 编辑 {env_example}，增加（与 browser-use 对齐，推荐 QUICK_URL）：",
            "  QUICK_URL=https://your-app.example.com/path?tenant=demo",
            "  （兼容旧名：QUICK_TARGET_URL / TARGET_URL）",
            "",
            "方式三 · 命令行显式传入：",
            '  run_quick_mode.py --query "…" --target-url "https://…" …',
            "  或批量/文档模式：--target-url / --task-prefix \"入口 URL：https://…\"",
            "",
            "禁止：从 .skill-output 历史产物、白皮书「探索环境」、其他项目 .env/YAML",
            "      或过往对话中自行推断 URL；缺 URL 时须停止并等待用户补充。",
        ]
    )


@dataclass
class PreflightResult:
    ok: bool
    target_url: str = ""
    enriched_query: str = ""
    missing: list[str] = field(default_factory=list)
    context_errors: list[str] = field(default_factory=list)

    @property
    def message(self) -> str:
        lines = [
            "缺少执行所需配置：",
            "",
        ]
        for idx, item in enumerate(self.missing, start=1):
            lines.append(f"{idx}. {item}")
        if self.context_errors:
            lines.append("")
            lines.append("辅助资料路径问题：")
            for err in self.context_errors:
                lines.append(f"- {err}")
        lines.extend(
            [
                "",
                "允许的配置来源：",
                "- 用户当次 query / 对话中明确给出的 URL、步骤、文件路径、账号密码",
                "- 命令行参数：--username / --password / --target-url / --no-login",
                "- 本技能 config/.env（如 QUICK_URL、QUICK_USERNAME、BU_LOCAL_BROWSER_CDP_URL 等）",
                "",
                "禁止从工作区其他项目、.skill-output 历史运行记录、白皮书探索环境名",
                "或其它文档中推断 URL、租户 ID 或账号。",
            ]
        )
        return "\n".join(lines)


def validate_context_paths(
    paths: Iterable[Path],
    *,
    skill_root: Path,
    user_query: str,
) -> list[str]:
    errors: list[str] = []
    skill_root = skill_root.resolve()
    query_text = user_query or ""
    for raw in paths:
        path = raw.expanduser()
        if not path.exists():
            errors.append(f"路径不存在且未在用户 query 中有效提供：{path}")
            continue
        resolved = path.resolve()
        explicitly_mentioned = (
            str(resolved) in query_text or str(path) in query_text or resolved.name in query_text
        )
        try:
            resolved.relative_to(skill_root / ".skill-output")
            if not explicitly_mentioned:
                errors.append(
                    f"禁止自动将 .skill-output 历史产物作为 --context：{resolved}。"
                    "只有用户当次 query 明确给出该路径时才允许。"
                )
                continue
        except ValueError:
            pass
        try:
            resolved.relative_to(skill_root)
            continue
        except ValueError:
            pass
        if explicitly_mentioned:
            continue
        errors.append(
            f"禁止将其他项目路径作为 --context：{resolved}。"
            "仅允许用户 query 中明确给出的路径，或技能包目录内的 references/ 等文档。"
        )
    return errors


def preflight_quick(
    query: str = "",
    *,
    explicit_target_url: str = "",
    task_prefix: str = "",
    user_query: str = "",
    context_paths: Iterable[Path] | None = None,
    skill_root: Path | None = None,
    require_url: bool = True,
    require_login: bool = True,
    cli_username: str = "",
    cli_password: str = "",
) -> PreflightResult:
    validation_query = " ".join(
        p for p in (user_query, query, task_prefix, explicit_target_url) if p
    )
    target_url = resolve_target_url(
        query,
        explicit_url=explicit_target_url,
        task_prefix=task_prefix,
        user_query=user_query,
    )
    enriched = sanitize_quick_query_for_cli(
        enrich_query_with_target_url(
            query,
            explicit_url=explicit_target_url,
            task_prefix=task_prefix,
            user_query=user_query,
        )
    )
    missing: list[str] = []

    if require_url and not target_url:
        missing.append(format_missing_target_url_guide(skill_root=skill_root))
    if require_login:
        missing.extend(missing_login_fields(cli_username=cli_username, cli_password=cli_password))

    context_errors: list[str] = []
    if context_paths and skill_root is not None:
        context_errors = validate_context_paths(
            context_paths,
            skill_root=skill_root,
            user_query=validation_query,
        )

    ok = not missing and not context_errors
    return PreflightResult(
        ok=ok,
        target_url=target_url,
        enriched_query=enriched,
        missing=missing,
        context_errors=context_errors,
    )
