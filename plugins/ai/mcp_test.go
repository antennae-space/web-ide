package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
	"antennae.space/ide/pod/assistant"
	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/projects"
)

func TestMCPDevelopmentToolScope(t *testing.T) {
	outside := t.TempDir()
	root := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "missing"), filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{outside, "../outside.txt", "linked/new.txt", "dangling"} {
		if err := checkMCPWorktreePath(root, name); err == nil {
			t.Errorf("development accepted path %q outside its worktree", name)
		}
	}
	if err := checkMCPWorktreePath(root, "src/new.txt"); err != nil {
		t.Fatalf("development cannot create a file in its worktree: %v", err)
	}
	ticket := &engine.TicketLink{ID: 5, Role: "dev"}
	if err := checkMCPDevelopmentTool(nil, ticket, "kanban_get", assistant.Args{"id": json.RawMessage("6")}); err == nil {
		t.Fatal("development accepted a different ticket")
	}
}

func TestMCPConversation(t *testing.T) {
	raw := json.RawMessage(`{"title":"Export","messages":[
		{"role":"user","content":"I need an export","display":"I need an export"},
		{"role":"assistant","content":"","tool_calls":[{"id":"c1","function":{"name":"ask_user","arguments":"{\"questions\":[{\"question\":\"Format?\"}]}"}}]},
		{"role":"tool","tool_call_id":"c1","content":"Format?: CSV"},
		{"role":"assistant","content":[{"type":"text","text":"Noted: CSV."}]},
		{"role":"assistant","content":"","tool_calls":[{"id":"c2","function":{"name":"read_file","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"c2","content":"secret file content"}]}`)
	text := conversationText(raw, 0, false)
	for _, want := range []string{"# Conversation: Export", "## User\nI need an export", "Format?", "## Answers of the user\nFormat?: CSV", "Noted: CSV."} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "secret file content") || strings.Contains(text, "call read_file") {
		t.Error("other tool results are left out")
	}
	// For a review: the last messages, with the calls, their errors and a failed answer.
	raw = json.RawMessage(`{"title":"Dev","messages":[
		{"role":"user","content":"Develop"},
		{"role":"assistant","content":"","tool_calls":[{"id":"b1","function":{"name":"bash","arguments":"{\"command\":\"pkill -x web-ide-pod\"}"}}]},
		{"role":"tool","tool_call_id":"b1","name":"bash","status":"ok","content":"Exit code 0"},
		{"role":"assistant","content":"","tool_calls":[{"id":"b2","function":{"name":"bash","arguments":"{\"command\":\"make\"}"}}]},
		{"role":"tool","tool_call_id":"b2","name":"bash","status":"ok","content":"Interrupted: the pod stopped before this tool ended."},
		{"role":"assistant","content":"","error":"Interrupted: the pod stopped."}]}`)
	text = conversationText(raw, 5, true)
	for _, want := range []string{"(1 earlier messages left out)", "- call bash {\"command\":\"pkill -x web-ide-pod\"}", "→ ok: Interrupted: the pod stopped before", "## The answer failed\nInterrupted: the pod stopped."} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "## User\nDevelop") || strings.Contains(text, "Exit code 0") {
		t.Errorf("earlier messages or plain results kept:\n%s", text)
	}
}

// kanban_develop: the development conversation of a ticket, linked to it and run in its
// worktree, and the tickets it refuses.
func TestMCPDevelop(t *testing.T) {
	s, rootID := newTestA(t, t.TempDir())
	root, _ := s.Projects.Get(rootID)
	wt := t.TempDir()
	if _, err := s.Projects.PutChild(root, 5, "t5", wt); err != nil {
		t.Fatal(err)
	}
	tickets := map[int64]map[string]any{
		5: {"id": 5, "title": "Export", "status": "in_progress", "complexity": "high", "worktree": wt},
		6: {"id": 6, "title": "No worktree", "status": "todo"},
		7: {"id": 7, "title": "Closed", "status": "done", "worktree": wt},
		9: {"id": 9, "title": "Lineage step", "status": "todo", "parent": 5},
		8: {"id": 8, "title": "Busy", "status": "in_progress", "parent": 5, "chatList": []any{map[string]any{"chatId": "busy", "role": "dev"}}},
	}
	var mu sync.Mutex
	var links []map[string]any
	linking := make(chan struct{})
	signalLink := sync.OnceFunc(func() { close(linking) })
	allowLink := make(chan struct{})
	releaseLink := sync.OnceFunc(func() { close(allowLink) })
	defer releaseLink()
	s.pod.(*fakePod).kanban = func(project, method string, params json.RawMessage) (json.RawMessage, error) {
		var a struct {
			ID int64
		}
		if err := json.Unmarshal(params, &a); err != nil {
			return nil, err
		}
		if method == "kanban.chat.link" {
			signalLink()
			<-allowLink
		}
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "kanban.get":
			if tk, ok := tickets[a.ID]; ok {
				return json.Marshal(tk)
			}
			return nil, errors.New("ticket not found")
		case "kanban.chat.link":
			var link map[string]any
			if err := json.Unmarshal(params, &link); err != nil {
				return nil, err
			}
			links = append(links, link)
			tickets[a.ID]["chatList"] = []map[string]any{link}
			return nil, nil
		}
		return nil, errors.New("no " + method + " in this test")
	}
	sc := plugins.MCPScope{Here: root, Root: root, Lang: "fr"}
	call := func(id int64) (string, error) {
		return callMCP(t, s, "kanban_develop", sc, map[string]any{"id": id})
	}

	if _, err := call(5); err == nil || !strings.Contains(err.Error(), "Choose a server and a model") {
		t.Fatalf("no default model: %v", err)
	}
	if err := s.LLM.SaveServer(llm.Server{ID: "srv", Name: "Fake", URL: "http://127.0.0.1:9"}, false); err != nil {
		t.Fatal(err)
	}
	if err := s.LLM.Select("srv", "m1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.developChat(context.Background(), sc, 5, "nope", "x"); err == nil || !strings.Contains(err.Error(), "unknown model server") {
		t.Fatalf("unknown server: %v", err)
	}
	if _, err := call(6); err == nil || !strings.Contains(err.Error(), "call kanban_start first") {
		t.Fatalf("no worktree: %v", err)
	}
	if _, err := call(7); err == nil || !strings.Contains(err.Error(), "To do or In progress") {
		t.Fatalf("closed ticket: %v", err)
	}
	s.assistants.mu.Lock()
	s.assistants.runs["busy"] = &assistantRun{id: "busy"}
	s.assistants.mu.Unlock()
	if _, err := call(8); err == nil || !strings.Contains(err.Error(), "conversation busy of ticket #8 is running") {
		t.Fatalf("a conversation running: %v", err)
	}
	s.assistants.mu.Lock()
	delete(s.assistants.runs, "busy")
	s.assistants.mu.Unlock()

	// The chat built, as the Kanban starts it from a window.
	c, err := s.developChat(context.Background(), sc, 5, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if c.Title != "#5 Développement · Export" || c.Mode != engine.Build || c.Server != "srv" || c.Model != "m1" {
		t.Fatalf("chat: %+v", c)
	}
	if c.Ticket == nil || c.Ticket.ID != 5 || c.Ticket.Role != "dev" || c.Ticket.Project != projects.ChildID(rootID, 5) || c.Ticket.Effort != "xhigh" {
		t.Fatalf("ticket link: %+v", c.Ticket)
	}
	if len(c.Messages) != 1 || c.Messages[0].Display != "Développe le ticket #5 « Export » en suivant son plan." || c.Messages[0].Author != assistant.AuthorClaude {
		t.Fatalf("first message: %+v", c.Messages)
	}

	step, err := s.developChat(context.Background(), sc, 9, "", "custom")
	if err != nil || step.Ticket.Project != c.Ticket.Project || step.Model != "custom" || step.Server != "srv" {
		t.Fatalf("lineage step: %+v, %v", step, err)
	}
	outside := sc
	outside.AllowsProject = func(project, root string) bool { return project == root }
	if _, err := s.developChat(context.Background(), outside, 9, "", ""); err == nil || !strings.Contains(err.Error(), "outside the MCP grant") {
		t.Fatalf("outside worktree grant: %v", err)
	}

	// A concurrent start is refused even before Kanban has the first conversation's link.
	type result struct {
		text string
		err  error
	}
	started := make(chan result, 1)
	go func() {
		text, err := call(5)
		started <- result{text, err}
	}()
	select {
	case <-linking:
	case res := <-started:
		t.Fatalf("development returned before linking: %+v", res)
	case <-time.After(10 * time.Second):
		t.Fatal("development did not reach Kanban")
	}
	competing := make(chan error, 1)
	go func() {
		_, err := call(9)
		competing <- err
	}()
	var duplicate error
	select {
	case duplicate = <-competing:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent start waited on the first conversation's link")
	}
	releaseLink()
	first := <-started
	if first.err != nil {
		t.Fatal(first.err)
	}
	id := regexp.MustCompile(`conversation ([^ .]+)\.`).FindStringSubmatch(first.text)
	if id == nil || !strings.Contains(first.text, "kanban_conversation") {
		t.Fatalf("answer: %s", first.text)
	}
	if duplicate == nil || !strings.Contains(duplicate.Error(), "active development (session "+id[1]) {
		t.Fatalf("concurrent start was not refused: %v", duplicate)
	}
	for end := time.Now().Add(10 * time.Second); s.Running(id[1]); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("the run does not end")
		}
	}
	saved, err := s.loadChat(chatLocOf(root), id[1])
	if err != nil || saved.Ticket == nil || saved.Ticket.Role != "dev" || saved.Title != "#5 Développement · Export" {
		t.Fatalf("saved: %+v %v", saved, err)
	}
	if owner := s.devReserve.take(c.Ticket.Project, "retry"); owner != "" {
		t.Fatalf("reservation held after the turn ended: %s", owner)
	}
	s.devReserve.release(c.Ticket.Project, "retry")
	read, err := callMCP(t, s, "kanban_conversation", sc, map[string]any{"id": 5, "chat": id[1]})
	if err != nil || !strings.Contains(read, c.Messages[0].Display) {
		t.Fatalf("linked conversation: %s, %v", read, err)
	}
	child, _ := s.Projects.Get(c.Ticket.Project)
	owner := plugins.MCPScope{Here: child, Root: root, Ticket: 5, ACPParent: "parent", Identity: "acp:parent",
		AllowsProject: func(here, _ string) bool { return here == child.ID }, RefreshDelegationGrant: func() bool { return true }}
	saved.Delegation = &engine.Delegation{Parent: owner.ACPParent, Turn: "turn", State: "failed"}
	saved.MCPOwner = owner.Identity
	if err := s.saveChat(chatLocOf(root), saved); err != nil {
		t.Fatal(err)
	}
	linked := map[string]any{"id": 5, "chat": saved.ID, "message": "steer", "answers": [][]string{{"yes"}}}
	if _, err := callMCP(t, s, "kanban_conversation", owner, linked); err != nil {
		t.Fatal(err)
	}
	sibling := owner
	sibling.ACPParent, sibling.Identity = "sibling", "acp:sibling"
	revoked := owner
	revoked.RefreshDelegationGrant = func() bool { return false }
	for _, tool := range []string{"kanban_conversation", "kanban_reply", "kanban_answer"} {
		for _, scope := range []plugins.MCPScope{sc, sibling, revoked} {
			if _, err := callMCP(t, s, tool, scope, linked); !errors.Is(err, errMCPConversation) {
				t.Fatalf("%s allowed a foreign credential: %v", tool, err)
			}
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if len(links) == 0 || links[0]["chatId"] != id[1] || links[0]["role"] != "dev" || links[0]["id"] != float64(5) {
		t.Fatalf("links: %v", links)
	}
}
