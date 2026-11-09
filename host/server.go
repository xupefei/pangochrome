package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"pangochrome/host/pangolin"
)

type request struct {
	ID             int64  `json:"id"`
	Cmd            string `json:"cmd"`
	ProfileID      string `json:"profileId"`
	Server         string `json:"server"`
	OrgID          string `json:"orgId"`
	SiteResourceID *int   `json:"siteResourceId"`
}

type reply struct {
	ID     int64  `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type stateEvent struct {
	Event string    `json:"event"`
	State stateView `json:"state"`
}

// The JSON types below follow docs/PROTOCOL.md.

type helloResult struct {
	Version string     `json:"version"`
	Proxy   proxyCreds `json:"proxy"`
}

type proxyCreds struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginInfo struct {
	Code      string `json:"code"`
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expiresAt"`
}

type exitNodeInfo struct {
	SiteResourceID int      `json:"siteResourceId"`
	Name           string   `json:"name"`
	SiteNames      []string `json:"siteNames"`
	Online         bool     `json:"online"`
}

type userView struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type exitNodeView struct {
	SiteResourceID int    `json:"siteResourceId"`
	Name           string `json:"name"`
	Active         bool   `json:"active"`
}

type stateView struct {
	Phase    string         `json:"phase"`
	Server   string         `json:"server,omitempty"`
	User     *userView      `json:"user,omitempty"`
	Orgs     []pangolin.Org `json:"orgs"`
	OrgID    string         `json:"orgId,omitempty"`
	Login    *loginInfo     `json:"login,omitempty"`
	Error    string         `json:"error,omitempty"`
	Sites    []siteState    `json:"sites"`
	Routes   routes         `json:"routes"`
	ExitNode *exitNodeView  `json:"exitNode,omitempty"`
}

type loginFlow struct {
	info   loginInfo
	cancel context.CancelFunc
}

type server struct {
	version  string
	baseDir  string
	out      *msgWriter
	proxy    *localProxy
	tun      *tunnel
	userAgnt string

	mu       sync.Mutex
	store    *accountStore
	acct     *account
	orgs     []pangolin.Org
	login    *loginFlow
	lastErr  string
	gateways map[int]pangolin.Gateway // last gateway list of acct.OrgID
	lastSent []byte
}

var errNotLoggedIn = errors.New("log in to Pangolin first")

func (s *server) handle(req request) {
	result, err := s.dispatch(req)
	r := reply{ID: req.ID, OK: err == nil, Result: result}
	if err != nil {
		r.Error = sentence(err.Error())
		r.Result = nil
	} else if result == nil {
		r.Result = struct{}{}
	}
	if sendErr := s.out.send(r); sendErr != nil {
		log.Printf("send reply: %v", sendErr)
	}
	s.pushState()
}

// sentence turns a Go error string into UI text: capital first letter, full
// stop at the end.
func sentence(msg string) string {
	if msg == "" {
		return msg
	}
	msg = strings.ToUpper(msg[:1]) + msg[1:]
	if !strings.HasSuffix(msg, ".") {
		msg += "."
	}
	return msg
}

func (s *server) dispatch(req request) (any, error) {
	if req.Cmd != "hello" && s.currentStore() == nil {
		return nil, errors.New("send hello first")
	}
	switch req.Cmd {
	case "hello":
		return s.hello(req.ProfileID)
	case "getState":
		return s.state(), nil
	case "login":
		return s.startLogin(req.Server)
	case "cancelLogin":
		s.cancelLogin()
		return nil, nil
	case "logout":
		return nil, s.logout()
	case "selectOrg":
		return nil, s.selectOrg(req.OrgID)
	case "connect":
		return nil, s.connect()
	case "disconnect":
		s.setError("")
		s.tun.stop()
		return nil, nil
	case "listExitNodes":
		return s.listExitNodes()
	case "setExitNode":
		if req.SiteResourceID == nil {
			return nil, errors.New("siteResourceId is required")
		}
		return nil, s.setExitNode(*req.SiteResourceID)
	default:
		return nil, fmt.Errorf("unknown command %q", req.Cmd)
	}
}

func (s *server) currentStore() *accountStore {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store
}

func (s *server) setError(msg string) {
	s.mu.Lock()
	s.lastErr = msg
	s.mu.Unlock()
}

func (s *server) hello(profileID string) (any, error) {
	dir, err := profileDir(s.baseDir, profileID)
	if err != nil {
		return nil, err
	}
	store := newAccountStore(dir)
	s.mu.Lock()
	if s.store != nil && s.store.path != store.path {
		s.mu.Unlock()
		return nil, errors.New("this helper process already serves another browser profile")
	}
	s.store = &store
	acct, loadErr := store.load()
	s.acct = acct
	if loadErr != nil {
		s.lastErr = loadErr.Error()
	}
	s.mu.Unlock()

	if acct != nil && acct.SessionToken != "" {
		go s.refreshOrgs()
	}
	return helloResult{
		Version: s.version,
		Proxy: proxyCreds{
			Host:     "127.0.0.1",
			Port:     s.proxy.port(),
			Username: s.proxy.username,
			Password: s.proxy.password,
		},
	}, nil
}

func (s *server) client(acct *account) *pangolin.Client {
	c := &pangolin.Client{Server: acct.Server, Token: acct.SessionToken, UserAgent: s.userAgnt}
	return c
}

// loggedIn returns a copy of the account, or an error when there is no
// usable session.
func (s *server) loggedIn() (account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acct == nil || s.acct.SessionToken == "" {
		return account{}, errNotLoggedIn
	}
	return *s.acct, nil
}

func (s *server) refreshOrgs() {
	acct, err := s.loggedIn()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	orgs, err := s.client(&acct).ListOrgs(ctx, acct.UserID)
	if err != nil {
		if pangolin.IsStatus(err, http.StatusUnauthorized) {
			s.sessionEnded()
		} else {
			s.setError("Cannot load organisations: " + err.Error())
		}
		s.pushState()
		return
	}
	s.mu.Lock()
	s.orgs = orgs
	s.mu.Unlock()
	s.pushState()
}

func deviceName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "browser"
	}
	return host + " (Pangochrome)"
}

func (s *server) startLogin(rawServer string) (any, error) {
	serverURL, err := pangolin.NormalizeServer(rawServer)
	if err != nil {
		return nil, err
	}
	s.cancelLogin()
	s.tun.stop()

	c := &pangolin.Client{Server: serverURL, UserAgent: s.userAgnt}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	code, err := c.StartDeviceLogin(ctx, deviceName())
	cancel()
	if err != nil {
		return nil, fmt.Errorf("cannot start the login: %w", err)
	}
	info := loginInfo{Code: code.Code, URL: c.ApprovalURL(code.Code), ExpiresAt: code.ExpiresAt.UnixMilli()}

	pollCtx, pollCancel := context.WithDeadline(context.Background(), code.ExpiresAt)
	flow := &loginFlow{info: info, cancel: pollCancel}
	s.mu.Lock()
	s.login = flow
	s.lastErr = ""
	s.mu.Unlock()
	go s.pollLogin(pollCtx, flow, c, code.Code)
	return info, nil
}

func (s *server) cancelLogin() {
	s.mu.Lock()
	flow := s.login
	s.login = nil
	s.mu.Unlock()
	if flow != nil {
		flow.cancel()
	}
}

func (s *server) pollLogin(ctx context.Context, flow *loginFlow, c *pangolin.Client, code string) {
	defer flow.cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.endLogin(flow, "The login code expired. Start the login again.")
			return
		case <-ticker.C:
		}
		token, err := c.PollDeviceLogin(ctx, code)
		if errors.Is(err, pangolin.ErrCodeExpired) {
			s.endLogin(flow, err.Error())
			return
		}
		if err != nil {
			if ctx.Err() != nil {
				continue
			}
			log.Printf("poll login: %v", err)
			continue
		}
		if token == "" {
			continue
		}
		c.Token = token
		err = s.finishLogin(c)
		msg := ""
		if err != nil {
			msg = "Login failed: " + err.Error()
		}
		s.endLogin(flow, msg)
		return
	}
}

// endLogin clears the login flow if it is still the current one.
func (s *server) endLogin(flow *loginFlow, errMsg string) {
	s.mu.Lock()
	if s.login == flow {
		s.login = nil
		if errMsg != "" {
			s.lastErr = errMsg
		}
	}
	s.mu.Unlock()
	s.pushState()
}

func (s *server) finishLogin(c *pangolin.Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	user, err := c.GetUser(ctx)
	if err != nil {
		return err
	}
	orgs, err := c.ListOrgs(ctx, user.UserID)
	if err != nil {
		return err
	}

	s.mu.Lock()
	prev := s.acct
	s.mu.Unlock()

	// Reuse this profile's device when the same user logs in again, so the
	// server does not collect stale devices.
	var creds pangolin.OlmCredentials
	if prev != nil && prev.Server == c.Server && prev.UserID == user.UserID && prev.Olm.ID != "" {
		exists, err := c.OlmExists(ctx, user.UserID, prev.Olm.ID)
		if err != nil {
			return err
		}
		if exists {
			creds = prev.Olm
		}
	}
	if creds.ID == "" {
		creds, err = c.CreateOlm(ctx, user.UserID, deviceName())
		if err != nil {
			return fmt.Errorf("cannot register this browser as a device: %w", err)
		}
	}

	acct := &account{
		Server:       c.Server,
		SessionToken: c.Token,
		UserID:       user.UserID,
		Email:        user.Email,
		Olm:          creds,
	}
	if user.Name != nil {
		acct.Name = *user.Name
	}
	if prev != nil && prev.Server == c.Server && prev.UserID == user.UserID {
		acct.ExitNodes = prev.ExitNodes
		acct.OrgID = prev.OrgID
	}
	if !hasOrg(orgs, acct.OrgID) {
		acct.OrgID = ""
		if len(orgs) > 0 {
			acct.OrgID = orgs[0].OrgID
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.save(acct); err != nil {
		return fmt.Errorf("cannot save the login: %w", err)
	}
	s.acct = acct
	s.orgs = orgs
	s.gateways = nil
	return nil
}

func hasOrg(orgs []pangolin.Org, id string) bool {
	for _, o := range orgs {
		if o.OrgID == id {
			return true
		}
	}
	return false
}

// sessionEnded keeps the server and email for the next login but forgets
// the session.
func (s *server) sessionEnded() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acct == nil {
		return
	}
	s.acct.SessionToken = ""
	if err := s.store.save(s.acct); err != nil {
		log.Printf("save account: %v", err)
	}
	s.lastErr = "Your Pangolin session ended. Log in again."
}

func (s *server) logout() error {
	s.cancelLogin()
	s.tun.stop()
	s.mu.Lock()
	acct := s.acct
	s.acct = nil
	s.orgs = nil
	s.gateways = nil
	s.lastErr = ""
	err := s.store.remove()
	s.mu.Unlock()
	if acct != nil && acct.SessionToken != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if logoutErr := s.client(acct).Logout(ctx); logoutErr != nil {
			log.Printf("server logout: %v", logoutErr)
		}
		cancel()
	}
	return err
}

func (s *server) selectOrg(orgID string) error {
	s.mu.Lock()
	if s.acct == nil || s.acct.SessionToken == "" {
		s.mu.Unlock()
		return errNotLoggedIn
	}
	if !hasOrg(s.orgs, orgID) {
		s.mu.Unlock()
		return errors.New("you are not a member of that organisation")
	}
	changed := s.acct.OrgID != orgID
	s.acct.OrgID = orgID
	s.gateways = nil
	s.lastErr = ""
	err := s.store.save(s.acct)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if changed && s.tun.isRunning() {
		s.tun.stop()
		return s.connect()
	}
	return nil
}

func (s *server) connect() error {
	acct, err := s.loggedIn()
	if err != nil {
		return err
	}
	if acct.OrgID == "" {
		return errors.New("choose an organisation first")
	}
	s.setError("")
	return s.tun.start(tunnelConfig{
		Server:    acct.Server,
		OlmID:     acct.Olm.ID,
		OlmSecret: acct.Olm.Secret,
		UserToken: acct.SessionToken,
		OrgID:     acct.OrgID,
	})
}

// fetchGateways loads the gateway list of the current org and caches it.
func (s *server) fetchGateways() (map[int]pangolin.Gateway, error) {
	acct, err := s.loggedIn()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	list, err := s.client(&acct).ListGateways(ctx, acct.OrgID)
	if err != nil {
		if pangolin.IsStatus(err, http.StatusUnauthorized) {
			s.sessionEnded()
		}
		return nil, err
	}
	byID := make(map[int]pangolin.Gateway, len(list))
	for _, g := range list {
		byID[g.SiteResourceID] = g
	}
	s.mu.Lock()
	if s.acct != nil && s.acct.OrgID == acct.OrgID {
		s.gateways = byID
	}
	s.mu.Unlock()
	return byID, nil
}

func (s *server) listExitNodes() (any, error) {
	byID, err := s.fetchGateways()
	if err != nil {
		return nil, err
	}
	out := make([]exitNodeInfo, 0, len(byID))
	for _, g := range byID {
		online := false
		for _, on := range g.SiteOnlines {
			online = online || on
		}
		names := g.SiteNames
		if names == nil {
			names = []string{}
		}
		out = append(out, exitNodeInfo{SiteResourceID: g.SiteResourceID, Name: g.Name, SiteNames: names, Online: online})
	}
	sortExitNodes(out)
	return out, nil
}

func (s *server) setExitNode(id int) error {
	if id < 0 {
		return errors.New("invalid exit node")
	}
	acct, err := s.loggedIn()
	if err != nil {
		return err
	}
	var gw pangolin.Gateway
	if id != 0 {
		s.mu.Lock()
		cached, ok := s.gateways[id]
		s.mu.Unlock()
		if !ok {
			byID, err := s.fetchGateways()
			if err != nil {
				return err
			}
			if cached, ok = byID[id]; !ok {
				return errors.New("that exit node is not available")
			}
		}
		gw = cached
	}

	s.mu.Lock()
	if s.acct == nil || s.acct.OrgID != acct.OrgID {
		s.mu.Unlock()
		return errors.New("the organisation changed, try again")
	}
	if s.acct.ExitNodes == nil {
		s.acct.ExitNodes = map[string]exitNodeChoice{}
	}
	if id == 0 {
		delete(s.acct.ExitNodes, acct.OrgID)
	} else {
		s.acct.ExitNodes[acct.OrgID] = exitNodeChoice{SiteResourceID: id, Name: gw.Name}
	}
	s.lastErr = ""
	saveErr := s.store.save(s.acct)
	s.mu.Unlock()
	if saveErr != nil {
		return saveErr
	}

	if !s.tun.status().registered {
		return nil // applied by onTunnelConnected
	}
	if id == 0 {
		return s.tun.clearExitNode()
	}
	return s.tun.selectExitNode(gw.SiteResourceID, gw.SiteIDs)
}

// onTunnelConnected applies the saved exit node of the org.
func (s *server) onTunnelConnected() {
	acct, err := s.loggedIn()
	if err != nil {
		return
	}
	id := acct.ExitNodes[acct.OrgID].SiteResourceID
	if id == 0 {
		return
	}
	s.mu.Lock()
	gw, ok := s.gateways[id]
	s.mu.Unlock()
	if !ok {
		byID, err := s.fetchGateways()
		if err != nil {
			s.setError("Cannot turn on the exit node: " + err.Error())
			s.pushState()
			return
		}
		if gw, ok = byID[id]; !ok {
			s.setError("The saved exit node is no longer available.")
			s.pushState()
			return
		}
	}
	if err := s.tun.selectExitNode(gw.SiteResourceID, gw.SiteIDs); err != nil {
		s.setError("Cannot turn on the exit node: " + err.Error())
	}
	s.pushState()
}

func (s *server) state() stateView {
	ts := s.tun.status()

	s.mu.Lock()
	defer s.mu.Unlock()
	v := stateView{
		Orgs:   []pangolin.Org{},
		Sites:  []siteState{},
		Routes: routes{Hosts: []string{}, CIDRs: []string{}},
		Error:  s.lastErr,
	}
	if s.orgs != nil {
		v.Orgs = s.orgs
	}
	if s.acct != nil {
		v.Server = s.acct.Server
		if s.acct.Email != "" {
			v.User = &userView{Email: s.acct.Email, Name: s.acct.Name}
		}
	}
	switch {
	case s.login != nil:
		v.Phase = "loggingIn"
		info := s.login.info
		v.Login = &info
	case s.acct == nil || s.acct.SessionToken == "":
		v.Phase = "loggedOut"
	case !ts.running:
		v.Phase = "disconnected"
	case !ts.registered:
		v.Phase = "connecting"
	default:
		v.Phase = "connected"
	}
	if v.Phase == "loggedOut" || v.Phase == "loggingIn" {
		v.Orgs = []pangolin.Org{}
		return v
	}
	v.OrgID = s.acct.OrgID
	if ts.running {
		v.Sites = ts.sites
		if v.Error == "" {
			v.Error = ts.olmError
		}
	}
	if v.Phase == "connected" {
		v.Routes = ts.routes
	}
	if choice := s.acct.ExitNodes[s.acct.OrgID]; choice.SiteResourceID != 0 {
		id := choice.SiteResourceID
		v.ExitNode = &exitNodeView{
			SiteResourceID: id,
			Name:           choice.Name,
			Active:         v.Phase == "connected" && ts.gatewayActive && ts.gatewayID == id,
		}
	}
	return v
}

// pushState sends a state event when the state differs from the last one
// sent.
func (s *server) pushState() {
	if s.currentStore() == nil {
		return
	}
	v := s.state()
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	same := bytes.Equal(b, s.lastSent)
	if !same {
		s.lastSent = b
	}
	s.mu.Unlock()
	if same {
		return
	}
	if err := s.out.send(stateEvent{Event: "state", State: v}); err != nil {
		log.Printf("send state: %v", err)
	}
}
