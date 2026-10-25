package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"antennae.space/ide/pod/plugins"
	"antennae.space/ide/pod/plugins/builtin"
	"antennae.space/ide/pod/sshx"
)

// The agents bridge (#167): its grant, a project of the family only, a method of the bridge.
func TestAgentsBridge(t *testing.T) {
	s, ts := newServerWith(t, func(s *Server) { s.Plugins = builtin.Registry(true) })
	a, _ := dial(t, ts, s.Token)
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	rt, _ := s.openRuntime(id, sshx.Creds{})
	m := plugins.Manifest{ID: "board", Name: "Board", APIVersion: plugins.APIVersion, Requires: []string{"agents"}}
	without := plugins.External{Manifest: m}
	with := plugins.External{Manifest: m, Grants: []string{"use:agents"}}
	call := func(e plugins.External, args string) (any, error) {
		return s.serviceCall(context.Background(), rt, e, json.RawMessage(args))
	}
	if _, err := call(without, `{"capability":"agents","method":"agents.ticketSession","params":{"project":"`+id+`","ticket":1}}`); err == nil || !strings.Contains(err.Error(), "use:agents is not granted") {
		t.Fatalf("without its grant: %v", err)
	}
	if _, err := call(with, `{"capability":"agents","method":"agents.ticketSession","params":{"project":"elsewhere","ticket":1}}`); err == nil || !strings.Contains(err.Error(), "not a project of this one") {
		t.Fatalf("another project: %v", err)
	}
	if _, err := call(with, `{"capability":"agents","method":"agents.create","params":{}}`); err == nil || !strings.Contains(err.Error(), "not a method of the bridge") {
		t.Fatalf("out of the bridge: %v", err)
	}
	r, err := call(with, `{"capability":"agents","method":"agents.ticketSession","params":{"project":"`+id+`-t3","ticket":3}}`)
	if err != nil || r.(map[string]any)["found"] != false {
		t.Fatalf("a worktree of the project: %v %v", r, err)
	}
}
