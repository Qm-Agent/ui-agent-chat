"""Verify the locally supplied browser-use wheel before installing it in an image."""

import hashlib
import os
from pathlib import Path
import re
import sys
import zipfile


INTERNAL_REFERENCE = re.compile(
    rb"code\.linke|alipay\.com|alipay\.net|antgroup-inc\.cn|yuque\.antfin|theta\.aistest",
    re.I,
)


def main() -> int:
    wheel_dir = Path(sys.argv[1])
    wheels = list(wheel_dir.glob("browser_use-3.1.6-*.whl"))
    if len(wheels) != 1:
        raise ValueError("expected exactly one browser-use 3.1.6 wheel")

    wheel = wheels[0]
    expected = os.getenv("UIWARDEN_BROWSER_USE_WHEEL_SHA256", "").strip().lower()
    public_release = os.getenv("UIWARDEN_PUBLIC_RELEASE", "").lower() == "true"
    redistribution_approved = os.getenv("UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED", "") == "true"
    if public_release and not expected:
        raise ValueError("public release requires UIWARDEN_BROWSER_USE_WHEEL_SHA256")
    if public_release and not redistribution_approved:
        raise ValueError("public release requires UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED=true")
    actual = hashlib.sha256(wheel.read_bytes()).hexdigest()
    if expected and (not re.fullmatch(r"[0-9a-f]{64}", expected) or actual != expected):
        raise ValueError("browser-use wheel SHA-256 mismatch")

    prefix = "browser_use-3.1.6.dist-info/"
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        metadata = archive.read(prefix + "METADATA").decode("utf-8")
        license_text = archive.read(prefix + "licenses/LICENSE").decode("utf-8")
        private_references = [name for name in names if INTERNAL_REFERENCE.search(archive.read(name))]
    if not re.search(r"^Name: browser-use$", metadata, re.MULTILINE):
        raise ValueError("wheel package name is not browser-use")
    if not re.search(r"^Version: 3\.1\.6$", metadata, re.MULTILINE):
        raise ValueError("wheel version is not 3.1.6")
    if "MIT License" not in license_text or "Copyright" not in license_text:
        raise ValueError("wheel is missing upstream MIT license notice")
    forbidden_entries = [
        name
        for name in names
        if "/tests/" in name
        or name.startswith("browser_use/static/benchmarks/")
        or name == "browser_use/static/custom-hosts"
    ]
    if forbidden_entries:
        raise ValueError("wheel contains tests, benchmark assets, or private hosts")
    if private_references:
        raise ValueError("wheel contains internal references")

    print(f"Verified local browser-use wheel: {wheel.name} (SHA-256 {actual})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        print(f"browser-use wheel verification failed: {error}", file=sys.stderr)
        sys.exit(1)
