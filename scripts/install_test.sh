#!/usr/bin/env bash
# Tests scripts/install.sh against a local fake release, in a temporary HOME.
# Needs Go, Python 3 and a prepared host/third_party (make prepare).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
# macOS TMPDIR ends in a slash. The helper writes a clean path to the manifest.
tmpdir=${TMPDIR:-/tmp}
tmp=$(mktemp -d "${tmpdir%/}/pangochrome-install-test.XXXXXX")
server_pid=
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

version=v9.9.9
broken=v9.9.8
ext_id=abcdefghijklmnopabcdefghijklmnop
goos=$(cd "$repo/host" && go env GOOS)
goarch=$(cd "$repo/host" && go env GOARCH)

# Release $version has the host's helper under every asset name, so that a
# stubbed uname can select any of them. Release $broken has helpers that do
# not run.
publish() { # version file
  local dir="$tmp/site/download/$1" a
  mkdir -p "$dir"
  for a in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
    cp "$2" "$dir/pangochrome-helper-$a"
  done
  sed "s/^release_version=\$/release_version=$1/" "$repo/scripts/install.sh" >"$dir/install.sh"
  (cd "$dir" && shasum -a 256 pangochrome-helper-* install.sh >SHA256SUMS.txt)
}
(cd "$repo/host" && CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$version" -o "$tmp/helper" .)
publish "$version" "$tmp/helper"
printf '#!/bin/sh\nexit 1\n' >"$tmp/broken-helper"
publish "$broken" "$tmp/broken-helper"

cat >"$tmp/server.py" <<'EOF'
import http.server, os, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
os.chdir(sys.argv[2])
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
EOF
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 "$tmp/server.py" "$port" "$tmp/site" &
server_pid=$!
for _ in $(seq 50); do
  curl -fs -o /dev/null "http://127.0.0.1:$port/download/$version/SHA256SUMS.txt" && break
  sleep 0.1
done
curl -fs -o /dev/null "http://127.0.0.1:$port/download/$version/SHA256SUMS.txt" || fail "the test server did not start"

# uname and sysctl stubs, controlled by STUB_OS, STUB_CPU and STUB_ROSETTA.
mkdir "$tmp/stubs"
cat >"$tmp/stubs/uname" <<'EOF'
#!/bin/sh
case $1 in -s) echo "$STUB_OS" ;; -m) echo "$STUB_CPU" ;; esac
EOF
printf '#!/bin/sh\necho "$STUB_ROSETTA"\n' >"$tmp/stubs/sysctl"
chmod +x "$tmp/stubs/uname" "$tmp/stubs/sysctl"
case $goos in darwin) host_os=Darwin ;; *) host_os=Linux ;; esac
case $goos/$goarch in linux/arm64) host_cpu=aarch64 ;; */arm64) host_cpu=arm64 ;; *) host_cpu=x86_64 ;; esac

export HOME="$tmp/home"
unset XDG_CONFIG_HOME
export PANGOCHROME_RELEASES="http://127.0.0.1:$port"
helper="$HOME/.local/bin/pangochrome-helper"
case $goos in
darwin) manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/pangochrome.helper.json" ;;
*) manifest="$HOME/.config/google-chrome/NativeMessagingHosts/pangochrome.helper.json" ;;
esac

# Runs the install.sh of release $1 the way the popup command does:
# downloaded and piped into sh.
run() { # release, then install.sh options
  local release=$1
  shift
  curl -fsSL "$PANGOCHROME_RELEASES/download/$release/install.sh" |
    PATH="$tmp/stubs:$PATH" STUB_OS="${STUB_OS:-$host_os}" STUB_CPU="${STUB_CPU:-$host_cpu}" \
      STUB_ROSETTA="${STUB_ROSETTA:-0}" sh -s -- "$@"
}
expect_failure() { # message, then run arguments
  local message=$1 out
  shift
  if out=$(run "$@" 2>&1); then fail "succeeded, but should fail with: $message"; fi
  case $out in *"$message"*) ;; *) fail "output does not say '$message': $out" ;; esac
}

echo "test: install the release that the script comes from"
out=$(run "$version" --extension-id "$ext_id")
case $out in *"pangochrome-helper-$goos-$goarch $version"*) ;; *) fail "wrong asset: $out" ;; esac
[ -x "$helper" ] || fail "no executable helper at $helper"
[ "$("$helper" version)" = "$version" ] || fail "helper reports another version"
grep -q "\"path\": \"$helper\"" "$manifest" || fail "manifest does not point at $helper"
grep -q "chrome-extension://$ext_id/" "$manifest" || fail "manifest does not allow $ext_id"

echo "test: pick the asset for the CPU"
out=$(STUB_OS=Linux STUB_CPU=aarch64 run "$version")
case $out in *"pangochrome-helper-linux-arm64 "*) ;; *) fail "aarch64 did not select linux-arm64: $out" ;; esac
out=$(STUB_OS=Darwin STUB_CPU=x86_64 STUB_ROSETTA=1 run "$version")
case $out in *"pangochrome-helper-darwin-arm64 "*) ;; *) fail "Rosetta did not select darwin-arm64: $out" ;; esac
out=$(STUB_OS=Darwin STUB_CPU=x86_64 STUB_ROSETTA=0 run "$version")
case $out in *"pangochrome-helper-darwin-amd64 "*) ;; *) fail "Intel did not select darwin-amd64: $out" ;; esac

echo "test: refuse bad arguments and systems"
expect_failure "not a release version" "$version" --version 1.0
expect_failure "not a Chrome extension ID" "$version" --extension-id not-an-id
STUB_OS=FreeBSD expect_failure "supports macOS and Linux only" "$version"
STUB_CPU=riscv64 expect_failure "unsupported CPU" "$version"

echo "test: keep the installed helper if the new one fails"
before=$(shasum -a 256 "$helper" | awk '{ print $1 }')
expect_failure "does not run here" "$broken"
[ "$(shasum -a 256 "$helper" | awk '{ print $1 }')" = "$before" ] || fail "a helper that does not run replaced the installed one"
# A changed asset must not reach the installed path.
asset="$tmp/site/download/$version/pangochrome-helper-$goos-$goarch"
cp "$asset" "$tmp/asset.good"
printf x >>"$asset"
expect_failure "checksum mismatch" "$version"
[ "$(shasum -a 256 "$helper" | awk '{ print $1 }')" = "$before" ] || fail "a failed download replaced the installed helper"
cp "$tmp/asset.good" "$asset"

echo "test: uninstall"
run "$version" --uninstall >/dev/null
[ ! -e "$helper" ] || fail "helper still installed"
[ ! -e "$manifest" ] || fail "manifest still registered"

echo "PASS"
