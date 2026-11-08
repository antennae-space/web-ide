package engine

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"antennae.space/ide/pod/assistant"
)

// step is an answer calling one tool, and its result.
func step(id, name, args, status, out string) []*Message {
	call := ToolCall{ID: id, Type: "function"}
	call.Function.Name, call.Function.Arguments = name, args
	return []*Message{
		{Role: "assistant", ToolCalls: []ToolCall{call}},
		{Role: "tool", ToolCallID: id, Name: name, Status: status, Content: assistant.String(out)},
	}
}

func steps(n int, f func(i int) []*Message) []*Message {
	out := []*Message{{Role: "user", Content: assistant.String("go")}}
	for i := 0; i < n; i++ {
		out = append(out, f(i)...)
	}
	return out
}

func TestFindSuspect(t *testing.T) {
	same := func(i int) []*Message {
		return step(fmt.Sprint(i), "read_file", `{"path":"a.go","start_line":1}`, "ok", "package a")
	}
	if FindSuspect(steps(2, same)) != nil {
		t.Fatal("2 repeats are not suspect")
	}
	sp := FindSuspect(steps(3, same))
	if sp == nil || sp.Rule != "repeat" || sp.State != "open" || !strings.Contains(sp.Detail, "read_file 3 times") {
		t.Fatalf("3 repeats: %+v", sp)
	}
	// The same arguments written another way are the same call; another result is progress.
	reordered := steps(3, func(i int) []*Message {
		args := `{"path":"a.go","start_line":1}`
		if i == 1 {
			args = `{"start_line":1, "path":"a.go"}`
		}
		return step(fmt.Sprint(i), "read_file", args, "ok", "package a")
	})
	if sp := FindSuspect(reordered); sp == nil || sp.Rule != "repeat" {
		t.Fatalf("keys in another order: %+v", sp)
	}
	if FindSuspect(steps(3, func(i int) []*Message {
		return step(fmt.Sprint(i), "bash", `{"command":"make"}`, "ok", fmt.Sprintf("built %c", 'a'+i))
	})) != nil {
		t.Fatal("the same call with new results is not suspect")
	}
	// Waiting tools are not repeats.
	if FindSuspect(steps(5, func(i int) []*Message {
		return step(fmt.Sprint(i), "read_console", `{"console_id":"c"}`, "ok", "waiting")
	})) != nil {
		t.Fatal("read_console waits")
	}
	// The same error from different calls, timings apart.
	sp = FindSuspect(steps(3, func(i int) []*Message {
		return step(fmt.Sprint(i), "bash", fmt.Sprintf(`{"command":"go test -run T%d"}`, i), "error", fmt.Sprintf("FAIL a_test.go:12 (0.0%ds)", i))
	}))
	if sp == nil || sp.Rule != "error" {
		t.Fatalf("same error: %+v", sp)
	}
	var reason assistant.Text
	if json.Unmarshal(sp.Reason, &reason) != nil || reason.Key != "The same error {n} times: {what}" || reason.Params["what"] != "bash" {
		t.Fatalf("reason: %s", sp.Reason)
	}
	// An edit undone.
	edit := func(id, old, new string) []*Message {
		args, _ := json.Marshal(map[string]string{"path": "a.go", "old_string": old, "new_string": new})
		return step(id, "edit_file", string(args), "ok", "edited")
	}
	msgs := append(steps(0, nil), edit("e1", "x := 1", "x := 2")...)
	if FindSuspect(msgs) != nil {
		t.Fatal("one edit")
	}
	if sp := FindSuspect(append(msgs, edit("e2", "x := 2", "x := 1")...)); sp == nil || sp.Rule != "revert" {
		t.Fatalf("revert: %+v", sp)
	}
}

func TestSuspectWindow(t *testing.T) {
	same := func(i int) []*Message { return step(fmt.Sprint(i), "list_dir", `{"path":"."}`, "ok", "a.go") }
	msgs := steps(2, same)
	// A message of the user opens a new window.
	msgs = append(msgs, &Message{Role: "user", Content: assistant.String("again")})
	msgs = append(msgs, same(9)...)
	if FindSuspect(msgs) != nil {
		t.Fatal("the window starts after the message of the user")
	}
	// One alert per window: after it, the count starts again.
	msgs = steps(3, same)
	msgs[len(msgs)-1].Suspect = FindSuspect(msgs)
	msgs = append(msgs, same(7)...)
	if FindSuspect(msgs) != nil {
		t.Fatal("a second alert right after the first")
	}
	msgs = append(append(msgs, same(8)...), same(9)...)
	if FindSuspect(msgs) == nil {
		t.Fatal("3 more repeats after the alert")
	}
}
