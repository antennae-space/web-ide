package acp

import (
	"encoding/json"
	"fmt"
	"testing"
)

// opencode sends the paths of its tool calls relative to the working folder.
func TestToolPathsMadeAbsolute(t *testing.T) {
	var th thread
	th.index()
	var w wireToolCall
	_ = json.Unmarshal([]byte(`{"toolCallId":"t1","kind":"edit","locations":[{"path":"notes.txt"},{"path":"/abs/a.go"}],
		"content":[{"type":"diff","path":"sub/b.txt","oldText":"a","newText":"b"}]}`), &w)
	e := th.Entries[th.applyTool(w, "/work")]
	if len(e.Locations) != 2 || e.Locations[0] != "/work/notes.txt" || e.Locations[1] != "/abs/a.go" {
		t.Fatalf("locations: %v", e.Locations)
	}
	if e.Content[0].Path != "/work/sub/b.txt" {
		t.Fatalf("diff path: %s", e.Content[0].Path)
	}
}

// The files of a session: those of its completed edits, absolute, once (the Explorer, #242).
func TestChangedFiles(t *testing.T) {
	var th thread
	th.index()
	apply := func(js string) Entry {
		var w wireToolCall
		_ = json.Unmarshal([]byte(js), &w)
		return th.Entries[th.applyTool(w, "/work")]
	}
	edit := apply(`{"toolCallId":"t1","kind":"edit","status":"in_progress","locations":[{"path":"a.go"}],"content":[{"type":"diff","path":"a.go","oldText":"a","newText":"b"}]}`)
	if got := changedFiles(edit, "/work"); got != nil {
		t.Fatalf("an edit not completed changed nothing yet: %v", got)
	}
	edit = apply(`{"toolCallId":"t1","status":"completed"}`)
	read := apply(`{"toolCallId":"t2","kind":"read","status":"completed","locations":[{"path":"b.go"}]}`)
	moved := apply(`{"toolCallId":"t3","kind":"move","status":"completed","locations":[{"path":"c.go"}]}`)
	s := &Session{}
	for _, e := range []Entry{edit, read, moved, edit} {
		s.addFiles(changedFiles(e, "/work"))
	}
	if fmt.Sprint(s.info.Files) != "[/work/a.go /work/c.go]" {
		t.Fatalf("files: %v", s.info.Files)
	}
}
