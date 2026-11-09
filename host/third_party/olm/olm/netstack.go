package olm

import (
	"fmt"
	"net/netip"
	"strings"
	"sync"

	"github.com/fosrl/olm/dns"
	"github.com/fosrl/olm/peers"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// netstackState is the userspace stack of the current connection.
// handleConnect publishes it when the connection is ready, and Close clears
// it before teardown starts, so callers never get a stack that is closing.
type netstackState struct {
	mu       sync.RWMutex
	pending  *netstack.Net // created with the device, not yet published
	net      *netstack.Net
	dnsProxy *dns.DNSProxy
}

// createNetstackTUN creates the userspace device that replaces the OS TUN
// interface in netstack mode. tunnelIP may carry a CIDR suffix.
func (o *Olm) createNetstackTUN(tunnelIP string) (tun.Device, error) {
	addr, err := netip.ParseAddr(strings.Split(tunnelIP, "/")[0])
	if err != nil {
		return nil, fmt.Errorf("invalid tunnel IP %q: %w", tunnelIP, err)
	}
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, o.olmConfig.NetstackDNS, o.tunnelConfig.MTU)
	if err != nil {
		return nil, err
	}
	o.netstack.mu.Lock()
	o.netstack.pending = tnet
	o.netstack.mu.Unlock()
	return tdev, nil
}

func (o *Olm) publishNetstack() {
	o.netstack.mu.Lock()
	defer o.netstack.mu.Unlock()
	o.netstack.net = o.netstack.pending
	o.netstack.dnsProxy = o.dnsProxy
}

func (o *Olm) clearNetstack() {
	o.netstack.mu.Lock()
	defer o.netstack.mu.Unlock()
	o.netstack.pending = nil
	o.netstack.net = nil
	o.netstack.dnsProxy = nil
}

// Net returns the userspace stack of the connected tunnel. It is nil in TUN
// mode and while no tunnel is connected.
func (o *Olm) Net() *netstack.Net {
	o.netstack.mu.RLock()
	defer o.netstack.mu.RUnlock()
	return o.netstack.net
}

// ResolveAlias returns the IPv4 addresses of a Pangolin DNS alias. Like a
// DNS query to the olm DNS proxy, a match starts a just-in-time connection
// to the site that owns the alias.
func (o *Olm) ResolveAlias(name string) ([]netip.Addr, bool) {
	o.netstack.mu.RLock()
	proxy := o.netstack.dnsProxy
	o.netstack.mu.RUnlock()
	if proxy == nil {
		return nil, false
	}
	ips, ok := proxy.ResolveLocal(name)
	if !ok {
		return nil, false
	}
	addrs := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		if addr, ok := netip.AddrFromSlice(ip); ok {
			addrs = append(addrs, addr.Unmap())
		}
	}
	return addrs, len(addrs) > 0
}

// Sites returns a copy of the site peers of the current connection, with
// their remote subnets and aliases.
func (o *Olm) Sites() []peers.SiteConfig {
	pm := o.getPeerManager()
	if pm == nil {
		return nil
	}
	return pm.SnapshotPeers()
}
