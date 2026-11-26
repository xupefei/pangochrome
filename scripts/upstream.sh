#!/usr/bin/env bash
# Builds host/third_party/<name> from the pinned upstream releases and the
# patches in patches/. See patches/README.md.
set -euo pipefail

# Git exports these to hooks. They would point git at the outer repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

repo=$(cd "$(dirname "$0")/.." && pwd)
pins="$repo/patches/upstream.txt"
out="$repo/host/third_party"
work=

usage() {
  cat >&2 <<'EOF'
usage: bash scripts/upstream.sh prepare [--force]
       bash scripts/upstream.sh diff

prepare  Builds host/third_party/<name> for each module in patches/upstream.txt.
         It stops before it replaces a tree that has edits. --force drops them.
diff     Writes the edits in each host/third_party/<name> to patches/<name>.patch.
EOF
  exit 2
}

die() {
  echo "upstream.sh: $*" >&2
  exit 1
}

# git with every setting forced that changes what it stages, applies or prints.
g() {
  git -c core.autocrlf=false -c core.safecrlf=false -c core.attributesFile=/dev/null \
    -c core.excludesFile=/dev/null -c core.fsmonitor=false -c core.quotePath=true \
    -c apply.ignoreWhitespace=no -c diff.suppressBlankEmpty=false -c diff.noprefix=false \
    -c diff.mnemonicPrefix=false -c color.ui=false "$@"
}

# Stages the tree and prints its tree hash. Files that upstream's .gitignore
# names stay out, except files that are already staged.
tree_of() {
  g -C "$1" add -A . && g -C "$1" write-tree
}

# Identifies what a tree is built from: the module version and the patch.
inputs_of() { # module version patch
  local patch_id=none
  if [ -s "$3" ]; then
    patch_id=$(git hash-object "$3")
  fi
  echo "$1@$2 $patch_id"
}

has_edits() {
  [ "$(tree_of "$1")" != "$(cat "$1/.git/pangochrome-tree")" ]
}

# Calls "$1 name module version sum" for each pin. Reads the pins on fd 3, so
# that the commands in the loop cannot read them.
for_each_pin() {
  local name module version sum
  while read -r name module version sum <&3 || [ -n "$name" ]; do
    sum=${sum%$'\r'}
    case $name in '' | '#'*) continue ;; esac
    case $name in *[!a-z0-9_-]*) die "bad name in patches/upstream.txt: $name" ;; esac
    "$1" "$name" "$module" "$version" "$sum"
  done 3<"$pins"
}

prepare_one() {
  local name=$1 module=$2 version=$3 sum=$4
  local patch="$repo/patches/$name.patch" target="$out/$name"
  local inputs
  inputs=$(inputs_of "$module" "$version" "$patch")

  if [ -e "$target" ]; then
    if [ ! -f "$target/.git/pangochrome-tree" ]; then
      [ "$force" = yes ] || die "$target was not built by 'make prepare'. Move it away, or run 'bash scripts/upstream.sh prepare --force'."
    elif [ "$(cat "$target/.git/pangochrome-inputs")" = "$inputs" ]; then
      if has_edits "$target"; then
        echo "$name: up to date, with edits that are not in patches/$name.patch yet"
      else
        echo "$name: up to date"
      fi
      return
    elif has_edits "$target" && [ "$force" != yes ]; then
      die "$target has edits that are not in patches/$name.patch, and patches/upstream.txt or patches/$name.patch changed since it was built. Copy your edits elsewhere, then run 'bash scripts/upstream.sh prepare --force'."
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
  printf '.DS_Store\n*.orig\n*.rej\n' >"$tree/.git/info/exclude"
  local base applied
  # The base takes every file of the release, also those its .gitignore names.
  base=$(g -C "$tree" add -A -f . && g -C "$tree" write-tree)
  local from="$module@$version"
  if [ -s "$patch" ]; then
    g -C "$tree" apply --whitespace=nowarn "$patch" || die "patches/$name.patch does not apply to $module@$version"
    from="$from and patches/$name.patch"
  fi
  applied=$(tree_of "$tree")
  echo "$base" >"$tree/.git/pangochrome-base"
  echo "$applied" >"$tree/.git/pangochrome-tree"
  echo "$inputs" >"$tree/.git/pangochrome-inputs"

  rm -rf "$target"
  mv "$tree" "$target"
  echo "$name: built from $from"
}

diff_one() {
  local name=$1 module=$2 version=$3
  local target="$out/$name" patch="$repo/patches/$name.patch"
  [ -f "$target/.git/pangochrome-base" ] || die "$target was not built by 'make prepare'"
  local built
  built=$(cat "$target/.git/pangochrome-inputs")
  [ "$built" = "$(inputs_of "$module" "$version" "$patch")" ] ||
    die "$target is built from '$built', but patches/upstream.txt or patches/$name.patch changed since. Run 'make prepare' first."

  local tree
  tree=$(tree_of "$target")
  g -C "$target" diff --cached --binary --full-index --no-ext-diff --no-textconv --no-color \
    --no-renames -U3 --inter-hunk-context=0 --indent-heuristic --diff-algorithm=myers \
    --src-prefix=a/ --dst-prefix=b/ -O/dev/null "$(cat "$target/.git/pangochrome-base")" >"$work/$name.patch"
  mv "$work/$name.patch" "$patch"
  echo "$tree" >"$target/.git/pangochrome-tree"
  inputs_of "$module" "$version" "$patch" >"$target/.git/pangochrome-inputs"
  echo "$name: wrote patches/$name.patch"
}

force=no
case "${1:-}" in
prepare)
  case "${2:-}" in
  '') ;;
  --force) force=yes ;;
  *) usage ;;
  esac
  ;;
diff) [ $# -eq 1 ] || usage ;;
*) usage ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-upstream.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
if [ "$1" = prepare ]; then
  for_each_pin prepare_one
else
  for_each_pin diff_one
fi
