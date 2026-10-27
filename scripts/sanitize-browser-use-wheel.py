#!/usr/bin/env python3
"""Create the redistributable UIWarden browser-use SDK wheel."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
from pathlib import PurePosixPath
import zipfile


VERSION = "3.1.6"
DIST_INFO = PurePosixPath(f"browser_use-{VERSION}.dist-info")
METADATA = str(DIST_INFO / "METADATA")
RECORD = str(DIST_INFO / "RECORD")
LICENSE = str(DIST_INFO / "licenses" / "LICENSE")
CHAT_MODELS = "browser_use/agent/chat_models.py"


def should_exclude(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        "tests" in path.parts
        or name.startswith("browser_use/static/benchmarks/")
        or name == "browser_use/static/custom-hosts"
        or name == RECORD
    )


def sanitize_metadata(value: bytes) -> bytes:
    text = value.decode("utf-8")
    headers, _, _description = text.partition("\n\n")
    public_headers = []
    for line in headers.splitlines():
        if line.startswith("Project-URL:"):
            continue
        public_headers.append(line)
    public_headers.append("Project-URL: Upstream, https://github.com/browser-use/browser-use")
    description = f"""# browser-use {VERSION} UIWarden SDK

This bundled Python SDK is based on the MIT-licensed browser-use project and
contains the runtime integration used by UIWarden. Internal test fixtures,
private host mappings and non-runtime benchmark assets are excluded from the
redistributable wheel. See UIWarden's THIRD_PARTY_NOTICES.md for attribution.
"""
    return ("\n".join(public_headers) + "\n\n" + description).encode("utf-8")


def sanitize_chat_models(value: bytes) -> bytes:
    """Replace distribution-specific model routing with the public contract."""
    text = value.decode("utf-8")
    marker = "def convert_dict_to_message("
    if marker not in text:
        raise ValueError("browser-use chat_models.py structure is unsupported")
    _prefix, suffix = text.split(marker, 1)
    public_prefix = '''from __future__ import annotations

import os
from typing import Any, Dict, Union
from urllib.parse import urlsplit

from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    BaseMessageChunk,
    ChatMessage,
    ChatMessageChunk,
    HumanMessage,
    HumanMessageChunk,
    SystemMessage,
    SystemMessageChunk,
    ToolMessage,
    ToolMessageChunk,
)
from langchain_openai import ChatOpenAI


# UIWarden public OpenAI-compatible model resolver.
def build_models(
    actor="qwen3.7-plus",
    planner="qwen3.7-plus",
    asserter="qwen3.7-plus",
    page_extraction_llm="qwen3.7-plus",
    locating_llm="qwen3.7-plus",
    coding_llm="qwen3.7-plus",
):
    key = os.getenv("BU_OPENAI_API_KEY", "").strip()
    base = os.getenv("BU_OPENAI_API_BASE", "").strip()
    if not key or not base:
        raise ValueError("BU_OPENAI_API_KEY and BU_OPENAI_API_BASE are required")
    url = urlsplit(base)
    if (
        url.scheme not in ("https", "http")
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("BU_OPENAI_API_BASE must be an HTTP(S) URL without credentials, query or fragment")

    roles = (
        ("BU_ACTOR_MODEL", actor),
        ("BU_PLANNER_MODEL", planner),
        ("BU_ASSERTER_MODEL", asserter),
        ("BU_PAGE_EXTRACTION_LLM", page_extraction_llm),
        ("BU_LOCATING_LLM", locating_llm),
        ("BU_CODING_LLM", coding_llm),
    )
    names = [os.getenv(variable, "").strip() or default for variable, default in roles]
    if any(not name for name in names):
        raise ValueError("Every browser-use model role must have a non-empty model name")
    clients = {
        name: ChatOpenAI(
            model=name,
            api_key=key,
            base_url=base,
            temperature=0.0,
            timeout=120,
            max_retries=1,
        )
        for name in set(names)
    }
    resolved = [clients[name] for name in names]
    return (*resolved[:3], dict(zip(
        ("page_extraction_llm", "locating_llm", "coding_llm"),
        resolved[3:],
    )))


'''
    return (public_prefix + marker + suffix).encode("utf-8")


def record_digest(value: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(value).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--license", required=True)
    args = parser.parse_args()

    license_value = open(args.license, "rb").read()

    written: list[tuple[str, str, int]] = []
    with zipfile.ZipFile(args.source, "r") as source, zipfile.ZipFile(
        args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as output:
        for info in source.infolist():
            if should_exclude(info.filename):
                continue
            value = source.read(info.filename)
            if info.filename == METADATA:
                value = sanitize_metadata(value)
            elif info.filename == CHAT_MODELS:
                value = sanitize_chat_models(value)
            output.writestr(info, value)
            written.append((info.filename, record_digest(value), len(value)))

        if LICENSE not in {name for name, _digest, _size in written}:
            output.writestr(LICENSE, license_value)
            written.append((LICENSE, record_digest(license_value), len(license_value)))

        record_buffer = io.StringIO(newline="")
        writer = csv.writer(record_buffer, lineterminator="\n")
        writer.writerows(written)
        writer.writerow((RECORD, "", ""))
        output.writestr(RECORD, record_buffer.getvalue().encode("utf-8"))


if __name__ == "__main__":
    main()
