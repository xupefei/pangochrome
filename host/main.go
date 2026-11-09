// Command pangochrome-helper is the native-messaging helper of the
// Pangochrome browser extension. It runs a userspace Pangolin client and a
// local HTTP proxy that only the extension can use.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	newtlogger "github.com/fosrl/newt/logger"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `pangochrome-helper is started by the Pangochrome extension.

Commands:
  pangochrome-helper install [--extension-id ID] [--binary-path PATH]
      Register the helper with Chrome, Chromium, Brave and Edge for this user.
  pangochrome-helper uninstall
      Remove the registrations that install wrote.
  pangochrome-helper version
`

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "install":
			os.Exit(runInstall(args[1:]))
		case "uninstall":
			os.Exit(runUninstall(args[1:]))
		case "version", "--version":
			fmt.Println(version)
			return
		case "help", "-h", "--help":
			fmt.Print(usage)
			return
		}
	}
	// Chrome passes the calling origin, "chrome-extension://<id>/", as the
	// first argument.
	if len(args) == 0 || !strings.HasPrefix(args[0], "chrome-extension://") {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	os.Exit(runHost(os.Stdin))
}

func runHost(in io.Reader) int {
	// Chrome reads framed messages from stdout. Point os.Stdout at stderr so
	// that a stray print from a library cannot corrupt the stream.
	out := &msgWriter{w: os.Stdout}
	os.Stdout = os.Stderr

	baseDir, err := defaultBaseDir()
	if err != nil {
		log.Printf("no config directory: %v", err)
		return 1
	}
	if err := setUpLogging(baseDir); err != nil {
		log.Printf("logging: %v", err)
	}

	s := &server{version: version, baseDir: baseDir, out: out, userAgnt: "pangochrome-helper/" + version}
	s.tun, err = newTunnel(version, tunnelEvents{
		changed:   s.pushState,
		connected: func() { go s.onTunnelConnected() },
		stopped: func(reason string) {
			s.setError(reason)
			s.pushState()
		},
		authError: func(message string) {
			s.sessionEnded()
			s.pushState()
		},
	})
	if err != nil {
		log.Printf("start olm: %v", err)
		return 1
	}
	s.proxy, err = newLocalProxy(s.tun.dial)
	if err != nil {
		log.Printf("start proxy: %v", err)
		return 1
	}
	go func() {
		if err := s.proxy.serve(); err != nil {
			log.Printf("proxy stopped: %v", err)
		}
	}()

	// olm reports peer and route changes only through its status, so poll it.
	go func() {
		for range time.Tick(time.Second) {
			s.pushState()
		}
	}()

	for {
		msg, err := readMessage(in)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("read: %v", err)
			}
			break
		}
		var req request
		if err := json.Unmarshal(msg, &req); err != nil || req.ID <= 0 || req.Cmd == "" {
			log.Printf("ignoring malformed request")
			continue
		}
		go s.handle(req)
	}

	// Chrome closed the port: the extension was unloaded or the browser quit.
	s.tun.stop()
	_ = s.proxy.close()
	return 0
}

// setUpLogging sends the helper's and olm's logs to <base>/helper.log. The
// file restarts when it is over 5 MiB.
func setUpLogging(baseDir string) error {
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(baseDir, "helper.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if fi, err := os.Stat(path); err == nil && fi.Size() > 5<<20 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	log.SetOutput(f)
	newtlogger.GetLogger().SetOutput(f)
	return nil
}

func sortExitNodes(nodes []exitNodeInfo) {
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Name != nodes[j].Name {
			return nodes[i].Name < nodes[j].Name
		}
		return nodes[i].SiteResourceID < nodes[j].SiteResourceID
	})
}
