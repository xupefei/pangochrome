// Package hostnet wraps every change olm makes to the host network:
// interface addresses, routes and route watching. After Disable, every
// function is a no-op. Netstack mode (see olm.OlmConfig.Netstack) calls
// Disable because the tunnel then has no OS interface to configure.
package hostnet

import (
	"context"
	"sync/atomic"

	"github.com/fosrl/newt/network"
)

var disabled atomic.Bool

// Disable turns every function in this package into a no-op for the rest of
// the process.
func Disable() { disabled.Store(true) }

// Disabled reports whether Disable was called.
func Disabled() bool { return disabled.Load() }

func ConfigureInterface(interfaceName, tunnelIP string, mtu int) error {
	if Disabled() {
		return nil
	}
	return network.ConfigureInterface(interfaceName, tunnelIP, mtu)
}

func AddSecondaryAddress(interfaceName, addr string) error {
	if Disabled() {
		return nil
	}
	return network.AddSecondaryAddress(interfaceName, addr)
}

func RemoveSecondaryAddress(interfaceName, addr string) error {
	if Disabled() {
		return nil
	}
	return network.RemoveSecondaryAddress(interfaceName, addr)
}

func AddRoutesWithSource(remoteSubnets []string, interfaceName, sourceIP string) error {
	if Disabled() {
		return nil
	}
	return network.AddRoutesWithSource(remoteSubnets, interfaceName, sourceIP)
}

func RemoveRoutes(remoteSubnets []string, interfaceName string) error {
	if Disabled() {
		return nil
	}
	return network.RemoveRoutes(remoteSubnets, interfaceName)
}

func AddRouteForServerIPWithSource(serverIP, interfaceName, sourceIP string) error {
	if Disabled() {
		return nil
	}
	return network.AddRouteForServerIPWithSource(serverIP, interfaceName, sourceIP)
}

func RemoveRouteForServerIPWithSource(serverIP, interfaceName, sourceIP string) error {
	if Disabled() {
		return nil
	}
	return network.RemoveRouteForServerIPWithSource(serverIP, interfaceName, sourceIP)
}

func AddGatewayDefaultRoute(interfaceName, sourceIP string) error {
	if Disabled() {
		return nil
	}
	return network.AddGatewayDefaultRoute(interfaceName, sourceIP)
}

func RemoveGatewayDefaultRoute(interfaceName string) error {
	if Disabled() {
		return nil
	}
	return network.RemoveGatewayDefaultRoute(interfaceName)
}

func AddBypassRouteForDestination(destIP, tunnelInterface string) error {
	if Disabled() {
		return nil
	}
	return network.AddBypassRouteForDestination(destIP, tunnelInterface)
}

func RemoveBypassRouteForDestination(destIP string) error {
	if Disabled() {
		return nil
	}
	return network.RemoveBypassRouteForDestination(destIP)
}

func ReconcileBypassRoute(destIP, tunnelInterface string) (bool, error) {
	if Disabled() {
		return false, nil
	}
	return network.ReconcileBypassRoute(destIP, tunnelInterface)
}

func ManagesHostRoutes() bool {
	return !Disabled() && network.ManagesHostRoutes()
}

func WatchRouteChanges(ctx context.Context, onChange func()) error {
	if Disabled() {
		return nil
	}
	return network.WatchRouteChanges(ctx, onChange)
}
