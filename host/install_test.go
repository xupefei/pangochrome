package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestIDsMatchConfig(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "config", "ids.json"))
	if err != nil {
		t.Fatal(err)
	}
	var ids struct {
		NativeHostName    string `json:"nativeHostName"`
		ChromeExtensionID string `json:"chromeExtensionId"`
	}
	if err := json.Unmarshal(b, &ids); err != nil {
		t.Fatal(err)
	}
	if ids.NativeHostName != nativeHostName || ids.ChromeExtensionID != defaultExtensionID {
		t.Fatalf("config/ids.json has %+v; install.go has %q and %q", ids, nativeHostName, defaultExtensionID)
	}
}

// dirOf returns the data directory of browser in dirs.
func dirOf(t *testing.T, dirs []browserDir, browser string) string {
	t.Helper()
	for _, d := range dirs {
		if d.browser == browser {
			return d.root
		}
	}
	t.Fatalf("no %s in %v", browser, dirs)
	return ""
}

func TestBrowserDirs(t *testing.T) {
	linux := browserDirs("linux", "/home/u", "")
	if linux[0].browser != "Google Chrome" || linux[0].root != "/home/u/.config/google-chrome" {
		t.Errorf("linux first entry = %+v, want Google Chrome", linux[0])
	}
	if got := dirOf(t, browserDirs("linux", "/home/u", "/xdg"), "Chromium"); got != "/xdg/chromium" {
		t.Errorf("XDG Chromium root = %q", got)
	}
	mac := browserDirs("darwin", "/Users/u", "")
	if mac[0].browser != "Google Chrome" || mac[0].root != "/Users/u/Library/Application Support/Google/Chrome" {
		t.Errorf("macOS first entry = %+v, want Google Chrome", mac[0])
	}
	if got := dirOf(t, mac, "Arc"); got != "/Users/u/Library/Application Support/Arc/User Data" {
		t.Errorf("macOS Arc root = %q", got)
	}
	if browserDirs("windows", "C:/", "") != nil {
		t.Error("windows should be unsupported")
	}
}

func TestInstallAndUninstall(t *testing.T) {
	tmp := t.TempDir()
	dirs := browserDirs("linux", tmp, "")
	// Chromium is present. The other browsers apart from Chrome are not.
	if err := os.MkdirAll(dirOf(t, dirs, "Chromium"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := install(dirs, "/opt/p/pangochrome-helper", "not-an-id"); err == nil {
		t.Fatal("install accepted an invalid extension ID")
	}
	written, err := install(dirs, "/opt/p/pangochrome-helper", defaultExtensionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 2 {
		t.Fatalf("wrote %v, want Chrome and Chromium only", written)
	}
	b, err := os.ReadFile(manifestPath(dirs[0].root))
	if err != nil {
		t.Fatal(err)
	}
	var m hostManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m.Name != nativeHostName || m.Path != "/opt/p/pangochrome-helper" || m.Type != "stdio" ||
		len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != "chrome-extension://"+defaultExtensionID+"/" {
		t.Fatalf("manifest = %+v", m)
	}

	// A file with our name but another host inside is not ours to delete.
	foreign := manifestPath(dirOf(t, dirs, "Brave"))
	if err := os.MkdirAll(filepath.Dir(foreign), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(foreign, []byte(`{"name":"someone.else"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	removed, err := uninstall(dirs)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 2 {
		t.Fatalf("removed %v, want the two written manifests", removed)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("foreign manifest was removed: %v", err)
	}
}

func TestResolveBinaryPath(t *testing.T) {
	if _, err := resolveBinaryPath("relative/helper"); err == nil {
		t.Error("accepted a relative path")
	}
	dir := t.TempDir()
	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveBinaryPath(plain); err == nil {
		t.Error("accepted a non-executable file")
	}
	exe := filepath.Join(dir, "exe")
	if err := os.WriteFile(exe, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveBinaryPath(exe); err != nil || got != exe {
		t.Errorf("resolveBinaryPath(exe) = %q, %v", got, err)
	}
}

func TestInstallKeepsEarlierExtensionIDs(t *testing.T) {
	dirs := browserDirs("linux", t.TempDir(), "")[:1]
	const other = "abcdefghijklmnopabcdefghijklmnop"
	for _, id := range []string{other, defaultExtensionID, defaultExtensionID} {
		if _, err := install(dirs, "/opt/p/pangochrome-helper", id); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(manifestPath(dirs[0].root))
	if err != nil {
		t.Fatal(err)
	}
	var m hostManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	want := []string{"chrome-extension://" + other + "/", "chrome-extension://" + defaultExtensionID + "/"}
	if !slices.Equal(m.AllowedOrigins, want) {
		t.Fatalf("allowed_origins = %v, want %v", m.AllowedOrigins, want)
	}

	// Origins that are not extension origins are dropped.
	m.AllowedOrigins = append(m.AllowedOrigins, "https://evil.example/")
	b, _ = json.Marshal(m)
	if err := os.WriteFile(manifestPath(dirs[0].root), b, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := previousOrigins(manifestPath(dirs[0].root)); !slices.Equal(got, want) {
		t.Fatalf("previousOrigins = %v, want %v", got, want)
	}
}
