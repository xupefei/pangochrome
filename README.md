# Pangochrome

Pangochrome lets Chrome reach [Pangolin](https://github.com/fosrl/pangolin)
private resources without a system VPN and without root. It works with
Pangolin Cloud and with self-hosted Pangolin.

Only the browser profile that runs the extension uses the tunnel. Other apps
and other profiles keep the normal network.

Pangochrome is tested on macOS. The Linux helper is built and unit-tested,
but nobody has tried it on a real Linux desktop yet. Windows is not supported.

## Install

1. Install the Pangochrome extension.
2. Open its popup. It shows a command for your system, for example:

   ```sh
   curl -fsSL https://github.com/xupefei/pangochrome/releases/download/v0.1.0/install.sh | sh -s -- --extension-id <id>
   ```

3. Run the command in a terminal, then press **Retry** in the popup.

The script needs `curl`. It installs the helper of its own release:

1. It downloads the helper for your system and checks it against the
   release's `SHA256SUMS.txt`.
2. It installs the helper as `~/.local/bin/pangochrome-helper`. It needs no
   root.
3. It registers the helper with the Chromium browsers that you have: Google
   Chrome (also Beta, Dev and Canary), Chromium, Brave, Microsoft Edge,
   Vivaldi, Opera and, on macOS, Arc. Snap and Flatpak browsers cannot start
   the helper.

When the extension updates to a newer version than the helper, the popup
shows the command again. To remove the helper, run:

```sh
curl -fsSL https://github.com/xupefei/pangochrome/releases/latest/download/install.sh | sh -s -- --uninstall
```

## How it works

Pangochrome has two parts:

- **The extension** (`extension/`, Chrome MV3) shows the login, the org and
  the exit node. It sets a PAC script so that Chrome sends Pangolin traffic
  to the helper.
- **The helper** (`host/`, Go) is a Chrome native-messaging host. It runs
  Pangolin's client library [olm](https://github.com/fosrl/olm) on a userspace
  network stack (netstack mode), and serves an HTTP proxy on `127.0.0.1` that
  only the extension can use.

The olm and newt code comes from pinned upstream releases plus the patches in
`patches/`. See `patches/README.md`.
`docs/PROTOCOL.md` defines the messages between the two parts and the
routing rules.

Chrome sends these requests to the helper:

- Pangolin DNS aliases, for example `nas.internal` or `*.lab.internal`.
- IPv4 addresses inside the remote subnets and alias addresses of your sites.
- With an exit node chosen: all other traffic, except `localhost`, loopback,
  link-local and private LAN addresses. Until the exit node is active, the
  helper refuses this traffic, so it fails instead of going out directly.
  WebRTC is limited to proxied connections while an exit node is chosen.

All other traffic goes direct. If you want to be connected but the tunnel is
down, or your Pangolin session has ended, Chrome sends the same requests to a
closed port instead, so they fail and do not leak out directly. Turn off the
connection in the popup to browse normally.

## Build

You need Go 1.26 or later, Node.js 22 or later, git and unzip. The tests
also need Python 3.

```sh
make helper        # writes dist/pangochrome-helper
make extension     # writes extension/dist
make install-helper
```

`make install-helper` registers `dist/pangochrome-helper` with the Chromium
browsers of the current user, on Linux and macOS.
If you move the binary, run `pangochrome-helper install` again.

Then open `chrome://extensions`, turn on Developer mode, click
**Load unpacked** and select `extension/dist`. The unpacked extension has the
ID `lioplghkjopgaienllcabfmfehgkjgfh`, which `pangochrome-helper install`
allows. To also allow another ID, such as the Chrome Web Store build's, run
`pangochrome-helper install --extension-id <id>`.

## Use

1. Click the Pangochrome icon.
2. Choose Pangolin Cloud, or enter the address of your Pangolin server.
3. Click **Log in**. A tab opens on your server. Check that the code matches
   and approve the device.
4. Choose the organisation and turn on the toggle.
5. Optional: choose an exit node to send all browser traffic through a site.

Each browser profile has its own device and login. `docs/PRIVACY.md` lists
what the helper keeps, and where.

The helper logs to `helper.log` in `~/Library/Application Support/pangochrome`
on macOS and `~/.config/pangochrome` on Linux. To add olm's and WireGuard's
debug logs, create an empty file named `debug` in the same folder and
reconnect. Debug logs leave out secrets, but they are long; delete the file
when you are done.

## Test

```sh
make test
```

`make test` runs every test suite. CI runs it on Linux (x86-64 and arm64)
and macOS. On Linux, CI also runs `make test-netns`, which checks in a
network namespace that the helper leaves host routes and addresses alone.

## Release

1. Set the same version in `extension/static/manifest.json` and
   `extension/package.json`.
2. Push a tag `v<version>`, for example `v0.1.0`.

The Release workflow runs the tests and publishes a GitHub release with the
helpers for macOS and Linux, `install.sh`, the Chrome Web Store zip
`pangochrome-extension-v<version>.zip` and `SHA256SUMS.txt`, with a build
attestation for each file. The popup of extension version X installs the
helper of release vX, so submit only the zip of a published release.

To check a download, run `gh attestation verify <file> --repo xupefei/pangochrome`.

## Limits

- Chromium browsers only. The helper runs on macOS and Linux. It is not
  signed with an Apple Developer ID. The install script works without one,
  because macOS does not quarantine files that `curl` downloads.
- The tunnel carries IPv4 TCP only. Chrome does not use QUIC through a
  proxy, so HTTP/3 sites use TCP instead.
- A host name that resolves to a resource IP in public DNS goes direct. Use
  the Pangolin alias or the IP address instead.
- With an exit node on, the helper resolves public names with 1.1.1.1 and
  8.8.8.8, over TCP through the tunnel. Exit nodes do not always forward UDP.
- Listing exit nodes needs a role that can list the org's site resources.
  The Pangolin CLI has the same rule.
- Resources that need an exit-node server connection, such as AI gateway
  (inference) resources, are not tested.
- Fail-closed sends traffic to `127.0.0.1:1`. On macOS any local program may
  listen on that port, so a local program could receive that traffic.

## Licence

AGPL-3.0, because the helper includes olm. See `LICENSE` and `NOTICE`.
