package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"pangochrome/host/pangolin"
)

func TestProfileDir(t *testing.T) {
	if _, err := profileDir("/base", "../escape"); err == nil {
		t.Error("accepted a path-like profile ID")
	}
	if _, err := profileDir("/base", "short"); err == nil {
		t.Error("accepted a profile ID under 8 characters")
	}
	got, err := profileDir("/base", "abcDEF12_-")
	if err != nil || got != "/base/profiles/abcDEF12_-" {
		t.Errorf("profileDir = %q, %v", got, err)
	}
}

func TestAccountStoreRoundTrip(t *testing.T) {
	s := newAccountStore(t.TempDir() + "/profiles/p1234567")
	if a, err := s.load(); a != nil || err != nil {
		t.Fatalf("empty store: load = %v, %v", a, err)
	}
	want := &account{
		Server: "https://p.example.com", SessionToken: "tok", UserID: "u1", Email: "a@example.com",
		OrgID: "acme", Olm: pangolin.OlmCredentials{ID: "olm1", Secret: "s"}, ExitNodes: map[string]exitNodeChoice{"acme": {SiteResourceID: 5, Name: "Home"}},
	}
	if err := s.save(want); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("account file mode = %v, want 0600", fi.Mode().Perm())
	}
	got, err := s.load()
	if err != nil || got.SessionToken != "tok" || got.Olm.ID != "olm1" || got.ExitNodes["acme"] != (exitNodeChoice{SiteResourceID: 5, Name: "Home"}) {
		t.Fatalf("load = %+v, %v", got, err)
	}
	if err := s.remove(); err != nil {
		t.Fatal(err)
	}
	if err := s.remove(); err != nil {
		t.Fatalf("second remove: %v", err)
	}
}

func TestMessageFraming(t *testing.T) {
	var buf bytes.Buffer
	w := &msgWriter{w: &buf}
	if err := w.send(map[string]any{"id": 1, "ok": true}); err != nil {
		t.Fatal(err)
	}
	if got := buf.Bytes()[:4]; !bytes.Equal(got, []byte{18, 0, 0, 0}) {
		t.Fatalf("length prefix = %v, want 18 little-endian", got)
	}
	msg, err := readMessage(&buf)
	if err != nil || string(msg) != `{"id":1,"ok":true}` {
		t.Fatalf("readMessage = %q, %v", msg, err)
	}

	oversized := bytes.NewReader([]byte{0, 0, 0x20, 0})
	if _, err := readMessage(oversized); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("oversized frame: err = %v", err)
	}
}
