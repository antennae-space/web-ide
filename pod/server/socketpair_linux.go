package server

import "golang.org/x/sys/unix"

// socketpair makes a pair of connected Unix sockets of type typ, closed on exec.
func socketpair(typ int) ([2]int, error) {
	return unix.Socketpair(unix.AF_UNIX, typ|unix.SOCK_CLOEXEC, 0)
}
