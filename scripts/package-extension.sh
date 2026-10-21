#!/usr/bin/env bash
# Packages aseprite-extension/ as dist/aseprite-mcp.aseprite-extension: a plain zip that
# Aseprite installs on double-click or via Edit > Preferences > Extensions > Add Extension.
#
#   scripts/package-extension.sh [output-file]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/aseprite-extension"
OUT="${1:-$ROOT/dist/aseprite-mcp.aseprite-extension}"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed (Debian/Ubuntu: sudo apt install zip; Fedora: sudo dnf install zip)." >&2
  exit 1
fi
for required in package.json main.lua; do
  if [[ ! -f "$SRC/$required" ]]; then
    echo "error: $SRC/$required is missing; is this a complete checkout?" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT"

# Directory entries are kept on purpose: Aseprite records every zip entry in __info.json
# and only removes listed directories on uninstall/update, so a zip without them leaves
# empty folders behind. Tests and dotfiles (.DS_Store, editor swap files) are not shipped.
(cd "$SRC" && zip -q -r -X "$OUT" . -x "tests/" "tests/*" ".*" "*/.*")

COUNT="$(cd "$SRC" && find . -type f ! -path "./tests/*" ! -name ".*" | wc -l | tr -d ' ')"
echo "Created $OUT ($COUNT files)"
