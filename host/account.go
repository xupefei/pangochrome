package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	"pangochrome/host/pangolin"
)

// account is what the helper keeps between runs for one browser profile.
// The file holds the session token and device secret, so it is mode 0600.
type account struct {
	Server       string                  `json:"server"`
	SessionToken string                  `json:"sessionToken"`
	UserID       string                  `json:"userId"`
	Email        string                  `json:"email"`
	Name         string                  `json:"name,omitempty"`
	OrgID        string                  `json:"orgId,omitempty"`
	Olm          pangolin.OlmCredentials `json:"olm"`
	// ExitNodes maps an org ID to the chosen gateway site resource ID.
	ExitNodes map[string]int `json:"exitNodes,omitempty"`
}

var profileIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// profileDir returns the state directory of one browser profile.
func profileDir(base, profileID string) (string, error) {
	if !profileIDPattern.MatchString(profileID) {
		return "", errors.New("invalid profile ID")
	}
	return filepath.Join(base, "profiles", profileID), nil
}

// defaultBaseDir is ~/.config/pangochrome on Linux and
// ~/Library/Application Support/pangochrome on macOS.
func defaultBaseDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pangochrome"), nil
}

type accountStore struct{ path string }

func newAccountStore(dir string) accountStore {
	return accountStore{path: filepath.Join(dir, "account.json")}
}

// load returns nil and no error when no account is saved.
func (s accountStore) load() (*account, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var a account
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, fmt.Errorf("saved account is damaged: %w", err)
	}
	return &a, nil
}

func (s accountStore) save(a *account) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".account-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func (s accountStore) remove() error {
	err := os.Remove(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
