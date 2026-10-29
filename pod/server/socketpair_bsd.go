//go:build darwin || freebsd || netbsd || openbsd

package server

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// socketpair makes a pair of connected Unix sockets of type typ, closed on exec: no
// SOCK_CLOEXEC there, so the fork lock keeps a child from inheriting them in between.
func socketpair(typ int) ([2]int, error) {
	syscall.ForkLock.RLock()
	defer syscall.ForkLock.RUnlock()
	fds, err := unix.Socketpair(unix.AF_UNIX, typ, 0)
	if err != nil {
		return fds, err
	}
	unix.CloseOnExec(fds[0])
	unix.CloseOnExec(fds[1])
	return fds, nil
}
