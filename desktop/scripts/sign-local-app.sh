#!/usr/bin/env bash

set -euo pipefail

app_path="${1:?Usage: sign-local-app.sh <path-to-app>}"

if [[ ! -d "$app_path" ]]; then
  echo "[desktop] app bundle not found: $app_path" >&2
  exit 1
fi

# Electron's directory build linker-signs executables but does not seal the
# enclosing bundle when no Developer ID is configured. Seal the whole local
# bundle so a copied app has a consistent resource signature. Release jobs can
# replace this ad-hoc signature with Developer ID signing and notarization.
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

echo "[desktop] local app bundle signed and verified: $app_path"
