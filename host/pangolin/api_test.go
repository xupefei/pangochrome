package pangolin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNormalizeServer(t *testing.T) {
	ok := map[string]string{
		"app.pangolin.net":            "https://app.pangolin.net",
		" https://p.example.com/ ":    "https://p.example.com",
		"http://localhost:3000":       "http://localhost:3000",
		"HTTPS://Mixed.Example.com":   "https://Mixed.Example.com",
		"pangolin.example.com:8443//": "https://pangolin.example.com:8443",
	}
	for in, want := range ok {
		got, err := NormalizeServer(in)
		if err != nil || got != want {
			t.Errorf("NormalizeServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "ftp://x.example", "https://x.example/sub", "https://", "https://x.example/?q=1"} {
		if got, err := NormalizeServer(in); err == nil {
			t.Errorf("NormalizeServer(%q) = %q, want error", in, got)
		}
	}
}

func write(w http.ResponseWriter, status int, data any, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data":    data,
		"success": status < 400,
		"error":   status >= 400,
		"message": message,
		"status":  status,
	})
}

// fakeServer imitates the Pangolin endpoints the client uses.
func fakeServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	polls := &atomic.Int32{}
	mux := http.NewServeMux()
	requireSession := func(w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("X-CSRF-Token") != csrfToken {
			write(w, http.StatusForbidden, nil, "CSRF token missing")
			return false
		}
		c, err := r.Cookie(sessionCookie)
		if err != nil || c.Value != "tok" {
			write(w, http.StatusUnauthorized, nil, "Unauthorized")
			return false
		}
		return true
	}
	mux.HandleFunc("POST /api/v1/auth/device-web-auth/start", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["applicationName"] == "" {
			write(w, http.StatusBadRequest, nil, "applicationName required")
			return
		}
		write(w, http.StatusOK, map[string]any{"code": "ABCD-1234", "expiresInSeconds": 300}, "")
	})
	mux.HandleFunc("GET /api/v1/auth/device-web-auth/poll/{code}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("code") != "ABCD-1234" {
			write(w, http.StatusOK, map[string]any{"verified": false}, "Code not found")
			return
		}
		if polls.Add(1) < 2 {
			write(w, http.StatusOK, map[string]any{"verified": false}, "Code not yet verified")
			return
		}
		write(w, http.StatusOK, map[string]any{"verified": true, "token": "tok"}, "Code verified and session created")
	})
	mux.HandleFunc("GET /api/v1/user", func(w http.ResponseWriter, r *http.Request) {
		if requireSession(w, r) {
			write(w, http.StatusOK, map[string]any{"userId": "u1", "email": "a@example.com", "name": "Ann"}, "")
		}
	})
	mux.HandleFunc("GET /api/v1/user/u1/orgs", func(w http.ResponseWriter, r *http.Request) {
		if requireSession(w, r) {
			write(w, http.StatusOK, map[string]any{"orgs": []map[string]any{{"orgId": "acme", "name": "Acme"}}}, "")
		}
	})
	mux.HandleFunc("PUT /api/v1/user/u1/olm", func(w http.ResponseWriter, r *http.Request) {
		if requireSession(w, r) {
			write(w, http.StatusOK, map[string]any{"olmId": "olm1", "secret": "s3cret"}, "")
		}
	})
	mux.HandleFunc("GET /api/v1/user/u1/olm/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(w, r) {
			return
		}
		if r.PathValue("id") != "olm1" {
			write(w, http.StatusNotFound, nil, "Olm not found")
			return
		}
		write(w, http.StatusOK, map[string]any{"olmId": "olm1"}, "")
	})
	mux.HandleFunc("GET /api/v1/org/acme/site-resources", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(w, r) {
			return
		}
		if r.URL.Query().Get("mode") != "gateway" {
			t.Errorf("mode = %q, want gateway", r.URL.Query().Get("mode"))
		}
		write(w, http.StatusOK, map[string]any{"siteResources": []map[string]any{
			{"siteResourceId": 5, "name": "Home", "mode": "gateway", "enabled": true, "siteIds": []int{1}, "siteNames": []string{"Home"}, "siteOnlines": []bool{true}},
			{"siteResourceId": 6, "name": "Off", "mode": "gateway", "enabled": false, "siteIds": []int{2}},
			{"siteResourceId": 7, "name": "No sites", "mode": "gateway", "enabled": true},
			{"siteResourceId": 8, "name": "Web", "mode": "host", "enabled": true, "siteIds": []int{1}},
		}}, "")
	})
	mux.HandleFunc("GET /api/v1/org/locked/site-resources", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusForbidden, nil, "User does not have permission")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, polls
}

func TestDeviceLoginFlow(t *testing.T) {
	srv, polls := fakeServer(t)
	ctx := context.Background()
	c := &Client{Server: srv.URL}

	code, err := c.StartDeviceLogin(ctx, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if code.Code != "ABCD-1234" {
		t.Fatalf("code = %q", code.Code)
	}
	if got := c.ApprovalURL(code.Code); got != srv.URL+"/auth/login/device?code=ABCD-1234" {
		t.Fatalf("approval URL = %q", got)
	}

	token, err := c.PollDeviceLogin(ctx, code.Code)
	if err != nil || token != "" {
		t.Fatalf("first poll = %q, %v; want pending", token, err)
	}
	token, err = c.PollDeviceLogin(ctx, code.Code)
	if err != nil || token != "tok" {
		t.Fatalf("second poll = %q, %v; want tok", token, err)
	}
	if polls.Load() != 2 {
		t.Fatalf("polls = %d", polls.Load())
	}

	if _, err := c.PollDeviceLogin(ctx, "ZZZZ-0000"); !errors.Is(err, ErrCodeExpired) {
		t.Fatalf("unknown code: err = %v, want ErrCodeExpired", err)
	}
}

func TestSessionCalls(t *testing.T) {
	srv, _ := fakeServer(t)
	ctx := context.Background()

	anon := &Client{Server: srv.URL}
	if _, err := anon.GetUser(ctx); !IsStatus(err, http.StatusUnauthorized) {
		t.Fatalf("GetUser without session: err = %v, want 401", err)
	}

	c := &Client{Server: srv.URL, Token: "tok"}
	user, err := c.GetUser(ctx)
	if err != nil || user.UserID != "u1" || user.Email != "a@example.com" || user.Name == nil || *user.Name != "Ann" {
		t.Fatalf("GetUser = %+v, %v", user, err)
	}
	orgs, err := c.ListOrgs(ctx, "u1")
	if err != nil || len(orgs) != 1 || orgs[0].OrgID != "acme" {
		t.Fatalf("ListOrgs = %+v, %v", orgs, err)
	}
	creds, err := c.CreateOlm(ctx, "u1", "laptop")
	if err != nil || creds != (OlmCredentials{ID: "olm1", Secret: "s3cret"}) {
		t.Fatalf("CreateOlm = %+v, %v", creds, err)
	}
	if ok, err := c.OlmExists(ctx, "u1", "olm1"); err != nil || !ok {
		t.Fatalf("OlmExists(olm1) = %v, %v", ok, err)
	}
	if ok, err := c.OlmExists(ctx, "u1", "gone"); err != nil || ok {
		t.Fatalf("OlmExists(gone) = %v, %v", ok, err)
	}
}

func TestListGatewaysFiltersUnusable(t *testing.T) {
	srv, _ := fakeServer(t)
	c := &Client{Server: srv.URL, Token: "tok"}
	gws, err := c.ListGateways(context.Background(), "acme")
	if err != nil {
		t.Fatal(err)
	}
	if len(gws) != 1 || gws[0].SiteResourceID != 5 {
		t.Fatalf("gateways = %+v, want only Home", gws)
	}
	_, err = c.ListGateways(context.Background(), "locked")
	if err == nil || !strings.Contains(err.Error(), "cannot list exit nodes") {
		t.Fatalf("forbidden org: err = %v", err)
	}
}

func TestNonPangolinServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>hello</html>"))
	}))
	defer srv.Close()
	_, err := (&Client{Server: srv.URL}).StartDeviceLogin(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "not a Pangolin server") {
		t.Fatalf("err = %v", err)
	}
}
