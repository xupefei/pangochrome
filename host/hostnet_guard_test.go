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
)

// Functions of github.com/fosrl/newt/network that change the host. In
// netstack mode olm must reach them only through its hostnet package.
var hostChangingNetworkFuncs = map[string]bool{
	"AddBypassRouteForDestination":     true,
	"AddGatewayDefaultRoute":           true,
	"AddRouteForServerIP":              true,
	"AddRouteForServerIPWithSource":    true,
	"AddRoutes":                        true,
	"AddRoutesWithSource":              true,
	"AddSecondaryAddress":              true,
	"ConfigureInterface":               true,
	"DarwinAddRoute":                   true,
	"DarwinAddRouteWithSource":         true,
	"DarwinRemoveRoute":                true,
	"LinuxAddRoute":                    true,
	"LinuxRemoveRoute":                 true,
	"ReconcileBypassRoute":             true,
	"RemoveBypassRouteForDestination":  true,
	"RemoveGatewayDefaultRoute":        true,
	"RemoveRouteForServerIP":           true,
	"RemoveRouteForServerIPWithSource": true,
	"RemoveRoutes":                     true,
	"RemoveSecondaryAddress":           true,
	"WatchRouteChanges":                true,
	"WindowsAddRoute":                  true,
	"WindowsRemoveRoute":               true,
}

func TestOlmHostNetworkCallsUseHostnet(t *testing.T) {
	root := filepath.Join("third_party", "olm")
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "hostnet" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
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
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == local && hostChangingNetworkFuncs[sel.Sel.Name] {
				t.Errorf("%s calls network.%s directly; call hostnet.%s instead", fset.Position(sel.Pos()), sel.Sel.Name, sel.Sel.Name)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
