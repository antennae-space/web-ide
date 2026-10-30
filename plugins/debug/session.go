package debug

// A debug session is one run of a configuration, in the worktree whose runtime started it
// (#188, docs/design/debug.md). The manager is the part of that runtime: the sessions stop with
// the project, not a while after its last window left — a program keeps running while you read
// its stack on your phone.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"path"
	"strings"
	"sync"
	"time"

	"antennae.space/ide/lib/i18n"
	"antennae.space/ide/plugins/debug/internal/dap"
	"antennae.space/ide/pod/execx"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/runtime"
)

// States of a session.
const (
	stateStarting = "starting"
	stateRunning  = "running"
	stateStopped  = "stopped"
	stateEnded    = "ended"
)

// requests are the ways a configuration reaches a program.
var requests = map[string]bool{"launch": true, "attach": true, "listen": true}

// Manager holds the sessions of one worktree.
type Manager struct {
	rt          *runtime.Runtime
	mu          sync.Mutex
	list        []*Session
	breakpoints *breakpointStore
}

// sessionsOf is the debug part of a runtime.
func sessionsOf(rt *runtime.Runtime) *Manager {
	return rt.Part("debug", func() any { return newManager(rt) }).(*Manager)
}

func newManager(rt *runtime.Runtime) *Manager {
	return &Manager{rt: rt, breakpoints: newBreakpoints(rt)}
}

// Stop ends the sessions, with the project or with the pod.
func (m *Manager) Stop(bool) {
	m.mu.Lock()
	list := append([]*Session{}, m.list...)
	m.mu.Unlock()
	for _, s := range list {
		s.end()
	}
}

// views are the sessions of the worktree, the oldest first.
func (m *Manager) views() []Session {
	m.mu.Lock()
	list := append([]*Session{}, m.list...)
	m.mu.Unlock()
	out := make([]Session, 0, len(list))
	for _, s := range list {
		out = append(out, s.view())
	}
	return out
}

// liveSessions are the sessions still running or paused (where a breakpoint goes now).
func (m *Manager) liveSessions() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*Session
	for _, s := range m.list {
		if s.view().State != stateEnded {
			out = append(out, s)
		}
	}
	return out
}

// get is a session by id.
func (m *Manager) get(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.list {
		if s.ID == id {
			return s, nil
		}
	}
	return nil, i18n.Errorf("no debug session %s", id)
}

// drop takes a session out of the list.
func (m *Manager) drop(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.list[:0]
	for _, x := range m.list {
		if x != s {
			out = append(out, x)
		}
	}
	m.list = out
}

// Session is one run of a configuration.
type Session struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Type    string         `json:"type"`
	Pack    string         `json:"pack"`
	Request string         `json:"request"`
	State   string         `json:"state"`
	Config  map[string]any `json:"config"`
	// Thread is the thread the last stop reported: what the steps act on.
	Thread int `json:"thread,omitempty"`
	// Where the program stopped, for the editor.
	File string `json:"file,omitempty"`
	Line int    `json:"line,omitempty"`

	mgr    *Manager
	client *dap.Client
	proc   execx.Process
	mu     sync.Mutex
	closed bool
	// ready is closed when the adapter has sent its `initialized` event.
	ready chan struct{}
}

// view is what the windows see of a session.
func (s *Session) view() Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Session{ID: s.ID, Name: s.Name, Type: s.Type, Pack: s.Pack, Request: s.Request,
		State: s.State, Config: s.Config, Thread: s.Thread, File: s.File, Line: s.Line}
}

func (s *Session) setState(state string) {
	s.mu.Lock()
	s.State = state
	s.mu.Unlock()
	s.mgr.rt.Emit("debug.session", s.view())
}

// startSession runs a configuration: the adapter of its type, the launch or attach request, then
// the breakpoints of the worktree, then configurationDone.
func (m *Manager) startSession(cfg Config, file string) (*Session, error) {
	if cfg.Request == "listen" {
		return nil, i18n.New("listening for debug connections comes with PHP (#192)")
	}
	if !requests[cfg.Request] {
		return nil, i18n.Errorf("%s is not a debug request (launch or attach)", cfg.Request)
	}
	pack, d, err := debuggerOf(m.rt, cfg.Type)
	if err != nil {
		return nil, err
	}
	// The variables of the configuration: ${workspaceFolder} is the worktree of the session,
	// ${file} the active file.
	vars := map[string]string{"workspaceFolder": m.rt.Root}
	if file != "" {
		vars["file"] = abs(m.rt, file)
		vars["fileDirname"] = path.Dir(vars["file"])
	}
	fields := map[string]any{}
	for k, v := range cfg.Fields {
		if k == "name" || k == "type" || k == "request" {
			continue
		}
		fields[k] = substitute(v, vars)
	}

	// The adapter: its command, built by the core on its grant debugger:<type>, not confined.
	argv, err := pod.DebuggerCommand(m.rt, pack, d)
	if err != nil {
		return nil, err
	}
	port := 0
	if d.Transport == "tcp" {
		if port, err = freePort(m.rt); err != nil {
			return nil, err
		}
		argv = fillPort(argv, port)
	}
	proc, err := m.rt.Runner.Start(argv, m.rt.Root)
	if err != nil {
		return nil, i18n.Errorf("%s could not start: %w", d.Argv[0], err)
	}

	s := &Session{ID: newID(), Name: cfg.Name, Type: cfg.Type, Pack: pack, Request: cfg.Request,
		State: stateStarting, Config: fields, mgr: m, ready: make(chan struct{}), proc: proc}
	if d.Transport == "tcp" {
		// The adapter speaks DAP on the port: what it prints is its error output.
		go followOutput(proc.Stdout(), func(text string) {
			m.rt.Emit("debug.output", map[string]any{"session": s.ID, "category": "stderr", "output": text})
		})
	}
	c, err := adapterConn(m.rt, d, port, proc)
	if err != nil {
		_ = proc.Kill()
		return nil, err
	}
	s.client = dap.New(c.reader, c.writer, dap.Options{
		Event:   func(e dap.Event) { m.event(s, e) },
		Reverse: func(ctx context.Context, req dap.Request) (any, error) { return m.reverse(s, req) },
	}, func() {
		_ = c.close()
		_ = proc.Kill()
	})

	if _, err := s.dapRequest(15, "initialize", map[string]any{
		"clientID": "web-ide", "clientName": "Web IDE", "adapterID": cfg.Type,
		"pathFormat": "path", "linesStartAt1": true, "columnsStartAt1": true,
		"supportsVariableType": true, "supportsRunInTerminalRequest": true,
	}); err != nil {
		s.end()
		return nil, err
	}
	m.mu.Lock()
	m.list = append(m.list, s)
	m.mu.Unlock()

	// The launch request is not waited for: an adapter may answer it only after
	// configurationDone. The host waits for the `initialized` event instead.
	ch, err := s.client.Send(cfg.Request, fields)
	if err != nil {
		s.end()
		return nil, err
	}
	go func() {
		if res := <-ch; res.Err != nil {
			s.fail(res.Err.Error())
		}
	}()
	select {
	case <-s.ready:
	case <-time.After(20 * time.Second):
		s.end()
		return nil, i18n.New("the adapter never said it was ready")
	}
	if s.view().State == stateEnded {
		return nil, i18n.New("the adapter refused the configuration")
	}
	if err := m.sendBreakpoints(s); err != nil {
		s.end()
		return nil, err
	}
	if _, err := s.dapRequest(10, "setExceptionBreakpoints", map[string]any{"filters": []string{}}); err != nil {
		s.end()
		return nil, err
	}
	if _, err := s.dapRequest(10, "configurationDone", map[string]any{}); err != nil {
		s.end()
		return nil, err
	}
	s.setState(stateRunning)
	return s, nil
}

// dapRequest is a request of the session, with its deadline.
func (s *Session) dapRequest(seconds int, command string, args any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	if s.client == nil {
		return nil, i18n.New("the debug session ended")
	}
	return s.client.Request(ctx, command, args)
}

// sendBreakpoints sends the stored breakpoints of the worktree to one session, file by file.
func (m *Manager) sendBreakpoints(s *Session) error {
	for file, list := range m.breakpoints.all() {
		if _, err := m.sendBreakpointsFor(s, file, list); err != nil {
			return err
		}
	}
	return nil
}

// sendBreakpointsFor sends one file's breakpoints to a session and answers what the adapter kept.
func (m *Manager) sendBreakpointsFor(s *Session, file string, list []Breakpoint) ([]map[string]any, error) {
	enabled := []Breakpoint{}
	for _, b := range list {
		if b.Enabled {
			enabled = append(enabled, b)
		}
	}
	body, err := s.dapRequest(10, "setBreakpoints", map[string]any{
		"source":         map[string]any{"name": path.Base(file), "path": abs(m.rt, file)},
		"sourceModified": false,
		"breakpoints":    dapBreakpoints(enabled),
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Breakpoints []map[string]any `json:"breakpoints"`
	}
	_ = json.Unmarshal(body, &res)
	return res.Breakpoints, nil
}

// dapBreakpoints are the breakpoints as DAP takes them.
func dapBreakpoints(list []Breakpoint) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, b := range list {
		m := map[string]any{"line": b.Line}
		if b.Condition != "" {
			m["condition"] = b.Condition
		}
		if b.HitCondition != "" {
			m["hitCondition"] = b.HitCondition
		}
		if b.LogMessage != "" {
			m["logMessage"] = b.LogMessage
		}
		out = append(out, m)
	}
	return out
}

// event handles an event of the adapter: the stop, the output, the end of the program.
func (m *Manager) event(s *Session, e dap.Event) {
	var body map[string]any
	_ = json.Unmarshal(e.Body, &body)
	if body == nil {
		body = map[string]any{}
	}
	str := func(k string) string {
		if v, ok := body[k].(string); ok {
			return v
		}
		return ""
	}
	num := func(k string) int {
		if v, ok := body[k].(float64); ok {
			return int(v)
		}
		return 0
	}
	switch e.Event {
	case "initialized":
		select {
		case <-s.ready:
		default:
			close(s.ready)
		}
	case "stopped":
		file, line := stopPlace(body)
		thread := num("threadId")
		s.mu.Lock()
		s.State = stateStopped
		s.Thread = thread
		s.mu.Unlock()
		// The place of the stop comes with the event for some adapters; dlv only names the
		// thread: the host reads its top frame. The reader waits for no answer, so the request
		// runs on its own.
		go m.announceStop(s, thread, str("reason"), body["allThreadsStopped"], file, line)
	case "continued", "resumed":
		s.mu.Lock()
		if s.State == stateStopped {
			s.State = stateRunning
		}
		s.mu.Unlock()
		m.rt.Emit("debug.session", s.view())
	case "output":
		m.rt.Emit("debug.output", map[string]any{"session": s.ID, "category": str("category"), "output": str("output")})
	case "breakpoint", "breakpoints":
		m.rt.Emit("debug.breakpoint", map[string]any{"session": s.ID, "body": e.Body})
	case "thread":
		if reason := str("reason"); reason == "started" || reason == "exited" {
			m.rt.Emit("debug.thread", map[string]any{"session": s.ID, "reason": reason,
				"threadId": num("threadId"), "name": str("name")})
		}
	case "terminated", "processExited":
		go s.end()
	default:
		m.rt.Emit("debug.event", map[string]any{"session": s.ID, "event": e.Event, "body": e.Body})
	}
}

// announceStop tells the windows where the program stopped: the place the event carried, or the
// top frame of the thread when the adapter did not send it.
func (m *Manager) announceStop(s *Session, thread int, reason string, allThreads any, file string, line int) {
	if file == "" {
		raw, err := s.request(10, "stackTrace", map[string]any{"threadId": thread, "startFrame": 0, "levels": 1})
		if err == nil {
			var out struct {
				StackFrames []struct {
					Line   int `json:"line"`
					Source struct {
						Path string `json:"path"`
					} `json:"source"`
				} `json:"stackFrames"`
			}
			if json.Unmarshal(raw, &out) == nil && len(out.StackFrames) > 0 {
				file, line = out.StackFrames[0].Source.Path, out.StackFrames[0].Line
			}
		}
	}
	s.mu.Lock()
	if s.State == stateStopped {
		s.File, s.Line = file, line
	}
	s.mu.Unlock()
	m.rt.Emit("debug.stopped", map[string]any{"session": s.ID, "thread": thread, "reason": reason,
		"file": file, "line": line, "allThreadsStopped": allThreads})
}

// stopPlace is where a stop happened: the source and line of the top frame when the event
// carries them.
func stopPlace(body map[string]any) (string, int) {
	if frames, ok := body["stackFrames"].([]any); ok && len(frames) > 0 {
		if f, ok := frames[0].(map[string]any); ok {
			line, _ := f["line"].(float64)
			if src, ok := f["source"].(map[string]any); ok {
				if p, ok := src["path"].(string); ok {
					return p, int(line)
				}
			}
		}
	}
	line, _ := body["line"].(float64)
	return "", int(line)
}

// reverse answers a request the adapter sends to the host.
func (m *Manager) reverse(s *Session, req dap.Request) (any, error) {
	switch req.Command {
	case "runInTerminal":
		var args struct {
			Kind  string            `json:"kind"`
			Args  []string          `json:"args"`
			Cwd   string            `json:"cwd"`
			Title string            `json:"title"`
			Env   map[string]string `json:"env"`
		}
		if err := json.Unmarshal(req.Args, &args); err != nil {
			return nil, err
		}
		if len(args.Args) == 0 {
			return nil, i18n.New("runInTerminal has no command")
		}
		cwd := args.Cwd
		if cwd == "" {
			cwd = m.rt.Root
		}
		title := args.Title
		if title == "" {
			title = strings.Join(args.Args, " ")
		}
		info, err := m.rt.Consoles.Create("terminal", title, args.Args, cwd, 100, 30)
		if err != nil {
			return nil, err
		}
		m.rt.Emit("console.created", info)
		return map[string]any{"type": "runInTerminalResponse", "processId": 0, "shellProcessId": 0}, nil
	case "startDebugging":
		return nil, i18n.New("an adapter starting a debug session comes with JavaScript (#191)")
	default:
		return nil, i18n.Errorf("the host does not answer %s", req.Command)
	}
}

// fail ends a session on the adapter's error, telling the windows.
func (s *Session) fail(reason string) {
	s.mu.Lock()
	already := s.closed
	s.mu.Unlock()
	if !already {
		s.end()
	}
	s.mgr.rt.Emit("debug.error", map[string]any{"session": s.ID, "error": reason})
}

// end closes a session and tells the windows.
func (s *Session) end() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.State = stateEnded
	client, proc := s.client, s.proc
	s.mu.Unlock()
	if client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _ = client.Request(ctx, "disconnect", map[string]any{})
		cancel()
		client.Close()
	}
	if proc != nil {
		_ = proc.Kill()
	}
	s.mgr.drop(s)
	s.mgr.rt.Emit("debug.session", s.view())
}

// request runs a DAP request on a live session.
func (s *Session) request(seconds int, command string, args any) (json.RawMessage, error) {
	if s.view().State == stateEnded {
		return nil, i18n.New("the debug session ended")
	}
	return s.dapRequest(seconds, command, args)
}

// debuggerOf is the adapter of a type, among the debuggers of the packs the project uses.
func debuggerOf(rt *runtime.Runtime, dtype string) (string, plugins.Debugger, error) {
	for _, d := range pod.PackDebuggers(rt) {
		if d.Debugger.Type == dtype {
			return d.Pack, d.Debugger, nil
		}
	}
	return "", plugins.Debugger{}, i18n.Errorf("no pack gives a debugger for %s", dtype)
}

// abs is the absolute path of a project path on the machine the session runs on.
func abs(rt *runtime.Runtime, p string) string {
	if p == "" {
		return rt.Root
	}
	if abs, err := rt.Abs(p); err == nil && abs != "" {
		return abs
	}
	return p
}

// fillPort replaces {port} in an adapter's arguments.
func fillPort(argv []string, port int) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = strings.ReplaceAll(a, "{port}", fmt.Sprint(port))
	}
	return out
}

// conn is the connection to an adapter: its pipes (stdio) or a socket (tcp).
type conn struct {
	reader interface{ Read([]byte) (int, error) }
	writer interface{ Write([]byte) (int, error) }
	closer func() error
}

func (c conn) close() error {
	if c.closer != nil {
		return c.closer()
	}
	return nil
}

// adapterConn reaches the adapter: over its pipes, or on the port it listens on (retrying until
// the process has opened it).
func adapterConn(rt *runtime.Runtime, d plugins.Debugger, port int, proc execx.Process) (conn, error) {
	if d.Transport != "tcp" {
		return conn{reader: proc.Stdout(), writer: proc.Stdin(), closer: func() error { return proc.Kill() }}, nil
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(10 * time.Second)
	for {
		var c net.Conn
		var err error
		if rt.Local {
			c, err = net.Dial("tcp", addr)
		} else {
			var ctx context.Context
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			c, err = rt.Dial(ctx, addr)
			cancel()
		}
		if err == nil {
			return conn{reader: c, writer: c, closer: func() error { return c.Close() }}, nil
		}
		if time.Now().After(deadline) {
			return conn{}, i18n.Errorf("the adapter never listened on %s: %w", addr, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// freePort is a port this machine is not listening on (a random one over SSH, where the adapter
// listens on the host).
func freePort(rt *runtime.Runtime) (int, error) {
	if rt.Local {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, err
		}
		defer l.Close()
		return l.Addr().(*net.TCPAddr).Port, nil
	}
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return 20000 + int(b[0])<<8 | int(b[1]), nil
}

// followOutput reads what an adapter prints and hands each chunk to the windows.
func followOutput(r io.Reader, emit func(string)) {
	buf := make([]byte, 8<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			emit(string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}

// newID is the id of a session.
func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
