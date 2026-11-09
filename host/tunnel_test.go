package main

import (
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/fosrl/olm/api"
	"github.com/fosrl/olm/peers"
)

var testSites = []peers.SiteConfig{
	{
		SiteId:        2,
		Name:          "Office",
		RemoteSubnets: []string{"10.1.0.0/24", "fd00::/64", "10.1.0.7/24"},
		Aliases: []peers.Alias{
			{Alias: "NAS.internal.", AliasAddress: "100.96.128.10"},
			{Alias: "*.lab.internal", AliasAddress: "100.96.128.11"},
		},
	},
	{
		SiteId:  1,
		Name:    "Cloud",
		Aliases: []peers.Alias{{Alias: "db.internal", AliasAddress: "100.96.128.12"}},
	},
}

func TestBuildRoutes(t *testing.T) {
	got := buildRoutes(testSites, []string{"nas.internal", "*.lab.internal", "db.internal", "jit.internal."})
	want := routes{
		Hosts: []string{"*.lab.internal", "db.internal", "jit.internal", "nas.internal"},
		CIDRs: []string{"10.1.0.0/24", "100.96.128.10/32", "100.96.128.11/32", "100.96.128.12/32"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildRoutes:\n got %+v\nwant %+v", got, want)
	}
}

func TestBuildSitesPutsUnknownAliasesOnDemand(t *testing.T) {
	statuses := map[int]*api.PeerStatus{2: {Connected: true, IsRelay: true}}
	got := buildSites(testSites, statuses, []string{"nas.internal", "jit.internal"})
	if len(got) != 3 {
		t.Fatalf("got %d sites, want 3: %+v", len(got), got)
	}
	if got[0].Name != "Cloud" || got[0].Connected {
		t.Errorf("first site = %+v, want disconnected Cloud", got[0])
	}
	if got[1].Name != "Office" || !got[1].Connected || !got[1].Relayed {
		t.Errorf("second site = %+v, want connected and relayed Office", got[1])
	}
	if want := []string{"*.lab.internal", "nas.internal"}; !reflect.DeepEqual(got[1].Aliases, want) {
		t.Errorf("Office aliases = %v, want %v", got[1].Aliases, want)
	}
	if got[2].SiteID != 0 || !reflect.DeepEqual(got[2].Aliases, []string{"jit.internal"}) {
		t.Errorf("on-demand site = %+v, want site 0 with jit.internal", got[2])
	}
}

func TestResolveDestination(t *testing.T) {
	prefixes := sitePrefixes(testSites)
	aliases := map[string][]netip.Addr{
		"nas.internal": {netip.MustParseAddr("100.96.128.10")},
	}
	resolveAlias := func(name string) ([]netip.Addr, bool) {
		a, ok := aliases[name]
		return a, ok
	}
	lookup := func(name string) ([]string, error) {
		if name == "example.com" {
			return []string{"2606:4700::1", "93.184.215.14", "127.0.0.1"}, nil
		}
		return nil, errors.New("no such host")
	}

	tests := []struct {
		name    string
		host    string
		gateway bool
		want    []string
		wantErr error
	}{
		{"alias", "nas.internal", false, []string{"100.96.128.10"}, nil},
		{"ip in remote subnet", "10.1.0.42", false, []string{"10.1.0.42"}, nil},
		{"alias address", "100.96.128.12", false, []string{"100.96.128.12"}, nil},
		{"ip outside routes", "192.168.1.1", false, nil, errNotAllowed},
		{"public name without exit node", "example.com", false, nil, errNotAllowed},
		{"ipv6 literal", "fd00::1", false, nil, errNotAllowed},
		{"public ip with exit node", "93.184.215.14", true, []string{"93.184.215.14"}, nil},
		{"loopback with exit node", "127.0.0.1", true, nil, errNotAllowed},
		{"link-local with exit node", "169.254.1.1", true, nil, errNotAllowed},
		{"public name with exit node keeps usable IPv4 only", "example.com", true, []string{"93.184.215.14"}, nil},
		{"alias wins over exit node", "nas.internal", true, []string{"100.96.128.10"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveDestination(tt.host, tt.gateway, prefixes, resolveAlias, lookup)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var gotStr []string
			for _, a := range got {
				gotStr = append(gotStr, a.String())
			}
			if !reflect.DeepEqual(gotStr, tt.want) {
				t.Fatalf("got %v, want %v", gotStr, tt.want)
			}
		})
	}
}

func TestResolveDestinationLookupFailure(t *testing.T) {
	_, err := resolveDestination("nowhere.example", true, nil,
		func(string) ([]netip.Addr, bool) { return nil, false },
		func(string) ([]string, error) { return nil, errors.New("timeout") })
	if err == nil || errors.Is(err, errNotAllowed) {
		t.Fatalf("err = %v, want a resolution error", err)
	}
}
