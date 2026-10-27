#!/usr/bin/env python3
"""兼容入口：实现位于 ``package/scripts/run_yaml_repair_batch.py``。"""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    _canon = Path(__file__).resolve().parent.parent / "package" / "scripts" / "run_yaml_repair_batch.py"
    sys.argv[0] = str(_canon)
    runpy.run_path(str(_canon), run_name="__main__")
