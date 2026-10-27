"""为 LangChain Chat 模型包装 invoke/ainvoke：瞬时错误退避，持久错误快速失败。"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def _env_int_min0(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


# 全局并发与节流，避免兼容模型服务在突发并发下抖动。
# - RECURSIVE_EXPLORATION_LLM_MAX_CONCURRENCY: 同时进行的 LLM 调用上限（默认 2）。
# - RECURSIVE_EXPLORATION_LLM_MIN_INTERVAL_MS: 同一进程内相邻 LLM 调用最小间隔（默认 0 ms，关闭）。
_GLOBAL_THROTTLE_LOCK = threading.Lock()
_LAST_CALL_TS_MONO: float = 0.0
_ASYNC_SEM: asyncio.Semaphore | None = None
_ASYNC_SEM_LOOP_ID: int | None = None
_SYNC_SEM: threading.BoundedSemaphore | None = None


def _max_concurrency() -> int:
    return _env_int("RECURSIVE_EXPLORATION_LLM_MAX_CONCURRENCY", 2)


def _min_interval_s() -> float:
    return _env_int_min0("RECURSIVE_EXPLORATION_LLM_MIN_INTERVAL_MS", 0) / 1000.0


def _get_async_sem() -> asyncio.Semaphore:
    global _ASYNC_SEM, _ASYNC_SEM_LOOP_ID
    loop = asyncio.get_event_loop()
    lid = id(loop)
    if _ASYNC_SEM is None or _ASYNC_SEM_LOOP_ID != lid:
        _ASYNC_SEM = asyncio.Semaphore(_max_concurrency())
        _ASYNC_SEM_LOOP_ID = lid
    return _ASYNC_SEM


def _get_sync_sem() -> threading.BoundedSemaphore:
    global _SYNC_SEM
    if _SYNC_SEM is None:
        _SYNC_SEM = threading.BoundedSemaphore(_max_concurrency())
    return _SYNC_SEM


def _wait_min_interval_sync() -> None:
    global _LAST_CALL_TS_MONO
    iv = _min_interval_s()
    if iv <= 0:
        return
    with _GLOBAL_THROTTLE_LOCK:
        now = time.monotonic()
        wait = (_LAST_CALL_TS_MONO + iv) - now
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _LAST_CALL_TS_MONO = now


async def _wait_min_interval_async() -> None:
    global _LAST_CALL_TS_MONO
    iv = _min_interval_s()
    if iv <= 0:
        return
    with _GLOBAL_THROTTLE_LOCK:
        now = time.monotonic()
        wait = (_LAST_CALL_TS_MONO + iv) - now
        if wait <= 0:
            _LAST_CALL_TS_MONO = now
            return
        next_ts = _LAST_CALL_TS_MONO + iv
        _LAST_CALL_TS_MONO = next_ts
    await asyncio.sleep(wait)


# 错误分类：persistent（鉴权/DNS）通常重试也无济于事，应快速失败；transient（限流/瞬时网关）值得重试。
_PERSISTENT_NAMES = {"AuthenticationError"}
_TRANSIENT_NAMES = {
    "RateLimitError",
    "APITimeoutError",
    "InternalServerError",
}


def _classify(exc: BaseException) -> str:
    """返回 ``persistent`` / ``transient`` / ``no_retry``。"""
    name = type(exc).__name__
    if name in _PERSISTENT_NAMES:
        return "persistent"
    msg = str(exc)
    msg_l = msg.lower()
    if name == "APIStatusError":
        code = getattr(exc, "status_code", None)
        if code in (401, 403):
            return "persistent"
        if code in (429, 500, 502, 503):
            return "transient"
    if name == "APIConnectionError":
        # DNS 解析失败属于持久（除非链路恢复，否则重试只浪费时间）。
        if "nodename nor servname" in msg or "name or service not known" in msg_l:
            return "persistent"
        return "transient"
    if name in _TRANSIENT_NAMES:
        return "transient"
    if "401" in msg or "服务未授权" in msg or "unauthor" in msg_l:
        return "persistent"
    if "429" in msg or "rate" in msg_l or "too many requests" in msg_l:
        return "transient"
    return "no_retry"


def _attempt_cap(klass: str, default_cap: int) -> int:
    """按错误类别决定本次最大尝试数：persistent 显著低于 transient。"""
    if klass == "persistent":
        return _env_int("RECURSIVE_EXPLORATION_LLM_RETRY_MAX_PERSISTENT", 2)
    if klass == "transient":
        return default_cap
    return 1


class ChatModelRetryWrapper:
    """委托内部 ChatModel，仅在 invoke / ainvoke 上增加退避重试。"""

    def __init__(
        self,
        inner: Any,
        *,
        max_attempts: int | None = None,
        initial_delay_s: float = 1.0,
        max_delay_s: float = 60.0,
    ) -> None:
        self._inner = inner
        self._max_attempts = max_attempts if max_attempts is not None else _env_int(
            "RECURSIVE_EXPLORATION_LLM_RETRY_MAX", 5
        )
        self._initial_delay_s = initial_delay_s
        self._max_delay_s = max_delay_s

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _hint_persistent(self, exc: BaseException) -> str:
        """对持久型错误给出一行排障提示，避免「重试到天荒地老」。"""
        name = type(exc).__name__
        msg = str(exc)
        if name == "AuthenticationError" or "401" in msg or "服务未授权" in msg:
            return "鉴权失败（401）：请检查 .env 中的 BU_OPENAI_API_KEY 是否有效；持久型错误已快速失败"
        if "nodename nor servname" in msg.lower() or "name or service not known" in msg.lower():
            return "DNS 解析失败：请检查网络和域名解析；持久型错误已快速失败"
        return "持久型错误已快速失败，避免长时间无效重试"

    def invoke(self, *args: Any, **kwargs: Any) -> Any:
        delay = self._initial_delay_s
        last: BaseException | None = None
        sem = _get_sync_sem()
        for attempt in range(self._max_attempts):
            try:
                with sem:
                    _wait_min_interval_sync()
                    return self._inner.invoke(*args, **kwargs)
            except Exception as e:
                last = e
                klass = _classify(e)
                cap = min(self._max_attempts, _attempt_cap(klass, self._max_attempts))
                if attempt + 1 >= cap or klass == "no_retry":
                    if klass == "persistent":
                        logger.warning(
                            "%s | %s",
                            self._hint_persistent(e),
                            e,
                        )
                    raise
                jitter = random.uniform(0, delay * 0.25)
                logger.warning(
                    "LLM invoke 将重试 %s/%s（%s, %s）：%s",
                    attempt + 1,
                    cap,
                    klass,
                    type(e).__name__,
                    e,
                )
                time.sleep(delay + jitter)
                delay = min(delay * 2.0, self._max_delay_s)
        assert last is not None
        raise last

    async def ainvoke(self, *args: Any, **kwargs: Any) -> Any:
        delay = self._initial_delay_s
        last: BaseException | None = None
        for attempt in range(self._max_attempts):
            try:
                sem = _get_async_sem()
                async with sem:
                    await _wait_min_interval_async()
                    inner = self._inner
                    fn = getattr(inner, "ainvoke", None)
                    if fn is None:
                        return inner.invoke(*args, **kwargs)
                    return await fn(*args, **kwargs)
            except Exception as e:
                last = e
                klass = _classify(e)
                cap = min(self._max_attempts, _attempt_cap(klass, self._max_attempts))
                if attempt + 1 >= cap or klass == "no_retry":
                    if klass == "persistent":
                        logger.warning(
                            "%s | %s",
                            self._hint_persistent(e),
                            e,
                        )
                    raise
                jitter = random.uniform(0, delay * 0.25)
                logger.warning(
                    "LLM ainvoke 将重试 %s/%s（%s, %s）：%s",
                    attempt + 1,
                    cap,
                    klass,
                    type(e).__name__,
                    e,
                )
                await asyncio.sleep(delay + jitter)
                delay = min(delay * 2.0, self._max_delay_s)
        assert last is not None
        raise last


def wrap_chat_models_with_retries(
    actor: Any,
    planner: Any,
    asserter: Any,
    aux_llms: dict[str, Any] | None,
    *,
    max_attempts: int | None = None,
) -> tuple[Any, Any, Any, dict[str, Any] | None]:
    """对 actor/planner/asserter 及 aux_llms 各模型包一层重试（None 跳过）。"""

    def _w(m: Any) -> Any:
        return ChatModelRetryWrapper(m, max_attempts=max_attempts) if m is not None else None

    out_aux = None
    if aux_llms:
        out_aux = {k: _w(v) if v is not None else None for k, v in aux_llms.items()}
    return _w(actor), _w(planner), _w(asserter), out_aux


def stability_agent_omega_conf() -> dict[str, Any]:
    """合并进 browser_use default.yaml：默认仅 3 次内置步内重试（外层 wrapper 已处理瞬时退避，
    再叠 6 次会与外层组合成长时间无效重试）。可通过 RECURSIVE_EXPLORATION_AGENT_MAX_LLM_RETRY 调整。"""
    return {
        "agent": {
            "max_llm_retry": _env_int("RECURSIVE_EXPLORATION_AGENT_MAX_LLM_RETRY", 3),
        }
    }
