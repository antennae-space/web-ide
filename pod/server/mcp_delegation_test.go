package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/sshx"
)

type mcpTurn struct {
	Chat, Turn, State, Server, Model, Answer, Error, Question string
	TimedOut                                                  bool `json:"timed_out"`
	Truncated                                                 bool
}

func acpMCPClient(t *testing.T, s *Server, ts *httptest.Server, ws *wsClient, project string) (*mcpClient, string) {
	t.Helper()
	ws.call("project.open", map[string]any{"id": project})
	id := ws.call("agents.create", map[string]any{"agent": "claude"})["result"].(map[string]any)["id"].(string)
	ws.waitEvent("agents.changed", func(v map[string]any) bool { return v["id"] == id && v["state"] == "ready" })
	token, err := s.readMCPFile(acpMCPPath(project, id))
	if err != nil {
		t.Fatal(err)
	}
	return &mcpClient{t: t, url: ts.URL, token: string(token)}, id
}

func TestMCPACPDelegation(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is needed by the fake agent")
	}
	bin, _ := filepath.Abs("../../e2e/bin")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	var next, cancelled atomic.Int32
	var longReady atomic.Bool
	var pending sync.WaitGroup
	block := make(chan struct{})
	finishLong := make(chan struct{})
	const longPrompt = "long multi-tool turn"
	const batches, callsPerBatch = 9, 3
	longBatch := func(batch int) []string {
		var calls [][3]string
		for i := range callsPerBatch {
			calls = append(calls, [3]string{fmt.Sprintf("long-%d-%d", batch, i), "read_file", `{"path":"inside.txt"}`})
		}
		return toolCalls(calls...)
	}
	t.Cleanup(pending.Wait)
	requests := make(chan map[string]any, 64)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			writeJSON(w, map[string]any{"data": []map[string]any{
				{"id": "cheap", "capabilities": map[string]bool{"function_calling": true}},
				{"id": "approved"}, {"id": "unapproved"},
			}})
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		dropNotes(req)
		requests <- req
		var answer []string
		msg := lastMessage(req)
		switch msg["content"] {
		case "block":
			next.Add(1)
			select {
			case <-r.Context().Done():
				cancelled.Add(1)
				return
			case <-block:
				return
			}
		case "question":
			answer = toolCalls([3]string{"q", "ask_user", `{"questions":[{"question":"Which color?"}]}`})
		case "inspect":
			answer = toolCalls(
				[3]string{"r", "read_file", `{"path":"inside.txt"}`},
				[3]string{"x", "read_file", `{"path":"../outside.txt"}`},
				[3]string{"l", "read_file", `{"path":"via-link.txt"}`},
				[3]string{"b", "bash", `{"command":"touch forbidden.txt"}`},
				[3]string{"w", "write_file", `{"path":"forbidden.txt","content":"x"}`},
				[3]string{"a", "spawn_agent", `{"task":"nested"}`},
				[3]string{"c", "agent_stop", `{"id":"nested"}`})
		case longPrompt:
			answer = longBatch(0)
		case "fail":
			http.Error(w, "fixture model error", http.StatusBadGateway)
			return
		default:
			var batch, index int
			switch id, _ := msg["tool_call_id"].(string); {
			case id == "c":
				answer = text(strings.Repeat("été", 2100))
			case strings.HasPrefix(id, "long-"):
				if _, err := fmt.Sscanf(id, "long-%d-%d", &batch, &index); err != nil {
					http.Error(w, "unexpected fixture tool call", http.StatusBadRequest)
					return
				}
				if batch+1 < batches {
					answer = longBatch(batch + 1)
					break
				}
				longReady.Store(true)
				select {
				case <-finishLong:
					answer = text("Long turn completed")
				case <-r.Context().Done():
					return
				case <-block:
					return
				}
			default:
				answer = text("Result: " + fmt.Sprint(msg["content"]))
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range answer {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer func() { close(block); model.Close() }()

	s, ts := newServerWith(t, func(s *Server) {
		s.Cfg.Addr = "127.0.0.1:4433"
	})
	ws, err := dial(t, ts, s.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.c.CloseNow()
	rootDir, otherDir := t.TempDir(), t.TempDir()
	rootID := ws.call("projects.create", map[string]any{"type": "local", "path": rootDir})["result"].(map[string]any)["id"].(string)
	otherID := ws.call("projects.create", map[string]any{"type": "local", "path": otherDir})["result"].(map[string]any)["id"].(string)
	root, _ := s.Projects.Get(rootID)
	dir := filepath.Join(rootDir, ".ide", "worktrees", "42-example")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	put := func(p, text string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	put(filepath.Join(dir, "inside.txt"), "inside marker")
	put(filepath.Join(dir, "..", "outside.txt"), "outside secret")
	if err := os.Symlink(filepath.Join(dir, "..", "outside.txt"), filepath.Join(dir, "via-link.txt")); err != nil {
		t.Fatal(err)
	}
	child, err := s.Projects.PutWorktree(root, "fixture", dir)
	if err != nil {
		t.Fatal(err)
	}

	owner, session := acpMCPClient(t, s, ts, ws, child.ID)
	sibling, _ := acpMCPClient(t, s, ts, ws, child.ID)
	other, _ := acpMCPClient(t, s, ts, ws, otherID)
	ws.call("project.open", map[string]any{"id": child.ID})
	manual := newMCPClient(t, s, ts.URL, rootID)
	listed := func(m *mcpClient, name string) bool {
		for _, raw := range m.rpc("tools/list", nil)["tools"].([]any) {
			if raw.(map[string]any)["name"] == name {
				return true
			}
		}
		return false
	}
	denied := func(m *mcpClient, name string, args map[string]any, want string) string {
		t.Helper()
		got, failed := m.tool(name, args)
		if !failed || !strings.Contains(got, want) {
			t.Fatalf("%s: %s", name, got)
		}
		return got
	}
	invoke := func(m *mcpClient, name string, args map[string]any) mcpTurn {
		t.Helper()
		raw := m.ok(name, args)
		var turn mcpTurn
		if err := json.Unmarshal([]byte(raw), &turn); err != nil {
			t.Fatalf("%s: %q: %v", name, raw, err)
		}
		return turn
	}
	start := func(message string) mcpTurn {
		t.Helper()
		return invoke(owner, "assistant_start", map[string]any{"cwd": dir, "message": message})
	}
	argsFor := func(turn mcpTurn, ms int) map[string]any {
		return map[string]any{"cwd": dir, "chat": turn.Chat, "turn": turn.Turn, "timeout_ms": ms}
	}
	for _, tool := range []string{"assistant_wait", "assistant_stop"} {
		if !listed(owner, tool) || listed(manual, tool) {
			t.Fatalf("discovery for %s", tool)
		}
		denied(manual, tool, map[string]any{"cwd": dir, "chat": "missing"}, "unavailable")
	}
	bad := map[string]any{"cwd": dir, "message": "fixture"}
	denied(owner, "assistant_start", bad, "Configure a server and model for sub-agents")
	ws.call("project.open", map[string]any{"id": rootID})
	server := "delegate-model"
	settings := llm.Server{ID: server, Name: "Delegation fixture", URL: model.URL, Kind: "llamacpp",
		Models: []llm.ModelConf{{ID: "approved"}}}
	ws.call("llm.server.save", settings)
	ws.call("llm.select", map[string]any{"server": server, "model": "approved"})
	denied(owner, "assistant_start", bad, "Configure a server and model for sub-agents")
	settings.Children = true
	ws.call("llm.server.save", settings)
	ws.call("llm.select", map[string]any{"server": server, "model": "unapproved"})
	denied(owner, "assistant_start", bad, "Configure a server and model for sub-agents")
	ws.call("llm.select", map[string]any{"server": server, "model": "approved"})

	ws.call("project.open", map[string]any{"id": child.ID})
	if got := ws.call("llm.config", nil)["result"].(map[string]any); got["server"] != server || got["model"] != "approved" || got["childServer"] != "" || got["childModel"] != "" {
		t.Fatalf("worktree settings: %v", got)
	}
	implicit := start("approved default selection")
	if implicit.Server != server || implicit.Model != "approved" {
		t.Fatal(implicit)
	}
	if turn := invoke(owner, "assistant_wait", argsFor(implicit, 3000)); turn.State != "completed" || turn.Answer != "Result: approved default selection" {
		t.Fatal(turn)
	}

	ws.call("llm.children", map[string]any{"server": server, "model": ""})
	denied(owner, "assistant_start", bad, "Configure a server and model for sub-agents")
	ws.call("llm.children", map[string]any{"server": server, "model": "missing"})
	denied(owner, "assistant_start", bad, `model "missing" is not available`)
	ws.call("llm.children", map[string]any{"server": server, "model": "cheap"})
	denied(owner, "assistant_start", map[string]any{"cwd": dir, "message": "fixture", "mode": "build"}, "analysis mode")
	denied(owner, "assistant_start", map[string]any{"cwd": dir, "message": strings.Repeat("a", 16385)}, "16 KiB")
	denied(owner, "assistant_start", map[string]any{"cwd": dir, "message": "fixture", "server": server, "model": "unapproved"}, "not configured")
	approved := invoke(owner, "assistant_start", map[string]any{"cwd": dir, "message": "approved selection", "server": server, "model": "approved"})
	if approved.Model != "approved" {
		t.Fatal(approved)
	}
	if turn := invoke(owner, "assistant_wait", argsFor(approved, 3000)); turn.State != "completed" {
		t.Fatal(turn)
	}

	inspect := start("inspect")
	if inspect.Model != "cheap" || inspect.Server != server {
		t.Fatal(inspect)
	}
	got := invoke(owner, "assistant_wait", argsFor(inspect, 3000))
	if got.State != "completed" || !got.Truncated || len(got.Answer) > 8192 {
		t.Fatal("expected bounded completed answer", got.State, got.Truncated, len(got.Answer), got.Error)
	}
	for _, name := range []string{"assistant_read", "assistant_send", "assistant_wait", "assistant_stop"} {
		arg := map[string]any{"cwd": dir, "chat": inspect.Chat, "message": "hello", "session": session, "timeout_ms": 0}
		found := denied(sibling, name, arg, "conversation is unavailable")
		arg["chat"] = "missing"
		if found != denied(sibling, name, arg, "conversation is unavailable") {
			t.Fatalf("%s leaks existence", name)
		}
		arg["chat"] = inspect.Chat
		denied(other, name, arg, "not granted")
		if name == "assistant_read" || name == "assistant_send" {
			denied(manual, name, arg, "conversation is unavailable")
		}
	}
	if got := sibling.ok("assistant_list", map[string]any{"cwd": dir}); got != "No conversation." {
		t.Fatal(got)
	}
	if got := manual.ok("assistant_list", map[string]any{"cwd": dir}); got != "No conversation." {
		t.Fatal(got)
	}
	if got := owner.ok("assistant_list", map[string]any{"cwd": dir}); !strings.Contains(got, inspect.Chat) {
		t.Fatal(got)
	}
	if _, err := os.Stat(filepath.Join(dir, "forbidden.txt")); !os.IsNotExist(err) {
		t.Fatal("forbidden tool changed the worktree", err)
	}
	loc, _, _ := aiOf(s).ChatLoc(child.ID)
	var chat engine.Chat
	raw, err := llmOf(s).GetChat(loc, inspect.Chat)
	if err != nil || json.Unmarshal(raw, &chat) != nil {
		t.Fatal("missing saved transcript", err)
	}
	if len(chat.Messages) != 10 || chat.Delegation.Parent != session || chat.Parent != "" {
		t.Fatalf("transcript size %d or parent does not match", len(chat.Messages))
	}
	const unavailable = "Tool unavailable in this MCP conversation."
	wantTools := map[string]string{"r": "inside marker", "x": "outside the ticket worktree", "l": "regular files or directories", "b": unavailable, "w": unavailable, "a": unavailable, "c": unavailable}
	for _, msg := range chat.Messages {
		if msg.Role != "tool" {
			continue
		}
		want, ok := wantTools[msg.ToolCallID]
		if !ok || !strings.Contains(string(msg.Content), want) {
			t.Fatalf("tool %s: %s", msg.ToolCallID, msg.Content)
		}
		delete(wantTools, msg.ToolCallID)
	}
	if len(wantTools) != 0 {
		t.Fatalf("missing tool results: %v", wantTools)
	}
	var inspectRequests int
	analysisTools := []string{"ask_user", "list_dir", "read_file"}
	for {
		select {
		case req := <-requests:
			if _, capped := req["max_tokens"]; capped {
				t.Fatalf("unexpected implicit output cap: %v", req["max_tokens"])
			}
			defs, _ := req["tools"].([]any)
			var names []string
			for _, def := range defs {
				n := def.(map[string]any)["function"].(map[string]any)["name"].(string)
				if !slices.Contains(analysisTools, n) {
					t.Fatalf("offered tool %s", n)
				}
				names = append(names, n)
			}
			if req["model"] == "cheap" {
				inspectRequests++
				slices.Sort(names)
				if !slices.Equal(names, analysisTools) {
					t.Fatalf("analysis tools offered: %v", names)
				}
			}
		default:
			goto checkedTools
		}
	}
checkedTools:
	if inspectRequests != 2 {
		t.Fatalf("expected two analysis model requests, got %d", inspectRequests)
	}
	question := start("question")
	if got := invoke(owner, "assistant_wait", argsFor(question, 3000)); got.State != "waiting_user" || !strings.Contains(got.Question, "Which color?") {
		t.Fatal(got)
	}
	if got := invoke(owner, "assistant_stop", argsFor(question, 0)); got.State != "cancelled" {
		t.Fatal(got)
	}
	failed := start("fail")
	if got := invoke(owner, "assistant_wait", argsFor(failed, 3000)); got.State != "failed" || !strings.Contains(got.Error, "fixture model error") {
		t.Fatal(got)
	}

	delegated := start(longPrompt)
	waitFor(t, "model reached the last request after all tool batches", longReady.Load)
	if got := invoke(owner, "assistant_wait", argsFor(delegated, 50)); got.State != "running" || !got.TimedOut {
		t.Fatal(got)
	}
	close(finishLong)
	if got := invoke(owner, "assistant_wait", argsFor(delegated, 3000)); got.State != "completed" || got.Answer != "Long turn completed" {
		t.Fatal(got)
	}
	ui, err := dial(t, ts, s.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer ui.c.CloseNow()
	ui.call("project.open", map[string]any{"id": child.ID})
	const uiChat = "long-ui-turn"
	ui.call("assistant.send", map[string]any{"id": uiChat, "text": longPrompt, "mode": "plan", "server": server, "model": "cheap"})
	ui.waitEvent("assistant.update", func(m map[string]any) bool { return m["id"] == uiChat && m["state"] == "idle" })
	for _, id := range []string{uiChat, delegated.Chat} {
		raw, err := llmOf(s).GetChat(loc, id)
		var saved engine.Chat
		if err != nil || json.Unmarshal(raw, &saved) != nil {
			t.Fatalf("missing long turn %s: %v", id, err)
		}
		var tools int
		for _, m := range saved.Messages {
			if m.Role == "tool" && strings.Contains(string(m.Content), "inside marker") {
				tools++
			}
		}
		last := saved.Messages[len(saved.Messages)-1]
		if tools != batches*callsPerBatch || !strings.Contains(string(last.Content), "Long turn completed") || last.Error != "" {
			t.Fatalf("%s: expected %d tool results and a final answer, got %d results and %+v", id, batches*callsPerBatch, tools, last)
		}
	}
	var longRequests int
	for len(requests) > 0 {
		req := <-requests
		msgs := req["messages"].([]any)
		if len(msgs) > 1 && msgs[1].(map[string]any)["content"] == longPrompt {
			if _, capped := req["max_tokens"]; capped {
				t.Fatal("a long turn received an implicit output cap")
			}
			longRequests++
		}
	}
	if longRequests != 2*(batches+1) {
		t.Fatalf("both launch paths should make %d requests, got %d total", batches+1, longRequests)
	}

	active := start("block")
	waitFor(t, "model is busy", func() bool { return next.Load() == 1 })
	denied(owner, "assistant_start", bad, "already has an active")
	denied(owner, "assistant_send", map[string]any{"cwd": dir, "chat": active.Chat, "message": strings.Repeat("x", 16385)}, "16 KiB")
	denied(owner, "assistant_wait", argsFor(active, 20001), "between 0 and 20000")
	if got := invoke(owner, "assistant_wait", argsFor(active, 0)); got.State != "running" || got.TimedOut {
		t.Fatal(got)
	}
	if got := invoke(owner, "assistant_wait", argsFor(active, 50)); got.State != "running" || !got.TimedOut {
		t.Fatal(got)
	}
	if q := invoke(owner, "assistant_send", map[string]any{"cwd": dir, "chat": active.Chat, "message": "queued follow-up"}); q.Turn != active.Turn {
		t.Fatal(q)
	}

	request := func(ctx context.Context, token, name string, args map[string]any) (*http.Response, error) {
		data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/mcp", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+token)
		return (&http.Client{Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
	}
	ctx, disconnect := context.WithCancel(context.Background())
	disconnected := make(chan error, 1)
	go func() {
		resp, err := request(ctx, owner.token, "assistant_wait", argsFor(active, 5000))
		if resp != nil {
			resp.Body.Close()
		}
		disconnected <- err
	}()
	time.AfterFunc(30*time.Millisecond, disconnect)
	if err := <-disconnected; err == nil || cancelled.Load() != 0 {
		t.Fatalf("disconnect affected task or did not cancel wait: %v", err)
	}
	results := make(chan mcpTurn, 4)
	for range 2 {
		pending.Add(1)
		go func() {
			defer pending.Done()
			results <- invoke(&mcpClient{t: t, url: ts.URL, token: owner.token}, "assistant_wait", argsFor(active, 3000))
		}()
		pending.Add(1)
		go func() {
			defer pending.Done()
			got := invoke(&mcpClient{t: t, url: ts.URL, token: owner.token}, "assistant_stop", argsFor(active, 0))
			if got.State != "stopping" && got.State != "cancelled" {
				t.Errorf("stop: %v", got)
			}
		}()
	}
	for range 2 {
		select {
		case got := <-results:
			if got.State != "cancelled" || got.TimedOut {
				t.Fatal(got)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("wait did not return")
		}
	}
	pending.Wait()
	waitFor(t, "model HTTP request cancelled", func() bool { return cancelled.Load() == 1 })
	if got := owner.ok("assistant_read", map[string]any{"cwd": dir, "chat": active.Chat, "tools": true}); !strings.Contains(got, "block") || strings.Contains(got, "queued follow-up") {
		t.Fatal(got)
	}

	follow := invoke(owner, "assistant_send", map[string]any{"cwd": dir, "chat": active.Chat, "message": "new turn"})
	if follow.Turn == active.Turn || follow.Chat != active.Chat {
		t.Fatal(follow)
	}
	denied(owner, "assistant_wait", argsFor(active, 0), "conversation is unavailable")
	reconnected := &mcpClient{t: t, url: ts.URL, token: owner.token}
	if got := invoke(reconnected, "assistant_wait", argsFor(follow, 3000)); got.State != "completed" || got.Answer != "Result: new turn" {
		t.Fatal(got)
	}

	rt, err := s.openRuntime(child.ID, sshx.Creds{})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := aiOf(s).AgentsOf(rt).Get(session)
	if err != nil {
		t.Fatal(err)
	}
	if err := parent.Prompt("crash"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the ACP session reloaded", func() bool {
		info, entries := parent.Thread()
		for _, entry := range entries {
			if info.State == "ready" && entry.Kind == "notice" && strings.Contains(entry.Text, "its session loaded") {
				return true
			}
		}
		return false
	})
	if got := invoke(reconnected, "assistant_wait", argsFor(follow, 0)); got.State != "completed" {
		t.Fatal(got)
	}
	revoked := start("block")
	waitFor(t, "model is busy again", func() bool { return next.Load() == 2 })
	var waited atomic.Bool
	inFlight := make(chan string, 1)
	go func() {
		m := &mcpClient{t: t, url: ts.URL, token: owner.token}
		waited.Store(true)
		got, _ := m.tool("assistant_wait", argsFor(revoked, 5000))
		inFlight <- got
	}()
	waitFor(t, "wait started", waited.Load)
	time.Sleep(50 * time.Millisecond)
	if err := aiOf(s).AgentsOf(rt).Close(session); err != nil {
		t.Fatal(err)
	}
	if got := <-inFlight; !strings.Contains(got, "conversation is unavailable") {
		t.Fatal(got)
	}
	for _, name := range []string{"assistant_read", "assistant_send", "assistant_wait", "assistant_stop"} {
		res, err := request(context.Background(), owner.token, name, argsFor(revoked, 0))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("revoked %s: %d", name, res.StatusCode)
		}
	}
}
