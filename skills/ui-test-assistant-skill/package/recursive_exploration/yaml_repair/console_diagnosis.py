"""自愈过程中向控制台输出失败分析与修复策略（便于用户感知每轮在做什么）。"""

from __future__ import annotations

import re
from pathlib import Path


def _tail_file(path: Path, max_chars: int = 6000) -> str:
    if not path.is_file():
        return ""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if len(raw) <= max_chars:
        return raw
    return "...[log 仅保留末尾]\n" + raw[-max_chars:]


def _primary_stderr_message(stderr: str) -> str:
    s = (stderr or "").strip()
    if not s:
        return "（子进程 stderr 为空或未捕获）"
    lines = [ln.rstrip() for ln in s.splitlines() if ln.strip()]
    # 优先末条 RuntimeError / 断言文案
    for ln in reversed(lines):
        if "RuntimeError:" in ln:
            return ln.strip()[:800]
        if ln.startswith("Assertion reason:") or "Assertion:" in ln:
            return ln.strip()[:800]
    blob = "\n".join(lines[-8:])
    return blob[-1200:] if len(blob) > 1200 else blob


def _log_hints(log_tail: str) -> list[str]:
    hints: list[str] = []
    low = log_tail.lower()
    if "assertion: false" in low:
        hints.append("日志含断言失败（Assertion: False），瞬时 Toast 类断言可能已错过展示时机")
    if "assertion reason:" in low:
        m = re.search(r"Assertion reason:\s*(.+)", log_tail, re.I | re.M)
        if m:
            hints.append(f"断言说明摘录: {m.group(1).strip()[:200]}")
    if "timeout after" in low:
        hints.append(
            "日志含步骤超时（timeout）；具体等待条件是否合理交给下一步 LLM 结合全文日志与 YAML 分析"
        )
    if "账号或密码错误" in log_tail or "密码错误" in log_tail:
        hints.append("日志提示账号或密码错误，请核对环境与账密")
    if "[cache]" in low and "l2 cache hit" in low:
        hints.append("日志仍出现 L2 cache hit（若期望完全不走缓存，请确认 cache.enabled=false）")
    return hints[:6]


def print_round_execution_failed_header(round_idx: int, returncode: int) -> None:
    print(f"\n{'─' * 58}")
    print(f"[yaml_repair] ■ 第 {round_idx} 轮执行结束：失败（CLI 退出码 {returncode}）")
    print(f"{'─' * 58}")


def print_failure_analysis(
    *,
    stderr: str,
    stdout: str,
    log_dir: Path,
    vision_next_round: bool,
) -> None:
    """在尝试修复前打印可读失败分析。"""
    print("\n【失败原因分析】")
    msg = _primary_stderr_message(stderr)
    print(f"  · stderr 要点:\n    {msg.replace(chr(10), chr(10) + '    ')}")

    log_path = Path(log_dir) / "log.log"
    tail = _tail_file(log_path)
    if tail.strip():
        hints = _log_hints(tail)
        if hints:
            for h in hints:
                print(f"  · {h}")
        else:
            last_lines = [ln for ln in tail.splitlines() if ln.strip()][-4:]
            if last_lines:
                print("  · log.log 末尾片段:")
                for ln in last_lines:
                    print(f"    {ln[:240]}")
    else:
        print("  · （尚未生成 log.log 或无读取权限）")

    if vision_next_round:
        print("  · 下一轮 LLM 改写将附带「阶梯 vision」提示（截图/视觉线索权重更高）")

    _stdout_preview = (stdout or "").strip()
    if len(_stdout_preview) > 400:
        _stdout_preview = _stdout_preview[:400] + "…"
    if _stdout_preview:
        print(f"  · stdout 摘要: {_stdout_preview}")


def print_repair_strategy(title: str, detail: str = "") -> None:
    print(f"\n【本次修复策略】{title}")
    if detail.strip():
        # 多行缩进
        for line in detail.strip().splitlines():
            print(f"  {line}")


def print_llm_repair_planned(use_vision_hint: bool) -> None:
    vision = "开启 vision 提示" if use_vision_hint else "未开启 vision 提示"
    print_repair_strategy(
        "调用 LLM 基于失败摘要改写 YAML",
        f"将把 stderr/stdout 摘要与当前 YAML 发给模型生成候选；{vision}。\n"
        "门禁：不得新增断言/pyCode/jsCode/aiQuery（相对首轮合并基线）。",
    )


def print_gate_rejected(context: str, verr: str) -> None:
    print_repair_strategy(f"门禁拒绝（{context}）", verr)


def print_round_success(round_idx: int) -> None:
    print(f"\n[yaml_repair] ✓ 第 {round_idx} 轮 CLI 执行成功，自愈在本轮结束。")
