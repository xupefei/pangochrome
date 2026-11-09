package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

// These must match config/ids.json; install_test.go checks this.
const (
	nativeHostName     = "pangochrome.helper"
	defaultExtensionID = "lioplghkjopgaienllcabfmfehgkjgfh"
)

var extensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)

type hostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

type browserDir struct {
	browser string
	root    string // the browser's user data directory
}

// browserDirs lists the per-user data directories of the supported
// Chromium browsers. The manifest goes in <root>/NativeMessagingHosts.
func browserDirs(goos, home, configHome string) []browserDir {
	switch goos {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		return []browserDir{
			{"Google Chrome", filepath.Join(base, "Google", "Chrome")},
			{"Chromium", filepath.Join(base, "Chromium")},
			{"Brave", filepath.Join(base, "BraveSoftware", "Brave-Browser")},
			{"Microsoft Edge", filepath.Join(base, "Microsoft Edge")},
		}
	case "linux":
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		return []browserDir{
			{"Google Chrome", filepath.Join(configHome, "google-chrome")},
			{"Chromium", filepath.Join(configHome, "chromium")},
			{"Brave", filepath.Join(configHome, "BraveSoftware", "Brave-Browser")},
			{"Microsoft Edge", filepath.Join(configHome, "microsoft-edge")},
		}
	}
	return nil
}

func manifestPath(root string) string {
	return filepath.Join(root, "NativeMessagingHosts", nativeHostName+".json")
}

func currentBrowserDirs() ([]browserDir, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dirs := browserDirs(runtime.GOOS, home, os.Getenv("XDG_CONFIG_HOME"))
	if dirs == nil {
		return nil, fmt.Errorf("install is not supported on %s", runtime.GOOS)
	}
	return dirs, nil
}

func runInstall(args []string) int {
	fset := flag.NewFlagSet("install", flag.ContinueOnError)
	extID := fset.String("extension-id", defaultExtensionID, "Chrome extension `ID` allowed to start the helper")
	binPath := fset.String("binary-path", "", "absolute `path` of the helper binary (default: this binary)")
	if err := fset.Parse(args); err != nil {
		return 2
	}
	dirs, err := currentBrowserDirs()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	path, err := resolveBinaryPath(*binPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	written, err := install(dirs, path, *extID)
	for _, p := range written {
		fmt.Println("Registered:", p)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func runUninstall(args []string) int {
	if len(args) > 0 {
		fmt.Fprintln(os.Stderr, "uninstall takes no arguments")
		return 2
	}
	dirs, err := currentBrowserDirs()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	removed, err := uninstall(dirs)
	for _, p := range removed {
		fmt.Println("Removed:", p)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func resolveBinaryPath(p string) (string, error) {
	if p == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		p = exe
	}
	if !filepath.IsAbs(p) {
		return "", errors.New("--binary-path must be an absolute path")
	}
	fi, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("%s is not an executable file", p)
	}
	return filepath.Clean(p), nil
}

// install writes the manifest for Chrome always, and for each other browser
// whose data directory exists.
func install(dirs []browserDir, binaryPath, extensionID string) ([]string, error) {
	if !extensionIDPattern.MatchString(extensionID) {
		return nil, fmt.Errorf("%q is not a Chrome extension ID", extensionID)
	}
	m := hostManifest{
		Name:           nativeHostName,
		Description:    "Pangochrome helper",
		Path:           binaryPath,
		Type:           "stdio",
		AllowedOrigins: []string{"chrome-extension://" + extensionID + "/"},
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	b = append(b, '\n')

	var written []string
	for i, d := range dirs {
		if i > 0 {
			if _, err := os.Stat(d.root); err != nil {
				continue
			}
		}
		p := manifestPath(d.root)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return written, fmt.Errorf("%s: %w", d.browser, err)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return written, fmt.Errorf("%s: %w", d.browser, err)
		}
		written = append(written, p)
	}
	return written, nil
}

// uninstall removes only manifests that carry our host name.
func uninstall(dirs []browserDir) ([]string, error) {
	var removed []string
	for _, d := range dirs {
		p := manifestPath(d.root)
		b, err := os.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return removed, err
		}
		var m hostManifest
		if json.Unmarshal(b, &m) != nil || m.Name != nativeHostName {
			continue
		}
		if err := os.Remove(p); err != nil {
			return removed, err
		}
		removed = append(removed, p)
	}
	return removed, nil
}
