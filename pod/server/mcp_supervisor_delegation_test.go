package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"antennae.space/ide/plugins/ai/llm"
)

func TestMCPSupervisorDelegation(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is needed by the fake agent")
	}
	bin, err := filepath.Abs("../../e2e/bin")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	release := make(chan struct{}, 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			writeJSON(w, map[string]any{"data": []map[string]string{{"id": "fixture"}}})
		case "/v1/chat/completions":
			select {
			case <-r.Context().Done():
				return
			case <-release:
			}
			w.Header().Set("Content-Type", "text/event-stream")
			for _, chunk := range text("Delegated fixture answer") {
				fmt.Fprintf(w, "data: %s\n\n", chunk)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(model.Close)
	t.Cleanup(func() { close(release) })
	s, ts := newServer(t)
	ws, err := dial(t, ts, s.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.c.CloseNow()
	create := func(dir string) string {
		t.Helper()
		return ws.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	}
	rootDir, otherDir := t.TempDir(), t.TempDir()
	rootID := create(rootDir)
	create(otherDir)
	root, _ := s.Projects.Get(rootID)
	dir := filepath.Join(rootDir, ".ide", "worktrees", "delegation")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	child, err := s.Projects.PutWorktree(root, "delegation", dir)
	if err != nil {
		t.Fatal(err)
	}
	owner, parent := acpMCPClient(t, s, ts, ws, child.ID)
	sibling, _ := acpMCPClient(t, s, ts, ws, child.ID)
	if err := llmOf(s).SaveServer(llm.Server{ID: "fixture", Name: "Fixture", URL: model.URL, Kind: "llamacpp"}, false); err != nil {
		t.Fatal(err)
	}
	if err := llmOf(s).SetChildDefault("fixture", "fixture"); err != nil {
		t.Fatal(err)
	}

	grants := make(map[string]mcpGrant)
	supervisor := func(name string, projects map[string]bool, assistant bool) *mcpClient {
		token := "fixture-supervisor-0123456789abcdef-" + name
		grants[name] = mcpGrant{TokenSHA256: mcpDigest(token), Profile: mcpSupervisor, Projects: projects, Assistant: assistant}
		return &mcpClient{t: t, url: ts.URL, token: token}
	}
	family := supervisor("family", map[string]bool{rootID: true}, true)
	worktree := supervisor("worktree", map[string]bool{child.ID: false}, true)
	rootOnly := supervisor("root", map[string]bool{rootID: false}, true)
	ungranted := supervisor("ungranted", map[string]bool{rootID: true}, false)
	if err := s.Store.WriteJSON(mcpClients, grants); err != nil {
		t.Fatal(err)
	}

	raw := owner.ok("assistant_start", map[string]any{"cwd": dir, "message": "Delegated fixture prompt"})
	var turn mcpTurn
	if err := json.Unmarshal([]byte(raw), &turn); err != nil || turn.Chat == "" || turn.Turn == "" {
		t.Fatalf("assistant_start: %s (%v)", raw, err)
	}
	list := func(m *mcpClient, cwd string, active bool) string {
		return m.ok("assistant_list", map[string]any{"cwd": cwd, "active": active})
	}
	read := func(m *mcpClient, cwd string) string {
		return m.ok("assistant_read", map[string]any{"cwd": cwd, "chat": turn.Chat})
	}
	contains := func(got string, want ...string) {
		t.Helper()
		for _, part := range want {
			if !strings.Contains(got, part) {
				t.Fatalf("missing %q in %q", part, got)
			}
		}
	}
	denied := func(m *mcpClient, name, cwd, want string) {
		t.Helper()
		got, failed := m.tool(name, map[string]any{"cwd": cwd, "chat": turn.Chat, "turn": turn.Turn, "message": "Supervisor follow-up"})
		if !failed || !strings.Contains(got, want) {
			t.Fatalf("%s: %q", name, got)
		}
	}

	contains(list(family, rootDir, true), turn.Chat, "ACP parent "+parent, "turn "+turn.Turn, "state running")
	contains(read(worktree, dir), "Delegated fixture prompt", "ACP parent "+parent, "turn "+turn.Turn, "state running")
	for _, m := range []*mcpClient{rootOnly, sibling} {
		cwd := dir
		if m == rootOnly {
			cwd = rootDir
		}
		if got := list(m, cwd, false); got != "No conversation." {
			t.Fatalf("out-of-scope list: %q", got)
		}
		denied(m, "assistant_read", cwd, "conversation is unavailable")
	}
	for _, name := range []string{"assistant_list", "assistant_read"} {
		denied(family, name, otherDir, "not granted")
		denied(ungranted, name, dir, "unavailable")
	}
	denied(family, "assistant_send", dir, "conversation is unavailable")
	for _, name := range []string{"assistant_stop", "assistant_wait"} {
		denied(family, name, dir, "conversation is unavailable")
		denied(ungranted, name, dir, "unavailable")
	}
	for _, name := range []string{"kanban_reply", "kanban_answer"} {
		denied(family, name, dir, "unavailable")
	}

	release <- struct{}{}
	raw = owner.ok("assistant_wait", map[string]any{"cwd": dir, "chat": turn.Chat, "turn": turn.Turn, "timeout_ms": 3000})
	contains(raw, `"state":"completed"`, "Delegated fixture answer")
	if got := list(family, rootDir, true); got != "No conversation." {
		t.Fatalf("active list after completion: %q", got)
	}
	contains(list(worktree, dir, false), turn.Chat, "state completed")
	contains(read(family, rootDir), "Delegated fixture answer", "ACP parent "+parent, "turn "+turn.Turn, "state completed")
	denied(family, "assistant_send", rootDir, "conversation is unavailable")

	start := map[string]any{"cwd": dir, "mode": "build", "message": "Supervisor analysis"}
	if got, failed := family.tool("assistant_start", start); !failed || !strings.Contains(got, "analysis mode") {
		t.Fatalf("build: %s", got)
	}
	start["mode"] = "plan"
	start["server"], start["model"] = "fixture", "unapproved"
	if got, failed := family.tool("assistant_start", start); !failed || !strings.Contains(got, "not configured") {
		t.Fatalf("unapproved model: %s", got)
	}
	delete(start, "server")
	delete(start, "model")
	raw = family.ok("assistant_start", start)
	if err := json.Unmarshal([]byte(raw), &turn); err != nil || turn.Chat == "" || turn.Turn == "" || turn.Model != "fixture" {
		t.Fatalf("Supervisor start: %s (%v)", raw, err)
	}
	contains(read(family, dir), "Supervisor analysis", "MCP delegation", "turn "+turn.Turn)
	for _, name := range []string{"assistant_read", "assistant_send", "assistant_wait", "assistant_stop"} {
		denied(owner, name, dir, "conversation is unavailable")
		denied(worktree, name, dir, "conversation is unavailable")
		denied(family, name, rootDir, "conversation is unavailable")
	}
	if got, failed := family.tool("assistant_start", start); !failed || !strings.Contains(got, "already has an active") {
		t.Fatalf("concurrent start: %s", got)
	}
	args := map[string]any{"cwd": dir, "chat": turn.Chat, "turn": turn.Turn, "timeout_ms": 3000}
	family.ok("assistant_stop", args)
	contains(family.ok("assistant_wait", args), `"state":"cancelled"`)
	contains(read(family, dir), "state cancelled")
}
