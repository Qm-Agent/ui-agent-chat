#!/usr/bin/env python3
"""
ui-test-assistant-skill 前置环境检查：Python 须为 3.10–3.13（与 browser-use requires-python 对齐后
由本技能收窄上界），browser-use 固定 3.1.6，且可 import browser_use
（避免仅装了包元数据但缺 socksio 等传递依赖时 CLI 仍报错）。

- 若设置环境变量 UI_TEST_PYTHON（或兼容 UI_TEST_ASSISTANT_PYTHON），**仅**检查该解释器。
- 未设置时：先检查**运行本脚本的**解释器（sys.executable），若不满足则继续在 PATH 上探测
  python3.20、…、3.10 及 python3（按 realpath 去重），避免「默认 python3 为 Conda 旧版、
  browser-use 装在另一套 python3.12」时误判未安装。

版本检测使用 importlib.metadata（与 `python -m pip show` 同源），**不要**用裸 `pip show`，
以免 pip 与目标 Python 不是同一环境。

在 Claude / Cursor 等 Agent 中，是否为本脚本申请最高终端权限由**当前环境与平台**决定；若受限导致读不到本机
Python，可引导用户在 IDE 中放宽权限或到系统终端运行本脚本并设置 UI_TEST_PYTHON（见 SKILL.md「执行环境策略」）。

任意目录执行均可，注意传入技能目录下本脚本路径。
"""
from __future__ import annotations

import os
import argparse
import re
import shutil
import subprocess
import sys

# 与 SKILL 一致：browser-use 仓库 pyproject 多为 requires-python >=3.10,<4.0；
# 本技能支持 **3.10–3.13**（含）；新建环境仍推荐 3.10（历史联调与稳定性）。
PYTHON_MM_MIN = (3, 10)
PYTHON_MM_MAX = (3, 13)
# 固定 3.1.6，避免 `>=` 装到非本技能联调版本
PIN_BROWSER_USE = (3, 1, 5)

# 当前 Skill 使用经项目审核的 browser-use 3.1.6 wheel。该内部增量并非
# PyPI 同名发布线，安装来源由部署者通过环境变量明确提供。
BROWSER_USE_WHEEL = os.environ.get("UIWARDEN_BROWSER_USE_WHEEL", "/path/to/browser_use-3.1.6-py3-none-any.whl")


def python_range_label() -> str:
    return f"{PYTHON_MM_MIN[0]}.{PYTHON_MM_MIN[1]}–{PYTHON_MM_MAX[0]}.{PYTHON_MM_MAX[1]}"


SANDBOX_PIP_HINT = (
    "若在 Claude / Cursor 等 IDE 的受限沙箱中执行，`pip install` 往往写入临时环境、下次丢失。\n"
    f"请在本机终端用 **Python {python_range_label()}** 之一建固定 venv，并安装仓库 `vendor/browser-use/` 内经过净化和哈希校验的 SDK wheel（公网 PyPI 同名包不等同于本技能联调版本）。\n"
    "若无现成合适版本，**推荐**用 **Python 3.10** 建 venv（与技能历史联调一致），例如：\n"
    f"  /path/to/python3.10 -m venv ~/.venvs/ui-test-assistant\n"
    f"  ~/.venvs/ui-test-assistant/bin/python -m pip install -U pip\n"
    f"  ~/.venvs/ui-test-assistant/bin/python -m pip install \"{BROWSER_USE_WHEEL}\"\n"
    "  ~/.venvs/ui-test-assistant/bin/python -m playwright install chromium\n"
    "然后 export UI_TEST_PYTHON=$HOME/.venvs/ui-test-assistant/bin/python3\n"
    "或在 IDE 中酌情放宽终端/沙箱权限后再执行安装与 CLI，使命令落在本机持久 Python 上。"
)


def _version_tuple(version_str: str) -> tuple[int, ...]:
    parts: list[int] = []
    for seg in version_str.strip().split("."):
        m = re.match(r"(\d+)", seg)
        parts.append(int(m.group(1)) if m else 0)
    return tuple(parts)


def _version_matches_pin(installed: tuple[int, ...], pin: tuple[int, ...]) -> bool:
    if len(installed) < len(pin):
        return False
    return installed[: len(pin)] == pin


def _exe_real_key(path: str) -> str:
    try:
        return os.path.realpath(path)
    except OSError:
        return os.path.abspath(path)


def interpreters_from_env() -> list[str] | None:
    for key in ("UI_TEST_PYTHON", "UI_TEST_ASSISTANT_PYTHON"):
        v = os.environ.get(key, "").strip()
        if v:
            return [os.path.expanduser(v)]
    return None


def candidate_interpreters_without_env() -> list[str]:
    """PATH 上可能存在的 python3.x 候选（含 3.10–3.13，去重）；sys.executable 优先。"""
    out: list[str] = []
    seen: set[str] = set()

    def add(p: str | None) -> None:
        if not p:
            return
        exp = os.path.expanduser(p)
        if not (os.path.isfile(exp) and os.access(exp, os.X_OK)):
            return
        key = _exe_real_key(exp)
        if key in seen:
            return
        seen.add(key)
        out.append(exp)

    add(sys.executable)
    for minor in range(20, 9, -1):
        add(shutil.which(f"python3.{minor}"))
    add(shutil.which("python3"))
    return out


def check_python_at(exe: str) -> tuple[bool, str]:
    lo_maj, lo_min = PYTHON_MM_MIN
    _, hi_min = PYTHON_MM_MAX
    code = (
        "import sys\n"
        "v = sys.version_info\n"
        f"ok = v[0] == {lo_maj} and {lo_min} <= v[1] <= {hi_min}\n"
        "assert ok, 'need_py_range'\n"
        "print(f'{v.major}.{v.minor}.{v.micro}')\n"
    )
    try:
        r = subprocess.run(
            [exe, "-c", code],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except OSError as e:
        return False, f"无法执行解释器 {exe!r}: {e}"

    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        if "need_py_range" in err or "AssertionError" in err:
            return False, (
                f"{exe} 的 Python 不在本技能支持范围 **{python_range_label()}**（与 browser-use "
                "声明的 requires-python 对齐后，本技能将次版本上限定为 3.13）。\n"
                "若本机已有 **3.10–3.13** 且已安装 browser-use，请设 **UI_TEST_PYTHON** 指向该解释器；"
                "若尚无可用的 3.10–3.13，**推荐安装 Python 3.10** 并建 venv（见 SKILL.md「安装」）。"
            )
        return False, f"检查 Python 版本失败（{exe}）：{err or r.returncode}"

    ver_line = (r.stdout or "").strip().splitlines()[-1] if (r.stdout or "").strip() else ""
    return True, f"Python {ver_line}（解释器 {exe}，满足本技能 {python_range_label()}）"


def check_browser_use_at(exe: str) -> tuple[bool, str]:
    code = (
        "from importlib.metadata import PackageNotFoundError, version\n"
        "import sys\n"
        "try:\n"
        "    print(version('browser-use'))\n"
        "except PackageNotFoundError:\n"
        "    sys.exit(2)\n"
    )
    try:
        r = subprocess.run(
            [exe, "-c", code],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except OSError as e:
        return False, f"无法执行解释器 {exe!r}: {e}"

    if r.returncode == 2:
        return False, "未检测到已安装的 browser-use 包。\n" + SANDBOX_PIP_HINT

    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        return False, f"检查 browser-use 失败：{err or r.returncode}"

    ver = (r.stdout or "").strip().splitlines()[-1] if (r.stdout or "").strip() else ""
    tup = _version_tuple(ver)
    if not _version_matches_pin(tup, PIN_BROWSER_USE):
        return False, (
            f"已安装 browser-use {ver}，本技能固定为 {'.'.join(map(str, PIN_BROWSER_USE))}（勿用宽松 `>=` 以免装到非本技能联调版本）。\n"
            "请在该解释器上安装经授权、校验的本地 3.1.6 wheel：\n"
            f'  {exe} -m pip install "{BROWSER_USE_WHEEL}"\n'
            + SANDBOX_PIP_HINT
        )
    return True, f"browser-use {ver}（固定 {'.'.join(map(str, PIN_BROWSER_USE))}）"


def check_browser_use_import_at(exe: str) -> tuple[bool, str]:
    """已声明安装 browser-use 时，验证顶层 import 可用（常见缺失：socksio）。"""
    code = (
        "import sys\n"
        "try:\n"
        "    import browser_use  # noqa: F401\n"
        "except ModuleNotFoundError as e:\n"
        "    sys.stderr.write((e.name or '') + '\\n')\n"
        "    sys.exit(3)\n"
        "except Exception as e:\n"
        "    sys.stderr.write(type(e).__name__ + ': ' + str(e) + '\\n')\n"
        "    sys.exit(4)\n"
    )
    try:
        r = subprocess.run(
            [exe, "-c", code],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except OSError as e:
        return False, f"无法执行解释器 {exe!r}: {e}"

    if r.returncode == 0:
        return True, "`import browser_use` 正常"

    if r.returncode == 3:
        name = (r.stderr or "").strip().splitlines()[-1] if (r.stderr or "").strip() else ""
        if name == "socksio":
            return False, (
                "已安装 browser-use，但 `import browser_use` 失败：缺少 **socksio**（httpx SOCKS 可选依赖常未随环境装齐）。\n"
                f"请在该解释器执行：{exe} -m pip install socksio\n"
                f"或：{exe} -m pip install 'httpx[socks]'"
            )
        return False, (
            f"已安装 browser-use，但 `import browser_use` 失败：缺少模块 {name!r}。\n"
            f"请在该解释器安装对应 pip 包，或：{exe} -m pip install \"browser-use==3.1.6\""
        )

    err = (r.stderr or r.stdout or "").strip()
    return False, f"已安装 browser-use，但 `import browser_use` 失败：{err or r.returncode}"


def find_usable_interpreter() -> tuple[str | None, list[str], bool]:
    from_list = interpreters_from_env()
    from_env = from_list is not None
    exes = from_list if from_env else candidate_interpreters_without_env()
    failures: list[str] = []

    for exe in exes:
        ok_py, msg_py = check_python_at(exe)
        if not ok_py:
            failures.append(f"{exe}\n  → {msg_py}")
            continue

        ok_bu, msg_bu = check_browser_use_at(exe)
        if not ok_bu:
            failures.append(f"{exe}\n  → {msg_bu}")
            continue

        ok_imp, msg_imp = check_browser_use_import_at(exe)
        if not ok_imp:
            failures.append(f"{exe}\n  → {msg_imp}")
            continue

        return exe, failures, from_env

    return None, failures, from_env


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 ui-test-assistant-skill 的 browser-use 执行环境")
    parser.add_argument(
        "--print-python",
        action="store_true",
        help="只输出可用 Python 解释器路径，供脚本自动消费",
    )
    args = parser.parse_args()

    exe, failures, from_env = find_usable_interpreter()

    if args.print_python:
        if exe:
            print(exe)
            return 0
        return 2

    if from_env:
        print("检查解释器来自 UI_TEST_PYTHON / UI_TEST_ASSISTANT_PYTHON")
    else:
        print(
            "未设置 UI_TEST_PYTHON / UI_TEST_ASSISTANT_PYTHON：将依次尝试当前解释器及 PATH 上的 "
            "python3.x（避免 pip 与 python3 分属不同安装前缀时误判）。"
        )

    if exe:
        ok_py, msg_py = check_python_at(exe)
        ok_bu, msg_bu = check_browser_use_at(exe)
        ok_imp, msg_imp = check_browser_use_import_at(exe)
        if not from_env and _exe_real_key(exe) != _exe_real_key(sys.executable):
            print(f"选用解释器: {exe}（与运行本脚本的 {sys.executable!r} 不同）")
            print(
                "建议在执行 CLI 前设置: "
                f'export UI_TEST_PYTHON="{exe}"'
                " 以保证与检查、pip、playwright 使用同一 Python。"
            )
        elif not from_env:
            print(f"检查解释器: {exe}")
        print(msg_py)
        print(msg_bu)
        print(msg_imp)
        print("环境检查通过。")
        return 0

    exit_if_bu_fail = any("browser-use" in failure or "import browser_use" in failure for failure in failures)
    print(
        f"未找到同时满足 Python {python_range_label()}、browser-use 3.1.6 且可 import browser_use 的解释器。\n"
    )
    print("\n\n".join(failures))
    print(
        "\n提示：不要用系统默认的裸 `pip` / `pip show` 判断（可能与 `python3` 不是同一环境）；"
        "请用 `你的python -m pip …` 或重新运行本脚本。"
    )
    print(
        "\n若 pip 报找不到 browser-use==3.1.6：请使用仓库内置并经校验的 SDK wheel：\n"
        f'  "<PY>" -m pip install "{BROWSER_USE_WHEEL}"\n'
        f"（将 <PY> 换为你的 **{python_range_label()}** 可执行路径之一，且与 pip/CLI 为同一解释器；"
        "wheel 的哈希、内容净化和第三方许可由项目发布门禁校验。）"
    )
    return 2 if exit_if_bu_fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
