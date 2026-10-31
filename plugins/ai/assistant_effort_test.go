package ai

import (
	"encoding/json"
	"strings"
	"testing"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
)

func TestEffortFor(t *testing.T) {
	user := &engine.Message{Role: "user"}
	answer := &engine.Message{Role: "assistant"}
	tool := func(name, status string) *engine.Message {
		return &engine.Message{Role: "tool", Name: name, Status: status}
	}
	set := func(level string) *engine.Message {
		return &engine.Message{Role: "tool", Name: "set_effort", Status: "ok", Effort: level}
	}
	dyn, withTool := assistant.Options{}, assistant.Options{Effort: "auto", EffortTool: true}
	cases := []struct {
		name string
		o    assistant.Options
		msgs []*engine.Message
		want string
	}{
		{"a message of the user", dyn, []*engine.Message{user}, "xhigh"},
		{"tool results", dyn, []*engine.Message{user, answer, tool("read_file", "ok"), tool("bash", "ok")}, "medium"},
		{"a failed call", dyn, []*engine.Message{user, answer, tool("read_file", "ok"), tool("bash", "error")}, "xhigh"},
		{"a refused change", dyn, []*engine.Message{user, answer, tool("edit_file", "denied")}, "xhigh"},
		{"mechanical calls", dyn, []*engine.Message{user, answer, tool("edit_file", "ok"), tool("write_file", "ok")}, "low"},
		{"an edit and a command", dyn, []*engine.Message{user, answer, tool("edit_file", "ok"), tool("bash", "ok")}, "medium"},
		{"only the last step counts", dyn, []*engine.Message{user, answer, tool("bash", "error"), answer, tool("read_file", "ok")}, "medium"},
		{"a summary is no message of the user", dyn, []*engine.Message{user, answer, {Role: "user", Kind: "summary"}, answer, tool("edit_file", "ok")}, "low"},
		{"fixed by the user", assistant.Options{Effort: "low"}, []*engine.Message{user}, "low"},
		{"chosen by the model", withTool, []*engine.Message{user, answer, set("low"), answer, tool("bash", "error")}, "low"},
		{"the model's choice ends with the user", withTool, []*engine.Message{set("low"), user}, "xhigh"},
		{"set_effort ignored when turned off", dyn, []*engine.Message{user, answer, set("low"), tool("read_file", "ok")}, "medium"},
	}
	for _, c := range cases {
		if got := effortFor(&engine.Chat{Messages: c.msgs}, c.o); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	// A session of a ticket keeps the effort of its complexity, the dynamic one included.
	low := &engine.Chat{Messages: []*engine.Message{user}, Ticket: &engine.TicketLink{ID: 1, Role: "dev", Effort: "low"}}
	if got := effortFor(low, dyn); got != "low" {
		t.Fatalf("effort of a low ticket: %s", got)
	}
	auto := &engine.Chat{Messages: []*engine.Message{user, answer, tool("read_file", "ok")}, Ticket: &engine.TicketLink{ID: 1, Role: "dev", Effort: "auto"}}
	if got := effortFor(auto, assistant.Options{Effort: "low"}); got != "medium" {
		t.Fatalf("dynamic effort of a medium ticket: %s", got)
	}
}

// A local model keeps the first effort of the conversation; a change is a note after the last
// message sent, a system turn or text appended to it (#217).
func TestLocalEffort(t *testing.T) {
	c := &engine.Chat{Messages: []*engine.Message{{Role: "user", Content: assistant.String("go")}}}
	if got := localEffort(c, "qwen", "xhigh", false); got != "xhigh" || c.Effort != "xhigh" || c.Messages[0].EffortNote != nil {
		t.Fatalf("first effort: %s %+v", got, c.Messages[0])
	}
	c.Messages = append(c.Messages, &engine.Message{Role: "assistant"}, &engine.Message{Role: "tool", Content: assistant.String("un")})
	if got := localEffort(c, "qwen", "medium", false); got != "xhigh" || c.Messages[2].EffortNote == nil || c.Messages[2].EffortNote.Level != "medium" {
		t.Fatalf("a change: %s %+v", got, c.Messages[2])
	}
	// The same effort again: no new note.
	c.Messages = append(c.Messages, &engine.Message{Role: "assistant"}, &engine.Message{Role: "tool", Content: assistant.String("deux")})
	if localEffort(c, "qwen", "medium", false); c.Messages[4].EffortNote != nil {
		t.Fatal("note for the effort in force")
	}
	// A failed answer set aside is not a carrier.
	c.Messages = append(c.Messages, &engine.Message{Role: "assistant", Error: "boom"})
	localEffort(c, "qwen", "xhigh", false)
	if n := c.Messages[4].EffortNote; n == nil || n.Text != genericEffort["xhigh"] {
		t.Fatalf("carrier: %+v", c.Messages[4])
	}
	out := apiMessages("sys", c.Messages, false)
	if text := assistant.ContentText(out[5].Content); text != "deux\n\n"+genericEffort["xhigh"] {
		t.Fatalf("appended: %q", text)
	}

	// DeepSeek: a system turn after the message, its trained line.
	d := &engine.Chat{Effort: "xhigh", Messages: []*engine.Message{{Role: "user", Content: assistant.String("go")}, {Role: "assistant"}, {Role: "tool", Content: assistant.String("un")}}}
	localEffort(d, "DeepSeek-V4.1", "low", true)
	out = apiMessages("sys", d.Messages, false)
	if len(out) != 5 || out[4].Role != "system" || !strings.HasPrefix(assistant.ContentText(out[4].Content), "Reasoning Effort: 50 (range 1-100") || assistant.ContentText(out[3].Content) != "un" {
		t.Fatalf("system turn: %+v", out)
	}
}

// The effort note comes after the date and the active file of a message of the user.
func TestEffortNoteAfterContext(t *testing.T) {
	m := &engine.Message{Role: "user", Content: assistant.String("go"), ActiveFile: "a.go",
		EffortNote: &engine.EffortNote{Level: "low", Text: genericEffort["low"]}}
	out := apiMessages("sys", []*engine.Message{m}, false)
	if got := assistant.ContentText(out[1].Content); got != "go\n\n(Active file in the editor: a.go.)\n\n"+genericEffort["low"] {
		t.Fatalf("%q", got)
	}
}

func TestAppendTextToParts(t *testing.T) {
	parts := json.RawMessage(`[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:x"}}]`)
	var got []map[string]any
	if json.Unmarshal(appendText(parts, "note"), &got) != nil || len(got) != 3 || got[2]["text"] != "note" {
		t.Fatalf("%v", got)
	}
}
