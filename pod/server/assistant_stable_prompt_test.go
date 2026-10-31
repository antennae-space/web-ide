package server

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/plugins/ai/llm"
)

// The system prompt and the tools of a conversation stay the same from one request to the
// next, so a server keeps its prompt cache: the ticket linked is read with kanban_get, the
// date and the active file come at the end of the user's message that saw them change (#216).
func TestAssistantSystemPromptStaysTheSame(t *testing.T) {
	var mu sync.Mutex
	markdown := "# Ticket 7\nFirst version."
	s, ts := newServer(t)
	// The Kanban is an external plugin: a fake one answers the ticket.
	s.handlers["kanban.markdown"] = func(context.Context, *Client, json.RawMessage) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		return map[string]any{"id": 7, "branch": "ticket/7-x", "markdown": markdown}, nil
	}
	model := &fakeModel{notes: true}
	mts := model.serve(t)
	if err := llmOf(s).SaveServer(llm.Server{ID: "s1", Kind: "llamacpp", URL: mts.URL}, false); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 30, 23, 59, 0, 0, time.Local)
	engine.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	defer func() { engine.Now = time.Now }()
	a, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	model.answer = func(map[string]any) []string { return text("Ok.") }

	send := func(msg, file string) {
		a.call("assistant.send", map[string]any{"id": "st1", "text": msg, "server": "s1", "model": "m",
			"ticket": map[string]any{"id": 7, "role": "plan"}, "options": map[string]any{"activeFile": file}})
		a.waitUpdate("st1", idle)
	}
	send("First", "a.go")
	mu.Lock()
	markdown = "# Ticket 7\nSecond version, with a note."
	now = now.Add(2 * time.Minute) // past midnight
	mu.Unlock()
	send("Second", "b.go")
	send("Third", "b.go")

	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.requests) != 3 {
		t.Fatalf("%d requests", len(model.requests))
	}
	system := func(k int) string {
		return model.requests[k]["messages"].([]any)[0].(map[string]any)["content"].(string)
	}
	sys := system(0)
	if strings.Contains(sys, "First version") || !strings.Contains(sys, "kanban_get (id 7)") ||
		strings.Contains(sys, "a.go") || strings.Contains(sys, "2026") {
		t.Fatalf("system prompt: %s", sys)
	}
	for k := 1; k < 3; k++ {
		if system(k) != sys {
			t.Fatalf("system prompt of request %d changed:\n%s\n---\n%s", k+1, sys, system(k))
		}
		if !reflect.DeepEqual(model.requests[k]["tools"], model.requests[0]["tools"]) {
			t.Fatalf("tools of request %d changed", k+1)
		}
		prev, cur := model.requests[k-1]["messages"].([]any), model.requests[k]["messages"].([]any)
		if len(cur) <= len(prev) || !reflect.DeepEqual(cur[:len(prev)], prev) {
			t.Fatalf("request %d does not start with request %d", k+1, k)
		}
	}
	for k, want := range []string{
		"First\n\n(Date: Friday, October 30, 2026. Active file in the editor: a.go.)",
		"Second\n\n(Date: Saturday, October 31, 2026. Active file in the editor: b.go.)",
		"Third",
	} {
		if got := lastMessage(model.requests[k])["content"]; got != want {
			t.Fatalf("user message of request %d: %q, want %q", k+1, got, want)
		}
	}
	// The conversation keeps them with the messages, apart from the text typed.
	msgs := a.call("assistant.open", map[string]any{"id": "st1"})["result"].(map[string]any)["chat"].(map[string]any)["messages"].([]any)
	if m := msgs[2].(map[string]any); m["content"] != "Second" || m["activeFile"] != "b.go" || m["date"] != "Saturday, October 31, 2026" {
		t.Fatalf("second message stored: %v", m)
	}
}
