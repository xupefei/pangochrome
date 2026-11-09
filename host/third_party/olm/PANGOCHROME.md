# Pangochrome patch to olm

Upstream: https://github.com/fosrl/olm, tag `v1.10.2` (commit `eee8873`).
Licence: AGPL-3.0 (see `LICENSE`).
The same patch, as separate commits: branch `netstack-mode` of
https://github.com/xupefei/olm.

The patch adds a netstack mode. In netstack mode olm runs its WireGuard
device on a userspace TCP/IP stack (`golang.zx2c4.com/wireguard/tun/netstack`)
instead of an OS TUN interface. olm then needs no root and changes no host
interfaces, routes or DNS. The embedding program reaches the tunnel through
`Olm.Net` and resolves Pangolin aliases with `Olm.ResolveAlias`.

Enable it with `OlmConfig.Netstack = true`. In netstack mode `StartTunnel`
forces `NativeDNSManaged` on and `OverrideDNS`, `EnableUAPI` and
`SubnetRouter` off, so a server push cannot change host DNS either.

Host routes and addresses are left alone through newt's existing
`network.NativeConfigDisabled` flag, which olm already sets when it is handed
a TUN file descriptor. Upstream newt v1.19.0 honours that flag only on macOS,
so `go.mod` (here and in `host/`) replaces newt with
https://github.com/xupefei/newt/tree/native-config-disabled, which honours it
on Linux and Windows too.

## Changes

- `go.mod`, `go.sum`: the newt replace above.
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

## Known limits

- An exit node of the `ExitNodeConfig` kind (used by inference resources)
  has a second tunnel address. The netstack device has only the primary
  address. olm's MiddleDevice NAT may make this work anyway, but it is not
  tested. Gateway exit nodes only need the `0.0.0.0/0` WireGuard claim.
- `network.NativeConfigDisabled` is process-wide, so one process runs either
  TUN mode or netstack mode.

## Update to a new olm release

1. Diff this directory against `v1.10.2` to get the patch:
   `git diff 664f46d -- host/third_party/olm`.
2. Replace the directory with the new release and apply the patch.
3. Run `go test ./...` in `host/`.
   `TestOlmUsesOnlyReviewedNetworkSymbols` fails if olm starts using a
   `newt/network` symbol nobody has checked for netstack mode, or stops
   setting `NativeConfigDisabled` there. `TestNewtHonoursNativeConfigDisabled`
   fails if the newt in use still changes the host with the flag set.
