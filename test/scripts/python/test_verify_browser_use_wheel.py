import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "verify_browser_use_wheel.py"


class VerifyBrowserUseWheelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.wheel = self.directory / "browser_use-3.1.6-py3-none-any.whl"
        self.write_wheel("Name: browser-use\nVersion: 3.1.6\n")

    def write_wheel(self, metadata, extra_files=None):
        with zipfile.ZipFile(self.wheel, "w") as archive:
            archive.writestr("browser_use-3.1.6.dist-info/METADATA", metadata)
            archive.writestr("browser_use-3.1.6.dist-info/licenses/LICENSE", "MIT License\nCopyright (c) Example\n")
            for name, value in (extra_files or {}).items():
                archive.writestr(name, value)

    def verify(self, **environment):
        env = os.environ.copy()
        env.pop("UIWARDEN_PUBLIC_RELEASE", None)
        env.pop("UIWARDEN_BROWSER_USE_WHEEL_SHA256", None)
        env.pop("UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED", None)
        env.update(environment)
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.directory)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    def test_valid_local_wheel(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified local browser-use wheel", result.stdout)

    def test_rejects_wrong_hash(self):
        result = self.verify(UIWARDEN_BROWSER_USE_WHEEL_SHA256="0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)

    def test_public_release_requires_hash_and_rejects_internal_metadata(self):
        missing_hash = self.verify(UIWARDEN_PUBLIC_RELEASE="true")
        self.assertIn("requires UIWARDEN_BROWSER_USE_WHEEL_SHA256", missing_hash.stderr)
        digest = hashlib.sha256(self.wheel.read_bytes()).hexdigest()
        missing_approval = self.verify(
            UIWARDEN_PUBLIC_RELEASE="true",
            UIWARDEN_BROWSER_USE_WHEEL_SHA256=digest,
        )
        self.assertIn("requires UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED=true", missing_approval.stderr)
        internal_fixture_domain = ".".join(("code", "alipay", "com"))
        self.write_wheel(f"Name: browser-use\nVersion: 3.1.6\nProject-URL: https://{internal_fixture_domain}/example\n")
        digest = hashlib.sha256(self.wheel.read_bytes()).hexdigest()
        internal = self.verify(
            UIWARDEN_PUBLIC_RELEASE="true",
            UIWARDEN_BROWSER_USE_WHEEL_SHA256=digest,
            UIWARDEN_BROWSER_USE_REDISTRIBUTION_APPROVED="true",
        )
        self.assertIn("internal references", internal.stderr)

        self.write_wheel(
            "Name: browser-use\nVersion: 3.1.6\n",
            {"browser_use/static/custom-hosts": "127.0.0.1 example.invalid\n"},
        )
        bundled_private_resource = self.verify()
        self.assertIn("tests, benchmark assets, or private hosts", bundled_private_resource.stderr)

    def test_rejects_wrong_version(self):
        self.write_wheel("Name: browser-use\nVersion: 3.1.4\n")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version is not 3.1.6", result.stderr)


if __name__ == "__main__":
    unittest.main()
