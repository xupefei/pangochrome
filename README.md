# Pangochrome

Pangochrome lets Chrome reach [Pangolin](https://github.com/fosrl/pangolin)
private resources without a system VPN and without root. It works with
Pangolin Cloud and with self-hosted Pangolin.

Only the browser profile that runs the extension uses the tunnel. Other apps
and other profiles keep the normal network.

## How it works

Pangochrome has two parts:

- **The extension** (`extension/`, Chrome MV3) shows the login, the org and
  the exit node. It sets a PAC script so that Chrome sends Pangolin traffic
  to the helper.
- **The helper** (`host/`, Go) is a Chrome native-messaging host. It runs
  Pangolin's client library [olm](https://github.com/fosrl/olm) on a userspace
  network stack, and serves an HTTP proxy on `127.0.0.1` that only the
  extension can use.

The olm copy in `host/third_party/olm` has a small patch that adds this
userspace mode. See `host/third_party/olm/PANGOCHROME.md`.
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

You need Go 1.26 or later and Node.js 22 or later.

```sh
make helper        # writes dist/pangochrome-helper
make extension     # writes extension/dist
make install-helper
```

`make install-helper` registers `dist/pangochrome-helper` with Chrome,
Chromium, Brave and Microsoft Edge for the current user, on Linux and macOS.
If you move the binary, run `pangochrome-helper install` again.

Then open `chrome://extensions`, turn on Developer mode, click
**Load unpacked** and select `extension/dist`. The extension ID is
`lioplghkjopgaienllcabfmfehgkjgfh`. The helper accepts only this ID. To allow
another ID, run `pangochrome-helper install --extension-id <id>`.

## Use

1. Click the Pangochrome icon.
2. Choose Pangolin Cloud, or enter the address of your Pangolin server.
3. Click **Log in**. A tab opens on your server. Check that the code matches
   and approve the device.
4. Choose the organisation and turn on the toggle.
5. Optional: choose an exit node to send all browser traffic through a site.

The helper keeps its state in `~/.config/pangochrome` on Linux and in
`~/Library/Application Support/pangochrome` on macOS. Each browser profile
has its own device and login. Logging out ends the session but keeps the
device registration, so the next login reuses it. The log is `helper.log` in
the same directory.

## Test

```sh
make test
```

This runs the helper's Go tests, the upstream olm tests for the patched
packages, and the extension's unit tests.

## Limits

- Chrome only. The helper runs on Linux and macOS.
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
