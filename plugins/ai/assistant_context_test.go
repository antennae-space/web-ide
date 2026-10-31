package ai

import (
	"encoding/json"
	"testing"

	"antennae.space/ide/plugins/ai/engine"
	"antennae.space/ide/pod/assistant"
)

// The date and the active file a message carries end its content as the model reads it.
func TestWithContext(t *testing.T) {
	m := &engine.Message{Role: "user", Content: assistant.String("hi\n"), ActiveFile: "a.go"}
	if got := assistant.ContentText(withContext(m)); got != "hi\n\n(Active file in the editor: a.go.)" {
		t.Fatalf("%q", got)
	}
	m.Content = userContent("look", json.RawMessage(`[{"type":"image_url","image_url":{"url":"data:x"}}]`))
	var parts []map[string]any
	if json.Unmarshal(withContext(m), &parts) != nil || len(parts) != 3 || parts[2]["text"] != "(Active file in the editor: a.go.)" {
		t.Fatalf("%v", parts)
	}
	if m.ActiveFile = ""; string(withContext(m)) != string(m.Content) {
		t.Fatal("no note: the content as stored")
	}
}
