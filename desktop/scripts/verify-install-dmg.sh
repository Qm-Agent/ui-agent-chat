#!/bin/bash

set -euo pipefail

dmg_path="${1:?Usage: verify-install-dmg.sh <path-to-dmg>}"
mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/uiwarden-dmg-verify.XXXXXX")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil verify "$dmg_path" >/dev/null
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null

test -d "$mount_dir/UIWarden.app"
codesign --verify --deep --strict --verbose=2 "$mount_dir/UIWarden.app"
test -f "$mount_dir/Applications"
test ! -L "$mount_dir/Applications"
applications_target="$(osascript - "$mount_dir/Applications" <<'APPLESCRIPT'
on run argv
set aliasPath to POSIX file (item 1 of argv) as alias
tell application "Finder"
  return POSIX path of (original item of aliasPath as alias)
end tell
end run
APPLESCRIPT
)"
test "$applications_target" = "/Applications/"
applications_icon_bytes="$(xattr -px com.apple.ResourceFork "$mount_dir/Applications" | wc -c | tr -d ' ')"
test "$applications_icon_bytes" -gt 1024
test -s "$mount_dir/.DS_Store"
node "$script_dir/mac-icon.cjs" verify "$mount_dir/UIWarden.app/Contents/Resources/icon.icns"

resources="$mount_dir/UIWarden.app/Contents/Resources"
test -s "$resources/THIRD_PARTY_NOTICES.md"
test -s "$resources/LICENSE"
grep -q 'Apache License' "$resources/LICENSE"
test -s "$resources/LICENSES/browser-use-MIT.txt"
grep -q 'MIT License' "$resources/LICENSES/browser-use-MIT.txt"
browser_use_wheel="$resources/vendor/browser-use/browser_use-3.1.6-py3-none-any.whl"
test -s "$browser_use_wheel"
test "$(shasum -a 256 "$browser_use_wheel" | awk '{print $1}')" = "4cf70be8ed5a833b803d8417af5a3185b97accd437122206a82c0cd969452e4b"
ui_test_runtime="$resources/ui-test-runtime"
test -s "$ui_test_runtime/runtime-manifest.json"
grep -q '"schemaVersion": "uiwarden-ui-test-runtime/v1"' "$ui_test_runtime/runtime-manifest.json"
grep -q '"browserUseVersion": "3.1.6"' "$ui_test_runtime/runtime-manifest.json"
grep -q '"playwrightVersion": "1.58.0"' "$ui_test_runtime/runtime-manifest.json"
ui_test_python="$ui_test_runtime/python/bin/python3"
test -x "$ui_test_python"
PLAYWRIGHT_BROWSERS_PATH="$ui_test_runtime/ms-playwright" PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  "$ui_test_python" -c 'from importlib.metadata import version; from playwright.sync_api import sync_playwright; assert version("browser-use") == "3.1.6"; p=sync_playwright().start(); b=p.chromium.launch(headless=True); b.close(); f=p.firefox.launch(headless=True); f.close(); p.stop()'
for name in ui-test-assistant-skill dt-gui-computer-skill dt-gui-browser-skill browser-task-group-extension browser-automation; do
  test -d "$resources/$name"
  sensitive="$(find "$resources/$name" \( -name '.env' -o -name '.env.*' -o -name '.skill-output' -o -name 'test-reports' -o -name 'logs' -o -name '__pycache__' -o -name '*.log' -o -name '*.pyc' -o -name '.DS_Store' \) ! -name '.env.example' -print -quit)"
  if [ -n "$sensitive" ]; then
    echo "Unexpected local configuration or execution output in DMG: $sensitive" >&2
    exit 1
  fi
done
private_context="$(find "$resources/ui-test-assistant-skill/config/perference_context" -type f ! -name '.gitkeep' -print -quit 2>/dev/null || true)"
private_prompt="$(find "$resources/ui-test-assistant-skill/config/prompt_context" -type f ! -name '.gitkeep' ! -name 'global_readme.md' -print -quit 2>/dev/null || true)"
if [ -n "$private_context$private_prompt" ]; then
  echo "Unexpected private Skill context in DMG: ${private_context:-$private_prompt}" >&2
  exit 1
fi
test ! -e "$resources/runtime/agents/cfuse"
test ! -e "$resources/runtime/agents/cfuse.exe"
grep -q '"defaultRuntime": "dtcoder"' "$resources/runtime/agents/runtime-manifest.json"
grep -q '"bundledCommercialRuntimes": false' "$resources/runtime/agents/runtime-manifest.json"

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$mount_dir/UIWarden.app/Contents/Info.plist")"

echo "UIWarden ${version} install DMG verified: Finder layout, app, icon, Applications alias and packaged resources are present."
