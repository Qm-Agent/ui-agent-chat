"""BrowserContext 子类：截图前等待 domcontentloaded（可配置），适配长期不触发 window load 的页面。"""
from __future__ import annotations

import base64
import json
import logging
import os
from typing import TYPE_CHECKING, Union

from playwright.async_api import Browser as PlaywrightBrowser

from browser_use.browser.context import BrowserContext, BrowserContextConfig
from browser_use.utils import time_execution_async

if TYPE_CHECKING:
    from browser_use.browser.browser import Browser

logger = logging.getLogger(__name__)


class RelaxedLoadBrowserContext(BrowserContext):
    """覆盖 take_screenshot，避免默认 wait_for_load_state(load) 在部分站点上永久超时。

    覆盖 ``_create_context``：`browser_use`` 在配置了 ``cdp_url`` / ``chrome_instance_path`` 时会复用
    ``browser.contexts[0]``，导致递归探索中每条队列任务仍落在**同一 Playwright 上下文/窗口**，
    前置状态互相污染。此处始终 ``browser.new_context(...)``，保证每条任务隔离。
    """

    def __init__(
        self,
        browser: "Browser",
        config: BrowserContextConfig | None = None,
        *,
        screenshot_wait_timeout_ms: int = 90_000,
        screenshot_capture_timeout_ms: int = 300_000,
        screenshot_wait_until: str = "domcontentloaded",
        state=None,
        cache_manager=None,
    ) -> None:
        super().__init__(
            browser,
            config=config or BrowserContextConfig(),
            state=state,
            cache_manager=cache_manager,
        )
        self._screenshot_wait_timeout_ms = screenshot_wait_timeout_ms
        self._screenshot_capture_timeout_ms = screenshot_capture_timeout_ms
        self._screenshot_wait_until = screenshot_wait_until
        # 截图前再等一次 networkidle/动效收尾，避免「页面仍在缓冲、骨架屏」时截图。
        self._screenshot_networkidle_timeout_ms = self._env_int(
            "RECURSIVE_EXPLORATION_SCREENSHOT_NETWORKIDLE_MS", 6_000
        )
        self._screenshot_quiet_settle_ms = self._env_int(
            "RECURSIVE_EXPLORATION_SCREENSHOT_QUIET_MS", 400
        )

    @staticmethod
    def _env_int(name: str, default: int) -> int:
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            return default
        try:
            return max(0, int(raw))
        except ValueError:
            return default

    async def _create_context(self, browser: PlaywrightBrowser):
        """始终新建浏览器上下文；逻辑与 ``BrowserContext._create_context`` 的 *else* 分支及后续 Cookie/init 一致。"""
        context = await browser.new_context(
            viewport=self.config.browser_window_size,
            no_viewport=False,
            user_agent=self.config.user_agent,
            java_script_enabled=True,
            bypass_csp=self.config.disable_security,
            ignore_https_errors=self.config.disable_security,
            record_video_dir=self.config.save_recording_path,
            record_video_size=self.config.browser_window_size,
            locale=self.config.locale,
            device_scale_factor=self.config.device_scale_factor,
        )

        if self.config.trace_path:
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)

        if self.config.cookies_file:
            raw = self.config.cookies_file.strip()
            if (
                not (raw.startswith("[") or raw.startswith("{"))
                and "\n" not in raw
                and os.path.exists(raw)
            ):
                with open(raw, "r", encoding="utf-8") as f:
                    cookie_content = f.read()
                self._cookies_source_is_file = True
            else:
                cookie_content = raw
                self._cookies_source_is_file = False
            try:
                cookies = json.loads(cookie_content)
                if isinstance(cookies, str) and cookies.strip().startswith(("[", "{")):
                    cookies = json.loads(cookies)
                if isinstance(cookies, list):
                    _pw_same_site = {"strict": "Strict", "lax": "Lax", "none": "None"}
                    playwright_cookies = []
                    for c in cookies:
                        if not isinstance(c, dict):
                            continue
                        nc = dict(c)
                        ss = (nc.get("sameSite") or "").strip()
                        ss_lower = ss.lower()
                        if ss in ("unspecified", "no_restriction", ""):
                            nc["sameSite"] = "Lax" if ss != "no_restriction" else "None"
                        elif ss_lower in _pw_same_site:
                            nc["sameSite"] = _pw_same_site[ss_lower]
                        else:
                            nc["sameSite"] = "Lax"
                        playwright_cookies.append(nc)
                    logger.info(
                        "Loaded %d cookies from %s",
                        len(playwright_cookies),
                        raw if self._cookies_source_is_file else "inline",
                    )
                    await context.add_cookies(playwright_cookies)
                else:
                    logger.warning("Cookie value did not parse to a list; skipping.")
            except json.JSONDecodeError as e:
                logger.warning("Failed to parse cookie (file or inline JSON): %s", e)

        await context.add_init_script(
            """
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US']
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            window.chrome = { runtime: {} };
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            (function () {
                const originalAttachShadow = Element.prototype.attachShadow;
                Element.prototype.attachShadow = function attachShadow(options) {
                    return originalAttachShadow.call(this, { ...options, mode: "open" });
                };
            })();
            """
        )

        return context

    @time_execution_async("--take_screenshot")
    async def take_screenshot(
        self, full_page: bool = False, b64: bool = True
    ) -> Union[str, bytes]:
        page = await self.get_current_page()
        await page.bring_to_front()
        await page.wait_for_load_state(
            self._screenshot_wait_until,
            timeout=self._screenshot_wait_timeout_ms,
        )
        # 等到 networkidle / 短暂静默后再截图，可显著降低「页面仍是骨架屏 / 加载动画」时的取样误差。
        if self._screenshot_networkidle_timeout_ms > 0:
            try:
                await page.wait_for_load_state(
                    "networkidle",
                    timeout=self._screenshot_networkidle_timeout_ms,
                )
            except Exception:
                logger.debug(
                    "screenshot networkidle wait timed out (%s ms); continuing",
                    self._screenshot_networkidle_timeout_ms,
                )
        if self._screenshot_quiet_settle_ms > 0:
            try:
                await page.wait_for_timeout(self._screenshot_quiet_settle_ms)
            except Exception:
                logger.debug("screenshot quiet settle failed; continuing", exc_info=True)
        screenshot = await page.screenshot(
            full_page=full_page,
            animations="disabled",
            timeout=self._screenshot_capture_timeout_ms,
        )
        if b64:
            screenshot = base64.b64encode(screenshot).decode("utf-8")
        return screenshot
