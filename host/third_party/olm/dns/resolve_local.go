package dns

import "net"

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
