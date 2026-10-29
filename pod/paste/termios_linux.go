package paste

import "golang.org/x/sys/unix"

// The ioctls reading and writing the termios of a terminal.
const (
	getTermios = unix.TCGETS
	setTermios = unix.TCSETS
)
