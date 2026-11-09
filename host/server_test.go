package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"pangochrome/host/pangolin"
)

func newTestServer(t *testing.T) *server {
	t.Helper()
	store := newAccountStore(t.TempDir())
	return &server{
		out:   &msgWriter{w: &bytes.Buffer{}},
		tun:   newTunnel("test", tunnelEvents{changed: func() {}}),
		store: &store,
	}
}

func TestSentence(t *testing.T) {
	for in, want := range map[string]string{
		"":                          "",
		"log in to Pangolin first":  "Log in to Pangolin first.",
		"Already a sentence.":       "Already a sentence.",
		"élan is missing":           "Élan is missing.",
		"cannot reach x: timed out": "Cannot reach x: timed out.",
	} {
		if got := sentence(in); got != want {
			t.Errorf("sentence(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStatePhases(t *testing.T) {
	s := newTestServer(t)
	if got := s.state(); got.Phase != "loggedOut" || got.User != nil || len(got.Orgs) != 0 {
		t.Fatalf("no account: %+v", got)
	}

	s.login = &loginFlow{info: loginInfo{Code: "AB-12"}, cancel: func() {}}
	if got := s.state(); got.Phase != "loggingIn" || got.Login == nil || got.Login.Code != "AB-12" {
		t.Fatalf("login in progress: %+v", got)
	}
	s.login = nil

	s.acct = &account{
		Server: "https://p.example.com", SessionToken: "tok", Email: "a@example.com", OrgID: "acme",
		ExitNodes: map[string]exitNodeChoice{"acme": {SiteResourceID: 5, Name: "Home"}},
	}
	s.orgs = []pangolin.Org{{OrgID: "acme", Name: "Acme"}}
	got := s.state()
	if got.Phase != "disconnected" || got.OrgID != "acme" || len(got.Orgs) != 1 {
		t.Fatalf("logged in: %+v", got)
	}
	if got.ExitNode == nil || got.ExitNode.Name != "Home" || got.ExitNode.Active {
		t.Fatalf("exit node while disconnected: %+v", got.ExitNode)
	}

	// A session that ended keeps the user and the exit-node choice, so the
	// extension keeps failing closed, but hides the orgs.
	s.acct.SessionToken = ""
	got = s.state()
	if got.Phase != "loggedOut" || got.User == nil || len(got.Orgs) != 0 || got.ExitNode == nil || got.ExitNode.Active {
		t.Fatalf("session ended: %+v", got)
	}
}

func TestStateJSONHasEmptyArrays(t *testing.T) {
	b, err := json.Marshal(newTestServer(t).state())
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"orgs", "sites"} {
		if _, ok := v[key].([]any); !ok {
			t.Errorf("%s = %v, want an array", key, v[key])
		}
	}
	r, _ := v["routes"].(map[string]any)
	if _, ok := r["hosts"].([]any); !ok {
		t.Errorf("routes.hosts = %v, want an array", r["hosts"])
	}
}

func TestFinishLoginAfterCancelDiscardsSession(t *testing.T) {
	var loggedOut atomic.Bool
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, data any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "success": true, "error": false})
	}
	mux.HandleFunc("GET /api/v1/user", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"userId": "u1", "email": "a@example.com"})
	})
	mux.HandleFunc("GET /api/v1/user/u1/orgs", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"orgs": []map[string]any{{"orgId": "acme", "name": "Acme"}}})
	})
	mux.HandleFunc("PUT /api/v1/user/u1/olm", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"olmId": "olm1", "secret": "s"})
	})
	mux.HandleFunc("POST /api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		loggedOut.Store(true)
		ok(w, map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	s := newTestServer(t)
	_, cancel := context.WithCancel(context.Background())
	flow := &loginFlow{cancel: cancel}
	s.login = nil // the user cancelled after approving
	c := &pangolin.Client{Server: srv.URL, Token: "new-token"}

	if err := s.finishLogin(flow, c); err != nil {
		t.Fatal(err)
	}
	if s.acct != nil {
		t.Fatalf("a cancelled login saved an account: %+v", s.acct)
	}
	if a, err := s.store.load(); a != nil || err != nil {
		t.Fatalf("store = %+v, %v; want empty", a, err)
	}
	waitFor(t, loggedOut.Load, "the discarded session was not logged out")

	// The same flow, still current, saves the account.
	s.login = flow
	if err := s.finishLogin(flow, c); err != nil {
		t.Fatal(err)
	}
	if s.acct == nil || s.acct.SessionToken != "new-token" || s.acct.OrgID != "acme" || s.acct.Olm.ID != "olm1" {
		t.Fatalf("account = %+v", s.acct)
	}
}

func TestClosedWriterRefusesWrites(t *testing.T) {
	var buf bytes.Buffer
	w := &msgWriter{w: &buf}
	w.close()
	if err := w.send(map[string]int{"id": 1}); err != errWriterClosed {
		t.Fatalf("send after close: err = %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("wrote %d bytes after close", buf.Len())
	}
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal(msg)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
