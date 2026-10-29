package dap

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAdapter is an adapter speaking DAP on one connection: it answers `launch`, sends
// `initialized` after it, and can be asked to answer `launch` only after `configurationDone`
// (the risk named in the plan: the host must not block on it).
type fakeAdapter struct {
	rw        io.ReadWriter
	mu        sync.Mutex
	got       []string
	late      bool // launch answered after configurationDone
	launchSeq int
	reverse   bool // asks a runInTerminal after configurationDone

	events []Event
	evMu   sync.Mutex
	done   chan struct{}
}

func (f *fakeAdapter) serve() {
	defer f.rw.(interface{ Close() error }).Close()
	br := bufio.NewReader(f.rw)
	seq := 0
	for {
		body, err := read(br)
		if err != nil {
			return
		}
		var m struct {
			Seq       int             `json:"seq"`
			Command   string          `json:"command"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(body, &m); err != nil {
			return
		}
		f.mu.Lock()
		f.got = append(f.got, m.Command)
		f.mu.Unlock()
		switch m.Command {
		case "initialize":
			f.reply(m.Seq, "initialize", map[string]any{"capabilities": map[string]any{"supportsConfigurationDoneRequest": true}})
		case "launch":
			if !f.late {
				f.reply(m.Seq, "launch", map[string]any{})
				f.event("initialized", map[string]any{})
			} else {
				f.launchSeq = m.Seq
			}
		case "configurationDone":
			f.reply(m.Seq, "configurationDone", map[string]any{})
			if f.late {
				f.reply(f.launchSeq, "launch", map[string]any{})
				f.event("initialized", map[string]any{})
			}
			if f.reverse {
				seq++
				_ = write(f.rw, map[string]any{"seq": seq, "type": "request", "command": "runInTerminal",
					"arguments": map[string]any{"kind": "terminal", "args": []string{"go", "run", "."}, "cwd": "/p"}})
			}
		case "setBreakpoints":
			var args struct {
				Source struct {
					Path string `json:"path"`
				} `json:"source"`
				Breakpoints []struct {
					Line int `json:"line"`
				} `json:"breakpoints"`
			}
			_ = json.Unmarshal(m.Arguments, &args)
			list := []any{}
			for _, b := range args.Breakpoints {
				list = append(list, map[string]any{"id": b.Line, "verified": true, "line": b.Line})
			}
			f.reply(m.Seq, "setBreakpoints", map[string]any{"breakpoints": list})
		case "threads":
			f.reply(m.Seq, "threads", map[string]any{"threads": []any{map[string]any{"id": 1, "name": "main"}}})
		case "stackTrace":
			f.reply(m.Seq, "stackTrace", map[string]any{"stackFrames": []any{map[string]any{"id": 10, "name": "main", "line": 12,
				"source": map[string]any{"path": "/p/main.go", "name": "main.go"}}}, "totalFrames": 1})
		case "scopes":
			f.reply(m.Seq, "scopes", map[string]any{"scopes": []any{map[string]any{"name": "Locals", "variablesReference": 20}}})
		case "variables":
			f.reply(m.Seq, "variables", map[string]any{"variables": []any{map[string]any{"name": "n", "value": "3", "type": "int"}}})
		case "disconnect":
			f.reply(m.Seq, "disconnect", map[string]any{})
			return
		default:
			f.reply(m.Seq, m.Command, map[string]any{})
		}
	}
}

func (f *fakeAdapter) reply(requestSeq int, cmd string, body any) {
	_ = write(f.rw, map[string]any{"seq": 0, "type": "response", "command": cmd, "request_seq": requestSeq, "success": true, "body": body})
}

func (f *fakeAdapter) event(name string, body any) {
	f.evMu.Lock()
	f.events = append(f.events, Event{Event: name, Body: json.RawMessage(`{}`)})
	f.evMu.Unlock()
	_ = write(f.rw, map[string]any{"seq": 0, "type": "event", "event": name, "body": body})
}

// order are the commands the adapter got, in order.
func (f *fakeAdapter) order() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.got, " ")
}

// pipe connects a client and a fake adapter over pipes (the stdio transport).
func pipe(t *testing.T, f *fakeAdapter) *Client {
	t.Helper()
	host, adapter := net.Pipe()
	f.rw = adapter
	go f.serve()
	var ev []Event
	_ = ev
	return New(host, host, Options{Event: func(e Event) {
		f.evMu.Lock()
		f.events = append(f.events, e)
		f.evMu.Unlock()
	}}, func() { _ = host.Close() })
}

func ask(t *testing.T, c *Client, cmd string, args any) json.RawMessage {
	t.Helper()
	body, err := c.Request(context.Background(), cmd, args)
	if err != nil {
		t.Fatalf("%s: %v", cmd, err)
	}
	return body
}

// waitEvent waits until the client has seen an event.
func waitEvent(t *testing.T, f *fakeAdapter, name string) Event {
	t.Helper()
	for i := 0; i < 100; i++ {
		f.evMu.Lock()
		for _, e := range f.events {
			if e.Event == name {
				f.evMu.Unlock()
				return e
			}
		}
		f.evMu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no %s event (got %s)", name, f.order())
	return Event{}
}

// The launch sequence: initialize, launch, initialized, setBreakpoints, configurationDone.
func TestLaunchSequence(t *testing.T) {
	f := &fakeAdapter{done: make(chan struct{})}
	c := pipe(t, f)
	ask(t, c, "initialize", map[string]any{"clientID": "web-ide"})
	ch, err := c.Send("launch", map[string]any{"program": "/p"})
	if err != nil {
		t.Fatal(err)
	}
	waitEvent(t, f, "initialized")
	ask(t, c, "setBreakpoints", map[string]any{"source": map[string]any{"path": "/p/main.go"}, "breakpoints": []any{map[string]any{"line": 12}}})
	ask(t, c, "setExceptionBreakpoints", map[string]any{"filters": []any{}})
	ask(t, c, "configurationDone", map[string]any{})
	if res := <-ch; res.Err != nil {
		t.Fatalf("launch: %v", res.Err)
	}
	if got := f.order(); got != "initialize launch setBreakpoints setExceptionBreakpoints configurationDone" {
		t.Fatalf("order: %s", got)
	}
	ask(t, c, "threads", nil)
	ask(t, c, "stackTrace", map[string]any{"threadId": 1})
	ask(t, c, "scopes", map[string]any{"frameId": 10})
	body := ask(t, c, "variables", map[string]any{"variablesReference": 20})
	if !strings.Contains(string(body), `"n"`) {
		t.Fatalf("variables: %s", body)
	}
	c.Close()
}

// An adapter that answers `launch` only after `configurationDone` does not block the host.
func TestLaunchAnsweredLate(t *testing.T) {
	f := &fakeAdapter{late: true}
	c := pipe(t, f)
	ask(t, c, "initialize", nil)
	ch, err := c.Send("launch", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	ask(t, c, "configurationDone", nil) // the adapter sends `initialized` after it
	waitEvent(t, f, "initialized")
	if res := <-ch; res.Err != nil {
		t.Fatalf("launch: %v", res.Err)
	}
	c.Close()
}

// A reverse request (runInTerminal) reaches the host and its answer goes back.
func TestRunInTerminal(t *testing.T) {
	f := &fakeAdapter{reverse: true}
	host, adapter := net.Pipe()
	f.rw = adapter
	go f.serve()
	var got Request
	done := make(chan struct{})
	c := New(host, host, Options{Reverse: func(_ context.Context, req Request) (any, error) {
		got = req
		close(done)
		return map[string]any{"type": "runInTerminalResponse", "processId": 42}, nil
	}}, func() { _ = host.Close() })
	ask(t, c, "initialize", nil)
	ask(t, c, "launch", nil)
	ask(t, c, "configurationDone", nil)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the host was never asked")
	}
	if got.Command != "runInTerminal" {
		t.Fatalf("reverse request: %s", got.Command)
	}
	var args struct {
		Args []string `json:"args"`
		Cwd  string   `json:"cwd"`
	}
	_ = json.Unmarshal(got.Args, &args)
	if strings.Join(args.Args, " ") != "go run ." || args.Cwd != "/p" {
		t.Fatalf("arguments: %s", got.Args)
	}
	c.Close()
}

// The same over a socket (the tcp transport: dlv dap --listen).
func TestClientTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	failed := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			failed <- err
			return
		}
		f := &fakeAdapter{rw: conn}
		f.serve()
	}()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c := New(conn, conn, Options{}, func() { _ = conn.Close() })
	ask(t, c, "initialize", nil)
	ask(t, c, "launch", nil)
	body := ask(t, c, "threads", nil)
	if !strings.Contains(string(body), "main") {
		t.Fatalf("threads: %s", body)
	}
	c.Close()
	select {
	case err := <-failed:
		t.Fatal(err)
	default:
	}
}

// A refused response is an error.
func TestRefused(t *testing.T) {
	host, adapter := net.Pipe()
	go func() {
		br := bufio.NewReader(adapter)
		body, err := read(br)
		if err != nil {
			return
		}
		var m struct {
			Seq int `json:"seq"`
		}
		_ = json.Unmarshal(body, &m)
		_ = write(adapter, map[string]any{"seq": 0, "type": "response", "command": "launch", "request_seq": m.Seq,
			"success": false, "message": "no program"})
		_ = adapter.Close()
	}()
	c := New(host, host, Options{}, func() { _ = host.Close() })
	_, err := c.Request(context.Background(), "launch", nil)
	if err == nil || err.Error() != "no program" {
		t.Fatalf("refused: %v", err)
	}
	for i := 0; i < 100 && !c.Closed(); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if c.Err() == nil {
		t.Fatal("the client knows the connection ended")
	}
}
