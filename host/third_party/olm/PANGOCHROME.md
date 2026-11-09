# Pangochrome patch to olm

Upstream: https://github.com/fosrl/olm, tag `v1.10.2` (commit `eee8873`).
Licence: AGPL-3.0 (see `LICENSE`).

The patch adds a netstack mode. In netstack mode olm runs its WireGuard
device on a userspace TCP/IP stack (`golang.zx2c4.com/wireguard/tun/netstack`)
instead of an OS TUN interface. olm then needs no root and changes no host
interfaces, routes or DNS. The embedding program reaches the tunnel through
`Olm.Net` and resolves Pangolin aliases with `Olm.ResolveAlias`.

Enable it with `OlmConfig.Netstack = true`. Also set
`TunnelConfig.NativeDNSManaged = true` and leave `OverrideDNS`, `EnableUAPI`
and `SubnetRouter` false.

## Changes

- `hostnet/` (new): wraps every host network change olm makes. After
  `hostnet.Disable()` each wrapper is a no-op. `olm/connect.go`,
  `olm/exitnode.go` and `peers/manager.go` call these wrappers instead of
  `github.com/fosrl/newt/network`. Only the package prefix changes.
- `olm/olm.go`: `Init` skips the TUN permission check and calls
  `hostnet.Disable()` in netstack mode. `Close` clears the published stack
  first.
- `olm/connect.go`: `handleConnect` creates the netstack device in netstack
  mode and publishes the stack when the connection is ready.
- `olm/netstack.go` (new): device creation and the `Net`, `ResolveAlias`,
  `AliasNames` and `Sites` accessors.
- `olm/types.go`: `OlmConfig.Netstack` and `OlmConfig.NetstackDNS`.
- `dns/resolve_local.go` (new): `DNSProxy.ResolveLocal`, an in-process alias
  lookup that also starts a just-in-time site connection, and
  `DNSProxy.LocalNames`, the list of alias names.
- `peers/snapshot.go` (new): `PeerManager.SnapshotPeers`, a deep copy of the
  site peers.

## Known limits

- An exit node of the `ExitNodeConfig` kind (used by inference resources)
  needs a second tunnel address. The netstack device has only the primary
  address, so those resources do not work in netstack mode. Gateway exit
  nodes work: they only need the `0.0.0.0/0` WireGuard claim.

## Update to a new olm release

1. Diff this directory against `v1.10.2` to get the patch:
   `git diff 35a1544 -- host/third_party/olm`.
2. Replace the directory with the new release and apply the patch.
3. Recheck that every `network.*` call that changes the host goes through
   `hostnet`.
