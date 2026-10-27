#!/usr/bin/env python3
"""Validate native automation JSON Schemas and representative payloads."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = ROOT / "native-automation" / "schemas"


def load(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def main() -> None:
    schemas = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.json")}
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)

    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema))
        for schema in schemas.values()
        if "$id" in schema
    )
    session_validator = Draft202012Validator(
        schemas["session.schema.json"],
        registry=registry,
    )
    session_validator.validate(
        {
            "version": 1,
            "sessionId": "cua-test",
            "providerId": "mock",
            "app": {"kind": "name", "value": "demo"},
            "controlMode": "agent-control",
            "deliveryMode": "foreground-compatible",
            "state": "active",
            "artifactDir": "/tmp/native-reps/cua-test",
            "startedAt": "2026-07-11T12:00:00.000Z",
            "eventCount": 1,
            "snapshotSequence": 0,
            "actionCount": 0,
            "approvalCount": 0,
        }
    )
    Draft202012Validator(schemas["manifest.schema.json"], registry=registry).validate(
        {
            "artifactKind": "native-rep",
            "schemaVersion": 1,
            "runId": "cua-test",
            "nativeRunId": "cua-test",
            "providerId": "macos-accessibility",
            "app": {"kind": "bundle-id", "value": "com.apple.calculator"},
            "deliveryMode": "foreground-compatible",
            "startedAt": "2026-07-11T12:00:00.000Z",
            "finishedAt": "2026-07-11T12:00:01.000Z",
            "stopReason": "schema-validation",
            "captureStopReason": "schema-validation",
            "eventCount": 5,
            "snapshotCount": 1,
            "actionCount": 1,
            "approvalCount": 0,
        }
    )
    snapshot_validator = Draft202012Validator(
        schemas["snapshot.schema.json"],
        registry=registry,
    )
    snapshot_validator.validate(
        {
            "version": 1,
            "snapshotId": "snapshot-test",
            "sessionId": "cua-test",
            "sequence": 1,
            "app": {"id": "com.apple.calculator", "displayName": "Calculator", "isRunning": True},
            "text": "AXSplitter value=-1",
            "elements": [
                {
                    "elementId": "ax-0-0",
                    "role": "AXSplitter",
                    "name": "",
                    "value": "-1",
                    "secure": False,
                    "enabled": True,
                    "actions": [],
                }
            ],
            "delta": {
                "changed": True,
                "windowChanged": True,
                "focusedElementChanged": False,
                "textChanged": True,
                "addedElementCount": 1,
                "removedElementCount": 0,
                "updatedElementCount": 0,
                "actionCountSinceLastObservation": 0,
                "noProgressCount": 0,
            },
            "capturedAt": "2026-07-11T12:00:00.000Z",
        }
    )
    Draft202012Validator(schemas["error.schema.json"]).validate(
        {
            "ok": False,
            "error": {
                "code": "STALE_SNAPSHOT",
                "message": "snapshot expired",
                "details": {},
            },
        }
    )
    print(f"native automation schemas: PASS count={len(schemas)}")


if __name__ == "__main__":
    main()
