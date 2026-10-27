#!/usr/bin/env python3
"""Patch browser-use for UIWarden runtime compatibility.

Applies packaging, browser, and public model-route compatibility patches.

1. **CLI extra_chromium_args forwarding** — browser-use==3.1.6's CLI builds
   BrowserConfig without forwarding ``cfg.browser.extra_chromium_args``.
   This patch adds the forwarding in two BrowserConfig construction sites.

2. **Docker-friendly base Chromium flags** — Adds ``--disable-dev-shm-usage``
   and ``--no-zygote`` to the base launch args in
   ``Browser._build_launch_args()``. These flags are essential for Chromium
   to run in Docker/CI containers where ``/dev/shm`` is small (default 64MB)
   and the zygote process cannot fork properly. Without these flags Chromium
   crashes immediately with "Target page, context or browser has been closed".

3. **Launch diagnostics** — Logs the actual Chromium args and environment
   before launching, making it easy to debug launch failures.

Usage (idempotent, safe to re-run):
    python3 scripts/patch-browser-use.py

Typically called during the default Docker image build.
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path


def _find_cli_py() -> Path | None:
    """Locate browser_use/cli.py on disk."""
    try:
        mod = importlib.import_module("browser_use.cli")
        return Path(mod.__file__)
    except Exception:
        return None


def _find_browser_py() -> Path | None:
    """Locate browser_use/browser/browser.py on disk."""
    try:
        mod = importlib.import_module("browser_use.browser.browser")
        return Path(mod.__file__)
    except Exception:
        return None


def _find_context_py() -> Path | None:
    """Locate browser_use/browser/context.py on disk."""
    try:
        mod = importlib.import_module("browser_use.browser.context")
        return Path(mod.__file__)
    except Exception:
        return None


def _find_controller_service_py() -> Path | None:
    """Locate browser_use/controller/service.py on disk."""
    try:
        mod = importlib.import_module("browser_use.controller.service")
        return Path(mod.__file__)
    except Exception:
        return None


def _find_chat_models_py() -> Path | None:
    """Locate browser_use/agent/chat_models.py on disk."""
    try:
        mod = importlib.import_module("browser_use.agent.chat_models")
        return Path(mod.__file__)
    except Exception:
        return None


def _find_agent_service_py() -> Path | None:
    """Locate browser_use/agent/service.py on disk."""
    try:
        mod = importlib.import_module("browser_use.agent.service")
        return Path(mod.__file__)
    except Exception:
        return None


def _patch_public_openai_models(src: str) -> tuple[str, bool]:
    """Allow configured public OpenAI-compatible vision model names."""
    marker = "UIWarden public OpenAI-compatible model resolver"
    if marker in src:
        return src, False

    factory_end = """\
}


def build_models("""
    resolver = """\
}


# UIWarden public OpenAI-compatible model resolver.
def _uiwarden_openai_credentials():
    return os.getenv("BU_OPENAI_API_KEY"), os.getenv("BU_OPENAI_API_BASE")


def _uiwarden_resolve_model(model_name):
    configured = __factory__.get(model_name)
    if configured is not None:
        return configured
    api_key, base_url = _uiwarden_openai_credentials()
    if not model_name or not api_key or not base_url:
        return None
    return ChatOpenAI(
        model=model_name,
        api_key=api_key,
        base_url=base_url,
        temperature=0.0,
        timeout=120,
    )


def build_models("""
    if factory_end not in src:
        return src, False
    src = src.replace(factory_end, resolver, 1)

    old_validation = """\
    assert all(
        model in __factory__
        for model in [actor, planner, asserter, page_extraction_llm, locating_llm, coding_llm]
    ), f"Invalid model name: {actor}, {planner}, {asserter}, {page_extraction_llm}, {locating_llm}, {coding_llm}"

    actor_llm = __factory__[actor]
    planner_llm = __factory__[planner]
    asserter_llm = __factory__[asserter]
"""
    new_validation = """\
    model_names = [actor, planner, asserter, page_extraction_llm, locating_llm, coding_llm]
    if not all(isinstance(model, str) and model.strip() for model in model_names):
        raise ValueError(f"Invalid empty model name: {model_names}")

    actor_llm = _uiwarden_resolve_model(actor)
    planner_llm = _uiwarden_resolve_model(planner)
    asserter_llm = _uiwarden_resolve_model(asserter)
    page_extraction_model = _uiwarden_resolve_model(page_extraction_llm)
    locating_model = _uiwarden_resolve_model(locating_llm)
    coding_model = _uiwarden_resolve_model(coding_llm)
"""
    if old_validation not in src:
        return src, False
    src = src.replace(old_validation, new_validation, 1)

    old_aux = """\
            "page_extraction_llm": __factory__[page_extraction_llm],
            "locating_llm": __factory__[locating_llm],
            "coding_llm": __factory__[coding_llm]
"""
    new_aux = """\
            "page_extraction_llm": page_extraction_model,
            "locating_llm": locating_model,
            "coding_llm": coding_model
"""
    if old_aux not in src:
        return src, False
    src = src.replace(old_aux, new_aux, 1)

    old_error_pattern = re.compile(
        r"    if actor_llm is None:\n"
        r"(?:.*\n)+?"
        r"    if planner_llm is None:\n"
        r"(?:.*\n)+?"
        r"    if asserter_llm is None:\n"
        r"(?:.*\n)+?"
        r"(?=    return )"
    )
    new_error_block = '''\
    missing = [
        role
        for role, model in (
            ("actor", actor_llm),
            ("planner", planner_llm),
            ("asserter", asserter_llm),
            ("page_extraction_llm", page_extraction_model),
            ("locating_llm", locating_model),
            ("coding_llm", coding_model),
        )
        if model is None
    ]
    if missing:
        raise RuntimeError(
            f"Models unavailable for roles {missing}. Configure BU_OPENAI_API_KEY and "
            "BU_OPENAI_API_BASE for an OpenAI-compatible provider."
        )
'''
    if not old_error_pattern.search(src):
        return src, False
    return old_error_pattern.sub(new_error_block, src, count=1), True


def _patch_public_model_box_format(src: str) -> tuple[str, bool]:
    """Give configured public vision models a valid coordinate convention."""
    marker = "UIWarden configurable public model box format"
    if marker in src:
        return src, False

    old = '''\
    @staticmethod
    def model_name_to_box_format(model_name: str):
        model_name = model_name.lower()
        if "gemini" in model_name:
            return "tlbr"
        elif "qwen3-vl" in model_name:
            return "ltrb"
'''
    new = '''\
    @staticmethod
    def model_name_to_box_format(model_name: str):
        model_name = model_name.lower()
        if "gemini" in model_name:
            return "tlbr"
        if "qwen3-vl" in model_name:
            return "ltrb"

        # UIWarden configurable public model box format. Public OpenAI-compatible
        # model names are not present in browser-use 3.1.6's fixed model map.
        # ltrb matches Qwen vision models; callers may override it explicitly.
        configured = os.getenv("BU_MODEL_BOX_FORMAT", "ltrb").strip().lower()
        return configured if configured in {"tlbr", "ltrb"} else "ltrb"
'''
    if old not in src:
        return src, False
    return src.replace(old, new, 1), True


def _patch_semantic_ancestor_iou(src: str) -> tuple[str, bool]:
    """Keep a strong text hit when promoting it to a clickable ancestor."""
    marker = "preserve the original child IoU"
    if marker in src:
        return src, False

    old = '''\
                max_iou = calculate_iou(
                    (unnormalized_box_2d[1], unnormalized_box_2d[0],
                     unnormalized_box_2d[3], unnormalized_box_2d[2]),
                    (semantic_ancestor.rectangle["left"], semantic_ancestor.rectangle["top"],
                     semantic_ancestor.rectangle["right"], semantic_ancestor.rectangle["bottom"]),
                )
'''
    new = '''\
                # UIWarden: preserve the original child IoU. A precise text hit
                # should not become a low-confidence match merely because its
                # semantic button ancestor has a larger rectangle.
                max_iou = max(max_iou, calculate_iou(
                    (unnormalized_box_2d[1], unnormalized_box_2d[0],
                     unnormalized_box_2d[3], unnormalized_box_2d[2]),
                    (semantic_ancestor.rectangle["left"], semantic_ancestor.rectangle["top"],
                     semantic_ancestor.rectangle["right"], semantic_ancestor.rectangle["bottom"]),
                ))
'''
    count = src.count(old)
    if count == 0:
        return src, False
    return src.replace(old, new), True


def _patch_task_browserconfig(src: str) -> tuple[str, bool]:
    """Patch the task-run BrowserConfig (around line 1048 in v3.1.6).

    Before:
        browser = Browser(
            config=BrowserConfig(
                headless=headless,
                browser_type=browser_type,
                new_context_config=BrowserContextConfig(
    After:
        extra_chromium_args = list(getattr(cfg.browser, "extra_chromium_args", [])) ...
        browser = Browser(
            config=BrowserConfig(
                headless=headless,
                browser_type=browser_type,
                extra_chromium_args=extra_chromium_args,
                new_context_config=BrowserContextConfig(
    """
    marker = "extra_chromium_args=extra_chromium_args,"
    if marker in src:
        return src, False

    old = """\
    browser = Browser(
        config=BrowserConfig(
            headless=headless,
            browser_type=browser_type,
            new_context_config=BrowserContextConfig("""
    new = """\
    extra_chromium_args = list(getattr(cfg.browser, "extra_chromium_args", [])) if getattr(cfg.browser, "extra_chromium_args", None) else []
    browser = Browser(
        config=BrowserConfig(
            headless=headless,
            browser_type=browser_type,
            extra_chromium_args=extra_chromium_args,
            new_context_config=BrowserContextConfig("""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_quick_browserconfig(src: str) -> tuple[str, bool]:
    """Patch the quick-run BrowserConfig (around line 1179 in v3.1.6).

    Before:
        browser_config_kwargs = {
            "headless": headless,
            "new_context_config": context_config,
            "_force_keep_browser_alive": use_cdp,
        }
        if use_cdp:
    After:
        browser_config_kwargs = {
            "headless": headless,
            "new_context_config": context_config,
            "_force_keep_browser_alive": use_cdp,
        }
        extra_args = getattr(cfg.browser, "extra_chromium_args", None)
        if extra_args:
            browser_config_kwargs["extra_chromium_args"] = list(extra_args) ...
        if use_cdp:
    """
    marker = 'browser_config_kwargs["extra_chromium_args"]'
    if marker in src:
        return src, False

    old = """\
    browser_config_kwargs = {
        "headless": headless,
        "new_context_config": context_config,
        "_force_keep_browser_alive": use_cdp,
    }
    if use_cdp:"""
    new = """\
    browser_config_kwargs = {
        "headless": headless,
        "new_context_config": context_config,
        "_force_keep_browser_alive": use_cdp,
    }
    # Pass extra_chromium_args from OmegaConf config (e.g. browser.extra_chromium_args=[--no-zygote])
    extra_args = getattr(cfg.browser, "extra_chromium_args", None)
    if extra_args:
        browser_config_kwargs["extra_chromium_args"] = list(extra_args) if not isinstance(extra_args, list) else extra_args
    if use_cdp:"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_build_launch_args(src: str) -> tuple[str, bool]:
    """Patch Browser._build_launch_args() to add Docker-friendly base flags.

    Adds ``--disable-dev-shm-usage``, ``--no-zygote``, and ``--disable-gpu``
    to the base_args list so they are always present, regardless of whether
    extra_chromium_args is passed through the OmegaConf pipeline. Without
    these flags Chromium crashes immediately in Docker containers with:
        "Target page, context or browser has been closed"

    --disable-dev-shm-usage: tells Chromium to use /tmp instead of /dev/shm.
        Docker's default /dev/shm is 64MB, too small for Chromium rendering.
        This flag is safe on all platforms (slightly slower but always works).

    --no-zygote: prevents Chromium from using the zygote process to pre-fork
        renderers. The zygote cannot fork properly in Docker/CI containers.
        This flag is safe on all platforms (slightly slower but more reliable).

    --disable-gpu: prevents Chromium from trying to initialize GPU drivers.
        Docker containers typically have no GPU; without this flag Chromium
        may crash during GPU init. Safe on all platforms.
    """
    marker = "Docker/CI: use /tmp instead of /dev/shm"
    if marker in src:
        return src, False

    old = "            '--disable-hsts',"
    new = """\
            '--disable-hsts',
            # Docker/CI: use /tmp instead of /dev/shm (default 64MB too small)
            '--disable-dev-shm-usage',
            # Docker/CI: zygote cannot fork in containers
            '--no-zygote',
            # Docker/CI: no GPU available, avoid GPU init crash
            '--disable-gpu',"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_launch_diagnostics(src: str) -> tuple[str, bool]:
    """Add diagnostic logging before browser launch.

    Logs the actual Chromium args and key environment indicators so that
    launch failures can be diagnosed from the log output.
    """
    marker = "is_docker = os.path.isfile(\"/.dockerenv\")"
    if marker in src:
        return src, False

    old = '        browser = await launcher.launch(**launch_kwargs)'
    new = """\
        # Diagnostic: log actual Chromium args and environment
        is_docker = os.path.isfile("/.dockerenv")
        logger.info(
            "Chromium launch args: headless=%s, docker=%s, args=%s",
            self.config.headless, is_docker, launch_kwargs.get("args", []),
        )
        browser = await launcher.launch(**launch_kwargs)"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_force_full_chromium(src: str) -> tuple[str, bool]:
    """Force full Chromium binary instead of headless-shell in headless mode.

    Playwright 1.52+ uses chrome-headless-shell by default when headless=True.
    On macOS, headless-shell crashes with MachPortRendezvous Permission denied
    in sandboxed environments (e.g., Claude Agent SDK). The full Chromium binary
    correctly handles --disable-features=MachPortRendezvous. On Linux/Docker
    both binaries work, but full Chromium is equally reliable.

    This patch adds channel="chrome-for-testing" when headless=True and no
    channel/executable_path is set, which tells Playwright to use the full
    Chromium binary instead of headless-shell.
    """
    marker = 'launch_kwargs["channel"] = "chrome-for-testing"'
    if marker in src:
        return src, False

    old = """\
        if profile.executable_path:
            launch_kwargs["executable_path"] = profile.executable_path

        # Diagnostic: log actual Chromium args and environment"""
    new = """\
        if profile.executable_path:
            launch_kwargs["executable_path"] = profile.executable_path

        # Force full Chromium binary instead of headless-shell.
        # Playwright 1.52+ uses chrome-headless-shell by default in headless mode,
        # which crashes on macOS with MachPortRendezvous Permission denied in
        # sandboxed environments. Full Chromium correctly handles
        # --disable-features=MachPortRendezvous. On Linux/Docker both work,
        # but full Chromium is equally reliable.
        if self.config.headless and not launch_kwargs.get("channel") and not launch_kwargs.get("executable_path"):
            launch_kwargs["channel"] = "chrome-for-testing"

        # Diagnostic: log actual Chromium args and environment"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_navigate_to(src: str) -> tuple[str, bool]:
    """Patch BrowserContext.navigate_to() to relax goto timeout and wait strategy.

    browser-use==3.1.6's ``navigate_to`` (used by the go_to_url action) calls
    ``page.goto(url)`` with no timeout and the default ``wait_until="load"``,
    then ``page.wait_for_load_state()`` (also "load"). Playwright's default
    navigation timeout is 30s, and the "load" event waits for ALL resources
    (including dev-tools WebSocket handshakes) to finish. For SPAs with heavy
    first-paint logic this never fires within 30s, causing:
        "Error executing action go_to_url: Page.goto: Timeout 30000ms exceeded."

    This patch aligns the standard agent path with the project's
    recursive_exploration config (90s + domcontentloaded): wait only for DOM
    readiness, not full resource load, and extend the timeout to 90s.
    """
    marker = "wait_until=\"domcontentloaded\"  # patched: relax SPA navigation"
    if marker in src:
        return src, False

    old = """\
        page = await self.get_current_page()
        await page.goto(url)
        await page.wait_for_load_state()
"""
    new = """\
        page = await self.get_current_page()
        await page.goto(url, timeout=90_000, wait_until="domcontentloaded")  # patched: relax SPA navigation
        await page.wait_for_load_state("domcontentloaded")
"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_controller_go_to_url(src: str) -> tuple[str, bool]:
    """Patch the go_to_url action in controller/service.py.

    browser-use==3.1.6's ``go_to_url`` action (registered at
    ``controller/service.py`` ~line 265) calls ``page.goto(params.url)``
    with no timeout and the default ``wait_until="load"``, then
    ``page.wait_for_load_state()`` (also "load"). This is the actual code
    path used by the standard agent (NOT ``BrowserContext.navigate_to``,
    which is only used by case_generator). For SPAs the "load" event
    never fires within Playwright's default 30s, causing:
        "Error executing action go_to_url: Page.goto: Timeout 30000ms exceeded."

    This patch aligns the standard agent path with the project's
    recursive_exploration config (90s + domcontentloaded): wait only for
    DOM readiness, not full resource load, and extend the timeout to 90s.
    """
    marker = 'await page.goto(params.url, timeout=90_000, wait_until="domcontentloaded")  # patched: relax SPA navigation'
    if marker in src:
        return src, False

    old = """\
            await page.goto(params.url)
            await page.wait_for_load_state()
            msg = f'🔗  Navigated to {params.url}'"""
    new = """\
            await page.goto(params.url, timeout=90_000, wait_until="domcontentloaded")  # patched: relax SPA navigation
            await page.wait_for_load_state("domcontentloaded")
            msg = f'🔗  Navigated to {params.url}'"""
    if old not in src:
        return src, False
    return src.replace(old, new), True


def _patch_controller_search_google(src: str) -> tuple[str, bool]:
    """Patch the search_google action in controller/service.py.

    Same SPA-navigation issue as go_to_url. ``search_google`` calls
    ``page.goto(f'https://www.google.com/search?q=...&udm=14')`` with no
    timeout and default wait_until. Apply the same relaxed navigation.
    """
    marker = "udm=14', timeout=90_000, wait_until=\"domcontentloaded\")  # patched: relax SPA navigation"
    if marker in src:
        return src, False

    old = "await page.goto(f'https://www.google.com/search?q={params.query}&udm=14')"
    new = "await page.goto(f'https://www.google.com/search?q={params.query}&udm=14', timeout=90_000, wait_until=\"domcontentloaded\")  # patched: relax SPA navigation"
    if old not in src:
        return src, False
    return src.replace(old, new), True


def main() -> int:
    cli_path = _find_cli_py()
    browser_path = _find_browser_py()
    context_path = _find_context_py()
    controller_path = _find_controller_service_py()
    chat_models_path = _find_chat_models_py()
    agent_service_path = _find_agent_service_py()

    patches = []

    # Patch 1 & 2: CLI extra_chromium_args forwarding
    if cli_path is not None:
        src = cli_path.read_text(encoding="utf-8")
        original = src

        src, p1 = _patch_task_browserconfig(src)
        src, p2 = _patch_quick_browserconfig(src)

        if src != original:
            cli_path.write_text(src, encoding="utf-8")
            if p1:
                patches.append("task BrowserConfig")
            if p2:
                patches.append("quick BrowserConfig")
        else:
            print("[patch-browser-use] cli.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.cli not found, skipping CLI patch.")

    # Patch 3, 4 & 5: Browser base flags + diagnostics + force full Chromium
    if browser_path is not None:
        src = browser_path.read_text(encoding="utf-8")
        original = src

        src, p3 = _patch_build_launch_args(src)
        src, p4 = _patch_launch_diagnostics(src)
        src, p5 = _patch_force_full_chromium(src)

        if src != original:
            browser_path.write_text(src, encoding="utf-8")
            if p3:
                patches.append("build_launch_args base flags")
            if p4:
                patches.append("launch diagnostics")
            if p5:
                patches.append("force full Chromium (not headless-shell)")
        else:
            print("[patch-browser-use] browser.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.browser.browser not found, skipping browser patch.")

    # Patch 6: navigate_to relaxed timeout + wait_until (SPA navigation fix)
    if context_path is not None:
        src = context_path.read_text(encoding="utf-8")
        original = src

        src, p6 = _patch_navigate_to(src)

        if src != original:
            context_path.write_text(src, encoding="utf-8")
            if p6:
                patches.append("navigate_to relaxed SPA navigation (90s + domcontentloaded)")
        else:
            print("[patch-browser-use] context.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.browser.context not found, skipping context patch.")

    # Patch 7 & 8: controller go_to_url + search_google relaxed SPA navigation
    if controller_path is not None:
        src = controller_path.read_text(encoding="utf-8")
        original = src

        src, p7 = _patch_controller_go_to_url(src)
        src, p8 = _patch_controller_search_google(src)
        src, p9 = _patch_semantic_ancestor_iou(src)

        if src != original:
            controller_path.write_text(src, encoding="utf-8")
            if p7:
                patches.append("controller go_to_url relaxed SPA navigation (90s + domcontentloaded)")
            if p8:
                patches.append("controller search_google relaxed SPA navigation")
            if p9:
                patches.append("semantic ancestor IoU preservation")
        else:
            print("[patch-browser-use] controller/service.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.controller.service not found, skipping controller patch.")

    if chat_models_path is not None:
        src = chat_models_path.read_text(encoding="utf-8")
        patched, changed = _patch_public_openai_models(src)
        if changed:
            chat_models_path.write_text(patched, encoding="utf-8")
            patches.append("public OpenAI-compatible model resolver")
        else:
            print("[patch-browser-use] chat_models.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.agent.chat_models not found, skipping model patch.")

    if agent_service_path is not None:
        src = agent_service_path.read_text(encoding="utf-8")
        patched, changed = _patch_public_model_box_format(src)
        if changed:
            agent_service_path.write_text(patched, encoding="utf-8")
            patches.append("public model box format resolver")
        else:
            print("[patch-browser-use] agent/service.py: already patched or structure changed, no changes applied.")
    else:
        print("[patch-browser-use] browser_use.agent.service not found, skipping box format patch.")

    if patches:
        print(f"[patch-browser-use] Patched: {', '.join(patches)}.")
    else:
        print("[patch-browser-use] No changes applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
