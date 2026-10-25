package console

import (
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// A console fed by a stream: what the plugin writes is its output, what the user types reaches
// the plugin, a resize is told, the stream closed ends it.
func TestAttachStream(t *testing.T) {
	var mu sync.Mutex
	var out strings.Builder
	exited := make(chan int, 1)
	m := NewManager(nil, "/", Events{
		Output: func(id string, data []byte, offset int64) { mu.Lock(); out.Write(data); mu.Unlock() },
		Exit:   func(id string, code int) { exited <- code },
	})
	pod, plugin := net.Pipe()
	var size [2]int
	info := m.AttachStream("docker exec web", pod, func(cols, rows int) { size = [2]int{cols, rows} })
	if info.Title != "docker exec web" || len(m.List()) != 1 {
		t.Fatalf("listed: %+v", m.List())
	}
	go func() { _, _ = plugin.Write([]byte("$ ")) }()
	for i := 0; i < 50; i++ {
		mu.Lock()
		got := out.String()
		mu.Unlock()
		if got == "$ " {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	go func() { _ = m.Input(info.ID, []byte("ls\r")) }()
	b := make([]byte, 8)
	n, _ := plugin.Read(b)
	if string(b[:n]) != "ls\r" {
		t.Fatalf("input: %q", b[:n])
	}
	_ = m.Resize(info.ID, 100, 30)
	if size != [2]int{100, 30} {
		t.Fatalf("resize: %v", size)
	}
	if _, snap, _ := m.Attach(info.ID); string(snap) != "$ " {
		t.Fatalf("scrollback: %q", snap)
	}
	plugin.Close()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream closed does not end the console")
	}
}
