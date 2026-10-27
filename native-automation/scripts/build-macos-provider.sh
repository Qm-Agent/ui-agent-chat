#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$ROOT_DIR/providers/macos/DTGuiComputerProvider.swift"
OUTPUT_DIR="$ROOT_DIR/target/native-provider"
APP="$OUTPUT_DIR/dt-gui-computer Provider.app"
CONTENTS="$APP/Contents"
OUTPUT="$CONTENTS/MacOS/dt-gui-computer-provider"
SIGNING_IDENTITY=${DT_GUI_COMPUTER_CODESIGN_IDENTITY:--}
DEPLOYMENT_TARGET=${DT_GUI_COMPUTER_MACOS_DEPLOYMENT_TARGET:-13.0}
TARGET_ARCH=${DT_GUI_COMPUTER_MACOS_ARCH:-$(uname -m)}
PACKAGE_VERSION=${DT_GUI_COMPUTER_PACKAGE_VERSION:-$(awk -F'"' '/"version"/ { print $4; exit }' "$ROOT_DIR/package.json")}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS provider can only be built on Darwin" >&2
  exit 2
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$CONTENTS/MacOS"
case "$TARGET_ARCH" in
  arm64|x86_64) ;;
  aarch64) TARGET_ARCH=arm64 ;;
  *) echo "unsupported macOS provider architecture: $TARGET_ARCH" >&2; exit 2 ;;
esac
TARGET_TRIPLE="${TARGET_ARCH}-apple-macosx${DEPLOYMENT_TARGET}"
MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" xcrun swiftc -O -target "$TARGET_TRIPLE" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework CoreImage \
  -framework CoreMedia -framework CoreVideo -framework ScreenCaptureKit -framework Vision \
  "$SOURCE" -o "$OUTPUT"
chmod 0755 "$OUTPUT"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>dt-gui-computer-provider</string>
  <key>CFBundleIdentifier</key><string>com.dt.gui.computer.provider</string>
  <key>CFBundleName</key><string>dt-gui-computer Provider</string>
  <key>CFBundleDisplayName</key><string>dt-gui-computer Provider</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${PACKAGE_VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>${DEPLOYMENT_TARGET}</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>DT GUI Agent</string>
</dict>
</plist>
PLIST
BINARY_MIN_VERSION=$(xcrun vtool -show-build "$OUTPUT" | awk '$1 == "minos" { print $2; exit }')
if [ "$BINARY_MIN_VERSION" != "$DEPLOYMENT_TARGET" ]; then
  echo "macOS Provider deployment target mismatch: binary=$BINARY_MIN_VERSION expected=$DEPLOYMENT_TARGET" >&2
  exit 1
fi
if [ "$SIGNING_IDENTITY" = "-" ]; then
  # A plain ad-hoc signature derives its designated requirement from cdhash,
  # which changes on every rebuild and invalidates the local TCC grant.
  codesign --force --deep --sign - \
    --requirements '=designated => identifier "com.dt.gui.computer.provider"' \
    "$APP" >/dev/null
else
  codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" "$APP" >/dev/null
fi
printf '%s\n' "$APP"
