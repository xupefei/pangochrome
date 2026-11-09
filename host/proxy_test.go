package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// startProxy runs a localProxy whose dial goes to backend for "app.internal"
// and fails with errNotAllowed for any other host.
func startProxy(t *testing.T, backend string) *localProxy {
	t.Helper()
	dial := func(ctx context.Context, host, port string) (net.Conn, error) {
		switch host {
		case "app.internal":
			var d net.Dialer
			return d.DialContext(ctx, "tcp", backend)
		case "down.internal":
			return nil, errors.New("connection refused")
		default:
			return nil, errNotAllowed
		}
	}
	p, err := newLocalProxy(dial)
	if err != nil {
		t.Fatal(err)
	}
	go p.serve()
	t.Cleanup(func() { p.close() })
	return p
}

func authHeader(p *localProxy) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(p.username+":"+p.password))
}

func proxyClient(p *localProxy, withAuth bool) *http.Client {
	proxyURL := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", p.port())}
	if withAuth {
		proxyURL.User = url.UserPassword(p.username, p.password)
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)},
		Timeout:   10 * time.Second,
	}
}

func TestProxyRequiresAuth(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer backend.Close()
	p := startProxy(t, backend.Listener.Addr().String())

	resp, err := proxyClient(p, false).Get("http://app.internal/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("status = %d, want 407", resp.StatusCode)
	}
	if got := resp.Header.Get("Proxy-Authenticate"); !strings.HasPrefix(got, "Basic ") {
		t.Fatalf("Proxy-Authenticate = %q", got)
	}

	wrong := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", p.port()), User: url.UserPassword(p.username, "wrong")}
	c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(wrong)}}
	resp, err = c.Get("http://app.internal/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("wrong password: status = %d, want 407", resp.StatusCode)
	}
}

func TestProxyForwardsHTTP(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("Proxy-Authorization leaked to the backend")
		}
		fmt.Fprintf(w, "host=%s path=%s", r.Host, r.URL.Path)
	}))
	defer backend.Close()
	p := startProxy(t, backend.Listener.Addr().String())

	resp, err := proxyClient(p, true).Get("http://app.internal/hello")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "host=app.internal path=/hello" {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
}

func TestProxyRejectsAndReportsDialErrors(t *testing.T) {
	p := startProxy(t, "127.0.0.1:1")
	for host, want := range map[string]int{
		"example.com":   http.StatusForbidden,
		"down.internal": http.StatusBadGateway,
	} {
		resp, err := proxyClient(p, true).Get("http://" + host + "/")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s: status = %d, want %d", host, resp.StatusCode, want)
		}
	}
}

func TestProxyConnectTunnel(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	p := startProxy(t, echo.Addr().String())

	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", p.port()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	// Send the CONNECT and the first payload bytes together, as browsers may.
	fmt.Fprintf(conn, "CONNECT app.internal:443 HTTP/1.1\r\nHost: app.internal:443\r\nProxy-Authorization: %s\r\n\r\nping", authHeader(p))

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d, want 200", resp.StatusCode)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(br, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "ping" {
		t.Fatalf("echo = %q, want ping", buf)
	}
}

func TestProxyRejectsOriginFormRequests(t *testing.T) {
	p := startProxy(t, "127.0.0.1:1")
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", p.port()), nil)
	req.Header.Set("Proxy-Authorization", authHeader(p))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}
