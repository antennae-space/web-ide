package server

import (
	"testing"
)

// Each desk is a session of its own: a change on desk 2 reaches the windows of desk 2 only,
// and the desk list reaches every window of the project.
func TestDesks(t *testing.T) {
	_, ts := newServer(t)
	a, err := dial(t, ts, "secret-token-0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	c, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	p := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)
	id := p["id"].(string)

	open := a.call("project.open", map[string]any{"id": id, "desk": 2})["result"].(map[string]any)
	if open["desk"] != float64(1) {
		t.Fatalf("a desk not created opens desk 1: %v", open["desk"])
	}
	a.call("session.update", map[string]any{"session": map[string]any{"layout": "one"}})

	b.call("project.open", map[string]any{"id": id})
	list := map[string]any{"desks": []any{map[string]any{"n": 1}, map[string]any{"n": 2, "name": "Review"}}, "recent": []string{"/x"}}
	b.call("desks.update", map[string]any{"desks": list})
	ev := a.waitEvent("desks.changed", nil)
	if ds := ev["desks"].([]any); len(ds) != 2 || ds[1].(map[string]any)["name"] != "Review" {
		t.Fatalf("desks.changed = %v", ev)
	}

	r := b.call("desk.switch", map[string]any{"desk": 2})["result"].(map[string]any)
	if r["desk"] != float64(2) || r["session"] != nil {
		t.Fatalf("desk 2 starts empty: %v", r)
	}
	c.call("project.open", map[string]any{"id": id, "desk": 2})
	b.call("session.update", map[string]any{"session": map[string]any{"layout": "two"}})
	ev = c.waitEvent("session.changed", nil)
	if ev["desk"] != float64(2) || ev["session"].(map[string]any)["layout"] != "two" {
		t.Fatalf("session.changed on desk 2 = %v", ev)
	}

	// The desk last used, on any device: a desk that does not exist is not recorded.
	c.call("desks.used", map[string]any{"desk": 2})
	c.call("desks.used", map[string]any{"desk": 7})
	if l := a.call("desks.last", nil)["result"].(map[string]any); l[id] != float64(2) {
		t.Fatalf("desks.last = %v", l)
	}

	// Desk 1 kept its session; a reads desk 2 and writes it (a tab sent there).
	if s := a.call("project.open", map[string]any{"id": id, "desk": 1})["result"].(map[string]any)["session"].(map[string]any); s["layout"] != "one" {
		t.Fatalf("desk 1 = %v", s)
	}
	if s := a.call("session.get", map[string]any{"desk": 2})["result"].(map[string]any); s["layout"] != "two" {
		t.Fatalf("session.get desk 2 = %v", s)
	}
	a.call("session.put", map[string]any{"desk": 2, "session": map[string]any{"layout": "sent"}})
	if ev := b.waitEvent("session.changed", nil); ev["session"].(map[string]any)["layout"] != "sent" {
		t.Fatalf("session.put = %v", ev)
	}

	// Removing desk 2: its session goes, its windows are not written back.
	a.call("desks.update", map[string]any{"desks": map[string]any{"desks": []any{map[string]any{"n": 1}}}})
	b.call("session.update", map[string]any{"session": map[string]any{"layout": "late"}})
	if r := a.callRawIn("", "session.get", map[string]any{"desk": 2}); r["error"] == nil {
		t.Fatalf("removed desk still readable: %v", r)
	}
}

// A console belongs to the desk of the window that opened it; console.move gives it to another
// desk and tells every window of the project.
func TestConsoleDesk(t *testing.T) {
	_, ts := newServer(t)
	a, err := dial(t, ts, "secret-token-0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := dial(t, ts, "secret-token-0123456789abcdef0123")
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	a.call("desks.update", map[string]any{"desks": map[string]any{"desks": []any{map[string]any{"n": 1}, map[string]any{"n": 2}}}})
	a.call("desk.switch", map[string]any{"desk": 2})
	b.call("project.open", map[string]any{"id": id})

	c := a.call("console.create", map[string]any{"kind": "terminal", "command": []string{"cat"}})["result"].(map[string]any)
	if c["desk"] != id+"@2" {
		t.Fatalf("console of desk 2: %v", c)
	}
	if ev := b.waitEvent("console.created", nil); ev["desk"] != id+"@2" {
		t.Fatalf("console.created = %v", ev)
	}
	a.call("console.move", map[string]any{"id": c["id"], "desk": 1})
	if ev := b.waitEvent("console.moved", nil); ev["id"] != c["id"] || ev["desk"] != id {
		t.Fatalf("console.moved = %v", ev)
	}
	if l := b.call("console.list", nil)["result"].([]any); l[0].(map[string]any)["desk"] != id {
		t.Fatalf("console.list after the move = %v", l)
	}
}
