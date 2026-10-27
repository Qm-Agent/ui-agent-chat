#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../../.." && pwd)
OUTPUT_DIR=${DT_GUI_COMPUTER_PACKAGE_OUTPUT:-/tmp/dt-gui-computer-package-smoke}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found; set NODE_BIN or add node to PATH" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

cleanup() {
  rm -rf "$OUTPUT_DIR"
}
trap cleanup EXIT
rm -rf "$OUTPUT_DIR"

"$NODE_BIN" "$ROOT_DIR/desktop/scripts/prepare-package.cjs"
(
  cd "$ROOT_DIR/desktop"
  "$NODE_BIN" ./node_modules/electron-builder/cli.js \
    --mac dir \
    --config electron-builder.json \
    --config.directories.output="$OUTPUT_DIR" \
    --publish never
)

APP=$(find "$OUTPUT_DIR" -type d -path '*/UIWarden.app' -print -quit)
if [ -z "$APP" ]; then
  echo "UIWarden.app not found in $OUTPUT_DIR" >&2
  exit 1
fi

RESOURCES="$APP/Contents/Resources/native-automation"
CLI="$RESOURCES/dt-gui-computer"
PROVIDER="$RESOURCES/dt-gui-computer Provider.app"
test -x "$CLI"
test -d "$PROVIDER"
codesign --verify --deep --strict "$PROVIDER"
test -x "$APP/Contents/Resources/runtime/node"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PROVIDER/Contents/Info.plist")" = "com.dt.gui.computer.provider"
MINIMUM_SYSTEM_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PROVIDER/Contents/Info.plist")
BINARY_MIN_VERSION=$(xcrun vtool -show-build "$PROVIDER/Contents/MacOS/dt-gui-computer-provider" | awk '$1 == "minos" { print $2; exit }')
test "$BINARY_MIN_VERSION" = "$MINIMUM_SYSTEM_VERSION"
OUTER_SIGNING="unsigned"
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  OUTER_SIGNING="verified"
fi

HOME_DIR=$(mktemp -d /tmp/dt-gui-computer-packaged-home.XXXXXX)
trap 'rm -rf "$HOME_DIR"; cleanup' EXIT
CAPABILITIES_FILE="$OUTPUT_DIR/capabilities.json"
DT_GUI_COMPUTER_HOME="$HOME_DIR" \
DT_GUI_COMPUTER_MACOS_PROVIDER="$PROVIDER" \
  "$CLI" capabilities --json >"$CAPABILITIES_FILE"
test -s "$CAPABILITIES_FILE"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!payload.ok || payload.data?.protocolVersion !== 1) {
    throw new Error("packaged dt-gui-computer returned incompatible capabilities");
  }
' "$CAPABILITIES_FILE"

echo "dt-gui-computer package smoke: PASS app=$APP outerSigning=$OUTER_SIGNING"
