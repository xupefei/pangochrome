#!/bin/sh
# Installs the Pangochrome helper for the current user and registers it with
# Chrome, Chromium, Brave and Microsoft Edge. Run:
#
#   curl -fsSL https://github.com/xupefei/pangochrome/releases/latest/download/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --version vX.Y.Z      install this release, not the latest one
#   --extension-id ID     allow this extension ID, not the one built into the helper
#   --uninstall           remove the registrations and the helper
set -eu

releases=${PANGOCHROME_RELEASES:-https://github.com/xupefei/pangochrome/releases}
install_dir=${PANGOCHROME_INSTALL_DIR:-$HOME/.local/bin}
dest=$install_dir/pangochrome-helper

say() { printf '%s\n' "$*"; }
die() {
  printf 'pangochrome install: %s\n' "$*" >&2
  exit 1
}

version=
extension_id=
uninstall=no
while [ $# -gt 0 ]; do
  case $1 in
  --version)
    [ $# -ge 2 ] || die "--version needs a value"
    version=$2
    shift 2
    ;;
  --extension-id)
    [ $# -ge 2 ] || die "--extension-id needs a value"
    extension_id=$2
    shift 2
    ;;
  --uninstall)
    uninstall=yes
    shift
    ;;
  *) die "unknown option: $1" ;;
  esac
done

if [ "$uninstall" = yes ]; then
  if [ -x "$dest" ]; then
    "$dest" uninstall
    rm -f "$dest"
    say "Removed $dest."
  else
    say "No helper at $dest."
  fi
  exit 0
fi

if [ -n "$extension_id" ] && ! printf '%s' "$extension_id" | grep -Eq '^[a-p]{32}$'; then
  die "$extension_id is not a Chrome extension ID"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
case $releases in
https://*) curl_https='--proto =https --tlsv1.2' ;;
*) curl_https= ;;
esac
fetch() {
  # shellcheck disable=SC2086 # curl_https is a list of options.
  curl -fsSL $curl_https "$@"
}

if [ -z "$version" ]; then
  # GitHub redirects .../releases/latest to .../releases/tag/<tag>.
  # shellcheck disable=SC2086 # curl_https is a list of options.
  latest=$(curl -fsS $curl_https -o /dev/null -w '%{redirect_url}' "$releases/latest") ||
    die "cannot find the latest release at $releases"
  version=${latest##*/}
fi
printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "$version is not a release version"

case $(uname -s) in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) die "Pangochrome supports macOS and Linux only" ;;
esac
case $(uname -m) in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) die "unsupported CPU: $(uname -m)" ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
asset=pangochrome-helper-$os-$arch

tmp=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

say "Downloading $asset $version..."
fetch -o "$tmp/$asset" "$releases/download/$version/$asset" || die "cannot download $asset $version"
fetch -o "$tmp/SHA256SUMS.txt" "$releases/download/$version/SHA256SUMS.txt" || die "cannot download SHA256SUMS.txt"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS.txt")
[ -n "$expected" ] || die "SHA256SUMS.txt has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset: expected $expected, got $actual"

mkdir -p "$install_dir"
# Rename into place, so that a running helper keeps its old file.
cp "$tmp/$asset" "$install_dir/.pangochrome-helper.new"
chmod 0755 "$install_dir/.pangochrome-helper.new"
mv -f "$install_dir/.pangochrome-helper.new" "$dest"
say "Installed $dest."

installed=$("$dest" version)
[ "$installed" = "$version" ] || say "Warning: the helper reports version $installed, not $version."

if [ -n "$extension_id" ]; then
  "$dest" install --extension-id "$extension_id"
else
  "$dest" install
fi
say "Done. Open the Pangochrome popup and press Retry."
