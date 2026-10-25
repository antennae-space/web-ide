package server

import (
	"encoding/json"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins/builtin"
)

// The kanban tools of the assistant run in the Kanban (#158): kanban_milestone in the assistant,
// any conversation reads and creates milestones; a briefing is linked to the ones it creates
// and may change them, others may not; kanban_create in a briefing links the conversation.
func TestKanbanAssistantTools(t *testing.T) {
	s, ts := newServerWith(t, func(s *Server) { s.Plugins = builtin.Registry(true) })
	a, _ := dial(t, ts, s.Token)
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	call := func(chat, mode, name, args string) (string, int64, error) {
		raw, err := s.callPlugin(t.Context(), id, "kanban.assistantTool", map[string]any{"name": name, "args": json.RawMessage(args),
			"context": map[string]any{"mode": mode, "chat": map[string]any{"id": chat, "title": "Exports"}}})
		if err != nil {
			return "", 0, err
		}
		var out struct {
			Result struct{ Content string }
			Linked int64
		}
		_ = json.Unmarshal(raw, &out)
		return out.Result.Content, out.Linked, nil
	}
	out, _, err := call("b1", "briefing", "kanban_milestone", `{"action":"create","title":"Exports","description":"CSV and JSON"}`)
	if err != nil || !strings.Contains(out, "Milestone 1 created") || !strings.Contains(out, "linked to it") {
		t.Fatalf("create: %v %s", err, out)
	}
	if _, _, err := call("b1", "briefing", "kanban_milestone", `{"action":"story_add","id":1,"text":"As a user, I export my orders"}`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := call("c1", "build", "kanban_milestone", `{"action":"story_add","id":1,"text":"x"}`); err == nil || !strings.Contains(err.Error(), "not linked") {
		t.Fatalf("a conversation changed a milestone it is not linked to: %v", err)
	}
	if out, linked, err := call("c1", "build", "kanban_create", `{"title":"CSV export","milestone":1}`); err != nil || !strings.Contains(out, "#1") || linked != 0 {
		t.Fatalf("ticket in a milestone: %v %s %d", err, out, linked)
	}
	md, _, err := call("c1", "build", "kanban_milestone", `{"action":"get","id":1}`)
	if err != nil || !strings.Contains(md, "As a user, I export my orders") || !strings.Contains(md, "- #1 [New] CSV export") || !strings.Contains(md, "Briefing: Exports (chat b1)") {
		t.Fatalf("get: %v %s", err, md)
	}
	if _, linked, err := call("b2", "briefing", "kanban_create", `{"title":"JSON export"}`); err != nil || linked != 2 {
		t.Fatalf("a briefing is linked to the ticket it creates: %v %d", err, linked)
	}
	if out, _, err := call("c1", "build", "kanban_update", `{"title":"x"}`); err != nil || !strings.Contains(out, "not linked to a ticket") {
		t.Fatalf("a conversation not linked: %v %s", err, out)
	}
}
