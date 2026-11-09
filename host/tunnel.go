package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/fosrl/olm/api"
	"github.com/fosrl/olm/olm"
	"github.com/fosrl/olm/peers"
)

var errTunnelDown = errors.New("tunnel is not connected")

// Resolvers for non-alias names while an exit node is active. Queries go
// through the tunnel and leave through the exit node.
var exitNodeDNS = []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("8.8.8.8")}

type tunnelConfig struct {
	Server    string
	OlmID     string
	OlmSecret string
	UserToken string
	OrgID     string
}

// tunnelEvents are called from olm goroutines.
type tunnelEvents struct {
	changed   func()               // status may have changed
	connected func()               // the tunnel finished registration
	stopped   func(reason string)  // olm ended the tunnel on its own
	authError func(message string) // the server rejected the session
}

// tunnel runs one netstack olm. olm keeps process-wide state, so a process
// has at most one tunnel.
type tunnel struct {
	o      *olm.Olm
	events tunnelEvents

	mu      sync.Mutex
	running bool
}

func newTunnel(version string, events tunnelEvents) (*tunnel, error) {
	t := &tunnel{events: events}
	o, err := olm.Init(context.Background(), olm.OlmConfig{
		LogLevel:    "INFO",
		Agent:       "Pangochrome",
		Version:     version,
		Netstack:    true,
		NetstackDNS: exitNodeDNS,
		OnConnected: func() {
			events.connected()
			events.changed()
		},
		OnTerminated: func() { t.stopFromOlm("the server ended the connection") },
		OnAuthError: func(status int, message string) {
			go t.stop()
			events.authError(message)
		},
		OnOlmError: func(code, message string) { events.changed() },
	})
	if err != nil {
		return nil, err
	}
	t.o = o
	return t, nil
}

func (t *tunnel) start(cfg tunnelConfig) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.running {
		return
	}
	t.running = true
	go t.o.StartTunnel(olm.TunnelConfig{
		Endpoint:  cfg.Server,
		ID:        cfg.OlmID,
		Secret:    cfg.OlmSecret,
		UserToken: cfg.UserToken,
		OrgID:     cfg.OrgID,
		MTU:       1280,
		Holepunch: true,
		// Never touch the host resolver: the browser reaches aliases
		// through the proxy, not through system DNS.
		NativeDNSManaged:   true,
		InitialFingerprint: fingerprint(),
	})
}

// stop blocks until olm has torn the tunnel down.
func (t *tunnel) stop() {
	t.mu.Lock()
	wasRunning := t.running
	t.running = false
	t.mu.Unlock()
	if wasRunning {
		_ = t.o.StopTunnel()
		t.events.changed()
	}
}

// stopFromOlm handles olm ending the tunnel itself, for example after the
// server sends a terminate message.
func (t *tunnel) stopFromOlm(fallback string) {
	reason := fallback
	if st := t.o.GetStatus(); st.OlmError != nil && st.OlmError.Message != "" {
		reason = st.OlmError.Message
	}
	go t.stop()
	t.events.stopped(reason)
}

func (t *tunnel) isRunning() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.running
}

func (t *tunnel) selectExitNode(siteResourceID int, siteIDs []int) error {
	return t.o.SelectGateway(siteResourceID, siteIDs)
}

func (t *tunnel) clearExitNode() error {
	return t.o.DisableGateway()
}

// tunnelStatus is what the extension sees of the tunnel.
type tunnelStatus struct {
	running       bool
	registered    bool
	olmError      string
	sites         []siteState
	routes        routes
	gatewayActive bool
	gatewayID     int
}

func (t *tunnel) status() tunnelStatus {
	if !t.isRunning() {
		return tunnelStatus{routes: routes{Hosts: []string{}, CIDRs: []string{}}}
	}
	st := t.o.GetStatus()
	s := tunnelStatus{
		running:       true,
		registered:    st.Registered,
		gatewayActive: st.GatewayActive,
		gatewayID:     st.GatewaySiteResourceId,
	}
	if st.OlmError != nil {
		s.olmError = st.OlmError.Message
	}
	connected := t.o.Sites()
	aliasNames := t.o.AliasNames()
	s.sites = buildSites(connected, st.PeerStatuses, aliasNames)
	s.routes = buildRoutes(connected, aliasNames)
	return s
}

// siteState mirrors the Site type of docs/PROTOCOL.md.
type siteState struct {
	SiteID    int      `json:"siteId"`
	Name      string   `json:"name"`
	Connected bool     `json:"connected"`
	Relayed   bool     `json:"relayed"`
	Aliases   []string `json:"aliases"`
}

type routes struct {
	Hosts []string `json:"hosts"`
	CIDRs []string `json:"cidrs"`
}

func normaliseName(name string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
}

// buildSites lists connected sites with their aliases. Aliases of sites
// that connect just in time have no site yet, so they go under a site with
// ID 0.
func buildSites(connected []peers.SiteConfig, statuses map[int]*api.PeerStatus, aliasNames []string) []siteState {
	out := []siteState{}
	seen := map[string]bool{}
	for _, sc := range connected {
		s := siteState{SiteID: sc.SiteId, Name: sc.Name, Aliases: []string{}}
		if ps := statuses[sc.SiteId]; ps != nil {
			s.Connected = ps.Connected
			s.Relayed = ps.IsRelay
			if s.Name == "" {
				s.Name = ps.Name
			}
		}
		for _, a := range sc.Aliases {
			name := normaliseName(a.Alias)
			if name != "" && !seen[name] {
				seen[name] = true
				s.Aliases = append(s.Aliases, name)
			}
		}
		sort.Strings(s.Aliases)
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	onDemand := siteState{Name: "Connects on first use", Aliases: []string{}}
	for _, n := range aliasNames {
		name := normaliseName(n)
		if name != "" && !seen[name] {
			seen[name] = true
			onDemand.Aliases = append(onDemand.Aliases, name)
		}
	}
	if len(onDemand.Aliases) > 0 {
		out = append(out, onDemand)
	}
	return out
}

func buildRoutes(connected []peers.SiteConfig, aliasNames []string) routes {
	r := routes{Hosts: []string{}, CIDRs: []string{}}
	for _, n := range aliasNames {
		if name := normaliseName(n); name != "" {
			r.Hosts = append(r.Hosts, name)
		}
	}
	for _, p := range sitePrefixes(connected) {
		r.CIDRs = append(r.CIDRs, p.String())
	}
	slices.Sort(r.Hosts)
	r.Hosts = slices.Compact(r.Hosts)
	slices.Sort(r.CIDRs)
	r.CIDRs = slices.Compact(r.CIDRs)
	return r
}

// sitePrefixes returns the IPv4 remote subnets and alias addresses of the
// connected sites. The tunnel carries IPv4 only.
func sitePrefixes(connected []peers.SiteConfig) []netip.Prefix {
	var out []netip.Prefix
	for _, sc := range connected {
		for _, cidr := range sc.RemoteSubnets {
			if p, err := netip.ParsePrefix(strings.TrimSpace(cidr)); err == nil && p.Addr().Is4() {
				out = append(out, p.Masked())
			}
		}
		for _, a := range sc.Aliases {
			if ip, err := netip.ParseAddr(a.AliasAddress); err == nil && ip.Is4() {
				out = append(out, netip.PrefixFrom(ip, 32))
			}
		}
	}
	return out
}

// dial is the proxy's only way out. It reaches Pangolin aliases, site
// subnets and, with an exit node active, the internet, all through the
// tunnel.
func (t *tunnel) dial(ctx context.Context, host, port string) (net.Conn, error) {
	tnet := t.o.Net()
	if tnet == nil || !t.isRunning() {
		return nil, errTunnelDown
	}
	portNum, err := strconv.ParseUint(port, 10, 16)
	if err != nil || portNum == 0 {
		return nil, fmt.Errorf("invalid port %q", port)
	}
	gatewayActive := t.o.GetStatus().GatewayActive
	addrs, err := t.resolve(ctx, normaliseName(strings.Trim(host, "[]")), gatewayActive, sitePrefixes(t.o.Sites()))
	if err != nil {
		return nil, err
	}
	lastErr := errNotAllowed
	for _, a := range addrs {
		c, err := tnet.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(a, uint16(portNum)))
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (t *tunnel) resolve(ctx context.Context, host string, gatewayActive bool, prefixes []netip.Prefix) ([]netip.Addr, error) {
	return resolveDestination(host, gatewayActive, prefixes,
		t.o.ResolveAlias,
		func(name string) ([]string, error) {
			tnet := t.o.Net()
			if tnet == nil {
				return nil, errTunnelDown
			}
			return tnet.LookupContextHost(ctx, name)
		})
}

// resolveDestination applies the helper proxy rules of docs/PROTOCOL.md.
func resolveDestination(
	host string,
	gatewayActive bool,
	prefixes []netip.Prefix,
	resolveAlias func(string) ([]netip.Addr, bool),
	lookup func(string) ([]string, error),
) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		if !ipAllowed(ip, gatewayActive, prefixes) {
			return nil, errNotAllowed
		}
		return []netip.Addr{ip}, nil
	}
	if addrs, ok := resolveAlias(host); ok {
		return v4Only(addrs), nil
	}
	if !gatewayActive {
		return nil, errNotAllowed
	}
	names, err := lookup(host)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve %s through the exit node: %w", host, err)
	}
	var addrs []netip.Addr
	for _, n := range names {
		if ip, err := netip.ParseAddr(n); err == nil && ipAllowed(ip.Unmap(), true, nil) {
			addrs = append(addrs, ip.Unmap())
		}
	}
	addrs = v4Only(addrs)
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%s has no IPv4 address", host)
	}
	return addrs, nil
}

func v4Only(addrs []netip.Addr) []netip.Addr {
	var out []netip.Addr
	for _, a := range addrs {
		if a.Is4() {
			out = append(out, a)
		}
	}
	return out
}

func ipAllowed(ip netip.Addr, gatewayActive bool, prefixes []netip.Prefix) bool {
	if !ip.Is4() {
		return false
	}
	for _, p := range prefixes {
		if p.Contains(ip) {
			return true
		}
	}
	if !gatewayActive {
		return false
	}
	return !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsMulticast() && !ip.IsUnspecified()
}

// fingerprint is the device description sent at registration. It carries
// no hardware identifiers.
func fingerprint() map[string]any {
	host, _ := os.Hostname()
	return map[string]any{
		"platform": runtime.GOOS,
		"arch":     runtime.GOARCH,
		"hostname": host,
	}
}
