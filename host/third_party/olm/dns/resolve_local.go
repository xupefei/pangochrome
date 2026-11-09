package dns

import (
	"net"
	"slices"
	"strings"
)

// ResolveLocal answers an A query for name from the local alias records
// only. Like a DNS query to the proxy, a match calls the JIT handler, so
// that the site that owns the alias connects on demand.
func (p *DNSProxy) ResolveLocal(name string) ([]net.IP, bool) {
	ips, ok := p.recordStore.GetRecords(name, RecordTypeA)
	if !ok || len(ips) == 0 {
		return nil, false
	}
	if handler := p.jitHandler; handler != nil {
		if siteId, ok := p.recordStore.GetSiteIdForDomain(name); ok && siteId != 0 {
			go handler(siteId)
		}
	}
	return ips, true
}

// LocalNames returns every local alias name and wildcard pattern, without
// the trailing dot, sorted. It includes aliases of sites that are not
// connected yet.
func (p *DNSProxy) LocalNames() []string {
	return p.recordStore.Names()
}

// Names returns every exact domain and wildcard pattern in the store,
// without the trailing dot, sorted.
func (s *DNSRecordStore) Names() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.exact)+len(s.wildcards))
	for name := range s.exact {
		names = append(names, strings.TrimSuffix(name, "."))
	}
	for pattern := range s.wildcards {
		names = append(names, strings.TrimSuffix(pattern, "."))
	}
	slices.Sort(names)
	return names
}
