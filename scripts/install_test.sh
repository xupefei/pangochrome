#!/usr/bin/env bash
# Tests scripts/install.sh against a local fake release, in a temporary HOME.
# Needs Go, Python 3 and a prepared host/third_party (make prepare).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pangochrome-install-test.XXXXXX")
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
ext_id=abcdefghijklmnopabcdefghijklmnop
case $(uname -s) in Darwin) os=darwin ;; *) os=linux ;; esac
case $(uname -m) in arm64 | aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
asset=pangochrome-helper-$os-$arch

release="$tmp/site/download/$version"
mkdir -p "$release"
(cd "$repo/host" && CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$version" -o "$release/$asset" .)
(cd "$release" && shasum -a 256 "$asset" >SHA256SUMS.txt)

# A file server that also redirects /latest the way GitHub does.
cat >"$tmp/server.py" <<'EOF'
import http.server, os, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/latest":
            self.send_response(302)
            self.send_header("Location", "/tag/" + sys.argv[3])
            self.end_headers()
            return
        super().do_GET()
    def log_message(self, *args):
        pass
os.chdir(sys.argv[2])
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
EOF
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 "$tmp/server.py" "$port" "$tmp/site" "$version" &
server_pid=$!
for _ in $(seq 50); do
  curl -fs -o /dev/null "http://127.0.0.1:$port/download/$version/SHA256SUMS.txt" && break
  sleep 0.1
done

export HOME="$tmp/home"
unset XDG_CONFIG_HOME
export PANGOCHROME_RELEASES="http://127.0.0.1:$port"
helper="$HOME/.local/bin/pangochrome-helper"
case $os in
darwin) manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/pangochrome.helper.json" ;;
*) manifest="$HOME/.config/google-chrome/NativeMessagingHosts/pangochrome.helper.json" ;;
esac
install_sh() { sh "$repo/scripts/install.sh" "$@"; }

echo "test: install a given version for a given extension"
install_sh --version "$version" --extension-id "$ext_id" >/dev/null
[ -x "$helper" ] || fail "no executable helper at $helper"
[ "$("$helper" version)" = "$version" ] || fail "helper reports another version"
grep -q "\"path\": \"$helper\"" "$manifest" || fail "manifest does not point at $helper"
grep -q "chrome-extension://$ext_id/" "$manifest" || fail "manifest does not allow $ext_id"

echo "test: install the latest version"
rm -f "$helper"
install_sh --extension-id "$ext_id" >/dev/null
[ "$("$helper" version)" = "$version" ] || fail "latest did not resolve to $version"

echo "test: refuse bad arguments"
if install_sh --version 1.0 >/dev/null 2>&1; then fail "accepted version 1.0"; fi
if install_sh --version "$version" --extension-id not-an-id >/dev/null 2>&1; then fail "accepted a bad extension ID"; fi

echo "test: refuse a checksum mismatch and keep the installed helper"
before=$(shasum -a 256 "$helper" | awk '{ print $1 }')
cp "$release/SHA256SUMS.txt" "$tmp/SHA256SUMS.good"
printf '%064d  %s\n' 0 "$asset" >"$release/SHA256SUMS.txt"
if install_sh --version "$version" >/dev/null 2>&1; then fail "accepted a bad checksum"; fi
[ "$(shasum -a 256 "$helper" | awk '{ print $1 }')" = "$before" ] || fail "a failed install replaced the helper"
cp "$tmp/SHA256SUMS.good" "$release/SHA256SUMS.txt"

echo "test: uninstall"
install_sh --uninstall >/dev/null
[ ! -e "$helper" ] || fail "helper still installed"
[ ! -e "$manifest" ] || fail "manifest still registered"

echo "PASS"
