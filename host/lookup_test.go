package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"reflect"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// startTCPDNS serves A records over TCP only and records the names asked.
func startTCPDNS(t *testing.T, answers map[string]string) (string, chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	asked := make(chan string, 16)
	srv := &dns.Server{Listener: ln, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
		m := new(dns.Msg)
		m.SetReply(q)
		name := q.Question[0].Name
		asked <- name
		if ip, ok := answers[name]; ok && q.Question[0].Qtype == dns.TypeA {
			m.Answer = append(m.Answer, &dns.A{
				Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.ParseIP(ip),
			})
		} else if !ok {
			m.Rcode = dns.RcodeNameError
		}
		_ = w.WriteMsg(m)
	})}
	go srv.ActivateAndServe()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return ln.Addr().String(), asked
}

func TestLookupOverTCPFallsBackToTheNextServer(t *testing.T) {
	addr, asked := startTCPDNS(t, map[string]string{"example.com.": "93.184.215.14"})
	first, second := netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.2")
	var dialled []netip.AddrPort
	dial := func(ctx context.Context, server netip.AddrPort) (net.Conn, error) {
		dialled = append(dialled, server)
		if server.Addr() == first {
			return nil, errors.New("unreachable")
		}
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	got, err := lookupOverTCP(ctx, []netip.Addr{first, second}, "example.com", dial)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"93.184.215.14"}) {
		t.Fatalf("got %v", got)
	}
	if name := <-asked; name != "example.com." {
		t.Fatalf("asked %q, want the rooted name", name)
	}
	for _, d := range dialled {
		if d.Port() != 53 {
			t.Fatalf("dialled %v, want port 53", d)
		}
	}
	if dialled[len(dialled)-1].Addr() != second {
		t.Fatalf("dialled %v, want the second server last", dialled)
	}
}

func TestLookupOverTCPReportsUnknownNames(t *testing.T) {
	addr, _ := startTCPDNS(t, nil)
	dial := func(ctx context.Context, _ netip.AddrPort) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if got, err := lookupOverTCP(ctx, []netip.Addr{netip.MustParseAddr("192.0.2.1")}, "nowhere.example", dial); err == nil {
		t.Fatalf("got %v, want an error", got)
	}
}
