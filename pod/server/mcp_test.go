package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mcpClient struct {
	t     *testing.T
	url   string
	token string
	n     int
}

func (m *mcpClient) post(body any) (*http.Response, map[string]any) {
	m.t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, m.url+"/mcp", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if m.token != "" {
		req.Header.Set("Authorization", "Bearer "+m.token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		m.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func (m *mcpClient) rpc(method string, params any) map[string]any {
	m.t.Helper()
	m.n++
	_, out := m.post(map[string]any{"jsonrpc": "2.0", "id": m.n, "method": method, "params": params})
	if out["error"] != nil {
		m.t.Fatalf("%s: %v", method, out["error"])
	}
	return out["result"].(map[string]any)
}

// tool calls a tool and returns its text; isError tells whether the tool failed.
func (m *mcpClient) tool(name string, args map[string]any) (string, bool) {
	m.t.Helper()
	r := m.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	return text, r["isError"] == true
}

func (m *mcpClient) ok(name string, args map[string]any) string {
	m.t.Helper()
	text, failed := m.tool(name, args)
	if failed {
		m.t.Fatalf("%s: %s", name, text)
	}
	return text
}

// The MCP of the pod: its token, its handshake, its tools, the project found from the folder of
// the client (the kanban_* tools: the Kanban's, e2e kanban).
func TestMCP(t *testing.T) {
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x", "GIT_CONFIG_GLOBAL": os.DevNull} {
		t.Setenv(k, v)
	}
	s, ts := newServer(t)
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("un\n"), 0o644)
	gitIn(t, dir, "init", "-q", "-b", "main")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "init")
	id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})

	// Without the token, nothing.
	anon := &mcpClient{t: t, url: ts.URL}
	if res, _ := anon.post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	m := &mcpClient{t: t, url: ts.URL, token: "secret-token-0123456789abcdef0123"}
	init := m.rpc("initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test"}})
	if init["protocolVersion"] != "2025-03-26" || !strings.Contains(init["instructions"].(string), "/open?path=") {
		t.Fatalf("initialize: %v", init)
	}
	if res, _ := m.post(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); res.StatusCode != http.StatusAccepted {
		t.Fatalf("notification: %d", res.StatusCode)
	}
	if tools := m.rpc("tools/list", nil)["tools"].([]any); len(tools) != len(mcpTools)+len(s.plugins.tools)+len(s.plugins.mcp) {
		t.Fatalf("tools: %d", len(tools))
	}

	// A folder outside any project is refused; a subfolder of the project selects it.
	if text, failed := m.tool("list_commands", map[string]any{"cwd": t.TempDir()}); !failed || !strings.Contains(text, "no project") {
		t.Fatalf("outside: %s", text)
	}
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	if text := m.ok("list_commands", map[string]any{"cwd": filepath.Join(dir, "sub")}); !strings.Contains(text, "No saved command") {
		t.Fatalf("subfolder: %s", text)
	}
}

func TestOpenLink(t *testing.T) {
	_, ts := newServer(t)
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	dir := t.TempDir()
	file := filepath.Join(dir, "a.go")
	os.WriteFile(file, []byte("package a\n"), 0o644)
	id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	link := ts.URL + "/open?path=" + file + "&line=3"
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	// Without a token: the pairing page.
	if res, _ := noRedirect.Get(link); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", res.StatusCode)
	}
	// No window on the project: the browser goes to the project page.
	req, _ := http.NewRequest(http.MethodGet, link, nil)
	req.Header.Set("Authorization", "Bearer secret-token-0123456789abcdef0123")
	res, _ := noRedirect.Do(req)
	if loc := res.Header.Get("Location"); res.StatusCode != http.StatusFound || !strings.HasPrefix(loc, "/project/"+id+"?open=") {
		t.Fatalf("no window: %d %s", res.StatusCode, loc)
	}
	// A window has it: it is asked to open the file.
	a.call("project.open", map[string]any{"id": id})
	req, _ = http.NewRequest(http.MethodPost, link, nil)
	req.Header.Set("Authorization", "Bearer secret-token-0123456789abcdef0123")
	res, _ = http.DefaultClient.Do(req)
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	if out["opened"] != true {
		t.Fatalf("opened: %v", out)
	}
	a.waitEvent("ide.open", func(d map[string]any) bool { return d["path"] == file && d["line"] == float64(3) })
}

// A project opened through a symbolic link is found from the folder the link leads to.
func TestMCPSymlinkedProject(t *testing.T) {
	_, ts := newServer(t)
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "apps")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	a.call("projects.create", map[string]any{"type": "local", "path": link})
	m := &mcpClient{t: t, url: ts.URL, token: "secret-token-0123456789abcdef0123"}
	if text := m.ok("list_commands", map[string]any{"cwd": real}); !strings.Contains(text, "No saved command") {
		t.Fatalf("list: %s", text)
	}
}

// Without the Kanban, the tools of the linked conversations say what they need (their run
// with the Kanban: e2e kanbanai).
func TestMCPReplyAndAnswer(t *testing.T) {
	_, ts := newServer(t)
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	dir := t.TempDir()
	id := a.call("projects.create", map[string]any{"type": "local", "path": dir})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	m := &mcpClient{t: t, url: ts.URL, token: "secret-token-0123456789abcdef0123"}
	for _, tool := range []string{"kanban_conversation", "kanban_reply", "kanban_answer"} {
		if text, failed := m.tool(tool, map[string]any{"cwd": dir, "id": 1, "chat": "c1", "message": "hi"}); !failed || !strings.Contains(text, "needs the tickets capability") {
			t.Fatalf("%s: %s", tool, text)
		}
	}
}
