package peers

import "slices"

// SnapshotPeers returns a deep copy of every tracked site peer. Unlike
// GetAllPeers, the result shares no slices with the manager, so callers can
// read it while the manager keeps updating peers.
func (pm *PeerManager) SnapshotPeers() []SiteConfig {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	out := make([]SiteConfig, 0, len(pm.peers))
	for _, peer := range pm.peers {
		peer.LocalEndpoints = slices.Clone(peer.LocalEndpoints)
		peer.RemoteSubnets = slices.Clone(peer.RemoteSubnets)
		peer.AllowedIps = slices.Clone(peer.AllowedIps)
		peer.Aliases = slices.Clone(peer.Aliases)
		out = append(out, peer)
	}
	return out
}
