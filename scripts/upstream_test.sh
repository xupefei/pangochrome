#!/usr/bin/env bash
# Tests scripts/upstream.sh in a scratch copy of the repo layout.
# Needs Go and the pinned modules (it downloads them if they are not cached).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tmpdir=${TMPDIR:-/tmp}
tmp=$(mktemp -d "${tmpdir%/}/pangochrome-upstream-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/scripts"
cp "$repo/scripts/upstream.sh" "$tmp/repo/scripts/"
cp -R "$repo/patches" "$tmp/repo/patches"
up() { bash "$tmp/repo/scripts/upstream.sh" "$@" 2>&1; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
expect() { # output, text it must contain
  case $1 in *"$2"*) ;; *) fail "expected '$2' in: $1" ;; esac
}

patch="$tmp/repo/patches/olm.patch"
file="$tmp/repo/host/third_party/olm/olm/types.go"
cp "$patch" "$tmp/olm.patch.orig"

echo "test: build, then report up to date"
expect "$(up prepare)" "olm: built from github.com/fosrl/olm@v1.10.2 and patches/olm.patch"
expect "$(up prepare)" "olm: up to date"

echo "test: ignore .DS_Store"
touch "$tmp/repo/host/third_party/olm/.DS_Store"
out=$(up prepare)
case $out in *"with edits"*) fail ".DS_Store counted as an edit: $out" ;; esac

echo "test: keep edits, and write them to the patch"
cp "$file" "$tmp/types.go.orig"
echo "// edit A" >>"$file"
expect "$(up prepare)" "olm: up to date, with edits"
grep -q "edit A" "$file" || fail "prepare dropped an edit"
expect "$(up diff)" "olm: wrote patches/olm.patch"
grep -q "+// edit A" "$patch" || fail "the patch lacks edit A"
expect "$(up prepare)" "olm: up to date"
cp "$patch" "$tmp/olm.patch.a"

echo "test: rebuild a clean tree when the patch changes"
cp "$tmp/types.go.orig" "$file"
up diff >/dev/null
cmp -s "$patch" "$tmp/olm.patch.orig" || fail "removing the edit did not give back the original patch"
cp "$tmp/olm.patch.a" "$patch"
expect "$(up prepare)" "olm: built from"
grep -q "edit A" "$file" || fail "the rebuilt tree lacks the changed patch"

echo "test: refuse edits when the patch changed, unless --force"
echo "// edit B" >>"$file"
cp "$tmp/olm.patch.orig" "$patch"
if out=$(up prepare); then fail "prepare replaced a tree with edits: $out"; fi
expect "$out" "changed since it was built"
if out=$(up diff); then fail "diff wrote a patch for other inputs: $out"; fi
expect "$out" "changed since"
grep -q "edit B" "$file" || fail "a refused prepare dropped edit B"
expect "$(up prepare --force)" "olm: built from"
if grep -q "edit" "$file"; then fail "--force kept the edits"; fi
cmp -s "$patch" "$tmp/olm.patch.orig" || fail "the patch changed"

echo "test: refuse a tree that prepare did not build"
rm -rf "$tmp/repo/host/third_party/olm/.git"
if out=$(up prepare); then fail "prepare replaced a tree it did not build: $out"; fi
expect "$out" "was not built by 'make prepare'"
expect "$(up prepare --force)" "olm: built from"

echo "PASS"
