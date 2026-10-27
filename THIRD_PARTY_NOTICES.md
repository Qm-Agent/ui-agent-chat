# Third-party notices

## browser-use

UIWarden's optional test assistant includes a `browser-use==3.1.6` Python SDK wheel derived from the open-source [browser-use project](https://github.com/browser-use/browser-use). Its upstream copyright and MIT license notice are reproduced below. The distribution wheel also contains its own `dist-info/licenses/LICENSE` file.

The same upstream notice is shipped as `LICENSES/browser-use-MIT.txt` in source, container, and desktop distributions so it remains available independently of Python package metadata.

The bundled wheel is based on the public upstream release and is redistributed under its MIT license. UIWarden applies its integration patches at Runtime build time from `scripts/patch-browser-use.py`; the fixed wheel digest and verification procedure are documented in `vendor/browser-use/README.md`. Package tests and non-runtime benchmark assets are excluded from the bundled wheel. This notice preserves the upstream attribution and does not change the license terms applicable to other UIWarden components.

```text
MIT License

Copyright (c) 2024 Gregor Zunic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Figo Browser

Figo Browser was used only as a design reference. The public source and build contain no Figo application bundle, source file, or asset. UIWarden captures use the product-owned `browser-rep` artifact kind and `uiwarden-browser-rep/v1` schema identifier.

## Bundled UI test Runtime

Desktop release packages contain a platform-specific CPython distribution from `astral-sh/python-build-standalone`, Python packages required by browser-use, and the Chromium and Firefox builds selected by Playwright 1.58.0. The Runtime retains CPython's license files, Python package `dist-info` license metadata, and browser-bundled third-party notices. `runtime-manifest.json` records the exact Python archive digest, installed Python package versions, and browser directories used by each release. These components remain subject to their respective upstream licenses; UIWarden's Apache-2.0 license does not replace them.

## DTCoder / AiWork

DTCoder/AiWork is a separate commercial dependency installed by the user under its own terms. The open-source source build does not include its binary or its authentication material.
