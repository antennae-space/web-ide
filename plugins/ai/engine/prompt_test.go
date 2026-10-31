package engine

import (
	"strings"
	"testing"
	"time"

	"antennae.space/ide/pod/assistant"
)

// The date and the active file are noted on a message of the user only when they changed
// since the last message still sent that carried them; a compaction makes them come again.
func TestStamp(t *testing.T) {
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.Local)
	Now = func() time.Time { return now }
	defer func() { Now = time.Now }()
	c := &Chat{Options: &assistant.Options{ActiveFile: "a.go"}}
	add := func() *Message {
		m := &Message{Role: "user", Content: assistant.String("hi")}
		c.AddUser(m)
		c.Messages = append(c.Messages, &Message{Role: "assistant", Content: assistant.String("ok")})
		return m
	}
	if m := add(); m.Date != "Saturday, October 31, 2026" || m.ActiveFile != "a.go" {
		t.Fatalf("first message: %+v", m)
	}
	if m := add(); m.Date != "" || m.ActiveFile != "" {
		t.Fatalf("nothing changed: %+v", m)
	}
	c.Options.ActiveFile = "" // no file open: nothing to tell
	if m := add(); m.Date != "" || m.ActiveFile != "" {
		t.Fatalf("no active file: %+v", m)
	}
	c.Options.ActiveFile = "b.go"
	now = now.Add(24 * time.Hour)
	if m := add(); m.Date != "Sunday, November 1, 2026" || m.ActiveFile != "b.go" || Context(m) != "(Date: Sunday, November 1, 2026. Active file in the editor: b.go.)" {
		t.Fatalf("both changed: %+v %q", m, Context(m))
	}
	for _, m := range c.Messages {
		m.Compacted = true
	}
	if m := add(); m.Date == "" || m.ActiveFile != "b.go" {
		t.Fatalf("after a compaction: %+v", m)
	}
}

// With its tools the model reads the ticket with kanban_get: the system prompt has only the
// instructions of its role.
func TestTicketPrompt(t *testing.T) {
	p := TicketPrompt(7, "dev", "ticket/7-x", 0, 0, "")
	if !strings.Contains(p, "kanban_get (id 7)") || !strings.Contains(p, "ticket/7-x") {
		t.Fatal(p)
	}
	if p := TicketPrompt(7, "dev", "", 0, 0, "# The ticket"); !strings.HasSuffix(p, "# The ticket") || strings.Contains(p, "kanban_get (id") {
		t.Fatal(p)
	}
}
