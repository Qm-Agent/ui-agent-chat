"""uiwarden live screenshot hook for browser-use quick subprocesses.

Python imports sitecustomize automatically when its directory is on PYTHONPATH.
The quick runner prepends this scripts directory before launching
``python -m browser_use.cli quick``. This hook mirrors every browser-use
``BrowserContext.take_screenshot`` result into UIWARDEN_OBSERVATION_DIR so the
platform can stream frames while the task is still running.
"""

from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
import re
import sys
import threading
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
_INDEX = 0
_SEEN: set[str] = set()
_EMBEDDED_CONFIG: dict[str, Any] | None = None


def _observation_root() -> Path:
    raw = (os.environ.get("UIWARDEN_OBSERVATION_DIR") or "").strip()
    root = Path(raw) if raw else Path(".skill-output") / "uiwarden-observation"
    return root if root.is_absolute() else Path.cwd() / root


def _label() -> str:
    raw = os.environ.get("UIWARDEN_OBSERVATION_LABEL") or "browser-use-live"
    return re.sub(r"[^\w.-]+", "_", raw).strip("_") or "browser-use-live"


def _write_frame(data: bytes, *, page_url: str = "", title: str = "") -> None:
    global _INDEX
    if not data:
        return
    digest = hashlib.sha1(data).hexdigest()
    with _LOCK:
        if digest in _SEEN:
            return
        _SEEN.add(digest)
        _INDEX += 1
        index = _INDEX
    target_dir = _observation_root() / _label()
    target_dir.mkdir(parents=True, exist_ok=True)
    frame = target_dir / f"frame_{index:04d}.png"
    frame.write_bytes(data)
    record = {
        "framePath": str(frame),
        "stepIndex": index,
        "url": page_url,
        "title": title,
        "actionSummary": f"browser-use 实时截图 {index}",
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    with (target_dir / "manifest.ndjson").open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    capture_root = _capture_root()
    if capture_root:
        capture_frame = capture_root / "screenshots" / f"frame_{index:04d}.png"
        capture_frame.parent.mkdir(parents=True, exist_ok=True)
        capture_frame.write_bytes(data)
        _append_stream("events", {**record, "type": "screenshot", "framePath": str(capture_frame)})


def _embedded_config() -> dict[str, Any]:
    global _EMBEDDED_CONFIG
    if _EMBEDDED_CONFIG is not None:
        return _EMBEDDED_CONFIG
    raw = (os.environ.get("UIWARDEN_EMBEDDED_BROWSER_SESSION_FILE") or "").strip()
    if not raw:
        _EMBEDDED_CONFIG = {}
        return _EMBEDDED_CONFIG
    try:
        _EMBEDDED_CONFIG = json.loads(Path(raw).read_text(encoding="utf-8"))
    except Exception:
        _EMBEDDED_CONFIG = {}
    return _EMBEDDED_CONFIG


def _capture_root() -> Path | None:
    raw = (os.environ.get("UIWARDEN_EMBEDDED_CAPTURE_DIR") or _embedded_config().get("captureDir") or "").strip()
    return Path(raw) if raw else None


def _append_stream(name: str, payload: dict[str, Any]) -> None:
    root = _capture_root()
    if not root:
        return
    target = root / "streams" / f"{name}.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": datetime.now().isoformat(timespec="milliseconds"), **payload}
    with _LOCK, target.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")


def _bytes_from_result(result: Any) -> bytes:
    if isinstance(result, bytes):
        return result
    if isinstance(result, str) and len(result) > 200:
        payload = result.split(",", 1)[1] if "," in result[:64] else result
        try:
            return base64.b64decode(payload, validate=False)
        except Exception:
            return b""
    return b""


def _install() -> None:
    try:
        from browser_use.browser.context import BrowserContext
    except Exception:
        return

    original = getattr(BrowserContext, "take_screenshot", None)
    if not original or getattr(original, "_uiwarden_live_hook", False):
        return

    async def wrapped(self, *args: Any, **kwargs: Any) -> Any:
        result = await original(self, *args, **kwargs)
        try:
            page = await self.get_current_page()
            _write_frame(
                _bytes_from_result(result),
                page_url=getattr(page, "url", "") or "",
                title=await page.title(),
            )
        except Exception:
            try:
                _write_frame(_bytes_from_result(result))
            except Exception:
                pass
        return result

    wrapped._uiwarden_live_hook = True  # type: ignore[attr-defined]
    setattr(BrowserContext, "take_screenshot", wrapped)


def _install_planner_output_normalizer() -> None:
    """兼容部分模型把 markdown plan 输出为字符串数组。"""
    try:
        from browser_use.agent.service import Agent, parse_response
    except Exception:
        return
    original = getattr(Agent, "parse_and_log_planner_output", None)
    if not original or getattr(original, "_uiwarden_planner_normalizer", False):
        return

    def patched(planner_raw_output: str, output_model: Any, model_name: str) -> Any:
        try:
            payload = json.loads(parse_response(planner_raw_output, syntax="json"))
            plan = payload.get("plan") if isinstance(payload, dict) else None
            if isinstance(plan, list):
                payload["plan"] = "\n".join(str(item) for item in plan)
                planner_raw_output = json.dumps(payload, ensure_ascii=False)
        except Exception:
            pass
        return original(planner_raw_output, output_model, model_name)

    patched._uiwarden_planner_normalizer = True  # type: ignore[attr-defined]
    Agent.parse_and_log_planner_output = staticmethod(patched)


def _install_structured_input_fill() -> None:
    """结构化 HTML 输入使用 fill，避免日期分段键盘输入产生畸形值。"""
    try:
        from browser_use.browser.context import BrowserContext
    except Exception:
        return
    original = getattr(BrowserContext, "input_text_rectangle", None)
    if not original or getattr(original, "_uiwarden_structured_fill", False):
        return

    async def wrapped(
        self: Any,
        rectangle: dict[str, float],
        text: str,
        clear_before_input: bool = True,
    ) -> Any:
        page = await self.get_current_page()
        x = rectangle["left"] + rectangle["width"] / 2
        y = rectangle["top"] + rectangle["height"] / 2
        handle = await page.evaluate_handle(
            """({x, y}) => document.elementsFromPoint(x, y)
              .map((node) => node.closest && node.closest('input, textarea'))
              .find(Boolean) || null""",
            {"x": x, "y": y},
        )
        element = handle.as_element()
        if element is not None:
            input_type = (await element.get_attribute("type") or "text").lower()
            if input_type in {"date", "datetime-local", "month", "time", "week", "number"}:
                await element.fill(text)
                return None
        return await original(self, rectangle, text, clear_before_input)

    wrapped._uiwarden_structured_fill = True  # type: ignore[attr-defined]
    setattr(BrowserContext, "input_text_rectangle", wrapped)


def _dialog_policy() -> str:
    task = " ".join(sys.argv).lower()
    if re.search(r"\b(dismiss|cancel|reject)\b|取消|拒绝", task):
        return "dismiss"
    if re.search(r"\b(accept|confirm|approve)\b|确认|同意", task):
        return "accept"
    return "dismiss"


async def _attach_dialog_handler(page: Any) -> None:
    if getattr(page, "_uiwarden_dialog_handler", False):
        return
    setattr(page, "_uiwarden_dialog_handler", True)
    policy = _dialog_policy()

    async def handle(dialog: Any) -> None:
        message = str(getattr(dialog, "message", "") or "")
        _append_stream("events", {
            "type": "browser-dialog",
            "dialogType": str(getattr(dialog, "type", "") or ""),
            "message": message,
            "policy": policy,
        })
        if policy == "accept":
            await dialog.accept()
        else:
            await dialog.dismiss()

    page.on("dialog", handle)


def _install_dialog_handler() -> None:
    """在动作前订阅 JS dialog，避免 Playwright 默认 dismiss 后 Agent 误判。"""
    try:
        from browser_use.browser.context import BrowserContext
    except Exception:
        return
    original = getattr(BrowserContext, "_initialize_session", None)
    if not original or getattr(original, "_uiwarden_dialog_handler", False):
        return

    async def wrapped(self: Any) -> Any:
        session = await original(self)
        for page in session.context.pages:
            await _attach_dialog_handler(page)

        def on_page(page: Any) -> None:
            asyncio.create_task(_attach_dialog_handler(page))

        session.context.on("page", on_page)
        return session

    wrapped._uiwarden_dialog_handler = True  # type: ignore[attr-defined]
    setattr(BrowserContext, "_initialize_session", wrapped)


def _install_cdp_context_reuse() -> None:
    """Monkeypatch BrowserContext._create_context：复用 CDP 连接浏览器的首个
    已有 context，避免 new_context 触发 playwright
    "Browser context management is not supported"。

    通过 connect_over_cdp 附着的浏览器（用户本机 Chrome/Edge，已由客户端托管启动
    并保留登录态），playwright 不允许在其上 new_context。原 _create_context 仅在
    `browser.config.cdp_url` 非空且 `len(browser.contexts) > 0` 时复用 contexts[0]；
    但部分 browser-use 版本/路径下 cdp_url 未及时写入 BrowserConfig 或 contexts
    暂为空，会落入 new_context 分支报错。此处兜底：只要存在已有 context 即复用，
    否则回退原逻辑（非 CDP 新启动场景不受影响）。
    """
    try:
        from browser_use.browser.context import BrowserContext
    except Exception:
        return

    original = getattr(BrowserContext, "_create_context", None)
    if not original or getattr(original, "_uiwarden_cdp_reuse_hook", False):
        return

    async def patched(self: Any, browser: Any) -> Any:
        cfg = getattr(self, "config", None)

        async def _reuse(ctx: Any) -> Any:
            trace_path = getattr(cfg, "trace_path", None) if cfg else None
            if trace_path:
                try:
                    await ctx.tracing.start(screenshots=True, snapshots=True, sources=True)
                except Exception:
                    pass
            return ctx

        # 1. Reuse an already-enumerated context (covers cdp_url set AND the
        #    case where cdp_url isn't on BrowserConfig but contexts exist).
        try:
            ctxs = browser.contexts
            if ctxs:
                return await _reuse(ctxs[0])
        except Exception:
            pass

        # 2. CDP-connected browser with no enumerable context yet. playwright
        # forbids new_context on connect_over_cdp browsers ("Browser context
        # management is not supported"), but new_page IS allowed and lands in
        # the default context — use it to materialize that context.
        is_cdp = False
        try:
            is_cdp = bool(getattr(getattr(self, "browser", None).config, "cdp_url", None))
        except Exception:
            pass
        if is_cdp:
            # Yield once so playwright can flush pending CDP context events;
            # browser.contexts is often populated only after an event-loop tick.
            for _ in range(20):
                try:
                    await asyncio.sleep(0.1)
                    ctxs = browser.contexts
                    if ctxs:
                        return await _reuse(ctxs[0])
                except Exception:
                    pass
            if _embedded_config().get("targetId"):
                raise RuntimeError("UIWarden embedded browser CDP context was not enumerated; refusing to create a new page")
            # Last resort: open a page on the default context, then read it back.
            try:
                page = await browser.new_page()
                ctx = getattr(page, "context", None)
                if ctx is not None:
                    return await _reuse(ctx)
            except Exception:
                pass

        # 3. Non-CDP / standard launch — original behavior unchanged.
        return await original(self, browser)

    patched._uiwarden_cdp_reuse_hook = True  # type: ignore[attr-defined]
    setattr(BrowserContext, "_create_context", patched)


async def _target_id_for_page(context: Any, page: Any) -> str:
    cdp = await asyncio.wait_for(context.new_cdp_session(page), timeout=3)
    try:
        result = await asyncio.wait_for(cdp.send("Target.getTargetInfo"), timeout=3)
        return str((result.get("targetInfo") or {}).get("targetId") or "")
    finally:
        await asyncio.wait_for(cdp.detach(), timeout=3)


async def _install_page_capture(context: Any, page: Any) -> None:
    if getattr(page, "_uiwarden_capture_installed", False):
        return
    setattr(page, "_uiwarden_capture_installed", True)
    page.on("request", lambda request: _append_stream("network", {
        "type": "request",
        "method": request.method,
        "url": request.url,
        "resourceType": request.resource_type,
    }))
    page.on("response", lambda response: _append_stream("network", {
        "type": "response",
        "url": response.url,
        "status": response.status,
    }))
    page.on("requestfailed", lambda request: _append_stream("network", {
        "type": "requestfailed",
        "method": request.method,
        "url": request.url,
        "failure": request.failure,
    }))
    page.on("console", lambda message: _append_stream("console", {
        "type": message.type,
        "text": message.text,
        "url": page.url,
    }))
    page.on("pageerror", lambda error: _append_stream("page-errors", {
        "type": "pageerror",
        "message": str(error),
        "url": page.url,
    }))

    def record_input(_source: Any, event: Any) -> None:
        if isinstance(event, dict):
            _append_stream("events", event)

    script = """
      (() => {
        if (window.__uiwardenCaptureInstalled) return;
        window.__uiwardenCaptureInstalled = true;
        const describe = (node) => ({
          tag: node && node.tagName ? node.tagName.toLowerCase() : '',
          role: node && node.getAttribute ? (node.getAttribute('role') || '') : '',
          text: node && node.innerText ? node.innerText.slice(0, 160) : '',
          name: node && node.getAttribute ? (node.getAttribute('name') || '') : ''
        });
        document.addEventListener('click', (event) => {
          window.__uiwardenRecord({type: 'click', trusted: event.isTrusted, target: describe(event.target), url: location.href});
        }, true);
        document.addEventListener('input', (event) => {
          const node = event.target;
          const secret = node && node.type === 'password';
          window.__uiwardenRecord({type: 'input', trusted: event.isTrusted, target: describe(node), value: secret ? '[REDACTED]' : String(node && node.value || '').slice(0, 256), url: location.href});
        }, true);
        document.addEventListener('scroll', () => {
          window.__uiwardenRecord({type: 'scroll', x: scrollX, y: scrollY, url: location.href});
        }, {capture: true, passive: true});
      })();
    """
    try:
        await context.expose_binding("__uiwardenRecord", record_input)
    except Exception:
        pass
    try:
        await context.add_init_script(script)
        await page.evaluate(script)
    except Exception as error:
        _append_stream("capture-gaps", {"reason": "input-capture-install-failed", "detail": str(error)})


def _install_embedded_target() -> None:
    config = _embedded_config()
    target_id = str(config.get("targetId") or "")
    expected_cdp_url = str(config.get("cdpUrl") or "")
    if not target_id:
        return
    try:
        from browser_use.browser.context import BrowserContext, BrowserContextState
    except Exception:
        return

    original_init = BrowserContext.__init__
    original_initialize = BrowserContext._initialize_session
    original_current = BrowserContext._get_current_page

    def init(self: Any, *args: Any, **kwargs: Any) -> None:
        kwargs["state"] = BrowserContextState(target_id=target_id)
        original_init(self, *args, **kwargs)
        browser_config = getattr(getattr(self, "browser", None), "config", None)
        if not browser_config or not expected_cdp_url:
            raise RuntimeError("UIWarden embedded browser context is missing its CDP contract")
        actual_cdp_url = str(getattr(browser_config, "cdp_url", None) or "")
        if actual_cdp_url != expected_cdp_url:
            setattr(browser_config, "cdp_url", expected_cdp_url)
            _append_stream("events", {
                "type": "cdp-contract-corrected",
                "targetId": target_id,
                "replacedCdpUrl": actual_cdp_url,
            })
        root = _capture_root()
        if root:
            self.config.trace_path = str(root / "trace")

    async def initialize(self: Any) -> Any:
        browser_session = await asyncio.wait_for(original_initialize(self), timeout=30)
        matched = None
        for page in browser_session.context.pages:
            try:
                if await _target_id_for_page(browser_session.context, page) == target_id:
                    matched = page
                    break
            except Exception:
                continue
        if matched is None:
            raise RuntimeError(f"UIWarden embedded browser target not found: {target_id}")
        self._uiwarden_target_page = matched
        await matched.bring_to_front()
        await asyncio.wait_for(matched.wait_for_load_state("domcontentloaded"), timeout=10)
        await _install_page_capture(browser_session.context, matched)
        _append_stream("events", {"type": "capture-started", "targetId": target_id, "url": matched.url})
        return browser_session

    async def current(self: Any, browser_session: Any) -> Any:
        page = getattr(self, "_uiwarden_target_page", None)
        if page is not None and not page.is_closed():
            return page
        return await original_current(self, browser_session)

    BrowserContext.__init__ = init
    BrowserContext._initialize_session = initialize
    BrowserContext._get_current_page = current


def _read_control_state() -> dict[str, Any]:
    config = _embedded_config()
    url = str(config.get("controlUrl") or "")
    token = str(config.get("controlToken") or "")
    run_id = str(config.get("runId") or "")
    if not url or not token or not run_id:
        return {"controlMode": "agent-control"}
    request = urllib.request.Request(
        f"{url}/v1/browser/runs/{run_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def _install_agent_control_gate() -> None:
    if not _embedded_config().get("runId"):
        return
    try:
        from browser_use.agent.service import Agent
    except Exception:
        return
    original_step = Agent.step
    original_run = Agent.run

    async def step(self: Any) -> Any:
        waiting_logged = False
        control_state: dict[str, Any] = {}
        while True:
            try:
                control_state = await asyncio.to_thread(_read_control_state)
                mode = str(control_state.get("controlMode") or "agent-control")
            except Exception as error:
                _append_stream("capture-gaps", {"reason": "control-bridge-read-failed", "detail": str(error)})
                mode = "agent-control"
            if mode != "human-control":
                if waiting_logged:
                    _append_stream("events", {"type": "agent-control-resumed"})
                break
            if not waiting_logged:
                waiting_logged = True
                _append_stream("events", {"type": "human-control-started"})
            await asyncio.sleep(0.25)
        requested_target = str(control_state.get("targetId") or "")
        browser_context = getattr(self, "browser_context", None)
        browser_session = getattr(browser_context, "session", None)
        current_page = getattr(browser_context, "_uiwarden_target_page", None)
        current_target = ""
        if browser_session is not None and current_page is not None and not current_page.is_closed():
            try:
                current_target = await _target_id_for_page(browser_session.context, current_page)
            except Exception:
                pass
        # The first Agent.step runs before BrowserContext has initialized its
        # Playwright session. Let original_step create it; target switching is
        # only meaningful on later steps.
        if requested_target and requested_target != current_target and browser_session is not None:
            matched = None
            for page in browser_session.context.pages:
                try:
                    if await _target_id_for_page(browser_session.context, page) == requested_target:
                        matched = page
                        break
                except Exception:
                    continue
            if matched is None:
                raise RuntimeError(f"UIWarden switched browser target not found: {requested_target}")
            browser_context._uiwarden_target_page = matched
            await matched.bring_to_front()
            await _install_page_capture(browser_session.context, matched)
            _append_stream("events", {"type": "controlled-target-switched", "targetId": requested_target, "url": matched.url})
        return await original_step(self)

    async def run(self: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return await original_run(self, *args, **kwargs)
        finally:
            root = _capture_root()
            browser_context = getattr(self, "browser_context", None)
            browser_session = getattr(browser_context, "session", None)
            if root and browser_session is not None:
                try:
                    await browser_context.take_screenshot()
                except Exception as error:
                    _append_stream("capture-gaps", {"reason": "final-screenshot-failed", "detail": str(error)})
                try:
                    trace_file = root / "trace" / "trace.zip"
                    trace_file.parent.mkdir(parents=True, exist_ok=True)
                    await browser_session.context.tracing.stop(path=str(trace_file))
                except Exception as error:
                    _append_stream("capture-gaps", {"reason": "trace-finalize-failed", "detail": str(error)})

    Agent.step = step
    Agent.run = run


def _load_runtime_dotenv() -> None:
    """Load the UIWarden workspace env before browser-use imports its registry."""
    dotenv_path = (os.environ.get("DOTENV_PATH") or "").strip()
    if not dotenv_path:
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(dotenv_path, override=False)
    except Exception as error:
        _append_stream("capture-gaps", {"reason": "runtime-dotenv-load-failed", "detail": str(error)})


def _install_configured_browser_profiles() -> None:
    """Register project browser profiles missing from browser-use 3.1.6."""
    executable = (os.environ.get("BU_CUSTOM_BROWSER_PATH") or "").strip()
    firefox_executable = (os.environ.get("BU_FIREFOX_PATH") or "").strip()
    try:
        from browser_use.browser.profiles import BrowserProfile, register_browser
        if executable:
            register_browser(BrowserProfile(
                vendor="custom",
                display_name="Custom Chromium",
                playwright_browser="chromium",
                executable_path=executable,
            ))
        register_browser(BrowserProfile(
            vendor="firefox",
            display_name="Firefox (Playwright managed)",
            playwright_browser="firefox",
            # Playwright Firefox uses a patched Juggler protocol build. A normal
            # /Applications/Firefox.app cannot complete that handshake.
            executable_path=None,
        ))
        if firefox_executable and "ms-playwright" not in firefox_executable:
            _append_stream("capture-gaps", {
                "reason": "system-firefox-replaced-with-playwright-runtime",
                "detail": (
                    f"{firefox_executable} 仅用于本机检测；执行改用 Playwright 配套 Firefox，"
                    "避免在首帧前因 Juggler 协议不兼容卡死"
                ),
            })
    except Exception as error:
        _append_stream("capture-gaps", {"reason": "browser-profile-register-failed", "detail": str(error)})


def _install_quick_browser_profile_default() -> None:
    """Make browser-use quick honor BU_BROWSER_TYPE when it omits BrowserConfig.browser_type."""
    try:
        from browser_use.browser.browser import BrowserConfig
        if getattr(BrowserConfig, "_uiwarden_profile_default_installed", False):
            return
        original_init = BrowserConfig.__init__

        def init(self, *args, **kwargs):
            # browser_type is the seventh dataclass argument. Explicit caller
            # choices always win; only the quick-mode omission is filled here.
            if len(args) <= 6 and "browser_type" not in kwargs:
                browser_type = (os.environ.get("BU_BROWSER_TYPE") or "").strip()
                if browser_type:
                    kwargs["browser_type"] = browser_type
            original_init(self, *args, **kwargs)

        BrowserConfig.__init__ = init
        BrowserConfig._uiwarden_profile_default_installed = True
    except Exception as error:
        _append_stream("capture-gaps", {"reason": "quick-browser-profile-patch-failed", "detail": str(error)})


_load_runtime_dotenv()
_install_configured_browser_profiles()
_install_quick_browser_profile_default()
_install_planner_output_normalizer()
_install_structured_input_fill()
_install_dialog_handler()
_install()
_install_cdp_context_reuse()
_install_embedded_target()
_install_agent_control_gate()
