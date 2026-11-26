#!/usr/bin/env bash
# Writes the Chrome Web Store zip from extension/dist, without the manifest
# "key": the store keeps the key and the extension ID itself.
set -euo pipefail

[ $# -eq 1 ] || {
  echo "usage: scripts/package-extension.sh OUTPUT.zip" >&2
  exit 2
}
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$(dirname "$1")"
out_dir=$(cd "$(dirname "$1")" && pwd)
out=$out_dir/$(basename "$1")
[ -f "$repo/extension/dist/manifest.json" ] || {
  echo "package-extension.sh: build the extension first (make extension)" >&2
  exit 1
}

stage=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-extension.XXXXXX")
trap 'rm -rf "$stage"' EXIT
cp -R "$repo/extension/dist/." "$stage/"
node -e '
const fs = require("fs");
const path = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
delete manifest.key;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$stage/manifest.json"

rm -f "$out"
(cd "$stage" && zip -qrX "$out" .)
echo "Wrote $out"
