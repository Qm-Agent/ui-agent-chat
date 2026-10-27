# Bundled browser-use Python SDK

UIWarden vendors `browser-use==3.1.6` as a local Python wheel so image builds
do not download that package from a private or public package index.

- File: `browser_use-3.1.6-py3-none-any.whl`
- SHA-256: `4cf70be8ed5a833b803d8417af5a3185b97accd437122206a82c0cd969452e4b`
- Upstream: <https://github.com/browser-use/browser-use>
- Upstream license: MIT, retained both inside the wheel and at
  `LICENSES/browser-use-MIT.txt`

The redistributable wheel contains UIWarden's runtime integration but excludes
package tests, private host mappings and the non-runtime MiniWoB benchmark
assets. Its metadata references the public upstream project only. Run
`npm run test:open-source-wheel` and `npm run check:open-source-build` before
publishing. To sanitize a newly approved source wheel, use:

```bash
python3 scripts/sanitize-browser-use-wheel.py SOURCE.whl OUTPUT.whl \
  --license LICENSES/browser-use-MIT.txt
```

Do not replace the wheel without reviewing the source, updating this digest,
re-running the release gates and preserving all applicable notices.
