package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func TestBrowserDirs(t *testing.T) {
	linux := browserDirs("linux", "/home/u", "")
	if linux[0].root != "/home/u/.config/google-chrome" {
		t.Errorf("linux Chrome root = %q", linux[0].root)
	}
	if got := browserDirs("linux", "/home/u", "/xdg")[1].root; got != "/xdg/chromium" {
		t.Errorf("XDG Chromium root = %q", got)
	}
	if got := browserDirs("darwin", "/Users/u", "")[0].root; got != "/Users/u/Library/Application Support/Google/Chrome" {
		t.Errorf("macOS Chrome root = %q", got)
	}
	if browserDirs("windows", "C:/", "") != nil {
		t.Error("windows should be unsupported")
	}
}

func TestInstallAndUninstall(t *testing.T) {
	tmp := t.TempDir()
	dirs := browserDirs("linux", tmp, "")
	// Chromium is present; Brave and Edge are not.
	if err := os.MkdirAll(dirs[1].root, 0o755); err != nil {
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
	foreign := manifestPath(dirs[2].root)
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
