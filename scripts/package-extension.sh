#!/usr/bin/env bash
# Zips aseprite-extension/ into an .aseprite-extension file (Aseprite installs it on double-click).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/claude-pixel-bridge.aseprite-extension"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$ROOT/aseprite-extension" && zip -q -r "$OUT" . -x ".*")
echo "Created $OUT"
