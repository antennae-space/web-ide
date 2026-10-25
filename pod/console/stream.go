package console

import (
	"io"
	"sync"
	"time"
)

// A console fed by a plugin (#147, docs/design/plugins.md, *API bricks*): its output is what
// the plugin writes on a stream (a socket whose other end is its backend's), what the user
// types goes back on it, and a resize reaches the plugin through a callback. The core stays the
// only one drawing terminals; the plugin gives the bytes (docker exec, adb shell).

// streamTerm is the PTY of a console fed by a stream.
type streamTerm struct {
	rw     io.ReadWriteCloser
	resize func(cols, rows int)
	once   sync.Once
}

func (t *streamTerm) Read(b []byte) (int, error)  { return t.rw.Read(b) }
func (t *streamTerm) Write(b []byte) (int, error) { return t.rw.Write(b) }

func (t *streamTerm) Resize(cols, rows int) error {
	if t.resize != nil {
		t.resize(cols, rows)
	}
	return nil
}

// Wait is called once the stream ended: the plugin closed it.
func (t *streamTerm) Wait() int { return 0 }

func (t *streamTerm) Kill() error {
	var err error
	t.once.Do(func() { err = t.rw.Close() })
	return err
}

// AttachStream adds a console fed by a stream: rw carries its output and its input, resize is
// told its size; the console ends when the stream does, and closing it closes the stream.
func (m *Manager) AttachStream(title string, rw io.ReadWriteCloser, resize func(cols, rows int)) Info {
	if title == "" {
		title = "Terminal"
	}
	t := &streamTerm{rw: rw, resize: resize}
	c := &Console{Info: Info{ID: newID(), Title: title, Kind: "terminal", Started: time.Now().UnixMilli()}, term: t}
	m.add(c)
	go m.pump(c, t)
	return c.Info
}
