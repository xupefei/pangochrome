# Patches to olm and newt

The helper builds against pinned upstream releases of
[olm](https://github.com/fosrl/olm) and [newt](https://github.com/fosrl/newt),
with one patch each. Both projects are licensed under AGPL-3.0.

- `upstream.txt`: the module, version and go.sum hash of each upstream release.
- `olm.patch`, `newt.patch`: our changes, as `git diff` output against those releases.

`make prepare` (`scripts/upstream.sh prepare`) downloads each release with
`go mod download`, refuses it if its hash differs from `upstream.txt`, applies
the patch and writes the result to `host/third_party/<name>`. `host/go.mod`
replaces both modules with those directories. Git ignores them.

## Change a patch

1. Run `make prepare`.
2. Edit the files in `host/third_party/olm` or `host/third_party/newt`.
3. Run `make patches` to write the edits to `olm.patch` and `newt.patch`.

`make prepare` refuses to overwrite a tree that has edits that are not in its
patch yet. `bash scripts/upstream.sh prepare --force` drops those edits.

## olm (v1.10.2)

The patch adds a netstack mode. In netstack mode olm runs its WireGuard
device on a userspace TCP/IP stack (`golang.zx2c4.com/wireguard/tun/netstack`)
instead of an OS TUN interface. olm then needs no root and changes no host
interfaces, routes or DNS. The embedding program reaches the tunnel through
`Olm.Net` and resolves Pangolin aliases with `Olm.ResolveAlias`.

Enable it with `OlmConfig.Netstack = true`. In netstack mode `StartTunnel`
forces `NativeDNSManaged` on and `OverrideDNS`, `EnableUAPI` and
`SubnetRouter` off, so a server push cannot change host DNS either.

The same changes, as separate commits: branch `netstack-mode` of
https://github.com/xupefei/olm.

- `go.mod`: replaces newt with `../newt`, the patched newt next to olm, so
  olm's own tests run against it.
- `olm/connect.go`: `handleConnect` sets `network.NativeConfigDisabled` in
  netstack mode, creates the netstack device and publishes the stack when the
  connection is ready. It also assigns `o.peerManager` under
  `peerManagerMu`, which its readers already take.
- `olm/olm.go`: `Init` skips the TUN permission check in netstack mode.
  `StartTunnel` forces the flags above. `Close` clears the published stack
  first.
- `api/api.go`: `GetStatus` takes `statusMu` and returns copies. Without
  the lock, a status read during a peer update can stop the process with
  "concurrent map read and map write".
- `olm/netstack.go` (new): device creation and the `Net`, `ResolveAlias`,
  `AliasNames` and `Sites` accessors.
- `olm/types.go`: `OlmConfig.Netstack`.
- `dns/resolve_local.go` (new): `DNSProxy.ResolveLocal`, an in-process alias
  lookup that also starts a just-in-time site connection, and
  `DNSProxy.LocalNames`, the list of alias names.
- `peers/snapshot.go` (new): `PeerManager.SnapshotPeers`, a deep copy of the
  site peers.

## newt (v1.19.0)

Two fixes that netstack mode relies on. Each is also on its own branch of
https://github.com/xupefei/newt, for upstream:

- `native-config-disabled`: host routes and addresses are left alone through
  newt's existing `network.NativeConfigDisabled` flag, which olm already sets
  when it is handed a TUN file descriptor. Upstream newt honours that flag
  only on macOS. This change honours it on Linux and Windows too.
- `holepunch-skip-unroutable`: hole-punch test packets are not sent to
  endpoints the host has no route to. Sites report every interface address as
  a local endpoint, IPv6 included. On an IPv4-only network, with a macOS
  content filter attached (endpoint security software uses one), each failed
  IPv6 send was reported on the WireGuard socket's next send, usually a
  handshake, and the tunnel never came up.

## Known limits

- An exit node of the `ExitNodeConfig` kind (used by inference resources)
  has a second tunnel address. The netstack device has only the primary
  address. olm's MiddleDevice NAT may make this work anyway, but it is not
  tested. Gateway exit nodes only need the `0.0.0.0/0` WireGuard claim.
- `network.NativeConfigDisabled` is process-wide, so one process runs either
  TUN mode or netstack mode.

## Move to a new upstream release

1. Set the new version in `upstream.txt`. Get its hash from the `Sum` field of
   `go mod download -json github.com/fosrl/olm@<version>`.
2. Run `make prepare`. If the patch still applies, go to step 4.
3. If it does not apply: move the patch aside, run `make prepare` to build the
   bare release, apply the old patch in `host/third_party/<name>` with
   `git apply --reject <old patch>`, resolve the `.rej` files, delete them and
   run `make patches`.
4. Run `make test`. `TestOlmUsesOnlyReviewedNetworkSymbols` fails if olm
   starts using a `newt/network` symbol nobody has checked for netstack mode,
   or stops setting `NativeConfigDisabled` there.
   `TestNewtHonoursNativeConfigDisabled` fails if the newt in use still
   changes the host with the flag set.
