#!/usr/bin/env bash
# Builds host/third_party/<name> from a pinned upstream Go module and
# patches/<name>.patch, and writes edits there back to the patch.
# See patches/README.md.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
pins="$repo/patches/upstream.txt"
out="$repo/host/third_party"

usage() {
  cat >&2 <<'EOF'
usage: bash scripts/upstream.sh prepare [--force]
       bash scripts/upstream.sh diff

prepare  Builds host/third_party/<name> for each module in patches/upstream.txt.
         It stops if a tree has edits that are not in its patch. --force drops them.
diff     Writes the edits in each host/third_party/<name> to patches/<name>.patch.
EOF
  exit 2
}

die() {
  echo "upstream.sh: $*" >&2
  exit 1
}

# git with the settings that make its output the same on every machine.
g() {
  git -c core.autocrlf=false -c core.safecrlf=false -c diff.noprefix=false \
    -c diff.mnemonicPrefix=false -c diff.relative=false -c color.ui=false "$@"
}

# Stages the whole tree, ignored files too, and prints its tree hash.
tree_of() {
  g -C "$1" add -A -f .
  g -C "$1" write-tree
}

# Identifies what a tree is built from: the module version and the patch.
inputs_of() {
  local patch_id=none
  if [ -s "$3" ]; then
    patch_id=$(git hash-object "$3")
  fi
  echo "$1@$2 $patch_id"
}

has_local_edits() {
  [ ! -f "$1/.git/pangochrome-tree" ] || [ "$(tree_of "$1")" != "$(cat "$1/.git/pangochrome-tree")" ]
}

prepare_one() {
  local work=$1 force=$2 name=$3 module=$4 version=$5 sum=$6
  local patch="$repo/patches/$name.patch" target="$out/$name"
  local inputs
  inputs=$(inputs_of "$module" "$version" "$patch")

  if [ -e "$target" ]; then
    if has_local_edits "$target"; then
      if [ "$force" != yes ]; then
        die "$target has edits that are not in patches/$name.patch. Run 'make patches' to keep them, or 'bash scripts/upstream.sh prepare --force' to drop them."
      fi
    elif [ "$(cat "$target/.git/pangochrome-inputs")" = "$inputs" ]; then
      echo "$name: up to date"
      return
    fi
  fi

  local info zip got
  info=$(cd "$work" && GOFLAGS= GO111MODULE=on go mod download -json "$module@$version") ||
    die "cannot download $module@$version"
  zip=$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*"Zip": "\(.*\)",\{0,1\}$/\1/p')
  got=$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*"Sum": "\(.*\)",\{0,1\}$/\1/p')
  [ -n "$zip" ] || die "go mod download returned no zip for $module@$version"
  [ "$got" = "$sum" ] || die "$module@$version has hash $got, but patches/upstream.txt pins $sum"

  local unpacked="$work/$name.unpacked" tree="$work/$name"
  unzip -q "$zip" -d "$unpacked"
  mv "$unpacked/$module@$version" "$tree"

  g -C "$tree" init -q
  local base applied
  base=$(tree_of "$tree")
  if [ -s "$patch" ]; then
    g -C "$tree" apply --whitespace=nowarn "$patch" ||
      die "patches/$name.patch does not apply to $module@$version"
  fi
  applied=$(tree_of "$tree")
  echo "$base" >"$tree/.git/pangochrome-base"
  echo "$applied" >"$tree/.git/pangochrome-tree"
  echo "$inputs" >"$tree/.git/pangochrome-inputs"

  rm -rf "$target"
  mv "$tree" "$target"
  echo "$name: built from $module@$version and patches/$name.patch"
}

work=
trap '[ -z "$work" ] || rm -rf "$work"' EXIT

prepare() {
  local force=$1 name module version sum
  work=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-upstream.XXXXXX")
  mkdir -p "$out"
  while read -r name module version sum <&3; do
    case "$name" in '' | '#'*) continue ;; esac
    prepare_one "$work" "$force" "$name" "$module" "$version" "$sum"
  done 3<"$pins"
}

diff_all() {
  local name module version sum target patch tree
  while read -r name module version sum <&3; do
    case "$name" in '' | '#'*) continue ;; esac
    target="$out/$name"
    patch="$repo/patches/$name.patch"
    [ -f "$target/.git/pangochrome-base" ] ||
      die "$target was not built by 'make prepare'"
    tree=$(tree_of "$target")
    g -C "$target" diff --cached --binary --full-index --no-ext-diff --diff-algorithm=myers \
      "$(cat "$target/.git/pangochrome-base")" >"$patch.tmp"
    mv "$patch.tmp" "$patch"
    echo "$tree" >"$target/.git/pangochrome-tree"
    inputs_of "$module" "$version" "$patch" >"$target/.git/pangochrome-inputs"
    echo "$name: wrote patches/$name.patch"
  done 3<"$pins"
}

case "${1:-}" in
prepare)
  case "${2:-}" in
  '') prepare no ;;
  --force) prepare yes ;;
  *) usage ;;
  esac
  ;;
diff)
  [ $# -eq 1 ] || usage
  diff_all
  ;;
*) usage ;;
esac
