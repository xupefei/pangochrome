package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"
)

// errNotAllowed means the destination is not reachable through the tunnel
// under the current routes. The proxy answers 403.
var errNotAllowed = errors.New("destination is not a Pangolin resource")

// dialFunc opens a TCP connection to host:port through the tunnel.
type dialFunc func(ctx context.Context, host, port string) (net.Conn, error)

// localProxy is an HTTP proxy on 127.0.0.1 that only Chrome, holding the
// per-process credentials, can use.
type localProxy struct {
	ln       net.Listener
	username string
	password string
	dial     dialFunc
	srv      *http.Server
	forward  *httputil.ReverseProxy
}

const dialTimeout = 20 * time.Second

func newLocalProxy(dial dialFunc) (*localProxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		ln.Close()
		return nil, err
	}
	p := &localProxy{
		ln:       ln,
		username: "pangochrome",
		password: base64.RawURLEncoding.EncodeToString(secret),
		dial:     dial,
	}
	p.forward = &httputil.ReverseProxy{
		// Out is already a copy of the absolute-form request, and ReverseProxy
		// drops hop-by-hop headers such as Proxy-Authorization.
		Rewrite: func(*httputil.ProxyRequest) {},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				return p.dial(ctx, host, port)
			},
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       60 * time.Second,
			ResponseHeaderTimeout: 2 * time.Minute,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeDialError(w, r.Host, err)
		},
	}
	p.srv = &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second, ErrorLog: log.Default()}
	return p, nil
}

func (p *localProxy) port() int { return p.ln.Addr().(*net.TCPAddr).Port }

func (p *localProxy) serve() error { return p.srv.Serve(p.ln) }

func (p *localProxy) close() error { return p.srv.Close() }

func (p *localProxy) authorised(r *http.Request) bool {
	user, pass, ok := parseProxyBasicAuth(r.Header.Get("Proxy-Authorization"))
	if !ok {
		return false
	}
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(p.username)) == 1
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(p.password)) == 1
	return userOK && passOK
}

func parseProxyBasicAuth(h string) (user, pass string, ok bool) {
	const prefix = "Basic "
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(h[len(prefix):]))
	if err != nil {
		return "", "", false
	}
	user, pass, ok = strings.Cut(string(raw), ":")
	return user, pass, ok
}

func (p *localProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !p.authorised(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="pangochrome"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	switch {
	case r.Method == http.MethodConnect:
		p.handleConnect(w, r)
	case r.URL.IsAbs() && r.URL.Scheme == "http":
		p.forward.ServeHTTP(w, r)
	default:
		http.Error(w, "this is a proxy, send absolute-form or CONNECT requests", http.StatusBadRequest)
	}
}

func (p *localProxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "CONNECT needs host:port", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dialTimeout)
	upstream, err := p.dial(ctx, host, port)
	cancel()
	if err != nil {
		writeDialError(w, r.Host, err)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "connection cannot be hijacked", http.StatusInternalServerError)
		return
	}
	client, brw, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		client.Close()
		upstream.Close()
		return
	}
	// The client may have sent the start of the TLS handshake already.
	if n := brw.Reader.Buffered(); n > 0 {
		buffered, _ := brw.Reader.Peek(n)
		if _, err := upstream.Write(buffered); err != nil {
			client.Close()
			upstream.Close()
			return
		}
	}
	pipe(client, upstream)
}

// pipe copies both ways until both directions finish, then closes both.
func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	copyHalf := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go copyHalf(a, b)
	go copyHalf(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}

func writeDialError(w http.ResponseWriter, target string, err error) {
	switch {
	case errors.Is(err, errNotAllowed):
		http.Error(w, target+" is not a Pangolin resource you can reach", http.StatusForbidden)
	case errors.Is(err, errTunnelDown):
		http.Error(w, "the Pangolin tunnel is not connected", http.StatusBadGateway)
	default:
		log.Printf("proxy: dial %s: %v", target, err)
		http.Error(w, "cannot reach "+target+" through Pangolin", http.StatusBadGateway)
	}
}
