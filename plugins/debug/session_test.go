package debug

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"antennae.space/ide/plugins/debug/internal/dap"
	"antennae.space/ide/pod/projects"
	"antennae.space/ide/pod/runtime"
	"antennae.space/ide/pod/sshx"
	"antennae.space/ide/pod/store"
)

// openRuntime is a local project of its own (files, consoles, events), for the tests.
func openRuntime(t *testing.T, events *[]map[string]any) *runtime.Runtime {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	rt, err := runtime.Open(projects.Project{ID: "p-dbg", Type: "local", Path: dir}, sshx.Creds{},
		runtime.Deps{Store: st}, func(event string, data any, _ string) {
			*events = append(*events, map[string]any{"event": event, "data": data})
		})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	return rt
}

// fakeHost is an adapter on the other end of a pipe: it records the requests and can send
// events.
type fakeHost struct {
	rw     io.ReadWriter
	mu     sync.Mutex
	seen   []map[string]any
	closed chan struct{}
}

func (f *fakeHost) serve() {
	br := bufio.NewReader(f.rw)
	for {
		body, err := readFrame(br)
		if err != nil {
			return
		}
		var m struct {
			Seq       int             `json:"seq"`
			Command   string          `json:"command"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(body, &m) != nil {
			continue
		}
		if m.Command == "disconnect" {
			return
		}
		f.mu.Lock()
		f.seen = append(f.seen, map[string]any{"command": m.Command, "arguments": m.Arguments})
		f.mu.Unlock()
		_ = writeFrame(f.rw, map[string]any{"seq": 0, "type": "response", "command": m.Command,
			"request_seq": m.Seq, "success": true, "body": map[string]any{"breakpoints": []any{}}})
	}
}

// send writes an event to the host side.
func (f *fakeHost) send(event string, body any) {
	_ = writeFrame(f.rw, map[string]any{"seq": 0, "type": "event", "event": event, "body": body})
}

func (f *fakeHost) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for _, m := range f.seen {
		out = append(out, m["command"].(string))
	}
	return out
}

func (f *fakeHost) last(command string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.seen) - 1; i >= 0; i-- {
		if f.seen[i]["command"] == command {
			var args map[string]any
			_ = json.Unmarshal(f.seen[i]["arguments"].(json.RawMessage), &args)
			return args
		}
	}
	return nil
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if rest, ok := strings.CutPrefix(line, "Content-Length:"); ok {
			n, err := strconv.Atoi(strings.TrimSpace(rest))
			if err != nil {
				return nil, err
			}
			length = n
		}
	}
	if length < 0 {
		return nil, io.ErrUnexpectedEOF
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeFrame(w io.Writer, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(w, "Content-Length: "+strconv.Itoa(len(data))+"\r\n\r\n"); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// The breakpoints of a worktree are saved and sent to the sessions running there (#188).
func TestBreakpointsSentToLiveSessions(t *testing.T) {
	var events []map[string]any
	rt := openRuntime(t, &events)
	m := newManager(rt)
	if _, err := m.breakpoints.set("main.go", []Breakpoint{{Line: 12, Condition: "n == 3", Enabled: true}, {Line: 20, Enabled: false}}); err != nil {
		t.Fatal(err)
	}
	host, adapter := net.Pipe()
	f := &fakeHost{rw: adapter}
	go f.serve()
	s := &Session{ID: "s1", Name: "Launch the package", Type: "go", State: stateRunning, mgr: m,
		ready: make(chan struct{})}
	s.client = dap.New(host, host, dap.Options{Event: func(e dap.Event) { m.event(s, e) }}, func() { _ = host.Close() })
	m.list = append(m.list, s)

	if err := m.sendBreakpoints(s); err != nil {
		t.Fatal(err)
	}
	args := f.last("setBreakpoints")
	if args == nil {
		t.Fatalf("no setBreakpoints: %v", f.commands())
	}
	src := args["source"].(map[string]any)
	if src["path"] != filepath.Join(rt.Root, "main.go") {
		t.Fatalf("source: %+v", src)
	}
	list := args["breakpoints"].([]any)
	if len(list) != 1 {
		t.Fatalf("a disabled breakpoint is not sent: %+v", list)
	}
	if bp := list[0].(map[string]any); bp["line"] != float64(12) || bp["condition"] != "n == 3" {
		t.Fatalf("breakpoint: %+v", bp)
	}

	// A stop reaches the windows with where the program stopped.
	f.send("stopped", map[string]any{"reason": "breakpoint", "threadId": 7, "allThreadsStopped": true,
		"stackFrames": []any{map[string]any{"id": 1, "line": 12, "source": map[string]any{"path": filepath.Join(rt.Root, "main.go")}}}})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.view().State == stateStopped {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if s.view().State != stateStopped {
		t.Fatalf("state after the stop: %s", s.view().State)
	}
	var stop map[string]any
	for _, e := range events {
		if e["event"] == "debug.stopped" {
			stop = e["data"].(map[string]any)
		}
	}
	if stop == nil {
		t.Fatalf("no debug.stopped: %v", events)
	}
	if stop["session"] != "s1" || stop["reason"] != "breakpoint" || stop["line"] != 12 ||
		stop["file"] != filepath.Join(rt.Root, "main.go") || stop["thread"] != 7 {
		t.Fatalf("debug.stopped: %+v", stop)
	}
	s.end()
}
