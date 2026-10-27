# UI test Runtime

UIWarden desktop release packages include a platform-specific UI testing Runtime so end users do not need to install Python packages or Playwright browsers.

The Runtime is assembled by `npm run prepare:ui-test-runtime` and is intentionally not committed to Git. A release build contains:

- CPython 3.11.17 from `astral-sh/python-build-standalone`, pinned by platform and SHA-256;
- the reviewed local `browser-use==3.1.6` wheel from `vendor/browser-use`;
- transitive Python dependencies constrained by `constraints.txt`;
- Playwright 1.58.0 Chromium and Firefox browser binaries;
- `runtime-manifest.json`, package versions, and upstream license metadata.

The build host needs public network access to GitHub Releases, the configured Python package index, and the Playwright CDN. The resulting desktop installation does not use those download services at runtime. Build macOS arm64, macOS x64, and Windows x64 packages on matching hosts; Runtime directories are not cross-platform.

Do not copy a developer virtual environment into a release. The release builder verifies the CPython archive digest, runs `pip check`, imports browser-use, and launches both packaged browsers before packaging.
