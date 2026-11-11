package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/fosrl/newt/holepunch"
	"github.com/fosrl/newt/network"
)

// In netstack mode olm sets network.NativeConfigDisabled, and newt then
// leaves the host's interfaces and routes alone. These are the
// github.com/fosrl/newt/network symbols olm uses, each checked to be safe
// in that mode.
var reviewedNetworkSymbols = map[string]bool{
	// Change host addresses or routes, or watch the routing table, only
	// while NativeConfigDisabled is unset.
	"AddBypassRouteForDestination":     true,
	"AddGatewayDefaultRoute":           true,
	"AddRouteForServerIPWithSource":    true,
	"AddRoutesWithSource":              true,
	"AddSecondaryAddress":              true,
	"ConfigureInterface":               true,
	"ManagesHostRoutes":                true,
	"ReconcileBypassRoute":             true,
	"RemoveBypassRouteForDestination":  true,
	"RemoveGatewayDefaultRoute":        true,
	"RemoveRouteForServerIPWithSource": true,
	"RemoveRoutes":                     true,
	"RemoveSecondaryAddress":           true,
	"WatchRouteChanges":                true,
	// Read or change only newt's in-memory NetworkSettings and options.
	"ClearNetworkSettings": true,
	"GetIncrementor":       true,
	"GetJSON":              true,
	"GetSettings":          true,
	"NativeConfigDisabled": true,
	"NetworkSettings":      true,
	"PreferLocalRoutes":    true,
	"SetDNSServers":        true,
	// Only read the host.
	"ErrNoPhysicalRoute": true,
	"FindUnusedUTUN":     true,
}

// TestOlmUsesOnlyReviewedNetworkSymbols fails when an olm update starts
// using another newt/network symbol, or stops setting NativeConfigDisabled
// in netstack mode.
func TestOlmUsesOnlyReviewedNetworkSymbols(t *testing.T) {
	root := filepath.Join("third_party", "olm")
	fset := token.NewFileSet()
	setsFlagForNetstack := false
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		// main.go and the service files belong to olm's own binary, which
		// pangochrome does not build.
		if filepath.Dir(path) == root {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		local := ""
		for _, imp := range f.Imports {
			if p, _ := strconv.Unquote(imp.Path.Value); p == "github.com/fosrl/newt/network" {
				local = "network"
				if imp.Name != nil {
					local = imp.Name.Name
				}
			}
		}
		if local == "" {
			return nil
		}
		isNetwork := func(e ast.Expr, name string) bool {
			sel, ok := e.(*ast.SelectorExpr)
			if !ok {
				return false
			}
			id, ok := sel.X.(*ast.Ident)
			return ok && id.Name == local && (name == "" || sel.Sel.Name == name)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.SelectorExpr:
				if isNetwork(n, "") && !reviewedNetworkSymbols[n.Sel.Name] {
					t.Errorf("%s: olm uses network.%s, which this test has not reviewed. Check that it changes nothing on the host while network.NativeConfigDisabled is set, then add it to reviewedNetworkSymbols.",
						fset.Position(n.Pos()), n.Sel.Name)
				}
			case *ast.AssignStmt:
				if len(n.Lhs) == 1 && len(n.Rhs) == 1 && isNetwork(n.Lhs[0], "NativeConfigDisabled") && mentions(n.Rhs[0], "Netstack") {
					setsFlagForNetstack = true
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !setsFlagForNetstack {
		t.Error("olm no longer sets network.NativeConfigDisabled from OlmConfig.Netstack (olm/connect.go); netstack mode would change host routes")
	}
}

func mentions(e ast.Expr, name string) bool {
	found := false
	ast.Inspect(e, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == name {
			found = true
		}
		return !found
	})
	return found
}

// TestNewtHonoursNativeConfigDisabled fails when the newt build in use
// still changes the host with NativeConfigDisabled set on this platform -
// upstream newt v1.19.0 does on Linux and Windows. See the newt replace in
// go.mod.
func TestNewtHonoursNativeConfigDisabled(t *testing.T) {
	network.ClearNetworkSettings()
	network.NativeConfigDisabled = true
	t.Cleanup(func() {
		network.NativeConfigDisabled = false
		network.ClearNetworkSettings()
	})

	if network.ManagesHostRoutes() {
		t.Error("ManagesHostRoutes() = true with NativeConfigDisabled set")
	}
	// The interface does not exist, so reaching the OS would fail.
	if err := network.ConfigureInterface("pangotest-none0", "100.64.0.2/24", 1280); err != nil {
		t.Errorf("ConfigureInterface reached the OS with NativeConfigDisabled set: %v", err)
	}
}

// The newt in use must not send hole-punch test packets to endpoints this
// host cannot route to: on macOS with a content filter attached, such a send
// fails a later WireGuard handshake. Upstream newt v1.19.0 has no
// holepunch.ErrNoRoute, so this does not compile without the newt replace in
// go.mod.
var _ = holepunch.ErrNoRoute
