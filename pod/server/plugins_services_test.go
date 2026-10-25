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

// The refusals of service.call (#155): a capability the caller does not require, one nobody
// provides, one a built-in provides, a method out of the provider's namespace.
func TestServiceCallRefusals(t *testing.T) {
	s, ts := newServerWith(t, func(s *Server) { s.Plugins = builtin.Registry(true) })
	a, _ := dial(t, ts, s.Token)
	id := a.call("projects.create", map[string]any{"type": "local", "path": t.TempDir()})["result"].(map[string]any)["id"].(string)
	a.call("project.open", map[string]any{"id": id})
	rt, _ := s.openRuntime(id, sshx.Creds{})
	for _, m := range []plugins.Manifest{
		{ID: "alpha", Name: "Alpha", Provides: []string{"greeting"}, Backend: "bin/alpha"},
		{ID: "beta", Name: "Beta", Requires: []string{"greeting", "worktrees", "nothing"}},
		{ID: "gamma", Name: "Gamma", Requires: []string{"greeting"}},
	} {
		m.APIVersion = plugins.APIVersion
		if err := s.Plugins.SetExternal(plugins.External{Manifest: m, Version: "1.0.0", Official: true}); err != nil {
			t.Fatal(err)
		}
	}
	beta, _ := s.Plugins.External("beta")
	gamma, _ := s.Plugins.External("gamma")
	call := func(e plugins.External, args string) error {
		_, err := s.serviceCall(context.Background(), rt, e, json.RawMessage(args))
		return err
	}
	for _, c := range []struct {
		who        plugins.External
		args, want string
	}{
		{gamma, `{"capability":"worktrees","method":"git.status"}`, "does not require worktrees"},
		// beta requires a missing capability: off, so its services are nobody's.
		{beta, `{"capability":"nothing","method":"x.y"}`, "nothing provides nothing"},
		{gamma, `{"capability":"greeting","method":"beta.hello"}`, "beta.hello is not a method of Alpha"},
	} {
		if err := call(c.who, c.args); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: %v, want %q", c.args, err, c.want)
		}
	}
	// A built-in's service: an external plugin reaches it through a core:<method> grant only.
	s.Plugins.RemoveExternal("beta")
	beta.Manifest.Requires = []string{"worktrees"}
	_ = s.Plugins.SetExternal(beta)
	if err := call(beta, `{"capability":"worktrees","method":"git.worktrees"}`); err == nil || !strings.Contains(err.Error(), "which an external plugin cannot call") {
		t.Fatalf("a built-in provider: %v", err)
	}
	if _, err := s.serviceOn(rt, gamma, json.RawMessage(`{"capability":"worktrees"}`)); err == nil {
		t.Fatal("listening to a capability not required")
	}
	if r, err := s.serviceOn(rt, gamma, json.RawMessage(`{"capability":"greeting"}`)); err != nil || r.(map[string]any)["provider"] != "alpha" || !s.backendOf(rt, "alpha").listeners["gamma"] {
		t.Fatalf("listening: %v %v", r, err)
	}
}
