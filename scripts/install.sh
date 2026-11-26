#!/bin/sh
# Installs the Pangochrome helper for the current user and registers it with
# the Chromium browsers. The Pangochrome popup shows the command to run:
#
#   curl -fsSL https://github.com/xupefei/pangochrome/releases/download/vX.Y.Z/install.sh | sh -s -- --extension-id ID
#
# Options:
#   --extension-id ID   also allow this extension ID (the popup passes its own)
#   --version vX.Y.Z    install this release, not the one this script is from
#   --uninstall         remove the registrations and the helper
set -eu

# make release sets this to the release version.
release_version=

releases=${PANGOCHROME_RELEASES:-https://github.com/xupefei/pangochrome/releases}
install_dir=$HOME/.local/bin
dest=$install_dir/pangochrome-helper

say() { printf '%s\n' "$*"; }
die() {
  printf 'pangochrome install: %s\n' "$*" >&2
  exit 1
}

# The whole script is one function, so that `curl | sh` runs nothing if the
# download stops early.
main() {
  version=$release_version
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
      "$dest" uninstall </dev/null
      rm -f "$dest"
      say "Removed $dest."
    else
      say "No helper at $dest."
    fi
    return
  fi

  [ -n "$version" ] || die "pass --version vX.Y.Z, or run the install.sh of a release"
  nl='
'
  case $version$extension_id in *"$nl"*) die "--version and --extension-id must be one line" ;; esac
  printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "$version is not a release version"
  if [ -n "$extension_id" ] && ! printf '%s' "$extension_id" | grep -Eq '^[a-p]{32}$'; then
    die "$extension_id is not a Chrome extension ID"
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | awk '{ print $1 }'; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | awk '{ print $1 }'; }
  else
    die "sha256sum or shasum is required"
  fi

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

  case $releases in
  https://*) curl_https='--proto =https --tlsv1.2' ;;
  *) curl_https= ;;
  esac
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  # dash runs the EXIT trap on exit only, not on a signal.
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "Downloading $asset $version..."
  # shellcheck disable=SC2086 # curl_https is a list of options.
  curl -fsSL $curl_https -o "$tmp/$asset" "$releases/download/$version/$asset" ||
    die "cannot download $asset $version"
  # shellcheck disable=SC2086
  curl -fsSL $curl_https -o "$tmp/SHA256SUMS.txt" "$releases/download/$version/SHA256SUMS.txt" ||
    die "cannot download SHA256SUMS.txt"

  expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS.txt")
  [ -n "$expected" ] || die "SHA256SUMS.txt has no entry for $asset"
  actual=$(sha256 "$tmp/$asset")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset: expected $expected, got $actual"

  mkdir -p "$install_dir"
  new=$install_dir/.pangochrome-helper.new
  install -m 0755 "$tmp/$asset" "$new"
  # Run the new helper before it replaces a working one.
  if ! installed=$("$new" version 2>&1 </dev/null); then
    rm -f "$new"
    die "the downloaded helper does not run here: $installed"
  fi
  [ "$installed" = "$version" ] || say "Warning: the helper reports version $installed, not $version."
  # Rename into place, so that a running helper keeps its old file.
  mv -f "$new" "$dest"
  say "Installed $dest."

  if [ -n "$extension_id" ]; then
    "$dest" install --extension-id "$extension_id" </dev/null
  else
    "$dest" install </dev/null
  fi
  say "Done. Open the Pangochrome popup and press Retry."
}

main "$@"
