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
// handleConnect publishes it when the connection is ready. Close clears it
// before teardown starts, so Net returns nil from then on. Dials on a stack
// obtained earlier fail once the device closes.
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
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, o.tunnelConfig.MTU)
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
// DNS query to the olm DNS proxy, a match also starts a just-in-time
// connection to the site that owns the alias, if it is not connected.
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

// AliasNames returns every Pangolin alias name and wildcard pattern of the
// current connection, including aliases of sites that connect just in time.
func (o *Olm) AliasNames() []string {
	o.netstack.mu.RLock()
	proxy := o.netstack.dnsProxy
	o.netstack.mu.RUnlock()
	if proxy == nil {
		return nil
	}
	return proxy.LocalNames()
}

// Sites returns a copy of the connected site peers, with their remote
// subnets and aliases. Sites that connect just in time appear only after
// they connect.
func (o *Olm) Sites() []peers.SiteConfig {
	pm := o.getPeerManager()
	if pm == nil {
		return nil
	}
	return pm.SnapshotPeers()
}
