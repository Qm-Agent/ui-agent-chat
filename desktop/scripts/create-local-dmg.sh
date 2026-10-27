#!/usr/bin/env bash
set -euo pipefail

APP_PATH=${1:?UIWarden.app path is required}
OUTPUT_DMG=${2:?output DMG path is required}
VOLUME_NAME=${3:-UIWarden}

if [[ ! -d "$APP_PATH" ]]; then
  echo "[desktop] app bundle not found: $APP_PATH" >&2
  exit 1
fi

MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/uiwarden-dmg-mount.XXXXXX")
RW_DMG=$(mktemp "${TMPDIR:-/tmp}/uiwarden-dmg-rw.XXXXXX").dmg
ATTACHED=false
cleanup() {
  if [[ "$ATTACHED" == "true" ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$MOUNT_DIR" "$RW_DMG"
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUTPUT_DMG")"
rm -f "$OUTPUT_DMG"
APP_SIZE_KB=$(du -sk "$APP_PATH" | awk '{print $1}')
# HFS+ block and catalog overhead is material for the bundled Python tree,
# which contains many small files. The slack affects only the temporary
# read/write image; the final UDZO image remains content-compressed.
DMG_SIZE_KB=$((APP_SIZE_KB + APP_SIZE_KB / 2 + 262144))
hdiutil create \
  -volname "$VOLUME_NAME" \
  -size "${DMG_SIZE_KB}k" \
  -fs HFS+ \
  -ov \
  "$RW_DMG" >/dev/null

hdiutil attach \
  "$RW_DMG" \
  -readwrite \
  -noverify \
  -noautoopen \
  -mountpoint "$MOUNT_DIR" >/dev/null
ATTACHED=true

ditto "$APP_PATH" "$MOUNT_DIR/UIWarden.app"
osascript - "$MOUNT_DIR" >/dev/null <<'APPLESCRIPT'
on run argv
set targetFolder to POSIX file (item 1 of argv) as alias
tell application "Finder"
  make new alias file at targetFolder to (POSIX file "/Applications" as alias) with properties {name:"Applications"}
end tell
end run
APPLESCRIPT

osascript -l JavaScript - "$MOUNT_DIR/Applications" <<'JXA'
ObjC.import('AppKit');

function run(argv) {
  const target = argv[0];
  const source = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ApplicationsFolderIcon.icns';
  const icon = $.NSImage.alloc.initWithContentsOfFile($(source));
  if (!icon || !$.NSWorkspace.sharedWorkspace.setIconForFileOptions(icon, $(target), 0)) {
    throw new Error('Unable to apply the macOS Applications alias icon');
  }
}
JXA

osascript - "$MOUNT_DIR" <<'APPLESCRIPT'
on run argv
set targetFolder to POSIX file (item 1 of argv) as alias
tell application "Finder"
    open targetFolder
    set targetWindow to container window of targetFolder
    set current view of targetWindow to icon view
    set toolbar visible of targetWindow to false
    set statusbar visible of targetWindow to false
    set pathbar visible of targetWindow to false
    set sidebar width of targetWindow to 0
    set bounds of targetWindow to {100, 100, 660, 460}
    set viewOptions to icon view options of targetWindow
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set text size of viewOptions to 13
    set background color of viewOptions to {65535, 65535, 65535}
    set position of item "UIWarden.app" of targetFolder to {155, 180}
    set position of item "Applications" of targetFolder to {405, 180}
    update targetFolder without registering applications
    delay 2
    close targetWindow
end tell
end run
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" -quiet
ATTACHED=false

hdiutil convert \
  "$RW_DMG" \
  -format UDZO \
  -imagekey zlib-level=6 \
  -ov \
  -o "$OUTPUT_DMG" >/dev/null

echo "[desktop] local DMG created: $OUTPUT_DMG"
