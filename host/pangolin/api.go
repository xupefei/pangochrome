// Package pangolin is a client for the parts of the Pangolin user API that a
// browser client needs: device login, user and org lookup, device (olm)
// credentials and exit-node (gateway resource) listing.
package pangolin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The Pangolin API accepts this fixed value as its anti-CSRF header.
const csrfToken = "x-csrf-protection"

const sessionCookie = "p_session_token"

// Client calls one Pangolin server. Token is empty until login completes.
type Client struct {
	Server    string // e.g. "https://app.pangolin.net", no path
	Token     string
	UserAgent string
	HTTP      *http.Client
}

// APIError is an error answer from the server.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("server answered HTTP %d", e.Status)
}

// IsStatus reports whether err is an APIError with the given HTTP status.
func IsStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status
}

// NormalizeServer turns user input such as "pangolin.example.com" into
// "https://pangolin.example.com". The olm websocket ignores URL paths, so a
// path is rejected.
func NormalizeServer(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("enter a server address")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("%q is not a valid server address", raw)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("the server address must start with https://")
	}
	if strings.Trim(u.Path, "/") != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("the server address must not contain a path")
	}
	return u.Scheme + "://" + u.Host, nil
}

type envelope struct {
	Data    json.RawMessage `json:"data"`
	Success bool            `json:"success"`
	Error   json.RawMessage `json:"error"`
	Message string          `json:"message"`
}

// do sends one API call and decodes the "data" field into out. It returns
// the envelope message, which some endpoints use as a status.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) (string, error) {
	u := c.Server + "/api/v1" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return "", err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reqBody)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-CSRF-Token", csrfToken)
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Token})
	}

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach %s: %w", c.Server, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", err
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		if resp.StatusCode >= 400 {
			return "", &APIError{Status: resp.StatusCode}
		}
		return "", fmt.Errorf("%s is not a Pangolin server (unexpected answer to %s)", c.Server, path)
	}
	if !env.Success || isTrue(env.Error) || resp.StatusCode >= 400 {
		return env.Message, &APIError{Status: resp.StatusCode, Message: env.Message}
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return env.Message, fmt.Errorf("unexpected answer to %s: %w", path, err)
		}
	}
	return env.Message, nil
}

// isTrue accepts the server's "error" field as a boolean or as any
// non-empty, non-false value.
func isTrue(raw json.RawMessage) bool {
	switch s := strings.TrimSpace(string(raw)); s {
	case "", "null", "false", `""`, "0":
		return false
	default:
		return true
	}
}

// DeviceCode is a started device login.
type DeviceCode struct {
	Code      string
	ExpiresAt time.Time
}

// ApprovalURL is the page where the user approves the device code.
func (c *Client) ApprovalURL(code string) string {
	return c.Server + "/auth/login/device?code=" + url.QueryEscape(code)
}

// StartDeviceLogin asks the server for a device code.
func (c *Client) StartDeviceLogin(ctx context.Context, deviceName string) (DeviceCode, error) {
	var out struct {
		Code             string `json:"code"`
		ExpiresInSeconds int64  `json:"expiresInSeconds"`
	}
	_, err := c.do(ctx, http.MethodPost, "/auth/device-web-auth/start", nil, map[string]string{
		"applicationName": "Pangochrome",
		"deviceName":      deviceName,
	}, &out)
	if err != nil {
		return DeviceCode{}, err
	}
	if out.Code == "" {
		return DeviceCode{}, errors.New("the server did not return a login code")
	}
	return DeviceCode{Code: out.Code, ExpiresAt: time.Now().Add(time.Duration(out.ExpiresInSeconds) * time.Second)}, nil
}

// ErrCodeExpired means the device code expired or the server no longer knows it.
var ErrCodeExpired = errors.New("the login code expired, start the login again")

// PollDeviceLogin returns the session token once the user has approved the
// code, or "" while approval is pending.
func (c *Client) PollDeviceLogin(ctx context.Context, code string) (string, error) {
	var out struct {
		Verified bool   `json:"verified"`
		Token    string `json:"token"`
	}
	msg, err := c.do(ctx, http.MethodGet, "/auth/device-web-auth/poll/"+url.PathEscape(code), nil, nil, &out)
	if err != nil {
		return "", err
	}
	if out.Verified {
		if out.Token == "" {
			return "", errors.New("the server approved the login but sent no session")
		}
		return out.Token, nil
	}
	if msg == "Code expired" || msg == "Code not found" {
		return "", ErrCodeExpired
	}
	return "", nil
}

// User is the logged-in user.
type User struct {
	UserID string  `json:"userId"`
	Email  string  `json:"email"`
	Name   *string `json:"name"`
}

func (c *Client) GetUser(ctx context.Context) (User, error) {
	var u User
	_, err := c.do(ctx, http.MethodGet, "/user", nil, nil, &u)
	if err == nil && u.UserID == "" {
		err = errors.New("the server did not return a user ID")
	}
	return u, err
}

// Org is an organisation the user belongs to.
type Org struct {
	OrgID string `json:"orgId"`
	Name  string `json:"name"`
}

func (c *Client) ListOrgs(ctx context.Context, userID string) ([]Org, error) {
	var out struct {
		Orgs []Org `json:"orgs"`
	}
	_, err := c.do(ctx, http.MethodGet, "/user/"+url.PathEscape(userID)+"/orgs", nil, nil, &out)
	return out.Orgs, err
}

// OlmCredentials identify this device (an "olm") to the server.
type OlmCredentials struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

// CreateOlm registers a new device for the user in all of their orgs.
func (c *Client) CreateOlm(ctx context.Context, userID, name string) (OlmCredentials, error) {
	var out struct {
		OlmID  string `json:"olmId"`
		Secret string `json:"secret"`
	}
	_, err := c.do(ctx, http.MethodPut, "/user/"+url.PathEscape(userID)+"/olm", nil, map[string]string{"name": name}, &out)
	if err == nil && (out.OlmID == "" || out.Secret == "") {
		err = errors.New("the server did not return device credentials")
	}
	return OlmCredentials{ID: out.OlmID, Secret: out.Secret}, err
}

// OlmExists reports whether the device is still registered for the user.
func (c *Client) OlmExists(ctx context.Context, userID, olmID string) (bool, error) {
	_, err := c.do(ctx, http.MethodGet, "/user/"+url.PathEscape(userID)+"/olm/"+url.PathEscape(olmID), nil, nil, nil)
	switch {
	case err == nil:
		return true, nil
	case IsStatus(err, http.StatusNotFound):
		return false, nil
	default:
		return false, err
	}
}

// Logout ends the session on the server.
func (c *Client) Logout(ctx context.Context) error {
	_, err := c.do(ctx, http.MethodPost, "/auth/logout", nil, nil, nil)
	return err
}

// Gateway is a gateway-mode site resource. Pangolin clients call it an exit
// node: selecting it routes all traffic through its sites.
type Gateway struct {
	SiteResourceID int      `json:"siteResourceId"`
	Name           string   `json:"name"`
	Mode           string   `json:"mode"`
	Enabled        bool     `json:"enabled"`
	SiteIDs        []int    `json:"siteIds"`
	SiteNames      []string `json:"siteNames"`
	SiteOnlines    []bool   `json:"siteOnlines"`
}

// ListGateways returns the enabled gateway resources of the org that have at
// least one site.
func (c *Client) ListGateways(ctx context.Context, orgID string) ([]Gateway, error) {
	const pageSize = 100
	var all []Gateway
	for page := 1; ; page++ {
		var out struct {
			SiteResources []Gateway `json:"siteResources"`
		}
		q := url.Values{"mode": {"gateway"}, "page": {strconv.Itoa(page)}, "pageSize": {strconv.Itoa(pageSize)}}
		if _, err := c.do(ctx, http.MethodGet, "/org/"+url.PathEscape(orgID)+"/site-resources", q, nil, &out); err != nil {
			if IsStatus(err, http.StatusForbidden) {
				return nil, errors.New("your role cannot list exit nodes in this organisation")
			}
			return nil, err
		}
		// Servers without gateway mode ignore the filter, so filter again.
		for _, r := range out.SiteResources {
			if r.Mode == "gateway" && r.Enabled && len(r.SiteIDs) > 0 {
				all = append(all, r)
			}
		}
		if len(out.SiteResources) < pageSize {
			return all, nil
		}
	}
}
