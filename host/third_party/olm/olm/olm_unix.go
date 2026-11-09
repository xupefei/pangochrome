//go:build !windows

package olm

import "syscall"

// closeFD closes a file descriptor in a platform-specific way
func closeFD(fd uint32) error {
	return syscall.Close(int(fd))
}